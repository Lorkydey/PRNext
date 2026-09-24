use anyhow::Result;
use clap::{Parser, Subcommand};
use rustyx::{
    manifest::Manifest,
    server::{start, ServerConfig},
};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "rustyx",
    version,
    about = "Rustyx native HTTP server for React applications"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Inspect a static image and produce its bounded build-time blur placeholder.
    ImageInfo { input: PathBuf },
    /// Serve a production build. Run the npm `rustyx build` command first.
    Start {
        #[arg(default_value = ".")]
        root: PathBuf,
        #[arg(long, default_value = "127.0.0.1")]
        hostname: String,
        #[arg(short, long, default_value_t = 3000)]
        port: u16,
        #[arg(long, default_value_t = 1)]
        workers: usize,
        /// Override the render worker (defaults to <root>/.rustyx/runtime/worker.mjs).
        #[arg(long)]
        worker: Option<PathBuf>,
        /// Node.js executable used for npm-compatible dynamic rendering.
        #[arg(long, default_value = "node")]
        node: PathBuf,
    },
    /// Display the routes in a built application.
    Routes {
        #[arg(default_value = ".")]
        root: PathBuf,
    },
}

fn main() -> Result<()> {
    let command = Cli::parse().command;
    if let Command::ImageInfo { input } = &command {
        println!(
            "{}",
            serde_json::to_string(&rustyx::images::image_info(input)?)?
        );
        return Ok(());
    }
    let mut runtime = tokio::runtime::Builder::new_multi_thread();
    // I/O multiplexing is cheap; migrating every request across all host cores
    // costs more than it saves with one JS worker. Scale with the requested
    // workers, retaining Tokio's explicit environment override for native loads.
    if std::env::var_os("TOKIO_WORKER_THREADS").is_none() {
        let workers = match &command {
            Command::Start { workers, .. } => (*workers).max(1),
            _ => 1,
        };
        runtime.worker_threads(workers.min(std::thread::available_parallelism()?.get()));
    }
    runtime.enable_all().build()?.block_on(run(command))
}
async fn run(command: Command) -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "rustyx=info,tower_http=warn".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    match command {
        Command::ImageInfo { input } => {
            println!(
                "{}",
                serde_json::to_string(&rustyx::images::image_info(&input)?)?
            );
            Ok(())
        }
        Command::Start {
            root,
            hostname,
            port,
            workers,
            worker,
            node,
        } => {
            let dist = rustyx::build_directory::resolve(&root).await?;
            let worker = worker.unwrap_or_else(|| dist.join("runtime/worker.mjs"));
            let worker = if worker.is_relative() {
                std::env::current_dir()?.join(worker)
            } else {
                worker
            };
            start(ServerConfig {
                root,
                hostname,
                port,
                workers,
                worker,
                node,
            })
            .await
        }
        Command::Routes { root } => {
            let manifest = Manifest::load(&rustyx::build_directory::resolve(&root).await?).await?;
            for route in manifest.routes {
                let kind = match route.kind {
                    rustyx::manifest::RouteKind::Page => "page",
                    rustyx::manifest::RouteKind::Api => "api ",
                };
                println!("{kind}  {}", route.pattern);
            }
            println!("{} prerendered page(s)", manifest.prerendered.len());
            Ok(())
        }
    }
}
