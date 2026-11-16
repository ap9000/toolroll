//! Take over (solo-workbench T4) with the real binary in a real pseudo-terminal against the fake console: `t` on the
//! result waiting starts the console's terminal on that build and attaches it over the console's socket; typing
//! reaches it (Ctrl-C too) and its echo comes back; the pane's size is sent; Ctrl-] comes back. The terminal outlives
//! the binary: a second run reattaches to it (listed, never started again) and shows the screen. What the program wrote
//! — clipboard writes, links, titles, notifications — never reaches the real terminal: every raw byte the binary wrote
//! is checked (the only links written are Toolroll's own, to the console's task page). The sign-in link reaches the binary on descriptor 3 from a 0600 file, removed once read.
#![cfg(unix)]
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use toolroll_fake_engine as fake;

const BIN: &str = env!("CARGO_BIN_EXE_toolroll-tui");
const HOSTILE: &str = concat!(
    "\x1b]52;c;ZXZpbC1jbGlwYm9hcmQ=\x07",
    "\x1b]8;;https://evil.example/x\x1b\\the docs\x1b]8;;\x1b\\ ",
    "\x1b]0;evil-title\x07",
    "\x1b]9;evil-notify\x07",
    "\x1b]777;notify;evil;body\x07",
    "\u{202e}gnp.txt\r\n"
);

struct Run {
    screen: Arc<Mutex<vt100::Parser>>,
    raw: Arc<Mutex<Vec<u8>>>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    reading: std::thread::JoinHandle<()>,
}

impl Run {
    fn start(engine: &fake::FakeEngine, scratch: &std::path::Path, rows: u16, cols: u16) -> Run {
        Run::start_with(engine, scratch, rows, cols, &[])
    }

    fn start_with(
        engine: &fake::FakeEngine,
        scratch: &std::path::Path,
        rows: u16,
        cols: u16,
        args: &[&str],
    ) -> Run {
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
        let pty = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut c = CommandBuilder::new("/bin/sh");
        c.args(["-c", "exec \"$0\" \"$@\" 3<\"$TR_LINK_FILE\""]);
        c.arg(BIN);
        c.args(args);
        // An environment of its own: no home, no colour setting, nothing of the person's.
        c.env_clear();
        c.env("PATH", "/usr/bin:/bin");
        c.env("TERM", "xterm-256color");
        c.env("TR_LINK_FILE", &link_file);
        let child = pty.slave.spawn_command(c).unwrap();
        drop(pty.slave);
        let mut reader = pty.master.try_clone_reader().unwrap();
        let writer = pty.master.take_writer().unwrap();
        let screen = Arc::new(Mutex::new(vt100::Parser::new(rows, cols, 0)));
        let raw = Arc::new(Mutex::new(Vec::new()));
        let (s2, r2) = (screen.clone(), raw.clone());
        let reading = std::thread::spawn(move || {
            let mut buf = [0u8; 65536];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        r2.lock().unwrap().extend_from_slice(&buf[..n]);
                        s2.lock().unwrap().process(&buf[..n]);
                    }
                }
            }
        });
        let run = Run {
            screen,
            raw,
            writer,
            child,
            master: pty.master,
            reading,
        };
        run.wait_for("Add CSV export", 15);
        std::fs::remove_file(&link_file).unwrap();
        run
    }

    fn wait_for(&self, what: &str, secs: u64) -> String {
        let until = Instant::now() + Duration::from_secs(secs);
        loop {
            let shown = self.screen.lock().unwrap().screen().contents();
            if shown.contains(what) {
                return shown;
            }
            assert!(
                Instant::now() < until,
                "the screen never showed {what:?}:\n{shown}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn press(&mut self, keys: &str) {
        self.writer.write_all(keys.as_bytes()).unwrap();
        self.writer.flush().unwrap();
        std::thread::sleep(Duration::from_millis(60));
    }

    /// Quit and wait for the exit (the binary is this test's own child; killed by its own handle only if it hangs).
    fn quit(mut self) -> Vec<u8> {
        self.press("q");
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success(), "{status:?}");
                break;
            }
            if Instant::now() > deadline {
                self.child.kill().unwrap();
                panic!("the binary didn't quit");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        drop(self.writer);
        drop(self.master);
        let _ = self.reading.join();
        let raw = self.raw.lock().unwrap().clone();
        raw
    }
}

