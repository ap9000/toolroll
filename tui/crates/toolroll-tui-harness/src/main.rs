//! Measures the terminal workbench (never packaged).
//!
//!   toolroll-tui-harness bench [--width 200] [--height 60] [--frames 3000] [--records 20000]
//!       the real view on ratatui's TestBackend, a long live transcript growing every frame: frame time.
//!   toolroll-tui-harness bench-diff [--width 200] [--height 60] [--lines 2000] [--frames 600]
//!       the Diff tab on a file of --lines changed lines (Rust, syntax colours on), scrolled a page a frame and back:
//!       frame time (colouring runs on its own thread meanwhile), grammar load time, and how long the colouring took.
//!   toolroll-tui-harness drive --bin <toolroll-tui> [--cols 200] [--rows 60] [--keys 300] [--interval-ms 40]
//!       [--resizes N] [--records 20000] [--rate 200] [--stats-out F] [--screen-out F]
//!       the real binary in a real PTY against the fake console (records streaming into the live build at --rate per
//!       second): key written → echoed on the parsed screen, and every DEC 2026 frame checked for tearing.
//!
//! The one-time link reaches the binary the way the launcher gives it: on descriptor 3 (here a 0600 file opened by
//! `sh` as fd 3 and removed once the binary has read it), never in its arguments or environment.
use anyhow::{bail, Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::json;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}
fn num<T: std::str::FromStr>(args: &[String], name: &str, d: T) -> T {
    arg(args, name).and_then(|v| v.parse().ok()).unwrap_or(d)
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        Some("bench") => bench(&args[1..]),
        Some("bench-diff") => bench_diff(&args[1..]),
        Some("drive") => drive(&args[1..]),
        _ => bail!("usage: bench | drive --bin <toolroll-tui>"),
    }
}

fn summary(mut v: Vec<f64>) -> serde_json::Value {
    if v.is_empty() {
        return json!({ "n": 0 });
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p = |q: f64| (v[((v.len() as f64 - 1.0) * q).round() as usize] * 1000.0).round() / 1000.0;
    json!({ "n": v.len(), "p50_ms": p(0.5), "p95_ms": p(0.95), "p99_ms": p(0.99), "max_ms": p(1.0) })
}

fn bench(args: &[String]) -> Result<()> {
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    use toolroll_tui::app::{App, Effect, Msg};
    let (w, h): (u16, u16) = (num(args, "--width", 200), num(args, "--height", 60));
    let frames: usize = num(args, "--frames", 3000);
    let records: usize = num(args, "--records", 20_000);
    let state = toolroll_fake_engine::scenario();
    let mut app = App::new(false, None);
    let work = serde_json::from_value(toolroll_fake_engine::scenario_work())?;
    app.update(Msg::Work(Ok(work)));
    app.key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Char('j'),
    ));
    app.key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Char('j'),
    ));
    let steps = serde_json::from_value(state.steps["t-live"].clone())?;
    let fx = app.update(Msg::Steps("t-live".into(), Ok(steps)));
    assert!(fx.iter().any(|e| matches!(e, Effect::FetchLive { .. })));
    let window = |from: usize, n: usize, cursor: usize| {
        serde_json::from_value(json!({ "version": 1, "session": { "kind": "run", "id": 7, "task": "t-live" }, "room": "agent:7", "live": true, "file": "main",
            "window": { "ok": true, "records": toolroll_fake_engine::busy_records(from, n), "cursor": format!("c{cursor}"), "restarted": false, "earlier": false, "quarantined": 0, "skipped": 0, "more": false } }))
        .unwrap()
    };
    app.update(Msg::Live(7, "main", Ok(window(0, records, records))));
    let mut term = Terminal::new(TestBackend::new(w, h))?;
    let mut times = vec![];
    for i in 0..frames {
        // A record arrives every frame (the transcript is laid out again each time it grows).
        app.update(Msg::Live(
            7,
            "main",
            Ok(window(records + i, 1, records + i + 1)),
        ));
        let t = Instant::now();
        term.draw(|f| toolroll_tui::view::draw(f, &mut app))?;
        times.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({ "size": format!("{w}x{h}"), "records": records, "frame_time": summary(times) })
        )?
    );
    Ok(())
}

