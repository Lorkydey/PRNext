//! Named production policies. Share the preset table with the JS renderer;
//! no profile changes application caching semantics or caps the old generation.
use anyhow::{bail, Result};
use serde::Deserialize;
use std::{collections::BTreeMap, sync::OnceLock};

pub const NAMES: [&str; 5] = ["balanced", "speed", "memory", "classic", "compact"];
pub const PRIMARY_NAMES: [&str; 4] = ["balanced", "speed", "memory", "classic"];

#[derive(Clone, Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub optimize_for_size: bool,
    pub semi_space_mi_b: Option<usize>,
    pub young_generation_mi_b: usize,
    pub render_starts: usize,
    pub live_responses: usize,
    pub api_concurrency: usize,
    pub response_buffer_mi_b: usize,
    /// Release an inactive render host; active responses and tracked work drain first.
    pub render_idle_seconds: Option<u64>,
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

    pub fn settings(self) -> Settings {
        self.settings_for(crate::resources::Resources::detect())
    }

    pub fn settings_for(self, resources: crate::resources::Resources) -> Settings {
        static PRESETS: OnceLock<BTreeMap<String, Settings>> = OnceLock::new();
        let mut value = PRESETS.get_or_init(|| {
            serde_json::from_str(include_str!(
                "../../../packages/prnext/runtime/profiles.json"
            ))
            .expect("invalid embedded runtime profiles")
        })[self.0]
            .clone();
        if self.0 == "speed"
            && (resources.cpu_cores <= 1.0 || resources.memory_mib.is_some_and(|m| m <= 1024))
        {
            value.semi_space_mi_b = Some(4);
            value.young_generation_mi_b = 16;
            value.render_starts = 16;
            value.live_responses = 32;
            value.api_concurrency = 256;
            value.response_buffer_mi_b = 4;
        }
        if self.0 == "balanced" && resources.memory_mib.is_some_and(|m| m < 512) {
            value.semi_space_mi_b = Some(2);
            value.young_generation_mi_b = 8;
            value.render_starts = 8;
            value.live_responses = 16;
            value.api_concurrency = 128;
            value.response_buffer_mi_b = 2;
        }
        if self.0 == "memory" && resources.memory_mib.is_some_and(|m| m < 512) {
            value.render_starts = 4;
            value.live_responses = 12;
        }
        value
    }

    pub fn node_arguments(self, node_options: &str) -> Vec<String> {
        let settings = self.settings();
        let mut args = Vec::new();
        let explicit_semi_space = node_options.contains("--max-semi-space-size")
            || node_options.contains("--max_semi_space_size");
        // V8's optimize-for-size strongly implies a 1 MiB semi-space, even
        // when NODE_OPTIONS or the CLI supplies a different value. An operator
        // override must therefore opt out of that bundled size policy too.
        if settings.optimize_for_size && !explicit_semi_space {
            args.push("--optimize-for-size".into());
        }
        // Node CLI flags override NODE_OPTIONS, so leave explicit heap choices
        // to the operator, including Node's underscore spelling.
        if !explicit_semi_space {
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
    fn speed_is_bounded_by_cpu_and_memory_not_host_cpu_count() {
        let speed = Profile::resolve(Some("speed"), None, None).unwrap();
        for resources in [
            crate::resources::Resources {
                cpu_cores: 0.7,
                memory_mib: Some(24000),
            },
            crate::resources::Resources {
                cpu_cores: 8.0,
                memory_mib: Some(700),
            },
        ] {
            let settings = speed.settings_for(resources);
            assert_eq!(settings.semi_space_mi_b, Some(4));
            assert_eq!(settings.young_generation_mi_b, 16);
            assert_eq!(settings.live_responses, 32);
        }
        assert_eq!(
            speed
                .settings_for(crate::resources::Resources {
                    cpu_cores: 4.0,
                    memory_mib: Some(2048)
                })
                .semi_space_mi_b,
            Some(16)
        );
        let balanced = Profile::resolve(Some("balanced"), None, None)
            .unwrap()
            .settings_for(crate::resources::Resources {
                cpu_cores: 2.0,
                memory_mib: Some(384),
            });
        assert_eq!(balanced.live_responses, 16);
        assert_eq!(balanced.young_generation_mi_b, 8);
        let memory = Profile::resolve(Some("memory"), None, None)
            .unwrap()
            .settings_for(crate::resources::Resources {
                cpu_cores: 1.0,
                memory_mib: Some(384),
            });
        assert!(memory.live_responses < balanced.live_responses);
        assert!(memory.render_starts < balanced.render_starts);
    }

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
                    .all(|arg| !arg.contains("semi-space") && arg != "--optimize-for-size"));
            }
            assert_eq!(
                profile
                    .node_arguments("")
                    .contains(&"--optimize-for-size".into()),
                s.optimize_for_size,
            );
            assert!(profile
                .node_arguments("")
                .iter()
                .all(|arg| !arg.contains("old-space")));
        }
    }

    #[test]
    fn real_node_preserves_explicit_semi_space_in_size_profiles() {
        let node = std::env::var_os("PRNEXT_NODE_BINARY").unwrap_or_else(|| "node".into());
        for name in ["balanced", "memory", "compact"] {
            let profile = Profile::resolve(Some(name), None, None).unwrap();
            for option in ["--max-semi-space-size=8", "--max_semi_space_size=8"] {
                // PrintFlags exits before running JS; these are V8's values
                // after applying implications, not the requested argv values.
                let output = std::process::Command::new(&node)
                    .args(profile.node_arguments(option))
                    .args(["--print-flag-values", "-e", ""])
                    .env("NODE_OPTIONS", option)
                    .env_remove("NODE_V8_COVERAGE")
                    .output()
                    .expect("Node must be installed for the runtime profile regression test");
                assert!(output.status.success(), "{name}: {:?}", output);
                assert!(output.stderr.is_empty(), "{name}: {:?}", output);
                let stdout = String::from_utf8(output.stdout).unwrap();
                assert!(
                    stdout
                        .lines()
                        .any(|line| line.trim() == "--max-semi-space-size=8"),
                    "{name}: explicit nursery was overridden"
                );
                assert!(
                    stdout
                        .lines()
                        .any(|line| line.trim() == "--no-optimize-for-size"),
                    "{name}: bundled size policy remained active"
                );
                assert!(
                    stdout
                        .lines()
                        .any(|line| line.trim() == "--max-old-space-size=0"),
                    "{name}: unexpected old-generation cap"
                );
            }
        }
    }
}
