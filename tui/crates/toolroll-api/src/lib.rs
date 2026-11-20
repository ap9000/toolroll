//! Toolroll's engine API, typed: the client the terminal workbench reads and acts through (src/contracts/engine-api.ts).
pub mod client;
pub mod connection;
pub mod models;
pub mod sse;
pub mod term;
pub mod task_builder;
pub use task_builder::{BuilderPicker, TaskBuilder};

pub use client::{
    check_hello, redeem, said_of, ActOutcome, ApiError, ChatSendOutcome, Client, LiveSignal,
    ProposalActOutcome,
};
pub use connection::{
    parse_connection_refusal, parse_disabled_connection, parse_disabled_metadata, ConnectionAccess,
    ConnectionBinding, ConnectionError, ConnectionRefusal, ConnectionRole, DisabledConnection,
    CONNECTION_PROTOCOL, MAX_CONNECTION_METADATA_BYTES,
};
pub use models::*;
pub use term::{Chunk, Held, TermEvent, TermSend, OUTPUT_BUDGET};
