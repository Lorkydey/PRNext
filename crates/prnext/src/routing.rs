use anyhow::{bail, Result};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Param {
    Single(String),
    Multiple(Vec<String>),
}

pub type Params = BTreeMap<String, Param>;

#[derive(Clone, Debug)]
enum Segment {
    Static(String),
    Dynamic(String),
    CatchAll(String),
    OptionalCatchAll(String),
}

#[derive(Clone, Debug)]
pub struct RoutePattern {
    segments: Vec<Segment>,
    pub specificity: Vec<u8>,
    pub shape: String,
}

/// Structural route index. Leaves retain the existing precedence rank; only
/// the winning pattern materializes request-owned parameter names and values.
#[derive(Default)]
pub struct RouteIndex {
    root: IndexNode,
}
#[derive(Default)]
struct IndexNode {
    literals: HashMap<String, IndexNode>,
    parameter: Option<Box<IndexNode>>,
    terminal: Option<usize>,
    catch_all: Option<usize>,
    optional: Option<usize>,
    first: Option<usize>,
    remainder: Vec<(RoutePattern, usize)>,
}
fn lowest(target: &mut Option<usize>, rank: usize) {
    if target.is_none_or(|value| rank < value) {
        *target = Some(rank);
    }
}
impl RouteIndex {
    pub fn insert(&mut self, pattern: &RoutePattern, rank: usize) {
        let mut node = &mut self.root;
        lowest(&mut node.first, rank);
        for (depth, segment) in pattern.segments.iter().enumerate() {
            // Bound trie depth and drop/lookup recursion even for a manually
            // supplied manifest containing exceptionally long route patterns.
            if depth == 64 {
                node.remainder.push((
                    RoutePattern {
                        segments: pattern.segments[depth..].to_vec(),
                        specificity: Vec::new(),
                        shape: String::new(),
                    },
                    rank,
                ));
                return;
            }
            match segment {
                Segment::Static(value) => node = node.literals.entry(value.clone()).or_default(),
                Segment::Dynamic(_) => node = node.parameter.get_or_insert_with(Default::default),
                Segment::CatchAll(_) => {
                    lowest(&mut node.catch_all, rank);
                    return;
                }
                Segment::OptionalCatchAll(_) => {
                    lowest(&mut node.optional, rank);
                    return;
                }
            }
            lowest(&mut node.first, rank);
        }
        lowest(&mut node.terminal, rank);
    }
    pub fn find(&self, parts: &[String]) -> Option<usize> {
        fn visit(node: &IndexNode, parts: &[String], best: &mut Option<usize>) {
            if node.first.is_none()
                || best.is_some_and(|best| node.first.is_some_and(|first| first >= best))
            {
                return;
            }
            for (pattern, rank) in &node.remainder {
                if best.is_none_or(|best| *rank < best) && pattern.matches(parts).is_some() {
                    lowest(best, *rank);
                }
            }
            if let Some(rank) = node.optional {
                lowest(best, rank);
            }
            if parts.is_empty() {
                if let Some(rank) = node.terminal {
                    lowest(best, rank);
                }
                return;
            }
            if let Some(rank) = node.catch_all {
                lowest(best, rank);
            }
            if let Some(child) = node.literals.get(&parts[0]) {
                visit(child, &parts[1..], best);
            }
            if let Some(child) = &node.parameter {
                visit(child, &parts[1..], best);
            }
        }
        let mut best = None;
        visit(&self.root, parts, &mut best);
        best
    }
}

impl RoutePattern {
    /// Construct an exact route key once at startup. Parameterized routes
    /// remain in the precedence-sorted matcher and never enter this index.
    pub fn static_path(&self) -> Option<String> {
        let mut path = String::new();
        for segment in &self.segments {
            let Segment::Static(value) = segment else {
                return None;
            };
            path.push('/');
            path.push_str(value);
        }
        if path.is_empty() {
            path.push('/');
        }
        Some(path)
    }

