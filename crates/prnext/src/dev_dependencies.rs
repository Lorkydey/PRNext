//! Bounded interned reverse dependencies with atomic batched publication.
use anyhow::{ensure, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
const MAX_FILES: usize = 100_000;
const MAX_RECORDS: usize = 50_000;
const MAX_EDGES: usize = 1_000_000;
const MAX_BYTES: usize = 16 * 1024 * 1024;
#[derive(Deserialize)]
pub(crate) struct RouteDependencies {
    route: String,
    files: Vec<String>,
    #[serde(default)]
    module: bool,
}
#[derive(Deserialize)]
pub(crate) struct CompactDependencies {
    route: String,
    files: Vec<usize>,
    #[serde(default)]
    module: bool,
}
#[derive(Default)]
struct Graph {
    files: HashMap<String, usize>,
    targets: Vec<(String, bool)>,
    reverse: Vec<Vec<usize>>,
}
struct Transfer {
    id: String,
    expected: (usize, usize, usize),
    records: usize,
    edges: usize,
    bytes: usize,
    targets: HashMap<(String, bool), usize>,
    graph: Graph,
}
#[derive(Default)]
pub(crate) struct DependencyIndex {
    graph: Graph,
    transfer: Option<Transfer>,
}
fn valid_file(file: &str) -> bool {
    !file.is_empty()
        && file.len() <= 2048
        && !file.contains(['\\', ':', '\0'])
        && file
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}
impl Transfer {
    fn files(&mut self, files: Vec<String>) -> Result<()> {
        ensure!(
            self.graph.files.len() + files.len() <= self.expected.0,
            "Too many development files"
        );
        for file in files {
            ensure!(
                valid_file(&file) && !self.graph.files.contains_key(&file),
                "Invalid or duplicate development file"
            );
            self.bytes += file.len() + 64;
            ensure!(
                self.bytes <= MAX_BYTES,
                "Development graph memory budget exceeded"
            );
            let id = self.graph.reverse.len();
            self.graph.files.insert(file, id);
            self.graph.reverse.push(Vec::new());
        }
        Ok(())
    }
    fn records(&mut self, records: Vec<CompactDependencies>) -> Result<()> {
        ensure!(
            self.records + records.len() <= self.expected.1,
            "Too many development records"
        );
        for record in records {
            ensure!(
                if record.module {
                    valid_file(&record.route)
                } else {
                    record.route.starts_with('/')
                        && record.route.len() <= 1024
                        && !record.route.contains(['\0', '\r', '\n'])
                },
                "Invalid development route"
            );
            self.edges += record.files.len();
            self.bytes += record.files.len() * std::mem::size_of::<usize>();
            ensure!(
                self.edges <= self.expected.2 && self.bytes <= MAX_BYTES,
                "Development graph edge or memory budget exceeded"
            );
            let key = (record.route, record.module);
            let target = if let Some(id) = self.targets.get(&key) {
                *id
            } else {
                self.bytes += key.0.len() * 2 + 64;
                ensure!(
                    self.bytes <= MAX_BYTES,
                    "Development graph memory budget exceeded"
                );
                let id = self.graph.targets.len();
                self.graph.targets.push(key.clone());
                self.targets.insert(key, id);
                id
            };
            for file in record.files {
                self.graph
                    .reverse
                    .get_mut(file)
                    .ok_or_else(|| anyhow::anyhow!("Invalid development file ID"))?
                    .push(target);
            }
            self.records += 1;
        }
        Ok(())
    }
}
impl DependencyIndex {
    pub(crate) fn begin(
        &mut self,
        id: String,
        files: usize,
        records: usize,
        edges: usize,
    ) -> Result<()> {
        ensure!(
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
            "Invalid graph transaction"
        );
        ensure!(
            files <= MAX_FILES && records <= MAX_RECORDS && edges <= MAX_EDGES,
            "Development graph capacity exceeded"
        );
        self.transfer = Some(Transfer {
            id,
            expected: (files, records, edges),
            records: 0,
            edges: 0,
            bytes: 0,
            targets: HashMap::new(),
            graph: Graph::default(),
        });
        Ok(())
    }
    fn pending(&mut self, id: &str) -> Result<&mut Transfer> {
        self.transfer
            .as_mut()
            .filter(|t| t.id == id)
            .ok_or_else(|| anyhow::anyhow!("Unknown graph transaction"))
    }
    pub(crate) fn files(&mut self, id: &str, files: Vec<String>) -> Result<()> {
        let result = self.pending(id)?.files(files);
        if result.is_err() {
            self.abort(id);
        }
        result
    }
    pub(crate) fn records(&mut self, id: &str, records: Vec<CompactDependencies>) -> Result<()> {
        let result = self.pending(id)?.records(records);
        if result.is_err() {
            self.abort(id);
        }
        result
    }
    pub(crate) fn abort(&mut self, id: &str) {
        if self.transfer.as_ref().is_some_and(|t| t.id == id) {
            self.transfer = None;
        }
    }
    pub(crate) fn commit(&mut self, id: &str) -> Result<Value> {
        let pending = self.pending(id)?;
        ensure!(
            (pending.graph.files.len(), pending.records, pending.edges) == pending.expected,
            "Incomplete graph transaction"
        );
        let transfer = self.transfer.take().unwrap();
        let stats = json!({"files":transfer.expected.0,"records":transfer.records,"edges":transfer.edges,"bytes":transfer.bytes});
        self.graph = transfer.graph;
        Ok(stats)
    }
    pub(crate) fn replace(&mut self, routes: Vec<RouteDependencies>) -> Result<()> {
        let mut next = Self::default();
        let mut names = Vec::new();
        let mut ids = HashMap::new();
        let mut records = Vec::new();
        let mut edges = 0;
        ensure!(routes.len() <= MAX_RECORDS, "Too many development routes");
        for route in routes {
            let mut files = Vec::new();
            for file in route.files {
                let id = *ids.entry(file.clone()).or_insert_with(|| {
                    let id = names.len();
                    names.push(file);
                    id
                });
                files.push(id);
            }
            edges += files.len();
            records.push(CompactDependencies {
                route: route.route,
                module: route.module,
                files,
            });
        }
        next.begin("legacy".into(), names.len(), records.len(), edges)?;
        next.files("legacy", names)?;
        next.records("legacy", records)?;
        next.commit("legacy")?;
        self.graph = next.graph;
        self.transfer = None;
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn affected(&self, changed: &[String]) -> Result<Value> {
        self.lookup(changed, false)
    }
    pub(crate) fn lookup(&self, changed: &[String], transitive: bool) -> Result<Value> {
        ensure!(
            changed.len() <= 512 && changed.iter().all(|f| valid_file(f)),
            "Invalid development changes"
        );
        let mut routes = BTreeSet::new();
        let mut modules = BTreeSet::new();
        let mut unknown = Vec::new();
        let mut pending = VecDeque::new();
        let mut visited = HashSet::new();
        for file in changed {
            if let Some(id) = self.graph.files.get(file) {
                pending.push_back(*id);
            } else {
                unknown.push(file);
            }
        }
        while let Some(file) = pending.pop_front() {
            if !visited.insert(file) {
                continue;
            }
            for target in &self.graph.reverse[file] {
                let (name, module) = &self.graph.targets[*target];
                if *module {
                    if modules.insert(name) && transitive {
                        if let Some(id) = self.graph.files.get(name) {
                            pending.push_back(*id);
                        }
                    }
                } else {
                    routes.insert(name);
                }
            }
        }
        let mut value =
            json!({"routes":routes,"modules":modules,"unknown":unknown,"complete":true});
        if serde_json::to_vec(&value)?.len() > 512 * 1024 {
            value = json!({"routes":[],"modules":[],"unknown":unknown,"complete":false});
        }
        Ok(value)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replaces_without_stale_edges_and_preserves_unknown_changes() {
        let mut index = DependencyIndex::default();
        index.replace(serde_json::from_value(json!([{"route":"/a","files":["a.tsx","shared.ts"]},{"route":"/b","files":["b.tsx","shared.ts"]}])).unwrap()).unwrap();
        assert_eq!(
            index
                .affected(&["shared.ts".into(), "new.ts".into()])
                .unwrap(),
            json!({"routes":["/a","/b"],"modules":[],"unknown":["new.ts"],"complete":true})
        );
        index
            .replace(serde_json::from_value(json!([{"route":"/b","files":["b.tsx"]}])).unwrap())
            .unwrap();
        assert_eq!(
            index.affected(&["shared.ts".into()]).unwrap()["routes"],
            json!([])
        );
    }
    #[test]
    fn transactions_are_atomic_and_ids_validated() {
        let mut index = DependencyIndex::default();
        index
            .replace(serde_json::from_value(json!([{"route":"/old","files":["old.ts"]}])).unwrap())
            .unwrap();
        index.begin("test".into(), 1, 1, 1).unwrap();
        index.files("test", vec!["new.ts".into()]).unwrap();
        assert!(index.commit("test").is_err());
        assert_eq!(
            index.affected(&["old.ts".into()]).unwrap()["routes"],
            json!(["/old"])
        );
        assert!(index.records("wrong", vec![]).is_err());
        assert!(index
            .records(
                "test",
                vec![CompactDependencies {
                    route: "/".into(),
                    module: false,
                    files: vec![9]
                }]
            )
            .is_err());
        index.abort("test");
        assert!(index.commit("test").is_err());
        assert!(index
            .replace(serde_json::from_value(json!([{"route":"/","files":["../secret"]}])).unwrap())
            .is_err());
        assert_eq!(
            index.affected(&["old.ts".into()]).unwrap()["routes"],
            json!(["/old"])
        );
    }
    #[test]
    fn deep_cyclic_graph_is_interned_and_walked_once() {
        let mut records = Vec::new();
        for n in 0..100 {
            records.push(json!({"route":format!("m{n}.ts"),"module":true,"files":[format!("m{}.ts",(n+1)%100)]}));
        }
        records.push(json!({"route":"/page","files":["m70.ts"]}));
        let mut index = DependencyIndex::default();
        index
            .replace(serde_json::from_value(json!(records)).unwrap())
            .unwrap();
        let found = index.lookup(&["m0.ts".into()], true).unwrap();
        assert_eq!(found["routes"], json!(["/page"]));
        assert_eq!(found["modules"].as_array().unwrap().len(), 100);
        assert!(index.begin("large".into(), MAX_FILES + 1, 0, 0).is_err());
    }
}
