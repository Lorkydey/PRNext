//! Optional HTTP lifetime budget, independent of a route's render maxDuration.
//! Timers own no application work after a response has completed.
use crate::metrics::{Outcome, Stage, StageSpan};
use axum::body::{Body, Bytes};
use http_body::Body as _;
use http_body::{Frame, SizeHint};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll, Waker},
    time::Duration,
};
use tokio::time::Instant;

#[derive(Clone, Copy, Debug)]
pub(crate) struct Settings {
    pub queue_timeout: Duration,
    pub response_timeout: Option<Duration>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            queue_timeout: Duration::from_secs(30),
            response_timeout: None,
        }
    }
}
impl Settings {
    pub fn from_env() -> anyhow::Result<Self> {
        fn read(name: &str) -> anyhow::Result<Option<String>> {
            match std::env::var(name) {
                Ok(value) => Ok(Some(value)),
                Err(std::env::VarError::NotPresent) => Ok(None),
                Err(_) => anyhow::bail!("{name} must contain an integer number of milliseconds"),
            }
        }
        Self::parse(
            read("PRNEXT_QUEUE_WAIT_MS")?.as_deref(),
            read("PRNEXT_REQUEST_TIMEOUT_MS")?.as_deref(),
        )
    }
    fn parse(queue: Option<&str>, response: Option<&str>) -> anyhow::Result<Self> {
        fn value(name: &str, raw: Option<&str>, default: u64, min: u64) -> anyhow::Result<u64> {
            match raw {
                None => Ok(default),
                Some(raw) => raw
                    .parse::<u64>()
                    .ok()
                    .filter(|n| (min..=3_600_000).contains(n))
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "{name} must be an integer between {min} and 3600000 milliseconds"
                        )
                    }),
            }
        }
        let queue = value("PRNEXT_QUEUE_WAIT_MS", queue, 30_000, 1)?;
        let response = value("PRNEXT_REQUEST_TIMEOUT_MS", response, 0, 0)?;
        Ok(Self {
            queue_timeout: Duration::from_millis(queue),
            response_timeout: (response != 0).then(|| Duration::from_millis(response)),
        })
    }
    pub fn begin(self) -> RequestBudget {
        RequestBudget {
            deadline: self
                .response_timeout
                .map(|duration| Instant::now() + duration),
            queue_timeout: self.queue_timeout,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct RequestBudget {
    pub deadline: Option<Instant>,
    pub queue_timeout: Duration,
}
#[derive(Debug)]
pub(crate) struct DeadlineExceeded;
impl Default for RequestBudget {
    fn default() -> Self {
        Settings::default().begin()
    }
}
impl RequestBudget {
    pub fn for_request(request: &axum::extract::Request) -> Self {
        request
            .extensions()
            .get::<Self>()
            .copied()
            .unwrap_or_default()
    }
    pub fn limit(self, duration: Duration) -> Instant {
        let local = Instant::now() + duration;
        self.deadline.map_or(local, |deadline| deadline.min(local))
    }
    pub fn queue_deadline(self) -> Instant {
        self.limit(self.queue_timeout)
    }
    pub async fn run<F: Future>(self, future: F) -> Result<F::Output, DeadlineExceeded> {
        match self.deadline {
            Some(deadline) => {
                if Instant::now() >= deadline {
                    return Err(DeadlineExceeded);
                }
                let result = tokio::time::timeout_at(deadline, future)
                    .await
                    .map_err(|_| DeadlineExceeded)?;
                if Instant::now() >= deadline {
                    return Err(DeadlineExceeded);
                }
                Ok(result)
            }
            None => Ok(future.await),
        }
    }
}

struct State {
    body: Option<Body>,
    body_span: StageSpan,
    request_span: StageSpan,
    expired: bool,
    waker: Option<Waker>,
    deadline: Option<Instant>,
}
impl State {
    fn finish(&mut self, outcome: Outcome) {
        self.body.take();
        self.body_span.finish(outcome);
        self.request_span.finish(outcome);
    }
}
struct BudgetBody {
    state: Arc<Mutex<State>>,
    timer: Option<tokio::task::AbortHandle>,
}
impl Drop for BudgetBody {
    fn drop(&mut self) {
        if let Some(timer) = &self.timer {
            timer.abort();
        }
        self.state.lock().unwrap().finish(Outcome::Cancelled);
    }
}
impl http_body::Body for BudgetBody {
    type Data = Bytes;
    type Error = std::io::Error;
    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let mut state = self.state.lock().unwrap();
        state.waker = Some(cx.waker().clone());
        if state.body.is_some()
            && state
                .deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
        {
            state.finish(Outcome::TimedOut);
            state.expired = true;
        }
        if state.expired {
            state.expired = false;
            return Poll::Ready(Some(Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "HTTP response deadline exceeded",
            ))));
        }
        let Some(body) = &mut state.body else {
            return Poll::Ready(None);
        };
        match Pin::new(&mut *body).poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                if body.is_end_stream() {
                    state.finish(Outcome::Completed);
                }
                Poll::Ready(Some(Ok(frame)))
            }
            Poll::Ready(Some(Err(_))) => {
                state.finish(Outcome::Failed);
                Poll::Ready(Some(Err(std::io::Error::other(
                    "HTTP response body failed",
                ))))
            }
            Poll::Ready(None) => {
                state.finish(Outcome::Completed);
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
    fn is_end_stream(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.body.is_none() && !state.expired
    }
    fn size_hint(&self) -> SizeHint {
        self.state
            .lock()
            .unwrap()
            .body
            .as_ref()
            .map_or_else(SizeHint::default, http_body::Body::size_hint)
    }
}