/// A long Rust diff: `n` changed lines in hunks of 20 (10 removed, 10 added, with context), as the engine sends it.
fn long_diff(n: usize) -> (serde_json::Value, serde_json::Value) {
    let mut hunks = vec![];
    let (mut old, mut new) = (1i64, 1i64);
    let body = |i: usize| {
        match i % 5 {
        0 => format!("    let total_{i} = items.iter().map(|x| x.price * {i}).sum::<u64>(); // running total"),
        1 => format!("    if total_{} > LIMIT {{ return Err(Error::TooLarge(\"{i}\".into())); }}", i - 1),
        2 => format!("    pub fn apply_{i}(&mut self, cart: &Cart) -> Result<u64, Error> {{"),
        3 => format!("        self.seen.insert({i}, String::from(\"line {i}\"));"),
        _ => "    }".to_string(),
    }
    };
    for h in 0..n.div_ceil(20) {
        let mut lines = vec![];
        let (o0, n0) = (old, new);
        for c in 0..3 {
            lines.push(json!({ "kind": "context", "text": body(h * 100 + c), "oldLine": old, "newLine": new }));
            old += 1;
            new += 1;
        }
        for i in 0..10 {
            lines.push(json!({ "kind": "deletion", "text": body(h * 20 + i), "oldLine": old, "newLine": null }));
            old += 1;
        }
        for i in 0..10 {
            lines.push(json!({ "kind": "addition", "text": body(h * 20 + i).replace("total", "subtotal"), "oldLine": null, "newLine": new }));
            new += 1;
        }
        for c in 0..3 {
            lines.push(json!({ "kind": "context", "text": body(h * 100 + 50 + c), "oldLine": old, "newLine": new }));
            old += 1;
            new += 1;
        }
        hunks.push(json!({ "header": format!("@@ -{o0},16 +{n0},16 @@"), "lines": lines }));
        old += 20;
        new += 20;
    }
    let file = json!({ "version": 1, "task": "t-done", "run": 2, "linesTruncated": false,
        "file": { "file": 0, "path": "src/checkout.rs", "oldPath": "src/checkout.rs", "meta": [], "hunks": hunks } });
    let diff = json!({ "version": 1, "task": "t-done", "run": 2, "patchTruncated": false, "problem": null,
        "totals": { "files": 1, "additions": n / 2, "deletions": n / 2, "binary": 0, "filesTruncated": false },
        "files": [{ "file": 0, "path": "src/checkout.rs", "oldPath": "src/checkout.rs", "additions": n / 2, "deletions": n / 2, "binary": false, "hunks": n.div_ceil(20) }] });
    (diff, file)
}

fn bench_diff(args: &[String]) -> Result<()> {
    use crossterm::event::{KeyCode, KeyEvent};
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    use toolroll_tui::app::{App, Effect, Msg};
    let (w, h): (u16, u16) = (num(args, "--width", 200), num(args, "--height", 60));
    let n: usize = num(args, "--lines", 2000);
    let frames: usize = num(args, "--frames", 600);
    let t = Instant::now();
    toolroll_tui::syntax::load_now();
    let load_ms = t.elapsed().as_secs_f64() * 1000.0;
    let state = toolroll_fake_engine::scenario();
    let mut app = App::new(false, None);
    app.update(Msg::Work(Ok(serde_json::from_value(
        toolroll_fake_engine::scenario_work(),
    )?)));
    app.key(KeyEvent::from(KeyCode::Char('j')));
    app.update(Msg::Steps(
        "t-done".into(),
        Ok(serde_json::from_value(state.steps["t-done"].clone())?),
    ));
    let fx = app.key(KeyEvent::from(KeyCode::Enter));
    let ask = fx
        .iter()
        .find_map(|e| match e {
            Effect::FetchDiff(a) => Some(a.clone()),
            _ => None,
        })
        .context("diff read")?;
    let (diff, file) = long_diff(n);
    let fx = app.update(Msg::Diff(ask, Ok(serde_json::from_value(diff)?)));
    let ask = fx
        .iter()
        .find_map(|e| match e {
            Effect::FetchDiffFile(a) => Some(a.clone()),
            _ => None,
        })
        .context("file read")?;
    app.update(Msg::DiffFile(ask, Ok(serde_json::from_value(file)?)));
    let rows = app.rows.len();
    let mut term = Terminal::new(TestBackend::new(w, h))?;
    let mut times = vec![];
    let mut coloured_after = None;
    let started = Instant::now();
    for i in 0..frames {
        // A page down a frame to the end, then back up: every row is drawn, coloured or not yet.
        let key = if (i / (rows / 20 + 1)).is_multiple_of(2) {
            KeyCode::PageDown
        } else {
            KeyCode::PageUp
        };
        let t = Instant::now();
        app.key(KeyEvent::from(key));
        term.draw(|f| toolroll_tui::view::draw(f, &mut app))?;
        times.push(t.elapsed().as_secs_f64() * 1000.0);
        if coloured_after.is_none() && !app.highlight_pending {
            coloured_after = Some((started.elapsed().as_secs_f64() * 1000.0).round());
        }
        // ~120 frames a second at most, as the screen draws.
        std::thread::sleep(Duration::from_micros(8_333));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({ "size": format!("{w}x{h}"), "changed_lines": n, "rows": rows,
            "grammar_load_ms": (load_ms * 10.0).round() / 10.0, "coloured_all_after_ms": coloured_after, "key_to_frame": summary(times) })
        )?
    );
    Ok(())
}

