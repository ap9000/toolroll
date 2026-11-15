//! Spike measurement harness (never packaged).
//!
//!   record --out F [--cols C] [--rows R] [--quit-after S] [--quit-key K] -- CMD ARGS…
//!       Runs a harmless command in a real PTY and saves its output with timestamps (TRREC1).
//!   drive --bin TUI [--cols 200] [--rows 60] [--keys N] [--interval-ms M] [--resizes N] [--secs S] -- TUI-ARGS…
//!       Runs the TUI's `run` in a real PTY, types keys and times each one from the write to the moment the echoed text
//!       is on the parsed screen (vt100), checks every synchronized frame for tearing, and resizes the PTY mid-stream.
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
fn after_dashdash(args: &[String]) -> Vec<String> {
    args.iter()
        .position(|a| a == "--")
        .map(|i| args[i + 1..].to_vec())
        .unwrap_or_default()
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        Some("record") => record(&args[1..]),
        Some("drive") => drive(&args[1..]),
        _ => bail!("usage: record|drive"),
    }
}

fn record(args: &[String]) -> Result<()> {
    let out = arg(args, "--out").context("--out")?;
    let cols: u16 = num(args, "--cols", 100);
    let rows: u16 = num(args, "--rows", 30);
    let quit_after: f64 = num(args, "--quit-after", 0.0);
    let quit_key = arg(args, "--quit-key").unwrap_or_else(|| "q".into());
    let cmd = after_dashdash(args);
    if cmd.is_empty() {
        bail!("-- CMD");
    }
    let pty = native_pty_system().openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let mut c = CommandBuilder::new(&cmd[0]);
    c.args(&cmd[1..]);
    c.env("TERM", "xterm-256color");
    let mut child = pty.slave.spawn_command(c)?;
    drop(pty.slave);
    let mut reader = pty.master.try_clone_reader()?;
    let mut writer = pty.master.take_writer()?;
    let start = Instant::now();
    let chunks = Arc::new(Mutex::new(Vec::<(u64, Vec<u8>)>::new()));
    let c2 = chunks.clone();
    let t = std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => c2
                    .lock()
                    .unwrap()
                    .push((start.elapsed().as_micros() as u64, buf[..n].to_vec())),
            }
        }
    });
    if quit_after > 0.0 {
        std::thread::sleep(Duration::from_secs_f64(quit_after));
        writer.write_all(quit_key.as_bytes())?;
        writer.flush()?;
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if Instant::now() > deadline {
            child.kill()?;
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(writer);
    drop(pty.master);
    let _ = t.join();
    let chunks = chunks.lock().unwrap();
    let mut f = std::fs::File::create(&out)?;
    f.write_all(b"TRREC1\n")?;
    f.write_all(format!("{}\n", json!({ "cols": cols, "rows": rows, "cmd": cmd })).as_bytes())?;
    let mut total = 0;
    for (t, b) in chunks.iter() {
        f.write_all(&t.to_le_bytes())?;
        f.write_all(&(b.len() as u32).to_le_bytes())?;
        f.write_all(b)?;
        total += b.len();
    }
    println!(
        "{}",
        json!({ "out": out, "chunks": chunks.len(), "bytes": total, "secs": start.elapsed().as_secs_f64() })
    );
    Ok(())
}

const BSU: &[u8] = b"\x1b[?2026h";
const ESU: &[u8] = b"\x1b[?2026l";

struct Screen {
    parser: vt100::Parser,
    size: (u16, u16), // rows, cols
    bsu: u64,
    esu: u64,
    bytes: u64,
    frames_checked: u64,
    frames_skipped_old_size: u64,
    torn: Vec<String>,
    expect: Option<(String, Instant)>,
    echo_ms: Vec<f64>,
    tail: Vec<u8>,
}

fn count(hay: &[u8], needle: &[u8]) -> u64 {
    hay.windows(needle.len()).filter(|w| *w == needle).count() as u64
}

impl Screen {
    fn steer_text(&self) -> Option<String> {
        let (rows, _) = self.size;
        let s = self.parser.screen();
        for r in (0..rows).rev() {
            let row = s.contents_between(r, 0, r, self.size.1);
            if let Some(i) = row.find("steer› ") {
                let rest = &row[i + "steer› ".len()..];
                return Some(rest.split('▏').next().unwrap_or("").to_string());
            }
        }
        None
    }
    fn title_size(&self) -> Option<(u16, u16)> {
        let row = self.parser.screen().contents_between(0, 0, 0, self.size.1);
        let i = row.find("Toolroll spike ")?;
        let dims = row[i + 15..].split_whitespace().next()?;
        let (w, h) = dims.split_once('x')?;
        Some((h.parse().ok()?, w.parse().ok()?))
    }
    fn check_frame(&mut self) {
        let (rows, cols) = self.size;
        match self.title_size() {
            Some(sz) if sz == (rows, cols) => {}
            _ => {
                self.frames_skipped_old_size += 1;
                return;
            }
        }
        self.frames_checked += 1;
        let s = self.parser.screen();
        let cell = |r: u16, c: u16| {
            s.cell(r, c)
                .map(|c| c.contents().to_string())
                .unwrap_or_default()
        };
        let corners = [
            cell(0, 0),
            cell(0, cols - 1),
            cell(rows - 1, 0),
            cell(rows - 1, cols - 1),
        ];
        let steer_row = s.contents_between(rows - 3, 0, rows - 3, cols);
        let ok = corners == ["┌", "┐", "└", "┘"] && steer_row.contains("steer› ");
        if !ok && self.torn.len() < 5 {
            self.torn.push(format!(
                "{}x{} corners={:?} steer_row_ok={}",
                cols,
                rows,
                corners,
                steer_row.contains("steer› ")
            ));
        } else if !ok {
            self.torn.push(String::new());
        }
    }
    fn feed(&mut self, data: &[u8]) {
        self.bytes += data.len() as u64;
        self.bsu += count(data, BSU);
        // Split at each end-of-frame so every complete frame is checked on its own.
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
        // Keep a possible partial marker for the next read; process the rest now.
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

fn summary(mut v: Vec<f64>) -> serde_json::Value {
    if v.is_empty() {
        return json!({ "n": 0 });
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p = |q: f64| (v[((v.len() as f64 - 1.0) * q).round() as usize] * 1000.0).round() / 1000.0;
    json!({ "n": v.len(), "p50_ms": p(0.5), "p95_ms": p(0.95), "p99_ms": p(0.99), "max_ms": p(1.0) })
}

fn drive(args: &[String]) -> Result<()> {
    let bin = arg(args, "--bin").context("--bin")?;
    let cols: u16 = num(args, "--cols", 200);
    let rows: u16 = num(args, "--rows", 60);
    let keys: usize = num(args, "--keys", 200);
    let interval: u64 = num(args, "--interval-ms", 40);
    let resizes: usize = num(args, "--resizes", 0);
    let tui_args = after_dashdash(args);
    let pty = native_pty_system().openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let mut c = CommandBuilder::new(&bin);
    c.arg("run");
    c.args(&tui_args);
    c.env("TERM", "xterm-256color");
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
        frames_skipped_old_size: 0,
        torn: Vec::new(),
        expect: None,
        echo_ms: Vec::new(),
        tail: Vec::new(),
    }));
    let s2 = screen.clone();
    let start = Instant::now();
    let t = std::thread::spawn(move || {
        let mut buf = [0u8; 1 << 16];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => s2.lock().unwrap().feed(&buf[..n]),
            }
        }
    });
    // Ready: the first full frame is on screen.
    let ready_deadline = Instant::now() + Duration::from_secs(10);
    while screen.lock().unwrap().steer_text().is_none() {
        if Instant::now() > ready_deadline {
            let s = screen.lock().unwrap();
            bail!(
                "the TUI never drew its steer line; {} bytes; screen:\n{}",
                s.bytes,
                s.parser.screen().contents()
            );
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let ready_ms = start.elapsed().as_secs_f64() * 1000.0;
    let alphabet = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut typed = String::new();
    let mut missed = 0;
    for i in 0..keys {
        if typed.len() >= 60 {
            writer.write_all(b"\x1b")?; // Esc clears the steer box
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
        {
            let mut s = screen.lock().unwrap();
            pty.master.resize(PtySize {
                rows: r,
                cols: cc,
                pixel_width: 0,
                pixel_height: 0,
            })?;
            s.parser.screen_mut().set_size(r, cc);
            s.size = (r, cc);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    if let Some(path) = arg(args, "--type-to-term") {
        // Tab focuses the terminal pane; type a command there; Tab back.
        writer.write_all(b"\t")?;
        writer.write_all(path.as_bytes())?;
        writer.write_all(b"\r")?;
        writer.flush()?;
        std::thread::sleep(Duration::from_millis(800));
        writer.write_all(b"\t")?;
        writer.flush()?;
        std::thread::sleep(Duration::from_millis(300));
    }
    if let Some(path) = arg(args, "--screen-out") {
        std::fs::write(path, screen.lock().unwrap().parser.screen().contents())?;
    }
    // Ctrl-C quits the TUI (it writes its stats file on the way out).
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
    drop(writer);
    drop(pty.master);
    let _ = t.join();
    let s = screen.lock().unwrap();
    let elapsed = start.elapsed().as_secs_f64();
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "pty": format!("{cols}x{rows}"), "ready_ms": (ready_ms * 10.0).round() / 10.0, "elapsed_s": (elapsed * 100.0).round() / 100.0,
            "keys": keys, "missed_echo": missed, "key_write_to_screen": summary(s.echo_ms.clone()),
            "sync_begin": s.bsu, "sync_end": s.esu, "frames_checked": s.frames_checked, "frames_before_app_saw_resize": s.frames_skipped_old_size,
            "torn_frames": s.torn.len(), "torn_examples": s.torn.iter().filter(|t| !t.is_empty()).collect::<Vec<_>>(),
            "resizes": resizes, "output_mb_per_s": ((s.bytes as f64 / elapsed / 1e6) * 100.0).round() / 100.0, "child": status,
        }))?
    );
    Ok(())
}
