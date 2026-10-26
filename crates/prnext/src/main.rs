use anyhow::Result;
use clap::{Parser, Subcommand};
use prnext::{
    manifest::Manifest,
    server::{start, ServerConfig},
};
use std::path::PathBuf;

#[cfg(windows)]
mod windows_process;

#[derive(Parser)]
#[command(
    name = "prnext",
    version,
    about = "PRNext native HTTP server for React applications"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    #[command(hide = true)]
    DevSpare {
        root: PathBuf,
        #[arg(long)]
        node: PathBuf,
        #[arg(long)]
        script: PathBuf,
    },
    /// Private development listener; controlled by the parent CLI over stdio.
    #[command(hide = true)]
    DevGateway {
        root: PathBuf,
        #[arg(long, default_value = "127.0.0.1")]
        hostname: String,
        #[arg(long, default_value_t = 3000)]
        port: u16,
    },
    /// Private HTTP proxy controlled through the persistent manager's stdio.
    #[command(hide = true)]
    PersistentProxy,
    /// Host multiple built applications with isolated, idle process trees.
    Host {
        #[arg(default_value = "prnext.host.json")]
        config: PathBuf,
        #[arg(long, default_value = "node")]
        node: PathBuf,
        #[arg(long, hide = true)]
        shutdown_on_stdin_eof: bool,
        #[arg(long)]
        check: bool,
    },
    /// Inspect a static image and produce its bounded build-time blur placeholder.
    ImageInfo { input: PathBuf },
    /// Serve a production build. Run the npm `prnext build` command first.
    Start {
        #[arg(default_value = ".")]
        root: PathBuf,
        /// Pin a production build inside the project for a supervised generation.
        #[arg(long, hide = true)]
        build_dir: Option<String>,
        #[arg(long, default_value = "127.0.0.1")]
        hostname: String,
        #[arg(short, long, default_value_t = 3000)]
        port: u16,
        #[arg(long, default_value_t = 1)]
        workers: usize,
        /// Production policy (default: balanced, unless set by a profile environment variable).
        #[arg(long, value_parser = clap::builder::PossibleValuesParser::new(
            prnext::profile::NAMES.map(|name| {
                let value = clap::builder::PossibleValue::new(name)
                    .hide(!prnext::profile::PRIMARY_NAMES.contains(&name));
                if name == "classic" { value.alias("standard") } else { value }
            })
        ))]
        profile: Option<String>,
        /// Host idle timeout in seconds; 0 keeps used hosts alive.
        #[arg(long)]
        worker_idle_seconds: Option<u64>,
        /// Extra lane idle timeout in seconds; 0 disables early lane retirement.
        #[arg(long)]
        lane_idle_seconds: Option<u64>,
        /// Retain one warm lane per used host (true/false); no eager rendering.
        #[arg(long, num_args = 0..=1, default_missing_value = "true")]
        keep_warm: Option<bool>,
        /// Override the render worker (defaults to <root>/.prnext/runtime/worker.mjs).
        #[arg(long)]
        worker: Option<PathBuf>,
        /// Node.js executable used for npm-compatible dynamic rendering.
        #[arg(long, default_value = "node")]
        node: PathBuf,
        /// Stop when the parent CLI closes its stdin pipe.
        #[arg(long, hide = true)]
        shutdown_on_stdin_eof: bool,
        /// Internal host retirement allowance; the host owns its global deadline.
        #[arg(long, hide = true, default_value_t = 30, value_parser = clap::value_parser!(u64).range(1..=300))]
        shutdown_grace_seconds: u64,
        /// Native lifecycle required by the Linux CLI exec handoff.
        #[arg(long, hide = true)]
        cli_exec: bool,
    },
    /// Display the routes in a built application.
    Routes {
        #[arg(default_value = ".")]
        root: PathBuf,
    },
}

