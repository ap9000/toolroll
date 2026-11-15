//! The real-terminal loop: tokio select over crossterm's EventStream, the engine's answers and `/live` signals, a
//! tick, and frame requests. Alternate screen; DEC 2026 synchronized output around every frame; frames drawn on
//! request, capped at ~120 fps; a key is applied and echoed in a frame drawn at once (never waiting for the cap);
//! kitty keyboard where the terminal offers it; mouse; bracketed paste; a panic hook that gives the terminal back.
use crate::app::{App, Effect, Msg, EXIT_LEAVE};
use crate::stats::Samples;
use crate::view;
use crossterm::event::{
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture, Event,
    EventStream, KeyEventKind, KeyboardEnhancementFlags, PopKeyboardEnhancementFlags,
    PushKeyboardEnhancementFlags,
};
use crossterm::terminal::{
    self, BeginSynchronizedUpdate, EndSynchronizedUpdate, EnterAlternateScreen,
    LeaveAlternateScreen,
};
use futures_util::StreamExt;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use std::io::{BufWriter, Stdout, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use toolroll_api::{ApiError, Client, LiveSignal};

const FRAME_MIN: Duration = Duration::from_micros(8_333);

type Term = Terminal<CrosstermBackend<BufWriter<Stdout>>>;

static KITTY: AtomicBool = AtomicBool::new(false);
/// The terminal's own title was kept (notify::TITLE_PUSH) and is given back on the way out.
static TITLE: AtomicBool = AtomicBool::new(false);

/// Give the terminal back: whatever state the screen left it in (also from the panic hook).
pub fn restore() {
    let mut out = std::io::stdout();
    if TITLE.swap(false, Ordering::SeqCst) {
        let _ = out.write_all(crate::notify::TITLE_POP.as_bytes());
    }
    if KITTY.swap(false, Ordering::SeqCst) {
        let _ = crossterm::execute!(out, PopKeyboardEnhancementFlags);
    }
    let _ = crossterm::execute!(
        out,
        DisableBracketedPaste,
        DisableMouseCapture,
        LeaveAlternateScreen,
        crossterm::cursor::Show
    );
    let _ = terminal::disable_raw_mode();
}

pub struct Options {
    pub owned: bool,
    pub project: Option<String>,
    /// Where asks to the launcher go (descriptor 4), when it gave one.
    pub control: Option<std::fs::File>,
    pub stats_out: Option<String>,
    /// Nothing can be shown (the console speaks another contract): the words, and the exit code a key ends with.
    pub fatal: Option<(String, i32)>,
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Run the screen until it ends; its exit code.
pub async fn run(client: Client, mut opts: Options) -> std::io::Result<i32> {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore();
        prev(info);
    }));
    terminal::enable_raw_mode()?;
    // Settings, the terminal's colours and background (asked before anything else reads the keyboard), and where
    // notifications go.
    let prefs = crate::settings::start(&crate::settings::Env::from_process());
    let mut stdout = std::io::stdout();
    stdout.write_all(crate::notify::TITLE_PUSH.as_bytes())?;
    TITLE.store(true, Ordering::SeqCst);
    crossterm::execute!(
        stdout,
        EnterAlternateScreen,
        EnableBracketedPaste,
        EnableMouseCapture
    )?;
    if terminal::supports_keyboard_enhancement().unwrap_or(false) {
        crossterm::execute!(
            stdout,
            PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
        )?;
        KITTY.store(true, Ordering::SeqCst);
    }
    let backend = CrosstermBackend::new(BufWriter::with_capacity(1 << 18, std::io::stdout()));
    let mut term: Term = Terminal::new(backend)?;
    let result = event_loop(&mut term, client, &mut opts, prefs).await;
    drop(term);
    restore();
    result
}

struct Loop {
    client: Client,
    tx: mpsc::UnboundedSender<Msg>,
    watch: Option<JoinHandle<()>>,
    watching: Vec<String>,
}

