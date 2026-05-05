//! Merge policy for incoming sidecar updates.
//!
//! Extracted from `src-tauri/src/settings.rs` so `mdviewer-core::sidecar`
//! can take the policy as a parameter without coupling to the desktop's
//! larger `Settings` struct. The desktop crate re-exports this enum via
//! `pub use mdviewer_core::auto_merge::AutoMergeMode;` so its existing
//! settings serde shape stays byte-identical.
//!
//! NOTE: This module deliberately omits the `ts_rs::TS` derive that the
//! desktop's settings file uses. `mdviewer-core` MUST stay platform-agnostic
//! and pull in zero TypeScript-codegen tooling. Desktop-side TypeScript
//! export is preserved by re-exporting from `src-tauri/src/settings.rs` —
//! the `Settings` struct that drives `npm run gen:types` continues to live
//! there with its own `ts_rs::TS` derive on the wrapping type.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutoMergeMode {
    Always,
    Ask,
    Manual,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pin the JSON shape of every variant — `snake_case` for `AutoMergeMode::Manual`,
    /// matching what the desktop's `settings.toml` writes today. If the
    /// `#[serde(rename_all = ...)]` attribute is dropped or changed, this
    /// fails before any consumer downstream sees a corrupt round trip.
    #[test]
    fn variants_serialize_as_snake_case() {
        assert_eq!(serde_json::to_string(&AutoMergeMode::Always).unwrap(), "\"always\"");
        assert_eq!(serde_json::to_string(&AutoMergeMode::Ask).unwrap(), "\"ask\"");
        assert_eq!(serde_json::to_string(&AutoMergeMode::Manual).unwrap(), "\"manual\"");
    }

    #[test]
    fn variants_deserialize_from_snake_case() {
        let always: AutoMergeMode = serde_json::from_str("\"always\"").unwrap();
        let ask: AutoMergeMode = serde_json::from_str("\"ask\"").unwrap();
        let manual: AutoMergeMode = serde_json::from_str("\"manual\"").unwrap();
        assert_eq!(always, AutoMergeMode::Always);
        assert_eq!(ask, AutoMergeMode::Ask);
        assert_eq!(manual, AutoMergeMode::Manual);
    }

    #[test]
    fn round_trip_preserves_variant() {
        for mode in [
            AutoMergeMode::Always,
            AutoMergeMode::Ask,
            AutoMergeMode::Manual,
        ] {
            let s = serde_json::to_string(&mode).unwrap();
            let back: AutoMergeMode = serde_json::from_str(&s).unwrap();
            assert_eq!(mode, back);
        }
    }
}
