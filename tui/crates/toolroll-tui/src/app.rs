//! The screen's state and what changes it: one struct, updated by keys, mouse and engine answers, drawn immediate-mode
//! each frame (view.rs). Nothing here talks to the network: an update returns the effects the loop runs (run.rs), so
//! every screen state can be built and snapshotted from fixtures.
use crate::text::clean;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::Rect;
use toolroll_api::{
    ActOutcome, ApiError, LiveRecord, LiveSessionWindow, LiveSignal, NeedRow, Question, ResultDiff,
    ResultDiffFile, StepCards, Window, WorkRow, WorkRows,
};

/// How the screen ended (the launcher reads it: tui-launch.ts TUI_EXIT).
pub const EXIT_LEAVE: i32 = 0;
pub const EXIT_ENDED: i32 = 1;
pub const EXIT_STOP: i32 = 40;
pub const EXIT_KEEP: i32 = 41;
pub const EXIT_CLASSIC: i32 = 42;
/// Crash dumps couldn't be turned off (guard.rs): nothing was read, and the classic screen opens instead.
pub const EXIT_UNPROTECTED: i32 = 43;

/// Said when a question and its answer can't be shown whole here.
pub const ANSWER_TOO_LONG: &str =
    "This question is too long to show here — press w to answer it in the browser.";

/// Records kept per run (the newest); older ones are dropped from memory, never written anywhere.
pub const RECORDS_KEPT: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    Live,
    Steps,
    Diff,
    Terminal,
}

impl Tab {
    pub const ALL: [Tab; 4] = [Tab::Live, Tab::Steps, Tab::Diff, Tab::Terminal];
    pub fn label(self) -> &'static str {
        match self {
            Tab::Live => "Live",
            Tab::Steps => "Steps",
            Tab::Diff => "Diff",
            Tab::Terminal => "Terminal",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Section {
    NeedsYou,
    Working,
    DoneToday,
}

impl Section {
    pub fn label(self) -> &'static str {
        match self {
            Section::NeedsYou => "Needs you",
            Section::Working => "Working",
            Section::DoneToday => "Done today",
        }
    }
}

/// One row of the left column.
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub section: Section,
    pub id: String,
    pub title: String,
    /// The short word on the right: what it asks, or what it is doing.
    pub word: String,
    pub detail: String,
    pub tone: String,
    pub paused: bool,
    /// Work's age words ("3m ago") and the project's name, for the list's columns.
    pub age: String,
    pub project: Option<String>,
    pub need: Option<NeedRow>,
    /// A task row (false: an ask that is no task, opened in the browser).
    pub is_task: bool,
}

impl Item {
    pub fn question(&self) -> Option<&Question> {
        self.need.as_ref().and_then(|n| n.question.as_ref())
    }
}

/// The result facts a dialog showed, pinned when it opened: what its act posts, exactly, and what a refresh is compared
/// with (a result that changed meanwhile closes the dialog instead of acting on something not shown).
#[derive(Debug, Clone, PartialEq)]
pub struct ReviewPin {
    pub task: String,
    pub run: i64,
    pub receipt: String,
    pub source: String,
    /// The changes as shown: files, additions, deletions (when the Diff tab had read them).
    pub totals: Option<(i64, i64, i64)>,
}

/// The question and answer a dialog showed, pinned when it opened.
#[derive(Debug, Clone, PartialEq)]
pub struct AnswerPin {
    pub task: String,
    pub index: usize,
    pub question: i64,
    pub option: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum NoteKind {
    /// Send back the result pinned here, with the words typed.
    SendBack(ReviewPin),
}

/// Said when a dialog closes because what it showed changed.
pub const RESULT_CHANGED: &str = "This result changed — look again.";
/// Said when Accept would approve something other than the changes on screen (another build, another file, or none).
pub const DIFF_DISAGREES: &str =
    "The changes on screen aren't the result waiting — look at them again, then press a.";
/// Said when `a` opens the changes first: Accept is a yes to the diff on screen, so it is shown before it is asked.
pub const SHOW_CHANGES_FIRST: &str = "Here are its changes — press a again to accept them.";
pub const QUESTION_CHANGED: &str = "This question changed — look again.";

#[derive(Debug, Clone, PartialEq)]
pub enum Mode {
    Normal,
    Steer(String),
    Note(NoteKind, String),
    NewTask(String),
    ConfirmStop(i64),
    ConfirmAnswer(AnswerPin),
    /// A small task's exact terms: Enter builds (POST /tasks/fast), p files it to plan first, Esc files nothing.
    /// Build is a person's yes to exactly these terms, so every term is shown whole (wrapped, scrolled with j/k), and
    /// Enter builds only once the view has drawn the end of them (`seen_end`, set by view.rs, never by a key). The
    /// preview and digest posted are the ones the engine gave with these terms, never read again.
    Build {
        title: String,
        preview: String,
        digest: String,
        terms: Vec<(String, String)>,
        scroll: usize,
        seen_end: bool,
    },
    /// Accept the result: a plain completion of the receipt read (no acceptance of anything not shown here).
    ConfirmAccept(ReviewPin),
    Help,
    /// The settings in use and their file (settings.rs): read-only, but `t` changes the theme for the session.
    Settings,
    Quit,
    /// Nothing more can happen here: the words, and the exit code a key ends with.
    Fatal(String, i32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Said,
    Refused,
}

/// A run's live records, read window by window.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Transcript {
    pub run: Option<i64>,
    pub main: Vec<LiveRecord>,
    pub sub: Vec<LiveRecord>,
    pub cursor_main: Option<String>,
    pub cursor_sub: Option<String>,
    pub live: bool,
    /// Why there is nothing to read (the run isn't this computer's, or no file yet).
    pub missing: Option<String>,
    /// Moves with every change (the view's line cache keys off it).
    pub version: u64,
}

/// The Live tab's laid-out lines: for which transcript version, width and first record, and when.
pub struct LineCache {
    pub version: u64,
    pub width: usize,
    pub from: usize,
    pub built: std::time::Instant,
    pub lines: Vec<ratatui::text::Line<'static>>,
}

/// What the loop does for an update.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    FetchWork,
    FetchSteps(String),
    FetchLive {
        run: i64,
        file: &'static str,
        cursor: Option<String>,
    },
    FetchDiff(DiffAsk),
    FetchDiffFile(FileAsk),
    Act {
        path: String,
        fields: Vec<(String, String)>,
        done: String,
    },
    /// The live rooms for what's on screen now (besides `workspace`).
    Watch(Vec<String>),
    OpenBrowser,
    Notify(String),
    Exit(i32),
}

/// One read of a task's changes: which task, which build (None: the newest), and the request's generation. Its answer
/// is taken only while it is still the read wanted (same generation, task and build), so a late answer for another
/// build is dropped instead of drawn under this one's facts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffAsk {
    pub task: String,
    pub run: Option<i64>,
    pub gen: u64,
}

