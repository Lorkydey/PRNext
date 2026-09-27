//! Bound waiting requests separately from requests with buffered bodies.
use std::{sync::Arc, time::Duration};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(super) struct Admission {
    active: Arc<Semaphore>,
    waiting: Arc<Semaphore>,
    timeout: Duration,
    adaptive: Option<super::adaptive::Adaptive>,
    starting: Option<Arc<Semaphore>>,
    pub(super) bodies: crate::pool::BodyBudget,
}

#[derive(Debug)]
pub(super) enum AdmissionError {
    Full,
    Timeout,
}

impl Admission {
    pub(super) fn new(workers: usize) -> Self {
        Self::concurrent(workers, 1)
    }

    pub(super) fn concurrent(workers: usize, lanes: usize) -> Self {
        let ceiling = workers * lanes.max(4);
        let active = Arc::new(Semaphore::new(ceiling));
        let adaptive =
            (std::env::var("PRNEXT_ADAPTIVE_ADMISSION").as_deref() == Ok("1")).then(|| {
                super::adaptive::Adaptive::new(
                    active.clone(),
                    workers * if lanes > 16 { 16 } else { 4 },
                    ceiling,
                )
            });
        Self {
            // Waiters retain unread bodies; legacy stdio keeps four admissions.
            active,
            adaptive,
            starting: None,
            waiting: Arc::new(Semaphore::new(
                (workers * if lanes > 1 { 256 } else { 64 }).min(1024),
            )),
            timeout: Duration::from_secs(30),
            bodies: crate::pool::BodyBudget::default(),
        }
    }

    /// Keep expensive pre-header work bounded independently of live streams.
    pub(super) fn with_start_limit(mut self, limit: usize) -> Self {
        self.starting = Some(Arc::new(Semaphore::new(limit.max(1))));
        self
    }

    pub(super) async fn acquire_start(
        &self,
    ) -> Result<Option<OwnedSemaphorePermit>, AdmissionError> {
        let Some(starting) = &self.starting else {
            return Ok(None);
        };
        tokio::time::timeout(self.timeout, starting.clone().acquire_owned())
            .await
            .map_err(|_| AdmissionError::Timeout)?
            .map(Some)
            .map_err(|_| AdmissionError::Full)
    }

    pub(super) async fn acquire(&self) -> Result<OwnedSemaphorePermit, AdmissionError> {
        if let Some(controller) = &self.adaptive {
            controller.reconcile();
        }
        while let Ok(permit) = self.active.clone().try_acquire_owned() {
            if let Some(permit) = self.accept(permit) {
                return Ok(permit);
            }
        }
        // Waiters retain only the unconsumed HTTP request, not an 8 MiB body or
        // a base64 worker payload. Dropping this future releases its queue slot.
        let _waiting = self
            .waiting
            .clone()
            .try_acquire_owned()
            .map_err(|_| AdmissionError::Full)?;
        tokio::time::timeout(self.timeout, async {
            loop {
                let permit = self.active.clone().acquire_owned().await?;
                if let Some(permit) = self.accept(permit) {
                    return Ok::<_, tokio::sync::AcquireError>(permit);
                }
            }
        })
        .await
        .map_err(|_| AdmissionError::Timeout)?
        .map_err(|_| AdmissionError::Full)
    }

    fn accept(&self, permit: OwnedSemaphorePermit) -> Option<OwnedSemaphorePermit> {
        match &self.adaptive {
            Some(controller) => controller.accept(permit),
            None => Some(permit),
        }
    }

    pub(super) fn start_sample(&self) -> Option<std::time::Instant> {
        self.adaptive.as_ref().map(|_| std::time::Instant::now())
    }
    pub(super) fn record(&self, started: Option<std::time::Instant>, success: bool) {
        if success {
            if let (Some(controller), Some(started)) = (&self.adaptive, started) {
                controller.record(started.elapsed());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn waiting_is_bounded_and_cancellation_releases_capacity() {
        let admission = Arc::new(Admission {
            active: Arc::new(Semaphore::new(1)),
            waiting: Arc::new(Semaphore::new(1)),
            timeout: Duration::from_secs(1),
            adaptive: None,
            starting: None,
            bodies: crate::pool::BodyBudget::default(),
        });
        let running = admission.acquire().await.unwrap();
        let pending = tokio::spawn({
            let admission = admission.clone();
            async move { admission.acquire().await }
        });
        while admission.waiting.available_permits() != 0 {
            tokio::task::yield_now().await;
        }
        assert!(matches!(
            admission.acquire().await,
            Err(AdmissionError::Full)
        ));
        pending.abort();
        let _ = pending.await;
        assert_eq!(admission.waiting.available_permits(), 1);
        drop(running);
        assert!(admission.acquire().await.is_ok());
    }

    #[tokio::test]
    async fn waiters_resume_in_order_and_timeout_without_leaking_slots() {
        let admission = Arc::new(Admission {
            active: Arc::new(Semaphore::new(1)),
            waiting: Arc::new(Semaphore::new(2)),
            timeout: Duration::from_millis(100),
            adaptive: None,
            starting: None,
            bodies: crate::pool::BodyBudget::default(),
        });
        let running = admission.acquire().await.unwrap();
        let first = tokio::spawn({
            let admission = admission.clone();
            async move { admission.acquire().await }
        });
        while admission.waiting.available_permits() != 1 {
            tokio::task::yield_now().await;
        }
        drop(running);
        let first = first.await.unwrap().unwrap();
        assert!(matches!(
            admission.acquire().await,
            Err(AdmissionError::Timeout)
        ));
        assert_eq!(admission.waiting.available_permits(), 2);
        drop(first);
        assert!(admission.acquire().await.is_ok());
    }
}
