//! `FEATURES` is the source of truth and the operator config reference is a
//! hand-maintained mirror. This test keeps the published table in sync.

use xai_grok_shell::agent::config::FEATURES;

const CONFIG_REFERENCE: &str = include_str!("../docs/user-guide/26-config-reference.md");

#[test]
fn every_registered_feature_reaches_the_operator() {
    for spec in FEATURES {
        assert!(
            CONFIG_REFERENCE.contains(&format!("`features.{}`", spec.key)),
            "{} has no row in the config reference",
            spec.key,
        );
        assert!(
            CONFIG_REFERENCE.contains(&format!("`{}`", spec.env)),
            "{} is undocumented in the config reference",
            spec.env,
        );
    }
}