const BSU: &[u8] = b"\x1b[?2026h";
const ESU: &[u8] = b"\x1b[?2026l";
const STEER: &str = "Steer: ";

struct Screen {
    parser: vt100::Parser,
    size: (u16, u16),
    bsu: u64,
    esu: u64,
    bytes: u64,
    frames_checked: u64,
    frames_old_size: u64,
    torn: Vec<String>,
    expect: Option<(String, Instant)>,
    echo_ms: Vec<f64>,
    tail: Vec<u8>,
}

fn count(hay: &[u8], needle: &[u8]) -> u64 {
    hay.windows(needle.len()).filter(|w| *w == needle).count() as u64
}

impl Screen {
    fn row(&self, r: u16) -> String {
        self.parser.screen().contents_between(r, 0, r, self.size.1)
    }
    fn contains(&self, text: &str) -> bool {
        (0..self.size.0).any(|r| self.row(r).contains(text))
    }
    fn steer_text(&self) -> Option<String> {
        for r in (0..self.size.0).rev() {
            let row = self.row(r);
            if let Some(i) = row.find(STEER) {
                let rest = &row[i + STEER.len()..];
                return Some(rest.split('▏').next().unwrap_or("").to_string());
            }
        }
        None
    }
    fn check_frame(&mut self) {
        let (rows, cols) = self.size;
        let s = self.parser.screen();
        let cell = |r: u16, c: u16| {
            s.cell(r, c)
                .map(|c| c.contents().to_string())
                .unwrap_or_default()
        };
        // A frame drawn for the size before a resize (the app hadn't seen the new size yet): its corner is elsewhere.
        if cell(0, 0) == "┌" && cell(0, cols - 1) != "┐" && (0..cols).any(|c| cell(0, c) == "┐")
        {
            self.frames_old_size += 1;
            return;
        }
        self.frames_checked += 1;
        let corners = [
            cell(0, 0),
            cell(0, cols - 1),
            cell(rows - 1, 0),
            cell(rows - 1, cols - 1),
        ];
        let keys = s.contents_between(rows - 2, 0, rows - 2, cols);
        let ok = corners == ["┌", "┐", "└", "┘"] && keys.contains("q quit");
        if !ok {
            let example = if self.torn.len() < 5 {
                format!(
                    "{cols}x{rows} corners={corners:?} keys_ok={}",
                    keys.contains("q quit")
                )
            } else {
                String::new()
            };
            self.torn.push(example);
        }
    }
    fn feed(&mut self, data: &[u8]) {
        self.bytes += data.len() as u64;
        self.bsu += count(data, BSU);
        let mut buf = std::mem::take(&mut self.tail);
        buf.extend_from_slice(data);
        let mut start = 0;
        let mut i = 0;
        while i + ESU.len() <= buf.len() {
            if &buf[i..i + ESU.len()] == ESU {
                let end = i + ESU.len();
                self.parser.process(&buf[start..end]);
                self.esu += 1;
                self.check_frame();
                start = end;
                i = end;
            } else {
                i += 1;
            }
        }
        let keep = (buf.len() - start).min(ESU.len() - 1);
        let process_to = buf.len() - keep;
        if process_to > start {
            self.parser.process(&buf[start..process_to]);
        }
        self.tail = buf[process_to..].to_vec();
        if let Some((want, at)) = &self.expect {
            if self.steer_text().as_deref() == Some(want.as_str()) {
                self.echo_ms.push(at.elapsed().as_secs_f64() * 1000.0);
                self.expect = None;
            }
        }
    }
}

