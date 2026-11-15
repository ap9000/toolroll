//! The real-terminal loop: tokio select over crossterm's EventStream, line feeders, a recorded (or live `/term`)
//! terminal pane and `/live`; alternate screen; DEC 2026 synchronized output around every frame; frames drawn on
//! request, capped at ~120 fps; a key is applied and echoed in a frame drawn at once (never waits for the cap).
use crate::app::{draw, App};
use crate::engine::{self, LiveEvent, TermSocket};
use crate::recording::{Recording, Replay};
use crate::stats::Samples;
use crate::Args;
use anyhow::Result;
use crossterm::event::{
    DisableBracketedPaste, EnableBracketedPaste, Event, EventStream, KeyCode, KeyEventKind,
    KeyModifiers,
};
use crossterm::terminal::{
    self, BeginSynchronizedUpdate, EndSynchronizedUpdate, EnterAlternateScreen,
    LeaveAlternateScreen,
};
use futures_util::{SinkExt, StreamExt};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use serde_json::json;
use std::io::{BufWriter, Stdout, Write};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const FRAME_MIN: Duration = Duration::from_micros(8_333); // ~120 fps cap for data-driven frames

type Term = Terminal<CrosstermBackend<BufWriter<Stdout>>>;

fn restore() {
    let mut out = std::io::stdout();
    let _ = crossterm::execute!(
        out,
        DisableBracketedPaste,
        LeaveAlternateScreen,
        crossterm::cursor::Show
    );
    let _ = terminal::disable_raw_mode();
}

pub fn main(args: &Args) -> Result<()> {
    if let Some(path) = args.value("--trace-out") {
        let file = std::fs::File::create(path)?;
        tracing_subscriber::fmt()
            .with_writer(std::sync::Mutex::new(file))
            .with_span_events(tracing_subscriber::fmt::format::FmtSpan::CLOSE)
            .with_ansi(false)
            .with_target(false)
            .init();
    }
    // The link (if any) is read before the screen is taken over; it is redeemed once and dropped.
    // `--link-stdin`: a pipe from the launcher. `--link-file`: the spike's PTY harness, whose child's stdin is the PTY;
    // the file is read once and removed. (The real launcher would pass an inherited pipe fd: see results.md.)
    let link = if args.flag("--link-stdin") {
        Some(read_line()?)
    } else if let Some(p) = args.value("--link-file") {
        let s = std::fs::read_to_string(&p)?;
        let _ = std::fs::remove_file(&p);
        Some(s.trim().to_string())
    } else {
        None
    };
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore();
        prev(info);
    }));
    let result = rt.block_on(run(args, link));
    restore();
    result
}

fn read_line() -> Result<String> {
    let mut s = String::new();
    std::io::stdin().read_line(&mut s)?;
    Ok(s.trim().to_string())
}

fn key_bytes(code: KeyCode, mods: KeyModifiers) -> Option<Vec<u8>> {
    Some(match code {
        KeyCode::Char(c) if mods.contains(KeyModifiers::CONTROL) && c.is_ascii_alphabetic() => {
            vec![(c.to_ascii_lowercase() as u8) & 0x1f]
        }
        KeyCode::Char(c) => c.to_string().into_bytes(),
        KeyCode::Enter => b"\r".to_vec(),
        KeyCode::Backspace => b"\x7f".to_vec(),
        KeyCode::Esc => b"\x1b".to_vec(),
        KeyCode::Up => b"\x1b[A".to_vec(),
        KeyCode::Down => b"\x1b[B".to_vec(),
        KeyCode::Right => b"\x1b[C".to_vec(),
        KeyCode::Left => b"\x1b[D".to_vec(),
        _ => return None,
    })
}