    pub fn parse(pattern: &str) -> Result<Self> {
        if !pattern.starts_with('/') || pattern.contains(['?', '#', '\\']) {
            bail!("invalid route pattern: {pattern}");
        }
        let parts: Vec<_> = pattern
            .trim_matches('/')
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();
        let mut names = HashSet::new();
        let mut segments = Vec::new();
        let mut specificity = Vec::new();
        let mut shapes = Vec::new();
        for (i, part) in parts.iter().enumerate() {
            let (segment, rank, shape) = if part.starts_with("[[...") && part.ends_with("]]") {
                let name = &part[5..part.len() - 2];
                validate_name(name, &mut names)?;
                if i + 1 != parts.len() {
                    bail!("catch-all must be the final route segment: {pattern}");
                }
                (
                    Segment::OptionalCatchAll(name.to_owned()),
                    0,
                    "[[...]]".to_owned(),
                )
            } else if part.starts_with("[...") && part.ends_with(']') {
                let name = &part[4..part.len() - 1];
                validate_name(name, &mut names)?;
                if i + 1 != parts.len() {
                    bail!("catch-all must be the final route segment: {pattern}");
                }
                (Segment::CatchAll(name.to_owned()), 1, "[...]".to_owned())
            } else if part.starts_with('[') && part.ends_with(']') {
                let name = &part[1..part.len() - 1];
                validate_name(name, &mut names)?;
                (Segment::Dynamic(name.to_owned()), 2, "[]".to_owned())
            } else {
                if part.contains(['[', ']']) || matches!(*part, "." | "..") {
                    bail!("invalid segment in {pattern}");
                }
                (Segment::Static((*part).to_owned()), 3, (*part).to_owned())
            };
            segments.push(segment);
            specificity.push(rank);
            shapes.push(shape);
        }
        // A complete match outranks an optional catch-all sharing the prefix.
        specificity.push(4);
        Ok(Self {
            segments,
            specificity,
            shape: format!("/{}", shapes.join("/")),
        })
    }

    pub fn matches(&self, parts: &[String]) -> Option<Params> {
        let mut params = Params::new();
        let mut cursor = 0;
        for segment in &self.segments {
            match segment {
                Segment::Static(value) => {
                    if parts.get(cursor)? != value {
                        return None;
                    }
                    cursor += 1;
                }
                Segment::Dynamic(name) => {
                    params.insert(name.clone(), Param::Single(parts.get(cursor)?.clone()));
                    cursor += 1;
                }
                Segment::CatchAll(name) => {
                    if cursor >= parts.len() {
                        return None;
                    }
                    params.insert(name.clone(), Param::Multiple(parts[cursor..].to_vec()));
                    cursor = parts.len();
                }
                Segment::OptionalCatchAll(name) => {
                    if cursor < parts.len() {
                        params.insert(name.clone(), Param::Multiple(parts[cursor..].to_vec()));
                    }
                    cursor = parts.len();
                }
            }
        }
        (cursor == parts.len()).then_some(params)
    }
}

fn validate_name(name: &str, names: &mut HashSet<String>) -> Result<()> {
    if name.is_empty() || name.contains(['[', ']', '/', '.']) || !names.insert(name.to_owned()) {
        bail!("invalid or duplicate route parameter: {name}");
    }
    Ok(())
}

