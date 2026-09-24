//! Development notifications. No watcher, polling task or connections in production.
use axum::{
    body::Body,
    http::{header, HeaderMap, Method, Response, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
};
use std::{
    convert::Infallible,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    sync::{watch, Semaphore},
};

const MAX_STATE_BYTES: u64 = 64 * 1024;

#[derive(Clone)]
pub struct DevState {
    updates: watch::Sender<Option<String>>,
    closed: Arc<AtomicBool>,
    slots: Arc<Semaphore>,
}

impl DevState {
    pub fn new(project: &Path, build_id: Option<&str>) -> Self {
        let initial = serde_json::json!({"state":"ready", "buildId":build_id}).to_string();
        let (updates, _) = watch::channel(Some(initial));
        let state = Self {
            updates,
            closed: Arc::new(AtomicBool::new(false)),
            slots: Arc::new(Semaphore::new(64)),
        };
        let path = project.join(".rustyx-dev.json");
        let sender = state.updates.clone();
        let closed = state.closed.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(150));
            while !closed.load(Ordering::Relaxed) {
                interval.tick().await;
                let Ok(file) = tokio::fs::File::open(&path).await else {
                    continue;
                };
                let mut source = String::new();
                if file
                    .take(MAX_STATE_BYTES + 1)
                    .read_to_string(&mut source)
                    .await
                    .is_err()
                    || source.len() as u64 > MAX_STATE_BYTES
                {
                    continue;
                }
                if serde_json::from_str::<serde_json::Value>(&source)
                    .ok()
                    .is_none_or(|value| !value.is_object())
                {
                    continue;
                }
                if closed.load(Ordering::Relaxed) {
                    break;
                }
                if sender.borrow().as_deref() != Some(&source) {
                    sender.send_replace(Some(source));
                }
            }
        });
        state
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.updates.send_replace(None);
    }

    pub fn response(&self, method: &Method, headers: &HeaderMap) -> Response<Body> {
        if method != Method::GET {
            return Response::builder()
                .status(StatusCode::METHOD_NOT_ALLOWED)
                .header(header::ALLOW, "GET")
                .body(Body::empty())
                .unwrap();
        }
        if headers
            .get("sec-fetch-site")
            .is_some_and(|value| value == "cross-site")
        {
            return Response::builder()
                .status(StatusCode::FORBIDDEN)
                .body(Body::empty())
                .unwrap();
        }
        let Ok(permit) = self.slots.clone().try_acquire_owned() else {
            return Response::builder()
                .status(StatusCode::SERVICE_UNAVAILABLE)
                .header(header::RETRY_AFTER, "1")
                .body(Body::empty())
                .unwrap();
        };
        let receiver = self.updates.subscribe();
        let events = futures_util::stream::unfold(
            (receiver, true, permit),
            |(mut receiver, first, permit)| async move {
                if !first && receiver.changed().await.is_err() {
                    return None;
                }
                let value = receiver.borrow_and_update().clone()?;
                Some((
                    Ok::<_, Infallible>(
                        Event::default()
                            .retry(Duration::from_millis(200))
                            .data(value),
                    ),
                    (receiver, false, permit),
                ))
            },
        );
        let mut response = Sse::new(events)
            .keep_alive(KeepAlive::new().interval(Duration::from_secs(10)))
            .into_response();
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
        response
            .headers_mut()
            .insert("x-accel-buffering", "no".parse().unwrap());
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn notifications_are_bounded_reject_cross_site_and_close_for_restart() {
        let root = tempfile::tempdir().unwrap();
        let state = DevState::new(root.path(), Some("first"));
        assert_eq!(
            state.response(&Method::POST, &HeaderMap::new()).status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        let mut headers = HeaderMap::new();
        headers.insert("sec-fetch-site", "cross-site".parse().unwrap());
        assert_eq!(
            state.response(&Method::GET, &headers).status(),
            StatusCode::FORBIDDEN
        );
        let responses = (0..64)
            .map(|_| state.response(&Method::GET, &HeaderMap::new()))
            .collect::<Vec<_>>();
        assert_eq!(
            state.response(&Method::GET, &HeaderMap::new()).status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        drop(responses);
        let response = state.response(&Method::GET, &HeaderMap::new());
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        state.close();
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert!(body.is_empty());
    }
}
