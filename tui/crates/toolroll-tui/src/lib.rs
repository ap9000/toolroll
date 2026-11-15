//! Toolroll's terminal workbench: a thin client of the local console. It renders and sends intents; every write is
//! the browser's own form POST through toolroll-api, and the session lives in memory only.
pub mod app;
pub mod guard;
pub mod notify;
pub mod review;
pub mod run;
pub mod settings;
pub mod stats;
pub mod syntax;
pub mod term;
pub mod text;
pub mod theme;
pub mod transcript;
pub mod view;

/// `--version`'s line, which the launcher's self-check reads (tui-launch.ts): this build and its engine contract.
pub fn version_line() -> String {
    format!(
        "toolroll-tui {} contract {}",
        env!("CARGO_PKG_VERSION"),
        toolroll_api::contract_digest()
    )
}
