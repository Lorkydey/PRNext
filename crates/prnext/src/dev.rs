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
    rpc_authoritative: Arc<AtomicBool>,
    slots: Arc<Semaphore>,
}

impl DevState {
    pub fn new(project: &Path, build_id: Option<&str>) -> Self {
        // Only the CLI's complete notification carries the refresh manifest.
        // Reconnecting before the first file read must not announce a new build
        // without it: the browser would fall back to a full document reload.
        let initial = serde_json::json!({"state":"building", "buildId":build_id}).to_string();
        let (updates, _) = watch::channel(Some(initial));
        let state = Self {
            updates,
            closed: Arc::new(AtomicBool::new(false)),
            rpc_authoritative: Arc::new(AtomicBool::new(false)),
            slots: Arc::new(Semaphore::new(64)),
        };
        let path = project.join(".prnext-dev.json");
        let publisher = state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(150));
            while !publisher.closed.load(Ordering::Relaxed) {
                interval.tick().await;
                if publisher.rpc_authoritative.load(Ordering::Relaxed) {
                    break;
                }
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
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&source) else {
                    continue;
                };
                if !value.is_object() {
                    continue;
                }
                let source = value.to_string();
                publisher.publish_snapshot(source, false);
            }
        });
        state
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.updates.send_replace(None);
    }
    fn publish_snapshot(&self, source: String, rpc: bool) {
        // The stable gateway receives every complete CLI notification over RPC.
        // A file opened before that notification may finish reading afterwards;
        // it must not restore an old error or build state. Keep the file fallback
        // only for runtimes that have never received a valid RPC publication.
        // Check and set authority inside the same watch write lock as the value.
        self.updates.send_if_modified(|current| {
            if self.closed.load(Ordering::Relaxed)
                || (!rpc && self.rpc_authoritative.load(Ordering::Relaxed))
            {
                return false;
            }
            if rpc {
                self.rpc_authoritative.store(true, Ordering::Relaxed);
            }
            if current.as_deref() == Some(&source) {
                return false;
            }
            *current = Some(source);
            true
        });
    }
    pub(crate) fn publish(&self, value: &serde_json::Value) -> anyhow::Result<()> {
        let source = value.to_string();
        if !value.is_object() || source.len() as u64 > MAX_STATE_BYTES {
            anyhow::bail!("Invalid development notification")
        }
        self.publish_snapshot(source, true);
        Ok(())
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
                            .retry(Duration::from_millis(50))
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
    use futures_util::StreamExt;

    #[tokio::test]
    async fn reconnect_waits_for_a_complete_refresh_notification() {
        let root = tempfile::tempdir().unwrap();
        let state = DevState::new(root.path(), Some("new-build"));
        let response = state.response(&Method::GET, &HeaderMap::new());
        let mut stream = response.into_body().into_data_stream();
        let first = tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let first = std::str::from_utf8(&first).unwrap();
        assert!(first.contains("\"state\":\"building\""));
        assert!(!first.contains("\"state\":\"ready\""));
        let notification = serde_json::json!({"state":"ready", "buildId":"new-build", "clientManifest":"/_prnext/assets/dev-new.json"}).to_string();
        tokio::fs::write(root.path().join(".prnext-dev.json"), &notification)
            .await
            .unwrap();
        let next = tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(std::str::from_utf8(&next).unwrap().contains(&notification));
        state.close();
        assert!(stream.next().await.is_none());
    }

    #[tokio::test]
    async fn delayed_file_snapshot_cannot_restore_diagnostics_after_rpc_recovery() {
        let root = tempfile::tempdir().unwrap();
        let state = DevState::new(root.path(), Some("same-build"));
        let stale = serde_json::json!({"state":"ready", "buildId":"same-build", "sequence":7, "typeErrors":["old type error"]});
        let recovered = serde_json::json!({"state":"ready", "buildId":"same-build", "sequence":7, "typeErrors":[]});
        let path = root.path().join(".prnext-dev.json");
        tokio::fs::write(&path, stale.to_string()).await.unwrap();
        // The poll has loaded an old complete snapshot, but has not published it.
        let delayed = tokio::fs::read_to_string(&path).await.unwrap();
        state.publish_snapshot(delayed.clone(), false);
        assert_eq!(state.updates.borrow().as_deref(), Some(delayed.as_str()));
        tokio::fs::write(&path, recovered.to_string())
            .await
            .unwrap();
        state.publish(&recovered).unwrap();
        // A clone represents the polling task sharing the publication write lock.
        state.clone().publish_snapshot(delayed, false);
        assert_eq!(
            state.updates.borrow().as_deref(),
            Some(recovered.to_string().as_str())
        );

        // Authoritative RPC still publishes transitory build state and new errors.
        let building = serde_json::json!({"state":"building", "typeErrors":[]});
        state.publish(&building).unwrap();
        assert_eq!(
            state.updates.borrow().as_deref(),
            Some(building.to_string().as_str())
        );
        let current = serde_json::json!({"state":"error", "error":"new build failure", "typeErrors":["new type error"]});
        state.publish(&current).unwrap();
        state.publish_snapshot(recovered.to_string(), false);
        assert_eq!(
            state.updates.borrow().as_deref(),
            Some(current.to_string().as_str())
        );
        state.close();
    }

    #[tokio::test]
    async fn invalid_rpc_keeps_legacy_polling_and_new_instances_reset_authority() {
        let root = tempfile::tempdir().unwrap();
        let state = DevState::new(root.path(), None);
        assert!(state.publish(&serde_json::json!("not an object")).is_err());
        assert!(state
            .publish(&serde_json::json!({"error":"x".repeat(MAX_STATE_BYTES as usize)}))
            .is_err());
        let legacy =
            serde_json::json!({"state":"ready", "typeErrors":["legacy issue"]}).to_string();
        state.publish_snapshot(legacy.clone(), false);
        assert_eq!(state.updates.borrow().as_deref(), Some(legacy.as_str()));
        // An identical valid RPC also establishes authority without a new event.
        state
            .publish(&serde_json::from_str(&legacy).unwrap())
            .unwrap();
        state.publish_snapshot("{\"state\":\"building\"}".to_owned(), false);
        assert_eq!(state.updates.borrow().as_deref(), Some(legacy.as_str()));
        state.close();

        let restarted = DevState::new(root.path(), None);
        let response = restarted.response(&Method::GET, &HeaderMap::new());
        let mut stream = response.into_body().into_data_stream();
        let _ = stream.next().await.unwrap().unwrap();
        tokio::fs::write(root.path().join(".prnext-dev.json"), &legacy)
            .await
            .unwrap();
        let event = tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(std::str::from_utf8(&event).unwrap().contains(&legacy));
        restarted.close();
        restarted
            .publish(&serde_json::json!({"state":"ready"}))
            .unwrap();
        restarted.publish_snapshot(legacy, false);
        assert!(restarted.updates.borrow().is_none());
    }

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
