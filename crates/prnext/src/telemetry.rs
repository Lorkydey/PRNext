//! Opt-in, bounded OTLP/HTTP JSON traces. No request content is exported.
use axum::{
    body::{Body, Bytes},
    http::{HeaderMap, HeaderValue},
};
use http_body::{Frame, SizeHint};
use serde_json::{json, Value};
use std::{
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering::Relaxed},
        OnceLock,
    },
    task::{Context, Poll},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, oneshot};

enum Message {
    Span(Value),
    Flush(oneshot::Sender<()>),
}
static EXPORTER: OnceLock<Option<mpsc::Sender<Message>>> = OnceLock::new();
#[derive(Default)]
struct ExportCounters {
    dropped: AtomicU64,
    rejected: AtomicU64,
    attempts: AtomicU64,
    failures: AtomicU64,
    failed_batches: AtomicU64,
    exported: AtomicU64,
    last_warning: AtomicU64,
}
static COUNTERS: ExportCounters = ExportCounters {
    dropped: AtomicU64::new(0),
    rejected: AtomicU64::new(0),
    attempts: AtomicU64::new(0),
    failures: AtomicU64::new(0),
    failed_batches: AtomicU64::new(0),
    exported: AtomicU64::new(0),
    last_warning: AtomicU64::new(0),
};
impl ExportCounters {
    fn values(&self) -> Value {
        json!({"droppedSpans":self.dropped.load(Relaxed),"rejectedSpans":self.rejected.load(Relaxed),"exportAttempts":self.attempts.load(Relaxed),
            "exportFailures":self.failures.load(Relaxed),"failedBatches":self.failed_batches.load(Relaxed),"exportedSpans":self.exported.load(Relaxed)})
    }
    fn warn(&self, reason: &str) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        let previous = self.last_warning.load(Relaxed);
        if now.saturating_sub(previous) >= 10_000
            && self
                .last_warning
                .compare_exchange(previous, now, Relaxed, Relaxed)
                .is_ok()
        {
            // Fixed fields only, independent of OTLP: no endpoint, credential,
            // application exception or request content can enter this warning.
            eprintln!(
                "[prnext] telemetry {}",
                json!({"reason":reason,"counters":self.values()})
            );
        }
    }
    fn enqueue(&self, sender: &mpsc::Sender<Message>, span: Value) {
        if sender.try_send(Message::Span(span)).is_err() {
            self.dropped.fetch_add(1, Relaxed);
            self.warn("queue_full");
        }
    }
}
pub(crate) fn snapshot() -> Value {
    let sender = EXPORTER.get().and_then(Option::as_ref);
    let mut values = COUNTERS.values();
    values["enabled"] = json!(sender.is_some());
    values["queuedSpans"] =
        json!(sender.map_or(0, |tx| tx.max_capacity().saturating_sub(tx.capacity())));
    values
}
async fn collector_result(mut response: reqwest::Response, count: usize) -> Option<(u64, bool)> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len().saturating_add(chunk.len()) > 16 * 1024 {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    let body: Value = if bytes.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&bytes).ok()?
    };
    if !body.is_object() {
        return None;
    }
    let partial = body
        .get("partialSuccess")
        .or_else(|| body.get("partial_success"));
    let Some(partial) = partial.filter(|value| !value.is_null()) else {
        return Some((0, false));
    };
    if !partial.is_object() {
        return None;
    }
    let rejected = match partial
        .get("rejectedSpans")
        .or_else(|| partial.get("rejected_spans"))
    {
        None => 0,
        Some(Value::String(value))
            if !value.is_empty()
                && value.len() <= 20
                && value.bytes().all(|b| b.is_ascii_digit()) =>
        {
            value.parse::<u64>().ok()?
        }
        Some(value) => value.as_u64()?,
    };
    if rejected > count as u64 {
        return None;
    }
    let warning = partial
        .get("errorMessage")
        .or_else(|| partial.get("error_message"))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    Some((rejected, warning))
}
async fn export_batch(
    client: &reqwest::Client,
    url: &reqwest::Url,
    headers: &HeaderMap,
    body: String,
    count: usize,
    counters: &ExportCounters,
) {
    for attempt in 0..3 {
        counters.attempts.fetch_add(1, Relaxed);
        let response = client
            .post(url.clone())
            .headers(headers.clone())
            .body(body.clone())
            .send()
            .await;
        let retry = match response {
            Ok(value) if value.status().is_success() => {
                if let Some((rejected, warning)) = collector_result(value, count).await {
                    counters
                        .exported
                        .fetch_add(count as u64 - rejected, Relaxed);
                    if rejected > 0 {
                        counters.rejected.fetch_add(rejected, Relaxed);
                        counters.dropped.fetch_add(rejected, Relaxed);
                        counters.failures.fetch_add(1, Relaxed);
                        counters.failed_batches.fetch_add(1, Relaxed);
                        counters.warn("collector_rejected");
                    } else if warning {
                        counters.warn("collector_warning");
                    }
                    return;
                }
                false // Never retry a 2xx acknowledgement, including partial success.
            }
            Ok(value) => [429, 502, 503, 504].contains(&value.status().as_u16()),
            Err(_) => true,
        };
        counters.failures.fetch_add(1, Relaxed);
        if !retry {
            break;
        }
        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(100 << attempt)).await;
        }
    }
    counters.failed_batches.fetch_add(1, Relaxed);
    counters.dropped.fetch_add(count as u64, Relaxed);
    counters.warn("export_failed");
}
fn nanos() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string()
}
fn random<const N: usize>() -> Option<String> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|v| format!("{v:02x}")).collect())
}
fn parent(value: &str) -> Option<(&str, &str, bool)> {
    let parts: Vec<_> = value.split('-').collect();
    if parts.len() != 4
        || parts[0] != "00"
        || parts[1].len() != 32
        || parts[2].len() != 16
        || parts[3].len() != 2
        || !parts[1..].iter().all(|s| {
            s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        || parts[1].bytes().all(|b| b == b'0')
        || parts[2].bytes().all(|b| b == b'0')
    {
        return None;
    }
    Some((
        parts[1],
        parts[2],
        u8::from_str_radix(parts[3], 16).ok()? & 1 != 0,
    ))
}
fn exporter() -> Option<&'static mpsc::Sender<Message>> {
    EXPORTER.get_or_init(|| {
        if std::env::var("OTEL_SDK_DISABLED").as_deref()==Ok("true") {return None;}
        let protocol=std::env::var("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL").or_else(|_|std::env::var("OTEL_EXPORTER_OTLP_PROTOCOL")).ok();
        if protocol.as_deref().is_some_and(|p|p!="http/json") {return None;}
        let endpoint=std::env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT").ok().or_else(||std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok().map(|v|format!("{}/v1/traces",v.trim_end_matches('/'))))?;
        let url=reqwest::Url::parse(&endpoint).ok()?;if !["http","https"].contains(&url.scheme()) {return None;}
        let mut headers=HeaderMap::new();
        for item in std::env::var("OTEL_EXPORTER_OTLP_TRACES_HEADERS").or_else(|_|std::env::var("OTEL_EXPORTER_OTLP_HEADERS")).unwrap_or_default().split(',') {
            if let Some((key,value))=item.split_once('=') {
                if let (Ok(name),Ok(value))=(axum::http::HeaderName::from_bytes(key.trim().as_bytes()),HeaderValue::from_str(&percent_encoding::percent_decode_str(value.trim()).decode_utf8_lossy())) {headers.insert(name,value);}
            }
        }
        headers.insert(axum::http::header::CONTENT_TYPE,HeaderValue::from_static("application/json"));
        let _=rustls::crypto::ring::default_provider().install_default();
        let client=reqwest::Client::builder().retry(reqwest::retry::never()).timeout(Duration::from_secs(2)).redirect(reqwest::redirect::Policy::none()).build().ok()?;
        let service=std::env::var("OTEL_SERVICE_NAME").unwrap_or_else(|_|"prnext".into());
        let (tx,mut rx)=mpsc::channel(1024);
        tokio::spawn(async move {
            let mut batch=Vec::with_capacity(128);
            loop {
                let message=if batch.is_empty(){rx.recv().await}else{tokio::time::timeout(Duration::from_millis(200),rx.recv()).await.ok().flatten()};
                let received=matches!(&message,Some(Message::Span(_)));
                let mut flush=None;
                match message {Some(Message::Span(span))=>batch.push(span),Some(Message::Flush(done))=>flush=Some(done),None if batch.is_empty()=>break,None=>{}}
                if batch.len()<128 && flush.is_none() && !batch.is_empty() && received {continue;}
                if !batch.is_empty() {
                    let count=batch.len();
                    let body=json!({"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":service}}]},"scopeSpans":[{"scope":{"name":"prnext.native"},"spans":std::mem::take(&mut batch)}]}]}).to_string();
                    export_batch(&client,&url,&headers,body,count,&COUNTERS).await;
                }
                if let Some(done)=flush {let _=done.send(());}
            }
        });Some(tx)
    }).as_ref()
}
pub(crate) fn enabled() -> bool {
    exporter().is_some()
}

