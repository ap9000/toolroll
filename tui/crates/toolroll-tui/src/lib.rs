//! Toolroll's terminal workbench: a thin client of the local console. It renders and sends intents; every write is
//! the browser's own form POST through toolroll-api, and the session lives in memory only.
pub mod agents;
pub mod app;
pub mod bootstrap;
pub mod chat;
pub mod chat_providers;
pub mod editor;
pub mod guard;
pub mod keys;
pub mod link;
pub mod notify;
pub mod palette;
pub mod panes;
pub mod review;
pub mod run;
pub mod search;
pub mod settings;
pub mod sheet;
pub mod state;
pub mod stats;
pub mod syntax;
pub mod term;
pub mod text;
pub mod theme;
pub mod thread;
pub mod transcript;
pub mod view;
pub mod view_cli;
pub mod viewstate;

/// `--version`'s line, which the launcher's self-check reads (tui-launch.ts): this build and its engine contract.
pub fn version_line() -> String {
    format!(
        "toolroll-tui {} contract {}",
        env!("CARGO_PKG_VERSION"),
        toolroll_api::contract_digest()
    )
}
