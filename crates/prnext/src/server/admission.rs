//! Bound waiting requests separately from requests with buffered bodies.
use crate::metrics::{Budget, BudgetWait, Outcome, Stage, StageSpan};
use std::{sync::Arc, time::Duration};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(super) struct Admission {
    active: Arc<Semaphore>,
    waiting: Arc<Semaphore>,
    timeout: Duration,
    adaptive: Option<super::adaptive::Adaptive>,
    starting: Option<Arc<Semaphore>>,
    pub(super) bodies: crate::pool::BodyBudget,
    kind: Budget,
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
        crate::metrics::register_budget(Budget::RenderLive, &active, ceiling, 1);
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
            kind: Budget::RenderLive,
        }
    }

    /// Keep expensive pre-header work bounded independently of live streams.
    pub(super) fn with_start_limit(mut self, limit: usize) -> Self {
        self.starting = Some(Arc::new(Semaphore::new(limit.max(1))));
        crate::metrics::register_budget(
            Budget::RenderStart,
            self.starting.as_ref().unwrap(),
            limit.max(1),
            1,
        );
        self
    }

    pub(super) fn api(mut self) -> Self {
        // Remove the constructor's render registration before assigning its class.
        crate::metrics::reclassify_budget(Budget::RenderLive, Budget::ApiLive, &self.active);
        self.kind = Budget::ApiLive;
        self
    }

    pub(super) fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub(super) async fn acquire_start_until(
        &self,
        deadline: tokio::time::Instant,
    ) -> Result<Option<OwnedSemaphorePermit>, AdmissionError> {
        let Some(starting) = &self.starting else {
            return Ok(None);
        };
        let mut span = StageSpan::new(Stage::RenderStart);
        let mut wait = BudgetWait::new(Budget::RenderStart);
        let result = if tokio::time::Instant::now() >= deadline {
            Err(AdmissionError::Timeout)
        } else {
            match tokio::time::timeout_at(deadline, starting.clone().acquire_owned()).await {
                Err(_) => Err(AdmissionError::Timeout),
                Ok(Err(_)) => Err(AdmissionError::Full),
                Ok(Ok(permit)) => Ok(Some(permit)),
            }
        };
        let outcome = match &result {
            Ok(_) => Outcome::Completed,
            Err(AdmissionError::Timeout) => Outcome::TimedOut,
            Err(_) => Outcome::Failed,
        };
        span.finish(outcome);
        wait.finish(outcome);
        result
    }

    #[cfg(test)]
    pub(super) async fn acquire(&self) -> Result<OwnedSemaphorePermit, AdmissionError> {
        self.acquire_until(tokio::time::Instant::now() + self.timeout)
            .await
    }
    pub(super) async fn acquire_until(
        &self,
        deadline: tokio::time::Instant,
    ) -> Result<OwnedSemaphorePermit, AdmissionError> {
        let mut span = StageSpan::new(Stage::Admission);
        let mut wait = BudgetWait::new(self.kind);
        let result = self
            .acquire_inner(deadline.min(tokio::time::Instant::now() + self.timeout))
            .await;
        let outcome = match &result {
            Ok(_) => Outcome::Completed,
            Err(AdmissionError::Timeout) => Outcome::TimedOut,
            Err(_) => Outcome::Failed,
        };
        span.finish(outcome);
        wait.finish(outcome);
        result
    }
    async fn acquire_inner(
        &self,
        deadline: tokio::time::Instant,
    ) -> Result<OwnedSemaphorePermit, AdmissionError> {
        if tokio::time::Instant::now() >= deadline {
            return Err(AdmissionError::Timeout);
        }
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
        tokio::time::timeout_at(deadline, async {
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
    async fn live_and_start_waits_share_the_queue_deadline_and_release_capacity() {
        let admission = Arc::new(Admission::concurrent(1, 1).with_start_limit(1));
        let live = admission
            .active
            .clone()
            .acquire_many_owned(4)
            .await
            .unwrap();
        let start = admission
            .starting
            .as_ref()
            .unwrap()
            .clone()
            .acquire_owned()
            .await
            .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(100);
        let waiting = tokio::spawn({
            let admission = admission.clone();
            async move {
                let _live = admission.acquire_until(deadline).await.unwrap();
                admission.acquire_start_until(deadline).await
            }
        });
        tokio::time::sleep(Duration::from_millis(55)).await;
        drop(live);
        assert!(matches!(
            waiting.await.unwrap(),
            Err(AdmissionError::Timeout)
        ));
        assert_eq!(admission.active.available_permits(), 4);
        drop(start);
        assert!(admission
            .acquire_start_until(tokio::time::Instant::now() + Duration::from_secs(1))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn waiting_is_bounded_and_cancellation_releases_capacity() {
        let admission = Arc::new(Admission {
            active: Arc::new(Semaphore::new(1)),
            waiting: Arc::new(Semaphore::new(1)),
            timeout: Duration::from_secs(1),
            adaptive: None,
            starting: None,
            bodies: crate::pool::BodyBudget::default(),
            kind: Budget::RenderLive,
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
            kind: Budget::RenderLive,
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
