//! The real-terminal loop: tokio select over crossterm's EventStream, the engine's answers and `/live` signals, a
//! tick, and frame requests. Alternate screen; DEC 2026 synchronized output around every frame; frames drawn on
//! request, capped at ~120 fps; a key is applied and echoed in a frame drawn at once (never waiting for the cap); a
//! take-over's output is parsed in turns of at most PARSE_SLICE, keys read first, and its echo drawn as it lands;
//! kitty keyboard where the terminal offers it; mouse; bracketed paste; a panic hook that gives the terminal back.
use crate::app::{App, Effect, Msg, EXIT_LEAVE};
use crate::stats::Samples;
use crate::text::clean;
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
use toolroll_api::{ApiError, Client, LiveSignal, TermSend};

const FRAME_MIN: Duration = Duration::from_micros(8_333);
/// While someone types into a terminal, its output is drawn this often at most (the echo waits no longer than this
/// for a frame, and a busy program's output can't cost a frame per chunk).
const ECHO_FRAME_MIN: Duration = Duration::from_millis(3);
/// How long a key keeps the faster frames above (its echo comes back through the console).
const ECHO_WINDOW: Duration = Duration::from_millis(250);
/// Terminal output already waiting is parsed in one turn for up to this long; the rest waits its turn, so a key never
/// waits behind more than this (keys are read first each turn), and nothing is dropped or reordered: the rest stays
/// queued in order, and still counts against the socket's output budget (the console slows the program meanwhile).
const PARSE_SLICE: Duration = Duration::from_millis(4);

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
    let env = crate::settings::Env::from_process();
    let prefs = crate::settings::start(&env);
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
    let result = event_loop(&mut term, client, &mut opts, prefs, &env).await;
    drop(term);
    restore();
    result
}

struct Loop {
    client: Client,
    tx: mpsc::UnboundedSender<Msg>,
    watch: Option<JoinHandle<()>>,
    watching: Vec<String>,
    /// The one terminal socket held (T4): the terminal the pane shows, by id. Dropping it closes the socket; the
    /// program keeps running in the console.
    term: Option<(String, mpsc::UnboundedSender<TermSend>)>,
}

