//! Toolroll's engine API, typed: the client the terminal workbench reads and acts through (src/contracts/engine-api.ts).
pub mod client;
pub mod models;
pub mod sse;
pub mod term;
pub mod task_builder;
pub use task_builder::TaskBuilder;

pub use client::{check_hello, redeem, said_of, ActOutcome, ApiError, Client, LiveSignal};
pub use models::*;
pub use term::{Chunk, Held, TermEvent, TermSend, OUTPUT_BUDGET};
