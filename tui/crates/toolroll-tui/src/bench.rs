//! Headless render benchmark: the same draw as `run`, timed per frame on (1) ratatui's TestBackend and
//! (2) the real CrosstermBackend encoding escapes into memory (DEC 2026 begin/end around each frame).
use crate::app::{draw, App};
use crate::recording::{Recording, Replay};
use crate::stats::Samples;
use crate::Args;
use anyhow::Result;
use crossterm::terminal::{BeginSynchronizedUpdate, EndSynchronizedUpdate};
use ratatui::backend::{CrosstermBackend, TestBackend};
use ratatui::layout::Rect;
use ratatui::{Terminal, TerminalOptions, Viewport};
use std::io::Write;
use std::time::{Duration, Instant};

pub fn main(args: &Args) -> Result<()> {
    let frames: usize = args.num("--frames", 2000);
    let w: u16 = args.num("--width", 200);
    let h: u16 = args.num("--height", 60);
    let rate: f64 = args.num("--rate", 10_000.0);
    let fps: f64 = args.num("--fps", 120.0);
    let vt_speed: f64 = args.num("--vt-speed", 10.0);
    let recording = args.value("--recording");
    crate::app::NOISY.store(args.flag("--noisy"), std::sync::atomic::Ordering::Relaxed);
    let per_frame_lines = (rate / fps).ceil() as usize;
    let frame_dt = Duration::from_secs_f64(1.0 / fps);

    let make_app = || -> Result<(App, Option<Replay>)> {
        let replay = match &recording {
            Some(p) => Some(Replay::new(Recording::load(p)?)),
            None => None,
        };
        let (r, c) = replay.as_ref().map(|r| r.size()).unwrap_or((24, 80));
        let mut app = App::new(r, c, "recorded session (vt100)".into());
        // Fill the rings to capacity first: the bench measures a full 100k-line ring per pane.
        app.feed_all(crate::app::RING_LINES);
        app.steer = "keep the alias, add a deprecation log line".into();
        Ok((app, replay))
    };

    let mut out = serde_json::Map::new();
    out.insert("size".into(), format!("{w}x{h}").into());
    out.insert("noisy".into(), args.flag("--noisy").into());
    out.insert("frames".into(), frames.into());
    out.insert("lines_per_pane_per_frame".into(), per_frame_lines.into());
    out.insert("ring_lines_per_pane".into(), crate::app::RING_LINES.into());

    // (1) TestBackend.
    {
        let (mut app, mut replay) = make_app()?;
        let mut term = Terminal::new(TestBackend::new(w, h))?;
        let mut s = Samples::default();
        let mut vt_bytes = 0usize;
        let mut buf = Vec::new();
        for i in 0..frames {
            app.feed_all(per_frame_lines);
            if let Some(r) = replay.as_mut() {
                buf.clear();
                r.advance(frame_dt.mul_f64(i as f64 * vt_speed), &mut buf);
                vt_bytes += buf.len();
                app.vt.process(&buf);
            }
            let t = Instant::now();
            term.draw(|f| draw(f, &app))?;
            s.push(t.elapsed());
        }
        out.insert("testbackend".into(), s.summary());
        out.insert("vt_bytes_replayed".into(), vt_bytes.into());
        out.insert(
            "vt_loops".into(),
            replay.map(|r| r.loops).unwrap_or(0).into(),
        );
    }

    // (2) CrosstermBackend into memory, with synchronized output per frame; also feeding cost.
    {
        let (mut app, mut replay) = make_app()?;
        let counter = std::rc::Rc::new(std::cell::Cell::new(0usize));
        let backend = CrosstermBackend::new(CountingSink(counter.clone()));
        let mut term = Terminal::with_options(
            backend,
            TerminalOptions {
                viewport: Viewport::Fixed(Rect::new(0, 0, w, h)),
            },
        )?;
        let mut draw_s = Samples::default();
        let mut feed_s = Samples::default();
        let mut bytes = 0usize;
        let mut buf = Vec::new();
        for i in 0..frames {
            let t0 = Instant::now();
            app.feed_all(per_frame_lines);
            if let Some(r) = replay.as_mut() {
                buf.clear();
                r.advance(frame_dt.mul_f64(i as f64 * vt_speed), &mut buf);
                app.vt.process(&buf);
            }
            feed_s.push(t0.elapsed());
            let t = Instant::now();
            crossterm::queue!(term.backend_mut(), BeginSynchronizedUpdate)?;
            term.draw(|f| draw(f, &app))?;
            crossterm::queue!(term.backend_mut(), EndSynchronizedUpdate)?;
            term.backend_mut().flush()?;
            draw_s.push(t.elapsed());
            bytes += counter.replace(0);
        }
        out.insert("crossterm_mem".into(), draw_s.summary());
        out.insert("feed_per_frame".into(), feed_s.summary());
        out.insert(
            "escape_bytes_per_frame_mean".into(),
            (bytes / frames.max(1)).into(),
        );
    }

    // (3) Resize churn on TestBackend: a different size every frame (full redraws).
    {
        let (mut app, _) = make_app()?;
        let mut term = Terminal::new(TestBackend::new(w, h))?;
        let sizes = [(w, h), (120, 40), (80, 24), (160, 50), (240, 70)];
        let mut s = Samples::default();
        for i in 0..frames.min(1000) {
            let (sw, sh) = sizes[i % sizes.len()];
            term.backend_mut().resize(sw, sh);
            app.feed_all(per_frame_lines);
            let t = Instant::now();
            term.draw(|f| draw(f, &app))?;
            s.push(t.elapsed());
        }
        out.insert("resize_every_frame_testbackend".into(), s.summary());
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::Value::Object(out))?
    );
    Ok(())
}

/// Discards what the backend writes, counting the bytes (the escape stream a real terminal would get).
struct CountingSink(std::rc::Rc<std::cell::Cell<usize>>);
impl Write for CountingSink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.set(self.0.get() + buf.len());
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