/// Take over: this session's own terminal on that task's build (the console lists only its own), else a new one; listed
/// again (it must still be this session's) before it is attached; its frames come back as messages until it closes.
async fn open_terminal(client: Client, tx: mpsc::UnboundedSender<Msg>, task: String, run: i64) {
    let fail = |e: ApiError| {
        let _ = tx.send(Msg::TermOpened {
            task: task.clone(),
            run,
            result: Err(e),
        });
    };
    let mine = |state: &toolroll_api::TermState| {
        state
            .sessions
            .iter()
            .find(|one| {
                one.task.as_deref() == Some(task.as_str())
                    && one.run == Some(run)
                    && one.ended_at.is_none()
            })
            .map(|one| (one.id.clone(), one.branch.clone()))
    };
    let listed = match client.term_state().await {
        Ok(state) => mine(&state),
        Err(e) => return fail(e),
    };
    if listed.is_none() {
        if let Err(e) = client.term_start(&task, run, "shell").await {
            return fail(e);
        }
    }
    // Whichever it is, attached only as the console lists it for this session now.
    let (id, branch) = match client.term_state().await {
        Ok(state) => match mine(&state) {
            Some(found) => found,
            None => {
                return fail(ApiError::Refused(
                    "That terminal isn't yours to open any more.".into(),
                ))
            }
        },
        Err(e) => return fail(e),
    };
    let (send, mut events, _held) = match client.term_connect(&id).await {
        Ok(three) => three,
        Err(e) => return fail(e),
    };
    if tx
        .send(Msg::TermOpened {
            task: task.clone(),
            run,
            result: Ok((id.clone(), branch, crate::app::TermLink(send))),
        })
        .is_err()
    {
        return;
    }
    while let Some(event) = events.recv().await {
        if tx.send(Msg::Term(id.clone(), event)).is_err() {
            return;
        }
    }
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
            Effect::FetchAgents => drop(tokio::spawn(async move {
                let _ = tx.send(Msg::Agents(client.agents().await));
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
            Effect::FetchThreads => drop(tokio::spawn(async move {
                let _ = tx.send(Msg::Threads(client.threads().await));
            })),
            Effect::FetchThread {
                thread,
                cursor,
                known,
                wait,
            } => drop(tokio::spawn(async move {
                let r = client
                    .thread_window(&thread, cursor.as_deref(), known.as_deref(), wait)
                    .await;
                let _ = tx.send(Msg::Thread(thread, r));
            })),
            Effect::FetchContext(ask) => drop(tokio::spawn(async move {
                let r = client
                    .diff_context(&ask.task, ask.run, ask.file, ask.from, ask.count)
                    .await;
                let _ = tx.send(Msg::Context(ask, r));
            })),
            Effect::Send {
                acts,
                task,
                run,
                text,
            } => drop(tokio::spawn(async move {
                let _ = tx.send(send_batch(&client, acts, task, run, text).await);
            })),
            Effect::Scrollback(lines) => {
                // The normal screen, mouse off (so the person can select), the lines, then a word on how to come back.
                let out = term.backend_mut();
                let _ = crossterm::execute!(out, DisableMouseCapture, LeaveAlternateScreen);
                let mut text = String::new();
                for line in &lines {
                    text.push_str(&clean(line));
                    text.push_str("\r\n");
                }
                text.push_str(
                    "\r\n(Copied by Toolroll. Select it now; press any key to go back.)\r\n",
                );
                let _ = out.write_all(text.as_bytes());
                let _ = out.flush();
            }
            Effect::ResumeScreen => {
                let out = term.backend_mut();
                let _ = crossterm::execute!(out, EnterAlternateScreen, EnableMouseCapture);
                // Every cell painted again, without asking the terminal anything (ratatui's clear asks for the cursor,
                // which would race the key reader): one frame unlike any real one, then the real one over it.
                let _ = term.draw(|f| {
                    let area = f.area();
                    f.buffer_mut().set_style(
                        area,
                        ratatui::style::Style::default()
                            .add_modifier(ratatui::style::Modifier::HIDDEN),
                    );
                });
            }
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
            Effect::TermOpen { task, run } => {
                drop(tokio::spawn(open_terminal(client, tx, task, run)));
            }
            Effect::FetchModels => drop(tokio::spawn(async move {
                let _ = tx.send(Msg::Models(client.models().await));
            })),
            Effect::CheckAgents => drop(tokio::spawn(async move {
                let _ = tx.send(Msg::Agents(client.agents_check().await));
            })),
            Effect::AgentTerm {
                kind,
                agent,
                confirm,
            } => {
                drop(tokio::spawn(open_agent_terminal(
                    client, tx, kind, agent, confirm,
                )));
            }
            Effect::TermSend { id, send } => {
                // Only the terminal the pane shows: anything else is dropped.
                if let Some((held, link)) = &self.term {
                    if *held == id {
                        let _ = link.send(send);
                    }
                }
            }
            Effect::TermDetach(id) => {
                if self.term.as_ref().is_some_and(|(held, _)| *held == id) {
                    self.term = None;
                }
            }
        }
        None
    }
}

/// An agent's own sign-in or confirmed install (the Agents screen): the console starts its own command for that agent,
/// answering the terminal's id, which is then attached; its pane is `agent:<id>`.
async fn open_agent_terminal(
    client: Client,
    tx: mpsc::UnboundedSender<Msg>,
    kind: String,
    agent: String,
    confirm: Option<String>,
) {
    let task = format!("agent:{agent}");
    let fail = |e: ApiError| {
        let _ = tx.send(Msg::TermOpened {
            task: task.clone(),
            run: 0,
            result: Err(e),
        });
    };
    let id = match client.term_agent(&kind, &agent, confirm.as_deref()).await {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let (send, mut events, _held) = match client.term_connect(&id).await {
        Ok(three) => three,
        Err(e) => return fail(e),
    };
    if tx
        .send(Msg::TermOpened {
            task: task.clone(),
            run: 0,
            result: Ok((id.clone(), String::new(), crate::app::TermLink(send))),
        })
        .is_err()
    {
        return;
    }
    while let Some(event) = events.recv().await {
        if tx.send(Msg::Term(id.clone(), event)).is_err() {
            return;
        }
    }
}

/// A batch's acts in turn, stopping at the first that isn't kept; the answer says how many were kept before it.
pub async fn send_batch(
    client: &Client,
    acts: Vec<crate::app::SendAct>,
    task: String,
    run: i64,
    text: String,
) -> Msg {
    let mut kept = 0;
    let mut result = Ok(toolroll_api::ActOutcome::Done(String::new()));
    for act in acts {
        let pairs: Vec<(&str, &str)> = act
            .fields
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        result = client.act(&act.path, &pairs, &act.done).await;
        if !matches!(result, Ok(toolroll_api::ActOutcome::Done(_))) {
            break;
        }
        kept += 1;
    }
    // (The last act kept isn't counted as "kept before a refusal": a full batch is Done.)
    if matches!(result, Ok(toolroll_api::ActOutcome::Done(_))) {
        kept = 0;
    }
    Msg::Sent {
        task,
        run,
        text,
        kept,
        result,
    }
}

async fn event_loop(
    term: &mut Term,
    client: Client,
    opts: &mut Options,
    prefs: crate::settings::Prefs,
    env: &crate::settings::Env,
) -> std::io::Result<i32> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Msg>();
    let mut lp = Loop {
        client: client.clone(),
        tx: tx.clone(),
        watch: None,
        watching: vec![],
        term: None,
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
    app.origin = Some(client.origin().to_string());
    // Where the last run left off (state.rs): our own small file, read only when it is safe to.
    let state_path = crate::state::path(env);
    app.restore = state_path.as_deref().and_then(crate::state::load);
    let mut saved = app.restore.clone();
    let mut last_save = Instant::now();
    // Clickable links follow the theme's rules (NO_COLOR, tmux): link.rs.
    let links_on = crate::link::enabled(env.no_color, env.tmux, prefs.settings.tmux_passthrough);
    app.status = prefs.first_warning().map(|w| (crate::app::Tone::Said, w));
    app.split = prefs.settings.list_width();
    // A background answer that comes late is dropped, never read as keys (for about a second from now).
    let watch = if prefs.late_reply {
        Duration::from_secs(1)
    } else {
        Duration::ZERO
    };
    let mut late = crate::theme::LateReply::new(Instant::now() + watch);
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
    let mut last_key: Option<Instant> = None;
    // The first output after a key is drawn at once, however recent the key's own frame (no timer between a key and
    // its echo: a short sleep can wake late); later output waits ECHO_FRAME_MIN between frames.
    let mut output_since_key = false;
    let mut dirty = true;
    let mut exit: Option<i32> = None;

    let draw = |term: &mut Term, app: &mut App, frames: &mut Samples| -> std::io::Result<Instant> {
        let t = Instant::now();
        // The screen has stepped aside for the scrollback (a copied hunk): nothing is drawn over it.
        if app.mode == crate::app::Mode::Copied {
            return Ok(t);
        }
        crossterm::queue!(term.backend_mut(), BeginSynchronizedUpdate)?;
        let frame = term.draw(|f| view::draw(f, app))?;
        // Our own links made clickable over the frame just drawn (never anything an agent wrote).
        let links = if links_on {
            crate::link::overlay(frame.buffer, &app.areas.links)
        } else {
            String::new()
        };
        if !links.is_empty() {
            term.backend_mut().write_all(links.as_bytes())?;
        }
        crossterm::queue!(term.backend_mut(), EndSynchronizedUpdate)?;
        term.backend_mut().flush()?;
        let done = Instant::now();
        frames.push(done - t);
        Ok(done)
    };

    // Where the person is, kept at most every two seconds while it changes, and on the way out (state.rs).
    let mut keep_place = |app: &App, force: bool| {
        let Some(path) = state_path.as_deref() else {
            return;
        };
        if !app.loaded || matches!(app.mode, crate::app::Mode::Fatal(..)) {
            return;
        }
        let now = app.resume_state();
        if saved.as_ref() == Some(&now) || (!force && last_save.elapsed() < Duration::from_secs(2))
        {
            return;
        }
        last_save = Instant::now();
        if crate::state::save(path, &now).is_ok() {
            saved = Some(now);
        }
    };
    loop {
        for fx in pending.drain(..) {
            if let Some(code) = lp.effect(fx, term, opts, &mut app) {
                exit = Some(code);
            }
        }
        keep_place(&app, false);
        if exit.is_some() {
            break;
        }
        // Typing into a terminal: its output (the echo among it) is drawn sooner.
        let typing = app.mode == crate::app::Mode::TakeOver
            && last_key.is_some_and(|k| k.elapsed() < ECHO_WINDOW);
        let gap = if typing { ECHO_FRAME_MIN } else { FRAME_MIN };
        let wait = match (dirty, last_frame) {
            (false, _) => Duration::from_secs(3600),
            (true, None) => Duration::ZERO,
            (true, Some(l)) => (l + gap).saturating_duration_since(Instant::now()),
        };
        tokio::select! {
            biased;
            ev = events.next() => {
                let Some(Ok(ev)) = ev else { break };
                match ev {
                    Event::Key(k) if k.kind != KeyEventKind::Release => {
                        let received = Instant::now();
                        let keys = late.feed(k, received);
                        if keys.is_empty() {
                            continue;
                        }
                        for k in keys {
                            pending.extend(app.key(k));
                        }
                        // Echoed in the same frame: drawn now, not at the next cap slot.
                        // (Effects first: a key that hands the screen to the scrollback must not paint over it.)
                        for fx in pending.drain(..) {
                            if let Some(code) = lp.effect(fx, term, opts, &mut app) {
                                exit = Some(code);
                            }
                        }
                        let done = draw(term, &mut app, &mut frames)?;
                        last_frame = Some(done);
                        last_key = Some(received);
                        output_since_key = false;
                        echo.push(done - received);
                        pending.extend(app.term_resize());
                        // Colouring left for later frames: draw again at the next slot.
                        dirty = app.highlight_pending;
                    }
                    Event::Paste(p) => { pending.extend(app.paste(&p)); dirty = true; }
                    Event::Mouse(m) => { pending.extend(app.mouse(m)); dirty = true; }
                    // Drawn at once: a key right behind a resize meets the new layout (a terminal that no longer fits
                    // takes no keys), and the terminal hears its new size.
                    Event::Resize(_, _) => {
                        last_frame = Some(draw(term, &mut app, &mut frames)?);
                        dirty = app.highlight_pending;
                        pending.extend(app.term_resize());
                    }
                    _ => {}
                }
            }
            _ = tokio::time::sleep(wait), if dirty => {
                last_frame = Some(draw(term, &mut app, &mut frames)?);
                dirty = app.highlight_pending;
                pending.extend(app.term_resize());
            }
            _ = tick.tick() => {
                for k in late.flush(Instant::now()) {
                    pending.extend(app.key(k));
                    dirty = true;
                }
                let now = now_secs();
                if now != app.now { app.now = now; dirty = true; }
                pending.extend(app.update(Msg::Tick));
            }
            Some(msg) = rx.recv() => {
                // Terminal output already waiting is taken in this turn too, in order, for up to PARSE_SLICE (one
                // frame for all of it, not one per chunk); anything else ends the turn after it.
                let turn = Instant::now();
                let mut next = Some(msg);
                let mut output = false;
                while let Some(msg) = next.take() {
                    // A take-over's socket: held here (the newest replaces the last, whose socket then closes).
                    if let Msg::TermOpened { result: Ok((id, _, link)), .. } = &msg {
                        lp.term = Some((id.clone(), link.0.clone()));
                    }
                    let is_output = matches!(msg, Msg::Term(_, toolroll_api::TermEvent::Output(_)));
                    output |= is_output;
                    pending.extend(app.update(msg));
                    // Each message's effects before the next message, as one turn each would have run them.
                    for fx in pending.drain(..) {
                        if let Some(code) = lp.effect(fx, term, opts, &mut app) {
                            exit = Some(code);
                        }
                    }
                    if is_output && exit.is_none() && turn.elapsed() < PARSE_SLICE {
                        next = rx.try_recv().ok();
                    }
                }
                dirty = true;
                // Typed input's echo: drawn as soon as its output is parsed while the person is typing (never waiting
                // for the frame cap), at most every ECHO_FRAME_MIN.
                let echo_now = output
                    && app.mode == crate::app::Mode::TakeOver
                    && last_key.is_some_and(|k| k.elapsed() < ECHO_WINDOW)
                    && (!output_since_key || last_frame.is_none_or(|l| l.elapsed() >= ECHO_FRAME_MIN));
                if echo_now {
                    output_since_key = true;
                    last_frame = Some(draw(term, &mut app, &mut frames)?);
                    dirty = app.highlight_pending;
                    pending.extend(app.term_resize());
                }
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
    keep_place(&app, true);
    workspace.abort();
    if let Some(h) = lp.watch.take() {
        h.abort();
    }
    if let Some(path) = &opts.stats_out {
        let report = serde_json::json!({ "frame_time": frames.summary(), "key_to_flush": echo.summary(),
            "term_bytes_parsed": app.term.as_ref().map(|p| p.parsed) });
        let _ = std::fs::write(
            path,
            serde_json::to_string_pretty(&report).unwrap_or_default(),
        );
    }
    Ok(exit.unwrap_or(EXIT_LEAVE))
}
