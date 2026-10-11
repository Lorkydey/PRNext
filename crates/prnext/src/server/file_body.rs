//! Keep a file admission until EOF, body error or disconnect, preserving frames.
use crate::io_admission::Lease;
use axum::{
    body::{Body, Bytes, HttpBody},
    extract::Request,
};
use std::{
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};

pub(super) fn header_bytes(request: &Request) -> u64 {
    if !crate::blocking::enabled() {
        return 0;
    }
    (request.uri().to_string().len()
        + request
            .headers()
            .iter()
            .map(|(name, value)| name.as_str().len() + value.as_bytes().len())
            .sum::<usize>()) as u64
}
pub(super) fn hold(body: Body, lease: Arc<Lease>) -> Body {
    Body::new(FileBody {
        body,
        lease: Some(lease),
    })
}
struct FileBody {
    body: Body,
    lease: Option<Arc<Lease>>,
}

// A dropped tokio::fs read can keep running on the blocking pool. The producer
// owns the file and its admission until that pending read actually settles.
// One queued frame plus the read in progress provide bounded backpressure.
pub(super) fn buffered(body: Body, lease: Arc<Lease>) -> Body {
    let hint = body.size_hint();
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    tokio::spawn(async move {
        let _lease = lease;
        let mut body = body;
        while !tx.is_closed() {
            let frame = std::future::poll_fn(|cx| Pin::new(&mut body).poll_frame(cx)).await;
            let Some(frame) = frame else {
                break;
            };
            let failed = frame.is_err();
            if tx.send(frame).await.is_err() || failed {
                break;
            }
        }
    });
    Body::new(Frames { rx, hint })
}
struct Frames {
    rx: tokio::sync::mpsc::Receiver<Result<http_body::Frame<Bytes>, axum::Error>>,
    hint: http_body::SizeHint,
}
impl HttpBody for Frames {
    type Data = Bytes;
    type Error = axum::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Bytes>, Self::Error>>> {
        let frame = self.rx.poll_recv(cx);
        if let Poll::Ready(Some(Ok(frame))) = &frame {
            if let (Some(exact), Some(data)) = (self.hint.exact(), frame.data_ref()) {
                self.hint.set_exact(exact.saturating_sub(data.len() as u64));
            }
        }
        frame
    }
    fn is_end_stream(&self) -> bool {
        self.rx.is_closed() && self.rx.is_empty()
    }
    fn size_hint(&self) -> http_body::SizeHint {
        self.hint
    }
}
impl HttpBody for FileBody {
    type Data = Bytes;
    type Error = axum::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Bytes>, Self::Error>>> {
        let result = Pin::new(&mut self.body).poll_frame(cx);
        if matches!(result, Poll::Ready(None | Some(Err(_)))) || self.body.is_end_stream() {
            self.lease.take();
        }
        result
    }
    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }
    fn size_hint(&self) -> http_body::SizeHint {
        self.body.size_hint()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io_admission::Gate;
    use std::time::Duration;
    #[tokio::test]
    async fn body_holds_admission_until_consumed_or_dropped() {
        let gate = Gate::new(1, 0, Duration::from_secs(1));
        let response = hold(
            Body::from("bytes"),
            Arc::new(gate.acquire(0).await.unwrap()),
        );
        assert!(gate.acquire(0).await.is_err());
        assert_eq!(response.size_hint().exact(), Some(5));
        assert_eq!(axum::body::to_bytes(response, 8).await.unwrap(), "bytes");
        let response = hold(
            Body::from("again"),
            Arc::new(gate.acquire(0).await.unwrap()),
        );
        assert!(gate.acquire(0).await.is_err());
        drop(response);
        assert!(gate.acquire(0).await.is_ok());
    }
    #[tokio::test]
    async fn disconnected_consumer_keeps_capacity_until_pending_read_settles() {
        let gate = Gate::new(1, 0, Duration::from_secs(1));
        let (entered, started) = tokio::sync::oneshot::channel();
        let (finish, pending) = tokio::sync::oneshot::channel();
        let input = futures_util::stream::once(async move {
            entered.send(()).unwrap();
            pending.await.unwrap();
            Ok::<_, std::io::Error>(Bytes::from_static(b"data"))
        });
        let lease = Arc::new(gate.acquire(0).await.unwrap());
        let response = hold(buffered(Body::from_stream(input), lease.clone()), lease);
        started.await.unwrap();
        drop(response);
        assert!(gate.acquire(0).await.is_err());
        finish.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if gate.acquire(0).await.is_ok() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}
