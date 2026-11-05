//! Opt-in, bounded HTTP metrics. Scrapes do not depend on an OTLP collector.
use super::*;
use axum::{
    body::{Body, Bytes},
    http::{header, Method, Request, Response, StatusCode},
};
use http_body::{Body as _, Frame, SizeHint};
use std::{
    fmt::Write,
    pin::Pin,
    sync::OnceLock,
    task::{Context, Poll},
};

const METHODS: [&str; 10] = [
    "GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "CONNECT", "TRACE", "_OTHER",
];
const STATUS_COUNT: usize = 501; // 100..599, then no response headers.
static DURATION: [Histogram; METHODS.len() * STATUS_COUNT] =
    [const { Histogram::new() }; METHODS.len() * STATUS_COUNT];
static IN_FLIGHT: AtomicU64 = AtomicU64::new(0);
static TOKEN: OnceLock<Option<String>> = OnceLock::new();

pub(crate) fn configure() -> anyhow::Result<()> {
    let value = std::env::var("PRNEXT_METRICS_TOKEN").ok();
    anyhow::ensure!(
        value.as_ref().is_none_or(|value| value.len() >= 32
            && value.len() <= 256
            && value.bytes().all(|b| b.is_ascii_graphic())),
        "PRNEXT_METRICS_TOKEN must contain 32 to 256 visible ASCII characters"
    );
    TOKEN.get_or_init(|| value);
    Ok(())
}
pub(super) fn configured() -> bool {
    TOKEN.get().is_some_and(Option::is_some)
}

pub(crate) struct RequestMetric {
    start: Option<Instant>,
    method: usize,
    status: u16,
}
impl RequestMetric {
    pub fn begin(method: &Method) -> Self {
        if !configured() {
            return Self {
                start: None,
                method: 0,
                status: 0,
            };
        }
        let start = configured().then(|| {
            IN_FLIGHT.fetch_add(1, Relaxed);
            Instant::now()
        });
        Self {
            start,
            method: METHODS
                .iter()
                .position(|value| *value == method.as_str())
                .unwrap_or(METHODS.len() - 1),
            status: 0,
        }
    }
    fn finish(&mut self, outcome: Outcome) {
        if let Some(start) = self.start.take() {
            IN_FLIGHT.fetch_sub(1, Relaxed);
            let status = if (100..600).contains(&self.status) {
                usize::from(self.status - 100)
            } else {
                500
            };
            DURATION[self.method * STATUS_COUNT + status].record(
                start.elapsed().as_nanos().min(u64::MAX as u128) as u64,
                outcome,
            );
        }
    }
    pub fn body(mut self, inner: Body, status: u16) -> Body {
        self.status = status;
        if self.start.is_none() {
            return inner;
        }
        if inner.is_end_stream() {
            self.finish(if status >= 500 {
                Outcome::Failed
            } else {
                Outcome::Completed
            });
            return inner;
        }
        Body::new(MeasuredBody {
            inner,
            metric: self,
        })
    }
}
impl Drop for RequestMetric {
    fn drop(&mut self) {
        self.finish(Outcome::Cancelled);
    }
}
struct MeasuredBody {
    inner: Body,
    metric: RequestMetric,
}
impl http_body::Body for MeasuredBody {
    type Data = Bytes;
    type Error = axum::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let value = Pin::new(&mut self.inner).poll_frame(cx);
        match &value {
            Poll::Ready(Some(Err(_))) => self.metric.finish(Outcome::Failed),
            Poll::Ready(None) => {
                let outcome = if self.metric.status >= 500 {
                    Outcome::Failed
                } else {
                    Outcome::Completed
                };
                self.metric.finish(outcome);
            }
            Poll::Ready(Some(Ok(_))) if self.inner.is_end_stream() => {
                let outcome = if self.metric.status >= 500 {
                    Outcome::Failed
                } else {
                    Outcome::Completed
                };
                self.metric.finish(outcome);
            }
            _ => {}
        }
        value
    }
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

