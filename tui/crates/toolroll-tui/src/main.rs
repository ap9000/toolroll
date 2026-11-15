//! Toolroll terminal workbench — DE-RISK SPIKE binary (not the product).
//!
//! Subcommands:
//!   --version                         self-check line for the npm launcher
//!   bench   [--frames N] [--width W] [--height H] [--recording F] [--rate L]   TestBackend + escape-encoding bench
//!   run     [--recording F] [--rate L] [--auto-quit-secs S] [--stats-out F] [--trace-out F]
//!           [--term-url ws://..] [--term-origin O] [--engine-base http://127.0.0.1:PORT --link-stdin]
//!   engine  --base http://127.0.0.1:PORT [--secs S] [--term-id HEX]   (one-time link read from stdin)
//!   term-probe --url ws://.. --origin O [--input TEXT]
//!
//! Credentials (session cookie, CSRF, mutation key) live only in memory and are never printed.

mod app;
mod bench;
mod engine;
mod recording;
mod ring;
mod run;
mod stats;

use anyhow::{bail, Result};

pub const VERSION: &str = concat!("toolroll-tui ", env!("CARGO_PKG_VERSION"));

pub struct Args {
    rest: Vec<String>,
}

impl Args {
    pub fn value(&self, name: &str) -> Option<String> {
        let mut it = self.rest.iter();
        while let Some(a) = it.next() {
            if a == name {
                return it.next().cloned();
            }
        }
        None
    }
    pub fn flag(&self, name: &str) -> bool {
        self.rest.iter().any(|a| a == name)
    }
    pub fn num<T: std::str::FromStr>(&self, name: &str, default: T) -> T {
        self.value(name)
            .and_then(|v| v.parse().ok())
            .unwrap_or(default)
    }
}

fn main() -> Result<()> {
    let mut argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.is_empty() {
        argv.push("run".into());
    }
    let cmd = argv.remove(0);
    let args = Args { rest: argv };
    match cmd.as_str() {
        "--version" | "-V" | "version" => {
            println!("{VERSION}");
            Ok(())
        }
        "bench" => bench::main(&args),
        "run" => run::main(&args),
        "engine" => engine::main(&args),
        "term-probe" => engine::term_probe_main(&args),
        other => bail!("unknown command {other:?}"),
    }
}
