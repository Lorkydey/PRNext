//! Lazy HTTP/HTTPS rewrite transport. No response buffering or request replay.
use axum::{
    body::{Body, Bytes},
    extract::Request,
    http::{header, HeaderMap, HeaderName, Response, StatusCode},
};
use futures_core::Stream;
use futures_util::StreamExt;
use std::{
    collections::HashSet,
    io,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll, Waker},
    time::Duration,
};
use tokio::sync::{Notify, OnceCell, OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;
const IDLE: Duration = Duration::from_secs(30);
const CHUNK: usize = 64 * 1024;
type Upstream = Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>;
pub struct Proxy {
    client: OnceCell<reqwest::Client>,
    slots: Arc<Semaphore>,
    waiting: Arc<Semaphore>,
    pooled_origins: Mutex<HashSet<String>>,
}
impl Default for Proxy {
    fn default() -> Self {
        Self {
            client: OnceCell::new(),
            slots: Arc::new(Semaphore::new(16)),
            waiting: Arc::new(Semaphore::new(256)),
            pooled_origins: Mutex::new(HashSet::new()),
        }
    }
}
impl Proxy {
    async fn acquire(&self) -> Result<OwnedSemaphorePermit, StatusCode> {
        if let Ok(permit) = self.slots.clone().try_acquire_owned() {
            return Ok(permit);
        }
        // Wait without reading the upload or opening another upstream stream.
        let _waiting = self
            .waiting
            .clone()
            .try_acquire_owned()
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        tokio::time::timeout(IDLE, self.slots.clone().acquire_owned())
            .await
            .map_err(|_| StatusCode::GATEWAY_TIMEOUT)?
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)
    }

    fn reuse_origin(&self, origin: String) -> bool {
        let mut origins = self.pooled_origins.lock().unwrap();
        if origins.contains(&origin) {
            return true;
        }
        if origins.len() >= 64 {
            return false;
        }
        origins.insert(origin);
        true
    }
    pub async fn forward(
        &self,
        request: Request,
        destination: &str,
    ) -> anyhow::Result<Response<Body>> {
        let permit = match self.acquire().await {
            Ok(permit) => permit,
            Err(status) => {
                return Ok(Response::builder()
                    .status(status)
                    .header(header::RETRY_AFTER, "1")
                    .body(Body::from(if status == StatusCode::GATEWAY_TIMEOUT {
                        "Proxy admission timed out"
                    } else {
                        "Proxy queue is full; retry shortly"
                    }))?)
            }
        };
        let client = self
            .client
            .get_or_try_init(|| async {
                let _ = rustls::crypto::ring::default_provider().install_default();
                reqwest::Client::builder()
                    .http1_only()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .retry(reqwest::retry::never())
                    .connect_timeout(Duration::from_secs(10))
                    .read_timeout(IDLE)
                    .pool_idle_timeout(Duration::from_secs(30))
                    .pool_max_idle_per_host(2)
                    .no_gzip()
                    .no_brotli()
                    .no_deflate()
                    .no_zstd()
                    .build()
            })
            .await?;
        let (mut parts, body) = request.into_parts();
        let original_host = parts.headers.get(header::HOST).cloned();
        strip_hop(&mut parts.headers);
        parts.headers.remove("x-forwarded-host");
        if let Some(host) = original_host {
            parts.headers.insert("x-forwarded-host", host);
        }
        parts.headers.remove(header::HOST);
        let destination = reqwest::Url::parse(destination)?;
        let origin = destination.origin().ascii_serialization();
        if !self.reuse_origin(origin) {
            parts.headers.insert(
                header::CONNECTION,
                axum::http::HeaderValue::from_static("close"),
            );
        }
        let head = parts.method == axum::http::Method::HEAD;
        let upload = futures_util::stream::unfold(
            (
                body.into_data_stream(),
                parts.extensions.remove::<crate::pool::BodyLease>(),
            ),
            |(mut stream, lease)| async move {
                match tokio::time::timeout(IDLE, stream.next()).await {
                    Ok(Some(value)) => Some((value.map_err(io::Error::other), (stream, lease))),
                    Ok(None) => None,
                    Err(_) => Some((
                        Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "proxy upload idle timeout",
                        )),
                        (stream, lease),
                    )),
                }
            },
        );
        let sent = tokio::time::timeout(
            IDLE,
            client
                .request(parts.method, destination)
                .headers(parts.headers)
                .body(reqwest::Body::wrap_stream(upload))
                .send(),
        )
        .await;
        let response = match sent {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                let status = if error.is_timeout() {
                    StatusCode::GATEWAY_TIMEOUT
                } else {
                    StatusCode::BAD_GATEWAY
                };
                return Ok(Response::builder()
                    .status(status)
                    .body(Body::from("External rewrite failed"))?);
            }
            Err(_) => {
                return Ok(Response::builder()
                    .status(504)
                    .body(Body::from("External rewrite timed out"))?)
            }
        };
        let status = response.status();
        let mut headers = response.headers().clone();
        strip_hop(&mut headers);
        let body = if head || matches!(status.as_u16(), 204 | 205 | 304) {
            drop(response);
            drop(permit);
            Body::empty()
        } else {
            Body::from_stream(ProxyStream::new(
                Box::pin(response.bytes_stream()),
                permit,
                IDLE,
            ))
        };
        let mut output = Response::new(body);
        *output.status_mut() = status;
        *output.headers_mut() = headers;
        Ok(output)
    }
}
pub fn strip_hop(headers: &mut HeaderMap) {
    let named = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|name| HeaderName::from_bytes(name.trim().as_bytes()).ok())
        .collect::<Vec<_>>();
    for name in named {
        headers.remove(name);
    }
    let hop = headers
        .keys()
        .filter(|name| crate::server::is_hop_header(name))
        .cloned()
        .collect::<Vec<_>>();
    for name in hop {
        headers.remove(name);
    }
}
struct State {
    stream: Option<Upstream>,
    remainder: Bytes,
    permit: Option<OwnedSemaphorePermit>,
    progress: Instant,
    waker: Option<Waker>,
    expired: bool,
}
struct ProxyStream {
    state: Arc<Mutex<State>>,
    wake: Arc<Notify>,
}
impl ProxyStream {
    fn new(stream: Upstream, permit: OwnedSemaphorePermit, idle: Duration) -> Self {
        let state = Arc::new(Mutex::new(State {
            stream: Some(stream),
            remainder: Bytes::new(),
            permit: Some(permit),
            progress: Instant::now(),
            waker: None,
            expired: false,
        }));
        let wake = Arc::new(Notify::new());
        let weak = Arc::downgrade(&state);
        let signal = wake.clone();
        tokio::spawn(async move {
            loop {
                let deadline = match weak.upgrade() {
                    Some(state) => {
                        let state = state.lock().unwrap();
                        if state.permit.is_none() {
                            return;
                        }
                        state.progress + idle
                    }
                    None => return,
                };
                tokio::select! { _=tokio::time::sleep_until(deadline)=>{}, _=signal.notified()=>continue }
                let Some(state) = weak.upgrade() else {
                    return;
                };
                let mut state = state.lock().unwrap();
                if state.progress + idle <= Instant::now() {
                    state.stream.take();
                    state.remainder = Bytes::new();
                    state.permit.take();
                    state.expired = true;
                    if let Some(waker) = state.waker.take() {
                        waker.wake();
                    }
                    return;
                }
            }
        });
        Self { state, wake }
    }
}
impl Stream for ProxyStream {
    type Item = Result<Bytes, io::Error>;
    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let mut state = self.state.lock().unwrap();
        if state.expired {
            state.expired = false;
            return Poll::Ready(Some(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "proxy response idle timeout",
            ))));
        }
        loop {
            if !state.remainder.is_empty() {
                let length = state.remainder.len().min(CHUNK);
                // Split ownership, so the HTTP writer cannot retain an oversized upstream allocation.
                let chunk = Bytes::copy_from_slice(&state.remainder.split_to(length));
                state.progress = Instant::now();
                return Poll::Ready(Some(Ok(chunk)));
            }
            let Some(stream) = state.stream.as_mut() else {
                return Poll::Ready(None);
            };
            match stream.as_mut().poll_next(cx) {
                Poll::Ready(Some(Ok(bytes))) => {
                    state.remainder = bytes;
                }
                Poll::Ready(Some(Err(error))) => {
                    state.stream.take();
                    state.permit.take();
                    self.wake.notify_one();
                    return Poll::Ready(Some(Err(io::Error::other(error))));
                }
                Poll::Ready(None) => {
                    state.stream.take();
                    state.permit.take();
                    self.wake.notify_one();
                    return Poll::Ready(None);
                }
                Poll::Pending => {
                    state.waker = Some(cx.waker().clone());
                    return Poll::Pending;
                }
            }
        }
    }
}
impl Drop for ProxyStream {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap();
        state.stream.take();
        state.remainder = Bytes::new();
        state.permit.take();
        self.wake.notify_one();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn queued_admission_is_bounded_cancellable_and_resumes_after_release() {
        let proxy = Arc::new(Proxy {
            waiting: Arc::new(Semaphore::new(2)),
            ..Proxy::default()
        });
        let mut active = Vec::new();
        for _ in 0..16 {
            active.push(proxy.acquire().await.unwrap());
        }
        let first = tokio::spawn({
            let proxy = proxy.clone();
            async move { proxy.acquire().await }
        });
        while proxy.waiting.available_permits() != 1 {
            tokio::task::yield_now().await;
        }
        let second = tokio::spawn({
            let proxy = proxy.clone();
            async move { proxy.acquire().await }
        });
        while proxy.waiting.available_permits() != 0 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            proxy.acquire().await.unwrap_err(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        first.abort();
        let _ = first.await;
        assert_eq!(proxy.waiting.available_permits(), 1);
        drop(active.pop());
        let resumed = second.await.unwrap().unwrap();
        assert_eq!(proxy.waiting.available_permits(), 2);
        drop(resumed);
        drop(active);
        assert_eq!(proxy.slots.available_permits(), 16);
    }
    #[test]
    fn idle_pool_origin_keys_are_bounded_for_dynamic_host_rewrites() {
        let proxy = Proxy::default();
        for i in 0..64 {
            assert!(proxy.reuse_origin(format!("http://host-{i}.test")));
        }
        assert!(!proxy.reuse_origin("http://overflow.test".into()));
        assert!(proxy.reuse_origin("http://host-0.test".into()));
        assert_eq!(proxy.pooled_origins.lock().unwrap().len(), 64);
    }
    #[tokio::test]
    async fn stalled_body_releases_admission_and_discards_upstream() {
        let slots = Arc::new(Semaphore::new(1));
        let stream = Box::pin(futures_util::stream::pending());
        let mut body = ProxyStream::new(
            stream,
            slots.clone().try_acquire_owned().unwrap(),
            Duration::from_millis(20),
        );
        assert!(slots.clone().try_acquire_owned().is_err());
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(slots.clone().try_acquire_owned().is_ok());
        assert!(body.next().await.unwrap().is_err());
        assert!(body.next().await.is_none());
    }
    #[tokio::test]
    async fn chunks_are_bounded_and_drop_releases_capacity() {
        let slots = Arc::new(Semaphore::new(1));
        let stream = Box::pin(futures_util::stream::iter([Ok(Bytes::from(vec![
            7;
            CHUNK * 3
        ]))]));
        let mut body = ProxyStream::new(stream, slots.clone().try_acquire_owned().unwrap(), IDLE);
        assert_eq!(body.next().await.unwrap().unwrap().len(), CHUNK);
        assert_eq!(slots.available_permits(), 0);
        drop(body);
        assert_eq!(slots.available_permits(), 1);
    }
    #[test]
    fn connection_named_headers_are_removed_both_directions() {
        let mut headers = HeaderMap::new();
        headers.insert("connection", "X-Internal, keep-alive".parse().unwrap());
        headers.insert("x-internal", "secret".parse().unwrap());
        headers.append("set-cookie", "a=1".parse().unwrap());
        headers.append("set-cookie", "b=2".parse().unwrap());
        strip_hop(&mut headers);
        assert!(!headers.contains_key("x-internal"));
        assert!(!headers.contains_key("connection"));
        assert_eq!(headers.get_all("set-cookie").iter().count(), 2);
    }
}
