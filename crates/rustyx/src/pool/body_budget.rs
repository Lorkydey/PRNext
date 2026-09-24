//! Bound decoded ingress bytes independently from asynchronous concurrency.
use axum::body::{Body, HttpBody};
use std::{sync::Arc, time::Duration};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Clone)]
pub struct BodyBudget(Arc<Semaphore>);
#[derive(Clone, Debug)]
pub struct BodyLease {
    _permit: Option<Arc<OwnedSemaphorePermit>>,
}
impl BodyLease {
    pub fn shrink_to(&mut self, bytes: usize) {
        if let Some(permit) = self._permit.as_mut().and_then(Arc::get_mut) {
            let units = bytes.div_ceil(64 * 1024);
            if permit.num_permits() > units {
                drop(permit.split(permit.num_permits() - units));
            }
        }
    }
}

// The same lease follows a buffered body across middleware, admission and the
// worker response. Cloning ownership does not reserve the bytes twice.
impl BodyBudget {
    pub fn request(
        &self,
        request: &axum::extract::Request,
        limit: usize,
    ) -> impl std::future::Future<Output = Result<BodyLease, &'static str>> + Send + 'static {
        let existing = request.extensions().get::<BodyLease>().cloned();
        let empty = request.body().size_hint().upper() == Some(0);
        let acquire = self.acquire(request.body(), limit);
        async move {
            if let Some(lease) = existing {
                return Ok(lease);
            }
            Ok(BodyLease {
                _permit: if empty {
                    None
                } else {
                    Some(Arc::new(acquire.await?))
                },
            })
        }
    }
}
impl Default for BodyBudget {
    fn default() -> Self {
        Self(Arc::new(Semaphore::new(512)))
    }
}
impl BodyBudget {
    // 64 KiB units, 32 MiB total, matching four maximum-sized request bodies.
    // Unknown/chunked bodies reserve their full configured limit before reading,
    // so partial uploads cannot deadlock while competing for the remaining bytes.
    pub fn acquire(
        &self,
        body: &Body,
        limit: usize,
    ) -> impl std::future::Future<Output = Result<OwnedSemaphorePermit, &'static str>> + Send + 'static
    {
        let bytes = body
            .size_hint()
            .upper()
            .map(|n| n.min(limit as u64) as usize)
            .unwrap_or(limit);
        let units = bytes.div_ceil(64 * 1024).min(512) as u32;
        let slots = self.0.clone();
        async move {
            tokio::time::timeout(Duration::from_secs(30), slots.acquire_many_owned(units))
                .await
                .map_err(|_| "Request body admission timed out")?
                .map_err(|_| "Request body admission closed")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn unknown_upload_releases_unused_reservation_after_reading() {
        let budget = BodyBudget::default();
        let request =
            axum::extract::Request::new(Body::from_stream(futures_util::stream::iter([Ok::<
                _,
                std::io::Error,
            >(
                axum::body::Bytes::from_static(b"small chunked body"),
            )])));
        let mut lease = budget.request(&request, 8 * 1024 * 1024).await.unwrap();
        assert_eq!(budget.0.available_permits(), 384);
        let bytes = axum::body::to_bytes(request.into_body(), 8 * 1024 * 1024)
            .await
            .unwrap();
        lease.shrink_to(bytes.len());
        assert_eq!(budget.0.available_permits(), 511);
        drop(lease);
        assert_eq!(budget.0.available_permits(), 512);
    }

    #[tokio::test]
    async fn body_lease_survives_handoff_and_is_reused_without_double_reservation() {
        let budget = BodyBudget::default();
        let mut request = axum::extract::Request::new(Body::from(vec![0; 8 * 1024 * 1024]));
        let first = budget.request(&request, 8 * 1024 * 1024).await.unwrap();
        request.extensions_mut().insert(first.clone());
        let downstream = budget.request(&request, 8 * 1024 * 1024).await.unwrap();
        assert_eq!(budget.0.available_permits(), 384);
        drop(first);
        drop(request);
        assert_eq!(budget.0.available_permits(), 384);
        drop(downstream);
        assert_eq!(budget.0.available_permits(), 512);
    }

    #[tokio::test]
    async fn uploads_are_bounded_without_blocking_empty_requests_and_release_on_cancel() {
        let budget = BodyBudget::default();
        let body = Body::from(vec![0u8; 8 * 1024 * 1024]);
        let mut permits = Vec::new();
        for _ in 0..4 {
            permits.push(budget.acquire(&body, 8 * 1024 * 1024).await.unwrap());
        }
        assert_eq!(budget.0.available_permits(), 0);
        let empty = budget
            .acquire(&Body::empty(), 8 * 1024 * 1024)
            .await
            .unwrap();
        assert!(tokio::time::timeout(
            Duration::from_millis(20),
            budget.acquire(&body, 8 * 1024 * 1024)
        )
        .await
        .is_err());
        drop(permits.pop());
        let replacement = budget.acquire(&body, 8 * 1024 * 1024).await.unwrap();
        drop(replacement);
        drop(empty);
        drop(permits);
        assert_eq!(budget.0.available_permits(), 512);
    }
}
