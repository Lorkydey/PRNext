//! Own prewarmed development Node processes outside V8. Parent EOF drains them;
//! a blocked JS event loop cannot disable the bounded native watchdog.
use anyhow::{bail, Context, Result};
use std::io::{Read, Write};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
};
pub async fn run(root: &Path, node: &Path, script: &Path) -> Result<()> {
    let token = std::env::var("PRNEXT_DEV_SPARE_TOKEN").unwrap_or_default();
    let control = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let control_port = control.local_addr()?.port();
    let mut command = Command::new(node);
    crate::pool::configure_development_child(&mut command, root).await?;
    let mut child = command
        .arg(script)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    let mut input = child.stdin.take().context("Missing development input")?;
    let (sender, mut receiver) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
    std::thread::spawn(move || {
        let mut source = std::io::stdin().lock();
        let mut buffer = [0; 8192];
        while let Ok(size) = source.read(&mut buffer) {
            if size == 0 || sender.blocking_send(buffer[..size].to_vec()).is_err() {
                break;
            }
        }
    });
    let mut copy = tokio::spawn(async move {
        while let Some(bytes) = receiver.recv().await {
            if input.write_all(&bytes).await.is_err() {
                break;
            }
        }
        let _ = input.shutdown().await;
    });
    let mut reader = BufReader::new(child.stdout.take().context("Missing development output")?);
    let mut output = std::io::stdout();
    let mut output_open = true;
    let mut parent_closed = false;
    let mut deadline = tokio::time::Instant::now() + Duration::from_secs(365 * 86400);
    let mut line = Vec::new();
    let mut forced = None;
    loop {
        line.clear();
        let mut bounded = (&mut reader).take(65537);
        tokio::select! {
            accepted=control.accept(),if !token.is_empty()=>{
                let(mut socket,_)=accepted?;
                let mut request=Vec::new();
                let mut authentication=BufReader::new(&mut socket);
                let result=tokio::time::timeout(Duration::from_millis(200),(&mut authentication).take(128).read_until(b'\n',&mut request)).await;
                let expected=format!("{token}\n");
                if matches!(result,Ok(Ok(_)))&&request.len()==expected.len()&&request.iter().zip(expected.as_bytes()).fold(0u8,|difference,(a,b)|difference|(a^b))==0 {
                    forced=Some(socket);break;
                }
            },
            result=child.wait()=>{copy.abort();let status=result?;if !status.success(){bail!("Development runtime exited")};return Ok(());},
            _=&mut copy,if !parent_closed=>{parent_closed=true;deadline=tokio::time::Instant::now()+Duration::from_secs(30);},
            _=tokio::time::sleep_until(deadline),if parent_closed=>{break;},
            result=tokio::time::timeout(Duration::from_secs(30),bounded.read_until(b'\n',&mut line))=>{
                match result {
                    Ok(Ok(size)) if size>0&&size<=65536=>{
                        if let Ok(mut message)=serde_json::from_slice::<serde_json::Value>(&line){
                            if message["type"]=="warm"{message["guardPort"]=control_port.into();line=serde_json::to_vec(&message)?;line.push(b'\n');}
                        }
                        if output_open && (output.write_all(&line).is_err() || output.flush().is_err()) {
                            output_open=false;
                            copy.abort();
                            if !parent_closed {parent_closed=true;deadline=tokio::time::Instant::now()+Duration::from_secs(30);}
                        }
                    },
                    _=>break,
                }
            }
        }
    }
    copy.abort();
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    if let Some(mut socket) = forced {
        let _ = socket.write_all(b"stopped\n").await;
    }
    Ok(())
}
