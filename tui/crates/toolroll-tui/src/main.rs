//! `toolroll-tui`: started by `toolroll` (src/tui-launch.ts), never by hand.
//!
//!   toolroll-tui --version                      this build and its engine contract (the launcher's self-check)
//!   toolroll-tui [--control-fd 4] [--owned] [--project <path>] [--stats-out <file>]
//!
//! Before anything secret exists, crash dumps are turned off (guard.rs); a binary that can't do that exits 43 and reads
//! nothing (`--version` checks it too, so the launcher never mints a link for it). With a control descriptor it then
//! says so there (one line), and only then does the launcher write the one-time sign-in link on file descriptor 3 (one
//! line, then end of file); it is redeemed at once and the session kept in memory only. Exit codes: 0 leave, 40 stop
//! the agents, 41 keep them in the background, 42 open the classic screen instead, 43 unprotected (classic screen), 1
//! the session ended, 2 started wrongly.
use std::io::{Read, Write};
use std::os::fd::FromRawFd;
use toolroll_tui::app::{EXIT_CLASSIC, EXIT_ENDED, EXIT_UNPROTECTED};
use toolroll_tui::guard;
use zeroize::Zeroizing;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

/// The link on descriptor 3: at most 1 KiB, one line, held in zeroizing memory.
fn read_link() -> Option<Zeroizing<String>> {
    // SAFETY: descriptor 3 is the launcher's pipe (or nothing: fstat says so and nothing is taken over).
    let open = unsafe { libc_fstat_ok(3) };
    if !open {
        return None;
    }
    let mut file = unsafe { std::fs::File::from_raw_fd(3) };
    let mut buf = Zeroizing::new(Vec::with_capacity(1024));
    let _ = (&mut file).take(1024).read_to_end(&mut buf);
    drop(file);
    let text = std::str::from_utf8(&buf).ok()?;
    let line = Zeroizing::new(text.lines().next()?.trim().to_string());
    (!line.is_empty()).then_some(line)
}

/// Whether a descriptor is open (fcntl F_GETFD), without taking it over.
unsafe fn libc_fstat_ok(fd: i32) -> bool {
    extern "C" {
        fn fcntl(fd: i32, cmd: i32, ...) -> i32;
    }
    const F_GETFD: i32 = 1;
    fcntl(fd, F_GETFD) != -1
}

fn main() {
    toolroll_tui::stats::started();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--version") {
        // The self-check proves the protection works here too: a binary that can't turn crash dumps off answers with
        // its reason and EXIT_UNPROTECTED, and the launcher mints nothing for it.
        if let Err(why) = guard::protect_from_dumps() {
            eprintln!("The terminal workbench {why}.");
            std::process::exit(EXIT_UNPROTECTED);
        }
        println!("{}", toolroll_tui::version_line());
        return;
    }
    let mut control = arg(&args, "--control-fd")
        .and_then(|n| n.parse::<i32>().ok())
        .filter(|n| *n > 2 && unsafe { libc_fstat_ok(*n) })
        .map(|n| unsafe { std::fs::File::from_raw_fd(n) });
    // Protect, say so, and only then read the link (guard::start keeps this order; its tests prove it).
    let started = guard::start(
        guard::protect_from_dumps,
        || {
            if let Some(c) = control.as_mut() {
                let _ = c
                    .write_all(guard::READY_LINE.as_bytes())
                    .and_then(|_| c.flush());
            }
        },
        read_link,
    );
    let link = match started {
        Err(guard::Startup::Unprotected(why)) => {
            eprintln!("The terminal workbench {why}, so it won't hold a sign-in. Opening the classic screen instead.");
            std::process::exit(EXIT_UNPROTECTED);
        }
        Ok(None) => {
            eprintln!("Start the terminal workbench with `toolroll`.");
            std::process::exit(2);
        }
        Ok(Some(link)) => link,
    };
    toolroll_tui::stats::mark("link_read");
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let code = rt.block_on(async move {
        let client = match toolroll_api::redeem(&link).await {
            Ok(c) => c,
            Err(e) => {
                eprintln!("The terminal workbench couldn't sign in: {e}.");
                return EXIT_CLASSIC;
            }
        };
        drop(link);
        toolroll_tui::stats::mark("signed_in");
        let hello = client.hello().await;
        toolroll_tui::stats::mark("hello_read");
        let fatal = match hello {
            Ok(hello) => toolroll_api::check_hello(&hello).err().map(|words| {
                (
                    format!("{words} Opening the classic screen instead."),
                    EXIT_CLASSIC,
                )
            }),
            Err(toolroll_api::ApiError::SessionEnded) => {
                Some(("Session ended: run toolroll again.".to_string(), EXIT_ENDED))
            }
            Err(e) => Some((
                format!("{e} Opening the classic screen instead."),
                EXIT_CLASSIC,
            )),
        };
        let opts = toolroll_tui::run::Options {
            owned: args.iter().any(|a| a == "--owned"),
            project: arg(&args, "--project"),
            control,
            stats_out: arg(&args, "--stats-out"),
            fatal,
        };
        match toolroll_tui::run::run(client, opts).await {
            Ok(code) => code,
            Err(e) => {
                eprintln!("The terminal workbench stopped: {e}.");
                EXIT_CLASSIC
            }
        }
    });
    if code == EXIT_ENDED {
        eprintln!("Session ended: run toolroll again.");
    }
    std::process::exit(code);
}