/// One read of a file's hunks: task, build, file and generation, all matched against its answer and the index shown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileAsk {
    pub task: String,
    pub run: i64,
    pub file: i64,
    pub gen: u64,
}

/// An engine answer or signal, as the loop hands it over.
#[derive(Debug, Clone)]
pub enum Msg {
    Work(Result<WorkRows, ApiError>),
    Steps(String, Result<StepCards, ApiError>),
    Live(i64, &'static str, Result<LiveSessionWindow, ApiError>),
    Diff(DiffAsk, Result<ResultDiff, ApiError>),
    DiffFile(FileAsk, Result<ResultDiffFile, ApiError>),
    Acted(Result<ActOutcome, ApiError>),
    Signal(LiveSignal),
    /// The launcher's answer to an ask (descriptor 4): words to say.
    Said(String),
    Tick,
}

/// Where things were drawn last frame (for the mouse).
#[derive(Debug, Clone, Default)]
pub struct Areas {
    pub list: Rect,
    /// The list's screen rows and the item each shows (None: a heading).
    pub rows: Vec<(u16, Option<usize>)>,
    pub tabs: Vec<(u16, u16, Tab)>,
    pub right: Rect,
    pub split_x: u16,
}

pub struct App {
    pub project_name: String,
    pub needs_count: i64,
    pub items: Vec<Item>,
    pub selected: usize,
    pub loaded: bool,
    pub tab: Tab,
    pub mode: Mode,
    pub steps: Option<StepCards>,
    pub transcript: Transcript,
    /// Follow the newest record (scrolling up stops it; End starts it again).
    pub follow: bool,
    /// Lines up from the bottom while not following.
    pub scroll: usize,
    pub diff: Option<ResultDiff>,
    pub diff_index: usize,
    pub diff_file: Option<ResultDiffFile>,
    pub diff_scroll: usize,
    /// The diff read whose answer is wanted (the newest asked), and the file read's; anything else is stale.
    diff_wanted: Option<DiffAsk>,
    file_wanted: Option<FileAsk>,
    diff_gen: u64,
    pub status: Option<(Tone, String)>,
    /// The left column's width in cells (dragged with the mouse).
    pub split: u16,
    pub dragging: bool,
    /// Quitting stops the agents this terminal started.
    pub owned: bool,
    /// Where a new task goes (the launcher's repository).
    pub project: Option<String>,
    /// Settings, theme and where notifications go (settings.rs); the loop sets them at start.
    pub prefs: crate::settings::Prefs,
    /// What the work list said last, to notify each change once (notify.rs).
    pub notifier: crate::notify::Notifier,
    /// Agents and costs learnt from steps, for the list's columns.
    pub facts: crate::settings::RowFacts,
    /// The question, the chosen answer and its consequence were all drawn whole (view.rs): Enter may send it.
    pub answer_shown: bool,
    /// The title of the task New task is filing (kept for Build's "plan it first").
    pub filing: String,
    pub fetching_live: bool,
    pub fetching_work: bool,
    pub work_again: bool,
    pub areas: Areas,
    /// The Live tab's lines for (transcript version, width): rebuilt only when either moves.
    pub line_cache: Option<LineCache>,
    /// Seconds since the epoch, for elapsed times (the loop sets it; tests fix it).
    pub now: i64,
    ticks: u64,
    counter: u64,
}

impl App {
    pub fn new(owned: bool, project: Option<String>) -> App {
        App {
            project_name: String::new(),
            needs_count: 0,
            items: Vec::new(),
            selected: 0,
            loaded: false,
            tab: Tab::Live,
            mode: Mode::Normal,
            steps: None,
            transcript: Transcript::default(),
            follow: true,
            scroll: 0,
            diff: None,
            diff_index: 0,
            diff_file: None,
            diff_scroll: 0,
            diff_wanted: None,
            file_wanted: None,
            diff_gen: 0,
            status: None,
            split: 36,
            dragging: false,
            owned,
            project,
            prefs: crate::settings::Prefs::default(),
            notifier: crate::notify::Notifier::default(),
            facts: crate::settings::RowFacts::default(),
            filing: String::new(),
            answer_shown: false,
            fetching_live: false,
            fetching_work: false,
            work_again: false,
            areas: Areas::default(),
            line_cache: None,
            now: 0,
            ticks: 0,
            counter: 0,
        }
    }

    pub fn selected_item(&self) -> Option<&Item> {
        self.items.get(self.selected)
    }

    fn selected_id(&self) -> Option<String> {
        self.selected_item().map(|i| i.id.clone())
    }

    /// The run being watched: the task's live build.
    pub fn live_run(&self) -> Option<i64> {
        self.steps.as_ref().and_then(|s| s.live_run)
    }

    /// The run whose records the Live tab shows: the live build, else the newest build the steps name.
    fn transcript_run(&self) -> Option<i64> {
        let steps = self.steps.as_ref()?;
        steps.live_run.or_else(|| {
            steps
                .cards
                .as_ref()?
                .iter()
                .filter(|c| c.key == "build")
                .flat_map(|c| c.runs.first().copied())
                .next()
        })
    }

    fn say(&mut self, tone: Tone, words: impl Into<String>) {
        self.status = Some((tone, clean(&words.into())));
    }

    fn token(&mut self, len: usize) -> String {
        use std::hash::{BuildHasher, Hasher};
        let mut out = String::new();
        while out.len() < len {
            self.counter += 1;
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u64(self.counter);
            h.write_u128(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0),
            );
            out.push_str(&format!("{:016x}", h.finish()));
        }
        out.truncate(len);
        out
    }

    // ---- engine answers ----------------------------------------------------------------------------------------

