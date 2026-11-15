//! Keeping the session's secrets out of crash dumps, before there are any to keep.
//!
//! The one-time link (descriptor 3) becomes a session cookie, a form token and a mutation key held in this process's
//! memory, and the release build aborts on panic (Cargo.toml `panic = "abort"`), so a crash would write a core file
//! holding them wherever the system keeps those. Before descriptor 3 is read:
//! - the core-file size limit is set to 0 (soft and hard) on every platform, so no core file is written;
//! - on Linux the process is also marked not dumpable (`PR_SET_DUMPABLE` 0), which also refuses core files to a
//!   system-wide `core_pattern` pipe handler and other users' ptrace/`/proc/<pid>/mem` reads;
//! - every crash signal (SIGSEGV, SIGBUS, SIGILL, SIGTRAP, SIGFPE, SIGSYS, SIGABRT, and SIGEMT on macOS) gets a handler
//!   that ends the process at once with `_exit(128 + signal)`, on the alternate signal stack. A process that exits
//!   instead of dying of the signal raises no EXC_CRASH, so macOS's crash reporter (ReportCrash) is never told and writes
//!   no diagnostic report (those can carry register values); `panic = "abort"` raises SIGABRT and is caught the same
//!   way. (Setting the task's exception ports to MACH_PORT_NULL was considered and not used: the kernel then forwards
//!   the exception to the host-level port, where the crash reporter also listens, so it would not suppress anything.)
//! - if any of these can't be set, nothing is read: the binary exits with EXIT_UNPROTECTED, saying why, and the launcher
//!   (src/tui-launch.ts) opens the classic screen. Under the launcher the link is written only after this binary says
//!   it is protected (one line on the control descriptor), so a binary that can't protect itself is never sent one.
//!
//! The exact guarantee: no core files (every platform); no macOS crash report for a crash signal (the handlers above).
//! Residual: a fault inside the handler itself, a crash before this runs (nothing secret exists yet), SIGKILL and
//! out-of-memory kills (no dump is taken for those), macOS resource reports (EXC_RESOURCE/EXC_GUARD, which record
//! usage, not registers), and anyone already able to debug this user's processes (root, or this same user where the
//! system allows it).
//!
//! The secrets are also held in zeroizing types (toolroll-api's Creds, the link here) so memory reused after they are
//! dropped doesn't keep them; copies the HTTP stack makes on the way out (header values, request bodies) are its own
//! and aren't zeroized, which is why the dump protection above comes first.

/// The line the binary writes on the control descriptor once it is protected; only then does the launcher send the link.
pub const READY_LINE: &str = "{\"ready\":\"protected\"}\n";

