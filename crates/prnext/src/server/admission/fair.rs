//! Route-pattern turns over the existing resource semaphore. There is no
//! executor, timer task, per-URL state, or reservation of idle execution slots.
use super::AdmissionError;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

pub(crate) struct FairQueue {
    state: Arc<Mutex<State>>,
    per_route: usize,
    limit: usize,
}
#[derive(Default)]
struct State {
    routes: HashMap<String, VecDeque<Arc<Notify>>>,
    turns: VecDeque<String>,
    queued: usize,
}
pub(crate) struct Ticket {
    state: Arc<Mutex<State>>,
    route: String,
    signal: Arc<Notify>,
    queued: bool,
    resource: Arc<Semaphore>,
    _waiting: Option<OwnedSemaphorePermit>,
}
pub(crate) enum Pending {
    Ready(OwnedSemaphorePermit),
    Queued(Ticket),
}
impl FairQueue {
    pub(crate) fn new(waiting_limit: usize) -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
            per_route: (waiting_limit / 2).max(1),
            limit: waiting_limit.max(1),
        }
    }

    /// A second scheduling stage whose callers already hold a bounded upstream
    /// admission. Keep route turns, but do not reject an admitted burst merely
    /// because its requests share one pattern.
    pub(crate) fn admitted(admission_limit: usize) -> Self {
        Self {
            per_route: admission_limit.max(1),
            ..Self::new(admission_limit)
        }
    }

    pub(crate) async fn acquire(
        &self,
        resource: &Arc<Semaphore>,
        waiting: Option<&Arc<Semaphore>>,
        route: &str,
        deadline: tokio::time::Instant,
        accept: impl Fn(OwnedSemaphorePermit) -> Option<OwnedSemaphorePermit>,
    ) -> Result<OwnedSemaphorePermit, AdmissionError> {
        if tokio::time::Instant::now() >= deadline {
            return Err(AdmissionError::Timeout);
        }
        self.begin(resource, waiting, route, &accept)?
            .acquire(deadline, accept)
            .await
    }

    /// Enroll synchronously, so bounded/single-flight producers can publish a
    /// waiter before spawning its supervised async continuation.
    pub(crate) fn begin(
        &self,
        resource: &Arc<Semaphore>,
        waiting: Option<&Arc<Semaphore>>,
        route: &str,
        accept: impl Fn(OwnedSemaphorePermit) -> Option<OwnedSemaphorePermit>,
    ) -> Result<Pending, AdmissionError> {
        let mut state = self.state.lock().unwrap();
        // Never bypass queued routes. In the uncontended case, including a
        // single busy route with free capacity, no ticket is allocated.
        if state.turns.is_empty() {
            while let Ok(permit) = resource.clone().try_acquire_owned() {
                if let Some(permit) = accept(permit) {
                    return Ok(Pending::Ready(permit));
                }
            }
        }
        if state.queued >= self.limit
            || state
                .routes
                .get(route)
                .is_some_and(|queue| queue.len() >= self.per_route)
        {
            return Err(AdmissionError::Full);
        }
        let waiting = waiting
            .map(|slots| slots.clone().try_acquire_owned())
            .transpose()
            .map_err(|_| AdmissionError::Full)?;
        let signal = Arc::new(Notify::new());
        if let Some(queue) = state.routes.get_mut(route) {
            queue.push_back(signal.clone());
        } else {
            state.turns.push_back(route.to_owned());
            state
                .routes
                .insert(route.to_owned(), VecDeque::from([signal.clone()]));
        }
        state.queued += 1;
        Ok(Pending::Queued(Ticket {
            state: self.state.clone(),
            route: route.to_owned(),
            signal,
            queued: true,
            resource: resource.clone(),
            _waiting: waiting,
        }))
    }
}
impl Pending {
    pub(crate) fn is_queued(&self) -> bool {
        matches!(self, Self::Queued(_))
    }
    pub(crate) async fn acquire(
        self,
        deadline: tokio::time::Instant,
        accept: impl Fn(OwnedSemaphorePermit) -> Option<OwnedSemaphorePermit>,
    ) -> Result<OwnedSemaphorePermit, AdmissionError> {
        let mut ticket = match self {
            Self::Ready(permit) => {
                return if tokio::time::Instant::now() >= deadline {
                    Err(AdmissionError::Timeout)
                } else {
                    Ok(permit)
                }
            }
            Self::Queued(ticket) => ticket,
        };
        loop {
            if tokio::time::Instant::now() >= deadline {
                return Err(AdmissionError::Timeout);
            }
            if ticket.is_head() {
                // Only the current route head waits on the semaphore. New
                // arrivals cannot join its FIFO ahead of another route's turn.
                let permit =
                    tokio::time::timeout_at(deadline, ticket.resource.clone().acquire_owned())
                        .await
                        .map_err(|_| AdmissionError::Timeout)?
                        .map_err(|_| AdmissionError::Full)?;
                if let Some(permit) = accept(permit) {
                    ticket.remove(true);
                    return Ok(permit);
                }
            } else {
                tokio::time::timeout_at(deadline, ticket.signal.notified())
                    .await
                    .map_err(|_| AdmissionError::Timeout)?;
            }
        }
    }
}
impl Ticket {
    fn is_head(&self) -> bool {
        let state = self.state.lock().unwrap();
        state
            .turns
            .front()
            .is_some_and(|route| route == &self.route)
            && state
                .routes
                .get(&self.route)
                .and_then(|queue| queue.front())
                .is_some_and(|signal| Arc::ptr_eq(signal, &self.signal))
    }
    fn remove(&mut self, granted: bool) {
        if !self.queued {
            return;
        }
        self.queued = false;
        let mut state = self.state.lock().unwrap();
        let Some(queue) = state.routes.get_mut(&self.route) else {
            return;
        };
        let Some(index) = queue
            .iter()
            .position(|signal| Arc::ptr_eq(signal, &self.signal))
        else {
            return;
        };
        queue.remove(index);
        let empty = queue.is_empty();
        state.queued -= 1;
        if empty {
            state.routes.remove(&self.route);
        }
        if empty || granted {
            if let Some(index) = state.turns.iter().position(|route| route == &self.route) {
                let route = state.turns.remove(index).unwrap();
                if !empty {
                    state.turns.push_back(route);
                }
            }
        }
        if let Some(signal) = state
            .turns
            .front()
            .and_then(|route| state.routes.get(route))
            .and_then(|queue| queue.front())
        {
            signal.notify_one();
        }
    }
}
impl Drop for Ticket {
    fn drop(&mut self) {
        self.remove(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    async fn queued(queue: &FairQueue, count: usize) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while queue.state.lock().unwrap().queued != count {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn hot_backlog_leaves_room_and_cold_work_finishes_before_the_backlog() {
        let queue = Arc::new(FairQueue::new(16));
        let resource = Arc::new(Semaphore::new(1));
        let occupied = resource.clone().acquire_owned().await.unwrap();
        let (events, mut starts) = tokio::sync::mpsc::unbounded_channel();
        let mut hot = Vec::new();
        for index in 0..8 {
            hot.push(tokio::spawn({
                let queue = queue.clone();
                let resource = resource.clone();
                let events = events.clone();
                async move {
                    let _permit = queue
                        .acquire(
                            &resource,
                            None,
                            "/expensive/[id]",
                            tokio::time::Instant::now() + Duration::from_secs(5),
                            Some,
                        )
                        .await
                        .unwrap();
                    events.send(("hot", index)).unwrap();
                    tokio::time::sleep(Duration::from_millis(35)).await;
                }
            }));
            queued(&queue, index + 1).await;
        }
        // Different request IDs/parameters must not buy more queue capacity.
        assert!(matches!(
            queue
                .acquire(
                    &resource,
                    None,
                    "/expensive/[id]",
                    tokio::time::Instant::now() + Duration::from_secs(1),
                    Some
                )
                .await,
            Err(AdmissionError::Full)
        ));
        let cold = tokio::spawn({
            let queue = queue.clone();
            let resource = resource.clone();
            let events = events.clone();
            async move {
                let _permit = queue
                    .acquire(
                        &resource,
                        None,
                        "/health",
                        tokio::time::Instant::now() + Duration::from_secs(5),
                        Some,
                    )
                    .await
                    .unwrap();
                events.send(("cold", 0)).unwrap();
            }
        });
        queued(&queue, 9).await;
        drop(occupied);
        assert_eq!(starts.recv().await, Some(("hot", 0)));
        assert_eq!(starts.recv().await, Some(("cold", 0)));
        cold.await.unwrap();
        for task in hot {
            task.await.unwrap();
        }
        assert_eq!(resource.available_permits(), 1);
        let state = queue.state.lock().unwrap();
        assert!(state.routes.is_empty() && state.turns.is_empty());
        assert_eq!(state.queued, 0);
    }

    #[tokio::test]
    async fn cancellation_timeout_and_head_removal_release_all_route_state() {
        let queue = Arc::new(FairQueue::new(8));
        let resource = Arc::new(Semaphore::new(1));
        let occupied = resource.clone().acquire_owned().await.unwrap();
        let mut tasks = Vec::new();
        for pattern in ["/a", "/a", "/b", "/c"] {
            tasks.push(tokio::spawn({
                let queue = queue.clone();
                let resource = resource.clone();
                async move {
                    queue
                        .acquire(
                            &resource,
                            None,
                            pattern,
                            tokio::time::Instant::now() + Duration::from_secs(5),
                            Some,
                        )
                        .await
                }
            }));
            queued(&queue, tasks.len()).await;
        }
        tasks.remove(1).abort(); // Remove a non-head waiter from the same route.
        queued(&queue, 3).await;
        let head = tasks.remove(0);
        head.abort();
        let _ = head.await;
        queued(&queue, 2).await;
        assert!(matches!(
            queue
                .acquire(
                    &resource,
                    None,
                    "/timeout",
                    tokio::time::Instant::now() + Duration::from_millis(15),
                    Some
                )
                .await,
            Err(AdmissionError::Timeout)
        ));
        drop(occupied);
        let first = tasks.remove(0).await.unwrap().unwrap();
        assert!(!tasks[0].is_finished());
        drop(first);
        drop(tasks.remove(0).await.unwrap().unwrap());
        queued(&queue, 0).await;
        assert!(queue.state.lock().unwrap().routes.is_empty());
        assert_eq!(resource.available_permits(), 1);
    }

    #[tokio::test]
    async fn single_pattern_uses_every_execution_slot_and_queue_cardinality_is_bounded() {
        let queue = Arc::new(FairQueue::new(4));
        let resource = Arc::new(Semaphore::new(16));
        let mut permits = Vec::new();
        for _ in 0..16 {
            permits.push(
                queue
                    .acquire(
                        &resource,
                        None,
                        "/only",
                        tokio::time::Instant::now() + Duration::from_secs(1),
                        Some,
                    )
                    .await
                    .unwrap(),
            );
        }
        assert_eq!(resource.available_permits(), 0);
        assert_eq!(queue.state.lock().unwrap().queued, 0);
        let mut tasks = Vec::new();
        for pattern in ["/a", "/b", "/c", "/d"] {
            tasks.push(tokio::spawn({
                let queue = queue.clone();
                let resource = resource.clone();
                async move {
                    queue
                        .acquire(
                            &resource,
                            None,
                            pattern,
                            tokio::time::Instant::now() + Duration::from_secs(2),
                            Some,
                        )
                        .await
                }
            }));
            queued(&queue, tasks.len()).await;
        }
        assert_eq!(queue.state.lock().unwrap().routes.len(), 4);
        assert!(matches!(
            queue
                .acquire(
                    &resource,
                    None,
                    "/e",
                    tokio::time::Instant::now() + Duration::from_secs(1),
                    Some
                )
                .await,
            Err(AdmissionError::Full)
        ));
        for task in tasks {
            task.abort();
            let _ = task.await;
        }
        queued(&queue, 0).await;
        assert!(queue.state.lock().unwrap().routes.is_empty());
        drop(permits);
        assert_eq!(resource.available_permits(), 16);
    }

    #[tokio::test]
    async fn enrolled_tickets_cancel_before_poll_and_survive_the_producer_owner() {
        let queue = FairQueue::new(4);
        let resource = Arc::new(Semaphore::new(1));
        let waiting = Arc::new(Semaphore::new(1));
        let active = queue
            .begin(&resource, Some(&waiting), "/only", Some)
            .unwrap();
        assert_eq!(resource.available_permits(), 0);
        let discarded = queue
            .begin(&resource, Some(&waiting), "/discarded", Some)
            .unwrap();
        assert_eq!(waiting.available_permits(), 0);
        drop(discarded);
        assert_eq!(waiting.available_permits(), 1);
        assert!(queue.state.lock().unwrap().routes.is_empty());
        let retained = queue
            .begin(&resource, Some(&waiting), "/retained", Some)
            .unwrap();
        drop(queue);
        drop(active);
        let permit = retained
            .acquire(tokio::time::Instant::now() + Duration::from_secs(1), Some)
            .await
            .unwrap();
        assert_eq!(waiting.available_permits(), 1);
        drop(permit);
        assert_eq!(resource.available_permits(), 1);
    }
}