    pub fn update(&mut self, msg: Msg) -> Vec<Effect> {
        match msg {
            Msg::Work(Ok(rows)) => self.got_work(rows),
            Msg::Work(Err(e)) => {
                self.fetching_work = false;
                self.failed(e)
            }
            Msg::Steps(task, Ok(steps)) => {
                if self.selected_id().as_deref() != Some(task.as_str()) {
                    return vec![];
                }
                let before = self.transcript_run();
                self.facts.learn(&steps);
                self.steps = Some(steps);
                self.check_pins();
                let mut fx = vec![];
                let run = self.transcript_run();
                if run != before || self.transcript.run != run {
                    self.transcript = Transcript {
                        run,
                        ..Transcript::default()
                    };
                    self.follow = true;
                    self.scroll = 0;
                    self.fetching_live = false;
                    if let Some(run) = run {
                        fx.push(Effect::FetchLive {
                            run,
                            file: "main",
                            cursor: None,
                        });
                        fx.push(Effect::FetchLive {
                            run,
                            file: "sub",
                            cursor: None,
                        });
                        self.fetching_live = true;
                    }
                }
                // The Diff tab follows the result waiting: another build's changes are read again for this one.
                let waiting = self
                    .steps
                    .as_ref()
                    .and_then(|s| s.review.as_ref())
                    .map(|r| r.run);
                if self.tab == Tab::Diff
                    && waiting.is_some()
                    && self.diff.as_ref().map(|d| d.run) != Some(waiting)
                    && self.diff_wanted.as_ref().map(|a| a.run) != Some(waiting)
                {
                    fx.push(self.ask_diff(task));
                }
                fx.push(Effect::Watch(self.rooms()));
                fx
            }
            Msg::Steps(_, Err(e)) => self.failed(e),
            Msg::Live(run, file, result) => self.got_live(run, file, result),
            Msg::Diff(ask, Ok(diff)) => self.got_diff(ask, diff),
            Msg::Diff(ask, Err(e)) => {
                if self.diff_wanted.as_ref() != Some(&ask) && !fatal(&e) {
                    return vec![];
                }
                self.diff_wanted = None;
                self.failed(e)
            }
            Msg::DiffFile(ask, Err(e)) => {
                if self.file_wanted.as_ref() != Some(&ask) && !fatal(&e) {
                    return vec![];
                }
                self.file_wanted = None;
                self.failed(e)
            }
            Msg::DiffFile(ask, Ok(file)) => self.got_diff_file(ask, file),
            Msg::Acted(Ok(ActOutcome::Done(words))) => {
                self.say(Tone::Said, words);
                self.refresh()
            }
            Msg::Acted(Ok(ActOutcome::Refused(words))) => {
                self.say(Tone::Refused, words);
                self.refresh()
            }
            Msg::Acted(Ok(ActOutcome::Terms {
                preview,
                digest,
                terms,
            })) => {
                let title = self.filing.clone();
                self.status = None;
                self.mode = Mode::Build {
                    title,
                    preview,
                    digest,
                    terms: terms.into_iter().map(|(l, w)| (clean(&l), w)).collect(),
                    scroll: 0,
                    seen_end: false,
                };
                vec![]
            }
            Msg::Acted(Err(e)) => self.failed(e),
            Msg::Signal(signal) => self.signal(signal),
            Msg::Said(words) => {
                self.say(Tone::Said, words);
                vec![]
            }
            Msg::Tick => self.tick(),
        }
    }

    fn failed(&mut self, e: ApiError) -> Vec<Effect> {
        // (A stale read's error is dropped by its caller unless it ends the session: see `fatal`.)
        match e {
            ApiError::SessionEnded => {
                self.mode = Mode::Fatal("Session ended: run toolroll again.".into(), EXIT_ENDED);
                vec![]
            }
            ApiError::Contract(words) => {
                self.mode = Mode::Fatal(
                    format!("{words} Run toolroll again after updating."),
                    EXIT_CLASSIC,
                );
                vec![]
            }
            other => {
                self.say(Tone::Refused, other.to_string());
                vec![]
            }
        }
    }

    /// Re-read what's on screen after an act.
    fn refresh(&mut self) -> Vec<Effect> {
        let mut fx = self.fetch_work();
        if let Some(id) = self
            .selected_item()
            .filter(|i| i.is_task)
            .map(|i| i.id.clone())
        {
            fx.push(Effect::FetchSteps(id.clone()));
            if self.tab == Tab::Diff {
                fx.push(self.ask_diff(id));
            }
        }
        fx
    }

    fn fetch_work(&mut self) -> Vec<Effect> {
        if self.fetching_work {
            self.work_again = true;
            return vec![];
        }
        self.fetching_work = true;
        vec![Effect::FetchWork]
    }

    fn got_work(&mut self, rows: WorkRows) -> Vec<Effect> {
        self.fetching_work = false;
        let before = self.selected_id();
        self.project_name = clean(&rows.project_name);
        self.needs_count = rows.needs_count;
        self.items = items_of(&rows);
        self.check_pins();
        let mut fx = vec![];
        // Each change once (a task starts waiting on you, finishes or fails), in our own words (notify.rs).
        let notify = self.prefs.settings.notify;
        fx.extend(
            self.notifier
                .observe(&self.items, notify, self.now)
                .map(Effect::Notify),
        );
        let first = !self.loaded;
        self.loaded = true;
        // Keep the same task selected when it is still listed.
        self.selected = before
            .as_ref()
            .and_then(|id| self.items.iter().position(|i| &i.id == id))
            .unwrap_or(0)
            .min(self.items.len().saturating_sub(1));
        let after = self.selected_id();
        if after != before || first {
            fx.extend(self.selection_changed());
        } else if let Some(id) = self
            .selected_item()
            .filter(|i| i.is_task)
            .map(|i| i.id.clone())
        {
            fx.push(Effect::FetchSteps(id));
        }
        if std::mem::take(&mut self.work_again) {
            fx.extend(self.fetch_work());
        }
        fx
    }

    fn got_live(
        &mut self,
        run: i64,
        file: &'static str,
        result: Result<LiveSessionWindow, ApiError>,
    ) -> Vec<Effect> {
        if file == "main" {
            self.fetching_live = false;
        }
        if self.transcript.run != Some(run) {
            return vec![];
        }
        let window = match result {
            Ok(w) => w,
            Err(e) => return self.failed(e),
        };
        self.transcript.live = window.live;
        match window.window {
            Window::Missing(m) => {
                if file == "main" {
                    self.transcript.missing = Some(match m.reason.as_str() {
                        "off" => {
                            "This build runs on another computer; its output is there.".to_string()
                        }
                        _ => "No output yet.".to_string(),
                    });
                    self.transcript.version += 1;
                }
                vec![]
            }
            Window::Read(read) => {
                let (records, cursor) = if file == "main" {
                    (&mut self.transcript.main, &mut self.transcript.cursor_main)
                } else {
                    (&mut self.transcript.sub, &mut self.transcript.cursor_sub)
                };
                if read.restarted {
                    records.clear();
                }
                let grew = !read.records.is_empty() || read.restarted;
                records.extend(read.records);
                if records.len() > RECORDS_KEPT {
                    let drop = records.len() - RECORDS_KEPT;
                    records.drain(..drop);
                }
                *cursor = Some(read.cursor.clone());
                if grew {
                    self.transcript.missing = None;
                    self.transcript.version += 1;
                }
                if read.more {
                    if file == "main" {
                        self.fetching_live = true;
                    }
                    return vec![Effect::FetchLive {
                        run,
                        file,
                        cursor: Some(read.cursor),
                    }];
                }
                vec![]
            }
        }
    }

