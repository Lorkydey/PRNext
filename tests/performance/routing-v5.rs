//! Isolated mechanism benchmark, not end-to-end HTTP throughput.
//! Compile against already-built dependencies; no production source mutation.
#[path = "../../crates/prnext/src/routing.rs"]
mod routing;

use routing::{decode_path, Params, RoutePattern};
use std::{collections::HashMap, hint::black_box, time::Instant};

struct Entry { id: usize, pattern: String, compiled: RoutePattern }
struct Table { exact: HashMap<String, usize>, dynamic: Vec<Entry> }
impl Table {
    fn new(kind: &str, count: usize) -> (Self, Vec<(String, Vec<String>)>) {
        let mut table = Self { exact: HashMap::new(), dynamic: Vec::new() };
        let mut queries = Vec::new();
        for id in 0..count {
            let prefix = format!("/bucket-{id:04}");
            let (pattern, request) = match kind {
                "exact" => (prefix.clone(), prefix),
                "dynamic" => (format!("{prefix}/[id]"), format!("{prefix}/value-{id}")),
                "catchall" => (format!("{prefix}/[...parts]"), format!("{prefix}/one/two/three")),
                _ => unreachable!(),
            };
            let compiled = RoutePattern::parse(&pattern).unwrap();
            if let Some(path) = compiled.static_path() { table.exact.insert(path, id); }
            else { table.dynamic.push(Entry { id, pattern, compiled }); }
            let parts = decode_path(&request).unwrap();
            queries.push((request, parts));
        }
        // Same ordering and resolution algorithm as server.rs::RouteTable.
        table.dynamic.sort_by(|a,b| b.compiled.specificity.cmp(&a.compiled.specificity).then(a.pattern.cmp(&b.pattern)));
        (table, queries)
    }
    #[inline]
    fn resolve(&self, path: &str, parts: &[String]) -> Option<(usize, Params)> {
        if let Some(id) = self.exact.get(path) { return Some((*id, Params::new())); }
        self.dynamic.iter().find_map(|entry| entry.compiled.matches(parts).map(|params| (entry.id, params)))
    }
}

#[inline(never)]
fn repeated(table: &Table, path: &str, parts: &[String]) -> usize {
    let mut result = 0;
    for check in 0..7 {
        let selected = black_box(table).resolve(black_box(path), black_box(parts));
        let (id, params) = black_box(selected.as_ref().unwrap());
        result ^= black_box(id.wrapping_add(params.len()).wrapping_add(check));
    }
    result
}
#[inline(never)]
fn once(table: &Table, path: &str, parts: &[String]) -> usize {
    let selected = black_box(table).resolve(black_box(path), black_box(parts));
    let mut result = 0;
    for check in 0..7 {
        let (id, params) = black_box(selected.as_ref().unwrap());
        result ^= black_box(id.wrapping_add(params.len()).wrapping_add(check));
    }
    result
}
fn main() {
    for kind in ["exact", "dynamic", "catchall"] {
        for count in [1usize, 100, 1000] {
            let (table, queries) = Table::new(kind, count);
            let iterations = if kind == "exact" { 100_000 } else { (200_000 / count).max(count * 2) };
            for (path, parts) in &queries {
                assert_eq!(repeated(&table, path, parts), once(&table, path, parts));
            }
            for round in 0..5 {
                let order = if round % 2 == 0 { ["repeated7", "once"] } else { ["once", "repeated7"] };
                for (position, variant) in order.into_iter().enumerate() {
                    let run = if variant == "once" { once } else { repeated };
                    for index in 0..100 { let (path, parts) = &queries[index % count]; black_box(run(&table, path, parts)); }
                    let started = Instant::now();
                    let mut checksum = 0usize;
                    for index in 0..iterations {
                        let (path, parts) = &queries[index % count];
                        checksum = checksum.wrapping_add(black_box(run(&table, path, parts)));
                    }
                    let elapsed = started.elapsed().as_nanos();
                    black_box(checksum);
                    println!("{{\"kind\":\"{kind}\",\"routes\":{count},\"round\":{round},\"position\":{position},\"variant\":\"{variant}\",\"iterations\":{iterations},\"elapsedNs\":{elapsed},\"nsPerDecision\":{},\"checksPerDecision\":7,\"checksum\":{checksum}}}", elapsed as f64 / iterations as f64);
                }
            }
        }
    }
}