pub(crate) struct Span {
    value: Option<Value>,
    sampled: bool,
    sender: mpsc::Sender<Message>,
}
impl Span {
    pub fn begin(headers: &mut HeaderMap, method: &str, route: &str) -> Option<Self> {
        let sender = exporter()?.clone();
        let incoming = headers
            .get("traceparent")
            .and_then(|v| v.to_str().ok())
            .and_then(parent);
        let trace = incoming.map(|p| p.0.to_string()).or_else(random::<16>)?;
        let previous = incoming.map(|p| p.1.to_string());
        let sampled = incoming.is_none_or(|p| p.2);
        let id = random::<8>()?;
        let value = json!({"traceId":trace,"spanId":id,"parentSpanId":previous.unwrap_or_default(),"flags":if sampled {1}else{0},"name":"prnext.http","kind":2,"startTimeUnixNano":nanos(),"attributes":[{"key":"http.request.method","value":{"stringValue":method}},{"key":"http.route","value":{"stringValue":route}}]});
        headers.insert(
            "traceparent",
            HeaderValue::from_str(&format!(
                "00-{trace}-{id}-{}",
                if sampled { "01" } else { "00" }
            ))
            .ok()?,
        );
        Some(Self {
            value: Some(value),
            sampled,
            sender,
        })
    }
    fn finish(&mut self, status: u16, cancelled: bool) {
        if let Some(mut value) = self.value.take() {
            if !self.sampled {
                return;
            }
            value["endTimeUnixNano"] = json!(nanos());
            value["attributes"].as_array_mut().unwrap().push(
                json!({"key":"http.response.status_code","value":{"intValue":status.to_string()}}),
            );
            if status >= 500 || cancelled {
                value["status"] = json!({"code":2});
            }
            COUNTERS.enqueue(&self.sender, value);
        }
    }
}
impl Drop for Span {
    fn drop(&mut self) {
        self.finish(0, true);
    }
}
struct TracedBody {
    inner: Body,
    span: Span,
    status: u16,
}
impl Drop for TracedBody {
    fn drop(&mut self) {
        self.span.finish(self.status, true);
    }
}
impl http_body::Body for TracedBody {
    type Data = Bytes;
    type Error = axum::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let value = Pin::new(&mut self.inner).poll_frame(cx);
        let status = self.status;
        match &value {
            Poll::Ready(None) => self.span.finish(status, false),
            Poll::Ready(Some(Err(_))) => self.span.finish(status, true),
            Poll::Ready(Some(Ok(_))) if self.inner.is_end_stream() => {
                self.span.finish(status, false)
            }
            _ => {}
        }
        value
    }
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}
pub(crate) fn body(inner: Body, mut span: Span, status: u16) -> Body {
    use http_body::Body as _;
    if inner.is_end_stream() {
        span.finish(status, false);
        inner
    } else {
        Body::new(TracedBody {
            inner,
            span,
            status,
        })
    }
}
pub(crate) async fn flush() {
    if let Some(Some(tx)) = EXPORTER.get() {
        let (done, wait) = oneshot::channel();
        // The send also needs a deadline when a stalled exporter fills its queue.
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            if tx.send(Message::Flush(done)).await.is_ok() {
                let _ = wait.await;
            }
        })
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_traceparent() {
        assert!(
            parent("00-11111111111111111111111111111111-2222222222222222-01")
                .unwrap()
                .2
        );
        for value in [
            "00-00000000000000000000000000000000-2222222222222222-01",
            "00-11111111111111111111111111111111-0000000000000000-01",
            "00-11111111111111111111111111111111-2222222222222222-xy",
            "01-11111111111111111111111111111111-2222222222222222-01",
        ] {
            assert!(parent(value).is_none());
        }
    }

    #[tokio::test]
    async fn exporter_counts_overload_without_an_exporter_dependency() {
        let counters = ExportCounters::default();
        let (tx, _rx) = mpsc::channel(1);
        counters.enqueue(&tx, json!({"spanId":"one"}));
        counters.enqueue(&tx, json!({"spanId":"two"}));
        assert_eq!(counters.dropped.load(Relaxed), 1);
        assert_eq!(tx.capacity(), 0);
        assert_eq!(counters.attempts.load(Relaxed), 0);
    }

    #[tokio::test]
    async fn exporter_distinguishes_success_permanent_rejection_and_bounded_retry() {
        use axum::{http::StatusCode, routing::post, Router};
        use std::sync::Arc;
        for (status, attempts, exported) in [(200, 1, 2), (400, 1, 0), (503, 3, 0)] {
            let calls = Arc::new(AtomicU64::new(0));
            let observed = calls.clone();
            let app = Router::new().route(
                "/v1/traces",
                post(move || {
                    let calls = observed.clone();
                    async move {
                        calls.fetch_add(1, Relaxed);
                        StatusCode::from_u16(status).unwrap()
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = reqwest::Url::parse(&format!(
                "http://{}/v1/traces",
                listener.local_addr().unwrap()
            ))
            .unwrap();
            let server = tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            let counters = ExportCounters::default();
            let client = reqwest::Client::builder()
                .retry(reqwest::retry::never())
                .timeout(Duration::from_secs(1))
                .build()
                .unwrap();
            export_batch(&client, &url, &HeaderMap::new(), "{}".into(), 2, &counters).await;
            assert_eq!(calls.load(Relaxed), attempts);
            assert_eq!(counters.attempts.load(Relaxed), attempts);
            assert_eq!(counters.exported.load(Relaxed), exported);
            assert_eq!(
                counters.failures.load(Relaxed),
                if exported > 0 { 0 } else { attempts }
            );
            assert_eq!(counters.dropped.load(Relaxed), 2 - exported);
            assert_eq!(
                counters.failed_batches.load(Relaxed),
                if exported > 0 { 0 } else { 1 }
            );
            server.abort();
            let _ = server.await;
        }
    }

    #[tokio::test]
    async fn partial_success_and_invalid_success_bodies_are_never_retried() {
        use axum::{routing::post, Router};
        use std::sync::Arc;
        for (body,exported,rejected) in [
            (r#"{"partialSuccess":{"rejectedSpans":"2","errorMessage":"private collector message"}}"#.to_owned(),1,2),
            ("invalid json".to_owned(),0,0),
            (" ".repeat(16*1024+1),0,0),
            (r#"{"partialSuccess":{"rejectedSpans":"4"}}"#.to_owned(),0,0),
        ] {
            let calls=Arc::new(AtomicU64::new(0));let observed=calls.clone();
            let app=Router::new().route("/",post(move ||{let calls=observed.clone();let body=body.clone();async move{calls.fetch_add(1,Relaxed);body}}));
            let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url=reqwest::Url::parse(&format!("http://{}/",listener.local_addr().unwrap())).unwrap();
            let server=tokio::spawn(async move{axum::serve(listener,app).await.unwrap();});
            let client=reqwest::Client::builder().retry(reqwest::retry::never()).timeout(Duration::from_secs(1)).build().unwrap();
            let counters=ExportCounters::default();
            export_batch(&client,&url,&HeaderMap::new(),"{}".into(),3,&counters).await;
            assert_eq!(calls.load(Relaxed),1);
            assert_eq!(counters.exported.load(Relaxed),exported);
            assert_eq!(counters.rejected.load(Relaxed),rejected);
            assert_eq!(counters.dropped.load(Relaxed),3-exported);
            assert_eq!(counters.failures.load(Relaxed),1);
            assert_eq!(counters.failed_batches.load(Relaxed),1);
            server.abort();let _=server.await;
        }
    }
}
