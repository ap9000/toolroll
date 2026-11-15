//! The screen's state and what changes it: one struct, updated by keys, mouse and engine answers, drawn immediate-mode
//! each frame (view.rs). Nothing here talks to the network: an update returns the effects the loop runs (run.rs), so
//! every screen state can be built and snapshotted from fixtures.
use crate::review::{self, Code, Kind, Note, NoteAt, Row, Side};
use crate::syntax::Highlights;
use crate::term::{Link, Pane};
use crate::text::clean;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::Rect;
use std::collections::{BTreeMap, HashMap, HashSet};
use toolroll_api::{
    ActOutcome, AgentsRead, ApiError, LiveRecord, LiveSessionWindow, LiveSignal, NeedRow, Question,
    ResultDiff, ResultDiffContext, ResultDiffFile, StepCards, TermEvent, TermSend, Window, WorkRow,
    WorkRows,
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
    /// A note on a line or hunk of the diff on screen: kept in this task's draft, never sent by itself.
    Line(NoteTarget),
}

/// Where a note being typed goes: the task, build and file it was opened on, and the line or hunk.
#[derive(Debug, Clone, PartialEq)]
pub struct NoteTarget {
    pub task: String,
    pub run: i64,
    pub file: i64,
    pub path: String,
    pub at: NoteAt,
    pub order: i64,
}

/// Said when notes don't fit the dialog that would send them (nothing is sent unless every note was shown).
pub const NOTES_TOO_LONG: &str =
    "These notes don't fit on screen. Make the window larger, or send them from the browser (w).";

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
    /// Accept the result: a plain completion of the receipt read (no acceptance of anything not shown here). With
    /// `accept_attach`, the notes shown go with it (saved on the result first).
    ConfirmAccept(ReviewPin),
    /// Send back with the notes in this task's draft, shown whole, and words for the whole change being typed.
    SendBack(ReviewPin, String),
    /// Send back's whole text, frozen when the words were typed, shown wrapped and scrolled (j/k, Space): Enter sends
    /// exactly this text, and only once the view has drawn its end (`seen_end`, set by view.rs, never by a key).
    SendReview {
        pin: ReviewPin,
        typed: String,
        text: String,
        scroll: usize,
        seen_end: bool,
    },
    /// A batch is on its way: no other act starts until its answer comes.
    Sending(String),
    /// The screen was given back to the terminal so a copied hunk can be selected in its scrollback; any key returns.
    Copied,
    Help,
    /// The settings in use and their file (settings.rs): read-only, but `t` changes the theme for the session.
    Settings,
    Quit,
    /// Nothing more can happen here: the words, and the exit code a key ends with.
    Fatal(String, i32),
    /// Typing in the Terminal tab's terminal (T4, take over): every key, paste and mouse event in the pane goes to that
    /// one terminal, Ctrl-C included; only Ctrl-] comes back to the workbench.
    TakeOver,
}

/// Said when a take-over starts typing (the key bar, or the pane's line, says how to come back).
pub const TYPING: &str = "Typing in the terminal. It keeps running in Toolroll after you leave.";
/// Said when Ctrl-] leaves the terminal.
pub const BACK: &str = "Back to the workbench. The terminal keeps running in Toolroll.";
/// Said when there is no saved build to take over yet.
pub const STILL_BUILDING: &str =
    "This build is still running. Stop it (x) or wait for its result, then press t to take over.";

/// A take-over's socket, as the loop holds it: what the screen sends that one terminal. (Effects and messages name the
/// terminal by id; the loop sends only to the one the pane shows.)
#[derive(Clone)]
pub struct TermLink(pub tokio::sync::mpsc::UnboundedSender<TermSend>);
impl std::fmt::Debug for TermLink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "TermLink")
    }
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
    /// The agents on this computer (GET /engine/agents), read while there are no tasks: the first run's lines.
    FetchAgents,
    FetchSteps(String),
    FetchLive {
        run: i64,
        file: &'static str,
        cursor: Option<String>,
    },
    FetchDiff(DiffAsk),
    FetchDiffFile(FileAsk),
    FetchContext(ContextAsk),
    Act {
        path: String,
        fields: Vec<(String, String)>,
        done: String,
    },
    /// A batch of notes, sent with the person's act: each POST in turn, stopping at the first refusal. The draft
    /// (`task`, `run`) is cleared once the notes are on the engine's side.
    Send {
        acts: Vec<SendAct>,
        task: String,
        run: i64,
        /// The exact text the batch carries (its identity's key).
        text: String,
    },
    /// Leave the alternate screen and write these lines to the terminal's own scrollback (copy without OSC 52).
    Scrollback(Vec<String>),
    /// Back to the alternate screen after Scrollback.
    ResumeScreen,
    /// The live rooms for what's on screen now (besides `workspace`).
    Watch(Vec<String>),
    OpenBrowser,
    Notify(String),
    Exit(i32),
    /// Take over (T4): find this session's terminal on that task's build (GET /term/state), else start one
    /// (POST /term/start), then attach (GET /term/<id>/socket).
    TermOpen {
        task: String,
        run: i64,
    },
    /// Typed input or a new size for terminal `id` (dropped unless it is the terminal the pane shows).
    TermSend {
        id: String,
        send: TermSend,
    },
    /// Let go of terminal `id`'s socket (the program keeps running in the console).
    TermDetach(String),
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

/// A batch submitted and not yet done: its request identity, and whether its notes are known to be saved on the
/// result (then a retry of Accept only completes). Kept per payload (task, build, the exact text posted).
#[derive(Debug, Clone, PartialEq)]
pub struct Pending {
    pub request: String,
    pub saved: bool,
}

/// One POST of a batch: path, form fields, and the words when it is kept.
#[derive(Debug, Clone, PartialEq)]
pub struct SendAct {
    pub path: String,
    pub fields: Vec<(String, String)>,
    pub done: String,
}

/// One read of hidden lines: task, build, file, generation and the lines asked, all matched against the answer and the
/// file on screen (a late answer for another file or an older ask is dropped).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextAsk {
    pub task: String,
    pub run: i64,
    pub file: i64,
    pub gen: u64,
    pub from: i64,
    pub count: i64,
}