/// Set the protection described above, or say why it couldn't be.
pub fn protect_from_dumps() -> Result<(), String> {
    let none = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: setrlimit reads the struct passed by reference; no memory is shared afterwards.
    if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &none) } != 0 {
        return Err(format!(
            "couldn't turn off crash dumps ({})",
            std::io::Error::last_os_error()
        ));
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        // SAFETY: prctl with PR_SET_DUMPABLE takes plain integers.
        if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
            return Err(format!(
                "couldn't mark itself not dumpable ({})",
                std::io::Error::last_os_error()
            ));
        }
    }
    for &signal in CRASH_SIGNALS {
        // SAFETY: a zeroed sigaction with a plain handler, an empty mask and SA_ONSTACK; the handler only calls _exit,
        // which is async-signal-safe.
        let installed = unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = exit_on_crash as extern "C" fn(libc::c_int) as libc::sighandler_t;
            action.sa_flags = libc::SA_ONSTACK;
            libc::sigemptyset(&mut action.sa_mask);
            libc::sigaction(signal, &action, std::ptr::null_mut())
        };
        if installed != 0 {
            return Err(format!(
                "couldn't keep crashes out of crash reports (signal {signal}: {})",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

/// The signals a crash dies of (the ones the system would turn into a core file or a crash report).
#[cfg(target_os = "macos")]
pub const CRASH_SIGNALS: &[libc::c_int] = &[
    libc::SIGSEGV,
    libc::SIGBUS,
    libc::SIGILL,
    libc::SIGTRAP,
    libc::SIGFPE,
    libc::SIGSYS,
    libc::SIGABRT,
    libc::SIGEMT,
];
#[cfg(not(target_os = "macos"))]
pub const CRASH_SIGNALS: &[libc::c_int] = &[
    libc::SIGSEGV,
    libc::SIGBUS,
    libc::SIGILL,
    libc::SIGTRAP,
    libc::SIGFPE,
    libc::SIGSYS,
    libc::SIGABRT,
];

/// End the process at once: an exit, not a death by signal, so no crash report is made.
extern "C" fn exit_on_crash(signal: libc::c_int) {
    // SAFETY: _exit is async-signal-safe and never returns.
    unsafe { libc::_exit(128 + signal) }
}

/// Whether every crash signal has this file's handler now.
pub fn crash_handlers_installed() -> bool {
    CRASH_SIGNALS.iter().all(|&signal| {
        // SAFETY: a query only (no new action); sigaction writes the current one into `now`.
        unsafe {
            let mut now: libc::sigaction = std::mem::zeroed();
            libc::sigaction(signal, std::ptr::null(), &mut now) == 0
                && now.sa_sigaction
                    == exit_on_crash as extern "C" fn(libc::c_int) as libc::sighandler_t
        }
    })
}

/// Whether this process is protected now: the core limit is 0 (and, on Linux, it isn't dumpable).
pub fn protected_now() -> bool {
    let mut now = libc::rlimit {
        rlim_cur: 1,
        rlim_max: 1,
    };
    // SAFETY: getrlimit writes into the struct passed.
    let core_off = unsafe { libc::getrlimit(libc::RLIMIT_CORE, &mut now) } == 0
        && now.rlim_cur == 0
        && crash_handlers_installed();
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        // SAFETY: PR_GET_DUMPABLE takes no pointers.
        core_off && unsafe { libc::prctl(libc::PR_GET_DUMPABLE, 0, 0, 0, 0) } == 0
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        core_off
    }
}

/// Why starting stopped before the link was read.
#[derive(Debug, PartialEq)]
pub enum Startup {
    /// The protection couldn't be set: the words, and nothing was read.
    Unprotected(String),
}

/// The start's order, kept in one place so it can be tested: protect, then say so (the control descriptor), and only
/// then read the link. A failed protection reads nothing and says nothing ready.
pub fn start<T>(
    protect: impl FnOnce() -> Result<(), String>,
    ready: impl FnOnce(),
    read: impl FnOnce() -> T,
) -> Result<T, Startup> {
    protect().map_err(Startup::Unprotected)?;
    ready();
    Ok(read())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn protection_comes_before_the_link_is_read() {
        let order = RefCell::new(Vec::new());
        let got = start(
            || {
                order.borrow_mut().push("protect");
                Ok(())
            },
            || order.borrow_mut().push("ready"),
            || {
                order.borrow_mut().push("read");
                7
            },
        );
        assert_eq!(got, Ok(7));
        assert_eq!(*order.borrow(), ["protect", "ready", "read"]);
    }

    #[test]
    fn a_failed_protection_reads_nothing_and_says_nothing_ready() {
        let order = RefCell::new(Vec::new());
        let got = start(
            || Err("couldn't turn off crash dumps (test)".to_string()),
            || order.borrow_mut().push("ready"),
            || order.borrow_mut().push("read"),
        );
        assert_eq!(
            got,
            Err(Startup::Unprotected(
                "couldn't turn off crash dumps (test)".into()
            ))
        );
        assert!(order.borrow().is_empty());
    }

    #[test]
    fn the_real_protection_turns_core_files_off() {
        // (In this test process: lowering its own core limit and dumpability is harmless.)
        protect_from_dumps().expect("protection");
        assert!(protected_now());
        assert!(crash_handlers_installed());
    }

    /// The crash itself, in a child process: protected, it raises SIGSEGV and SIGABRT and must EXIT (128 + signal), not
    /// die of the signal (dying of it is what makes a core file or a macOS crash report). Linux only: on macOS a failure
    /// here would leave a report in ~/Library/Logs/DiagnosticReports, so there the handlers are checked without a crash
    /// (crash_handlers_installed above).
    #[cfg(target_os = "linux")]
    #[test]
    fn a_crash_exits_instead_of_dying_of_the_signal() {
        use std::os::unix::process::ExitStatusExt;
        for signal in [libc::SIGSEGV, libc::SIGABRT] {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "guard::tests::crash_child", "--nocapture"])
                .env("TOOLROLL_GUARD_CRASH_CHILD", signal.to_string())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap();
            assert_eq!(status.signal(), None, "died of signal {signal}");
            assert_eq!(status.code(), Some(128 + signal));
        }
    }

    /// The child half of the test above (does nothing unless that test started it).
    #[cfg(target_os = "linux")]
    #[test]
    fn crash_child() {
        let Ok(signal) = std::env::var("TOOLROLL_GUARD_CRASH_CHILD") else {
            return;
        };
        protect_from_dumps().expect("protection");
        // SAFETY: raising a signal in this child process, on purpose.
        unsafe { libc::raise(signal.parse().unwrap()) };
        unreachable!("the handler exits");
    }
}
