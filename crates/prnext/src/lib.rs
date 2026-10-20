#[cfg(feature = "mimalloc")]
#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

pub mod build_directory;
pub mod build_output;
pub mod cache;
pub mod custom_routes;
pub mod dev;
pub mod diagnostics;
pub mod hosting;
pub mod i18n;
pub mod images;
pub mod io_admission;
pub mod manifest;
pub mod middleware;
pub mod pages;
pub mod pool;
pub mod profile;
pub mod proxy;
pub mod routing;
pub mod server;

pub mod blocking;
pub mod metrics;
pub mod retirement;
pub mod runtime_contract;
