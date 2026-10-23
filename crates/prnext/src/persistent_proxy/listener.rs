//! Bound accepted connections as well as in-flight HTTP bodies. Admission
//! waits before accept, without opening unbounded idle connection tasks.
use std::{
    io,
    net::SocketAddr,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::{OwnedSemaphorePermit, Semaphore},
};
pub(super) struct LimitedListener {
    listener: TcpListener,
    slots: Arc<Semaphore>,
}
pub(super) struct Connection {
    stream: TcpStream,
    _slot: OwnedSemaphorePermit,
}
impl LimitedListener {
    pub(super) fn new(listener: TcpListener) -> Self {
        Self {
            listener,
            slots: Arc::new(Semaphore::new(1024)),
        }
    }
}
impl axum::serve::Listener for LimitedListener {
    type Io = Connection;
    type Addr = SocketAddr;
    async fn accept(&mut self) -> (Connection, SocketAddr) {
        let slot = self
            .slots
            .clone()
            .acquire_owned()
            .await
            .expect("connection admission remains open");
        let (stream, address) = axum::serve::Listener::accept(&mut self.listener).await;
        // Node's previous HTTP listener disabled Nagle by default. Keep that
        // policy: headers and a streamed body can become ready on separate
        // polls, otherwise small keep-alive responses hit delayed ACK stalls.
        let _ = stream.set_nodelay(true);
        (
            Connection {
                stream,
                _slot: slot,
            },
            address,
        )
    }
    fn local_addr(&self) -> io::Result<SocketAddr> {
        self.listener.local_addr()
    }
}
impl AsyncRead for Connection {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}
impl AsyncWrite for Connection {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
    fn is_write_vectored(&self) -> bool {
        self.stream.is_write_vectored()
    }
    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write_vectored(cx, bufs)
    }
}
