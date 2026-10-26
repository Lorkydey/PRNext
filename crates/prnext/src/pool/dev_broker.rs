//! A CLI-owned prewarmed process is leased to exactly one immutable dev build.
//! Production and alternate worker scripts never consume this private descriptor.
use super::*;
use tokio::net::TcpStream;

#[derive(Deserialize)]
struct Descriptor {
    project: PathBuf,
    dist: PathBuf,
    port: u16,
    token: String,
    #[serde(rename = "guardPort")]
    guard_port: u16,
}
pub(super) struct Prepared {
    pub port: u16,
    pub token: String,
    pub watch: BufReader<TcpStream>,
    pub control: TcpStream,
    pub guard_port: u16,
}
pub(super) async fn force(port: u16, token: &str) -> Result<()> {
    timeout(Duration::from_secs(2), async {
        let mut socket = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).await?;
        socket.write_all(format!("{token}\n").as_bytes()).await?;
        let mut response = Vec::new();
        BufReader::new(socket)
            .take(16)
            .read_until(b'\n', &mut response)
            .await?;
        if response != b"stopped\n" {
            bail!("Development supervisor did not confirm worker exit");
        }
        Ok(())
    })
    .await?
}
pub(super) async fn connect(config: &WorkerConfig, lanes: usize) -> Result<Option<Prepared>> {
    // Serial maintenance workers retain their own native-owned lifetime.
    if lanes < 2 {
        return Ok(None);
    }
    let Some(file) = std::env::var_os("PRNEXT_DEV_BROKER") else {
        return Ok(None);
    };
    if config
        .script
        .file_name()
        .is_none_or(|name| name != "worker.mjs")
    {
        return Ok(None);
    }
    if !crate::manifest::Manifest::load(&config.dist).await?.dev {
        return Ok(None);
    }
    let file = PathBuf::from(file);
    let info = tokio::fs::symlink_metadata(&file).await?;
    if !info.is_file() || info.file_type().is_symlink() || info.len() > 4096 {
        bail!("Invalid development transport descriptor")
    }
    let descriptor: Descriptor = serde_json::from_slice(&tokio::fs::read(&file).await?)
        .context("Invalid development transport descriptor")?;
    if descriptor.port == 0
        || descriptor.guard_port == 0
        || descriptor.token.len() != 43
        || !descriptor
            .token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        || tokio::fs::canonicalize(&descriptor.project).await?
            != tokio::fs::canonicalize(&config.project).await?
        || tokio::fs::canonicalize(&descriptor.dist).await?
            != tokio::fs::canonicalize(&config.dist).await?
    {
        bail!("Development transport does not match this generation")
    }
    let cache = config
        .cache
        .as_ref()
        .map(|value| serde_json::json!({"url":value.url,"token":value.token}));
    async fn open(
        descriptor: &Descriptor,
        cache: &Option<serde_json::Value>,
        lanes: usize,
        watch: bool,
    ) -> Result<(u16, BufReader<TcpStream>)> {
        let mut socket =
            TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, descriptor.port)).await?;
        socket.set_nodelay(true)?;
        let message = serde_json::json!({"token":descriptor.token,"project":descriptor.project,"dist":descriptor.dist,"lanes":lanes,"cache":cache,"watch":watch});
        socket.write_all(format!("{message}\n").as_bytes()).await?;
        let mut response = Vec::new();
        let mut reader = BufReader::new(socket);
        timeout(
            Duration::from_secs(15),
            (&mut reader).take(1024).read_until(b'\n', &mut response),
        )
        .await??;
        let ready: serde_json::Value = serde_json::from_slice(&response)
            .context("Development transport did not become ready")?;
        let port = ready["port"]
            .as_u64()
            .filter(|port| *port > 0 && *port <= 65535)
            .context("Invalid development worker port")?;
        Ok((port as u16, reader))
    }
    let (port, watch) = open(&descriptor, &cache, lanes, true).await?;
    let (_, control) = open(&descriptor, &cache, lanes, false).await?;
    Ok(Some(Prepared {
        port,
        token: descriptor.token,
        watch,
        control: control.into_inner(),
        guard_port: descriptor.guard_port,
    }))
}