    fn signal(&mut self, signal: LiveSignal) -> Vec<Effect> {
        match signal {
            LiveSignal::Change(room) if room == "workspace" => self.fetch_work(),
            LiveSignal::Change(room) if room.starts_with("task:") => self
                .selected_id()
                .map(Effect::FetchSteps)
                .into_iter()
                .collect(),
            LiveSignal::Change(room) if room.starts_with("agent:") => self.poll_live(true),
            LiveSignal::Gone(_) | LiveSignal::Reload => self.refresh(),
            _ => vec![],
        }
    }

    fn poll_live(&mut self, with_sub: bool) -> Vec<Effect> {
        let Some(run) = self.transcript.run else {
            return vec![];
        };
        if self.fetching_live || (!self.transcript.live && self.transcript.cursor_main.is_some()) {
            return vec![];
        }
        self.fetching_live = true;
        let mut fx = vec![Effect::FetchLive {
            run,
            file: "main",
            cursor: self.transcript.cursor_main.clone(),
        }];
        if with_sub {
            fx.push(Effect::FetchLive {
                run,
                file: "sub",
                cursor: self.transcript.cursor_sub.clone(),
            });
        }
        fx
    }

    /// Every 250 ms: read on in a live build's records (well inside the one-second bar), subagents every 2 s.
    fn tick(&mut self) -> Vec<Effect> {
        self.ticks += 1;
        let gathered = self
            .notifier
            .tick(&self.items, self.now)
            .map(Effect::Notify);
        if matches!(self.mode, Mode::Fatal(..)) {
            return gathered.into_iter().collect();
        }
        let mut fx = vec![];
        if self.tab == Tab::Live || self.ticks.is_multiple_of(4) {
            fx = self.poll_live(self.ticks.is_multiple_of(8));
        }
        fx.extend(gathered);
        fx
    }

    /// The rooms that say when what's on screen changed.
    fn rooms(&self) -> Vec<String> {
        let mut rooms = vec![];
        if let Some(steps) = &self.steps {
            rooms.push(steps.room.clone());
        }
        if let Some(run) = self.transcript.run {
            rooms.push(format!("agent:{run}"));
        }
        rooms
    }

    fn selection_changed(&mut self) -> Vec<Effect> {
        self.steps = None;
        self.transcript = Transcript::default();
        self.diff = None;
        self.diff_file = None;
        self.diff_index = 0;
        self.diff_wanted = None;
        self.file_wanted = None;
        self.follow = true;
        self.scroll = 0;
        self.fetching_live = false;
        if matches!(
            self.mode,
            Mode::ConfirmAccept(_) | Mode::ConfirmAnswer(_) | Mode::Note(..)
        ) {
            self.say(Tone::Refused, RESULT_CHANGED);
        }
        if matches!(
            self.mode,
            Mode::ConfirmAnswer(_)
                | Mode::ConfirmAccept(_)
                | Mode::ConfirmStop(_)
                | Mode::Note(..)
                | Mode::Steer(_)
        ) {
            self.mode = Mode::Normal;
        }
        let Some(id) = self
            .selected_item()
            .filter(|i| i.is_task)
            .map(|i| i.id.clone())
        else {
            return vec![Effect::Watch(vec![])];
        };
        let mut fx = vec![Effect::FetchSteps(id.clone()), Effect::Watch(vec![])];
        if self.tab == Tab::Diff {
            fx.push(self.ask_diff(id));
        }
        fx
    }

    fn select(&mut self, index: usize) -> Vec<Effect> {
        if self.items.is_empty() {
            return vec![];
        }
        let index = index.min(self.items.len() - 1);
        if index == self.selected {
            return vec![];
        }
        self.selected = index;
        self.selection_changed()
    }

    fn set_tab(&mut self, tab: Tab) -> Vec<Effect> {
        self.tab = tab;
        match (tab, self.selected_id()) {
            (Tab::Diff, Some(id)) if self.diff.is_none() => vec![self.ask_diff(id)],
            _ => vec![],
        }
    }

    // ---- keys ---------------------------------------------------------------------------------------------------

