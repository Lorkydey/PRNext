//! Shared budget for streamed bytes being read or queued between Node and HTTP.
//! Downstream collectors have their own limits: retaining their Bytes here would
//! deadlock a collector whose complete response is larger than the queue budget.
use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const UNIT: usize = 4096;
#[derive(Clone)]
pub(super) struct ResponseBudget(Arc<Semaphore>);

impl Default for ResponseBudget {
    fn default() -> Self {
        let mib = std::env::var("PRNEXT_RESPONSE_BUFFER_MIB")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .filter(|n| (1..=64).contains(n))
            .unwrap_or_else(|| {
                crate::profile::Profile::from_env()
                    .map(|profile| profile.settings().response_buffer_mi_b)
                    .unwrap_or(8)
            });
        Self::new(mib * 1024 * 1024)
    }
}

impl ResponseBudget {
    pub(super) fn new(bytes: usize) -> Self {
        Self(Arc::new(Semaphore::new(bytes.div_ceil(UNIT))))
    }
    pub(super) async fn reserve(&self, bytes: usize) -> OwnedSemaphorePermit {
        self.0
            .clone()
            .acquire_many_owned(bytes.div_ceil(UNIT) as u32)
            .await
            .expect("response budget is never closed")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn a_small_chunk_reserves_one_unit_until_its_queue_slot_is_released() {
        let budget = ResponseBudget::new(UNIT);
        let reservation = budget.reserve(20).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(10), budget.reserve(1))
                .await
                .is_err()
        );
        drop(reservation);
        let permit = budget.reserve(UNIT).await;
        assert_eq!(budget.0.available_permits(), 0);
        drop(permit);
        assert_eq!(budget.0.available_permits(), 1);
    }

    #[tokio::test]
    async fn cancelled_reservations_do_not_leak_or_allocate_a_body() {
        let budget = ResponseBudget::new(UNIT * 2);
        let first = budget.reserve(UNIT + 1).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(10), budget.reserve(1))
                .await
                .is_err()
        );
        drop(first);
        assert_eq!(budget.0.available_permits(), 2);
        let next = budget.reserve(UNIT * 2).await;
        drop(next);
        assert_eq!(budget.0.available_permits(), 2);
    }
}