async fn run(args: &Args, link: Option<String>) -> Result<()> {
    let rate: f64 = args.num("--rate", 10_000.0);
    let auto_quit = args
        .value("--auto-quit-secs")
        .and_then(|s| s.parse::<f64>().ok())
        .map(Duration::from_secs_f64);
    let stats_out = args.value("--stats-out");
    crate::app::NOISY.store(args.flag("--noisy"), std::sync::atomic::Ordering::Relaxed);

    // Engine (before the alternate screen, so a refusal prints plainly).
    let mut session = None;
    let mut engine_notes = Vec::new();
    if let (Some(base), Some(link)) = (args.value("--engine-base"), link) {
        let (s, report) = engine::redeem(&base, &link).await?;
        engine_notes.push(json!({ "redeem": report }));
        session = Some(s);
    }
    let mut ws: Option<TermSocket> = None;
    if let Some(url) = args.value("--term-url") {
        let origin = args
            .value("--term-origin")
            .unwrap_or_else(|| "http://127.0.0.1".into());
        match engine::connect_term(&url, &origin, None, None).await {
            Ok(s) => ws = Some(s),
            Err(e) => engine_notes.push(json!({ "term": e })),
        }
    } else if let (Some(s), Some(id)) = (session.as_ref(), args.value("--term-id")) {
        match s.term(&id).await {
            Ok(sock) => ws = Some(sock),
            Err(e) => engine_notes.push(json!({ "term": e })),
        }
    }

    let mut replay = match (&ws, args.value("--recording")) {
        (None, Some(p)) => Some(Replay::new(Recording::load(&p)?)),
        _ => None,
    };
    let (vr, vc) = replay.as_ref().map(|r| r.size()).unwrap_or((24, 80));
    let title = if ws.is_some() {
        "live /term (WebSocket)"
    } else if replay.is_some() {
        "recorded session (vt100)"
    } else {
        "terminal"
    };
    let mut app = App::new(vr, vc, title.into());
    app.feed_all(crate::app::RING_LINES); // full rings from the start

    let (live_tx, mut live_rx) = mpsc::unbounded_channel::<LiveEvent>();
    let mut live_events = 0u64;
    if let Some(s) = session.as_ref() {
        // The session moves into its own task for the stream; the screen keeps the rest.
        let rooms = ["workspace", "summary"];
        let s2 = engine::Session::clone_for_stream(s);
        tokio::spawn(async move {
            let _ = s2.live(&rooms, live_tx).await;
        });
    }

    terminal::enable_raw_mode()?;
    let mut stdout = std::io::stdout();
    crossterm::execute!(stdout, EnterAlternateScreen, EnableBracketedPaste)?;
    let backend = CrosstermBackend::new(BufWriter::with_capacity(1 << 18, std::io::stdout()));
    let mut term: Term = Terminal::new(backend)?;
    // No term.clear(): it asks the terminal for the cursor position (a DSR round trip); the alternate screen starts empty.

    let mut events = EventStream::new();
    let mut feed = tokio::time::interval(Duration::from_millis(5));
    feed.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let start = Instant::now();
    let mut fed_at = start;
    let mut carry = 0.0f64;
    let mut frames = Samples::default();
    let mut echo = Samples::default();
    let mut intervals = Samples::default();
    let mut last_frame: Option<Instant> = None;
    let mut dirty = true;
    let mut resizes = 0u64;
    let mut frame_no = 0u64;
    let mut ws_bytes = 0usize;
    let mut sent_size = (0u16, 0u16);
    let mut vt_buf = Vec::new();

    let draw_frame = |term: &mut Term,
                      app: &mut App,
                      frames: &mut Samples,
                      intervals: &mut Samples,
                      last: &mut Option<Instant>,
                      n: &mut u64|
     -> Result<Instant> {
        let t = Instant::now();
        let span = tracing::info_span!("frame", n = *n);
        let _g = span.enter();
        crossterm::queue!(term.backend_mut(), BeginSynchronizedUpdate)?;
        term.draw(|f| draw(f, app))?;
        crossterm::queue!(term.backend_mut(), EndSynchronizedUpdate)?;
        term.backend_mut().flush()?;
        let done = Instant::now();
        frames.push(done - t);
        if let Some(prev) = *last {
            intervals.push(t - prev);
        }
        *last = Some(t);
        *n += 1;
        Ok(done)
    };

    loop {
        // Status line: what the person (and the harness) can read off the screen.
        if dirty {
            let fs = frames.summary();
            app.status = format!(
                "frames {} · frame p95 {} ms · echo p95 {} ms · live events {} · {} lines/s/pane · {}",
                frame_no, fs["p95_ms"], echo.summary()["p95_ms"], live_events, rate as u64,
                if ws.is_some() { format!("/term {} B", ws_bytes) } else { "replay".into() }
            );
        }
        let wait = match (dirty, last_frame) {
            (false, _) => Duration::from_secs(3600),
            (true, None) => Duration::ZERO,
            (true, Some(l)) => (l + FRAME_MIN).saturating_duration_since(Instant::now()),
        };
        tokio::select! {
            biased;
            ev = events.next() => {
                let Some(Ok(ev)) = ev else { break };
                match ev {
                    Event::Key(k) if k.kind != KeyEventKind::Release => {
                        let received = Instant::now();
                        if k.code == KeyCode::Char('c') && k.modifiers.contains(KeyModifiers::CONTROL) { break }
                        if k.code == KeyCode::Tab && ws.is_some() { app.term_focus = !app.term_focus; }
                        else if app.term_focus {
                            if let (Some(sock), Some(b)) = (ws.as_mut(), key_bytes(k.code, k.modifiers)) {
                                let d = String::from_utf8_lossy(&b).into_owned();
                                sock.send(Message::text(json!({ "t": "in", "d": d }).to_string())).await?;
                            }
                        } else {
                            match k.code {
                                KeyCode::Char(c) => app.steer.push(c),
                                KeyCode::Backspace => { app.steer.pop(); }
                                KeyCode::Esc => app.steer.clear(),
                                KeyCode::Enter => { let s = std::mem::take(&mut app.steer); app.sent.push(s); }
                                _ => {}
                            }
                        }
                        // Echo in the same frame: drawn now, not at the next cap slot.
                        let done = draw_frame(&mut term, &mut app, &mut frames, &mut intervals, &mut last_frame, &mut frame_no)?;
                        echo.push(done - received);
                        tracing::info!(echo_us = (done - received).as_micros() as u64, "key echoed");
                        dirty = false;
                    }
                    Event::Paste(p) => { if !app.term_focus { app.steer.push_str(&p); } dirty = true; }
                    Event::Resize(_, _) => { resizes += 1; dirty = true; last_frame = None; }
                    _ => {}
                }
            }
            _ = tokio::time::sleep(wait), if dirty => {
                draw_frame(&mut term, &mut app, &mut frames, &mut intervals, &mut last_frame, &mut frame_no)?;
                dirty = false;
                // A live terminal follows its pane's size.
                let inner = app.term_inner.get();
                if let Some(sock) = ws.as_mut() {
                    if inner != sent_size && inner.0 >= 1 && inner.1 >= 2 {
                        sent_size = inner;
                        app.vt.screen_mut().set_size(inner.0, inner.1);
                        sock.send(Message::text(json!({ "t": "resize", "cols": inner.1, "rows": inner.0 }).to_string())).await?;
                    }
                }
            }
            _ = feed.tick() => {
                let now = Instant::now();
                carry += rate * (now - fed_at).as_secs_f64();
                fed_at = now;
                let n = carry.floor() as usize;
                carry -= n as f64;
                if n > 0 { app.feed_all(n); dirty = true; }
                if let Some(r) = replay.as_mut() {
                    vt_buf.clear();
                    r.advance(now - start, &mut vt_buf);
                    if !vt_buf.is_empty() { app.vt.process(&vt_buf); }
                }
                if let Some(q) = auto_quit { if now - start >= q { break } }
            }
            m = async { match ws.as_mut() { Some(s) => s.next().await, None => std::future::pending().await } } => {
                match m {
                    Some(Ok(Message::Binary(b))) => { ws_bytes += b.len(); app.vt.process(&b); dirty = true; }
                    Some(Ok(Message::Text(_))) => {}
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => { ws = None; app.vt_title = "live /term (closed)".into(); dirty = true; }
                    Some(Ok(_)) => {}
                }
            }
            Some(ev) = live_rx.recv() => {
                live_events += 1;
                tracing::info!(event = %ev.event, bytes = ev.data.len(), "live");
                dirty = true;
            }
        }
    }
    drop(term);
    restore();
    let elapsed = start.elapsed().as_secs_f64();
    let report = json!({
        "elapsed_s": (elapsed * 100.0).round() / 100.0,
        "frames": frame_no, "fps": ((frame_no as f64 / elapsed) * 10.0).round() / 10.0,
        "frame_time": frames.summary(), "frame_interval": intervals.summary(), "key_to_flush": echo.summary(),
        "resizes": resizes, "live_events": live_events, "term_ws_bytes": ws_bytes, "engine": engine_notes,
        "lines_per_pane": app.panes[0].total,
    });
    if let Some(p) = stats_out {
        std::fs::write(p, serde_json::to_string_pretty(&report)?)?;
    } else {
        println!("{}", serde_json::to_string_pretty(&report)?);
    }
    Ok(())
}