    pub fn key(&mut self, key: KeyEvent) -> Vec<Effect> {
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            return self.quit();
        }
        match self.mode.clone() {
            Mode::Fatal(_, code) => vec![Effect::Exit(code)],
            Mode::Help => {
                self.mode = if key.code == KeyCode::Char('s') {
                    Mode::Settings
                } else {
                    Mode::Normal
                };
                vec![]
            }
            Mode::Settings => {
                if key.code == KeyCode::Char('t') {
                    self.prefs.cycle_theme();
                    self.line_cache = None;
                } else {
                    self.mode = Mode::Normal;
                }
                vec![]
            }
            Mode::Quit => match key.code {
                KeyCode::Char('s') => vec![Effect::Exit(EXIT_STOP)],
                KeyCode::Char('b') => vec![Effect::Exit(EXIT_KEEP)],
                KeyCode::Esc => {
                    self.mode = Mode::Normal;
                    vec![]
                }
                _ => vec![],
            },
            Mode::ConfirmStop(run) => {
                self.mode = Mode::Normal;
                match key.code {
                    KeyCode::Char('y') | KeyCode::Char('Y') => self.stop(run),
                    _ => {
                        self.say(Tone::Said, "Not stopped.");
                        vec![]
                    }
                }
            }
            Mode::Build {
                title,
                preview,
                digest,
                terms,
                scroll,
                seen_end,
            } => match key.code {
                // Reading on: the view says when the end has been shown.
                KeyCode::Char('j') | KeyCode::Down | KeyCode::PageDown | KeyCode::Char(' ') => {
                    let by = if matches!(key.code, KeyCode::PageDown | KeyCode::Char(' ')) {
                        10
                    } else {
                        1
                    };
                    self.mode = Mode::Build {
                        title,
                        preview,
                        digest,
                        terms,
                        scroll: scroll + by,
                        seen_end,
                    };
                    vec![]
                }
                KeyCode::Char('k') | KeyCode::Up | KeyCode::PageUp => {
                    let by = if key.code == KeyCode::PageUp { 10 } else { 1 };
                    self.mode = Mode::Build {
                        title,
                        preview,
                        digest,
                        terms,
                        scroll: scroll.saturating_sub(by),
                        seen_end,
                    };
                    vec![]
                }
                KeyCode::Enter if !seen_end => {
                    self.mode = Mode::Build {
                        title,
                        preview,
                        digest,
                        terms,
                        scroll,
                        seen_end,
                    };
                    self.say(Tone::Refused, "Read the terms to the end first (j or Space), or press w to review them in the browser.");
                    vec![]
                }
                KeyCode::Enter => {
                    self.mode = Mode::Normal;
                    self.act(
                        "/tasks/fast".into(),
                        vec![("preview", preview), ("digest", digest)],
                        "Building it.".into(),
                    )
                }
                KeyCode::Char('w') => {
                    self.mode = Mode::Build {
                        title,
                        preview,
                        digest,
                        terms,
                        scroll,
                        seen_end,
                    };
                    self.say(Tone::Said, "Opening Toolroll in your browser…");
                    vec![Effect::OpenBrowser]
                }
                KeyCode::Char('p') => {
                    self.mode = Mode::Normal;
                    let mut fields = vec![
                        ("title", title),
                        ("plain", "1".to_string()),
                        ("planning-policy", "choice".to_string()),
                        ("plan-first", "1".to_string()),
                    ];
                    if let Some(project) = &self.project {
                        fields.push(("repo", project.clone()));
                    }
                    self.act(
                        "/tasks/add".into(),
                        fields,
                        "Filed. A plan comes first.".into(),
                    )
                }
                KeyCode::Esc => {
                    self.mode = Mode::Normal;
                    self.say(Tone::Said, "Nothing filed.");
                    vec![]
                }
                _ => {
                    self.mode = Mode::Build {
                        title,
                        preview,
                        digest,
                        terms,
                        scroll,
                        seen_end,
                    };
                    vec![]
                }
            },
            Mode::ConfirmAccept(pin) => {
                self.mode = Mode::Normal;
                match key.code {
                    KeyCode::Enter => self.accept(pin),
                    _ => {
                        self.say(Tone::Said, "Not accepted.");
                        vec![]
                    }
                }
            }
            Mode::ConfirmAnswer(pin) => {
                self.mode = Mode::Normal;
                match key.code {
                    // Only an answer whose question and consequence were drawn whole (view.rs sets it).
                    KeyCode::Enter if !self.answer_shown => {
                        self.say(Tone::Refused, ANSWER_TOO_LONG);
                        vec![]
                    }
                    KeyCode::Enter => self.answer(pin),
                    _ => {
                        self.say(Tone::Said, "Not answered.");
                        vec![]
                    }
                }
            }
            Mode::Steer(text) => self.typing(
                key,
                text,
                |app, text| app.mode = Mode::Steer(text),
                |app, text| app.steer(text),
            ),
            Mode::NewTask(text) => self.typing(
                key,
                text,
                |app, text| app.mode = Mode::NewTask(text),
                |app, text| app.new_task(text),
            ),
            Mode::Note(kind, text) => {
                let k2 = kind.clone();
                self.typing(
                    key,
                    text,
                    move |app, text| app.mode = Mode::Note(k2.clone(), text),
                    move |app, text| app.note(kind.clone(), text),
                )
            }
            Mode::Normal => self.normal_key(key),
        }
    }

    /// A text box's keys: typing, Backspace, Esc to cancel, Enter to send.
    fn typing(
        &mut self,
        key: KeyEvent,
        mut text: String,
        keep: impl Fn(&mut App, String),
        send: impl Fn(&mut App, String) -> Vec<Effect>,
    ) -> Vec<Effect> {
        match key.code {
            KeyCode::Esc => {
                self.mode = Mode::Normal;
                vec![]
            }
            KeyCode::Enter => {
                self.mode = Mode::Normal;
                send(self, text)
            }
            KeyCode::Backspace => {
                text.pop();
                keep(self, text);
                vec![]
            }
            KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                if text.chars().count() < 2000 {
                    text.push(c);
                }
                keep(self, text);
                vec![]
            }
            _ => {
                keep(self, text);
                vec![]
            }
        }
    }

    /// Pasted text goes into the open text box (line breaks as spaces).
    pub fn paste(&mut self, pasted: &str) {
        let add = clean(pasted);
        let grow = |t: &mut String| {
            for c in add.chars() {
                if t.chars().count() >= 2000 {
                    break;
                }
                t.push(c);
            }
        };
        match &mut self.mode {
            Mode::Steer(t) | Mode::NewTask(t) | Mode::Note(_, t) => grow(t),
            _ => {}
        }
    }

    fn normal_key(&mut self, key: KeyEvent) -> Vec<Effect> {
        let item = self.selected_item().cloned();
        match key.code {
            KeyCode::Char('j') | KeyCode::Down => self.select(self.selected + 1),
            KeyCode::Char('k') | KeyCode::Up => self.select(self.selected.saturating_sub(1)),
            KeyCode::Enter => {
                // Open: the tab that answers what it asks.
                let tab = match item
                    .as_ref()
                    .and_then(|i| i.need.as_ref())
                    .and_then(|n| n.ask.as_deref())
                {
                    Some("review") => Tab::Diff,
                    _ => Tab::Live,
                };
                self.set_tab(tab)
            }
            KeyCode::Tab => self
                .set_tab(Tab::ALL[(Tab::ALL.iter().position(|t| *t == self.tab).unwrap() + 1) % 4]),
            KeyCode::BackTab => self
                .set_tab(Tab::ALL[(Tab::ALL.iter().position(|t| *t == self.tab).unwrap() + 3) % 4]),
            KeyCode::Char('s') => match self.live_run() {
                Some(_) => {
                    self.mode = Mode::Steer(String::new());
                    vec![]
                }
                None => {
                    self.say(
                        Tone::Refused,
                        "Nothing is building on this task, so there's no agent to steer.",
                    );
                    vec![]
                }
            },
            KeyCode::Char('p') => self.pause(item.as_ref()),
            KeyCode::Char('x') => match self.live_run() {
                Some(run) => {
                    self.mode = Mode::ConfirmStop(run);
                    vec![]
                }
                None => {
                    self.say(Tone::Refused, "Nothing is building on this task to stop.");
                    vec![]
                }
            },
            KeyCode::Char(c @ '1'..='9') => {
                let n = (c as u8 - b'1') as usize;
                match item.as_ref().and_then(|i| i.question()) {
                    Some(q) if n < q.options.len() => {
                        let o = &q.options[n];
                        self.mode = Mode::ConfirmAnswer(AnswerPin {
                            task: item.as_ref().unwrap().id.clone(),
                            index: n,
                            question: q.id,
                            option: o.id.clone(),
                            label: o.label.clone(),
                        });
                        self.answer_shown = false;
                        vec![]
                    }
                    Some(_) => {
                        self.say(Tone::Refused, format!("There's no answer {}.", n + 1));
                        vec![]
                    }
                    None => {
                        self.say(Tone::Refused, "No question is waiting on this task.");
                        vec![]
                    }
                }
            }
            KeyCode::Char('a') => {
                let Some(pin) = self.pin_review() else {
                    return vec![];
                };
                // Accept is a yes to the changes on screen: with no diff of this build shown, show it first.
                if self
                    .diff
                    .as_ref()
                    .is_none_or(|d| d.run != Some(pin.run) || d.task != pin.task)
                {
                    self.say(Tone::Said, SHOW_CHANGES_FIRST);
                    self.tab = Tab::Diff;
                    return vec![self.ask_diff(pin.task)];
                }
                if let Err(why) = self.diff_agrees(&pin) {
                    self.say(Tone::Refused, why);
                    return vec![];
                }
                self.status = None;
                self.mode = Mode::ConfirmAccept(pin);
                vec![]
            }
            KeyCode::Char('r') => {
                if let Some(pin) = self.pin_review() {
                    self.mode = Mode::Note(NoteKind::SendBack(pin), String::new());
                }
                vec![]
            }
            KeyCode::Char('n') => {
                self.mode = Mode::NewTask(String::new());
                vec![]
            }
            KeyCode::Char('w') => {
                self.say(Tone::Said, "Opening Toolroll in your browser…");
                vec![Effect::OpenBrowser]
            }
            KeyCode::Char('?') => {
                self.mode = Mode::Help;
                vec![]
            }
            KeyCode::Char('q') => self.quit(),
            KeyCode::Char('[') if self.tab == Tab::Diff => self.diff_step(-1),
            KeyCode::Char(']') if self.tab == Tab::Diff => self.diff_step(1),
            KeyCode::PageUp | KeyCode::Char('u') => {
                self.scroll_by(10);
                vec![]
            }
            KeyCode::PageDown | KeyCode::Char('d') => {
                self.scroll_by(-10);
                vec![]
            }
            KeyCode::End | KeyCode::Char('G') => {
                self.follow = true;
                self.scroll = 0;
                self.diff_scroll = 0;
                vec![]
            }
            KeyCode::Esc => {
                self.status = None;
                vec![]
            }
            _ => vec![],
        }
    }

    fn quit(&mut self) -> Vec<Effect> {
        if self.owned && !matches!(self.mode, Mode::Fatal(..)) {
            self.mode = Mode::Quit;
            vec![]
        } else {
            vec![Effect::Exit(EXIT_LEAVE)]
        }
    }

    /// Scroll the right pane: positive is up (older).
    pub fn scroll_by(&mut self, lines: i64) {
        if self.tab == Tab::Diff {
            self.diff_scroll = (self.diff_scroll as i64 - lines).max(0) as usize;
            return;
        }
        let next = (self.scroll as i64 + lines).max(0) as usize;
        self.scroll = next;
        self.follow = next == 0;
    }

    fn diff_step(&mut self, by: i64) -> Vec<Effect> {
        let Some(diff) = &self.diff else {
            return vec![];
        };
        if diff.files.is_empty() {
            return vec![];
        }
        let next = (self.diff_index as i64 + by).rem_euclid(diff.files.len() as i64) as usize;
        let ask = match (self.selected_id(), diff.run) {
            (Some(id), Some(run)) => Some((id, run, diff.files[next].file)),
            _ => None,
        };
        self.diff_index = next;
        self.diff_file = None;
        self.diff_scroll = 0;
        self.file_wanted = None;
        // The dialog that pinned another file's view no longer shows what it asks about.
        self.check_pins();
        match ask {
            Some((id, run, file)) => vec![self.ask_file(id, run, file)],
            None => vec![],
        }
    }

    // ---- the changes: asked, matched, and agreed with the result waiting -------------------------------------------

    /// Read the task's changes: the build waiting for review when the steps name one, else the newest.
    fn ask_diff(&mut self, task: String) -> Effect {
        self.diff_gen += 1;
        let run = self
            .steps
            .as_ref()
            .filter(|s| s.task.id == task || s.task.root == task)
            .and_then(|s| s.review.as_ref())
            .map(|r| r.run);
        let ask = DiffAsk {
            task,
            run,
            gen: self.diff_gen,
        };
        self.diff_wanted = Some(ask.clone());
        Effect::FetchDiff(ask)
    }

    fn ask_file(&mut self, task: String, run: i64, file: i64) -> Effect {
        self.diff_gen += 1;
        let ask = FileAsk {
            task,
            run,
            file,
            gen: self.diff_gen,
        };
        self.file_wanted = Some(ask.clone());
        Effect::FetchDiffFile(ask)
    }

    /// A diff index answer: taken only when it is the read wanted, for the task selected and the build asked. A new
    /// index drops the hunks shown (they were another index's), and the file read is asked again.
    fn got_diff(&mut self, ask: DiffAsk, diff: ResultDiff) -> Vec<Effect> {
        if self.diff_wanted.as_ref() != Some(&ask)
            || self.selected_id().as_deref() != Some(ask.task.as_str())
            || diff.task != ask.task
            || ask.run.is_some_and(|run| diff.run != Some(run))
        {
            return vec![];
        }
        self.diff_wanted = None;
        if self.diff.as_ref() != Some(&diff) {
            if self.diff.as_ref().map(|d| d.run) != Some(diff.run) {
                self.diff_index = 0;
            }
            self.diff_file = None;
            self.diff_scroll = 0;
            self.file_wanted = None;
        }
        self.diff_index = self.diff_index.min(diff.files.len().saturating_sub(1));
        let next = match (diff.run, diff.files.get(self.diff_index)) {
            (Some(run), Some(f)) => Some((run, f.file)),
            _ => None,
        };
        self.diff = Some(diff);
        self.check_pins();
        match next {
            Some((run, file)) => vec![self.ask_file(ask.task, run, file)],
            None => vec![],
        }
    }

    /// A file's hunks: taken only when they are the read wanted and still the file the index on screen points at.
    fn got_diff_file(&mut self, ask: FileAsk, file: ResultDiffFile) -> Vec<Effect> {
        let shown = self
            .diff
            .as_ref()
            .filter(|d| d.task == ask.task && d.run == Some(ask.run))
            .and_then(|d| d.files.get(self.diff_index))
            .map(|f| f.file);
        if self.file_wanted.as_ref() != Some(&ask)
            || self.selected_id().as_deref() != Some(ask.task.as_str())
            || file.task != ask.task
            || file.run != ask.run
            || file.file.file != ask.file
            || shown != Some(ask.file)
        {
            return vec![];
        }
        self.file_wanted = None;
        self.diff_file = Some(file);
        self.diff_scroll = 0;
        self.check_pins();
        vec![]
    }

    /// Whether the changes on screen are the pinned result's: the diff index is this task's and this build's, its
    /// totals are the ones the dialog showed, and the hunks drawn (if any) are this build's, for the file the index
    /// points at. Accept is enabled only when this, the pin and the steps' receipt all agree.
    fn diff_agrees(&self, pin: &ReviewPin) -> Result<(), &'static str> {
        let diff = self
            .diff
            .as_ref()
            .filter(|d| d.task == pin.task && d.run == Some(pin.run))
            .ok_or(DIFF_DISAGREES)?;
        let totals = diff
            .totals
            .as_ref()
            .map(|t| (t.files, t.additions, t.deletions));
        if totals != pin.totals {
            return Err(DIFF_DISAGREES);
        }
        if let Some(file) = &self.diff_file {
            let pointed = diff.files.get(self.diff_index).map(|f| f.file);
            if file.task != pin.task || file.run != pin.run || Some(file.file.file) != pointed {
                return Err(DIFF_DISAGREES);
            }
        }
        Ok(())
    }

    // ---- acts -----------------------------------------------------------------------------------------------------

    fn act(&mut self, path: String, fields: Vec<(&str, String)>, done: String) -> Vec<Effect> {
        vec![Effect::Act {
            path,
            fields: fields
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
            done,
        }]
    }

    fn task_path(&self, verb: &str) -> Option<String> {
        self.selected_id()
            .map(|id| format!("/t/{}/{verb}", toolroll_api::client::encode(&id)))
    }

    fn steer(&mut self, text: String) -> Vec<Effect> {
        let note = text.trim().to_string();
        let (Some(run), Some(path)) = (self.live_run(), self.task_path("steer")) else {
            self.say(Tone::Refused, "Nothing is building on this task any more.");
            return vec![];
        };
        if note.is_empty() {
            return vec![];
        }
        let key = self.token(24);
        self.act(
            path,
            vec![
                ("note", note),
                ("return", "task".into()),
                ("run", run.to_string()),
                ("key", key),
            ],
            format!("Note sent to build #{run}."),
        )
    }

    fn pause(&mut self, item: Option<&Item>) -> Vec<Effect> {
        let (Some(run), Some(path)) = (self.live_run(), self.task_path("pause")) else {
            self.say(Tone::Refused, "Nothing is building on this task to pause.");
            return vec![];
        };
        let request = self.token(24);
        let resume = item.is_some_and(|i| i.paused);
        let mut fields = vec![
            ("run", run.to_string()),
            ("request", request),
            ("return", "task".to_string()),
        ];
        if resume {
            fields.push(("mode", "resume".into()));
        }
        self.act(
            path,
            fields,
            if resume {
                format!("Resuming build #{run}.")
            } else {
                format!("Pausing build #{run}.")
            },
        )
    }

    fn stop(&mut self, run: i64) -> Vec<Effect> {
        let Some(path) = self.task_path("stop") else {
            return vec![];
        };
        self.act(
            path,
            vec![("run", run.to_string()), ("return", "task".into())],
            format!("Stopping build #{run}."),
        )
    }

    /// The answer pinned when the dialog opened, sent only while the same question still waits with the same option.
    fn answer(&mut self, pin: AnswerPin) -> Vec<Effect> {
        if self.answer_pin_stands(&pin).is_none() {
            self.say(Tone::Refused, QUESTION_CHANGED);
            return vec![];
        }
        // The person read the question, the choice and its consequence and pressed Enter on it: that is the
        // confirmation the form's box stands for.
        self.act(
            format!("/d/{}/answer", pin.question),
            vec![
                ("choice", pin.option),
                ("confirm", "yes".into()),
                ("return", "next".into()),
            ],
            format!("Answered: {}.", clean(&pin.label)),
        )
    }

    /// Whether the pinned answer is still the one on screen (Some), or the question changed (None).
    fn answer_pin_stands(&self, pin: &AnswerPin) -> Option<()> {
        let item = self.selected_item().filter(|i| i.id == pin.task)?;
        let q = item.question().filter(|q| q.id == pin.question)?;
        q.options
            .get(pin.index)
            .filter(|o| o.id == pin.option && o.label == pin.label)
            .map(|_| ())
    }

    /// The result waiting on this task as it is shown now, pinned (or why there's none, said).
    fn pin_review(&mut self) -> Option<ReviewPin> {
        let task = self
            .selected_item()
            .filter(|i| i.is_task)
            .map(|i| i.id.clone());
        let review = self
            .steps
            .as_ref()
            .filter(|s| Some(&s.task.id) == task.as_ref() || Some(&s.task.root) == task.as_ref())
            .and_then(|s| s.review.clone());
        match (task, review) {
            (Some(task), Some(r)) => {
                let totals = self
                    .diff
                    .as_ref()
                    .filter(|d| d.run == Some(r.run))
                    .and_then(|d| d.totals.as_ref())
                    .map(|t| (t.files, t.additions, t.deletions));
                Some(ReviewPin {
                    task,
                    run: r.run,
                    receipt: r.receipt,
                    source: r.source,
                    totals,
                })
            }
            _ => {
                let why = match self.selected_item().and_then(|i| i.need.as_ref()).and_then(|n| n.ask.as_deref()) {
                    Some("review") => "This result isn't ready to accept here yet. Press w to open it in the browser.",
                    _ => "No result is waiting for you on this task.",
                };
                self.say(Tone::Refused, why);
                None
            }
        }
    }

    /// Whether a pinned result is still the one waiting (same task, run, receipt and revision source).
    fn review_pin_stands(&self, pin: &ReviewPin) -> bool {
        self.selected_item().is_some_and(|i| i.id == pin.task)
            && self
                .steps
                .as_ref()
                .and_then(|s| s.review.as_ref())
                .is_some_and(|r| {
                    r.run == pin.run && r.receipt == pin.receipt && r.source == pin.source
                })
    }

    /// After a refresh: a dialog whose pinned facts no longer stand closes, saying so (nothing is sent).
    fn check_pins(&mut self) {
        let changed = match &self.mode {
            Mode::ConfirmAccept(pin) if self.review_pin_stands(pin) => self.diff_agrees(pin).err(),
            Mode::ConfirmAccept(pin) | Mode::Note(NoteKind::SendBack(pin), _) => {
                (!self.review_pin_stands(pin)).then_some(RESULT_CHANGED)
            }
            Mode::ConfirmAnswer(pin) => self
                .answer_pin_stands(pin)
                .is_none()
                .then_some(QUESTION_CHANGED),
            _ => None,
        };
        if let Some(words) = changed {
            self.mode = Mode::Normal;
            self.say(Tone::Refused, words);
        }
    }

    fn note(&mut self, kind: NoteKind, text: String) -> Vec<Effect> {
        let note = text.trim().to_string();
        match kind {
            NoteKind::SendBack(pin) => {
                if !self.review_pin_stands(&pin) {
                    self.say(Tone::Refused, RESULT_CHANGED);
                    return vec![];
                }
                if note.is_empty() {
                    self.say(Tone::Refused, "Say what to change, then press Enter.");
                    self.mode = Mode::Note(NoteKind::SendBack(pin), String::new());
                    return vec![];
                }
                let request = self.token(32);
                self.act(
                    format!("/r/{}/comment", pin.run),
                    vec![
                        ("intent", "revise".into()),
                        ("note", note),
                        ("request", request),
                        ("batch", String::new()),
                        ("source", pin.source),
                    ],
                    "Sent back. The revision is filed.".into(),
                )
            }
        }
    }

    /// Accept: the plain completion of the receipt read (POST /t/<task>/complete with `receipt` and `run`). Never
    /// `accept=1`: a result that still owes the person's acceptance (its checks, a caveat, a reason) is refused by the
    /// engine in words, and accepted in the browser where those terms are shown whole.
    fn accept(&mut self, pin: ReviewPin) -> Vec<Effect> {
        if !self.review_pin_stands(&pin) {
            self.say(Tone::Refused, RESULT_CHANGED);
            return vec![];
        }
        if let Err(why) = self.diff_agrees(&pin) {
            self.say(Tone::Refused, why);
            return vec![];
        }
        self.act(
            format!("/t/{}/complete", toolroll_api::client::encode(&pin.task)),
            vec![("receipt", pin.receipt), ("run", pin.run.to_string())],
            "Accepted. The task is complete.".into(),
        )
    }

    fn new_task(&mut self, text: String) -> Vec<Effect> {
        let title = text.trim().to_string();
        if title.is_empty() {
            return vec![];
        }
        // A small task comes back as its exact terms (Build); anything else is filed for a plan.
        self.filing = title.clone();
        let mut fields = vec![("title", title)];
        if let Some(project) = &self.project {
            fields.push(("repo", project.clone()));
        }
        self.act(
            "/tasks/add".into(),
            fields,
            "Filed. A plan comes first.".into(),
        )
    }

    // ---- mouse -----------------------------------------------------------------------------------------------------

    pub fn mouse(&mut self, ev: MouseEvent) -> Vec<Effect> {
        let (x, y) = (ev.column, ev.row);
        let inside = |r: Rect| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
        match ev.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                if x.abs_diff(self.areas.split_x) <= 1
                    && inside(Rect {
                        x: 0,
                        width: u16::MAX,
                        ..self.areas.list
                    })
                {
                    self.dragging = true;
                    return vec![];
                }
                if let Some((_, _, tab)) = self
                    .areas
                    .tabs
                    .iter()
                    .find(|(from, to, _)| y == self.areas.right.y && x >= *from && x < *to)
                    .copied()
                {
                    return self.set_tab(tab);
                }
                if inside(self.areas.list) {
                    if let Some((_, Some(index))) =
                        self.areas.rows.iter().find(|(row, _)| *row == y).cloned()
                    {
                        return self.select(index);
                    }
                }
                vec![]
            }
            MouseEventKind::Drag(MouseButton::Left) if self.dragging => {
                self.split = x.clamp(20, 90);
                vec![]
            }
            MouseEventKind::Up(_) => {
                self.dragging = false;
                vec![]
            }
            MouseEventKind::ScrollUp if inside(self.areas.list) => {
                self.select(self.selected.saturating_sub(1))
            }
            MouseEventKind::ScrollDown if inside(self.areas.list) => self.select(self.selected + 1),
            MouseEventKind::ScrollUp => {
                self.scroll_by(3);
                vec![]
            }
            MouseEventKind::ScrollDown => {
                self.scroll_by(-3);
                vec![]
            }
            _ => vec![],
        }
    }
}