fn wait_until(what: &str, secs: u64, mut ok: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(secs);
    while !ok() {
        assert!(Instant::now() < until, "never: {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn no_leaks(raw: &[u8]) {
    let out = String::from_utf8_lossy(raw);
    // Links (OSC 8) only ever ours: the console's own task page, or the end of one (link.rs). Never the program's.
    for (i, _) in out.match_indices("\x1b]8;;") {
        let rest = &out[i + 5..];
        let url = &rest[..rest.find('\x1b').unwrap_or(rest.len())];
        assert!(
            url.is_empty() || (url.starts_with("http://127.0.0.1:") && url.contains("/t/")),
            "a link that isn't ours reached the real terminal: {url:?}"
        );
    }
    for leak in [
        "\x1b]52",
        "ZXZpbC1jbGlwYm9hcmQ",
        "evil.example",
        "evil-title",
        "evil-notify",
        "evil;body",
        "\u{202e}",
    ] {
        assert!(!out.contains(leak), "{leak:?} reached the real terminal");
    }
}

#[test]
fn take_over_type_leave_and_reattach_in_a_real_terminal() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let mut state = fake::scenario();
    state.term_screen = vec![format!("{HOSTILE}build #2 ready in its worktree\r\n$ ").into_bytes()];
    let engine = rt.block_on(fake::FakeEngine::start(state, 0));
    let scratch =
        std::env::temp_dir().join(format!("toolroll-take-over-pty-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).unwrap();

    let mut run = Run::start(&engine, &scratch, 34, 120);
    // t-done (the result waiting): take over.
    run.press("j");
    // The first t says what it opens; nothing starts until the second.
    run.press("t");
    run.wait_for("Opens your shell in a separate copy of build #2.", 5);
    assert!(engine.acts().iter().all(|a| a.path != "/term/start"));
    run.press("t");
    let shown = run.wait_for("$ ", 10);
    assert!(
        shown.contains("build #2 ready in its worktree") && shown.contains("the docs"),
        "{shown}"
    );
    run.wait_for("Typing", 5);
    // Started once, naming the task and its build only, with the session's form token and key.
    let starts: Vec<_> = engine
        .acts()
        .into_iter()
        .filter(|a| a.path == "/term/start")
        .collect();
    assert_eq!(starts.len(), 1, "{starts:?}");
    assert!(starts[0].keyed && starts[0].csrf_ok && starts[0].cookie_ok);
    assert_eq!(starts[0].field("task"), Some("t-done"));
    assert_eq!(starts[0].field("run"), Some("2"));
    assert_eq!(starts[0].field("repo"), None);
    assert_eq!(starts[0].field("password"), None);
    // Typing reaches it and its echo comes back; Ctrl-C and q are the terminal's, not the workbench's.
    run.press("echo hi");
    run.press("\r");
    run.wait_for("$ echo hi", 5);
    run.press("\x03q");
    let frames = || engine.state.lock().unwrap().term_frames.clone();
    wait_until("Ctrl-C and q reached the terminal", 5, || {
        let f = frames();
        f.iter().any(|x| x == r#"{"d":"\u0003","t":"in"}"#)
            && f.iter().any(|x| x == r#"{"d":"q","t":"in"}"#)
    });
    // The pane's own size was sent (resizing follows the pane).
    let resized = frames()
        .into_iter()
        .filter(|f| f.contains("\"resize\""))
        .collect::<Vec<_>>();
    assert!(!resized.is_empty(), "no resize sent");
    let last: serde_json::Value = serde_json::from_str(resized.last().unwrap()).unwrap();
    assert!(
        last["cols"].as_u64().unwrap() < 120 && last["rows"].as_u64().unwrap() < 34,
        "{last}"
    );
    // Ctrl-] comes back to the workbench; q quits it (the terminal keeps running in the console).
    run.press("\x1d");
    // Back: the stable fact is the key bar (t types in it again; while typing it says Ctrl-] instead). What was said
    // stays on the status line meanwhile (app.rs status_held), whatever a background read answers.
    run.wait_for("type in it", 5);
    run.wait_for("Back to the workbench", 5);
    let raw = run.quit();
    no_leaks(&raw);
    // Our own link was written: the task on screen, clickable (OSC 8 to the console's task page).
    assert!(
        String::from_utf8_lossy(&raw).contains("\x1b]8;;http://127.0.0.1:"),
        "no link of ours was written"
    );
    assert_eq!(engine.state.lock().unwrap().term_attaches, 1);

    // A second run reattaches to the same terminal: listed, not started again.
    {
        let mut st = engine.state.lock().unwrap();
        st.redeemed = false;
        st.term_screen = vec![format!("{HOSTILE}$ echo hi\r\nhi\r\n$ ").into_bytes()];
    }
    let mut run = Run::start(&engine, &scratch, 34, 120);
    run.press("j");
    run.press("t");
    run.wait_for("Opens your shell in a separate copy", 5);
    run.press("t");
    run.wait_for("$ echo hi", 10);
    let shown = run.wait_for("Typing", 5);
    assert!(shown.contains("│hi "), "{shown}");
    assert_eq!(
        engine
            .acts()
            .iter()
            .filter(|a| a.path == "/term/start")
            .count(),
        1
    );
    assert_eq!(engine.state.lock().unwrap().term_attaches, 2);
    assert!(engine.state.lock().unwrap().term_refusals.is_empty());
    run.press("\x1d");
    no_leaks(&run.quit());
    let _ = std::fs::remove_dir_all(&scratch);
}

/// A busy program (32 MB/s asked, a build log's lines and `yes`'s) while someone types: the screen parses the output in
/// turns, keys first, and keeps none of it back or out of order. Every byte the console sent was parsed (counted by the
/// binary), every key reached the program in order, and the program's last redraw — written after the whole stream —
/// is what the screen shows.
#[test]
fn a_busy_program_loses_no_output_while_someone_types() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let mut state = fake::scenario();
    let mut chunks = vec![];
    for i in 0..64usize {
        let mut c = Vec::new();
        while c.len() < 16 * 1024 {
            if i % 2 == 0 {
                c.extend_from_slice(b"y\r\n");
            } else {
                c.extend_from_slice(
                    format!("\x1b[1;32m   Compiling\x1b[0m crate-{i} v0.1.0 \x1b[2m[{} of 64]\x1b[0m 日本\r\n", c.len())
                        .as_bytes(),
                );
            }
        }
        chunks.push(c);
    }
    state.term_stream = chunks;
    state.term_stream_repeat = 1 << 12;
    state.term_stream_rate = 32_000_000;
    state.term_stream_end = b"\r\nstream-end-7f3a\r\n".to_vec();
    state.term_full_screen = true;
    state.term_echo = false;
    let engine = rt.block_on(fake::FakeEngine::start(state, 0));
    let scratch = std::env::temp_dir().join(format!("toolroll-busy-pty-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).unwrap();
    let stats = scratch.join("stats.json");
    let mut run = Run::start_with(
        &engine,
        &scratch,
        40,
        140,
        &["--stats-out", stats.to_str().unwrap()],
    );
    run.press("j");
    run.press("t");
    run.wait_for("Opens your shell", 5);
    run.press("t");
    run.wait_for("Typing", 10);
    run.wait_for("Compiling", 10);
    let typed = "the quick brown fox";
    for ch in typed.chars() {
        run.press(&ch.to_string());
    }
    // A bound for a starved CI runner, not a latency measure: the fact waited on is the keys on screen, in order.
    run.wait_for(&format!("\u{2301} {typed}"), 20);
    engine.state.lock().unwrap().term_stream_stop = true;
    run.wait_for("stream-end-7f3a", 20);
    // The stream ended; a last key's redraw comes after all of it, and is what the top line shows.
    run.press("!");
    run.wait_for(&format!("\u{2301} {typed}!"), 20);
    run.press("\x1d");
    // Back: the stable fact is the key bar (t types in it again; while typing it says Ctrl-] instead). What was said
    // stays on the status line meanwhile (app.rs status_held), whatever a background read answers.
    run.wait_for("type in it", 5);
    run.wait_for("Back to the workbench", 5);
    run.quit();
    let own: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&stats).unwrap()).unwrap();
    let st = engine.state.lock().unwrap();
    assert!(
        st.term_stream_bytes > 4 << 20,
        "only {} bytes streamed",
        st.term_stream_bytes
    );
    assert_eq!(
        own["term_bytes_parsed"].as_u64(),
        Some(st.term_bytes_sent),
        "the screen parsed a different number of bytes than the console sent"
    );
    let keys: String = st
        .term_frames
        .iter()
        .filter_map(|f| serde_json::from_str::<serde_json::Value>(f).ok())
        .filter(|v| v["t"] == "in")
        .map(|v| v["d"].as_str().unwrap_or("").to_string())
        .collect();
    assert_eq!(keys, format!("{typed}!"));
    drop(st);
    let _ = std::fs::remove_dir_all(&scratch);
}