fn authorized(header: Option<&str>, token: &str) -> bool {
    let Some(supplied) = header.and_then(|value| value.strip_prefix("Bearer ")) else {
        return false;
    };
    supplied.len() == token.len()
        && supplied
            .bytes()
            .zip(token.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}
pub(crate) fn response(request: &Request<Body>) -> Response<Body> {
    let Some(token) = TOKEN.get().and_then(Option::as_ref) else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap();
    };
    let mut values = request.headers().get_all(header::AUTHORIZATION).iter();
    let supplied = values.next().and_then(|value| value.to_str().ok());
    if values.next().is_some() || !authorized(supplied, token) {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .header(header::WWW_AUTHENTICATE, "Bearer")
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::empty())
            .unwrap();
    }
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header(header::ALLOW, "GET, HEAD")
            .body(Body::empty())
            .unwrap();
    }
    let json = request
        .headers()
        .get(header::ACCEPT)
        .is_some_and(|value| value == "application/json");
    let content = if request.method() == Method::HEAD {
        String::new()
    } else if json {
        super::snapshot().to_string()
    } else {
        prometheus()
    };
    Response::builder()
        .header(header::CACHE_CONTROL, "no-store")
        .header(
            header::CONTENT_TYPE,
            if json {
                "application/json"
            } else {
                "text/plain; version=0.0.4; charset=utf-8"
            },
        )
        .body(Body::from(content))
        .unwrap()
}