/// Decode once, before routing and filesystem lookup. Encoded separators and dot
/// segments are rejected so the two lookup paths cannot interpret them differently.
pub fn decode_path(path: &str) -> Result<Vec<String>> {
    if !path.starts_with('/') || path.len() > 16 * 1024 {
        bail!("invalid path");
    }
    let mut parts = Vec::new();
    for raw in path.trim_matches('/').split('/').filter(|s| !s.is_empty()) {
        let bytes = raw.as_bytes();
        for (index, byte) in bytes.iter().enumerate() {
            if *byte == b'%'
                && (index + 2 >= bytes.len()
                    || !bytes[index + 1].is_ascii_hexdigit()
                    || !bytes[index + 2].is_ascii_hexdigit())
            {
                bail!("invalid path encoding");
            }
        }
        let part = percent_decode_str(raw).decode_utf8()?.into_owned();
        if part.contains(['/', '\\', '\0']) || matches!(part.as_str(), "." | "..") {
            bail!("invalid path segment");
        }
        parts.push(part);
    }
    Ok(parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_bounds_depth_without_changing_long_route_matches() {
        let prefix = "/literal".repeat(256);
        let patterns = [
            RoutePattern::parse(&format!("{prefix}/[id]")).unwrap(),
            RoutePattern::parse(&format!("{prefix}/[[...rest]]")).unwrap(),
        ];
        let mut index = RouteIndex::default();
        for (rank, pattern) in patterns.iter().enumerate() {
            index.insert(pattern, rank);
        }
        for path in [
            prefix.clone(),
            format!("{prefix}/value"),
            format!("{prefix}/value/tail"),
            "/missing".into(),
        ] {
            let parts = decode_path(&path).unwrap();
            assert_eq!(
                index.find(&parts),
                patterns.iter().position(|p| p.matches(&parts).is_some())
            );
        }
    }

    fn parts(path: &str) -> Vec<String> {
        decode_path(path).unwrap()
    }

    #[test]
    fn indexed_routing_preserves_precedence_and_parameter_ownership() {
        let mut patterns = vec![
            "/[lang]/shop/[id]",
            "/en/shop/[name]",
            "/en/[...tail]",
            "/[[...all]]",
            "/[lang]/shop/[[...rest]]",
            "/[a]/[b]/[c]/[d]",
        ]
        .into_iter()
        .map(|p| RoutePattern::parse(p).unwrap())
        .collect::<Vec<_>>();
        for n in 0..1500 {
            patterns.push(RoutePattern::parse(&format!("/catalog{n}/[item]/details")).unwrap());
        }
        patterns.sort_by(|a, b| b.specificity.cmp(&a.specificity));
        let mut index = RouteIndex::default();
        for (rank, p) in patterns.iter().enumerate() {
            index.insert(p, rank);
        }
        let mut paths = vec![
            "/".to_owned(),
            "/en/shop/42".into(),
            "/fr/shop/1".into(),
            "/en/shop".into(),
            "/en/other/x".into(),
            "/a/b/c/d".into(),
            "/missing/path".into(),
        ];
        for n in 0..1600 {
            paths.push(format!("/catalog{n}/test%20value/details"));
            paths.push(format!("/catalog{n}/test/unknown"));
        }
        for path in paths {
            let decoded = parts(&path);
            let old = patterns.iter().position(|p| p.matches(&decoded).is_some());
            assert_eq!(index.find(&decoded), old, "{path}");
        }
    }

    #[test]
    fn indexed_optional_and_required_catch_all_do_not_confuse_empty_tails() {
        let patterns =
            ["/a/[...tail]", "/a/[[...tail]]", "/[id]/b"].map(|p| RoutePattern::parse(p).unwrap());
        let mut index = RouteIndex::default();
        for (rank, p) in patterns.iter().enumerate() {
            index.insert(p, rank);
        }
        assert_eq!(index.find(&parts("/a")), Some(1));
        assert_eq!(index.find(&parts("/a/x")), Some(0));
        assert_eq!(index.find(&parts("/other/b")), Some(2));
        assert_eq!(index.find(&parts("/other")), None);
    }

    #[test]
    fn matches_dynamic_and_decodes_unicode() {
        let route = RoutePattern::parse("/posts/[id]").unwrap();
        assert_eq!(
            route.matches(&parts("/posts/caf%C3%A9/")),
            Some(BTreeMap::from([(
                "id".into(),
                Param::Single("café".into())
            )]))
        );
        assert!(route.matches(&parts("/posts")).is_none());
        assert!(route.matches(&parts("/posts/a/b")).is_none());
    }

    #[test]
    fn catch_all_is_array_and_optional_absent_is_omitted() {
        let route = RoutePattern::parse("/docs/[...slug]").unwrap();
        assert_eq!(
            route.matches(&parts("/docs/a/b")).unwrap()["slug"],
            Param::Multiple(vec!["a".into(), "b".into()])
        );
        assert!(route.matches(&parts("/docs")).is_none());
        assert_eq!(
            RoutePattern::parse("/docs/[[...slug]]")
                .unwrap()
                .matches(&parts("/docs")),
            Some(Params::new())
        );
    }

    #[test]
    fn ordering_prefers_static_then_dynamic_then_catch_all() {
        let mut routes = [
            "/docs/[[...slug]]",
            "/[...slug]",
            "/[id]",
            "/docs/[id]",
            "/docs",
        ]
        .map(|p| (p, RoutePattern::parse(p).unwrap()));
        routes.sort_by(|a, b| b.1.specificity.cmp(&a.1.specificity));
        let selected = routes
            .iter()
            .find(|(_, r)| r.matches(&parts("/docs")).is_some())
            .unwrap();
        assert_eq!(selected.0, "/docs");
        let selected = routes
            .iter()
            .find(|(_, r)| r.matches(&parts("/docs/intro")).is_some())
            .unwrap();
        assert_eq!(selected.0, "/docs/[id]");
        let selected = routes
            .iter()
            .find(|(_, r)| r.matches(&parts("/other")).is_some())
            .unwrap();
        assert_eq!(selected.0, "/[id]");
    }

    #[test]
    fn rejects_invalid_patterns_and_unsafe_paths() {
        for pattern in [
            "/a/[...slug]/b",
            "/a/[id]/[id]",
            "/a/[]",
            "/a/[broken",
            "/../a",
        ] {
            assert!(RoutePattern::parse(pattern).is_err(), "{pattern}");
        }
        for path in [
            "/../secret",
            "/%2e%2e/secret",
            "/foo%2fbar",
            "/foo%5cbar",
            "/%00",
            "/%zz",
            "/%ff",
        ] {
            assert!(decode_path(path).is_err(), "{path}");
        }
    }
}