/// Enforce the deadline even when HTTP backpressure stops polling the body.
/// Dropping the inner body releases queued bytes and notifies its worker lane.
pub(crate) fn response_body(
    body: Body,
    budget: RequestBudget,
    mut request_span: StageSpan,
) -> Body {
    if !crate::metrics::enabled() && budget.deadline.is_none() {
        return body;
    }
    let mut body_span = StageSpan::new(Stage::ResponseBody);
    if body.is_end_stream() {
        body_span.finish(Outcome::Completed);
        request_span.finish(Outcome::Completed);
        return body;
    }
    let state = Arc::new(Mutex::new(State {
        body: Some(body),
        body_span,
        request_span,
        expired: false,
        waker: None,
        deadline: budget.deadline,
    }));
    let timer = budget.deadline.map(|deadline| {
        let weak = Arc::downgrade(&state);
        tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            if let Some(state) = weak.upgrade() {
                let waker = {
                    let mut state = state.lock().unwrap();
                    if state.body.is_none() {
                        return;
                    }
                    state.finish(Outcome::TimedOut);
                    state.expired = true;
                    state.waker.take()
                };
                if let Some(waker) = waker {
                    waker.wake();
                }
            }
        })
        .abort_handle()
    });
    Body::new(BudgetBody { state, timer })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    #[test]
    fn settings_reject_invalid_values_and_keep_default_policy() {
        let defaults = Settings::parse(None, None).unwrap();
        assert_eq!(defaults.queue_timeout, Duration::from_secs(30));
        assert!(defaults.response_timeout.is_none());
        for value in ["", "-1", "1.5", "3600001", "garbage"] {
            assert!(Settings::parse(Some(value), None).is_err());
            assert!(Settings::parse(None, Some(value)).is_err());
        }
        assert!(Settings::parse(Some("0"), None).is_err());
        assert!(Settings::parse(None, Some("0"))
            .unwrap()
            .response_timeout
            .is_none());
    }
    #[tokio::test]
    async fn repeated_phases_share_the_same_absolute_deadline() {
        let budget = Settings::parse(Some("1000"), Some("300")).unwrap().begin();
        budget
            .run(tokio::time::sleep(Duration::from_millis(80)))
            .await
            .unwrap();
        assert!(budget
            .run(tokio::time::sleep(Duration::from_millis(250)))
            .await
            .is_err());
        assert!(budget.queue_deadline() <= budget.deadline.unwrap());
    }
    #[tokio::test]
    async fn deadline_drops_an_unpolled_body_and_returns_an_error() {
        struct DropSignal(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for DropSignal {
            fn drop(&mut self) {
                if let Some(sender) = self.0.take() {
                    let _ = sender.send(());
                }
            }
        }
        let (sender, dropped) = tokio::sync::oneshot::channel();
        let guard = DropSignal(Some(sender));
        let stream = futures_util::stream::unfold(guard, |guard| async {
            std::future::pending::<()>().await;
            Some((Ok::<Bytes, std::io::Error>(Bytes::new()), guard))
        });
        let budget = Settings::parse(None, Some("20")).unwrap().begin();
        let body = response_body(
            Body::from_stream(stream),
            budget,
            StageSpan::new(Stage::RequestTotal),
        );
        tokio::time::timeout(Duration::from_secs(1), dropped)
            .await
            .unwrap()
            .unwrap();
        assert!(to_bytes(body, 10).await.is_err());
    }
    #[tokio::test]
    async fn completion_and_cancellation_cancel_the_lifetime_timer() {
        let budget = Settings::parse(None, Some("15")).unwrap().begin();
        let body = response_body(
            Body::from("ok"),
            budget,
            StageSpan::new(Stage::RequestTotal),
        );
        assert_eq!(to_bytes(body, 10).await.unwrap(), "ok");
        let body = response_body(
            Body::from("drop"),
            budget,
            StageSpan::new(Stage::RequestTotal),
        );
        drop(body);
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