impl Loop {
    fn spawn_live(&self, rooms: Vec<String>) -> JoinHandle<()> {
        let client = self.client.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            // Reopened when it ends (a `reload`, a restart), a second apart; a session that ended says so once.
            loop {
                let (stx, mut srx) = mpsc::unbounded_channel();
                let c2 = client.clone();
                let rooms2 = rooms.clone();
                let stream = tokio::spawn(async move { c2.live(&rooms2, stx).await });
                while let Some(signal) = srx.recv().await {
                    if signal == LiveSignal::Ended {
                        break;
                    }
                    if tx.send(Msg::Signal(signal)).is_err() {
                        return;
                    }
                }
                if let Ok(Err(ApiError::SessionEnded)) = stream.await {
                    let _ = tx.send(Msg::Work(Err(ApiError::SessionEnded)));
                    return;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        })
    }

    fn effect(
        &mut self,
        fx: Effect,
        term: &mut Term,
        opts: &mut Options,
        app: &mut App,
    ) -> Option<i32> {
        let client = self.client.clone();
        let tx = self.tx.clone();
        match fx {
            Effect::FetchWork => drop(tokio::spawn(async move {
                let _ = tx.send(Msg::Work(client.work_rows().await));
            })),
            Effect::FetchSteps(task) => drop(tokio::spawn(async move {
                let r = client.steps(&task).await;
                let _ = tx.send(Msg::Steps(task, r));
            })),
            Effect::FetchLive { run, file, cursor } => drop(tokio::spawn(async move {
                let r = client.live_window(run, file, cursor.as_deref()).await;
                let _ = tx.send(Msg::Live(run, file, r));
            })),
            Effect::FetchDiff(ask) => drop(tokio::spawn(async move {
                let r = client.diff(&ask.task, ask.run).await;
                let _ = tx.send(Msg::Diff(ask, r));
            })),
            Effect::FetchDiffFile(ask) => drop(tokio::spawn(async move {
                let r = client.diff_file(&ask.task, ask.run, ask.file).await;
                let _ = tx.send(Msg::DiffFile(ask, r));
            })),
            Effect::Act { path, fields, done } => drop(tokio::spawn(async move {
                let pairs: Vec<(&str, &str)> = fields
                    .iter()
                    .map(|(k, v)| (k.as_str(), v.as_str()))
                    .collect();
                let _ = tx.send(Msg::Acted(client.act(&path, &pairs, &done).await));
            })),
            Effect::Watch(rooms) => {
                if rooms != self.watching {
                    if let Some(h) = self.watch.take() {
                        h.abort();
                    }
                    if !rooms.is_empty() {
                        self.watch = Some(self.spawn_live(rooms.clone()));
                    }
                    self.watching = rooms;
                }
            }
            Effect::OpenBrowser => match opts.control.as_mut() {
                Some(control) => {
                    if control
                        .write_all(b"{\"want\":\"browser\"}\n")
                        .and_then(|_| control.flush())
                        .is_err()
                    {
                        app.update(Msg::Acted(Ok(toolroll_api::ActOutcome::Refused(
                            "The browser couldn't be opened from here.".into(),
                        ))));
                    }
                }
                None => {
                    let words = format!("Open {} in your browser.", self.client.origin());
                    app.status = Some((crate::app::Tone::Said, words));
                }
            },
            Effect::Notify(words) => {
                // A desktop notification and the bell, as the settings say, between frames (notify.rs builds the
                // bytes, from our own constants and words).
                let bytes =
                    crate::notify::sequence(&words, app.prefs.reach, app.prefs.settings.bell);
                let out = term.backend_mut();
                let _ = out.write_all(bytes.as_bytes());
                let _ = out.flush();
            }
            Effect::Exit(code) => return Some(code),
        }
        None
    }
}

