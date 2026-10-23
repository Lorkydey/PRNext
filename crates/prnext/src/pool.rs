mod body_budget;
mod compile_cache;
mod lifecycle;
mod memory;
mod node_path;
mod parent;
mod response_budget;
mod socket;
use crate::routing::Params;
use anyhow::{anyhow, bail, Context, Result};
use axum::body::Bytes;
use base64::{engine::general_purpose::STANDARD, Engine};
pub use body_budget::{BodyBudget, BodyLease};
use futures_core::Stream;
pub(crate) use lifecycle::Lifecycle;
use response_budget::ResponseBudget;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    pin::Pin,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    task::{Context as TaskContext, Poll, Waker},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{mpsc, oneshot, OnceCell, OwnedSemaphorePermit},
    time::timeout,
};

pub const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_WIRE_BYTES: usize = 24 * 1024 * 1024;
const MAX_FRAME_BYTES: usize = 64 * 1024;
const MAX_CHUNK_BYTES: usize = 64 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Serialize)]
pub struct RoutingResolver {
    pub url: String,
    pub token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerRequest {
    #[serde(skip)]
    pub max_duration: Option<Duration>,
    pub id: u64,
    pub route_id: String,
    pub method: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_url: Option<String>,
    pub headers: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routing_request_headers: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routing_resolver: Option<RoutingResolver>,
    #[serde(skip)]
    pub body: WorkerBody,
    pub params: Params,
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub render_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revalidate_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_failure: Option<PageFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_request: Option<DocumentRequest>,
    pub middleware_matched: bool,
}

#[derive(Debug, Default)]
pub struct WorkerBody {
    bytes: Bytes,
    _lease: Option<BodyLease>,
}
impl WorkerBody {
    pub fn new(bytes: Bytes, lease: BodyLease) -> Self {
        Self {
            bytes,
            _lease: Some(lease),
        }
    }
}
impl From<Bytes> for WorkerBody {
    fn from(bytes: Bytes) -> Self {
        Self {
            bytes,
            _lease: None,
        }
    }
}
impl From<Vec<u8>> for WorkerBody {
    fn from(bytes: Vec<u8>) -> Self {
        Bytes::from(bytes).into()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRequest {
    pub url: String,
    pub original_url: Option<String>,
    pub method: String,
    pub headers: BTreeMap<String, String>,
}

#[derive(Clone, Copy)]
pub struct DocumentRequestSource<'a> {
    pub uri: &'a axum::http::Uri,
    pub original_url: Option<&'a str>,
    pub method: &'a axum::http::Method,
    pub headers: &'a axum::http::HeaderMap,
}
#[derive(Debug)]
pub struct DocumentRequestTooLarge;
impl std::fmt::Display for DocumentRequestTooLarge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Document request context exceeds 64 KiB")
    }
}
impl std::error::Error for DocumentRequestTooLarge {}
impl DocumentRequestSource<'_> {
    pub fn capture(self) -> Result<DocumentRequest> {
        let url = self
            .uri
            .path_and_query()
            .map(|value| value.as_str())
            .unwrap_or("/");
        let size = url.len()
            + self.original_url.map(str::len).unwrap_or(0)
            + self
                .headers
                .iter()
                .map(|(name, value)| name.as_str().len() + value.len() + 4)
                .sum::<usize>();
        if size > 64 * 1024 {
            return Err(DocumentRequestTooLarge.into());
        }
        Ok(DocumentRequest {
            url: url.into(),
            original_url: self.original_url.map(str::to_owned),
            method: self.method.to_string(),
            headers: crate::server::request_headers(self.headers),
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageFailure {
    pub name: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
    #[serde(
        default,
        deserialize_with = "present_error_code",
        skip_serializing_if = "Option::is_none"
    )]
    pub code: Option<serde_json::Value>,
}
fn present_error_code<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<serde_json::Value>, D::Error> {
    serde_json::Value::deserialize(deserializer).map(Some)
}
impl PageFailure {
    fn validate(&self) -> Result<()> {
        if self.name.len() > 128
            || self.message.len() > 2048
            || self.stack.as_ref().is_some_and(|stack| stack.len() > 4096)
            || self
                .status_code
                .is_some_and(|status| !(100..=599).contains(&status))
            || self.code.as_ref().is_some_and(|code| match code {
                serde_json::Value::String(value) => value.len() > 256,
                serde_json::Value::Null
                | serde_json::Value::Bool(_)
                | serde_json::Value::Number(_) => false,
                _ => true,
            })
        {
            bail!("invalid private page failure summary");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum HeaderValues {
    Single(String),
    Multiple(Vec<String>),
}

impl HeaderValues {
    pub fn values(&self) -> &[String] {
        match self {
            Self::Single(value) => std::slice::from_ref(value),
            Self::Multiple(values) => values,
        }
    }
    pub fn first(&self) -> Option<&str> {
        self.values().first().map(String::as_str)
    }
}
impl From<String> for HeaderValues {
    fn from(value: String) -> Self {
        Self::Single(value)
    }
}
impl From<&str> for HeaderValues {
    fn from(value: &str) -> Self {
        Self::Single(value.into())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IsrMetadata {
    #[serde(default)]
    pub kind: Option<String>,
    pub revalidate: crate::manifest::Revalidate,
    pub html_length: usize,
    pub data_length: usize,
    #[serde(default)]
    pub dynamic: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub last_modified: Option<i64>,
    #[serde(default)]
    pub cache_version: Option<String>,
}

#[derive(Deserialize)]
struct ReplyEnvelope {
    id: u64,
    status: u16,
    #[serde(default)]
    headers: BTreeMap<String, HeaderValues>,
    body: Option<String>,
    length: Option<usize>,
    #[serde(default, rename = "type")]
    kind: ReplyKind,
    isr: Option<IsrMetadata>,
    #[serde(default, rename = "pageError")]
    page_error: Option<u16>,
    #[serde(default, rename = "pageFailure")]
    page_failure: Option<PageFailure>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ReplyKind {
    // Absence alone selects the legacy protocol; explicit null or an unknown
    // type must not silently become a buffered response.
    #[default]
    #[serde(skip)]
    Buffered,
    Head,
    Complete,
}

pub struct RenderedResponse {
    pub status: u16,
    pub headers: BTreeMap<String, HeaderValues>,
    pub body: RenderedBody,
    pub isr: Option<IsrMetadata>,
    pub page_error: Option<u16>,
    pub page_failure: Option<PageFailure>,
}

pub enum RenderedBody {
    Buffered(Vec<u8>),
    Stream(ResponseStream),
    Compact(CompactBody),
}

/// A negotiated complete response of at most 16 KiB. No streaming channel or
/// frame-pump task is needed. Admission and the shared byte budget remain owned
/// until HTTP polls or drops this body, including a disconnected slow consumer.
pub struct CompactBody {
    bytes: Option<Bytes>,
    reservation: Option<OwnedSemaphorePermit>,
    admission: Option<OwnedSemaphorePermit>,
}
impl CompactBody {
    pub fn len(&self) -> usize {
        self.bytes.as_ref().map_or(0, Bytes::len)
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}
impl Stream for CompactBody {
    type Item = std::result::Result<Bytes, std::io::Error>;
    fn poll_next(mut self: Pin<&mut Self>, _: &mut TaskContext<'_>) -> Poll<Option<Self::Item>> {
        self.reservation.take();
        self.admission.take();
        Poll::Ready(self.bytes.take().filter(|bytes| !bytes.is_empty()).map(Ok))
    }
}

enum StreamItem {
    Chunk(Bytes, OwnedSemaphorePermit),
    End,
}

/// A single consumer with four queued chunks at most. Dropping the body closes
/// the receiver, interrupting both pipe reads and a blocked producer immediately.
pub struct ResponseStream {
    state: Arc<StdMutex<ResponseStreamState>>,
    complete: Option<oneshot::Sender<()>>,
    ended: bool,
}

struct ResponseStreamState {
    receiver: Option<mpsc::Receiver<StreamItem>>,
    waker: Option<Waker>,
    consumed: tokio::time::Instant,
}

impl ResponseStreamState {
    fn cancel(state: &StdMutex<Self>) {
        let waker = {
            let mut state = state.lock().unwrap();
            // Drop all queued bytes now, even if a stalled socket never polls
            // its HTTP body again after its worker has been retired.
            state.receiver.take();
            state.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

impl Drop for ResponseStream {
    fn drop(&mut self) {
        ResponseStreamState::cancel(&self.state);
    }
}

impl Stream for ResponseStream {
    type Item = std::result::Result<Bytes, std::io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Option<Self::Item>> {
        if self.ended {
            return Poll::Ready(None);
        }
        let item = {
            let mut state = self.state.lock().unwrap();
            if !state
                .waker
                .as_ref()
                .is_some_and(|waker| waker.will_wake(cx.waker()))
            {
                state.waker = Some(cx.waker().clone());
            }
            let item = match &mut state.receiver {
                Some(receiver) => receiver.poll_recv(cx),
                None => Poll::Ready(None),
            };
            if matches!(&item, Poll::Ready(Some(StreamItem::Chunk(_, _)))) {
                state.consumed = tokio::time::Instant::now();
            }
            item
        };
        match item {
            Poll::Ready(Some(StreamItem::Chunk(bytes, _reservation))) => {
                Poll::Ready(Some(Ok(bytes)))
            }
            Poll::Ready(Some(StreamItem::End)) => {
                self.ended = true;
                {
                    let mut state = self.state.lock().unwrap();
                    state.receiver.take();
                    // We are already polling this body. Only cancellation from
                    // another task needs to wake its stored HTTP consumer.
                    state.waker.take();
                }
                if let Some(complete) = self.complete.take() {
                    let _ = complete.send(());
                }
                Poll::Ready(None)
            }
            Poll::Ready(None) => {
                self.ended = true;
                self.complete.take();
                // Never expose errors from an application or the worker protocol.
                Poll::Ready(Some(Err(std::io::Error::other("Render stream failed"))))
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

struct Job {
    payload: Arc<StdMutex<Option<JobPayload>>>,
    reply: oneshot::Sender<Result<RenderedResponse>>,
    deadline: tokio::time::Instant,
}

struct JobPayload {
    queued_metric: crate::metrics::Gauge,
    request: WorkerRequest,
    permit: Option<OwnedSemaphorePermit>,
    start_permit: Option<OwnedSemaphorePermit>,
}

struct CancelQueuedJob(Arc<StdMutex<Option<JobPayload>>>);

impl Drop for CancelQueuedJob {
    fn drop(&mut self) {
        // A preceding streaming response may remain active for hours. Cancelled
        // requests must release their request buffers and admission immediately,
        // without waiting for that worker to dequeue the next job.
        self.0.lock().unwrap().take();
    }
}

#[derive(Debug)]
pub enum PoolError {
    Overloaded,
    Timeout,
    Worker(anyhow::Error),
}

#[derive(Clone)]
pub struct WorkerPool {
    config: WorkerConfig,
    workers: usize,
    sender: Arc<OnceCell<mpsc::Sender<Job>>>,
    sequence: Arc<AtomicU64>,
    concurrency: usize,
    timeout: Duration,
    retire_after: Option<Duration>,
    lane_retire_after: Option<Duration>,
    response_budget: ResponseBudget,
    lifecycle: Lifecycle,
}

#[derive(Clone)]
pub struct WorkerConfig {
    pub node: PathBuf,
    pub script: PathBuf,
    pub project: PathBuf,
    pub dist: PathBuf,
    pub cache: Option<crate::cache::CacheCredentials>,
}

impl WorkerPool {
    pub fn new(config: WorkerConfig, workers: usize) -> Self {
        Self {
            config,
            workers,
            sender: Arc::new(OnceCell::new()),
            sequence: Arc::new(AtomicU64::new(1)),
            concurrency: 1,
            timeout: REQUEST_TIMEOUT,
            retire_after: None,
            lane_retire_after: Some(Duration::from_secs(30)),
            response_budget: ResponseBudget::default(),
            lifecycle: Lifecycle::default(),
        }
    }

    pub(crate) fn with_lifecycle(mut self, lifecycle: Lifecycle) -> Self {
        self.lifecycle = lifecycle;
        self
    }

    pub(crate) fn background(
        &self,
        future: impl std::future::Future<Output = ()> + Send + 'static,
    ) -> Result<()> {
        let work = self.lifecycle.work()?;
        self.lifecycle.spawn(async move {
            let _work = work;
            future.await;
        });
        Ok(())
    }

    /// Independent bounded socket lanes share one Node process and heap.
    pub fn concurrent(mut self, lanes: usize) -> Self {
        self.concurrency = lanes.clamp(1, 512);
        self
    }

    pub fn capacity(&self) -> usize {
        self.workers * self.concurrency
    }

    pub fn retire_after(mut self, duration: Duration) -> Self {
        self.retire_after = Some(duration);
        self
    }

    pub fn retirement(mut self, host: Option<Duration>, lane: Option<Duration>) -> Self {
        self.retire_after = host;
        self.lane_retire_after = lane;
        self
    }

    pub async fn request(
        &self,
        request: WorkerRequest,
        permit: Option<OwnedSemaphorePermit>,
    ) -> std::result::Result<RenderedResponse, PoolError> {
        self.request_with_start(request, permit, None).await
    }

    pub async fn request_with_start(
        &self,
        mut request: WorkerRequest,
        permit: Option<OwnedSemaphorePermit>,
        start_permit: Option<OwnedSemaphorePermit>,
    ) -> std::result::Result<RenderedResponse, PoolError> {
        let sender = self
            .sender
            .get_or_init(|| async {
                let (sender, receiver) =
                    mpsc::channel::<Job>(self.workers * self.concurrency.max(4));
                self.lifecycle.spawn(dispatch_workers(
                    self.config.clone(),
                    self.workers,
                    self.concurrency,
                    self.timeout,
                    self.retire_after,
                    self.lane_retire_after,
                    self.response_budget.clone(),
                    self.lifecycle.clone(),
                    receiver,
                ));
                sender
            })
            .await;
        request.id = self.sequence.fetch_add(1, Ordering::Relaxed);
        crate::metrics::event(crate::metrics::Event::Submitted);
        let (reply, result) = oneshot::channel();
        let deadline = tokio::time::Instant::now() + request.max_duration.unwrap_or(self.timeout);
        let admitted = permit.is_some();
        let payload = Arc::new(StdMutex::new(Some(JobPayload {
            queued_metric: crate::metrics::Gauge::queued(),
            request,
            permit,
            start_permit,
        })));
        let _cancel_queued = CancelQueuedJob(payload.clone());
        let job = Job {
            payload,
            reply,
            deadline,
        };
        if admitted {
            // Cancelled jobs release their permits before a busy worker can
            // dequeue their empty envelopes. Already-admitted callers should
            // wait for these channel slots, not receive a spurious 503. Their
            // bodies and count remain bounded by the caller's admission gate.
            tokio::time::timeout_at(deadline, sender.send(job))
                .await
                .map_err(|_| PoolError::Timeout)?
                .map_err(|_| PoolError::Worker(anyhow!("worker queue stopped")))?;
        } else {
            sender.try_send(job).map_err(|_| PoolError::Overloaded)?;
        }
        match tokio::time::timeout_at(deadline, result).await {
            Err(_) => Err(PoolError::Timeout),
            Ok(Err(_)) => Err(PoolError::Worker(anyhow!("worker task stopped"))),
            Ok(Ok(Err(error))) => Err(PoolError::Worker(error)),
            Ok(Ok(Ok(reply))) => Ok(reply),
        }
    }
}

// Reuse the most recently available lane. A sequential workload must not open
// hundreds of sockets just because its asynchronous admission limit is high.
// Only demand creates lanes; completion includes consumption of the HTTP body.
#[allow(clippy::too_many_arguments)]
async fn dispatch_workers(
    config: WorkerConfig,
    workers: usize,
    concurrency: usize,
    timeout: Duration,
    retire_after: Option<Duration>,
    lane_retire_after: Option<Duration>,
    response_budget: ResponseBudget,
    lifecycle: Lifecycle,
    mut requests: mpsc::Receiver<Job>,
) {
    let capacity = workers * concurrency;
    let (available, mut completed) = mpsc::channel(capacity);
    let hosts: Vec<_> = (0..workers)
        .map(|_| {
            (concurrency > 1).then(|| {
                Arc::new(socket::SharedHost::new(
                    config.clone(),
                    concurrency,
                    lifecycle.clone(),
                ))
            })
        })
        .collect();
    let mut lanes: Vec<mpsc::Sender<Job>> = Vec::new();
    let mut idle = Vec::new();
    let mut stopping = lifecycle.subscribe();
    loop {
        tokio::select! {
            biased;
            _ = Lifecycle::stopped(&mut stopping) => break,
            Some(index) = completed.recv() => idle.push(index),
            job = requests.recv(), if !idle.is_empty() || lanes.len() < capacity => {
                let Some(job) = job else { break };
                if job.reply.is_closed() || tokio::time::Instant::now() >= job.deadline { continue; }
                let index = if let Some(index) = idle.pop() { index } else {
                    let index = lanes.len();
                    let (sender, receiver) = mpsc::channel(1);
                    lanes.push(sender);
                    let retirement = if concurrency > 1 && index >= workers {
                        match (retire_after, lane_retire_after) {
                            (Some(host), Some(lane)) => Some(host.min(lane)),
                            (host, lane) => host.or(lane),
                        }
                    } else { retire_after };
                    let follow_host = index < workers || lane_retire_after.is_none()
                        || retire_after.is_some_and(|host| lane_retire_after.is_some_and(|lane| host <= lane));
                    lifecycle.spawn(run_worker(index, config.clone(), receiver,
                        timeout, retirement, follow_host, hosts[index % workers].clone(), available.clone(), response_budget.clone(), lifecycle.clone()));
                    index
                };
                // Each idle notification represents exactly one vacant slot.
                if let Err(error) = lanes[index].try_send(job) {
                    let job = error.into_inner();
                    let _ = job.reply.send(Err(anyhow!("worker lane stopped")));
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_worker(
    index: usize,
    config: WorkerConfig,
    mut receiver: mpsc::Receiver<Job>,
    idle_timeout: Duration,
    retire_after: Option<Duration>,
    follow_host: bool,
    host: Option<Arc<socket::SharedHost>>,
    available: mpsc::Sender<usize>,
    response_budget: ResponseBudget,
    lifecycle: Lifecycle,
) {
    let mut worker: Option<Worker> = None;
    // A cancelled socket lane discards incomplete framing, not its healthy
    // process. Keep the host until reconnect or the normal idle retirement.
    let mut retained_host: Option<Arc<socket::Host>> = None;
    let mut first = true;
    let mut draining = lifecycle.subscribe();
    loop {
        if lifecycle.is_draining() {
            if let Some(mut idle) = worker.take() {
                idle.stop_gracefully().await;
            }
            retained_host.take();
        }
        if !first && available.send(index).await.is_err() {
            break;
        }
        first = false;
        // Keep one connection per host warm; surplus connections release their
        // buffers and file descriptors after a burst. Idle tasks are lightweight.
        let drainable = worker.is_some() || retained_host.is_some();
        let receive = async {
            if let Some(duration) =
                retire_after.filter(|_| worker.is_some() || retained_host.is_some())
            {
                let idle_host = follow_host
                    .then(|| {
                        worker
                            .as_ref()
                            .and_then(|worker| worker.host.clone())
                            .or_else(|| retained_host.clone())
                    })
                    .flatten();
                let expired = async {
                    if let Some(host) = idle_host {
                        host.wait_idle(duration).await;
                    } else {
                        tokio::time::sleep(duration).await;
                    }
                };
                let received = tokio::select! {
                    biased;
                    job = receiver.recv() => Ok(job),
                    _ = expired => Err(()),
                };
                match received {
                    Ok(job) => job,
                    Err(_) => {
                        crate::metrics::event(crate::metrics::Event::LaneRetired);
                        if let Some(mut idle) = worker.take() {
                            // Stdio finalizers may still be running after the
                            // terminal response frame. EOF lets them settle.
                            idle.stop_gracefully().await;
                        }
                        retained_host.take();
                        receiver.recv().await
                    }
                }
            } else {
                receiver.recv().await
            }
        };
        let job = tokio::select! {
            biased;
            job = receive => job,
            _ = Lifecycle::draining(&mut draining), if drainable => {
                if let Some(mut idle) = worker.take() { idle.stop_gracefully().await; }
                retained_host.take();
                receiver.recv().await
            },
        };
        let Some(mut job) = job else { break };
        if job.reply.is_closed() || tokio::time::Instant::now() >= job.deadline {
            continue;
        }
        let Some(payload) = job.payload.lock().unwrap().take() else {
            continue;
        };
        drop(payload.queued_metric);
        let _active_metric = crate::metrics::Gauge::active();
        // Admission belongs to the job until the HTTP body consumes the end
        // marker, disconnects, or stalls. Slow clients cannot accumulate bodies
        // outside the bounded pool by merely receiving their response headers.
        let mut permit = payload.permit;
        let mut host_activity = None;
        let result = tokio::select! {
            _ = job.reply.closed() => Err(ConsumerCancelled { reusable: false }.into()),
            result = tokio::time::timeout_at(job.deadline, async {
            if worker.is_none() {
                worker = Some(match &host { Some(host) => host.connect().await?, None => Worker::spawn(&config, lifecycle.clone()).await? });
                retained_host.take();
            }
            host_activity = worker.as_ref().and_then(|worker| worker.host.as_ref()).map(|host|host.begin_activity());
            worker.as_mut().unwrap().request(&payload.request, &response_budget).await
        })
            => result.unwrap_or_else(|_| Err(anyhow!("render worker timed out"))),
        };
        let request_id = payload.request.id;
        let max_duration = payload.request.max_duration;
        // Pre-header work has finished. Only the separate live-response permit
        // remains held through streaming and downstream backpressure.
        drop(payload.start_permit);
        // Streaming responses can outlive their request body by hours.
        let _body_lease = payload.request.body._lease;
        drop(payload.request.body.bytes);
        let result = match result {
            Ok(FirstReply::Buffered(mut reply)) => {
                if let RenderedBody::Compact(body) = &mut reply.body {
                    body.admission = permit.take();
                }
                let _ = job.reply.send(Ok(reply));
                Ok(())
            }
            Ok(FirstReply::Head {
                status,
                headers,
                isr,
                page_error,
                page_failure,
            }) => {
                let (sender, receiver) = mpsc::channel(4);
                let state = Arc::new(StdMutex::new(ResponseStreamState {
                    receiver: Some(receiver),
                    waker: None,
                    consumed: tokio::time::Instant::now(),
                }));
                let (complete, completed) = oneshot::channel();
                let reply = RenderedResponse {
                    status,
                    headers,
                    isr,
                    page_error,
                    page_failure,
                    body: RenderedBody::Stream(ResponseStream {
                        state: state.clone(),
                        complete: Some(complete),
                        ended: false,
                    }),
                };
                if job.reply.send(Ok(reply)).is_err() {
                    Err(ConsumerCancelled { reusable: false }.into())
                } else {
                    let stream = worker.as_mut().unwrap().stream(
                        request_id,
                        sender,
                        &state,
                        completed,
                        max_duration.unwrap_or(idle_timeout),
                        &response_budget,
                    );
                    let result = if max_duration.is_some() {
                        tokio::time::timeout_at(job.deadline, stream)
                            .await
                            .unwrap_or_else(|_| Err(anyhow!("route maxDuration exceeded")))
                    } else {
                        stream.await
                    };
                    if result.is_err() {
                        ResponseStreamState::cancel(&state);
                    }
                    result
                }
            }
            Err(error) => {
                let cancellation = error.downcast_ref::<ConsumerCancelled>().copied();
                let message = error.to_string();
                let _ = job.reply.send(Err(error));
                Err(match cancellation {
                    Some(error) => error.into(),
                    None => anyhow!(message),
                })
            }
        };
        drop(host_activity);
        if let Err(error) = &result {
            if let Some(cancelled) = error.downcast_ref::<ConsumerCancelled>() {
                crate::metrics::event(crate::metrics::Event::Cancelled);
                tracing::debug!(
                    worker = index,
                    reusable = cancelled.reusable,
                    "HTTP consumer cancelled render response"
                );
                if cancelled.reusable {
                    continue;
                }
                if let Some(host) = worker.as_ref().and_then(|worker| worker.host.clone()) {
                    retained_host = Some(host);
                }
            } else {
                crate::metrics::event(crate::metrics::Event::Failed);
                tracing::warn!(worker = index, %error, "restarting render worker after failed request");
            }
            if let Some(mut failed) = worker.take() {
                crate::metrics::event(crate::metrics::Event::LaneDiscarded);
                failed.stop().await;
            }
        }
    }
    if let Some(mut worker) = worker {
        worker.stop_gracefully().await;
    }
}

#[derive(Clone, Copy, Debug)]
struct ConsumerCancelled {
    // True only after a validated terminal frame: no unread protocol bytes.
    reusable: bool,
}
impl std::fmt::Display for ConsumerCancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HTTP response consumer disconnected or stalled")
    }
}
impl std::error::Error for ConsumerCancelled {}

enum FirstReply {
    Buffered(RenderedResponse),
    Head {
        status: u16,
        headers: BTreeMap<String, HeaderValues>,
        isr: Option<IsrMetadata>,
        page_error: Option<u16>,
        page_failure: Option<PageFailure>,
    },
}

#[derive(Deserialize)]
struct WorkerFrame {
    id: u64,
    #[serde(rename = "type")]
    kind: FrameKind,
    length: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum FrameKind {
    Chunk,
    End,
    Error,
}

struct Worker {
    child: Option<lifecycle::OwnedChild>,
    // A lane owns a connection, not the lifetime of other in-flight requests.
    host: Option<Arc<socket::Host>>,
    input: Box<dyn AsyncWrite + Unpin + Send>,
    output: BufReader<Box<dyn AsyncRead + Unpin + Send>>,
    frame_buffer: Vec<u8>,
    lifecycle: Lifecycle,
}

impl Worker {
    async fn spawn(config: &WorkerConfig, lifecycle: Lifecycle) -> Result<Self> {
        let work = lifecycle.work()?;
        let mut command = Command::new(&config.node);
        parent::configure(&mut command);
        memory::configure(&mut command)?;
        compile_cache::configure(&mut command, &config.project).await;
        if let Some(cache) = &config.cache {
            command
                .env("PRNEXT_CACHE_URL", &cache.url)
                .env("PRNEXT_CACHE_TOKEN", &cache.token);
        } else {
            command
                .env_remove("PRNEXT_CACHE_URL")
                .env_remove("PRNEXT_CACHE_TOKEN");
        }
        let child = command
            .arg(node_path::for_node(&config.script))
            .arg(node_path::for_node(&config.project))
            .arg(node_path::for_node(&config.dist))
            .current_dir(&config.project)
            .env(
                "NODE_ENV",
                std::env::var("NODE_ENV").unwrap_or_else(|_| "production".to_owned()),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("cannot start Node worker {}", config.script.display()))?;
        let mut child = lifecycle::OwnedChild::new(child, work, lifecycle.clone());
        let input = child.stdin.take().context("worker stdin unavailable")?;
        let output: Box<dyn AsyncRead + Unpin + Send> =
            Box::new(child.stdout.take().context("worker stdout unavailable")?);
        Ok(Self {
            child: Some(child),
            host: None,
            input: Box::new(input),
            output: BufReader::new(output),
            frame_buffer: Vec::with_capacity(512),
            lifecycle,
        })
    }

    async fn request(
        &mut self,
        request: &WorkerRequest,
        budget: &ResponseBudget,
    ) -> Result<FirstReply> {
        #[derive(Serialize)]
        struct Wire<'a> {
            #[serde(flatten)]
            request: &'a WorkerRequest,
            #[serde(skip_serializing_if = "Option::is_none")]
            body: Option<String>,
            #[serde(rename = "bodyLength", skip_serializing_if = "Option::is_none")]
            body_length: Option<usize>,
            #[serde(rename = "compactResponse")]
            compact_response: bool,
        }
        let binary = self.host.as_ref().is_some_and(|host| host.binary);
        let mut wire = serde_json::to_vec(&Wire {
            request,
            body: (!binary).then(|| STANDARD.encode(&request.body.bytes)),
            body_length: binary.then_some(request.body.bytes.len()),
            compact_response: true,
        })?;
        wire.push(b'\n');
        self.input
            .write_all(&wire)
            .await
            .context("worker stopped while receiving request")?;
        if binary && !request.body.bytes.is_empty() {
            self.input.write_all(&request.body.bytes).await?;
        }
        self.input.flush().await?;
        drop(wire);
        let output = self.line(MAX_WIRE_BYTES).await?;
        let reply: ReplyEnvelope =
            serde_json::from_slice(output).context("invalid response from render worker")?;
        validate_head(reply.id, reply.status, request.id)?;
        if let Some(failure) = &reply.page_failure {
            failure.validate()?;
            if request.render_mode.as_deref() != Some("isr")
                || reply.status != 500
                || reply.isr.is_some()
                || reply.page_error.is_some()
            {
                bail!("private page failure outside ISR generation");
            }
        }
        if reply
            .page_error
            .is_some_and(|status| !matches!(status, 404 | 500) || status != reply.status)
        {
            bail!("invalid Pages error response marker");
        }
        if matches!(reply.kind, ReplyKind::Head) {
            if output.len() > MAX_FRAME_BYTES {
                bail!("render worker head exceeds 64 KiB");
            }
            return Ok(FirstReply::Head {
                status: reply.status,
                headers: reply.headers,
                isr: reply.isr,
                page_error: reply.page_error,
                page_failure: reply.page_failure,
            });
        }
        if matches!(reply.kind, ReplyKind::Complete) {
            if output.len() > MAX_FRAME_BYTES || reply.isr.is_some() || reply.body.is_some() {
                bail!("invalid compact worker response");
            }
            let length = reply.length.context("compact response length missing")?;
            if length > 16 * 1024 {
                bail!("compact worker response exceeds 16 KiB");
            }
            let reservation = budget.reserve(length).await;
            let mut bytes = vec![0; length];
            self.output
                .read_exact(&mut bytes)
                .await
                .context("incomplete compact worker response")?;
            return Ok(FirstReply::Buffered(RenderedResponse {
                status: reply.status,
                headers: reply.headers,
                isr: None,
                page_error: reply.page_error,
                page_failure: reply.page_failure,
                body: RenderedBody::Compact(CompactBody {
                    bytes: Some(Bytes::from(bytes)),
                    reservation: Some(reservation),
                    admission: None,
                }),
            }));
        }
        // Large legacy base64 responses must not leave a multi-megabyte scratch
        // allocation resident in an otherwise idle worker.
        if self.frame_buffer.capacity() > MAX_FRAME_BYTES {
            self.frame_buffer = Vec::with_capacity(512);
        }
        let body = STANDARD
            .decode(
                reply
                    .body
                    .context("buffered worker response is missing its body")?,
            )
            .context("invalid worker body encoding")?;
        if body.len() > MAX_RESPONSE_BYTES {
            bail!("render worker response exceeds 16 MiB");
        }
        Ok(FirstReply::Buffered(RenderedResponse {
            status: reply.status,
            headers: reply.headers,
            isr: reply.isr,
            page_error: reply.page_error,
            page_failure: reply.page_failure,
            body: RenderedBody::Buffered(body),
        }))
    }

    async fn line(&mut self, limit: usize) -> Result<&[u8]> {
        self.frame_buffer.clear();
        let count = (&mut self.output)
            .take((limit + 1) as u64)
            .read_until(b'\n', &mut self.frame_buffer)
            .await?;
        if count == 0 {
            bail!("render worker exited without completing its response");
        }
        if count > limit || self.frame_buffer.last() != Some(&b'\n') {
            bail!("render worker frame exceeds size limit or is incomplete");
        }
        Ok(&self.frame_buffer)
    }

    async fn stream(
        &mut self,
        request_id: u64,
        sender: mpsc::Sender<StreamItem>,
        state: &StdMutex<ResponseStreamState>,
        mut completed: oneshot::Receiver<()>,
        idle_timeout: Duration,
        budget: &ResponseBudget,
    ) -> Result<()> {
        loop {
            let mut waiting_for_consumer = false;
            let progress = tokio::select! {
                _ = sender.closed() => return Err(ConsumerCancelled { reusable: false }.into()),
                result = timeout(idle_timeout, async {
                    let frame: WorkerFrame = serde_json::from_slice(self.line(MAX_FRAME_BYTES).await?)
                        .context("invalid render worker stream frame")?;
                    if frame.id != request_id {
                        bail!("render worker stream id mismatch");
                    }
                    match frame.kind {
                        FrameKind::Chunk => {
                            let length = frame.length.context("render worker chunk is missing its length")?;
                            if length == 0 || length > MAX_CHUNK_BYTES {
                                bail!("invalid render worker stream chunk");
                            }
                            waiting_for_consumer = true;
                            let permit = budget.reserve(length).await;
                            waiting_for_consumer = false;
                            let mut bytes = vec![0; length];
                            self.output.read_exact(&mut bytes).await
                                .context("render worker stopped inside a stream chunk")?;
                            waiting_for_consumer = true;
                            sender.send(StreamItem::Chunk(Bytes::from(bytes), permit)).await
                                .map_err(|_| ConsumerCancelled { reusable: false })?;
                            Ok(false)
                        }
                        FrameKind::End => Ok(true),
                        FrameKind::Error => bail!("render worker stream failed"),
                    }
                }) => result,
            };
            let ended = match progress {
                Err(_) if waiting_for_consumer => {
                    return Err(ConsumerCancelled { reusable: false }.into())
                }
                result => result.context("render stream stalled")??,
            };
            if ended {
                break;
            }
        }
        // Framing is now synchronized. Retain admission until HTTP consumes or
        // discards the terminal marker, but never restart a healthy worker for
        // a slow/disconnected HTTP consumer after this point.
        timeout(idle_timeout, sender.send(StreamItem::End))
            .await
            .map_err(|_| ConsumerCancelled { reusable: true })?
            .map_err(|_| ConsumerCancelled { reusable: true })?;
        let mut deadline = state.lock().unwrap().consumed + idle_timeout;
        loop {
            tokio::select! {
                biased;
                result = &mut completed => return result.map_err(|_| ConsumerCancelled { reusable: true }.into()),
                _ = tokio::time::sleep_until(deadline) => {
                    // Consumption updates an already-held stream-state lock.
                    // Checking only at the deadline avoids a separate watch
                    // allocation and producer wakeup for every output chunk.
                    deadline = state.lock().unwrap().consumed + idle_timeout;
                    if deadline <= tokio::time::Instant::now() {
                        return Err(ConsumerCancelled { reusable: true }.into());
                    }
                }
            }
        }
    }

    async fn stop(&mut self) {
        let _ = self.input.shutdown().await;
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            let _ = child.reap(Duration::ZERO).await;
        }
        self.host.take();
    }

    async fn stop_gracefully(&mut self) {
        let _ = self.input.shutdown().await;
        if let Some(mut child) = self.child.take() {
            // The boxed stdin remains owned until this Worker is dropped. Close
            // it now so the stdio runtime sees EOF before waiting for after().
            self.input = Box::new(tokio::io::sink());
            child.stdin.take();
            let grace = self
                .lifecycle
                .deadline()
                .saturating_duration_since(tokio::time::Instant::now());
            let _ = child.reap(grace).await;
        }
        self.host.take();
    }
}

fn validate_head(id: u64, status: u16, request_id: u64) -> Result<()> {
    if id != request_id {
        bail!("render worker response id mismatch");
    }
    if !(200..=599).contains(&status) {
        bail!("invalid render worker status");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn compact_replies_validate_binary_lengths_and_keep_admission_until_consumed() {
        let (_directory, config) = fixture();
        std::fs::write(&config.script, r#"
            import {createInterface} from 'node:readline';
            for await (const line of createInterface({input:process.stdin})) {
              const r=JSON.parse(line),path=new URL(r.url).pathname;
              if(!r.compactResponse) throw Error('compact negotiation missing');
              const bytes=Buffer.from('healthy é🚀');
              const length=path==='/oversize'?16385:path==='/missing'?undefined:path==='/negative'?-1:bytes.length;
              process.stdout.write(JSON.stringify({id:r.id,type:'complete',status:200,headers:{'set-cookie':['a=1','b=2']},length})+'\n');
              if(path==='/truncated'){process.stdout.write(bytes.subarray(0,3));process.exit(0)}
              process.stdout.write(bytes);
            }
        "#).unwrap();
        let pool = WorkerPool::new(config, 1);
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        for _ in 0..3 {
            let response = pool
                .request(
                    request("/ok"),
                    Some(slots.clone().acquire_owned().await.unwrap()),
                )
                .await
                .unwrap();
            assert!(matches!(response.body, RenderedBody::Compact(_)));
            assert_eq!(response.headers["set-cookie"].values().len(), 2);
            assert_eq!(slots.available_permits(), 0);
            assert_eq!(collect(response.body).await.unwrap(), "healthy é🚀");
            assert_eq!(slots.available_permits(), 1);
        }
        let response = pool
            .request(
                request("/ok"),
                Some(slots.clone().acquire_owned().await.unwrap()),
            )
            .await
            .unwrap();
        drop(response);
        assert_eq!(slots.available_permits(), 1);
        for path in ["/oversize", "/missing", "/negative", "/truncated"] {
            assert!(pool.request(request(path), None).await.is_err(), "{path}");
            assert_eq!(
                collect(pool.request(request("/ok"), None).await.unwrap().body)
                    .await
                    .unwrap(),
                "healthy é🚀"
            );
        }
    }

    async fn collect(body: RenderedBody) -> Result<Bytes> {
        let body = match body {
            RenderedBody::Buffered(bytes) => axum::body::Body::from(bytes),
            RenderedBody::Stream(stream) => axum::body::Body::from_stream(stream),
            RenderedBody::Compact(body) => axum::body::Body::from_stream(body),
        };
        Ok(axum::body::to_bytes(body, 32 * 1024 * 1024).await?)
    }

    fn fixture() -> (tempfile::TempDir, WorkerConfig) {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("worker.mjs");
        std::fs::write(&script, r#"
            import { createInterface } from 'node:readline';
            const lines = createInterface({ input: process.stdin });
            for await (const line of lines) {
              const request = JSON.parse(line);
              if (request.url.endsWith('/crash')) process.exit(17);
              if (request.url.endsWith('/hang')) await new Promise(() => { setInterval(() => {}, 1000); });
              if (request.url.endsWith('/slow')) await new Promise(resolve => setTimeout(resolve, 100));
              const id = request.url.endsWith('/wrong-id') ? request.id + 1 : request.id;
              process.stdout.write(JSON.stringify({ id, status: 200, headers: {}, body: Buffer.from('healthy').toString('base64') }) + '\n');
            }
        "#).unwrap();
        let config = WorkerConfig {
            node: "node".into(),
            script,
            project: directory.path().to_path_buf(),
            dist: directory.path().to_path_buf(),
            cache: None,
        };
        (directory, config)
    }

    fn request(path: &str) -> WorkerRequest {
        WorkerRequest {
            max_duration: None,
            id: 0,
            route_id: "test".into(),
            method: "GET".into(),
            url: format!("http://localhost{path}"),
            headers: BTreeMap::new(),
            body: WorkerBody::default(),
            params: Params::new(),
            stream: true,
            original_url: None,
            routing_request_headers: None,
            routing_resolver: None,
            render_mode: None,
            revalidate_reason: None,
            page_failure: None,
            document_request: None,
            middleware_matched: false,
        }
    }

    fn streaming_fixture() -> (tempfile::TempDir, WorkerConfig) {
        let (directory, config) = fixture();
        std::fs::write(&config.script, r#"
            import { createInterface } from 'node:readline';
            import { existsSync } from 'node:fs';
            const write = bytes => new Promise((resolve, reject) => process.stdout.write(bytes, error => error ? reject(error) : resolve()));
            const frame = value => write(JSON.stringify(value) + '\n');
            const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
            for await (const line of createInterface({ input: process.stdin })) {
              const request = JSON.parse(line), id = request.id, path = new URL(request.url).pathname;
              if (!request.stream) throw Error('stream negotiation missing');
              if (path.startsWith('/invalid-first-')) {
                const type = path.endsWith('null') ? null : path.endsWith('kind') ? 'buffered' : undefined;
                const status = path.endsWith('status') ? 101 : 200;
                await frame({ id, type, status, ...(path.endsWith('body') ? {} : { body: '' }) });
                continue;
              }
              if (path === '/buffered') {
                await frame({ id, status: 200, headers: { 'x-worker': String(process.pid) }, body: Buffer.from('healthy').toString('base64') });
                continue;
              }
              await frame({ id, type: 'head', status: 200, headers: { 'x-worker': String(process.pid), ...(path === '/large-head' ? { huge: 'x'.repeat(65536) } : {}) } });
              const chunk = async bytes => { await frame({ id, type: 'chunk', length: bytes.length }); await write(bytes); };
              if (path === '/invalid-zero') await frame({ id, type: 'chunk', length: 0 });
              else if (path === '/invalid-large') await frame({ id, type: 'chunk', length: 65537 });
              else if (path === '/invalid-id') await frame({ id: id + 1, type: 'chunk', length: 1 });
              else if (path === '/invalid-head') await frame({ id, type: 'head', status: 200 });
              else if (path === '/invalid-error') await frame({ id, type: 'error', message: 'PRIVATE_APPLICATION_SECRET' });
              else if (path === '/invalid-partial') { await frame({ id, type: 'chunk', length: 10 }); await write('xx'); process.exit(17); }
              else if (path === '/large') { for (let i = 0; i < 272; i++) await chunk(Buffer.alloc(65536, i % 256)); }
              else if (path === '/slow') { for (let i = 0; i < 8; i++) { await chunk(Buffer.from(String(i))); await pause(120); } }
              else if (path === '/three') { for (const character of 'abc') await chunk(Buffer.from(character)); }
              else if (path === '/many') { for (let i = 0; i < 32; i++) await chunk(Buffer.alloc(65536, i)); }
              else {
                await chunk(Buffer.from([115, 104, 101, 108, 108, 10, 0, 255, 123, 125]));
                if (path === '/gate' || path === '/hang') {
                  while (!existsSync('release')) await pause(10);
                  await chunk(Buffer.from('tail'));
                }
              }
              await frame({ id, type: 'end' });
            }
        "#).unwrap();
        (directory, config)
    }

    fn worker_id(reply: &RenderedResponse) -> &str {
        let HeaderValues::Single(value) = reply.headers.get("x-worker").unwrap() else {
            panic!("missing worker identity");
        };
        value
    }

    #[tokio::test]
    async fn route_duration_overrides_header_deadline_and_bounds_active_streams() {
        let (_directory, config) = fixture();
        let mut pool = WorkerPool::new(config, 1);
        pool.timeout = Duration::from_millis(30);
        let mut input = request("/slow");
        input.max_duration = Some(Duration::from_secs(2));
        let response = pool.request(input, None).await.unwrap();
        assert_eq!(response.status, 200);

        let (_directory, config) = streaming_fixture();
        let pool = WorkerPool::new(config, 1);
        let mut input = request("/slow");
        input.max_duration = Some(Duration::from_millis(500));
        let started = std::time::Instant::now();
        let response = pool.request(input, None).await.unwrap();
        let RenderedBody::Stream(mut stream) = response.body else {
            panic!("expected stream")
        };
        let mut failed = false;
        while let Some(chunk) = next(&mut stream).await {
            if chunk.is_err() {
                failed = true;
                break;
            }
        }
        assert!(
            failed,
            "active chunks must not reset an explicit maxDuration"
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(
            pool.request(request("/buffered"), None)
                .await
                .unwrap()
                .status,
            200
        );
    }

    fn socket_fixture() -> (tempfile::TempDir, WorkerConfig) {
        let (directory, mut config) = fixture();
        config.script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/prnext/runtime/worker.mjs")
            .canonicalize()
            .unwrap();
        config.dist = directory.path().join("dist");
        std::fs::create_dir_all(config.dist.join("runtime")).unwrap();
        std::fs::write(
            config.dist.join("manifest.json"),
            r#"{"routes":[{"id":"test","kind":"api","router":"app","module":"unused"}]}"#,
        )
        .unwrap();
        std::fs::write(
            config.dist.join("runtime/http.mjs"),
            "export const errorResponse = () => ({status:500,body:'error'});",
        )
        .unwrap();
        std::fs::write(config.dist.join("runtime/api.mjs"), r#"
            import { writeFileSync, existsSync } from 'node:fs';
            import { setTimeout as delay } from 'node:timers/promises';
            process.on('exit', () => writeFileSync('exited-' + process.pid, 'done'));
            export async function runApi({url,signal}) {
              const path = new URL(url).pathname;
              const headers = {'x-worker':String(process.pid)};
              if (path === '/fail') throw new Error('application failure');
              if (path === '/before-head') {
                writeFileSync('entered', String(process.pid));
                await new Promise((resolve,reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true}));
              }
              if (path === '/background' || path === '/background-supervised') {
                const work = (async () => { while (!existsSync('release-work')) await delay(10); writeFileSync('finished-work', 'done'); })();
                signal[Symbol.for('prnext.request-work')](work, path === '/background-supervised' ? {supervised:true} : undefined);
              }
              if (path === '/hang') {
                let sent = false;
                const body = { [Symbol.asyncIterator]() { return this; }, async next() {
                  if (!sent) { sent = true; return {value:Buffer.from('prefix'),done:false}; }
                  if (signal.aborted) throw signal.reason;
                  return new Promise((resolve,reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true}));
                }, async return() { return {done:true}; } };
                return {status:200,headers,body,cancel() { writeFileSync('cancelled', String(process.pid)); }};
              }
              if (path === '/many') return {status:200,headers,body:(async function*(){for(let i=0;i<32;i++)yield Buffer.alloc(65536,i);})()};
              return {status:200,headers,body:Buffer.from('healthy')};
            }
        "#).unwrap();
        (directory, config)
    }

    async fn wait_for_file(path: &std::path::Path) {
        timeout(Duration::from_secs(3), async {
            while !path.exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn socket_cancellation_reuses_the_host_before_headers_and_midstream() {
        let (directory, config) = socket_fixture();
        let pool = Arc::new(WorkerPool::new(config, 1).concurrent(2));
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let warm = pool.request(request("/buffered"), None).await.unwrap();
        let initial_worker = worker_id(&warm).to_owned();
        collect(warm.body).await.unwrap();
        for _ in 0..3 {
            let pending = tokio::spawn({
                let pool = pool.clone();
                let permit = slots.clone().acquire_owned().await.unwrap();
                async move { pool.request(request("/before-head"), Some(permit)).await }
            });
            wait_for_file(&directory.path().join("entered")).await;
            assert_eq!(
                std::fs::read_to_string(directory.path().join("entered")).unwrap(),
                initial_worker
            );
            pending.abort();
            let _ = pending.await;
            let permit = timeout(Duration::from_secs(3), slots.clone().acquire_owned())
                .await
                .unwrap()
                .unwrap();
            let reply = pool.request(request("/hang"), Some(permit)).await.unwrap();
            assert_eq!(worker_id(&reply), initial_worker);
            let RenderedBody::Stream(mut stream) = reply.body else {
                panic!("expected stream")
            };
            assert_eq!(next(&mut stream).await.unwrap().unwrap(), "prefix");
            drop(stream);
            let permit = timeout(Duration::from_secs(3), slots.clone().acquire_owned())
                .await
                .unwrap()
                .unwrap();
            wait_for_file(&directory.path().join("cancelled")).await;
            let healthy = pool
                .request(request("/buffered"), Some(permit))
                .await
                .unwrap();
            assert_eq!(
                worker_id(&healthy),
                initial_worker,
                "normal disconnects must not restart a healthy shared host"
            );
            assert_eq!(collect(healthy.body).await.unwrap(), "healthy");
            std::fs::remove_file(directory.path().join("entered")).unwrap();
            std::fs::remove_file(directory.path().join("cancelled")).unwrap();
        }
    }

    #[tokio::test]
    async fn cancellation_during_reconnect_keeps_the_retained_host() {
        let (directory, config) = fixture();
        std::fs::write(&config.script, r#"
            import net from 'node:net';
            import {createInterface} from 'node:readline';
            import {writeFileSync} from 'node:fs';
            let connections=0;
            const server=net.createServer(socket=>{
              const number=++connections;
              socket.on('error',()=>{});
              void(async()=>{
                let authenticated=false;
                for await(const line of createInterface({input:socket})){
                  if(!authenticated){authenticated=true;
                    if(number===2){writeFileSync('connecting',String(process.pid));continue;}
                    socket.write('ready\n');continue;
                  }
                  const r=JSON.parse(line),headers={'x-worker':String(process.pid)};
                  socket.write(JSON.stringify(r.url.endsWith('/hang')?{id:r.id,type:'head',status:200,headers}:{id:r.id,status:200,headers,body:Buffer.from('healthy').toString('base64')})+'\n');
                }
              })().catch(()=>{});
            });
            process.stdin.resume();process.stdin.once('end',()=>process.exit(0));
            server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({port:server.address().port})+'\n'));
        "#).unwrap();
        let pool = Arc::new(WorkerPool::new(config, 1).concurrent(2));
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let first = pool
            .request(
                request("/hang"),
                Some(slots.clone().acquire_owned().await.unwrap()),
            )
            .await
            .unwrap();
        let initial_worker = worker_id(&first).to_owned();
        drop(first);
        let pending = tokio::spawn({
            let pool = pool.clone();
            let permit = timeout(Duration::from_secs(3), slots.clone().acquire_owned())
                .await
                .unwrap()
                .unwrap();
            async move { pool.request(request("/buffered"), Some(permit)).await }
        });
        wait_for_file(&directory.path().join("connecting")).await;
        pending.abort();
        let _ = pending.await;
        let permit = timeout(Duration::from_secs(3), slots.clone().acquire_owned())
            .await
            .unwrap()
            .unwrap();
        let healthy = pool
            .request(request("/buffered"), Some(permit))
            .await
            .unwrap();
        assert_eq!(worker_id(&healthy), initial_worker);
        assert_eq!(collect(healthy.body).await.unwrap(), "healthy");
    }

    #[tokio::test]
    async fn retiring_the_last_socket_drains_tracked_background_work() {
        let (directory, config) = socket_fixture();
        let pool = WorkerPool::new(config, 1)
            .concurrent(2)
            .retire_after(Duration::from_millis(40));
        let reply = pool.request(request("/background"), None).await.unwrap();
        let initial_worker = worker_id(&reply).to_owned();
        assert_eq!(collect(reply.body).await.unwrap(), "healthy");
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(!directory.path().join("finished-work").exists());
        std::fs::write(directory.path().join("release-work"), "go").unwrap();
        wait_for_file(&directory.path().join("finished-work")).await;
        wait_for_file(&directory.path().join(format!("exited-{initial_worker}"))).await;
        let reply = pool.request(request("/buffered"), None).await.unwrap();
        assert_ne!(worker_id(&reply), initial_worker);
        assert_eq!(collect(reply.body).await.unwrap(), "healthy");
    }

    #[tokio::test]
    async fn supervised_background_work_retains_and_reuses_an_idle_host() {
        let (directory, mut config) = socket_fixture();
        let runtime_script = serde_json::to_string(config.script.to_str().unwrap()).unwrap();
        config.script = directory.path().join("supervised-worker.mjs");
        std::fs::write(
            &config.script,
            format!(
                r#"
            // prnext-transport:socket-v2
            // prnext-concurrency:512
            import {{ pathToFileURL }} from 'node:url';
            const originalTimeout = globalThis.setTimeout;
            globalThis.setTimeout = (callback, milliseconds, ...args) =>
              originalTimeout(callback, milliseconds === 30000 ? 50 : milliseconds, ...args);
            await import(pathToFileURL({runtime_script}).href);
        "#
            ),
        )
        .unwrap();
        let pool = WorkerPool::new(config, 1)
            .concurrent(2)
            .retire_after(Duration::from_millis(40));
        let reply = pool
            .request(request("/background-supervised"), None)
            .await
            .unwrap();
        let initial_worker = worker_id(&reply).to_owned();
        assert_eq!(collect(reply.body).await.unwrap(), "healthy");
        // Exceed both lane retirement and the accelerated legacy background
        // deadline. Supervised RSC work has a responsiveness policy instead.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!directory
            .path()
            .join(format!("exited-{initial_worker}"))
            .exists());
        assert!(!directory.path().join("finished-work").exists());
        let healthy = pool.request(request("/buffered"), None).await.unwrap();
        assert_eq!(worker_id(&healthy), initial_worker);
        assert_eq!(collect(healthy.body).await.unwrap(), "healthy");
        std::fs::write(directory.path().join("release-work"), "go").unwrap();
        wait_for_file(&directory.path().join("finished-work")).await;
        wait_for_file(&directory.path().join(format!("exited-{initial_worker}"))).await;
    }

    #[tokio::test]
    async fn disposing_the_pool_starts_graceful_shutdown_even_while_background_work_is_busy() {
        let (directory, mut config) = socket_fixture();
        let runtime_script = serde_json::to_string(config.script.to_str().unwrap()).unwrap();
        config.script = directory.path().join("owned-worker.mjs");
        std::fs::write(
            &config.script,
            format!(
                r#"
            // prnext-transport:socket-v2
            // prnext-concurrency:512
            import {{ pathToFileURL }} from 'node:url';
            import {{ writeFileSync }} from 'node:fs';
            await import(pathToFileURL({runtime_script}).href);
            process.stdin.once('end', () => writeFileSync('owner-closed', 'yes'));
        "#
            ),
        )
        .unwrap();
        let pool = WorkerPool::new(config, 1)
            .concurrent(2)
            .retire_after(Duration::from_millis(40));
        let reply = pool
            .request(request("/background-supervised"), None)
            .await
            .unwrap();
        let initial_worker = worker_id(&reply).to_owned();
        collect(reply.body).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!directory.path().join("owner-closed").exists());
        drop(pool);
        wait_for_file(&directory.path().join("owner-closed")).await;
        assert!(!directory.path().join("finished-work").exists());
        // Explicit disposal begins the bounded graceful drain even when a
        // cache producer has no natural completion. This test releases it;
        // graceful_shutdown_reaps_a_worker_even_when_v8_cannot_process_eof
        // separately exercises forced termination with an 80 ms grace.
        std::fs::write(directory.path().join("release-work"), "go").unwrap();
        wait_for_file(&directory.path().join("finished-work")).await;
        wait_for_file(&directory.path().join(format!("exited-{initial_worker}"))).await;
    }

    #[tokio::test]
    async fn stdio_idle_retirement_drains_post_response_work_before_releasing_child() {
        let (directory, config) = socket_fixture();
        std::fs::write(
            config.dist.join("runtime/api.mjs"),
            r#"
            import {writeFileSync,existsSync} from 'node:fs';
            import {setTimeout as delay} from 'node:timers/promises';
            process.on('exit',()=>writeFileSync('exited-work','yes'));
            export async function runApi() {
              return {status:200,headers:{},body:Buffer.from('healthy'),finalizeCache:async()=>{
                writeFileSync('started-work','yes');
                while(!existsSync('release-work')) await delay(5);
                writeFileSync('finished-work','yes');
              }};
            }
        "#,
        )
        .unwrap();
        let pool = WorkerPool::new(config, 1).retire_after(Duration::from_millis(40));
        let lifecycle = pool.lifecycle.clone();
        collect(pool.request(request("/buffered"), None).await.unwrap().body)
            .await
            .unwrap();
        wait_for_file(&directory.path().join("started-work")).await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(!directory.path().join("exited-work").exists());
        std::fs::write(directory.path().join("release-work"), "go").unwrap();
        wait_for_file(&directory.path().join("exited-work")).await;
        assert!(directory.path().join("finished-work").exists());
        lifecycle.begin_drain();
        assert!(lifecycle.drain_work().await);
        drop(pool);
        assert!(lifecycle.join().await);
    }

    #[tokio::test]
    async fn service_drain_awaits_post_response_work_and_normal_exit_in_stdio_and_socket_modes() {
        for concurrency in [1, 2] {
            let (directory, config) = socket_fixture();
            std::fs::write(config.dist.join("runtime/api.mjs"), r#"
                import {writeFileSync,existsSync} from 'node:fs';
                import {setTimeout as delay} from 'node:timers/promises';
                process.on('exit',()=>writeFileSync('exited-'+process.pid,'normal'));
                export async function runApi() {
                  return {status:200,headers:{'x-worker':String(process.pid)},body:Buffer.from('healthy'),
                    finalizeCache:async()=>{
                      writeFileSync('started-work','yes');
                      while(!existsSync('release-work')) await delay(5);
                      writeFileSync('finished-work','yes');
                    }};
                }
            "#).unwrap();
            let pool = WorkerPool::new(config, 1).concurrent(concurrency);
            let lifecycle = pool.lifecycle.clone();
            let response = pool.request(request("/buffered"), None).await.unwrap();
            let pid = worker_id(&response).to_owned();
            assert_eq!(collect(response.body).await.unwrap(), "healthy");
            wait_for_file(&directory.path().join("started-work")).await;
            lifecycle.begin_drain();
            assert!(timeout(Duration::from_millis(40), lifecycle.drain_work())
                .await
                .is_err());
            assert!(!directory.path().join("finished-work").exists());
            std::fs::write(directory.path().join("release-work"), "go").unwrap();
            assert!(timeout(Duration::from_secs(3), lifecycle.drain_work())
                .await
                .unwrap());
            assert!(directory.path().join("finished-work").exists());
            assert!(directory.path().join(format!("exited-{pid}")).exists());
            // Holding service state must not prevent draining; only now may it go.
            drop(pool);
            assert!(lifecycle.join().await);
        }
    }

    #[tokio::test]
    async fn tracked_private_work_can_start_a_fresh_host_during_service_grace() {
        let (_directory, config) = socket_fixture();
        let pool = WorkerPool::new(config, 1).concurrent(2);
        let lifecycle = pool.lifecycle.clone();
        let (release, released) = oneshot::channel();
        let (done, finished) = oneshot::channel();
        let private_pool = pool.clone();
        pool.background(async move {
            released.await.unwrap();
            let reply = private_pool
                .request(request("/buffered"), None)
                .await
                .unwrap();
            assert_eq!(collect(reply.body).await.unwrap(), "healthy");
            done.send(()).unwrap();
        })
        .unwrap();
        lifecycle.begin_drain();
        release.send(()).unwrap();
        timeout(Duration::from_secs(3), finished)
            .await
            .unwrap()
            .unwrap();
        assert!(timeout(Duration::from_secs(3), lifecycle.drain_work())
            .await
            .unwrap());
        drop(pool);
        assert!(lifecycle.join().await);
    }

    #[tokio::test]
    async fn service_drain_forces_a_blocked_stdio_worker_and_reaps_it_within_the_bound() {
        let (directory, config) = socket_fixture();
        std::fs::write(
            config.dist.join("runtime/api.mjs"),
            r#"
            import {writeFileSync} from 'node:fs';
            export async function runApi() {
              return {status:200,headers:{},body:Buffer.from('healthy'),
                finalizeCache:async()=>{writeFileSync('started-work','yes');while(true){}}};
            }
        "#,
        )
        .unwrap();
        let pool = WorkerPool::new(config, 1);
        let lifecycle = pool.lifecycle.clone();
        let response = pool.request(request("/buffered"), None).await.unwrap();
        collect(response.body).await.unwrap();
        wait_for_file(&directory.path().join("started-work")).await;
        let started = tokio::time::Instant::now();
        lifecycle.begin_drain_for(Duration::from_millis(80));
        let _ = lifecycle.drain_work().await;
        drop(pool);
        assert!(lifecycle.join().await);
        assert!(started.elapsed() >= Duration::from_millis(80));
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test]
    async fn warm_service_without_background_work_does_not_wait_for_the_grace_deadline() {
        let (_directory, config) = socket_fixture();
        let pool = WorkerPool::new(config, 1).concurrent(2);
        let lifecycle = pool.lifecycle.clone();
        collect(pool.request(request("/buffered"), None).await.unwrap().body)
            .await
            .unwrap();
        lifecycle.begin_drain();
        timeout(Duration::from_secs(3), async {
            assert!(lifecycle.drain_work().await);
            drop(pool);
            assert!(lifecycle.join().await);
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn cancelled_socket_hosts_follow_idle_retirement_without_interrupting_active_streams() {
        let (directory, config) = socket_fixture();
        let pool = WorkerPool::new(config, 1)
            .concurrent(2)
            .retire_after(Duration::from_millis(40));
        let reply = pool.request(request("/hang"), None).await.unwrap();
        let initial_worker = worker_id(&reply).to_owned();
        let RenderedBody::Stream(mut stream) = reply.body else {
            panic!("expected stream")
        };
        assert_eq!(next(&mut stream).await.unwrap().unwrap(), "prefix");
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(!directory
            .path()
            .join(format!("exited-{initial_worker}"))
            .exists());
        drop(stream);
        wait_for_file(&directory.path().join(format!("exited-{initial_worker}"))).await;
        let healthy = pool.request(request("/buffered"), None).await.unwrap();
        assert_ne!(worker_id(&healthy), initial_worker);
        assert_eq!(collect(healthy.body).await.unwrap(), "healthy");
    }

    #[tokio::test]
    async fn socket_application_errors_still_return_their_http_response() {
        let (_directory, config) = socket_fixture();
        let pool = WorkerPool::new(config, 1).concurrent(2);
        let warm = pool.request(request("/buffered"), None).await.unwrap();
        let initial_worker = worker_id(&warm).to_owned();
        collect(warm.body).await.unwrap();
        let failed = pool.request(request("/fail"), None).await.unwrap();
        assert_eq!(failed.status, 500);
        assert_eq!(collect(failed.body).await.unwrap(), "error");
        let healthy = pool.request(request("/buffered"), None).await.unwrap();
        assert_eq!(worker_id(&healthy), initial_worker);
        assert_eq!(collect(healthy.body).await.unwrap(), "healthy");
    }

    #[tokio::test]
    async fn a_stalled_socket_consumer_releases_queues_without_restarting_the_host() {
        let (_directory, config) = socket_fixture();
        let mut pool = WorkerPool::new(config, 1).concurrent(2);
        // Includes Node's cold start when the parallel suite shares one core.
        // Keep the deadline finite and verify release after it expires.
        pool.timeout = Duration::from_secs(2);
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let reply = pool
            .request(
                request("/many"),
                Some(slots.clone().acquire_owned().await.unwrap()),
            )
            .await
            .unwrap();
        let initial_worker = worker_id(&reply).to_owned();
        let permit = timeout(Duration::from_secs(6), slots.clone().acquire_owned())
            .await
            .unwrap()
            .unwrap();
        let RenderedBody::Stream(stream) = &reply.body else {
            panic!("expected stream")
        };
        assert!(stream.state.lock().unwrap().receiver.is_none());
        let healthy = pool
            .request(request("/buffered"), Some(permit))
            .await
            .unwrap();
        assert_eq!(worker_id(&healthy), initial_worker);
        assert_eq!(collect(healthy.body).await.unwrap(), "healthy");
    }

    #[tokio::test]
    async fn extra_lane_traffic_resets_the_host_idle_deadline() {
        let (directory, mut config) = socket_fixture();
        let script = serde_json::to_string(config.script.to_str().unwrap()).unwrap();
        config.script = directory.path().join("frequent-activity.mjs");
        std::fs::write(
            &config.script,
            format!(
                r#"
            import {{pathToFileURL}} from 'node:url';
            const interval=globalThis.setInterval;
            globalThis.setInterval=(fn,ms,...args)=>interval(fn,ms===1000?10:ms,...args);
            await import(pathToFileURL({script}).href);
        "#
            ),
        )
        .unwrap();
        let pool = WorkerPool::new(config, 1).concurrent(2).retirement(
            Some(Duration::from_millis(240)),
            Some(Duration::from_millis(80)),
        );
        let first = pool.request(request("/hang"), None).await.unwrap();
        let second = pool.request(request("/hang"), None).await.unwrap();
        let pid = worker_id(&first).to_owned();
        drop(first);
        tokio::time::sleep(Duration::from_millis(30)).await;
        drop(second);
        tokio::time::sleep(Duration::from_millis(30)).await;
        // Last available lane is the extra lane. It receives all this traffic
        // while the primary lane has no requests of its own.
        for _ in 0..8 {
            let reply = pool.request(request("/buffered"), None).await.unwrap();
            assert_eq!(worker_id(&reply), pid);
            collect(reply.body).await.unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        tokio::time::sleep(Duration::from_millis(70)).await;
        assert!(
            !directory.path().join(format!("exited-{pid}")).exists(),
            "host must remain warm for the configured interval after ANY lane completes"
        );
        let reply = pool.request(request("/buffered"), None).await.unwrap();
        assert_eq!(worker_id(&reply), pid);
        collect(reply.body).await.unwrap();
    }

    #[tokio::test]
    async fn simultaneous_wakeups_share_one_host_on_every_cycle() {
        let (directory, config) = socket_fixture();
        let pool = WorkerPool::new(config, 1)
            .concurrent(16)
            .retire_after(Duration::from_millis(80));
        let mut previous = String::new();
        for _ in 0..3 {
            let replies = futures_util::future::join_all((0..16).map(|_| async {
                let reply = pool.request(request("/buffered"), None).await.unwrap();
                let pid = worker_id(&reply).to_owned();
                assert_eq!(collect(reply.body).await.unwrap(), "healthy");
                pid
            }))
            .await;
            assert!(replies.iter().all(|pid| pid == &replies[0]));
            assert_ne!(replies[0], previous);
            previous = replies[0].clone();
            wait_for_file(&directory.path().join(format!("exited-{previous}"))).await;
        }
    }

    #[tokio::test]
    async fn global_response_budget_bounds_queues_and_allows_aggregating_consumers() {
        let (_directory, config) = streaming_fixture();
        let mut pool = WorkerPool::new(config, 2);
        pool.response_budget = ResponseBudget::new(MAX_CHUNK_BYTES);
        let first = pool.request(request("/many"), None).await.unwrap();
        let RenderedBody::Stream(mut first) = first.body else {
            panic!("expected stream")
        };
        let held = next(&mut first).await.unwrap().unwrap();
        assert_eq!(held.len(), MAX_CHUNK_BYTES);
        // The first consumer pauses with another chunk queued in Rust.
        timeout(Duration::from_secs(2), async {
            loop {
                if first
                    .state
                    .lock()
                    .unwrap()
                    .receiver
                    .as_ref()
                    .is_some_and(|r| !r.is_empty())
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let second = pool.request(request("/many"), None).await.unwrap();
        let RenderedBody::Stream(mut second) = second.body else {
            panic!("expected stream")
        };
        assert!(timeout(Duration::from_millis(30), next(&mut second))
            .await
            .is_err());
        drop(first);
        // The downstream body collector owns its own limit. Retained HTTP
        // chunks must not prevent it consuming a response larger than this queue.
        let bytes = timeout(
            Duration::from_secs(5),
            collect(RenderedBody::Stream(second)),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(bytes.len(), MAX_CHUNK_BYTES * 32);
        for (index, chunk) in bytes.chunks(MAX_CHUNK_BYTES).enumerate() {
            assert!(chunk.iter().all(|byte| *byte == index as u8));
        }
        assert_eq!(held.len(), MAX_CHUNK_BYTES);
    }

    #[tokio::test]
    async fn maintenance_workers_retire_only_between_jobs_and_restart_lazily() {
        let (_directory, config) = streaming_fixture();
        let pool = WorkerPool::new(config, 1).retire_after(Duration::from_millis(50));
        let first = pool.request(request("/buffered"), None).await.unwrap();
        let first_id = worker_id(&first).to_owned();
        drop(first);
        tokio::time::sleep(Duration::from_millis(140)).await;
        let streaming = pool.request(request("/slow"), None).await.unwrap();
        let second_id = worker_id(&streaming).to_owned();
        assert_ne!(first_id, second_id);
        assert_eq!(collect(streaming.body).await.unwrap().as_ref(), b"01234567");
        let after = pool.request(request("/buffered"), None).await.unwrap();
        assert_eq!(worker_id(&after), second_id);
    }

    async fn next(
        stream: &mut ResponseStream,
    ) -> Option<std::result::Result<Bytes, std::io::Error>> {
        std::future::poll_fn(|cx| Pin::new(&mut *stream).poll_next(cx)).await
    }

    #[tokio::test]
    async fn stream_headers_release_start_capacity_but_keep_live_admission() {
        let (_directory, config) = streaming_fixture();
        let pool = WorkerPool::new(config, 1);
        let live = Arc::new(tokio::sync::Semaphore::new(1));
        let starting = Arc::new(tokio::sync::Semaphore::new(1));
        let reply = pool
            .request_with_start(
                request("/gate"),
                Some(live.clone().acquire_owned().await.unwrap()),
                Some(starting.clone().acquire_owned().await.unwrap()),
            )
            .await
            .unwrap();
        assert_eq!(starting.available_permits(), 1);
        assert_eq!(live.available_permits(), 0);
        drop(reply);
        let permit = timeout(Duration::from_secs(2), live.clone().acquire_owned())
            .await
            .unwrap()
            .unwrap();
        drop(permit);
        assert_eq!(live.available_permits(), 1);
    }

    #[tokio::test]
    async fn raw_stream_delivers_before_completion_and_reuses_worker() {
        let (directory, config) = streaming_fixture();
        let pool = WorkerPool::new(config, 1);
        let reply = pool.request(request("/gate"), None).await.unwrap();
        let initial_worker = worker_id(&reply).to_owned();
        let RenderedBody::Stream(mut stream) = reply.body else {
            panic!("streaming reply was buffered");
        };
        assert_eq!(
            next(&mut stream).await.unwrap().unwrap().as_ref(),
            &[115, 104, 101, 108, 108, 10, 0, 255, 123, 125]
        );
        assert!(timeout(Duration::from_millis(40), next(&mut stream))
            .await
            .is_err());
        std::fs::write(directory.path().join("release"), "go").unwrap();
        assert_eq!(next(&mut stream).await.unwrap().unwrap(), "tail");
        assert!(next(&mut stream).await.is_none());
        let reply = pool.request(request("/buffered"), None).await.unwrap();
        assert_eq!(worker_id(&reply), initial_worker);
        assert_eq!(collect(reply.body).await.unwrap(), "healthy");
    }

    #[tokio::test]
    async fn streaming_responses_can_exceed_the_buffered_limit() {
        let (_directory, config) = streaming_fixture();
        let pool = WorkerPool::new(config, 1);
        let body = collect(pool.request(request("/large"), None).await.unwrap().body)
            .await
            .unwrap();
        assert_eq!(body.len(), 272 * MAX_CHUNK_BYTES);
        assert!(body.len() > MAX_RESPONSE_BYTES);
        for (index, chunk) in body.as_chunks::<MAX_CHUNK_BYTES>().0.iter().enumerate() {
            assert!(chunk.iter().all(|byte| *byte == (index % 256) as u8));
        }
    }

    #[tokio::test]
    async fn dropping_a_stream_releases_admission_and_restarts_without_replay() {
        let (_directory, config) = streaming_fixture();
        let pool = WorkerPool::new(config, 1);
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let reply = pool
            .request(
                request("/hang"),
                Some(slots.clone().acquire_owned().await.unwrap()),
            )
            .await
            .unwrap();
        let initial_worker = worker_id(&reply).to_owned();
        assert_eq!(slots.available_permits(), 0);
        drop(reply);
        let permit = timeout(Duration::from_secs(2), slots.clone().acquire_owned())
            .await
            .unwrap()
            .unwrap();
        let reply = pool
            .request(request("/buffered"), Some(permit))
            .await
            .unwrap();
        assert_ne!(worker_id(&reply), initial_worker);
        assert_eq!(collect(reply.body).await.unwrap(), "healthy");
    }

    #[tokio::test]
    async fn disconnecting_after_the_end_frame_releases_buffers_without_restarting() {
        let (_directory, config) = streaming_fixture();
        let pool = WorkerPool::new(config, 1);
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let reply = pool
            .request(
                request("/short"),
                Some(slots.clone().acquire_owned().await.unwrap()),
            )
            .await
            .unwrap();
        let initial_worker = worker_id(&reply).to_owned();
        let RenderedBody::Stream(stream) = &reply.body else {
            panic!("expected stream")
        };
        timeout(Duration::from_secs(2), async {
            while stream
                .state
                .lock()
                .unwrap()
                .receiver
                .as_ref()
                .unwrap()
                .len()
                != 2
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        drop(reply);
        let permit = timeout(Duration::from_secs(2), slots.clone().acquire_owned())
            .await
            .unwrap()
            .unwrap();
        let reply = pool
            .request(request("/buffered"), Some(permit))
            .await
            .unwrap();
        assert_eq!(
            worker_id(&reply),
            initial_worker,
            "a validated end frame makes the worker reusable even if HTTP disconnects"
        );
        assert_eq!(collect(reply.body).await.unwrap(), "healthy");
    }

    #[tokio::test]
    async fn cancelled_queue_envelopes_do_not_reject_new_admitted_requests() {
        let (directory, config) = streaming_fixture();
        let pool = Arc::new(WorkerPool::new(config, 1));
        let slots = Arc::new(tokio::sync::Semaphore::new(2));
        let reply = pool
            .request(
                request("/gate"),
                Some(slots.clone().acquire_owned().await.unwrap()),
            )
            .await
            .unwrap();
        let initial_worker = worker_id(&reply).to_owned();
        for remaining in (0..4).rev() {
            let permit = slots.clone().acquire_owned().await.unwrap();
            let pending = tokio::spawn({
                let pool = pool.clone();
                async move { pool.request(request("/buffered"), Some(permit)).await }
            });
            timeout(Duration::from_secs(2), async {
                while pool.sender.get().unwrap().capacity() != remaining {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            pending.abort();
            let _ = pending.await;
        }
        let permit = slots.clone().acquire_owned().await.unwrap();
        let (started, entered) = oneshot::channel();
        let pending = tokio::spawn({
            let pool = pool.clone();
            async move {
                let _ = started.send(());
                pool.request(request("/buffered"), Some(permit)).await
            }
        });
        entered.await.unwrap();
        tokio::task::yield_now().await;
        assert!(
            !pending.is_finished(),
            "Admitted work must wait for cancelled envelopes to drain"
        );
        std::fs::write(directory.path().join("release"), "go").unwrap();
        assert!(collect(reply.body).await.unwrap().ends_with(b"tail"));
        let recovered = timeout(Duration::from_secs(2), pending)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(worker_id(&recovered), initial_worker);
        assert_eq!(collect(recovered.body).await.unwrap(), "healthy");
    }

    #[tokio::test]
    async fn cancelling_a_queued_request_releases_admission_while_stream_is_active() {
        let (directory, config) = streaming_fixture();
        let pool = Arc::new(WorkerPool::new(config, 1));
        let slots = Arc::new(tokio::sync::Semaphore::new(2));
        let reply = pool
            .request(
                request("/gate"),
                Some(slots.clone().acquire_owned().await.unwrap()),
            )
            .await
            .unwrap();
        let initial_worker = worker_id(&reply).to_owned();
        let queued_permit = slots.clone().acquire_owned().await.unwrap();
        let pending_pool = pool.clone();
        let (started, entered) = oneshot::channel();
        let pending = tokio::spawn(async move {
            let mut request = request("/buffered");
            request.body = vec![b'x'; MAX_BODY_BYTES].into();
            let _ = started.send(());
            pending_pool.request(request, Some(queued_permit)).await
        });
        entered.await.unwrap();
        tokio::task::yield_now().await;
        assert_eq!(slots.available_permits(), 0);
        pending.abort();
        assert!(matches!(pending.await, Err(error) if error.is_cancelled()));
        let released = timeout(Duration::from_millis(200), slots.clone().acquire_owned())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            slots.available_permits(),
            0,
            "the active stream still owns its admission"
        );
        drop(released);
        std::fs::write(directory.path().join("release"), "go").unwrap();
        assert!(collect(reply.body).await.unwrap().ends_with(b"tail"));
        let recovered = pool.request(request("/buffered"), None).await.unwrap();
        assert_eq!(
            worker_id(&recovered),
            initial_worker,
            "a cancelled queued request must not restart the active stream worker"
        );
    }

    #[tokio::test]
    async fn streaming_deadline_resets_after_progress() {
        let (_directory, config) = streaming_fixture();
        let mut pool = WorkerPool::new(config, 1);
        pool.timeout = Duration::from_millis(500);
        let started = tokio::time::Instant::now();
        let reply = pool.request(request("/slow"), None).await.unwrap();
        let initial_worker = worker_id(&reply).to_owned();
        assert_eq!(collect(reply.body).await.unwrap(), "01234567");
        assert!(started.elapsed() > pool.timeout);
        let reply = pool.request(request("/buffered"), None).await.unwrap();
        assert_eq!(worker_id(&reply), initial_worker);
    }

    #[tokio::test]
    async fn final_consumer_deadline_follows_progress_without_producer_wakeups() {
        let (_directory, config) = streaming_fixture();
        let mut pool = WorkerPool::new(config, 1);
        pool.timeout = Duration::from_millis(500);
        let reply = pool.request(request("/three"), None).await.unwrap();
        let initial_worker = worker_id(&reply).to_owned();
        let RenderedBody::Stream(mut stream) = reply.body else {
            panic!("expected stream")
        };
        for character in ['a', 'b', 'c'] {
            assert_eq!(
                next(&mut stream).await.unwrap().unwrap(),
                character.to_string()
            );
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        assert!(next(&mut stream).await.is_none());
        let reply = pool.request(request("/buffered"), None).await.unwrap();
        assert_eq!(worker_id(&reply), initial_worker);
    }

    #[tokio::test]
    async fn stalled_producers_and_consumers_release_capacity() {
        for path in ["/hang", "/many", "/short"] {
            let (_directory, config) = streaming_fixture();
            let mut pool = WorkerPool::new(config, 1);
            pool.timeout = Duration::from_millis(500);
            let slots = Arc::new(tokio::sync::Semaphore::new(1));
            let reply = pool
                .request(
                    request(path),
                    Some(slots.clone().acquire_owned().await.unwrap()),
                )
                .await
                .unwrap();
            let initial_worker = worker_id(&reply).to_owned();
            assert_eq!(slots.available_permits(), 0);
            // Keep the receiver alive and unread: the final-marker watchdog is
            // necessary even when every body chunk already fits in the queue.
            let permit = timeout(Duration::from_secs(2), slots.clone().acquire_owned())
                .await
                .unwrap()
                .unwrap();
            let RenderedBody::Stream(stream) = &reply.body else {
                panic!("expected stream")
            };
            assert!(
                stream.state.lock().unwrap().receiver.is_none(),
                "timed out body must release every queued chunk even before the client polls again"
            );
            if path == "/hang" {
                assert!(collect(reply.body).await.is_err());
            } else {
                drop(reply);
            }
            let recovered = pool
                .request(request("/buffered"), Some(permit))
                .await
                .unwrap();
            if path == "/short" {
                assert_eq!(
                    worker_id(&recovered),
                    initial_worker,
                    "completed framing survives a stalled consumer"
                );
            } else {
                assert_ne!(worker_id(&recovered), initial_worker);
            }
        }
    }

    #[tokio::test]
    async fn malformed_streams_fail_and_are_never_reused() {
        let (_directory, config) = streaming_fixture();
        let pool = WorkerPool::new(config, 1);
        assert!(pool.request(request("/large-head"), None).await.is_err());
        for path in [
            "/invalid-first-null",
            "/invalid-first-kind",
            "/invalid-first-body",
            "/invalid-first-status",
        ] {
            assert!(pool.request(request(path), None).await.is_err(), "{path}");
            let recovered = pool.request(request("/buffered"), None).await.unwrap();
            assert_eq!(collect(recovered.body).await.unwrap(), "healthy");
        }
        for path in [
            "/invalid-zero",
            "/invalid-large",
            "/invalid-id",
            "/invalid-head",
            "/invalid-error",
            "/invalid-partial",
        ] {
            let reply = pool.request(request(path), None).await.unwrap();
            let initial_worker = worker_id(&reply).to_owned();
            let error = collect(reply.body).await.unwrap_err();
            assert!(!error.to_string().contains("PRIVATE_APPLICATION_SECRET"));
            let recovered = pool.request(request("/buffered"), None).await.unwrap();
            assert_ne!(worker_id(&recovered), initial_worker);
        }
    }

    #[tokio::test]
    async fn worker_recovers_after_crash_and_protocol_error() {
        let (_directory, config) = fixture();
        let pool = WorkerPool::new(config, 1);
        assert!(matches!(
            pool.request(request("/crash"), None).await,
            Err(PoolError::Worker(_))
        ));
        assert_eq!(
            collect(pool.request(request("/"), None).await.unwrap().body)
                .await
                .unwrap(),
            b"healthy".as_slice()
        );
        assert!(matches!(
            pool.request(request("/wrong-id"), None).await,
            Err(PoolError::Worker(_))
        ));
        assert_eq!(
            collect(pool.request(request("/"), None).await.unwrap().body)
                .await
                .unwrap(),
            b"healthy".as_slice()
        );
    }

    #[tokio::test]
    async fn hanging_worker_times_out_and_is_replaced() {
        let (_directory, config) = fixture();
        let mut pool = WorkerPool::new(config, 1);
        pool.timeout = Duration::from_millis(500);
        assert!(pool.request(request("/hang"), None).await.is_err());
        assert_eq!(
            collect(pool.request(request("/"), None).await.unwrap().body)
                .await
                .unwrap(),
            b"healthy".as_slice()
        );
    }

    #[tokio::test]
    async fn worker_queue_rejects_overload_instead_of_growing() {
        let (_directory, config) = fixture();
        let pool = Arc::new(WorkerPool::new(config, 1));
        let mut tasks = Vec::new();
        for _ in 0..20 {
            let pool = pool.clone();
            tasks.push(tokio::spawn(async move {
                pool.request(request("/slow"), None).await
            }));
        }
        let mut overloaded = 0;
        let mut succeeded = 0;
        for task in tasks {
            match task.await.unwrap() {
                Ok(_) => succeeded += 1,
                Err(PoolError::Overloaded) => overloaded += 1,
                Err(error) => panic!("unexpected queue failure: {error:?}"),
            }
        }
        assert!(succeeded > 0);
        assert!(
            succeeded <= 5,
            "one active worker plus four queued requests"
        );
        assert!(overloaded >= 15);
    }

    #[test]
    fn private_page_failure_fields_have_utf8_byte_and_scalar_limits() {
        let valid = serde_json::json!({"name":"Error","message":"safe","stack":"trace","statusCode":503,"code":"E_GSP"});
        assert!(serde_json::from_value::<PageFailure>(valid.clone())
            .unwrap()
            .validate()
            .is_ok());
        for (key, replacement) in [
            ("name", serde_json::json!("é".repeat(65))),
            ("message", serde_json::json!("x".repeat(2049))),
            ("stack", serde_json::json!("x".repeat(4097))),
            ("statusCode", serde_json::json!(999)),
            ("code", serde_json::json!({"arbitrary":"object"})),
            ("code", serde_json::json!("x".repeat(257))),
        ] {
            let mut value = valid.clone();
            value[key] = replacement;
            assert!(
                serde_json::from_value::<PageFailure>(value)
                    .unwrap()
                    .validate()
                    .is_err(),
                "{key}"
            );
        }
        let mut explicit_null = valid;
        explicit_null["code"] = serde_json::Value::Null;
        let error: PageFailure = serde_json::from_value(explicit_null).unwrap();
        assert_eq!(error.code, Some(serde_json::Value::Null));
        assert_eq!(
            serde_json::to_value(error).unwrap()["code"],
            serde_json::Value::Null
        );
    }
}