/// A waiting row's short word for what it asks, when Work gives none.
fn ask_word(ask: Option<&str>) -> Option<&'static str> {
    Some(match ask? {
        "approve" => "Approve",
        "answer" => "Question",
        "review" => "Result",
        "release" => "Release",
        "wrong" => "Problem",
        "setup" => "Set up",
        "flow" => "Flow",
        "unblock" => "Unblock",
        _ => return None,
    })
}

/// "Done today": a finished row updated within the day (Work's own age words: `<n>m ago`, `<n>h ago` under 24).
fn today(age: &str) -> bool {
    if let Some(m) = age.strip_suffix("m ago") {
        return m.parse::<u32>().is_ok();
    }
    age.strip_suffix("h ago")
        .and_then(|h| h.parse::<u32>().ok())
        .is_some_and(|h| h < 24)
}

/// The left column from Work's rows: what waits on you (Work's Decide, Review, Unblock groups, and asks that are no
/// task), what agents are working on, and what finished today.
pub fn items_of(rows: &WorkRows) -> Vec<Item> {
    let mut needs = vec![];
    let mut working = vec![];
    let mut done = vec![];
    let item = |section: Section, r: &WorkRow, word: String| Item {
        section,
        id: r.id.clone(),
        title: clean(&r.title),
        word: clean(&word),
        detail: clean(r.detail.as_deref().or(r.problem.as_deref()).unwrap_or("")),
        tone: r.status.tone.clone(),
        paused: r.status.label.to_lowercase().contains("paused")
            || r.word.word.to_lowercase().contains("paused"),
        age: clean(&r.age),
        project: r.project.as_deref().map(clean),
        need: r.need.clone(),
        is_task: true,
    };
    for r in &rows.rows {
        let waits = r.need.is_some()
            || matches!(r.group.as_str(), "decide" | "review" | "unblock")
            || r.status.tone == "attention";
        if waits {
            let asks = r
                .need
                .as_ref()
                .and_then(|n| n.ask.as_deref())
                .or(r.ask.as_deref());
            let word = r
                .chip
                .clone()
                .unwrap_or_else(|| ask_word(asks).unwrap_or(&r.word.word).to_string());
            needs.push(item(Section::NeedsYou, r, word));
        } else if r.group == "building"
            || r.status.tone == "live"
            || r.status.token.contains("queued")
        {
            working.push(item(Section::Working, r, r.word.word.clone()));
        } else if r.status.tone == "done" && today(&r.age) {
            done.push(item(Section::DoneToday, r, r.word.word.clone()));
        }
    }
    // Asks that are no task row (a held release, a flow card, a setup step): listed, opened in the browser.
    for group in &rows.needs {
        for n in &group.rows {
            if needs.iter().any(|i: &Item| i.id == n.id) {
                continue;
            }
            needs.push(Item {
                section: Section::NeedsYou,
                id: n.id.clone(),
                title: clean(&n.title),
                word: clean(&group.label),
                detail: clean(n.line.as_deref().or(n.reason.as_deref()).unwrap_or("")),
                tone: "attention".into(),
                paused: false,
                age: clean(&n.age),
                project: n.project.as_deref().map(clean),
                need: Some(n.clone()),
                is_task: false,
            });
        }
    }
    needs.into_iter().chain(working).chain(done).collect()
}

/// Errors that end the screen whichever read they came from (a stale read's other errors are dropped).
fn fatal(e: &ApiError) -> bool {
    matches!(e, ApiError::SessionEnded | ApiError::Contract(_))
}