async fn event_loop(
    term: &mut Term,
    client: Client,
    opts: &mut Options,
    prefs: crate::settings::Prefs,
) -> std::io::Result<i32> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Msg>();
    let mut lp = Loop {
        client: client.clone(),
        tx: tx.clone(),
        watch: None,
        watching: vec![],
    };
    // The launcher's answers on descriptor 4 (one JSON line each, capped): read on a thread of their own.
    if let Some(reader) = opts.control.as_ref().and_then(|c| c.try_clone().ok()) {
        let tx = tx.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(reader).lines() {
                let Ok(line) = line else { break };
                if line.len() > 2048 {
                    continue;
                }
                if let Some(said) = serde_json::from_str::<serde_json::Value>(&line)
                    .ok()
                    .and_then(|v| v["said"].as_str().map(str::to_owned))
                {
                    if tx.send(Msg::Said(said)).is_err() {
                        break;
                    }
                }
            }
        });
    }
    let mut app = App::new(opts.owned, opts.project.clone());
    app.now = now_secs();
    app.status = prefs.first_warning().map(|w| (crate::app::Tone::Said, w));
    app.split = prefs.settings.list_width();
    app.prefs = prefs;
    let mut titled: Option<i64> = None;
    // The workspace room, for as long as the screen is open.
    let workspace = lp.spawn_live(vec!["workspace".into()]);
    let mut pending: Vec<Effect> = vec![Effect::FetchWork];
    app.fetching_work = true;
    if let Some((words, code)) = opts.fatal.take() {
        app.mode = crate::app::Mode::Fatal(words, code);
        pending.clear();
    }
    let mut events = EventStream::new();
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut frames = Samples::default();
    let mut echo = Samples::default();
    let mut last_frame: Option<Instant> = None;
    let mut dirty = true;
    let mut exit: Option<i32> = None;

    let draw = |term: &mut Term, app: &mut App, frames: &mut Samples| -> std::io::Result<Instant> {
        let t = Instant::now();
        crossterm::queue!(term.backend_mut(), BeginSynchronizedUpdate)?;
        term.draw(|f| view::draw(f, app))?;
        crossterm::queue!(term.backend_mut(), EndSynchronizedUpdate)?;
        term.backend_mut().flush()?;
        let done = Instant::now();
        frames.push(done - t);
        Ok(done)
    };

    loop {
        for fx in pending.drain(..) {
            if let Some(code) = lp.effect(fx, term, opts, &mut app) {
                exit = Some(code);
            }
        }
        if exit.is_some() {
            break;
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
                        pending.extend(app.key(k));
                        // Echoed in the same frame: drawn now, not at the next cap slot.
                        let done = draw(term, &mut app, &mut frames)?;
                        last_frame = Some(done);
                        echo.push(done - received);
                        dirty = false;
                    }
                    Event::Paste(p) => { app.paste(&p); dirty = true; }
                    Event::Mouse(m) => { pending.extend(app.mouse(m)); dirty = true; }
                    Event::Resize(_, _) => { dirty = true; last_frame = None; }
                    _ => {}
                }
            }
            _ = tokio::time::sleep(wait), if dirty => {
                last_frame = Some(draw(term, &mut app, &mut frames)?);
                dirty = false;
            }
            _ = tick.tick() => {
                let now = now_secs();
                if now != app.now { app.now = now; dirty = true; }
                pending.extend(app.update(Msg::Tick));
            }
            Some(msg) = rx.recv() => {
                pending.extend(app.update(msg));
                dirty = true;
                // The window title: how many wait on you (our words and a number, nothing else).
                if app.loaded && titled != Some(app.needs_count) {
                    titled = Some(app.needs_count);
                    let out = term.backend_mut();
                    let _ = out.write_all(crate::notify::title_sequence(app.needs_count).as_bytes());
                    let _ = out.flush();
                }
            }
        }
    }
    workspace.abort();
    if let Some(h) = lp.watch.take() {
        h.abort();
    }
    if let Some(path) = &opts.stats_out {
        let report =
            serde_json::json!({ "frame_time": frames.summary(), "key_to_flush": echo.summary() });
        let _ = std::fs::write(
            path,
            serde_json::to_string_pretty(&report).unwrap_or_default(),
        );
    }
    Ok(exit.unwrap_or(EXIT_LEAVE))
}
