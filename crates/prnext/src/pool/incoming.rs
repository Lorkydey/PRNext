//! Demand-driven request ingress, negotiated independently from binary replies.
//! One Node credit authorizes at most one 64 KiB chunk. The existing ingress
//! lease stays owned here until EOF/cancellation, never an untracked task.
use super::*;
use axum::body::Body;
use futures_util::StreamExt;
use std::sync::atomic::AtomicBool;

pub(super) type Writer = Arc<tokio::sync::Mutex<Box<dyn AsyncWrite + Unpin + Send>>>;
#[derive(Debug)]
pub(super) struct Incoming {
    pub body: Body,
    pub length: Option<usize>,
    pub limit: usize,
    pub deadline: tokio::time::Instant,
}

#[derive(Debug)]
pub(crate) struct IngressFailure(pub u16);
impl std::fmt::Display for IngressFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Request body transport failed")
    }
}
impl std::error::Error for IngressFailure {}

impl Incoming {
    pub async fn buffered(self) -> Result<Bytes> {
        match tokio::time::timeout_at(self.deadline, axum::body::to_bytes(self.body, self.limit))
            .await
        {
            Ok(Ok(bytes)) if self.length.is_none_or(|length| length == bytes.len()) => Ok(bytes),
            Ok(Ok(_)) => Err(IngressFailure(400).into()),
            Ok(Err(_)) => Err(IngressFailure(413).into()),
            Err(_) => Err(IngressFailure(408).into()),
        }
    }
}

