#[cfg(feature = "mimalloc")]
#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

pub mod build_directory;
pub mod build_output;
pub mod cache;
pub mod custom_routes;
pub mod dev;
mod dev_dependencies;
pub mod dev_gateway;
pub mod dev_spare;
pub mod diagnostics;
pub mod hosting;
pub mod i18n;
pub mod images;
pub mod io_admission;
pub mod manifest;
pub mod middleware;
mod net;
pub mod pages;
pub mod persistent_proxy;
pub mod pool;
pub mod profile;
pub mod proxy;
pub mod routing;
pub mod server;

pub mod blocking;
pub mod metrics;
mod request_budget;
pub mod retirement;
pub mod runtime_contract;