pub(super) fn snapshot() -> serde_json::Value {
    serde_json::json!({"enabled":configured(),"activeRequests":IN_FLIGHT.load(Relaxed),"requests":DURATION.iter().enumerate().filter(|(_,h)|h.count.load(Relaxed)>0).map(|(index,h)|serde_json::json!({"method":METHODS[index/STATUS_COUNT],"status":if index%STATUS_COUNT==500 {0}else{100+index%STATUS_COUNT},"count":h.count.load(Relaxed),"sumSeconds":h.ns.load(Relaxed) as f64/1e9,"completed":h.outcomes[0].load(Relaxed),"failed":h.outcomes[1].load(Relaxed),"cancelled":h.outcomes[2].load(Relaxed),"timedOut":h.outcomes[3].load(Relaxed)})).collect::<Vec<_>>()})
}
fn prometheus() -> String {
    let mut text=String::from("# HELP http_server_request_duration_seconds HTTP handler and streaming body duration in seconds.\n# TYPE http_server_request_duration_seconds histogram\n# TYPE http_server_active_requests gauge\n");
    let _ = writeln!(
        text,
        "http_server_active_requests {}",
        IN_FLIGHT.load(Relaxed)
    );
    text.push_str("# TYPE prnext_http_cancelled_requests_total counter\n# TYPE prnext_http_failed_requests_total counter\n");
    for (index, h) in DURATION
        .iter()
        .enumerate()
        .filter(|(_, h)| h.count.load(Relaxed) > 0)
    {
        let method = METHODS[index / STATUS_COUNT];
        let status = if index % STATUS_COUNT == 500 {
            0
        } else {
            100 + index % STATUS_COUNT
        };
        let labels =
            format!("http_request_method=\"{method}\",http_response_status_code=\"{status}\"");
        // Read noncumulative buckets once and derive count from those samples.
        let mut count = 0;
        for (i, bucket) in h.buckets.iter().enumerate() {
            count += bucket.load(Relaxed);
            let bound = BOUNDS_MS
                .get(i)
                .map_or_else(|| "+Inf".to_owned(), |ms| (*ms as f64 / 1000.0).to_string());
            let _ = writeln!(
                text,
                "http_server_request_duration_seconds_bucket{{{labels},le=\"{bound}\"}} {count}"
            );
        }
        let _=writeln!(text,"http_server_request_duration_seconds_count{{{labels}}} {count}\nhttp_server_request_duration_seconds_sum{{{labels}}} {}\nprnext_http_cancelled_requests_total{{{labels}}} {}",h.ns.load(Relaxed) as f64/1e9,h.outcomes[2].load(Relaxed));
        let _ = writeln!(
            text,
            "prnext_http_failed_requests_total{{{labels}}} {}",
            h.outcomes[1].load(Relaxed)
        );
    }
    for (name, value) in EVENTS.iter().zip(COUNTS.iter()) {
        let _ = writeln!(
            text,
            "prnext_worker_events_total{{event=\"{name}\"}} {}",
            value.load(Relaxed)
        );
    }
    let _ = writeln!(
        text,
        "prnext_worker_active_jobs {}\nprnext_worker_queued_jobs {}",
        ACTIVE.load(Relaxed),
        QUEUED.load(Relaxed)
    );
    for (name, c) in BUDGETS.iter().zip(BUDGET_COUNTERS.iter()) {
        let (limit, used) = c.occupancy();
        let _=writeln!(text,"prnext_budget_limit{{budget=\"{name}\"}} {limit}\nprnext_budget_used{{budget=\"{name}\"}} {used}\nprnext_budget_waiting{{budget=\"{name}\"}} {}\nprnext_budget_rejected_total{{budget=\"{name}\"}} {}\nprnext_budget_timed_out_total{{budget=\"{name}\"}} {}",c.waiting.load(Relaxed),c.rejected.load(Relaxed),c.timed_out.load(Relaxed));
    }
    if let Some(object) = crate::telemetry::snapshot().as_object() {
        for name in [
            "queuedSpans",
            "droppedSpans",
            "rejectedSpans",
            "exportAttempts",
            "exportFailures",
            "failedBatches",
            "exportedSpans",
        ] {
            if let Some(value) = object.get(name).and_then(serde_json::Value::as_u64) {
                let metric = match name {
                    "queuedSpans" => "queued_spans",
                    "droppedSpans" => "dropped_spans_total",
                    "rejectedSpans" => "rejected_spans_total",
                    "exportAttempts" => "export_attempts_total",
                    "exportFailures" => "export_failures_total",
                    "failedBatches" => "failed_batches_total",
                    _ => "exported_spans_total",
                };
                let _ = writeln!(text, "prnext_telemetry_{metric} {value}");
            }
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scraper_requires_exact_bearer_and_has_bounded_labels() {
        assert!(authorized(Some("Bearer abc"), "abc"));
        for value in [
            None,
            Some("abc"),
            Some("bearer abc"),
            Some("Bearer abcd"),
            Some("Bearer abb"),
        ] {
            assert!(!authorized(value, "abc"));
        }
        let output = prometheus();
        assert!(!output.contains("url="));
        assert!(!output.contains("token"));
        assert!(output.contains("http_server_request_duration_seconds"));
    }
    #[tokio::test]
    async fn duration_covers_stream_completion_and_cancellation_once() {
        // Inject a local enabled metric without changing process-wide env.
        let baseline = IN_FLIGHT.load(Relaxed);
        IN_FLIGHT.fetch_add(1, Relaxed);
        let metric = RequestMetric {
            start: Some(Instant::now()),
            method: 0,
            status: 0,
        };
        let body = metric.body(Body::from("complete"), 200);
        assert_eq!(axum::body::to_bytes(body, 100).await.unwrap(), "complete");
        assert_eq!(IN_FLIGHT.load(Relaxed), baseline);
        IN_FLIGHT.fetch_add(1, Relaxed);
        let metric = RequestMetric {
            start: Some(Instant::now()),
            method: 1,
            status: 200,
        };
        drop(metric);
        assert_eq!(IN_FLIGHT.load(Relaxed), baseline);
        let index = (METHODS.len() - 1) * STATUS_COUNT + 100;
        let failures = DURATION[index].outcomes[1].load(Relaxed);
        IN_FLIGHT.fetch_add(1, Relaxed);
        let metric = RequestMetric {
            start: Some(Instant::now()),
            method: METHODS.len() - 1,
            status: 0,
        };
        let stream = futures_util::stream::iter([
            Ok(Bytes::from_static(b"prefix")),
            Err(std::io::Error::other("stream failed after 200 headers")),
        ]);
        let body = metric.body(Body::from_stream(stream), 200);
        assert!(axum::body::to_bytes(body, 100).await.is_err());
        assert_eq!(IN_FLIGHT.load(Relaxed), baseline);
        assert_eq!(DURATION[index].outcomes[1].load(Relaxed), failures + 1);
        assert!(prometheus().contains("prnext_http_failed_requests_total{http_request_method=\"_OTHER\",http_response_status_code=\"200\"}"));
    }
}