pub(super) struct Upload {
    credit: mpsc::Sender<()>,
    outstanding: Arc<AtomicBool>,
    task: Option<tokio::task::JoinHandle<()>>,
}
impl Upload {
    pub fn start(incoming: Incoming, lease: Option<BodyLease>, writer: Writer) -> Self {
        let (credit, mut demand) = mpsc::channel(1);
        let outstanding = Arc::new(AtomicBool::new(false));
        let pending = outstanding.clone();
        let task = tokio::spawn(async move {
            let mut lease = lease;
            let mut source = Some(incoming.body.into_data_stream());
            let mut remaining = Bytes::new();
            let mut total = 0usize;
            let mut expired = false;
            loop {
                let credit = if expired {
                    demand.recv().await
                } else {
                    match tokio::time::timeout_at(incoming.deadline, demand.recv()).await {
                        Ok(credit) => credit,
                        Err(_) => {
                            // A handler can return a long-lived response without
                            // reading its upload. Release native ingress at its
                            // original deadline independently of response traffic.
                            drop(source.take());
                            remaining = Bytes::new();
                            drop(lease.take());
                            expired = true;
                            demand.recv().await
                        }
                    }
                };
                if credit.is_none() {
                    break;
                }
                let result: std::result::Result<Option<Bytes>, u8> = async {
                    if expired || tokio::time::Instant::now() >= incoming.deadline {
                        return Err(2);
                    }
                    while remaining.is_empty() {
                        match tokio::time::timeout_at(
                            incoming.deadline,
                            source.as_mut().unwrap().next(),
                        )
                        .await
                        {
                            Err(_) => return Err(2),
                            Ok(Some(Err(_))) => return Err(3),
                            Ok(None) => {
                                return if incoming.length.is_none_or(|length| length == total) {
                                    Ok(None)
                                } else {
                                    Err(4)
                                };
                            }
                            Ok(Some(Ok(bytes))) => {
                                total = total.checked_add(bytes.len()).ok_or(1u8)?;
                                if total > incoming.limit {
                                    return Err(1);
                                }
                                if incoming.length.is_some_and(|length| total > length) {
                                    return Err(4);
                                }
                                remaining = bytes;
                            }
                        }
                    }
                    Ok(Some(
                        remaining.split_to(remaining.len().min(MAX_CHUNK_BYTES)),
                    ))
                }
                .await;
                let mut output = writer.lock().await;
                let terminal = !matches!(&result, Ok(Some(_)));
                // Release the logical credit before publishing bytes: Node
                // may consume them on another CPU before write_all returns.
                // The channel still bounds read-ahead to one queued credit.
                pending.store(false, Ordering::Release);
                let write = async {
                    match result {
                        Ok(Some(bytes)) => {
                            output
                                .write_all(&(bytes.len() as u32).to_be_bytes())
                                .await?;
                            output.write_all(&bytes).await?;
                        }
                        Ok(None) => output.write_all(&0u32.to_be_bytes()).await?,
                        Err(code) => {
                            output.write_all(&u32::MAX.to_be_bytes()).await?;
                            output.write_all(&[code]).await?;
                        }
                    }
                    output.flush().await
                }
                .await;
                if terminal || write.is_err() {
                    break;
                }
            }
        });
        Self {
            credit,
            outstanding,
            task: Some(task),
        }
    }
    pub fn grant(&self, length: Option<usize>) -> Result<()> {
        if length != Some(MAX_CHUNK_BYTES) || self.outstanding.swap(true, Ordering::AcqRel) {
            bail!("Invalid or duplicate request-body credit");
        }
        self.credit
            .try_send(())
            .map_err(|_| anyhow!("Request-body credit after completion"))
    }
    pub async fn cancel(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
    }
}
impl Drop for Upload {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn real_worker() -> (tempfile::TempDir, WorkerConfig) {
        let directory = tempfile::tempdir().unwrap();
        let dist = directory.path().join("dist");
        std::fs::create_dir_all(dist.join("runtime")).unwrap();
        std::fs::create_dir_all(dist.join("server")).unwrap();
        let source = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/prnext/runtime")
            .canonicalize()
            .unwrap();
        for module in ["api", "http"] {
            let url = reqwest::Url::from_file_path(source.join(format!("{module}.mjs"))).unwrap();
            std::fs::write(
                dist.join("runtime").join(format!("{module}.mjs")),
                format!(
                    "export * from {};",
                    serde_json::to_string(url.as_str()).unwrap()
                ),
            )
            .unwrap();
        }
        std::fs::write(dist.join("manifest.json"),r#"{"version":1,"buildId":"stream-ingress-test","config":{"streamingRequestBodies":true},"routes":[{"id":"upload","kind":"api","router":"app","pattern":"/[...path]","module":"server/upload.mjs"}]}"#).unwrap();
        std::fs::write(dist.join("server/upload.mjs"),r#"
            import {writeFileSync,readFileSync,existsSync} from 'node:fs';
            export function GET(){return new Response(JSON.stringify({pid:process.pid}));}
            export async function POST(request){
              if(new URL(request.url).pathname==='/ignore')return new Response(JSON.stringify({pid:process.pid,ignored:true}));
              const reader=request.body.getReader();const first=await reader.read();
              writeFileSync('first-seen',JSON.stringify({pid:process.pid,first:first.value?.length||0}));
              let count=existsSync('mutation-count')?Number(readFileSync('mutation-count','utf8')):0;writeFileSync('mutation-count',String(count+1));
              if(new URL(request.url).pathname==='/early'){await reader.cancel();return new Response(JSON.stringify({pid:process.pid,early:true}));}
              let size=first.value?.length||0,maxChunk=size;
              for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;maxChunk=Math.max(maxChunk,next.value.length);}
              return new Response(JSON.stringify({pid:process.pid,size,maxChunk}));
            }
        "#).unwrap();
        let config = WorkerConfig {
            node: std::env::var_os("PRNEXT_TEST_NODE")
                .unwrap_or_else(|| "node".into())
                .into(),
            script: source.join("worker.mjs"),
            project: directory.path().into(),
            dist,
            cache: None,
            memory: None,
        };
        (directory, config)
    }
    fn request(path: &str, body: WorkerBody, method: &str) -> WorkerRequest {
        WorkerRequest {
            max_duration: None,
            id: 0,
            route_id: "upload".into(),
            method: method.into(),
            url: format!("http://localhost{path}"),
            original_url: None,
            headers: BTreeMap::new(),
            routing_request_headers: None,
            routing_resolver: None,
            body,
            params: Params::new(),
            stream: true,
            render_mode: None,
            revalidate_reason: None,
            page_failure: None,
            document_request: None,
            middleware_matched: false,
        }
    }
    async fn collect(body: RenderedBody) -> Bytes {
        let body = match body {
            RenderedBody::Buffered(bytes) => Body::from(bytes),
            RenderedBody::Compact(body) => Body::from_stream(body),
            RenderedBody::Stream(body) => Body::from_stream(body),
        };
        axum::body::to_bytes(body, MAX_RESPONSE_BYTES)
            .await
            .unwrap()
    }
    async fn wait_file(path: &std::path::Path) {
        timeout(Duration::from_secs(10), async {
            while !path.is_file() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("real handler did not observe first bytes before EOF");
    }
    async fn body_lease() -> BodyLease {
        BodyBudget::default()
            .request(
                &axum::extract::Request::new(Body::from("reservation")),
                MAX_BODY_BYTES,
            )
            .await
            .unwrap()
    }
    async fn shutdown(pool: Arc<WorkerPool>) {
        let lifecycle = pool.lifecycle.clone();
        lifecycle.begin_drain_for(Duration::from_secs(5));
        lifecycle.force();
        drop(pool);
        assert!(timeout(Duration::from_secs(10), lifecycle.join())
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn older_socket_capability_and_stdio_both_buffer_without_replaying() {
        for lanes in [1, 2] {
            let (directory, mut config) = real_worker();
            // Run the real worker while omitting only its new advertised
            // capability, as a pre-streaming runtime does. Its renderer and
            // request framing remain real, rather than a mocked Rust parser.
            let worker_url = reqwest::Url::from_file_path(&config.script).unwrap();
            config.script = directory.path().join("old-capability.mjs");
            std::fs::write(&config.script, format!(r#"
                // prnext-transport:socket-v2
                // prnext-concurrency:512
                const original=process.stdout.write.bind(process.stdout);
                process.stdout.write=(chunk,...args)=>{{
                  try{{const ready=JSON.parse(String(chunk));if(Object.hasOwn(ready,'requestBodyStream')){{delete ready.requestBodyStream;chunk=JSON.stringify(ready)+'\n';}}}}catch{{}}
                  return original(chunk,...args);
                }};
                await import({});
            "#,serde_json::to_string(worker_url.as_str()).unwrap())).unwrap();
            let pool = Arc::new(WorkerPool::new(config, 1).concurrent(lanes));
            let warm = pool
                .request(request("/", WorkerBody::default(), "GET"), None)
                .await
                .unwrap();
            collect(warm.body).await;
            let (sender, receiver) = mpsc::channel::<std::result::Result<Bytes, std::io::Error>>(1);
            let (waiting, seen) = oneshot::channel();
            let body = Body::from_stream(futures_util::stream::unfold(
                (receiver, 0, Some(waiting)),
                |(mut receiver, polls, mut waiting)| async move {
                    if polls == 1 {
                        if let Some(waiting) = waiting.take() {
                            let _ = waiting.send(());
                        }
                    }
                    receiver
                        .recv()
                        .await
                        .map(|bytes| (bytes, (receiver, polls + 1, waiting)))
                },
            ));
            let incoming = WorkerBody::streamed(
                body,
                body_lease().await,
                Some(6),
                MAX_BODY_BYTES,
                tokio::time::Instant::now() + Duration::from_secs(10),
            );
            let pending = tokio::spawn({
                let pool = pool.clone();
                async move {
                    pool.request(request("/upload", incoming, "POST"), None)
                        .await
                }
            });
            sender.send(Ok(Bytes::from_static(b"abc"))).await.unwrap();
            timeout(Duration::from_secs(5), seen)
                .await
                .unwrap()
                .unwrap();
            assert!(
                !directory.path().join("first-seen").exists(),
                "an unnegotiated runtime must not see a partial body"
            );
            sender.send(Ok(Bytes::from_static(b"def"))).await.unwrap();
            drop(sender);
            let result = pending.await.unwrap().unwrap();
            assert_eq!(result.status, 200);
            let data: serde_json::Value =
                serde_json::from_slice(&collect(result.body).await).unwrap();
            assert_eq!(data["size"], 6);
            assert_eq!(
                std::fs::read_to_string(directory.path().join("mutation-count")).unwrap(),
                "1"
            );
            shutdown(pool).await;
        }
    }

    #[tokio::test]
    async fn real_route_handler_receives_first_bytes_before_eof_and_host_survives_early_cancel() {
        let (directory, config) = real_worker();
        let pool = Arc::new(WorkerPool::new(config, 1).concurrent(2));
        let warm = pool
            .request(request("/", WorkerBody::default(), "GET"), None)
            .await
            .unwrap();
        let original: serde_json::Value =
            serde_json::from_slice(&collect(warm.body).await).unwrap();
        let (sender, receiver) = mpsc::channel::<std::result::Result<Bytes, std::io::Error>>(1);
        let body = Body::from_stream(futures_util::stream::unfold(
            receiver,
            |mut receiver| async { receiver.recv().await.map(|value| (value, receiver)) },
        ));
        let incoming = WorkerBody::streamed(
            body,
            body_lease().await,
            Some(128 * 1024),
            MAX_BODY_BYTES,
            tokio::time::Instant::now() + Duration::from_secs(10),
        );
        let pending = tokio::spawn({
            let pool = pool.clone();
            async move {
                pool.request(request("/upload", incoming, "POST"), None)
                    .await
            }
        });
        sender
            .send(Ok(Bytes::from(vec![7; 64 * 1024])))
            .await
            .unwrap();
        wait_file(&directory.path().join("first-seen")).await;
        assert!(
            !pending.is_finished(),
            "handler must be waiting for the withheld upload tail"
        );
        sender
            .send(Ok(Bytes::from(vec![9; 64 * 1024])))
            .await
            .unwrap();
        drop(sender);
        let result = pending.await.unwrap().unwrap();
        assert_eq!(result.status, 200);
        let data: serde_json::Value = serde_json::from_slice(&collect(result.body).await).unwrap();
        assert_eq!(data["size"], 128 * 1024);
        assert_eq!(data["maxChunk"], MAX_CHUNK_BYTES);
        assert_eq!(data["pid"], original["pid"]);
        assert_eq!(
            std::fs::read_to_string(directory.path().join("mutation-count")).unwrap(),
            "1"
        );
        let (sender, receiver) = mpsc::channel::<std::result::Result<Bytes, std::io::Error>>(1);
        sender.send(Ok(Bytes::from_static(b"early"))).await.unwrap();
        let body = Body::from_stream(futures_util::stream::unfold(
            receiver,
            |mut receiver| async { receiver.recv().await.map(|value| (value, receiver)) },
        ));
        let result = pool
            .request(
                request(
                    "/early",
                    WorkerBody::streamed(
                        body,
                        body_lease().await,
                        None,
                        MAX_BODY_BYTES,
                        tokio::time::Instant::now() + Duration::from_secs(10),
                    ),
                    "POST",
                ),
                None,
            )
            .await
            .unwrap();
        assert_eq!(result.status, 200);
        let _: serde_json::Value = serde_json::from_slice(&collect(result.body).await).unwrap();
        timeout(Duration::from_secs(3), sender.closed())
            .await
            .expect("early response must drop unread ingress");
        let healthy = pool
            .request(request("/", WorkerBody::default(), "GET"), None)
            .await
            .unwrap();
        let healthy: serde_json::Value =
            serde_json::from_slice(&collect(healthy.body).await).unwrap();
        assert_eq!(healthy["pid"], original["pid"]);
        assert_eq!(
            std::fs::read_to_string(directory.path().join("mutation-count")).unwrap(),
            "2",
            "mutations must never replay"
        );
        shutdown(pool).await;
    }

    #[tokio::test]
    async fn real_worker_enforces_length_limit_and_cancelled_upload_releases_source() {
        let (directory, config) = real_worker();
        let pool = Arc::new(WorkerPool::new(config, 1).concurrent(2));
        for (length, limit, expected) in [(Some(4), MAX_BODY_BYTES, 400u16), (None, 2, 413u16)] {
            let body = WorkerBody::streamed(
                Body::from("abc"),
                body_lease().await,
                length,
                limit,
                tokio::time::Instant::now() + Duration::from_secs(10),
            );
            let result = pool
                .request(request("/upload", body, "POST"), None)
                .await
                .unwrap();
            assert_eq!(result.status, expected);
            collect(result.body).await;
        }
        let (sender, receiver) = mpsc::channel::<std::result::Result<Bytes, std::io::Error>>(1);
        let body = Body::from_stream(futures_util::stream::unfold(
            receiver,
            |mut receiver| async { receiver.recv().await.map(|value| (value, receiver)) },
        ));
        let upload_request = request(
            "/upload",
            WorkerBody::streamed(
                body,
                body_lease().await,
                None,
                MAX_BODY_BYTES,
                tokio::time::Instant::now() + Duration::from_secs(10),
            ),
            "POST",
        );
        let pending = tokio::spawn({
            let pool = pool.clone();
            async move { pool.request(upload_request, None).await }
        });
        tokio::task::yield_now().await;
        pending.abort();
        let _ = pending.await;
        timeout(Duration::from_secs(3), sender.closed())
            .await
            .expect("cancelled request retained the upload source");
        let response = pool
            .request(request("/", WorkerBody::default(), "GET"), None)
            .await
            .unwrap();
        assert_eq!(response.status, 200);
        collect(response.body).await;
        let stalled = Body::from_stream(futures_util::stream::pending::<
            std::result::Result<Bytes, std::io::Error>,
        >());
        let timed_out = pool
            .request(
                request(
                    "/upload",
                    WorkerBody::streamed(
                        stalled,
                        body_lease().await,
                        None,
                        MAX_BODY_BYTES,
                        tokio::time::Instant::now() + Duration::from_millis(25),
                    ),
                    "POST",
                ),
                None,
            )
            .await
            .unwrap();
        assert_eq!(timed_out.status, 408);
        collect(timed_out.body).await;
        let broken = Body::from_stream(futures_util::stream::once(async {
            Err::<Bytes, _>(std::io::Error::other("fixture source disconnected"))
        }));
        let failed = pool
            .request(
                request(
                    "/upload",
                    WorkerBody::streamed(
                        broken,
                        body_lease().await,
                        None,
                        MAX_BODY_BYTES,
                        tokio::time::Instant::now() + Duration::from_secs(10),
                    ),
                    "POST",
                ),
                None,
            )
            .await
            .unwrap();
        assert_eq!(failed.status, 400);
        collect(failed.body).await;
        shutdown(pool).await;
        drop(directory);
    }
    #[tokio::test]
    async fn no_source_poll_before_credit_and_cancel_releases_lease() {
        let polled = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = polled.clone();
        let body = Body::from_stream(futures_util::stream::poll_fn(move |_| {
            seen.fetch_add(1, Ordering::Relaxed);
            std::task::Poll::Pending::<Option<std::result::Result<Bytes, std::io::Error>>>
        }));
        let (left, _right) = tokio::io::duplex(1024);
        let writer: Writer = Arc::new(tokio::sync::Mutex::new(Box::new(left)));
        let mut upload = Upload::start(
            Incoming {
                body,
                length: None,
                limit: MAX_BODY_BYTES,
                deadline: tokio::time::Instant::now() + Duration::from_secs(5),
            },
            None,
            writer,
        );
        tokio::task::yield_now().await;
        assert_eq!(polled.load(Ordering::Relaxed), 0);
        upload.grant(Some(MAX_CHUNK_BYTES)).unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while polled.load(Ordering::Relaxed) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(upload.grant(Some(MAX_CHUNK_BYTES)).is_err());
        upload.cancel().await;
        upload.cancel().await;
    }
    #[tokio::test]
    async fn an_expired_ready_source_cannot_bypass_the_ingress_deadline() {
        // timeout_at polls an already-ready future before its timer. Explicit
        // deadline validation is required even when source and credit are ready.
        let (left, mut right) = tokio::io::duplex(1024);
        let writer: Writer = Arc::new(tokio::sync::Mutex::new(Box::new(left)));
        let mut upload = Upload::start(
            Incoming {
                body: Body::from("too late"),
                length: None,
                limit: MAX_BODY_BYTES,
                deadline: tokio::time::Instant::now() - Duration::from_millis(1),
            },
            None,
            writer,
        );
        upload.grant(Some(MAX_CHUNK_BYTES)).unwrap();
        assert_eq!(right.read_u32().await.unwrap(), u32::MAX);
        assert_eq!(right.read_u8().await.unwrap(), 2);
        upload.cancel().await;
    }

    #[tokio::test]
    async fn unread_upload_deadline_releases_full_ingress_reservation_without_a_credit() {
        let budget = BodyBudget::default();
        let request =
            axum::extract::Request::new(Body::from_stream(futures_util::stream::pending::<
                std::result::Result<Bytes, std::io::Error>,
            >()));
        let lease = budget.request(&request, MAX_BODY_BYTES).await.unwrap();
        let (left, _right) = tokio::io::duplex(1024);
        let writer: Writer = Arc::new(tokio::sync::Mutex::new(Box::new(left)));
        let mut upload = Upload::start(
            Incoming {
                body: request.into_body(),
                length: None,
                limit: MAX_BODY_BYTES,
                deadline: tokio::time::Instant::now() + Duration::from_millis(25),
            },
            Some(lease),
            writer,
        );
        let next = axum::extract::Request::new(Body::from_stream(futures_util::stream::pending::<
            std::result::Result<Bytes, std::io::Error>,
        >()));
        let replacement = timeout(
            Duration::from_secs(1),
            budget.request(&next, MAX_BODY_BYTES),
        )
        .await
        .expect("unread upload kept all ingress permits beyond its deadline")
        .unwrap();
        drop(replacement);
        upload.cancel().await;
    }
    #[tokio::test]
    async fn chunk_boundaries_eof_and_length_errors_are_explicit() {
        for (declared, code) in [(Some(3), 0u32), (Some(4), u32::MAX)] {
            let (left, mut right) = tokio::io::duplex(1024);
            let writer: Writer = Arc::new(tokio::sync::Mutex::new(Box::new(left)));
            let mut upload = Upload::start(
                Incoming {
                    body: Body::from("abc"),
                    length: declared,
                    limit: MAX_BODY_BYTES,
                    deadline: tokio::time::Instant::now() + Duration::from_secs(5),
                },
                None,
                writer,
            );
            upload.grant(Some(MAX_CHUNK_BYTES)).unwrap();
            assert_eq!(right.read_u32().await.unwrap(), 3);
            let mut bytes = [0; 3];
            right.read_exact(&mut bytes).await.unwrap();
            assert_eq!(&bytes, b"abc");
            // The write callback publishes credit release before another turn.
            tokio::task::yield_now().await;
            upload.grant(Some(MAX_CHUNK_BYTES)).unwrap();
            assert_eq!(right.read_u32().await.unwrap(), code);
            if code == u32::MAX {
                assert_eq!(right.read_u8().await.unwrap(), 4);
            }
            upload.cancel().await;
        }
    }
}
