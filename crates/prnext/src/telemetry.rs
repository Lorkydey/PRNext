//! Opt-in, bounded OTLP/HTTP JSON traces. No request content is exported.
use axum::{
    body::{Body, Bytes},
    http::{HeaderMap, HeaderValue},
};
use http_body::{Frame, SizeHint};
use serde_json::{json, Value};
use std::{
    pin::Pin,
    sync::OnceLock,
    task::{Context, Poll},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, oneshot};

enum Message {
    Span(Value),
    Flush(oneshot::Sender<()>),
}
static EXPORTER: OnceLock<Option<mpsc::Sender<Message>>> = OnceLock::new();
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
                    let body=json!({"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":service}}]},"scopeSpans":[{"scope":{"name":"prnext.native"},"spans":std::mem::take(&mut batch)}]}]}).to_string();
                    for attempt in 0..3 {
                        let response=client.post(url.clone()).headers(headers.clone()).body(body.clone()).send().await;
                        let retry=match response {Ok(value)=>[429,502,503,504].contains(&value.status().as_u16()),Err(_)=>true};
                        if !retry {break;}if attempt<2 {tokio::time::sleep(Duration::from_millis(100<<attempt)).await;}
                    }
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
            let _ = self.sender.try_send(Message::Span(value));
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
        if tx.send(Message::Flush(done)).await.is_ok() {
            let _ = tokio::time::timeout(Duration::from_secs(3), wait).await;
        }
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
}