fn main() -> Result<()> {
    let command = Cli::parse().command;
    #[cfg(windows)]
    if matches!(
        &command,
        Command::Host { .. } | Command::DevGateway { .. } | Command::DevSpare { .. }
    ) {
        windows_process::contain_workers()?;
    }
    if let Command::Start { profile, .. } = &command {
        #[cfg(windows)]
        windows_process::contain_workers()?;
        let selected = prnext::profile::Profile::resolve(
            profile.as_deref(),
            std::env::var("PRNEXT_PROFILE").ok().as_deref(),
            std::env::var("PRNEXT_MEMORY_PROFILE").ok().as_deref(),
        )?;
        // Establish the inherited policy before starting any runtime threads.
        std::env::set_var("PRNEXT_PROFILE", selected.name());
    }
    if let Command::ImageInfo { input } = &command {
        println!(
            "{}",
            serde_json::to_string(&prnext::images::image_info(input)?)?
        );
        return Ok(());
    }
    let mut runtime = tokio::runtime::Builder::new_multi_thread();
    let requested_workers = match &command {
        Command::Start { workers, .. } => (*workers).max(1),
        _ => 1,
    };
    let runtime_workers = match std::env::var("TOKIO_WORKER_THREADS") {
        Ok(value) => value
            .parse::<usize>()
            .ok()
            .filter(|n| *n > 0)
            .ok_or_else(|| anyhow::anyhow!("TOKIO_WORKER_THREADS must be a positive integer"))?,
        Err(_) => requested_workers.min(std::thread::available_parallelism()?.get()),
    };
    // Windows available_parallelism does not reliably reflect Job Object CPU
    // limits. Size server I/O from the selected runtime/render concurrency.
    // The multi-app supervisor retains Tokio's default: its long-lived child
    // stdout readers are not a static-file workload and can occupy many slots.
    if matches!(command, Command::Start { .. }) {
        runtime.max_blocking_threads(
            runtime_workers
                .max(requested_workers)
                .saturating_mul(4)
                .clamp(4, 256),
        );
        if let Ok(value) = std::env::var("PRNEXT_BLOCKING_THREADS") {
            let threads: usize = value.parse().map_err(|_| {
                anyhow::anyhow!("PRNEXT_BLOCKING_THREADS must be an integer between 1 and 1024")
            })?;
            anyhow::ensure!(
                (1..=1024).contains(&threads),
                "PRNEXT_BLOCKING_THREADS must be between 1 and 1024"
            );
            runtime.max_blocking_threads(threads);
        }
    }
    // I/O multiplexing is cheap; migrating every request across all host cores
    // costs more than it saves with one JS worker. Scale with the requested
    // workers, retaining Tokio's explicit environment override for native loads.
    runtime.worker_threads(runtime_workers);
    runtime
        .on_thread_start(prnext::blocking::thread_start)
        .on_thread_stop(prnext::blocking::thread_stop);
    let runtime = runtime.enable_all().build()?;
    prnext::blocking::observe(runtime.metrics().num_workers());
    runtime.block_on(run(command))
}
async fn run(command: Command) -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "prnext=info,tower_http=warn".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    match command {
        Command::DevSpare { root, node, script } => {
            prnext::dev_spare::run(&root, &node, &script).await
        }
        Command::DevGateway {
            root,
            hostname,
            port,
        } => prnext::dev_gateway::run(&root, &hostname, port).await,
        Command::PersistentProxy => prnext::persistent_proxy::run().await,
        Command::Host {
            config,
            node,
            shutdown_on_stdin_eof,
            check,
        } => {
            if check {
                let checked = prnext::hosting::HostConfig::load(&config).await?;
                println!(
                    "Hosting configuration valid: {} applications",
                    checked.apps.len()
                );
                Ok(())
            } else {
                prnext::hosting::start(config, node, shutdown_on_stdin_eof).await
            }
        }
        Command::ImageInfo { input } => {
            println!(
                "{}",
                serde_json::to_string(&prnext::images::image_info(&input)?)?
            );
            Ok(())
        }
        Command::Start {
            root,
            build_dir,
            hostname,
            port,
            workers,
            profile: _,
            worker_idle_seconds,
            lane_idle_seconds,
            keep_warm,
            worker,
            node,
            shutdown_on_stdin_eof,
            shutdown_grace_seconds,
            cli_exec,
        } => {
            anyhow::ensure!(
                !cli_exec || cfg!(target_os = "linux"),
                "CLI exec handoff requires Linux worker containment"
            );
            let dist =
                prnext::build_directory::resolve_selected(&root, build_dir.as_deref()).await?;
            let worker = worker.unwrap_or_else(|| dist.join("runtime/worker.mjs"));
            let worker = if worker.is_relative() {
                std::env::current_dir()?.join(worker)
            } else {
                worker
            };
            start(ServerConfig {
                root,
                build_dir,
                hostname,
                port,
                workers,
                retirement: prnext::retirement::Overrides {
                    idle_seconds: worker_idle_seconds,
                    lane_idle_seconds,
                    keep_warm,
                },
                worker,
                node,
                shutdown_on_stdin_eof,
                shutdown_grace: std::time::Duration::from_secs(shutdown_grace_seconds),
            })
            .await
        }
        Command::Routes { root } => {
            let manifest = Manifest::load(&prnext::build_directory::resolve(&root).await?).await?;
            for route in manifest.routes {
                let kind = match route.kind {
                    prnext::manifest::RouteKind::Page => "page",
                    prnext::manifest::RouteKind::Api => "api ",
                };
                println!("{kind}  {}", route.pattern);
            }
            println!("{} prerendered page(s)", manifest.prerendered.len());
            Ok(())
        }
    }
}
