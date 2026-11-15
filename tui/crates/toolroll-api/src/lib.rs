//! Toolroll's engine API, typed: the client the terminal workbench reads and acts through (src/contracts/engine-api.ts).
pub mod client;
pub mod models;
pub mod sse;
pub mod term;

pub use client::{check_hello, redeem, ActOutcome, ApiError, Client, LiveSignal};
pub use models::*;
pub use term::{TermEvent, TermSend};
