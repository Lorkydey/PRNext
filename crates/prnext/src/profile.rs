//! Named production policies. Share the preset table with the JS renderer;
//! no profile changes application caching semantics or caps the old generation.
use anyhow::{bail, Result};
use serde::Deserialize;
use std::{collections::BTreeMap, sync::OnceLock};

pub const NAMES: [&str; 5] = ["balanced", "speed", "memory", "classic", "compact"];
pub const PRIMARY_NAMES: [&str; 4] = ["balanced", "speed", "memory", "classic"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub optimize_for_size: bool,
    pub semi_space_mi_b: Option<usize>,
    pub young_generation_mi_b: usize,
    pub render_starts: usize,
    pub live_responses: usize,
    pub api_concurrency: usize,
    pub response_buffer_mi_b: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Profile(&'static str);

impl Profile {
    pub fn resolve(
        explicit: Option<&str>,
        environment: Option<&str>,
        legacy: Option<&str>,
    ) -> Result<Self> {
        let name = explicit
            .or(environment.filter(|s| !s.is_empty()))
            .unwrap_or(if legacy == Some("compact") {
                "compact"
            } else {
                "balanced"
            });
        // Preserve existing scripts while exposing the historical policy as classic.
        let name = if name == "standard" { "classic" } else { name };
        let Some(name) = NAMES.into_iter().find(|allowed| *allowed == name) else {
            bail!("Unknown runtime profile {name:?}; use {}", NAMES.join(", "));
        };
        Ok(Self(name))
    }

    pub fn from_env() -> Result<Self> {
        let selected = Self::resolve(
            None,
            std::env::var("PRNEXT_PROFILE").ok().as_deref(),
            std::env::var("PRNEXT_MEMORY_PROFILE").ok().as_deref(),
        )?;
        Ok(
            if std::env::var("NODE_ENV").as_deref() == Ok("development") {
                Self("classic")
            } else {
                selected
            },
        )
    }

    pub fn name(self) -> &'static str {
        self.0
    }

    pub fn settings(self) -> &'static Settings {
        static PRESETS: OnceLock<BTreeMap<String, Settings>> = OnceLock::new();
        &PRESETS.get_or_init(|| {
            serde_json::from_str(include_str!(
                "../../../packages/prnext/runtime/profiles.json"
            ))
            .expect("invalid embedded runtime profiles")
        })[self.0]
    }

    pub fn node_arguments(self, node_options: &str) -> Vec<String> {
        let settings = self.settings();
        let mut args = Vec::new();
        if settings.optimize_for_size {
            args.push("--optimize-for-size".into());
        }
        // Node CLI flags override NODE_OPTIONS, so leave explicit heap choices
        // to the operator, including Node's underscore spelling.
        if !node_options.contains("--max-semi-space-size")
            && !node_options.contains("--max_semi_space_size")
        {
            if let Some(size) = settings.semi_space_mi_b {
                args.push(format!("--max-semi-space-size={size}"));
            }
        }
        args
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_then_environment_then_legacy_and_invalid_names_fail() {
        assert_eq!(
            Profile::resolve(Some("speed"), Some("memory"), Some("compact"))
                .unwrap()
                .name(),
            "speed"
        );
        assert_eq!(
            Profile::resolve(None, Some("standard"), Some("compact"))
                .unwrap()
                .name(),
            "classic"
        );
        assert_eq!(
            Profile::resolve(None, None, Some("compact"))
                .unwrap()
                .name(),
            "compact"
        );
        assert_eq!(
            Profile::resolve(None, None, None).unwrap().name(),
            "balanced"
        );
        assert_eq!(
            Profile::resolve(None, Some(""), None).unwrap().name(),
            "balanced"
        );
        assert_eq!(
            Profile::resolve(Some("standard"), Some("balanced"), None)
                .unwrap()
                .name(),
            "classic"
        );
        assert!(Profile::resolve(Some(""), None, None).is_err());
        assert!(Profile::resolve(None, Some("typo"), None).is_err());
        assert!(Profile::resolve(Some("cpu"), None, None).is_err());
        assert!(Profile::resolve(None, Some("cpu"), None).is_err());
    }

    #[test]
    fn all_presets_have_bounded_capacity_and_preserve_explicit_heap_options() {
        for name in NAMES {
            let profile = Profile::resolve(Some(name), None, None).unwrap();
            let s = profile.settings();
            assert!(
                s.render_starts > 0
                    && s.render_starts <= s.live_responses
                    && s.live_responses <= 512
            );
            assert!(s.api_concurrency > 0 && s.api_concurrency <= 512);
            assert!((1..=64).contains(&s.response_buffer_mi_b));
            assert!(s.young_generation_mi_b >= 4);
            for option in ["--max-semi-space-size=8", "--max_semi_space_size 8"] {
                assert!(profile
                    .node_arguments(option)
                    .iter()
                    .all(|arg| !arg.contains("semi-space")));
            }
            assert!(profile
                .node_arguments("")
                .iter()
                .all(|arg| !arg.contains("old-space")));
        }
    }
}
