//! The real binary in a real pseudo-terminal against the fake console (the harness's road, solo-workbench plan T2):
//! a person opens a result's changes, leaves notes, moves around (nothing is sent), copies a hunk to the scrollback,
//! and sends back with the notes; the console receives exactly the notes the screen showed. The sign-in link reaches
//! the binary on descriptor 3 from a 0600 file in a folder of this test's own, removed once read.
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
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn review_in_a_real_terminal() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let engine = rt.block_on(fake::FakeEngine::start(fake::scenario(), 0));
    let scratch = std::env::temp_dir().join(format!("toolroll-review-pty-{}", std::process::id()));
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
    let (rows, cols) = (34u16, 120u16);
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
    // An environment of its own: no home, no colour setting, nothing of the person's.
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
    let mut press = |keys: &str| {
        writer.write_all(keys.as_bytes()).unwrap();
        writer.flush().unwrap();
        std::thread::sleep(Duration::from_millis(60));
    };
    wait_for(&screen, "Add CSV export", 15);
    std::fs::remove_file(&link_file).unwrap();
    // t-done, its changes.
    press("j");
    press("\r");
    wait_for(&screen, "@@ -1,3 +1,3 @@", 10);
    // The added line (rows: heading, context, removed, added), a note on it.
    press("jjj");
    press("c");
    wait_for(&screen, "Note on src/total.ts line 2:", 5);
    press("round to cents");
    press("\r");
    wait_for(&screen, "Note: round to cents", 5);
    // Moving around: lines, hunks, notes, the view, the next file and back.
    press("kj[]nNgGvv}");
    wait_for(&screen, "Totals include tax.", 5);
    press("{");
    wait_for(&screen, "Note: round to cents", 5);
    assert!(engine.acts().is_empty(), "moving sent {:?}", engine.acts());
    // Copy the hunk: the screen steps aside, the hunk is on the terminal's own screen to select; a key comes back.
    press("y");
    let copied = wait_for(&screen, "(Copied by Toolroll", 5);
    assert!(
        copied.contains("src/total.ts @@ -1,3 +1,3 @@")
            && copied.contains("+  return sum(items) + tax(items);"),
        "{copied}"
    );
    press("x");
    wait_for(&screen, "Note: round to cents", 5);
    assert!(engine.acts().is_empty(), "copying sent {:?}", engine.acts());
    // Send back with the note.
    press("r");
    wait_for(&screen, "Send back build #2 with:", 5);
    press("Thanks.");
    wait_for(&screen, "For the whole change: Thanks.", 5);
    // The whole text, read to its end, then Enter sends exactly it.
    press("\r");
    let shown = wait_for(&screen, "goes back with exactly this:", 5);
    press("\r");
    let until = Instant::now() + Duration::from_secs(10);
    while engine.acts().is_empty() {
        assert!(Instant::now() < until, "nothing was sent");
        std::thread::sleep(Duration::from_millis(10));
    }
    wait_for(&screen, "Sent back", 5);
    let acts = engine.acts();
    assert_eq!(acts.len(), 1, "{acts:?}");
    assert_eq!(acts[0].path, "/r/2/comment");
    assert!(acts[0].keyed && acts[0].csrf_ok && acts[0].cookie_ok && acts[0].in_place);
    let posted = acts[0].field("note").unwrap();
    assert_eq!(
        posted,
        "Notes on the changes:\n- src/total.ts line 2 — round to cents\n\nThanks."
    );
    for line in posted.lines().filter(|l| !l.is_empty()) {
        assert!(
            shown.contains(line),
            "posted but not shown: {line}\n{shown}"
        );
    }
    // Quit (nothing owned here: Ctrl-C leaves).
    press("\x03");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if Instant::now() > deadline {
            child.kill().unwrap();
            panic!("the binary didn't quit");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(writer);
    drop(pty.master);
    let _ = reading.join();
    let _ = std::fs::remove_dir_all(&scratch);
}