/// An engine answer or signal, as the loop hands it over.
#[derive(Debug, Clone)]
pub enum Msg {
    Work(Result<WorkRows, ApiError>),
    Agents(Result<AgentsRead, ApiError>),
    Steps(String, Result<StepCards, ApiError>),
    Live(i64, &'static str, Result<LiveSessionWindow, ApiError>),
    Diff(DiffAsk, Result<ResultDiff, ApiError>),
    DiffFile(FileAsk, Result<ResultDiffFile, ApiError>),
    Context(ContextAsk, Result<ResultDiffContext, ApiError>),
    /// A batch's outcome: the last act's answer (or the first refusal), and how many acts were kept before it.
    Sent {
        task: String,
        run: i64,
        text: String,
        kept: usize,
        result: Result<ActOutcome, ApiError>,
    },
    Acted(Result<ActOutcome, ApiError>),
    Signal(LiveSignal),
    /// The launcher's answer to an ask (descriptor 4): words to say.
    Said(String),
    Tick,
    /// A take-over's terminal: attached (its id and socket) or why not.
    TermOpened {
        task: String,
        run: i64,
        result: Result<(String, TermLink), ApiError>,
    },
    /// What terminal `id` said.
    Term(String, TermEvent),
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
    /// The first row of the file view drawn (the view keeps the cursor in sight).
    pub diff_scroll: usize,
    /// The row the person is on (notes, expands and copies act on it).
    pub diff_cursor: usize,
    /// Side by side asked for (v); shown only when the pane is wide enough.
    pub diff_split: bool,
    /// The Diff tab's width last frame (view.rs sets it).
    pub diff_width: u16,
    /// The file on screen laid out (with the context revealed), and its rows.
    pub code: Option<Code>,
    pub rows: Vec<Row>,
    /// Moves whenever `code` is laid out again (the colouring keys off it).
    pub code_version: u64,
    /// Lines revealed around the hunks (new-file number → text, cleaned), and the file's length once known.
    pub revealed: BTreeMap<i64, String>,
    pub line_count: Option<i64>,
    context_wanted: Option<ContextAsk>,
    /// Notes per task and build, in memory only, until sent. They survive switching files, tabs and tasks.
    pub drafts: HashMap<(String, i64), Vec<Note>>,
    /// After `n`/`N` moved to another file: land on its first (true) or last note.
    note_jump: Option<bool>,
    /// The file's code coloured so far, and whether more is left (the loop draws again while it is).
    pub highlights: Option<Highlights>,
    pub highlight_pending: bool,
    /// Syntax colours in Diff (their shades come from the theme, theme.rs `code`).
    pub syntax_on: bool,
    /// The notes in the open dialog were all drawn (view.rs): only then may Enter send them.
    pub batch_shown: bool,
    /// Accept carries the notes shown (t in the Accept dialog).
    pub accept_attach: bool,
    /// Every batch submitted for a draft and not yet done, by (task, build, exact text): its request identity, reused
    /// whenever the same text is submitted again, and whether its notes are saved. Kept for the life of the draft.
    pub pending: HashMap<(String, i64, String), Pending>,
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
    /// The agents on this computer (the first run's lines, shown while there are no tasks); None until read.
    pub agents: Option<AgentsRead>,
    pub fetching_agents: bool,
    pub work_again: bool,
    pub areas: Areas,
    /// The Live tab's lines for (transcript version, width): rebuilt only when either moves.
    pub line_cache: Option<LineCache>,
    /// Seconds since the epoch, for elapsed times (the loop sets it; tests fix it).
    pub now: i64,
    /// The Terminal tab's terminal (T4): the selected task's take-over, when one is open.
    pub term: Option<Pane>,
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
            diff_cursor: 0,
            diff_split: false,
            diff_width: 0,
            code: None,
            rows: Vec::new(),
            code_version: 0,
            revealed: BTreeMap::new(),
            line_count: None,
            context_wanted: None,
            drafts: HashMap::new(),
            note_jump: None,
            highlights: None,
            highlight_pending: false,
            syntax_on: true,
            batch_shown: false,
            accept_attach: false,
            pending: HashMap::new(),
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
            agents: None,
            fetching_agents: false,
            work_again: false,
            areas: Areas::default(),
            line_cache: None,
            now: 0,
            term: None,
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
            Msg::Agents(read) => {
                self.fetching_agents = false;
                match read {
                    Ok(read) => self.agents = Some(read),
                    // Only an ended session matters here: the lines are a first-run nicety, never a reason to stop.
                    Err(ApiError::SessionEnded) => return self.failed(ApiError::SessionEnded),
                    Err(_) => {}
                }
                vec![]
            }
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
            Msg::Context(ask, Ok(ctx)) => self.got_context(ask, ctx),
            Msg::Context(ask, Err(e)) => {
                if self.context_wanted.as_ref() != Some(&ask) && !fatal(&e) {
                    return vec![];
                }
                self.context_wanted = None;
                self.failed(e)
            }
            Msg::Sent {
                task,
                run,
                text,
                kept,
                result,
            } => self.sent(task, run, text, kept, result),
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
            Msg::TermOpened { task, run, result } => self.term_opened(task, run, result),
            Msg::Term(id, event) => self.term_event(id, event),
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
        // No tasks yet: the first run's lines about this computer's agents (who the first task goes to, or how to sign in).
        fx.extend(self.fetch_agents());
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
    /// Read the agents on this computer while there are no tasks (one read at a time).
    fn fetch_agents(&mut self) -> Vec<Effect> {
        if !self.loaded || !self.items.is_empty() || self.fetching_agents {
            return vec![];
        }
        self.fetching_agents = true;
        vec![Effect::FetchAgents]
    }

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
        // The console looks for agents in the background: until it has answered (or while nothing is signed in), ask
        // again every few seconds, so a sign-in in another terminal shows up here.
        if self.ticks.is_multiple_of(12)
            && self
                .agents
                .as_ref()
                .is_none_or(|a| a.checked_at.is_none() || a.first_task.is_none())
        {
            let agents = self.fetch_agents();
            if !agents.is_empty() {
                fx = agents;
                fx.extend(gathered);
                return fx;
            }
        }
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
        // Another task: let go of this one's terminal (it keeps running in the console; t on it again reattaches).
        let detached = self.drop_term();
        self.steps = None;
        self.transcript = Transcript::default();
        self.diff = None;
        self.diff_index = 0;
        self.diff_wanted = None;
        self.file_wanted = None;
        self.drop_file();
        self.follow = true;
        self.scroll = 0;
        self.fetching_live = false;
        if matches!(
            self.mode,
            Mode::ConfirmAccept(_)
                | Mode::ConfirmAnswer(_)
                | Mode::Note(..)
                | Mode::SendBack(..)
                | Mode::SendReview { .. }
        ) {
            self.say(Tone::Refused, RESULT_CHANGED);
        }
        if matches!(
            self.mode,
            Mode::ConfirmAnswer(_)
                | Mode::ConfirmAccept(_)
                | Mode::ConfirmStop(_)
                | Mode::Note(..)
                | Mode::SendBack(..)
                | Mode::SendReview { .. }
                | Mode::Steer(_)
        ) {
            self.mode = Mode::Normal;
        }
        let Some(id) = self
            .selected_item()
            .filter(|i| i.is_task)
            .map(|i| i.id.clone())
        else {
            let mut fx = detached;
            fx.push(Effect::Watch(vec![]));
            return fx;
        };
        let mut fx = detached;
        fx.extend([Effect::FetchSteps(id.clone()), Effect::Watch(vec![])]);
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
        // Typing in the terminal: every key is the terminal's (Ctrl-C too), but Ctrl-].
        if self.mode == Mode::TakeOver {
            return self.take_over_key(key);
        }
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            return self.quit();
        }
        match self.mode.clone() {
            Mode::Fatal(_, code) => vec![Effect::Exit(code)],
            Mode::Copied => {
                self.mode = Mode::Normal;
                self.say(Tone::Said, "The hunk stays in your terminal's scrollback.");
                vec![Effect::ResumeScreen]
            }
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
                    // Attach the notes (or not): the dialog stays open, showing what goes with it.
                    KeyCode::Char('t') if !self.notes_of(&pin.task, pin.run).is_empty() => {
                        self.accept_attach = !self.accept_attach;
                        self.batch_shown = false;
                        self.mode = Mode::ConfirmAccept(pin);
                        vec![]
                    }
                    KeyCode::Enter if self.accept_attach && !self.batch_shown => {
                        self.say(Tone::Refused, NOTES_TOO_LONG);
                        vec![]
                    }
                    KeyCode::Enter if self.accept_attach => self.accept_with_notes(pin),
                    KeyCode::Enter => self.accept(pin),
                    _ => {
                        self.say(Tone::Said, "Not accepted.");
                        vec![]
                    }
                }
            }
            Mode::SendBack(pin, text) => {
                let p2 = pin.clone();
                self.typing(
                    key,
                    text,
                    move |app, text| app.mode = Mode::SendBack(p2.clone(), text),
                    move |app, text| app.review_send_back(pin.clone(), text),
                )
            }
            // Nothing else starts while a batch is on its way (Ctrl-C still quits, above).
            Mode::Sending(_) => vec![],
            Mode::SendReview {
                pin,
                typed,
                text,
                scroll,
                seen_end,
            } => {
                let again = |scroll: usize| Mode::SendReview {
                    pin: pin.clone(),
                    typed: typed.clone(),
                    text: text.clone(),
                    scroll,
                    seen_end,
                };
                match key.code {
                    KeyCode::Char('j') | KeyCode::Down => {
                        self.mode = again(scroll + 1);
                        vec![]
                    }
                    KeyCode::Char(' ') | KeyCode::PageDown => {
                        self.mode = again(scroll + 10);
                        vec![]
                    }
                    KeyCode::Char('k') | KeyCode::Up => {
                        self.mode = again(scroll.saturating_sub(1));
                        vec![]
                    }
                    KeyCode::PageUp => {
                        self.mode = again(scroll.saturating_sub(10));
                        vec![]
                    }
                    KeyCode::Enter if !seen_end => {
                        self.mode = again(scroll);
                        self.say(
                            Tone::Refused,
                            "Read it to the end first (j or Space), or send it from the browser (w).",
                        );
                        vec![]
                    }
                    KeyCode::Enter => {
                        self.mode = Mode::Normal;
                        self.send_back_with_notes(pin, typed, text)
                    }
                    // Back to the words, nothing sent.
                    KeyCode::Esc => {
                        self.mode = Mode::SendBack(pin, typed);
                        vec![]
                    }
                    _ => {
                        self.mode = again(scroll);
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
            Mode::TakeOver => vec![],
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

    /// Pasted text goes into the open text box (line breaks as spaces), or, while typing in the terminal, to it.
    pub fn paste(&mut self, pasted: &str) -> Vec<Effect> {
        if self.mode == Mode::TakeOver {
            let Some(pane) = self.term.as_ref().filter(|p| p.live()) else {
                return vec![];
            };
            return match pane.paste_bytes(pasted) {
                Ok(bytes) => self.term_input(bytes),
                Err(words) => {
                    self.say(Tone::Refused, words);
                    vec![]
                }
            };
        }
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
            Mode::Steer(t) | Mode::NewTask(t) | Mode::Note(_, t) | Mode::SendBack(_, t) => grow(t),
            _ => {}
        }
        vec![]
    }

    fn normal_key(&mut self, key: KeyEvent) -> Vec<Effect> {
        if self.tab == Tab::Diff {
            if let Some(fx) = self.diff_key(key) {
                return fx;
            }
        }
        if self.tab == Tab::Terminal {
            if let Some(fx) = self.terminal_tab_key(key) {
                return fx;
            }
        }
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
                self.accept_attach = false;
                self.batch_shown = false;
                self.mode = Mode::ConfirmAccept(pin);
                vec![]
            }
            KeyCode::Char('r') => {
                if let Some(pin) = self.pin_review() {
                    // The notes kept for this result (if any) and words for the whole change, then the whole text to
                    // read to its end before anything is sent.
                    self.mode = Mode::SendBack(pin, String::new());
                }
                vec![]
            }
            KeyCode::Char('n') => {
                self.mode = Mode::NewTask(String::new());
                vec![]
            }
            KeyCode::Char('t') => self.take_over(),
            KeyCode::Char('w') => {
                self.say(Tone::Said, "Opening Toolroll in your browser…");
                vec![Effect::OpenBrowser]
            }
            KeyCode::Char('?') => {
                self.mode = Mode::Help;
                vec![]
            }
            KeyCode::Char('q') => self.quit(),
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

    /// Scroll the right pane: positive is up (older). In Diff the cursor moves with the view.
    pub fn scroll_by(&mut self, lines: i64) {
        if self.tab == Tab::Diff {
            let last = self.rows.len().saturating_sub(1) as i64;
            self.diff_scroll = (self.diff_scroll as i64 - lines).clamp(0, last.max(0)) as usize;
            self.diff_cursor = (self.diff_cursor as i64 - lines).clamp(0, last.max(0)) as usize;
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
        self.drop_file();
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
            self.drop_file();
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
        let same = self.diff_file.as_ref() == Some(&file);
        if !same {
            self.drop_file();
            self.diff_file = Some(file);
            self.relayout();
        }
        if let Some(first) = self.note_jump.take() {
            let notes: Vec<usize> = self.note_rows();
            if let Some(&row) = if first { notes.first() } else { notes.last() } {
                self.diff_cursor = row;
            }
        }
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
            Mode::ConfirmAccept(pin) | Mode::SendBack(pin, _) | Mode::SendReview { pin, .. }
                if self.review_pin_stands(pin) =>
            {
                self.diff_agrees(pin).err()
            }
            Mode::ConfirmAccept(pin) | Mode::SendBack(pin, _) | Mode::SendReview { pin, .. } => {
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
            NoteKind::Line(target) => {
                let notes = self
                    .drafts
                    .entry((target.task.clone(), target.run))
                    .or_default();
                if note.is_empty() {
                    let before = notes.len();
                    notes.retain(|n| !(n.file == target.file && n.at == target.at));
                    if notes.len() < before {
                        self.say(Tone::Said, "Note removed.");
                    }
                } else {
                    review::put(
                        notes,
                        Note {
                            file: target.file,
                            path: target.path,
                            at: target.at,
                            order: target.order,
                            text: clean(&note),
                        },
                    );
                    self.say(
                        Tone::Said,
                        "Note kept. Nothing is sent until you send back (r) or accept with notes (a).",
                    );
                }
                self.rerow();
                vec![]
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

    /// The request identity for a batch of exactly `text` on this result: the one already used for it (a retry, after
    /// an answer that was lost or refused), else a new one. The console dedupes on it (an unchanged retry lands on the
    /// note or revision the first one made), so the same notes are never saved twice.
    fn pending_for(&mut self, task: &str, run: i64, text: &str) -> Pending {
        let key = (task.to_string(), run, text.to_string());
        if let Some(p) = self.pending.get(&key) {
            return p.clone();
        }
        let p = Pending {
            request: self.token(32),
            saved: false,
        };
        self.pending.insert(key, p.clone());
        p
    }

    /// Accept with the notes shown: saved on the result as one note (POST /r/<run>/comment, the result page's own Save
    /// note), then the same plain completion as Accept. Pinned exactly as Accept is; the notes posted are the ones the
    /// dialog drew, under one request identity kept until both are done; notes already saved are not posted again.
    fn accept_with_notes(&mut self, pin: ReviewPin) -> Vec<Effect> {
        if !self.review_pin_stands(&pin) {
            self.say(Tone::Refused, RESULT_CHANGED);
            return vec![];
        }
        if let Err(why) = self.diff_agrees(&pin) {
            self.say(Tone::Refused, why);
            return vec![];
        }
        let text = review::batch_text(&self.notes_of(&pin.task, pin.run), "");
        if text.is_empty() {
            return self.accept(pin);
        }
        if text.chars().count() > review::BATCH_MAX_CHARS {
            self.say(Tone::Refused, too_long(&text));
            return vec![];
        }
        let pending = self.pending_for(&pin.task, pin.run, &text);
        let payload = text.clone();
        let mut acts = vec![];
        if !pending.saved {
            acts.push(SendAct {
                path: format!("/r/{}/comment", pin.run),
                fields: vec![
                    ("note".into(), text),
                    ("request".into(), pending.request),
                    ("path".into(), String::new()),
                    ("line".into(), String::new()),
                ],
                done: "Notes saved on the result.".into(),
            });
        }
        acts.push(SendAct {
            path: format!("/t/{}/complete", toolroll_api::client::encode(&pin.task)),
            fields: vec![
                ("receipt".into(), pin.receipt),
                ("run".into(), pin.run.to_string()),
            ],
            done: "Accepted with your notes. The task is complete.".into(),
        });
        self.mode = Mode::Sending("Saving your notes, then accepting…".into());
        vec![Effect::Send {
            acts,
            task: pin.task,
            run: pin.run,
            text: payload,
        }]
    }

    /// Send back's words are typed: freeze the whole text it would post, and show it to be read to the end.
    fn review_send_back(&mut self, pin: ReviewPin, general: String) -> Vec<Effect> {
        if !self.review_pin_stands(&pin) {
            self.say(Tone::Refused, RESULT_CHANGED);
            return vec![];
        }
        let text = review::batch_text(&self.notes_of(&pin.task, pin.run), &general);
        if text.is_empty() {
            self.say(Tone::Refused, "Say what to change, then press Enter.");
            self.mode = Mode::SendBack(pin, general);
            return vec![];
        }
        if text.chars().count() > review::BATCH_MAX_CHARS {
            self.say(Tone::Refused, too_long(&text));
            self.mode = Mode::SendBack(pin, general);
            return vec![];
        }
        self.status = None;
        self.mode = Mode::SendReview {
            pin,
            typed: general,
            text,
            scroll: 0,
            seen_end: false,
        };
        vec![]
    }

    /// Send back with exactly the text the review showed to its end, as one revise act (POST /r/<run>/comment
    /// intent=revise, the result page's own Send back): pinned exactly as Accept is, under one request identity per text.
    fn send_back_with_notes(&mut self, pin: ReviewPin, typed: String, text: String) -> Vec<Effect> {
        if !self.review_pin_stands(&pin) {
            self.say(Tone::Refused, RESULT_CHANGED);
            return vec![];
        }
        // Notes are about lines of the diff: with any, the diff on screen must be the result's (as for Accept). Words
        // alone for the whole change go back as Send back always has, diff shown or not.
        if !self.notes_of(&pin.task, pin.run).is_empty() {
            if let Err(why) = self.diff_agrees(&pin) {
                self.say(Tone::Refused, why);
                return vec![];
            }
        }
        // Bound to the preview: the notes it was made from must still make exactly that text.
        if review::batch_text(&self.notes_of(&pin.task, pin.run), &typed) != text {
            self.say(
                Tone::Refused,
                "Your notes changed. Look at them again, then send.",
            );
            return vec![];
        }
        let pending = self.pending_for(&pin.task, pin.run, &text);
        let payload = text.clone();
        self.mode = Mode::Sending("Sending it back…".into());
        vec![Effect::Send {
            text: payload,
            acts: vec![SendAct {
                path: format!("/r/{}/comment", pin.run),
                fields: vec![
                    ("intent".into(), "revise".into()),
                    ("note".into(), text),
                    ("request".into(), pending.request),
                    ("batch".into(), String::new()),
                    ("source".into(), pin.source),
                ],
                done: "Sent back. The revision is filed.".into(),
            }],
            task: pin.task,
            run: pin.run,
        }]
    }

    /// A batch's outcome. Done: the draft and its identity are cleared. Refused or unanswered: the notes and the
    /// identity stay for a retry (which the console dedupes), and notes known to be saved are marked so a retry only
    /// completes.
    fn sent(
        &mut self,
        task: String,
        run: i64,
        text: String,
        kept: usize,
        result: Result<ActOutcome, ApiError>,
    ) -> Vec<Effect> {
        if matches!(self.mode, Mode::Sending(_)) {
            self.mode = Mode::Normal;
        }
        let key = (task.clone(), run, text);
        if kept > 0 {
            if let Some(p) = self.pending.get_mut(&key) {
                p.saved = true;
            }
        }
        let saved = self.pending.get(&key).is_some_and(|p| p.saved);
        match result {
            Ok(ActOutcome::Done(words)) => {
                // The draft is done with: its notes and every identity kept for it.
                self.drafts.remove(&(task.clone(), run));
                self.pending
                    .retain(|(t, r, _), _| !(*t == task && *r == run));
                self.rerow();
                self.say(Tone::Said, words);
                self.refresh()
            }
            Ok(ActOutcome::Terms { .. }) => {
                self.say(
                    Tone::Refused,
                    "Toolroll answered something unexpected. Your notes are kept.",
                );
                vec![]
            }
            Ok(ActOutcome::Refused(words)) => {
                if saved {
                    self.say(
                        Tone::Refused,
                        format!(
                            "Your notes are saved on the result, but it wasn't accepted: {words}"
                        ),
                    );
                } else {
                    self.say(Tone::Refused, format!("{words} Your notes are kept."));
                }
                self.refresh()
            }
            Err(e) => self.failed(e),
        }
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
        if let Some(fx) = self.terminal_mouse(&ev) {
            return fx;
        }
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

/// Said when a batch is over the engine's note limit.
fn too_long(text: &str) -> String {
    format!(
        "These notes are too long to send together ({} of {} characters). Remove some, or send them from the browser (w).",
        text.chars().count(),
        review::BATCH_MAX_CHARS
    )
}

// ---- the Diff tab: rows, cursor, notes, context, copy -------------------------------------------------------------

impl App {
    /// The file on screen is gone (another file, build or task): its layout, cursor, revealed lines and pending context
    /// read go with it. Notes stay in their draft.
    fn drop_file(&mut self) {
        self.diff_file = None;
        self.code = None;
        self.rows.clear();
        self.revealed.clear();
        self.line_count = None;
        self.context_wanted = None;
        self.diff_cursor = 0;
        self.diff_scroll = 0;
        self.highlights = None;
        self.highlight_pending = false;
    }

    /// The task, build and file the hunks on screen are of.
    pub fn file_shown(&self) -> Option<(String, i64, i64, String)> {
        self.diff_file
            .as_ref()
            .map(|f| (f.task.clone(), f.run, f.file.file, clean(&f.file.path)))
    }

    /// The notes kept for a task's build, in order.
    pub fn notes_of(&self, task: &str, run: i64) -> Vec<Note> {
        self.drafts
            .get(&(task.to_string(), run))
            .cloned()
            .unwrap_or_default()
    }

    /// The notes on the file on screen (what `Row::Note` indexes).
    pub fn notes_here(&self) -> Vec<Note> {
        match self.file_shown() {
            Some((task, run, file, _)) => self
                .notes_of(&task, run)
                .into_iter()
                .filter(|n| n.file == file)
                .collect(),
            None => vec![],
        }
    }

    /// Side by side is shown: asked for, and the pane is wide enough.
    pub fn split_on(&self) -> bool {
        self.diff_split && self.diff_width >= review::SPLIT_MIN_WIDTH
    }

    /// The view's width this frame: the rows follow it when side by side starts or stops fitting.
    pub fn set_diff_width(&mut self, width: u16) {
        let before = self.split_on();
        self.diff_width = width;
        if before != self.split_on() {
            self.rerow();
        }
    }

    /// Lay the file out again (revealed lines changed), keeping the cursor on the same line.
    fn relayout(&mut self) {
        let keep = self.cursor_identity();
        self.code = self
            .diff_file
            .as_ref()
            .map(|f| review::layout(f, &self.revealed, self.line_count));
        self.code_version += 1;
        self.rerow();
        if let Some(id) = keep {
            if let Some(at) = self.find_identity(&id) {
                self.diff_cursor = at;
            }
        }
    }

    /// The rows again (notes or side by side changed).
    fn rerow(&mut self) {
        let notes = self.notes_here();
        self.rows = match &self.code {
            Some(code) => review::rows(code, &notes, self.split_on()),
            None => vec![],
        };
        self.diff_cursor = self.diff_cursor.min(self.rows.len().saturating_sub(1));
    }

    fn note_rows(&self) -> Vec<usize> {
        self.rows
            .iter()
            .enumerate()
            .filter(|(_, r)| matches!(r, Row::Note(_)))
            .map(|(i, _)| i)
            .collect()
    }

    /// What the cursor is on, as something that survives a new layout: a hunk, or a line by its numbers.
    fn cursor_identity(&self) -> Option<(char, Option<i64>, Option<i64>)> {
        let code = self.code.as_ref()?;
        match self.rows.get(self.diff_cursor)? {
            Row::Hunk(h) => Some(('h', Some(*h as i64), None)),
            Row::Code(c) | Row::Pair(_, Some(c)) | Row::Pair(Some(c), None) => {
                let l = &code.lines[*c];
                Some(('l', l.old, l.new))
            }
            Row::Gap { hunk, .. } => Some(('g', Some(*hunk as i64), None)),
            _ => None,
        }
    }

    fn find_identity(&self, id: &(char, Option<i64>, Option<i64>)) -> Option<usize> {
        let code = self.code.as_ref()?;
        self.rows.iter().position(|r| match (id.0, r) {
            ('h', Row::Hunk(h)) => Some(*h as i64) == id.1,
            ('g', Row::Gap { hunk, .. }) => Some(*hunk as i64) == id.1,
            ('l', Row::Code(c))
            | ('l', Row::Pair(_, Some(c)))
            | ('l', Row::Pair(Some(c), None)) => {
                let l = &code.lines[*c];
                (l.old, l.new) == (id.1, id.2)
            }
            _ => false,
        })
    }

    /// The hunk a row belongs to (a gap: the hunk below it).
    fn hunk_at(&self, row: usize) -> Option<usize> {
        let code = self.code.as_ref()?;
        match self.rows.get(row)? {
            Row::Hunk(h) => Some(*h),
            Row::Gap { hunk, .. } => Some(*hunk),
            Row::Code(c) | Row::Pair(Some(c), _) | Row::Pair(None, Some(c)) => {
                Some(code.lines[*c].hunk)
            }
            Row::Note(_) | Row::Pair(None, None) => {
                (0..row).rev().find_map(|r| match &self.rows[r] {
                    Row::Note(_) => None,
                    _ => self.hunk_at(r),
                })
            }
        }
    }

    fn move_cursor(&mut self, by: i64) {
        let last = self.rows.len().saturating_sub(1) as i64;
        self.diff_cursor = (self.diff_cursor as i64 + by).clamp(0, last.max(0)) as usize;
    }

    /// The Diff tab's own keys (None: the key means what it means everywhere). Nothing here sends anything: notes,
    /// moves, expands and copies stay on this computer, except a context read, which only reads.
    fn diff_key(&mut self, key: KeyEvent) -> Option<Vec<Effect>> {
        let fx = match key.code {
            KeyCode::Char('j') | KeyCode::Down => {
                self.move_cursor(1);
                vec![]
            }
            KeyCode::Char('k') | KeyCode::Up => {
                self.move_cursor(-1);
                vec![]
            }
            KeyCode::PageDown | KeyCode::Char('d') => {
                self.move_cursor(10);
                vec![]
            }
            KeyCode::PageUp | KeyCode::Char('u') => {
                self.move_cursor(-10);
                vec![]
            }
            KeyCode::Home | KeyCode::Char('g') => {
                self.diff_cursor = 0;
                vec![]
            }
            KeyCode::End | KeyCode::Char('G') => {
                self.diff_cursor = self.rows.len().saturating_sub(1);
                vec![]
            }
            KeyCode::Char(']') => self.hunk_step(1),
            KeyCode::Char('[') => self.hunk_step(-1),
            KeyCode::Char('}') => self.diff_step(1),
            KeyCode::Char('{') => self.diff_step(-1),
            KeyCode::Char('n') => self.note_step(true),
            KeyCode::Char('N') => self.note_step(false),
            KeyCode::Char('c') => self.start_note(),
            KeyCode::Backspace | KeyCode::Delete => self.remove_note(),
            KeyCode::Char('e') => self.expand(true),
            KeyCode::Char('E') => self.expand(false),
            KeyCode::Enter if matches!(self.rows.get(self.diff_cursor), Some(Row::Gap { .. })) => {
                self.expand(true)
            }
            KeyCode::Char('v') => {
                self.diff_split = !self.diff_split;
                if self.diff_split && self.diff_width > 0 && !self.split_on() {
                    self.say(
                        Tone::Said,
                        "Side by side needs a wider window, so the changes stay in one column.",
                    );
                }
                self.rerow();
                vec![]
            }
            KeyCode::Char('y') => self.copy_hunk(),
            _ => return None,
        };
        Some(fx)
    }

    fn hunk_step(&mut self, by: i64) -> Vec<Effect> {
        let heads: Vec<usize> = self
            .rows
            .iter()
            .enumerate()
            .filter(|(_, r)| matches!(r, Row::Hunk(_)))
            .map(|(i, _)| i)
            .collect();
        let next = if by > 0 {
            heads.iter().find(|&&i| i > self.diff_cursor)
        } else {
            heads.iter().rev().find(|&&i| i < self.diff_cursor)
        };
        match next {
            Some(&i) => {
                self.diff_cursor = i;
                self.diff_scroll = i;
            }
            None => self.say(
                Tone::Said,
                if by > 0 {
                    "That's the last hunk in this file. } goes to the next file."
                } else {
                    "That's the first hunk in this file. { goes to the previous file."
                },
            ),
        }
        vec![]
    }

    /// The next (or previous) note: in this file, else the next file with notes (its hunks are read first).
    fn note_step(&mut self, forward: bool) -> Vec<Effect> {
        let rows = self.note_rows();
        let here = if forward {
            rows.iter().find(|&&i| i > self.diff_cursor)
        } else {
            rows.iter().rev().find(|&&i| i < self.diff_cursor)
        };
        if let Some(&i) = here {
            self.diff_cursor = i;
            return vec![];
        }
        let (Some((task, run, file, _)), Some(diff)) = (self.file_shown(), self.diff.clone())
        else {
            return vec![];
        };
        let with_notes: HashSet<i64> = self.notes_of(&task, run).iter().map(|n| n.file).collect();
        let order: Vec<usize> = if forward {
            (self.diff_index + 1..diff.files.len()).collect()
        } else {
            (0..self.diff_index).rev().collect()
        };
        match order
            .into_iter()
            .find(|&i| with_notes.contains(&diff.files[i].file) && diff.files[i].file != file)
        {
            Some(i) => {
                self.note_jump = Some(forward);
                self.diff_step(i as i64 - self.diff_index as i64)
            }
            None => {
                self.say(
                    Tone::Said,
                    if self.drafts.get(&(task, run)).is_none_or(Vec::is_empty) {
                        "No notes yet. Press c on a line to leave one."
                    } else if forward {
                        "No more notes after this one."
                    } else {
                        "No notes before this one."
                    },
                );
                vec![]
            }
        }
    }

    /// `c`: a note on the line or hunk under the cursor (or edit the note under it).
    fn start_note(&mut self) -> Vec<Effect> {
        let (Some((task, run, file, path)), Some(code)) = (self.file_shown(), self.code.as_ref())
        else {
            self.say(Tone::Refused, "Open a file's changes first.");
            return vec![];
        };
        let notes = self.notes_here();
        let line_target = |c: usize| {
            let l = &code.lines[c];
            match (l.kind, l.old, l.new) {
                (Kind::Meta, ..) => None,
                (Kind::Deletion, Some(o), _) => Some((NoteAt::Line(Side::Old, o), o)),
                (_, _, Some(n)) => Some((NoteAt::Line(Side::New, n), n)),
                _ => None,
            }
        };
        let (at, order, text) = match self.rows.get(self.diff_cursor) {
            Some(Row::Hunk(h)) => (
                NoteAt::Hunk(code.headers[*h].clone()),
                code.spans[*h].map(|s| s.first_new).unwrap_or(0),
                String::new(),
            ),
            Some(Row::Code(c)) | Some(Row::Pair(_, Some(c))) | Some(Row::Pair(Some(c), None)) => {
                match line_target(*c) {
                    Some((at, order)) => (at, order, String::new()),
                    None => {
                        self.say(
                            Tone::Refused,
                            "Move to a line or a hunk heading to leave a note.",
                        );
                        return vec![];
                    }
                }
            }
            Some(Row::Note(k)) => match notes.get(*k) {
                Some(n) => (n.at.clone(), n.order, n.text.clone()),
                None => return vec![],
            },
            _ => {
                self.say(
                    Tone::Refused,
                    "Move to a line or a hunk heading to leave a note.",
                );
                return vec![];
            }
        };
        // Editing the note already on this spot.
        let text = if text.is_empty() {
            notes
                .iter()
                .find(|n| n.at == at)
                .map(|n| n.text.clone())
                .unwrap_or_default()
        } else {
            text
        };
        self.mode = Mode::Note(
            NoteKind::Line(NoteTarget {
                task,
                run,
                file,
                path,
                at,
                order,
            }),
            text,
        );
        vec![]
    }

    fn remove_note(&mut self) -> Vec<Effect> {
        let Some(Row::Note(k)) = self.rows.get(self.diff_cursor).cloned() else {
            return vec![];
        };
        let (Some((task, run, _, _)), Some(note)) =
            (self.file_shown(), self.notes_here().get(k).cloned())
        else {
            return vec![];
        };
        if let Some(notes) = self.drafts.get_mut(&(task, run)) {
            notes.retain(|n| *n != note);
        }
        self.rerow();
        self.say(Tone::Said, "Note removed.");
        vec![]
    }

    /// `e` / `E`: reveal up to EXPAND_STEP hidden lines next to the hunk under the cursor (above it with `e`, below it
    /// with `E`); on a hidden-lines marker, its lines nearest the hunk below (`e`) or above (`E`).
    fn expand(&mut self, above: bool) -> Vec<Effect> {
        let (Some((task, run, file, _)), Some(code)) = (self.file_shown(), self.code.as_ref())
        else {
            return vec![];
        };
        let hunks = code.spans.len();
        if hunks == 0 {
            return vec![];
        }
        let on_gap = matches!(self.rows.get(self.diff_cursor), Some(Row::Gap { .. }));
        let Some(h) = self.hunk_at(self.diff_cursor) else {
            return vec![];
        };
        // The gap to open and which end of it: `true` = its bottom (just above hunk `gap`).
        let (gap, bottom) = match (on_gap, above) {
            (true, true) if h < hunks => (h, true),
            (true, _) => (h, false),
            (false, true) => (h, true),
            (false, false) => (h + 1, false),
        };
        let Some((below, top)) = review::gap_of(&code.spans, gap, self.line_count) else {
            self.say(
                Tone::Refused,
                "The hidden lines here can't be worked out. Press w to see the whole file.",
            );
            return vec![];
        };
        let (from, to) = if bottom {
            let Some(mut end) = top else { return vec![] };
            while end >= below && self.revealed.contains_key(&end) {
                end -= 1;
            }
            (below.max(end - review::EXPAND_STEP + 1), end)
        } else {
            let mut start = below;
            while self.revealed.contains_key(&start) {
                start += 1;
            }
            let end = start + review::EXPAND_STEP - 1;
            (start, top.map_or(end, |t| end.min(t)))
        };
        if to < from {
            self.say(
                Tone::Said,
                if bottom {
                    "Nothing more is hidden above this hunk."
                } else {
                    "Nothing more is hidden below this hunk."
                },
            );
            return vec![];
        }
        self.diff_gen += 1;
        let ask = ContextAsk {
            task,
            run,
            file,
            gen: self.diff_gen,
            from,
            count: to - from + 1,
        };
        self.context_wanted = Some(ask.clone());
        vec![Effect::FetchContext(ask)]
    }

    /// Hidden lines: taken only when they answer the read wanted, for the file still on screen (same task, build and
    /// file), and only the lines asked for that fall between hunks. Anything else is a stale answer, dropped.
    fn got_context(&mut self, ask: ContextAsk, ctx: ResultDiffContext) -> Vec<Effect> {
        let shown = self.file_shown().map(|(t, r, f, _)| (t, r, f));
        if self.context_wanted.as_ref() != Some(&ask)
            || self.selected_id().as_deref() != Some(ask.task.as_str())
            || shown != Some((ask.task.clone(), ask.run, ask.file))
            || ctx.task != ask.task
            || ctx.run != ask.run
            || ctx.file != ask.file
            || ctx.from != ask.from
        {
            return vec![];
        }
        self.context_wanted = None;
        if let Some(problem) = &ctx.problem {
            self.say(Tone::Refused, problem.clone());
            return vec![];
        }
        if let Some(count) = ctx.line_count {
            self.line_count = Some(count.max(0));
        }
        let spans = self
            .code
            .as_ref()
            .map(|c| c.spans.clone())
            .unwrap_or_default();
        let inside_hunk = |n: i64| {
            spans
                .iter()
                .flatten()
                .any(|s| n >= s.first_new && n <= s.last_new)
        };
        for line in ctx.lines {
            let n = line.new_line;
            if n >= ask.from && n < ask.from + ask.count && !inside_hunk(n) {
                self.revealed.insert(n, clean(&line.text));
            }
        }
        self.relayout();
        vec![]
    }

    /// `y`: the hunk under the cursor, written to the terminal's own scrollback (the screen steps aside until a key),
    /// never to the clipboard by escape sequence. Every line is cleaned text.
    fn copy_hunk(&mut self) -> Vec<Effect> {
        let (Some(file), Some(h)) = (self.diff_file.as_ref(), self.hunk_at(self.diff_cursor))
        else {
            return vec![];
        };
        let Some(hunk) = file.file.hunks.get(h) else {
            self.say(Tone::Said, "Move to a hunk to copy it.");
            return vec![];
        };
        let mut lines = vec![format!(
            "{} {}",
            clean(&file.file.path),
            clean(&hunk.header)
        )];
        for l in &hunk.lines {
            let sign = match l.kind.as_str() {
                "addition" => '+',
                "deletion" => '-',
                _ => ' ',
            };
            lines.push(format!("{sign}{}", clean(&l.text)));
        }
        self.mode = Mode::Copied;
        vec![Effect::Scrollback(lines)]
    }
}

// ---- take over: the Terminal tab's terminal (T4) ----------------------------------------------------------------------

impl App {
    /// The selected task's terminal pane, when the Terminal tab shows one.
    pub fn pane_here(&self) -> Option<&Pane> {
        let id = self.selected_item().filter(|i| i.is_task)?.id.as_str();
        self.term.as_ref().filter(|p| p.task == id)
    }

    /// Let go of the pane and its socket (the program runs on in the console).
    fn drop_term(&mut self) -> Vec<Effect> {
        if self.mode == Mode::TakeOver {
            self.mode = Mode::Normal;
        }
        match self.term.take().and_then(|p| p.id) {
            Some(id) => vec![Effect::TermDetach(id)],
            None => vec![],
        }
    }

    /// `t`: type in a terminal on this task's latest saved build. The one already open is typed in again; otherwise the
    /// console's own terminal on that build is found (or started) and attached. The build named is the result waiting
    /// for review, else the newest finished build; a build still running has nothing saved to open on.
    fn take_over(&mut self) -> Vec<Effect> {
        let Some(item) = self.selected_item().filter(|i| i.is_task).cloned() else {
            self.say(Tone::Refused, "Choose a task to take over.");
            return vec![];
        };
        self.tab = Tab::Terminal;
        if let Some(pane) = self.pane_here() {
            match pane.link {
                Link::Live => {
                    self.mode = Mode::TakeOver;
                    self.say(Tone::Said, TYPING);
                    return vec![];
                }
                Link::Opening | Link::Attaching => return vec![],
                Link::Ended { .. } | Link::Closed(_) => {}
            }
        }
        let Some(steps) = self.steps.as_ref() else {
            self.say(Tone::Said, "Reading this task — press t again in a moment.");
            return vec![];
        };
        let newest_build = steps
            .cards
            .iter()
            .flatten()
            .filter(|c| c.key == "build")
            .flat_map(|c| c.runs.first().copied())
            .next();
        let run = steps.review.as_ref().map(|r| r.run).or(newest_build);
        match run {
            Some(run) if Some(run) != steps.live_run => {
                let mut fx = self.drop_term();
                self.term = Some(Pane::opening(item.id.clone(), run));
                self.status = Some((Tone::Said, format!("Opening a terminal on build #{run}…")));
                fx.push(Effect::TermOpen { task: item.id, run });
                fx
            }
            _ if steps.live_run.is_some() => {
                self.say(Tone::Refused, STILL_BUILDING);
                vec![]
            }
            _ => {
                self.say(
                    Tone::Refused,
                    "This task has no finished build to take over yet.",
                );
                vec![]
            }
        }
    }

    fn term_opened(
        &mut self,
        task: String,
        run: i64,
        result: Result<(String, TermLink), ApiError>,
    ) -> Vec<Effect> {
        let wanted = self
            .term
            .as_ref()
            .is_some_and(|p| p.task == task && p.run == run && p.link == Link::Opening);
        match result {
            Ok((id, _link)) if wanted => {
                if let Some(pane) = self.term.as_mut() {
                    pane.attached(id);
                }
                // Straight to typing, when the person is still looking at it.
                if self.tab == Tab::Terminal
                    && self.pane_here().is_some()
                    && matches!(self.mode, Mode::Normal)
                {
                    self.mode = Mode::TakeOver;
                    self.say(Tone::Said, TYPING);
                }
                vec![]
            }
            // Opened for a pane no longer wanted (another task, another build): let go of it.
            Ok((id, _)) => vec![Effect::TermDetach(id)],
            Err(e) if wanted => {
                let words = e.to_string();
                if let Some(pane) = self.term.as_mut() {
                    pane.link = Link::Closed(clean(&words));
                }
                if matches!(e, ApiError::SessionEnded) {
                    return self.failed(e);
                }
                self.say(Tone::Refused, words);
                vec![]
            }
            Err(_) => vec![],
        }
    }

    fn term_event(&mut self, id: String, event: TermEvent) -> Vec<Effect> {
        let Some(pane) = self
            .term
            .as_mut()
            .filter(|p| p.id.as_deref() == Some(id.as_str()))
        else {
            return vec![];
        };
        let mut back = false;
        let mut said: Option<(Tone, String)> = None;
        match event {
            TermEvent::Output(bytes) => {
                pane.input_full = false;
                pane.output(&bytes);
            }
            TermEvent::Hello { cols, rows, ended } => pane.hello(cols, rows, ended),
            TermEvent::Exit { code, signal } => {
                pane.link = Link::Ended { code, signal };
                back = true;
                said = Some((
                    Tone::Said,
                    "The terminal's program ended. Press t to open a new terminal.".into(),
                ));
            }
            TermEvent::InputFull => {
                pane.input_full = true;
                said = Some((
                    Tone::Said,
                    "The program isn't reading input right now; what you type waits until it does."
                        .into(),
                ));
            }
            TermEvent::Closed { code } => {
                if !matches!(pane.link, Link::Ended { .. }) {
                    let words = match code {
                        Some(4401) => "This terminal is no longer yours to type in (signed out, or someone else joined this Toolroll).",
                        Some(4008) => "The terminal fell behind. Press t to attach again.",
                        Some(1008) => "Typing went faster than the terminal reads. Press t to attach again.",
                        Some(4429) => "This terminal is open in too many places. Close one, then press t.",
                        _ => "The terminal's connection closed. It keeps running in Toolroll — press t to attach again.",
                    };
                    pane.link = Link::Closed(words.into());
                    said = Some((Tone::Refused, words.into()));
                }
                back = true;
            }
        }
        if back && self.mode == Mode::TakeOver {
            self.mode = Mode::Normal;
        }
        if let Some((tone, words)) = said {
            self.say(tone, words);
        }
        vec![]
    }

    /// Bytes for the terminal the pane shows (only while live).
    fn term_input(&mut self, bytes: Vec<u8>) -> Vec<Effect> {
        let Some(pane) = self.term.as_mut().filter(|p| p.live()) else {
            return vec![];
        };
        let (Some(id), Ok(text)) = (pane.id.clone(), String::from_utf8(bytes)) else {
            return vec![];
        };
        // Typing shows the live screen again.
        if pane.scroll > 0 {
            pane.scroll_by(-(pane.scroll as i64));
        }
        vec![Effect::TermSend {
            id,
            send: TermSend::Input(text),
        }]
    }

    /// A key while typing in the terminal: Ctrl-] goes back; every other key is the terminal's.
    fn take_over_key(&mut self, key: KeyEvent) -> Vec<Effect> {
        if crate::term::is_back_key(&key) {
            self.mode = Mode::Normal;
            self.say(Tone::Said, BACK);
            return vec![];
        }
        let Some(pane) = self.term.as_ref().filter(|p| p.live()) else {
            self.mode = Mode::Normal;
            return vec![];
        };
        match pane.key_bytes(key) {
            Some(bytes) => self.term_input(bytes),
            None => vec![],
        }
    }

    /// The Terminal tab's own keys while not typing: scroll its scrollback, copy it, follow the live screen again.
    fn terminal_tab_key(&mut self, key: KeyEvent) -> Option<Vec<Effect>> {
        let pane = self.term.as_mut()?;
        match key.code {
            KeyCode::PageUp | KeyCode::Char('u') => {
                pane.scroll_by(i64::from(pane.area.height.max(2) - 1))
            }
            KeyCode::PageDown | KeyCode::Char('d') => {
                pane.scroll_by(-i64::from(pane.area.height.max(2) - 1))
            }
            KeyCode::End | KeyCode::Char('G') => pane.scroll_by(-(pane.scroll as i64)),
            KeyCode::Char('y') => {
                // The terminal's scrollback and screen, as text, into the real terminal's own scrollback (no clipboard
                // escape is ever written).
                let lines = pane.text_lines();
                if lines.is_empty() {
                    self.say(Tone::Said, "Nothing in the terminal to copy yet.");
                    return Some(vec![]);
                }
                self.mode = Mode::Copied;
                return Some(vec![Effect::Scrollback(lines)]);
            }
            _ => return None,
        }
        Some(vec![])
    }

    /// The mouse over the terminal: to the program when it asked for the mouse (while typing), else the wheel scrolls
    /// the scrollback here; a click in the pane starts typing; a click outside it while typing goes back first.
    fn terminal_mouse(&mut self, ev: &MouseEvent) -> Option<Vec<Effect>> {
        if self.tab != Tab::Terminal {
            return None;
        }
        let pane = self.term.as_mut()?;
        let a = pane.area;
        let inside = ev.column >= a.x
            && ev.row >= a.y
            && ev.column < a.x + a.width
            && ev.row < a.y + a.height;
        if !inside {
            if self.mode == Mode::TakeOver && matches!(ev.kind, MouseEventKind::Down(_)) {
                self.mode = Mode::Normal;
                self.say(Tone::Said, BACK);
            }
            return None;
        }
        if self.mode == Mode::TakeOver {
            if let Some(bytes) = pane.mouse_bytes(ev) {
                return Some(self.term_input(bytes));
            }
        }
        match ev.kind {
            MouseEventKind::ScrollUp => pane.scroll_by(3),
            MouseEventKind::ScrollDown => pane.scroll_by(-3),
            MouseEventKind::Down(MouseButton::Left) if self.mode == Mode::Normal && pane.live() => {
                self.mode = Mode::TakeOver;
                self.say(Tone::Said, TYPING);
            }
            _ => {}
        }
        Some(vec![])
    }

    /// After a frame: the pane's new size for its terminal, when it changed (resizing follows the pane).
    pub fn term_resize(&mut self) -> Option<Effect> {
        let pane = self.term.as_mut()?;
        let id = pane.id.clone()?;
        let (cols, rows) = pane.wanted_size()?;
        Some(Effect::TermSend {
            id,
            send: TermSend::Resize { cols, rows },
        })
    }
}