fn wait_for(screen: &Arc<Mutex<Screen>>, what: &str, secs: u64) -> Result<()> {
    let until = Instant::now() + Duration::from_secs(secs);
    while !screen.lock().unwrap().contains(what) {
        if Instant::now() > until {
            bail!(
                "the screen never showed {what:?}:\n{}",
                screen.lock().unwrap().parser.screen().contents()
            );
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}

fn drive(args: &[String]) -> Result<()> {
    let bin = arg(args, "--bin").context("--bin")?;
    let cols: u16 = num(args, "--cols", 200);
    let rows: u16 = num(args, "--rows", 60);
    let keys: usize = num(args, "--keys", 300);
    let interval: u64 = num(args, "--interval-ms", 40);
    let resizes: usize = num(args, "--resizes", 0);
    let records: usize = num(args, "--records", 20_000);
    let rate: u64 = num(args, "--rate", 200);
    let scratch = std::env::temp_dir().join(format!("toolroll-harness-{}", std::process::id()));
    std::fs::create_dir_all(&scratch)?;

    // The fake console, in this process, with a long transcript growing at `rate` records a second.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    let mut state = toolroll_fake_engine::scenario();
    state
        .live
        .get_mut(&toolroll_fake_engine::LIVE_RUN)
        .unwrap()
        .0
        .extend(toolroll_fake_engine::busy_records(0, records));
    let engine = Arc::new(rt.block_on(toolroll_fake_engine::FakeEngine::start(state, 0)));
    let link_file = scratch.join("link");
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&link_file)?;
        writeln!(f, "{}", engine.link())?;
    }
    let feeding = Arc::new(std::sync::atomic::AtomicBool::new(true));
    if rate > 0 {
        let (e2, on) = (engine.clone(), feeding.clone());
        rt.spawn(async move {
            let mut n = records;
            let every = Duration::from_micros(1_000_000 / rate);
            while on.load(std::sync::atomic::Ordering::Relaxed) {
                tokio::time::sleep(every).await;
                e2.push_records(
                    toolroll_fake_engine::LIVE_RUN,
                    toolroll_fake_engine::busy_records(n, 1),
                );
                n += 1;
            }
        });
    }

    let pty = native_pty_system().openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let mut c = CommandBuilder::new("/bin/sh");
    c.args(["-c", "exec \"$0\" \"$@\" 3<\"$TR_LINK_FILE\""]);
    c.arg(&bin);
    if let Some(out) = arg(args, "--stats-out") {
        c.args(["--stats-out", &out]);
    }
    c.env("TERM", "xterm-256color");
    c.env("TR_LINK_FILE", &link_file);
    let mut child = pty.slave.spawn_command(c)?;
    drop(pty.slave);
    let mut reader = pty.master.try_clone_reader()?;
    let mut writer = pty.master.take_writer()?;
    let screen = Arc::new(Mutex::new(Screen {
        parser: vt100::Parser::new(rows, cols, 0),
        size: (rows, cols),
        bsu: 0,
        esu: 0,
        bytes: 0,
        frames_checked: 0,
        frames_old_size: 0,
        torn: vec![],
        expect: None,
        echo_ms: vec![],
        tail: vec![],
    }));
    let s2 = screen.clone();
    let t = std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => s2.lock().unwrap().feed(&buf[..n]),
            }
        }
    });
    let start = Instant::now();
    wait_for(&screen, "Upgrade the test runner", 15)?;
    let ready_ms = start.elapsed().as_secs_f64() * 1000.0;
    // The link file is gone once read: nothing on disk holds it.
    std::fs::remove_file(&link_file)?;
    // To the live build (third row), then open the steer box.
    writer.write_all(b"jj")?;
    writer.flush()?;
    wait_for(&screen, "build #7", 10)?;
    writer.write_all(b"s")?;
    writer.flush()?;
    wait_for(&screen, STEER, 5)?;
    let alphabet = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut typed = String::new();
    let mut missed = 0;
    for i in 0..keys {
        if typed.len() >= 60 {
            // Esc closes the box (nothing sent); s opens an empty one.
            writer.write_all(b"\x1b")?;
            writer.flush()?;
            std::thread::sleep(Duration::from_millis(30));
            writer.write_all(b"s")?;
            writer.flush()?;
            typed.clear();
            let until = Instant::now() + Duration::from_secs(2);
            while screen.lock().unwrap().steer_text().as_deref() != Some("")
                && Instant::now() < until
            {
                std::thread::sleep(Duration::from_millis(2));
            }
        }
        let ch = alphabet[i % alphabet.len()] as char;
        typed.push(ch);
        {
            let mut s = screen.lock().unwrap();
            s.expect = Some((typed.clone(), Instant::now()));
            writer.write_all(&[ch as u8])?;
            writer.flush()?;
        }
        let until = Instant::now() + Duration::from_secs(1);
        while screen.lock().unwrap().expect.is_some() {
            if Instant::now() > until {
                missed += 1;
                screen.lock().unwrap().expect = None;
                break;
            }
            std::thread::sleep(Duration::from_micros(200));
        }
        std::thread::sleep(Duration::from_millis(interval));
    }
    let sizes = [
        (60u16, 200u16),
        (40, 120),
        (24, 80),
        (50, 160),
        (70, 240),
        (30, 100),
    ];
    for i in 0..resizes {
        let (r, cc) = sizes[(i + 1) % sizes.len()];
        let mut s = screen.lock().unwrap();
        pty.master.resize(PtySize {
            rows: r,
            cols: cc,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        s.parser.screen_mut().set_size(r, cc);
        s.size = (r, cc);
        drop(s);
        std::thread::sleep(Duration::from_millis(250));
    }
    if let Some(path) = arg(args, "--screen-out") {
        std::fs::write(path, screen.lock().unwrap().parser.screen().contents())?;
    }
    // Esc closes the box; Ctrl-C quits (stats written on the way out).
    writer.write_all(b"\x1b")?;
    writer.flush()?;
    std::thread::sleep(Duration::from_millis(100));
    writer.write_all(b"\x03")?;
    writer.flush()?;
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(st) = child.try_wait()? {
            break format!("{st:?}");
        }
        if Instant::now() > deadline {
            child.kill()?;
            break "killed".into();
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    feeding.store(false, std::sync::atomic::Ordering::Relaxed);
    drop(writer);
    drop(pty.master);
    let _ = t.join();
    let acts = engine.acts();
    let s = screen.lock().unwrap();
    let elapsed = start.elapsed().as_secs_f64();
    let _ = std::fs::remove_dir_all(&scratch);
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "pty": format!("{cols}x{rows}"), "ready_ms": (ready_ms * 10.0).round() / 10.0, "elapsed_s": (elapsed * 100.0).round() / 100.0,
            "records_at_start": records, "records_per_s": rate, "keys": keys, "missed_echo": missed, "key_write_to_screen": summary(s.echo_ms.clone()),
            "sync_begin": s.bsu, "sync_end": s.esu, "frames_checked": s.frames_checked, "frames_before_app_saw_resize": s.frames_old_size,
            "torn_frames": s.torn.len(), "torn_examples": s.torn.iter().filter(|t| !t.is_empty()).collect::<Vec<_>>(),
            "resizes": resizes, "output_mb_per_s": ((s.bytes as f64 / elapsed / 1e6) * 100.0).round() / 100.0, "child": status,
            "acts_sent": acts.len(),
        }))?
    );
    Ok(())
}
