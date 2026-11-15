//! The real binary's start, as the launcher drives it: crash dumps are off and it says it is ready on the control
//! descriptor BEFORE anything is written on descriptor 3, and the self-check (`--version`) proves the same protection.
#![cfg(unix)]
use std::io::{BufRead, BufReader, Write};
use std::os::fd::{FromRawFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;
use toolroll_tui::app::EXIT_CLASSIC;
use toolroll_tui::guard::READY_LINE;

const BIN: &str = env!("CARGO_BIN_EXE_toolroll-tui");

#[test]
fn version_answers_only_once_protected() {
    let out = Command::new(BIN).arg("--version").output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).starts_with("toolroll-tui "));
}

#[test]
fn it_says_ready_before_the_link_is_written_and_reads_it_only_then() {
    let mut link = [0 as RawFd; 2];
    let mut control = [0 as RawFd; 2];
    // SAFETY: plain descriptor creation; each is owned below.
    unsafe {
        assert_eq!(libc::pipe(link.as_mut_ptr()), 0);
        assert_eq!(
            libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, control.as_mut_ptr()),
            0
        );
    }
    // Every descriptor moved above 100 and close-on-exec, so the child gets exactly the two it is given at 3 and 4
    // (and no number clashes with those two while they are placed).
    let high = |fd: RawFd| -> RawFd {
        // SAFETY: duplicates a descriptor this test owns, then closes the original.
        unsafe {
            let moved = libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 100);
            assert!(moved >= 100);
            libc::close(fd);
            moved
        }
    };
    let (link_read, link_write, ours, theirs) = (
        high(link[0]),
        high(link[1]),
        high(control[0]),
        high(control[1]),
    );
    let mut cmd = Command::new(BIN);
    cmd.args(["--control-fd", "4"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: only async-signal-safe calls (dup2) between fork and exec; dup2 clears close-on-exec on 3 and 4.
    unsafe {
        cmd.pre_exec(move || {
            if libc::dup2(link_read, 3) < 0 || libc::dup2(theirs, 4) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn().unwrap();
    // SAFETY: the child has its copies; these ends are the test's own.
    unsafe {
        libc::close(link_read);
        libc::close(theirs);
    }
    let mut link_end = unsafe { std::fs::File::from_raw_fd(link_write) };
    let control_end = unsafe { std::fs::File::from_raw_fd(ours) };
    // Nothing has been written on descriptor 3: the ready line arrives anyway (it didn't wait for the link).
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = BufReader::new(control_end).read_line(&mut line);
        let _ = tx.send(line);
    });
    let said = rx
        .recv_timeout(Duration::from_secs(10))
        .expect("no ready line");
    assert_eq!(said, READY_LINE);
    #[cfg(target_os = "linux")]
    {
        // While it waits for the link, its core limit is already 0.
        let limits = std::fs::read_to_string(format!("/proc/{}/limits", child.id())).unwrap();
        let core = limits
            .lines()
            .find(|l| l.starts_with("Max core file size"))
            .unwrap();
        assert!(core.split_whitespace().nth(4) == Some("0"), "{core}");
    }
    // Only now the link (here one that isn't: it signs nothing in, and the binary opens the classic screen).
    link_end.write_all(b"not a link\n").unwrap();
    drop(link_end);
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(EXIT_CLASSIC));
}
