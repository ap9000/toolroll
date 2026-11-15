//! Keeping the session's secrets out of crash dumps, before there are any to keep.
//!
//! The one-time link (descriptor 3) becomes a session cookie, a form token and a mutation key held in this process's
//! memory, and the release build aborts on panic (Cargo.toml `panic = "abort"`), so a crash would write a core file
//! holding them wherever the system keeps those. Before descriptor 3 is read:
//! - the core-file size limit is set to 0 (soft and hard) on every platform, so no core file is written;
//! - on Linux the process is also marked not dumpable (`PR_SET_DUMPABLE` 0), which also refuses core files to a
//!   system-wide `core_pattern` pipe handler and other users' ptrace/`/proc/<pid>/mem` reads;
//! - if either can't be set, nothing is read: the binary exits with EXIT_UNPROTECTED, saying why, and the launcher
//!   (src/tui-launch.ts) opens the classic screen. Under the launcher the link is written only after this binary says
//!   it is protected (one line on the control descriptor), so a binary that can't protect itself is never sent one.
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
    Ok(())
}

/// Whether this process is protected now: the core limit is 0 (and, on Linux, it isn't dumpable).
pub fn protected_now() -> bool {
    let mut now = libc::rlimit {
        rlim_cur: 1,
        rlim_max: 1,
    };
    // SAFETY: getrlimit writes into the struct passed.
    let core_off =
        unsafe { libc::getrlimit(libc::RLIMIT_CORE, &mut now) } == 0 && now.rlim_cur == 0;
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
    }
}
