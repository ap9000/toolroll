//! Leaving the workbench gives the terminal back on a fresh line (stranger 17): whatever comes next — the launcher's
//! "Stopping Toolroll…", "Session ended: run toolroll again." — starts at the left edge of its own row, never glued
//! after what the screen held before it opened. The real binary in a real pseudo-terminal against the fake console.
#![cfg(unix)]
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use toolroll_fake_engine as fake;

const BIN: &str = env!("CARGO_BIN_EXE_toolroll-tui");

fn wait_for(screen: &Arc<Mutex<vt100::Parser>>, what: &str, secs: u64) -> String {
    let until = Instant::now() + Duration::from_secs(secs);
    loop {
        let shown = screen.lock().unwrap().screen().contents();
        if shown.contains(what) {
            return shown;
        }
        assert!(
            Instant::now() < until,
            "the screen never showed {what:?}:\n{shown}"
        );
        std::thread::sleep(Duration::from_millis(10)); // guard: bound poll interval; waits on the screen's text
    }
}

#[test]
fn what_follows_the_workbench_starts_on_a_fresh_line() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let engine = rt.block_on(fake::FakeEngine::start(fake::scenario(), 0));
    let scratch = std::env::temp_dir().join(format!("toolroll-exit-pty-{}", std::process::id()));
    std::fs::create_dir_all(&scratch).unwrap();
    let link_file = scratch.join("link");
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&link_file)
            .unwrap();
        writeln!(f, "{}", engine.link()).unwrap();
    }
    let (rows, cols) = (30u16, 100u16);
    let pty = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    // Something left mid-row before the screen opens, and a line after it closes (as the launcher prints).
    let mut c = CommandBuilder::new("/bin/sh");
    c.args([
        "-c",
        "printf 'before, no newline'; \"$0\" \"$@\" 3<\"$TR_LINK_FILE\"; printf 'AFTER the screen\\n'",
    ]);
    c.arg(BIN);
    c.env_clear();
    c.env("PATH", "/usr/bin:/bin");
    c.env("TERM", "xterm-256color");
    c.env("TR_LINK_FILE", &link_file);
    let mut child = pty.slave.spawn_command(c).unwrap();
    drop(pty.slave);
    let mut reader = pty.master.try_clone_reader().unwrap();
    let mut writer = pty.master.take_writer().unwrap();
    let screen = Arc::new(Mutex::new(vt100::Parser::new(rows, cols, 0)));
    let s2 = screen.clone();
    let reading = std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => s2.lock().unwrap().process(&buf[..n]),
            }
        }
    });
    wait_for(&screen, "Add CSV export", 15);
    std::fs::remove_file(&link_file).unwrap();
    // Quit (nothing owned here: Ctrl-C leaves).
    writer.write_all(b"\x03").unwrap();
    writer.flush().unwrap();
    let shown = wait_for(&screen, "AFTER the screen", 10);
    let row = shown
        .lines()
        .find(|line| line.contains("AFTER the screen"))
        .unwrap();
    assert_eq!(row.trim_end(), "AFTER the screen", "{shown}");
    let deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() > deadline {
            child.kill().unwrap();
            panic!("the binary didn't quit");
        }
        std::thread::sleep(Duration::from_millis(20)); // guard: bound poll interval; waits on the child's exit
    }
    drop(writer);
    drop(pty.master);
    let _ = reading.join();
    let _ = std::fs::remove_dir_all(&scratch);
}
