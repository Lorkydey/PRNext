#[cfg(feature = "mimalloc")]
#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

pub mod build_directory;
pub mod cache;
pub mod custom_routes;
pub mod dev;
pub mod i18n;
pub mod images;
pub mod manifest;
pub mod middleware;
pub mod pages;
pub mod pool;
pub mod proxy;
pub mod routing;
pub mod server;
