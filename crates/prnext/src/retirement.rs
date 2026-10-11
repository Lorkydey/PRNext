use anyhow::{bail, Result};
use serde::Deserialize;
use std::time::Duration;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Overrides {
    pub idle_seconds: Option<u64>,
    pub lane_idle_seconds: Option<u64>,
    pub keep_warm: Option<bool>,
}
#[derive(Debug, PartialEq, Eq)]
pub struct Policy {
    pub host: Option<Duration>,
    pub lane: Option<Duration>,
}
impl Overrides {
    pub fn from_env() -> Result<Self> {
        fn seconds(name: &str) -> Result<Option<u64>> {
            std::env::var(name).ok().map(|value| {
                if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                    bail!("{name} must be an integer between 0 and 604800 seconds (0 disables retirement)");
                }
                Ok(value.parse()?)
            }).transpose()
        }
        let keep_warm = std::env::var("PRNEXT_KEEP_WARM")
            .ok()
            .map(|value| match value.as_str() {
                "true" | "1" => Ok(true),
                "false" | "0" => Ok(false),
                _ => {
                    bail!("PRNEXT_KEEP_WARM must be true, false, 1 or 0")
                }
            })
            .transpose()?;
        Ok(Self {
            idle_seconds: seconds("PRNEXT_WORKER_IDLE_SECONDS")?,
            lane_idle_seconds: seconds("PRNEXT_LANE_IDLE_SECONDS")?,
            keep_warm,
        })
    }
    pub fn resolve(profile: Option<u64>, config: &Self, env: &Self, cli: &Self) -> Result<Policy> {
        for value in [config, env, cli] {
            if value.idle_seconds.is_some_and(|s| s > 604800)
                || value.lane_idle_seconds.is_some_and(|s| s > 604800)
            {
                bail!("worker retirement must be between 0 and 604800 seconds (0 disables retirement)");
            }
        }
        let seconds = cli
            .idle_seconds
            .or(env.idle_seconds)
            .or(config.idle_seconds)
            .or(profile)
            .unwrap_or(0);
        let lane = cli
            .lane_idle_seconds
            .or(env.lane_idle_seconds)
            .or(config.lane_idle_seconds)
            .unwrap_or(30);
        let warm = cli
            .keep_warm
            .or(env.keep_warm)
            .or(config.keep_warm)
            .unwrap_or(false);
        Ok(Policy {
            host: (!warm && seconds != 0).then(|| Duration::from_secs(seconds)),
            lane: (lane != 0).then(|| Duration::from_secs(lane)),
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn precedence_disabling_and_warm_host() {
        let empty = Overrides::default();
        let config = Overrides {
            idle_seconds: Some(5),
            ..empty.clone()
        };
        let env = Overrides {
            idle_seconds: Some(8),
            ..empty.clone()
        };
        let cli = Overrides {
            idle_seconds: Some(9),
            ..empty.clone()
        };
        assert_eq!(
            Overrides::resolve(Some(300), &config, &env, &cli)
                .unwrap()
                .host,
            Some(Duration::from_secs(9))
        );
        assert_eq!(
            Overrides::resolve(Some(300), &config, &env, &empty)
                .unwrap()
                .host,
            Some(Duration::from_secs(8))
        );
        assert_eq!(
            Overrides::resolve(Some(300), &config, &empty, &empty)
                .unwrap()
                .host,
            Some(Duration::from_secs(5))
        );
        assert_eq!(
            Overrides::resolve(Some(300), &empty, &empty, &empty)
                .unwrap()
                .host,
            Some(Duration::from_secs(300))
        );
        let off = Overrides {
            idle_seconds: Some(0),
            lane_idle_seconds: Some(0),
            keep_warm: None,
        };
        assert_eq!(
            Overrides::resolve(Some(300), &empty, &empty, &off).unwrap(),
            Policy {
                host: None,
                lane: None
            }
        );
        let warm = Overrides {
            keep_warm: Some(true),
            ..empty.clone()
        };
        assert_eq!(
            Overrides::resolve(Some(30), &empty, &empty, &warm).unwrap(),
            Policy {
                host: None,
                lane: Some(Duration::from_secs(30))
            }
        );
        assert!(Overrides::resolve(
            None,
            &Overrides {
                idle_seconds: Some(604801),
                ..empty.clone()
            },
            &empty,
            &empty
        )
        .is_err());
    }
}
