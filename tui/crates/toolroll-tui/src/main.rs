//! `toolroll-tui`: started by `toolroll` (src/tui-launch.ts), never by hand.
//!
//!   toolroll-tui --version                      this build and its engine contract (the launcher's self-check)
//!   toolroll-tui [--control-fd 4] [--owned] [--project <path>] [--stats-out <file>]
//!
//! The one-time sign-in link arrives on file descriptor 3 (one line, then end of file); it is redeemed at once and the
//! session kept in memory only. Exit codes: 0 leave, 40 stop the agents, 41 keep them in the background, 42 open the
//! classic screen instead, 1 the session ended, 2 started wrongly.
use std::io::Read;
use std::os::fd::FromRawFd;
use toolroll_tui::app::{EXIT_CLASSIC, EXIT_ENDED};

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

/// The link on descriptor 3: at most 1 KiB, one line.
fn read_link() -> Option<String> {
    // SAFETY: descriptor 3 is the launcher's pipe (or nothing: fstat says so and nothing is taken over).
    let open = unsafe { libc_fstat_ok(3) };
    if !open {
        return None;
    }
    let mut file = unsafe { std::fs::File::from_raw_fd(3) };
    let mut buf = Vec::new();
    let _ = (&mut file).take(1024).read_to_end(&mut buf);
    drop(file);
    let text = String::from_utf8(buf).ok()?;
    let line = text.lines().next()?.trim().to_string();
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
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--version") {
        println!("{}", toolroll_tui::version_line());
        return;
    }
    let Some(link) = read_link() else {
        eprintln!("Start the terminal workbench with `toolroll`.");
        std::process::exit(2);
    };
    let control = arg(&args, "--control-fd")
        .and_then(|n| n.parse::<i32>().ok())
        .filter(|n| *n > 2 && unsafe { libc_fstat_ok(*n) })
        .map(|n| unsafe { std::fs::File::from_raw_fd(n) });
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
        let fatal = match client.hello().await {
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
