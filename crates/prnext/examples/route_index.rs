//! Isolated lookup benchmark: cargo run --release --example route_index.
use prnext::routing::{decode_path, RouteIndex, RoutePattern};
use std::{hint::black_box, time::Instant};
fn main() {
    for count in [100, 1000, 10000] {
        let patterns = (0..count)
            .map(|i| RoutePattern::parse(&format!("/tenant-{i}/[id]/[[...rest]]")).unwrap())
            .collect::<Vec<_>>();
        let mut index = RouteIndex::default();
        for (rank, pattern) in patterns.iter().enumerate() {
            index.insert(pattern, rank);
        }
        let paths = (0..1000)
            .map(|i| decode_path(&format!("/tenant-{}/value/tail", i * 37 % count)).unwrap())
            .collect::<Vec<_>>();
        for parts in &paths {
            assert_eq!(
                index.find(parts),
                patterns.iter().position(|p| p.matches(parts).is_some())
            );
        }
        let iterations = 10000;
        let begin = Instant::now();
        for i in 0..iterations {
            black_box(
                patterns
                    .iter()
                    .position(|p| p.matches(black_box(&paths[i % paths.len()])).is_some()),
            );
        }
        let linear = begin.elapsed().as_nanos();
        let begin = Instant::now();
        for i in 0..iterations {
            let parts = black_box(&paths[i % paths.len()]);
            let rank = index.find(parts).unwrap();
            black_box(patterns[rank].matches(parts));
        }
        println!(
            "{}",
            serde_json::json!({"routes":count,"iterations":iterations,"linearNs":linear,"indexedNs":begin.elapsed().as_nanos()})
        );
    }
}
