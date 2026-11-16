//! The screen's state and what changes it: one struct, updated by keys, mouse and engine answers, drawn immediate-mode
//! each frame (view.rs). Nothing here talks to the network: an update returns the effects the loop runs (run.rs), so
//! every screen state can be built and snapshotted from fixtures.
use crate::keys::{Action, Scope};
use crate::palette::Pick;
use crate::review::{self, Code, Kind, Note, NoteAt, Row, Side};
use crate::syntax::Highlights;
use crate::term::{Link, Pane};
use crate::text::clean;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::Rect;
use std::collections::{BTreeMap, HashMap, HashSet};
use toolroll_api::{
    ActOutcome, AgentsRead, ApiError, LiveRecord, LiveSessionWindow, LiveSignal, LiveThreads,
    NeedRow, Question, ResultDiff, ResultDiffContext, ResultDiffFile, Spend, StepCards, TermEvent,
    TermSend, Window, WorkRow, WorkRows,
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
    /// Queued, or waiting to start again (a retry after a temporary problem).
    UpNext,
    /// Everything else Work sends: finished, failed, stopped, put away.
    Recent,
}

impl Section {
    pub const ALL: [Section; 4] = [
        Section::NeedsYou,
        Section::Working,
        Section::UpNext,
        Section::Recent,
    ];
    pub fn label(self) -> &'static str {
        match self {
            Section::NeedsYou => "Needs you",
            Section::Working => "Working",
            Section::UpNext => "Up next",
            Section::Recent => "Recent",
        }
    }
    /// The left column's order.
    pub fn order(self) -> u8 {
        match self {
            Section::NeedsYou => 0,
            Section::Working => 1,
            Section::UpNext => 2,
            Section::Recent => 3,
        }
    }
}

/// Where a Work row is listed. Total over every row Work can send: the group and tone are the contract's closed enums
/// (WORK_ROW_GROUPS, WORK_STATUS_TONES) and the status token is open, so nothing here drops a row; a row nothing else
/// places is Recent.
pub fn section_of(r: &WorkRow) -> Section {
    let waits = r.need.is_some()
        || matches!(r.group.as_str(), "decide" | "review" | "unblock")
        || r.status.tone == "attention";
    if waits {
        Section::NeedsYou
    } else if r.group == "building" || r.status.tone == "live" || r.rank == 1 {
        Section::Working
    } else if r.rank == 2 || r.status.token.contains("queued") {
        Section::UpNext
    } else {
        Section::Recent
    }
}

/// What the list shows (picked in the palette; the saved ones are remembered between runs, state.rs).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Filter {
    All,
    /// The terminal's own project (the launcher's).
    ThisProject,
    /// What waits on you.
    NeedsMe,
    /// What moved today.
    Today,
    /// What agents are working on (and what is up next).
    Working,
    /// What failed.
    Failed,
    /// What finished.
    Done,
    /// One project, picked by name in the palette (not remembered).
    Project(String),
}

impl Filter {
    /// Its word in the state file (a picked project is remembered as everything).
    pub fn key(&self) -> &'static str {
        match self {
            Filter::All | Filter::Project(_) => "all",
            Filter::ThisProject => "this-project",
            Filter::NeedsMe => "needs-me",
            Filter::Today => "today",
            Filter::Working => "working",
            Filter::Failed => "failed",
            Filter::Done => "done",
        }
    }
    pub fn from_key(key: &str) -> Option<Filter> {
        Some(match key {
            "all" => Filter::All,
            "this-project" => Filter::ThisProject,
            "needs-me" => Filter::NeedsMe,
            "today" => Filter::Today,
            "working" => Filter::Working,
            "failed" => Filter::Failed,
            "done" => Filter::Done,
            _ => return None,
        })
    }
    /// The palette action that picks it.
    pub fn action(&self) -> Option<Action> {
        match self {
            Filter::All => Some(Action::FilterAll),
            Filter::ThisProject => Some(Action::FilterThisProject),
            Filter::NeedsMe => Some(Action::FilterNeedsMe),
            Filter::Today => Some(Action::FilterToday),
            Filter::Working => Some(Action::FilterWorking),
            Filter::Failed => Some(Action::FilterFailed),
            Filter::Done => Some(Action::FilterDone),
            Filter::Project(_) => None,
        }
    }
    /// How the list's heading names it (None: everything).
    pub fn words(&self) -> Option<String> {
        match self {
            Filter::All => None,
            Filter::ThisProject => Some("This project".into()),
            Filter::NeedsMe => Some("Needs me".into()),
            Filter::Today => Some("Today".into()),
            Filter::Working => Some("Working".into()),
            Filter::Failed => Some("Failed".into()),
            Filter::Done => Some("Done".into()),
            Filter::Project(p) => Some(p.clone()),
        }
    }
    /// Whether a row is shown (`here`: the terminal's project's name and path).
    fn keeps(&self, item: &Item, here: Option<(&str, &str)>) -> bool {
        match self {
            Filter::All => true,
            Filter::ThisProject => here.is_some_and(|(name, path)| {
                item.project
                    .as_deref()
                    .is_some_and(|p| p == name || p == path)
            }),
            Filter::NeedsMe => item.section == Section::NeedsYou,
            Filter::Today => age_secs(&item.age).is_some_and(|s| s < 86_400),
            Filter::Working => matches!(item.section, Section::Working | Section::UpNext),
            Filter::Failed => item.tone == "problem" || item.word == "Failed",
            Filter::Done => item.section == Section::Recent && item.tone == "done",
            Filter::Project(p) => item.project.as_deref() == Some(p.as_str()),
        }
    }
}

/// Work's age words as seconds ("just now", "42s ago", "3m ago", "2h ago", "5d ago", "2w ago"); None for anything else.
pub fn age_secs(age: &str) -> Option<i64> {
    let age = age.trim();
    if age == "just now" || age == "now" {
        return Some(0);
    }
    let n = age.strip_suffix(" ago")?;
    let unit = n.chars().last()?;
    let count: i64 = n[..n.len() - unit.len_utf8()].trim().parse().ok()?;
    let secs = match unit {
        's' => 1,
        'm' => 60,
        'h' => 3600,
        'd' => 86_400,
        'w' => 7 * 86_400,
        _ => return None,
    };
    Some(count.saturating_mul(secs))
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
    /// A task row (false: an ask that is no task, opened in the browser, or a thread).
    pub is_task: bool,
    /// A Flexible thread (thread.rs): one more live session, its panel the thread's own.
    pub thread: bool,
    /// A queued task waiting to start again (Work's own facts: when, and why the last build stopped).
    pub waiting: Option<toolroll_api::Waiting>,
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
/// Said when a dialog's key comes but the dialog wasn't on screen in the last frame (a window too small to draw it).
pub const UNDRAWN: &str = "Make the window bigger to see this first.";

#[derive(Debug, Clone, PartialEq)]
pub enum Mode {
    Normal,
    Steer(String),
    Note(NoteKind, String),
    /// New task: the words typed, and whether it is filed to plan first (Tab, or Shift-Enter) instead of Just code.
    NewTask(String, bool),
    /// The command palette: what is typed and the line picked (palette.rs). Enter runs it as its key would.
    Palette(crate::palette::Palette),
    ConfirmStop(i64),
    /// Retry a failed task: the build and approved scope the steps named (pinned when it opened), posted exactly.
    ConfirmRetry {
        task: String,
        run: i64,
        digest: String,
    },
    /// Stop retrying a waiting task (POST /t/<task>/hold, the task page's "Hold the next attempt"): it stays, nothing
    /// more runs until it is resumed.
    ConfirmHold {
        task: String,
    },
    /// Cancel a task: the state and latest build shown (`run`: None for no build), posted as pins the cancel proves.
    ConfirmCancel {
        task: String,
        title: String,
        state: String,
        run: Option<i64>,
    },
    ConfirmAnswer(AnswerPin),
    /// A thread's question and the answer picked, pinned (thread.rs): Enter posts exactly them.
    ConfirmThread(crate::thread::ThreadPin),
    /// A new thread's first message (refused by the engine while Flexible isn't available).
    NewThread(String),
    /// A new thread's terms card, read whole before Enter starts it (thread.rs StartTerms).
    StartThread(crate::thread::StartTerms),
    /// The Agents screen: an agent's install command, shown whole; only Enter here runs exactly it in a pane.
    ConfirmInstall {
        agent: String,
        name: String,
        command: String,
    },
    /// The Agents screen: choosing a role's model, or the default agent.
    PickModel(crate::agents::Pick),
    /// The Agents screen: a models change shown before → after; Enter saves exactly it (Settings → Models' write).
    ConfirmModels(crate::agents::ModelsChange),
    /// The Agents screen: a ready agent's new sign-in, asked first (it replaces the one in use).
    ConfirmSignInAgain {
        agent: String,
        words: String,
    },
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
    /// Searching the focused pane (search.rs): its query and where it is among the matches.
    Search(crate::search::Search),
    Help,
    /// The settings in use and their file (settings.rs): read-only, but `t` changes the theme for the session.
    Settings,
    Quit,
    /// Nothing more can happen here: the words, and the exit code a key ends with.
    Fatal(String, i32),
    /// Typing in the Terminal tab's terminal (T4, take over): every key, paste and mouse event in the pane goes to that
    /// one terminal, Ctrl-C included; only Ctrl-] comes back to the workbench.
    TakeOver,
    /// What taking over this build opens, said before anything starts (TAKE_OVER_SCOPE): t opens it, Esc doesn't.
    ConfirmTakeOver {
        task: String,
        run: i64,
    },
}

/// What opening a take-over means, said before the first one on a build (its number goes after "build #").
pub fn take_over_scope(run: i64) -> String {
    format!("Opens your shell in a separate copy of build #{run}. Your shell's startup files and any project hooks they load (e.g. direnv) will run there.")
}

/// Said when a take-over starts typing (the key bar, or the pane's line, says how to come back).
/// Said when typing starts in an agent's own sign-in or install (the Agents screen).
pub const TYPING_AGENT: &str =
    "Typing in the agent's own sign-in. Ctrl-] comes back; Toolroll never reads what it saves.";
pub const TYPING: &str =
    "Typing in a separate copy of the build. Your shell's own startup files run in it.";
/// Two presses on the divider within this: the list back to its usual width.
pub const DOUBLE_CLICK: std::time::Duration = std::time::Duration::from_millis(400);

/// How long a status said in answer to the person is held against background reads (status_held).
pub const STATUS_HOLD: std::time::Duration = std::time::Duration::from_secs(3);
/// Said when Ctrl-] leaves the terminal.
pub const BACK: &str = "Back to the workbench. The terminal keeps running in Toolroll.";
/// Said when typing stops because the terminal isn't on screen (too small a window, another tab, a dialog).
pub const OFF_SCREEN: &str =
    "The terminal isn't on screen, so typing stopped. Press t to type in it again.";
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
    /// The person's Flexible threads (GET /agents/live/threads).
    FetchThreads,
    /// One window of a thread's live session from `cursor`, with its facts unless they are still `known`; `wait`: held
    /// by the console until the thread changes (no polling while it waits).
    FetchThread {
        thread: String,
        cursor: Option<String>,
        known: Option<String>,
        wait: bool,
    },
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
    /// Open this text (a pane's own, already cleaned) in the person's editor: a private temporary file, the screen
    /// given back to the editor and taken again after (editor.rs, run.rs).
    OpenInEditor {
        name: String,
        text: String,
    },
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
    /// The installation's models (GET /engine/models), for the Agents screen.
    FetchModels,
    /// Look for this computer's agents again (POST /engine/agents/check), then the agents read.
    CheckAgents,
    /// An agent's own sign-in, or its confirmed install (`confirm`: the exact command shown), in a pane: started by
    /// the console from its own command for that agent (POST /term/agent/<kind>), then attached.
    AgentTerm {
        kind: String,
        agent: String,
        confirm: Option<String>,
    },
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
    Threads(Result<LiveThreads, ApiError>),
    Thread(String, Result<LiveSessionWindow, ApiError>),
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
    /// A take-over's terminal: attached (its id, its branch, its socket) or why not.
    TermOpened {
        task: String,
        run: i64,
        result: Result<(String, String, TermLink), ApiError>,
    },
    /// What terminal `id` said.
    Term(String, TermEvent),
    /// The installation's models (the Agents screen).
    Models(Result<toolroll_api::ModelsRead, ApiError>),
}

/// Where things were drawn last frame (for the mouse).
#[derive(Debug, Clone, Default)]
pub struct Areas {
    pub list: Rect,
    /// The list's screen rows and the item each shows (None: a heading).
    pub rows: Vec<(u16, Option<usize>)>,
    pub tabs: Vec<(u16, u16, Tab)>,
    pub right: Rect,
    /// The focused panel's content (under its head): where a search's matches are lit.
    pub content: Rect,
    /// The list and panels together (for the divider's drag, whichever side the list is on).
    pub body: Rect,
    pub split_x: u16,
    /// The links drawn this frame (only ours: link.rs), written clickable after it.
    pub links: Vec<crate::link::LinkArea>,
}

pub struct App {
    pub project_name: String,
    pub needs_count: i64,
    /// The rows the list shows (`all_items` through the filter).
    pub items: Vec<Item>,
    /// Every row Work gave, and the threads.
    pub all_items: Vec<Item>,
    pub filter: Filter,
    /// Today's spend and the plan's use (the header's cost line), when the console gives them.
    pub spend: Option<Spend>,
    /// The panels on screen: one, two or four (panes.rs).
    pub panes: crate::panes::Panes,
    /// The console's origin, for its own task links (link.rs).
    pub origin: Option<String>,
    /// Where the last run left off, until the first work list has been read (state.rs).
    pub restore: Option<crate::state::Resume>,
    restore_scroll: Option<(String, usize)>,
    restore_diff: Option<(String, usize, usize)>,
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
    /// The list: full, a slim rail, or hidden (viewstate.rs), and which side it is on.
    pub list_state: crate::viewstate::ListState,
    pub side: crate::viewstate::Side,
    /// The focused panel alone, everything else set aside (z again comes back).
    pub zoom: bool,
    /// When the divider was last pressed (a second press soon after resets the list's width).
    pub divider_down: Option<std::time::Instant>,
    /// Finished, failed or answered tasks not opened since (shown marked, counted in the top bar).
    pub unread: std::collections::BTreeSet<String>,
    /// Where a needs-you jump left from (jump-back returns there).
    pub jump_from: Option<String>,
    /// The search last made in this pane (its query stays lit after Enter until Esc).
    pub search: Option<crate::search::Search>,
    /// The dialog drawn in the last frame, as `dialog_key` names it (view.rs sets it each frame; None when no dialog
    /// was drawn, the window too small among the reasons). A dialog's keys act only when it is exactly this one.
    pub drawn_dialog: Option<String>,
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
    /// The person's Flexible threads and the one watched (thread.rs).
    pub threads: crate::thread::Threads,
    /// A thread's question and the answer picked were drawn to their end (thread.rs): Enter may send it.
    pub thread_shown: bool,
    /// How far the thread's answer dialog is read on (j/k).
    pub thread_scroll: usize,
    /// The title of the task New task is filing (kept for Build's "plan it first").
    pub filing: String,
    pub fetching_live: bool,
    pub fetching_work: bool,
    /// The agents on this computer (the first run's lines, shown while there are no tasks); None until read.
    pub agents: Option<AgentsRead>,
    pub fetching_agents: bool,
    /// The Agents screen, while it is open (agents.rs).
    pub agents_screen: Option<crate::agents::Screen>,
    /// This computer's offset from UTC, in seconds (read at start; 0 in tests): times are shown on its clock.
    pub utc_offset_secs: i64,
    /// When the status line was last said, and whether a key came since (status_held).
    pub said_at: Option<std::time::Instant>,
    pub key_since_said: bool,
    /// The Settings screen's chosen row (settings.rs Choice::ALL).
    pub settings_row: usize,
    /// Build's Usual row shown whole (f), else its summary line only.
    pub build_unfold: bool,
    pub work_again: bool,
    pub areas: Areas,
    /// The Live tab's lines for (transcript version, width): rebuilt only when either moves.
    pub line_cache: Option<LineCache>,
    /// Seconds since the epoch, for elapsed times (the loop sets it; tests fix it).
    pub now: i64,
    /// The Terminal tab's terminal (T4): the selected task's take-over, when one is open.
    pub term: Option<Pane>,
    /// The builds (task, build) whose take-over the person said yes to here (ConfirmTakeOver), each asked once.
    pub confirmed: HashSet<(String, i64)>,
    /// `t` was pressed on this task before its steps were read: the take-over goes on (its confirm first, as ever) once
    /// they are, while the person is still on that task's Terminal tab with nothing else open.
    take_over_wanted: Option<String>,
    ticks: u64,
    counter: u64,
}

impl App {
    pub fn new(owned: bool, project: Option<String>) -> App {
        App {
            project_name: String::new(),
            needs_count: 0,
            items: Vec::new(),
            all_items: Vec::new(),
            filter: Filter::All,
            spend: None,
            panes: crate::panes::Panes::default(),
            origin: None,
            restore: None,
            restore_scroll: None,
            restore_diff: None,
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
            split: 46,
            dragging: false,
            list_state: crate::viewstate::ListState::Full,
            side: crate::viewstate::Side::Left,
            zoom: false,
            divider_down: None,
            unread: std::collections::BTreeSet::new(),
            jump_from: None,
            search: None,
            drawn_dialog: None,
            owned,
            project,
            prefs: crate::settings::Prefs::default(),
            notifier: crate::notify::Notifier::default(),
            facts: crate::settings::RowFacts::default(),
            filing: String::new(),
            answer_shown: false,
            threads: crate::thread::Threads::default(),
            thread_shown: false,
            thread_scroll: 0,
            fetching_live: false,
            fetching_work: false,
            agents: None,
            fetching_agents: false,
            agents_screen: None,
            utc_offset_secs: 0,
            said_at: None,
            key_since_said: true,
            settings_row: 0,
            build_unfold: false,
            work_again: false,
            areas: Areas::default(),
            line_cache: None,
            now: 0,
            term: None,
            confirmed: HashSet::new(),
            take_over_wanted: None,
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

    /// The steps read, when it is the selected task's.
    pub fn steps_here(&self) -> Option<&StepCards> {
        let task = self
            .selected_item()
            .filter(|i| i.is_task)
            .map(|i| i.id.as_str())?;
        self.steps
            .as_ref()
            .filter(|s| s.task.id == task || s.task.root == task)
    }

    /// The selected task is queued with nothing building: waiting for a builder, or to try again.
    pub fn queued_here(&self) -> bool {
        self.steps_here()
            .is_some_and(|s| s.task.state == "queued" && s.live_run.is_none())
    }

    /// What Cancel shows and pins for the selected task: its id, title, state and latest build (any step's newest run).
    pub fn cancel_pins(&self) -> Option<(String, String, String, Option<i64>)> {
        let item = self.selected_item().filter(|i| i.is_task && !i.thread)?;
        let steps = self.steps_here()?;
        if !matches!(steps.task.state.as_str(), "queued" | "running" | "failed") {
            return None;
        }
        let run = steps
            .cards
            .iter()
            .flatten()
            .flat_map(|c| c.runs.iter().copied())
            .max()
            .or(steps.live_run);
        Some((
            item.id.clone(),
            item.title.clone(),
            steps.task.state.clone(),
            run,
        ))
    }

    /// A result waits for this person's Accept or Send back on the selected task.
    pub fn review_waiting(&self) -> bool {
        self.steps_here().is_some_and(|s| s.review.is_some())
    }

    /// What Retry would post for the selected task (a failed task whose approval stands as it is).
    pub fn retry_pins(&self) -> Option<(String, toolroll_api::RetryPins)> {
        let task = self.selected_item().filter(|i| i.is_task)?.id.clone();
        let pins = self.steps_here()?.retry.clone()?;
        Some((task, pins))
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

    pub(crate) fn say(&mut self, tone: Tone, words: impl Into<String>) {
        self.status = Some((tone, clean(&words.into())));
        self.said_at = Some(std::time::Instant::now());
        self.key_since_said = false;
    }

    /// What was just said in answer to the person ("Back to the workbench") is held: until their next key, and for at
    /// least STATUS_HOLD, a background read's trouble doesn't replace it.
    pub fn status_held(&self) -> bool {
        self.status.is_some()
            && !self.key_since_said
            && self.said_at.is_some_and(|t| t.elapsed() < STATUS_HOLD)
    }

    /// A background read failed: an ended session or another contract still ends the screen; anything else is said
    /// unless what is on the status line was just said to the person (status_held). The next poll reads again.
    fn read_failed(&mut self, e: ApiError) -> Vec<Effect> {
        if fatal(&e) || !self.status_held() {
            return self.failed(e);
        }
        vec![]
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
                    Ok(read) => {
                        self.agents = Some(read);
                        crate::agents::on_agents(self);
                    }
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
                // A watched panel's task (panes.rs), besides or instead of the selected one.
                let mut watched = self.watch_steps(&task, &steps);
                if !watched.is_empty() || self.panes.watches().any(|w| w.task == task) {
                    self.facts.learn(&steps);
                    watched.push(Effect::Watch(self.rooms()));
                }
                if self.selected_id().as_deref() != Some(task.as_str()) {
                    return watched;
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
                    fx.push(self.ask_diff(task.clone()));
                }
                fx.push(Effect::Watch(self.rooms()));
                fx.extend(
                    watched
                        .into_iter()
                        .filter(|e| !matches!(e, Effect::Watch(_))),
                );
                // A `t` pressed before these steps were read: the same take-over now (its confirm first), only while
                // the person is still on this task's Terminal tab with no dialog open.
                if self.take_over_wanted.take().as_deref() == Some(task.as_str())
                    && self.tab == Tab::Terminal
                    && self.mode == Mode::Normal
                {
                    fx.extend(self.take_over());
                }
                fx
            }
            Msg::Steps(_, Err(e)) => self.read_failed(e),
            Msg::Live(run, file, result) => {
                let mut fx = match (&result, file) {
                    (Ok(window), "main") => self.watch_live(run, window),
                    (Err(_), "main") => {
                        // A watched panel's read that failed is read again at the next poll.
                        for w in self.panes.slots.iter_mut().flatten() {
                            if w.transcript.run == Some(run) {
                                w.fetching = false;
                            }
                        }
                        vec![]
                    }
                    _ => vec![],
                };
                fx.extend(self.got_live(run, file, result));
                fx
            }
            Msg::Diff(ask, Ok(diff)) => self.got_diff(ask, diff),
            Msg::Diff(ask, Err(e)) => {
                if self.diff_wanted.as_ref() != Some(&ask) && !fatal(&e) {
                    return vec![];
                }
                self.diff_wanted = None;
                self.read_failed(e)
            }
            Msg::DiffFile(ask, Err(e)) => {
                if self.file_wanted.as_ref() != Some(&ask) && !fatal(&e) {
                    return vec![];
                }
                self.file_wanted = None;
                self.read_failed(e)
            }
            Msg::DiffFile(ask, Ok(file)) => self.got_diff_file(ask, file),
            Msg::Threads(read) => self.got_threads(read),
            Msg::Thread(id, read) => self.got_thread(id, read),
            Msg::Context(ask, Ok(ctx)) => self.got_context(ask, ctx),
            Msg::Context(ask, Err(e)) => {
                if self.context_wanted.as_ref() != Some(&ask) && !fatal(&e) {
                    return vec![];
                }
                self.context_wanted = None;
                self.read_failed(e)
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
                self.sent_thread();
                self.refresh()
            }
            Msg::Acted(Ok(ActOutcome::Refused(words))) => {
                self.say(Tone::Refused, words);
                self.sent_thread();
                self.refresh()
            }
            Msg::Acted(Ok(ActOutcome::ThreadTerms { key, lines })) => {
                self.status = None;
                self.mode = Mode::StartThread(crate::thread::StartTerms::new(
                    self.filing.clone(),
                    self.project.clone(),
                    key,
                    lines,
                ));
                vec![]
            }
            Msg::Acted(Ok(ActOutcome::Terms {
                preview,
                digest,
                terms,
            })) => {
                let title = self.filing.clone();
                self.status = None;
                self.build_unfold = false;
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
            Msg::Acted(Err(e)) => {
                self.sent_thread();
                self.failed(e)
            }
            Msg::Signal(signal) => self.signal(signal),
            Msg::Said(words) => {
                self.say(Tone::Said, words);
                vec![]
            }
            Msg::Tick => self.tick(),
            Msg::TermOpened { task, run, result } => self.term_opened(task, run, result),
            Msg::Term(id, event) => self.term_event(id, event),
            Msg::Models(read) => crate::agents::on_models(self, read),
        }
    }

    /// `failed`, for the Agents screen (agents.rs).
    pub(crate) fn failed_pub(&mut self, e: ApiError) -> Vec<Effect> {
        self.failed(e)
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
        if self.agents_screen.is_some() {
            fx.push(Effect::FetchModels);
        }
        fx.extend(self.poll_thread());
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
        // The first-run steps the welcome offers aren't counted as needing you (covered_by_welcome).
        let covered = rows
            .needs
            .iter()
            .flat_map(|g| g.rows.iter())
            .filter(|n| covered_by_welcome(n))
            .count() as i64;
        self.needs_count = (rows.needs_count - covered).max(0);
        self.spend = rows.spend.clone();
        let was: std::collections::HashMap<String, (Section, String, bool)> = self
            .all_items
            .iter()
            .map(|i| {
                (
                    i.id.clone(),
                    (i.section, i.word.clone(), i.question().is_some()),
                )
            })
            .collect();
        self.all_items = items_of(&rows);
        self.all_items.extend(self.threads.items());
        sort_sections(&mut self.all_items);
        // Unread: a task that finished, failed, or had its question answered since the last read, unless it is the one
        // open now. It stays marked until it is opened (viewstate.rs keeps it).
        if self.loaded {
            for i in self.all_items.iter().filter(|i| i.is_task && !i.thread) {
                let Some((section, word, asked)) = was.get(&i.id) else {
                    continue;
                };
                let finished = *section != Section::Recent && i.section == Section::Recent;
                let failed = i.word == "Failed" && word != "Failed";
                let answered = *asked && i.question().is_none() && i.section != Section::NeedsYou;
                if (finished || failed || answered) && before.as_deref() != Some(i.id.as_str()) {
                    self.unread.insert(i.id.clone());
                }
            }
        }
        let first = !self.loaded;
        // Where the last run left off: its filter and layout, then its task (state.rs).
        let restore = if first { self.restore.take() } else { None };
        if let Some(r) = &restore {
            self.filter = r.filter.clone();
        }
        self.items = self.filtered();
        self.check_pins();
        let mut fx = vec![];
        // Each change once (a task starts waiting on you, finishes or fails), in our own words (notify.rs).
        let notify = self.prefs.settings.notify;
        fx.extend(
            self.notifier
                .observe(&self.all_items, notify, self.now)
                .map(Effect::Notify),
        );
        self.loaded = true;
        let before = match restore.as_ref().and_then(|r| r.task.clone()) {
            Some(task) if self.items.iter().any(|i| i.id == task) => Some(task),
            _ => before,
        };
        // Keep the same task selected when it is still listed.
        self.selected = before
            .as_ref()
            .and_then(|id| self.items.iter().position(|i| &i.id == id))
            .unwrap_or(0)
            .min(self.items.len().saturating_sub(1));
        if let Some(r) = restore {
            fx.extend(self.resume(r));
        }
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
        // The person's Flexible threads, read with the work (never again once the console said they aren't available).
        if !self.threads.off && !self.threads.fetching {
            self.threads.fetching = true;
            fx.push(Effect::FetchThreads);
        }
        fx
    }

    /// The threads list: merged into the left column (the selection kept); a refusal means Flexible is off here, said
    /// by nothing (threads are simply not listed) and never asked again.
    fn got_threads(&mut self, read: Result<LiveThreads, ApiError>) -> Vec<Effect> {
        self.threads.fetching = false;
        match read {
            Ok(list) => self.threads.listed(list),
            Err(e) if fatal(&e) => return self.failed(e),
            Err(_) => {
                self.threads.off = true;
                self.threads.rows.clear();
            }
        }
        let before = self.selected_id();
        self.all_items.retain(|i| !i.thread);
        self.all_items.extend(self.threads.items());
        sort_sections(&mut self.all_items);
        self.items = self.filtered();
        self.selected = before
            .as_ref()
            .and_then(|id| self.items.iter().position(|i| &i.id == id))
            .unwrap_or(self.selected)
            .min(self.items.len().saturating_sub(1));
        if self.selected_id() != before {
            return self.selection_changed();
        }
        self.poll_thread()
    }

    /// The selected thread being watched, if it is one.
    pub fn thread_selected(&self) -> Option<String> {
        self.selected_item()
            .filter(|i| i.thread)
            .map(|i| i.id.clone())
    }

    /// Read on in the watched thread (one read at a time), now: a selection, a refresh, an act's answer.
    fn poll_thread(&mut self) -> Vec<Effect> {
        let Some(id) = self.thread_selected() else {
            return vec![];
        };
        let view = self
            .threads
            .view
            .get_or_insert_with(|| crate::thread::ThreadView {
                id: id.clone(),
                ..Default::default()
            });
        if view.id != id || view.fetching {
            return vec![];
        }
        view.fetching = true;
        view.due = 0;
        vec![Effect::FetchThread {
            thread: id,
            cursor: view.transcript.cursor_main.clone(),
            known: view.facts.as_ref().map(|f| f.version.clone()),
            wait: view.transcript.cursor_main.is_some() && view.facts.is_some(),
        }]
    }

    /// The tick's read of the watched thread, when none is held: a held read (wait) answers the moment the thread
    /// changes, so nothing polls while it waits; after one that came back unchanged the next waits a tick longer each
    /// time, up to every eighth (2 s).
    fn tick_thread(&mut self) -> Vec<Effect> {
        let Some(view) = self.threads.view.as_mut() else {
            return self.poll_thread();
        };
        if view.due > 0 {
            view.due -= 1;
            return vec![];
        }
        self.poll_thread()
    }

    /// A thread's window: its records appended (a restart clears them first), its facts replaced when they changed (a
    /// window without them says they didn't); a dialog whose question no longer stands closes. After a change the next
    /// read is a held one at once (it answers at the thread's next change); after an unchanged one, a later tick's.
    fn got_thread(&mut self, id: String, read: Result<LiveSessionWindow, ApiError>) -> Vec<Effect> {
        let Some(view) = self.threads.view.as_mut().filter(|v| v.id == id) else {
            return vec![];
        };
        view.fetching = false;
        let window = match read {
            Ok(w) => w,
            Err(e) => return self.read_failed(e),
        };
        let mut changed = view.transcript.live != window.live;
        view.transcript.live = window.live;
        if let Some(facts) = window.thread {
            if view.facts.as_ref().map(|f| &f.version) != Some(&facts.version) {
                view.facts = Some(facts);
                changed = true;
            }
        }
        let mut more = None;
        if let Window::Read(read) = window.window {
            if read.restarted {
                view.transcript.main.clear();
            }
            if read.restarted || !read.records.is_empty() {
                view.transcript.main.extend(read.records);
                if view.transcript.main.len() > RECORDS_KEPT {
                    let drop = view.transcript.main.len() - RECORDS_KEPT;
                    view.transcript.main.drain(..drop);
                }
                view.transcript.version += 1;
                changed = true;
            }
            view.transcript.cursor_main = Some(read.cursor.clone());
            if read.more {
                more = Some(read.cursor);
            }
        }
        view.quiet = if changed { 0 } else { (view.quiet + 1).min(3) };
        view.due = (1u32 << view.quiet) - 1;
        crate::thread::check_pin(self);
        match more {
            Some(cursor) => {
                let view = self.threads.view.as_mut().unwrap();
                view.fetching = true;
                vec![Effect::FetchThread {
                    thread: id,
                    cursor: Some(cursor),
                    known: view.facts.as_ref().map(|f| f.version.clone()),
                    wait: false,
                }]
            }
            // Something changed: wait for the next change at once (a held read), never on the tick.
            None if changed => self.poll_thread(),
            None => vec![],
        }
    }

    /// An act came back: the answer it carried (if any) is no longer on its way here; the read says where it stands.
    fn sent_thread(&mut self) {
        if let Some(view) = self.threads.view.as_mut() {
            view.sending = None;
        }
    }

    /// Enter on a thread's answer dialog: posted only while the pinned question still stands and was drawn whole.
    fn answer_thread(&mut self, pin: crate::thread::ThreadPin) -> Vec<Effect> {
        if !crate::thread::stands(self.threads.view.as_ref(), &pin) {
            self.say(Tone::Refused, crate::thread::THREAD_QUESTION_CHANGED);
            return vec![];
        }
        if !self.thread_shown {
            self.say(Tone::Refused, crate::thread::READ_TO_THE_END);
            return vec![];
        }
        if let Some(view) = self.threads.view.as_mut() {
            view.sending = Some(pin.request.clone());
        }
        let fields = crate::thread::answer_fields(&pin);
        self.act(
            format!(
                "/agents/live/thread/{}/answer",
                toolroll_api::client::encode(&pin.thread)
            ),
            fields,
            format!("Sent: {}.", clean(&pin.label)),
        )
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
            Err(e) => return self.read_failed(e),
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
                // Where the last run left off in this output (state.rs), once it has been read.
                if file == "main" && !read.more {
                    if let Some((task, lines)) = self.restore_scroll.take() {
                        if self.selected_id().as_deref() == Some(task.as_str()) {
                            self.scroll = lines;
                            self.follow = false;
                        }
                    }
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
            LiveSignal::Change(room) if room.starts_with("task:") => {
                let mut fx = self.watch_changed(&room);
                let mine = self.steps.as_ref().is_none_or(|s| s.room == room) || fx.is_empty();
                if mine {
                    fx.extend(self.selected_id().map(Effect::FetchSteps));
                }
                fx
            }
            LiveSignal::Change(room) if room.starts_with("agent:") => {
                let mut fx = self.poll_live(true);
                fx.extend(self.poll_watches());
                fx
            }
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
            .tick(&self.all_items, self.now)
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
        if self.thread_selected().is_some() {
            fx = self.tick_thread();
        } else if self.tab == Tab::Live || self.ticks.is_multiple_of(4) {
            fx = self.poll_live(self.ticks.is_multiple_of(8));
        }
        // The watched panels read on every other tick (half a second: inside the one-second bar).
        if self.ticks.is_multiple_of(2) {
            fx.extend(self.poll_watches());
        }
        fx.extend(gathered);
        fx
    }

    /// The rooms that say when what's on screen changed (the watched panels' too).
    pub(crate) fn rooms(&self) -> Vec<String> {
        let mut rooms = self.watch_rooms();
        if let Some(steps) = &self.steps {
            rooms.push(steps.room.clone());
        }
        if let Some(run) = self.transcript.run {
            rooms.push(format!("agent:{run}"));
        }
        rooms
    }

    pub(crate) fn selection_changed(&mut self) -> Vec<Effect> {
        // Opened: no longer unread.
        if let Some(id) = self.selected_id() {
            self.unread.remove(&id);
        }
        self.search = None;
        // Another task: let go of this one's terminal (it keeps running in the console; t on it again reattaches).
        let detached = self.drop_term();
        self.take_over_wanted = None;
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
        if matches!(self.mode, Mode::ConfirmThread(_)) {
            self.say(Tone::Refused, crate::thread::THREAD_QUESTION_CHANGED);
        }
        if matches!(
            self.mode,
            Mode::ConfirmAnswer(_)
                | Mode::ConfirmThread(_)
                | Mode::ConfirmAccept(_)
                | Mode::ConfirmTakeOver { .. }
                | Mode::ConfirmStop(_)
                | Mode::Note(..)
                | Mode::SendBack(..)
                | Mode::SendReview { .. }
                | Mode::Steer(_)
        ) {
            self.mode = Mode::Normal;
        }
        self.threads.view = None;
        if self.thread_selected().is_some() {
            let mut fx = self.poll_thread();
            fx.push(Effect::Watch(vec![]));
            return fx;
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
        if self.tab != tab {
            // What was said belonged to the tab left.
            self.status = None;
        }
        self.tab = tab;
        match (tab, self.selected_id()) {
            (Tab::Diff, Some(id)) if self.diff.is_none() => vec![self.ask_diff(id)],
            _ => vec![],
        }
    }

    // ---- keys ---------------------------------------------------------------------------------------------------

    pub fn key(&mut self, key: KeyEvent) -> Vec<Effect> {
        // A key: what was said before it may give way now.
        self.key_since_said = true;
        // Typing in the terminal: every key is the terminal's (Ctrl-C too), but Ctrl-].
        if self.mode == Mode::TakeOver {
            return self.take_over_key(key);
        }
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            return self.quit();
        }
        // A dialog acts only once it was on screen, exactly as it is now, in the last frame (a window too small draws
        // none, and two keys in one read meet a dialog never drawn). Esc still closes it.
        if let Some(k) = self.dialog_key() {
            if self.drawn_dialog.as_ref() != Some(&k) && key.code != KeyCode::Esc {
                self.say(Tone::Refused, UNDRAWN);
                return vec![];
            }
        }
        match self.mode.clone() {
            Mode::Fatal(_, code) => vec![Effect::Exit(code)],
            Mode::Copied => {
                self.mode = Mode::Normal;
                self.say(
                    Tone::Said,
                    if self.agents_screen.is_some() {
                        "The commands stay in your terminal's scrollback."
                    } else {
                        "The hunk stays in your terminal's scrollback."
                    },
                );
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
                let rows = crate::settings::Choice::ALL.len();
                match key.code {
                    KeyCode::Char('t') => {
                        self.prefs.cycle_theme();
                        self.line_cache = None;
                    }
                    KeyCode::Char('j') | KeyCode::Down => {
                        self.settings_row = (self.settings_row + 1).min(rows - 1);
                    }
                    KeyCode::Char('k') | KeyCode::Up => {
                        self.settings_row = self.settings_row.saturating_sub(1);
                    }
                    KeyCode::Enter | KeyCode::Char(' ') => {
                        let choice = crate::settings::Choice::ALL[self.settings_row.min(rows - 1)];
                        let said = self.prefs.change(choice);
                        if choice == crate::settings::Choice::ListSide {
                            self.side = self.prefs.settings.list_side;
                        }
                        match said {
                            Ok(words) => self.say(Tone::Said, words),
                            Err(words) => self.say(Tone::Refused, words),
                        }
                        self.line_cache = None;
                    }
                    _ => {
                        self.mode = Mode::Normal;
                        self.status = None;
                    }
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
            Mode::ConfirmHold { task } => {
                self.mode = Mode::Normal;
                match key.code {
                    KeyCode::Enter => self.hold(task),
                    _ => {
                        self.say(Tone::Said, "It keeps retrying.");
                        vec![]
                    }
                }
            }
            Mode::ConfirmCancel {
                task, state, run, ..
            } => {
                self.mode = Mode::Normal;
                match key.code {
                    KeyCode::Enter => self.cancel(task, state, run),
                    _ => {
                        self.say(Tone::Said, "Not cancelled.");
                        vec![]
                    }
                }
            }
            Mode::ConfirmRetry { task, run, digest } => {
                self.mode = Mode::Normal;
                match key.code {
                    KeyCode::Enter => self.retry(task, run, digest),
                    _ => {
                        self.say(Tone::Said, "Not retried.");
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
                KeyCode::Char('f') => {
                    // The Usual row: its summary, or every setting in it.
                    self.build_unfold = !self.build_unfold;
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
            Mode::ConfirmThread(pin) => {
                // Reading on through what would be allowed: the view says when its end has been drawn.
                let by: i64 = match key.code {
                    KeyCode::Char('j') | KeyCode::Down => 1,
                    KeyCode::Char(' ') | KeyCode::PageDown => 10,
                    KeyCode::Char('k') | KeyCode::Up => -1,
                    KeyCode::PageUp => -10,
                    _ => 0,
                };
                if by != 0 {
                    self.thread_scroll = (self.thread_scroll as i64 + by).max(0) as usize;
                    return vec![];
                }
                self.mode = Mode::Normal;
                match key.code {
                    KeyCode::Enter => self.answer_thread(pin),
                    _ => {
                        self.say(Tone::Said, "Not answered.");
                        vec![]
                    }
                }
            }
            Mode::StartThread(terms) => crate::thread::start_key(self, terms, key),
            Mode::NewThread(text) => self.typing(
                key,
                text,
                |app, text| app.mode = Mode::NewThread(text),
                |app, text| app.new_thread(text),
            ),
            Mode::Steer(text) => self.typing(
                key,
                text,
                |app, text| app.mode = Mode::Steer(text),
                |app, text| app.steer(text),
            ),
            Mode::NewTask(text, plan) => match key.code {
                // Tab: Just code or plan first, said on the line; Shift-Enter files it to plan first at once.
                KeyCode::Tab | KeyCode::BackTab => {
                    self.mode = Mode::NewTask(text, !plan);
                    vec![]
                }
                KeyCode::Enter => {
                    self.mode = Mode::Normal;
                    let plan = plan || key.modifiers.contains(KeyModifiers::SHIFT);
                    self.new_task(text, plan)
                }
                _ => self.typing(
                    key,
                    text,
                    move |app, text| app.mode = Mode::NewTask(text, plan),
                    move |app, text| app.new_task(text, plan),
                ),
            },
            Mode::Palette(palette) => self.palette_key(key, palette),
            Mode::Note(kind, text) => {
                let k2 = kind.clone();
                self.typing(
                    key,
                    text,
                    move |app, text| app.mode = Mode::Note(k2.clone(), text),
                    move |app, text| app.note(kind.clone(), text),
                )
            }
            Mode::Normal if self.agents_screen.is_some() => crate::agents::key(self, key),
            Mode::Normal => self.normal_key(key),
            Mode::Search(s) => self.search_key(key, s),
            Mode::TakeOver => vec![],
            Mode::ConfirmInstall { .. }
            | Mode::PickModel(_)
            | Mode::ConfirmModels(_)
            | Mode::ConfirmSignInAgain { .. } => crate::agents::mode_key(self, key),
            Mode::ConfirmTakeOver { task, run } => match key.code {
                KeyCode::Char('t') => {
                    self.mode = Mode::Normal;
                    // Still the task on screen, and still its build to take over: else nothing opens.
                    let still = self.selected_item().is_some_and(|i| i.id == task)
                        && self.steps.as_ref().is_some_and(|s| s.live_run != Some(run));
                    if !still {
                        self.say(Tone::Refused, RESULT_CHANGED);
                        return vec![];
                    }
                    self.confirmed.insert((task.clone(), run));
                    self.open_take_over(task, run)
                }
                KeyCode::Esc => {
                    self.mode = Mode::Normal;
                    self.say(Tone::Said, "Nothing opened.");
                    vec![]
                }
                _ => vec![],
            },
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
        self.key_since_said = true;
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
            Mode::Palette(p) => {
                grow(&mut p.query);
                p.selected = 0;
            }
            Mode::Steer(t)
            | Mode::NewTask(t, _)
            | Mode::NewThread(t)
            | Mode::Note(_, t)
            | Mode::SendBack(_, t) => grow(t),
            _ => {}
        }
        vec![]
    }

    /// A key with no dialog open: the keymap's action (the Diff tab's own keys first there), else a number answering
    /// the question on screen, else Esc clearing the last message. Every action runs through `run_action`, which the
    /// command palette runs too.
    fn normal_key(&mut self, key: KeyEvent) -> Vec<Effect> {
        // The Diff tab's keys are a task result's; a thread's panel has no Diff (its own keys come below).
        if self.tab == Tab::Diff && self.thread_selected().is_none() {
            if let Some(action) = self.prefs.settings.keymap.lookup(Scope::Diff, &key) {
                return self.run_action(action);
            }
        }
        if let Some(action) = self.prefs.settings.keymap.lookup(Scope::Global, &key) {
            return self.run_action(action);
        }
        match key.code {
            KeyCode::Char(c @ '1'..='9') => self.answer_key((c as u8 - b'1') as usize),
            KeyCode::Esc => {
                self.status = None;
                vec![]
            }
            // A key that means nothing here says so, never nothing at all.
            KeyCode::Char(c)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                    && !c.is_control() =>
            {
                let palette = self.prefs.settings.keymap.key_words(Action::Palette);
                let words = if palette.is_empty() {
                    format!("{c} does nothing here.")
                } else {
                    format!("{c} does nothing here · {palette} shows every action")
                };
                self.say(Tone::Said, words);
                vec![]
            }
            _ => vec![],
        }
    }

    /// What a palette line does: an action as its key does it, an answer as its number does, a task shown, a project's
    /// tasks listed.
    pub fn run_pick(&mut self, pick: Pick) -> Vec<Effect> {
        match pick {
            Pick::Action(action) => self.run_action(action),
            Pick::Answer(n) => self.answer_key(n),
            Pick::Task(id) => self.show_task(&id),
            Pick::Project(name) => self.set_filter(Filter::Project(name)),
        }
    }

    /// The palette's keys: typing narrows it, Up and Down (or Ctrl-P / Ctrl-N) move, Enter runs, Esc closes.
    fn palette_key(&mut self, key: KeyEvent, mut p: crate::palette::Palette) -> Vec<Effect> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let count = crate::palette::matches(self, &p.query).len();
        match key.code {
            KeyCode::Esc => {
                self.mode = Mode::Normal;
                return vec![];
            }
            KeyCode::Enter => {
                let picked = crate::palette::matches(self, &p.query)
                    .get(p.selected)
                    .map(|e| e.pick.clone());
                self.mode = Mode::Normal;
                return match picked {
                    Some(pick) => self.run_pick(pick),
                    None => vec![],
                };
            }
            KeyCode::Up | KeyCode::BackTab => p.selected = p.selected.saturating_sub(1),
            KeyCode::Char('p') if ctrl => p.selected = p.selected.saturating_sub(1),
            KeyCode::Down | KeyCode::Tab => {
                p.selected = (p.selected + 1).min(count.saturating_sub(1))
            }
            KeyCode::Char('n') if ctrl => {
                p.selected = (p.selected + 1).min(count.saturating_sub(1))
            }
            KeyCode::PageUp => p.selected = p.selected.saturating_sub(10),
            KeyCode::PageDown => p.selected = (p.selected + 10).min(count.saturating_sub(1)),
            KeyCode::Backspace => {
                p.query.pop();
                p.selected = 0;
            }
            KeyCode::Char(c) if !ctrl => {
                if p.query.chars().count() < 200 {
                    p.query.push(c);
                }
                p.selected = 0;
            }
            _ => {}
        }
        self.mode = Mode::Palette(p);
        vec![]
    }

    /// One action, whichever way it was asked for (its key, or the palette): the only place each act starts, so both
    /// ways keep the same pins and confirms.
    pub fn run_action(&mut self, action: Action) -> Vec<Effect> {
        let item = self.selected_item().cloned();
        let diff_here = self.tab == Tab::Diff && self.thread_selected().is_none();
        // (An agent's sign-in pane is never the Terminal tab's, and never copied.)
        let terminal_here =
            self.tab == Tab::Terminal && self.term.as_ref().is_some_and(|p| !p.sensitive);
        match action {
            Action::MoveDown => self.select(self.selected + 1),
            Action::MoveUp => self.select(self.selected.saturating_sub(1)),
            Action::Open => {
                // On a hidden-lines marker in Diff: show them.
                if diff_here && matches!(self.rows.get(self.diff_cursor), Some(Row::Gap { .. })) {
                    return self.expand(true);
                }
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
            Action::NextTab => self
                .set_tab(Tab::ALL[(Tab::ALL.iter().position(|t| *t == self.tab).unwrap() + 1) % 4]),
            Action::PreviousTab => self
                .set_tab(Tab::ALL[(Tab::ALL.iter().position(|t| *t == self.tab).unwrap() + 3) % 4]),
            Action::Steer => match self.live_run() {
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
            Action::Pause => self.pause(item.as_ref()),
            Action::Stop => match self.live_run() {
                Some(run) => {
                    self.mode = Mode::ConfirmStop(run);
                    vec![]
                }
                // Waiting to try again, or queued: stop retrying (it stays; nothing more runs).
                None if self.queued_here() => {
                    let task = item.as_ref().map(|i| i.id.clone()).unwrap_or_default();
                    self.status = None;
                    self.mode = Mode::ConfirmHold { task };
                    vec![]
                }
                None => {
                    self.say(
                        Tone::Refused,
                        "Nothing is building or waiting on this task to stop.",
                    );
                    vec![]
                }
            },
            Action::CancelTask => match self.cancel_pins() {
                Some((task, title, state, run)) => {
                    self.status = None;
                    self.mode = Mode::ConfirmCancel {
                        task,
                        title,
                        state,
                        run,
                    };
                    vec![]
                }
                None => {
                    self.say(
                        Tone::Refused,
                        "Only a queued, running or failed task can be cancelled (open its steps first).",
                    );
                    vec![]
                }
            },
            Action::NewThread => {
                self.mode = Mode::NewThread(String::new());
                // Its agent is said on the line above: read it when it isn't known yet.
                if self.agents.is_none() && !self.fetching_agents {
                    self.fetching_agents = true;
                    return vec![Effect::FetchAgents];
                }
                vec![]
            }
            Action::Accept => {
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
            Action::SendBack if !self.review_waiting() && self.retry_pins().is_some() => {
                self.run_action(Action::Retry)
            }
            Action::Retry => match self.retry_pins() {
                Some((task, pins)) => {
                    self.status = None;
                    self.mode = Mode::ConfirmRetry {
                        task,
                        run: pins.run,
                        digest: pins.digest,
                    };
                    vec![]
                }
                None => {
                    self.say(Tone::Refused, "Only a failed task can be retried here.");
                    vec![]
                }
            },
            Action::SendBack => {
                if let Some(pin) = self.pin_review() {
                    // The notes kept for this result (if any) and words for the whole change, then the whole text to
                    // read to its end before anything is sent.
                    self.mode = Mode::SendBack(pin, String::new());
                }
                vec![]
            }
            Action::NewTask => self.open_new_task(),
            Action::TakeOver => self.take_over(),
            Action::Browser => {
                self.say(Tone::Said, "Opening Toolroll in your browser…");
                vec![Effect::OpenBrowser]
            }
            Action::Help => {
                self.mode = Mode::Help;
                vec![]
            }
            Action::Quit => self.quit(),
            Action::Palette => {
                self.mode = Mode::Palette(crate::palette::Palette::default());
                vec![]
            }
            Action::NextNeedsYou => self.next_needs_you(true),
            Action::PreviousNeedsYou => self.next_needs_you(false),
            Action::JumpBack => match self.jump_from.take() {
                Some(id) if self.all_items.iter().any(|i| i.id == id) => {
                    self.jump_from = self.selected_id();
                    self.say(Tone::Said, "Back where you were.");
                    self.show_task(&id)
                }
                _ => {
                    self.say(Tone::Said, "Nowhere to go back to: jump with ! first.");
                    vec![]
                }
            },
            Action::Search => match crate::search::pane_text(self) {
                Some(_) => {
                    self.mode = Mode::Search(crate::search::Search {
                        query: String::new(),
                        typing: true,
                        at: 0,
                        count: 0,
                    });
                    vec![]
                }
                None => {
                    self.say(Tone::Said, "Nothing to search here.");
                    vec![]
                }
            },
            Action::OpenInEditor => match crate::search::pane_text(self) {
                Some((name, lines)) if !lines.is_empty() => {
                    let mut text = lines.join("\n");
                    text.push('\n');
                    self.say(Tone::Said, "Opening it in your editor…");
                    vec![Effect::OpenInEditor {
                        name: name.to_string(),
                        text,
                    }]
                }
                _ => {
                    self.say(Tone::Said, "Nothing here to open in an editor.");
                    vec![]
                }
            },
            Action::ListNarrower | Action::ListWider => {
                self.resize(if action == Action::ListWider { 1 } else { -1 });
                vec![]
            }
            Action::Equalize => {
                self.panes.ratio_x = 50;
                self.panes.ratio_y = 50;
                self.split = self.prefs.settings.list_width();
                self.say(Tone::Said, "Even splits, and the list at its usual width.");
                vec![]
            }
            Action::ListCycle => {
                self.list_state = self.list_state.next();
                let words = match self.list_state {
                    crate::viewstate::ListState::Full => "The list, in full.",
                    crate::viewstate::ListState::Rail => {
                        "The list as a slim rail: b again hides it."
                    }
                    crate::viewstate::ListState::Hidden => "The list is hidden: b shows it again.",
                };
                self.say(Tone::Said, words);
                vec![]
            }
            Action::Zoom => {
                self.zoom = !self.zoom;
                self.say(
                    Tone::Said,
                    if self.zoom {
                        "Zoomed: this panel alone. z comes back."
                    } else {
                        "Back from zoom."
                    },
                );
                vec![]
            }
            Action::ListSide => {
                self.side = self.side.other();
                self.say(
                    Tone::Said,
                    format!("The list is on the {} now.", self.side.key()),
                );
                vec![]
            }
            Action::ScrollUp | Action::ScrollDown => {
                let up = action == Action::ScrollUp;
                if diff_here {
                    self.move_cursor(if up { -10 } else { 10 });
                } else if terminal_here {
                    let pane = self.term.as_mut().expect("terminal_here");
                    let page = i64::from(pane.area.height.max(2) - 1);
                    pane.scroll_by(if up { page } else { -page });
                } else {
                    self.scroll_by(if up { 10 } else { -10 });
                }
                vec![]
            }
            Action::Follow => {
                if diff_here {
                    self.diff_cursor = self.rows.len().saturating_sub(1);
                } else if terminal_here {
                    let pane = self.term.as_mut().expect("terminal_here");
                    pane.scroll_by(-(pane.scroll as i64));
                } else {
                    self.follow = true;
                    self.scroll = 0;
                    self.diff_scroll = 0;
                }
                vec![]
            }
            Action::Copy => {
                if diff_here {
                    return self.copy_hunk();
                }
                if terminal_here {
                    // The terminal's scrollback and screen, as text, into the real terminal's own scrollback (no
                    // clipboard escape is ever written).
                    let lines = self
                        .term
                        .as_mut()
                        .map(|p| p.text_lines())
                        .unwrap_or_default();
                    if lines.is_empty() {
                        self.say(Tone::Said, "Nothing in the terminal to copy yet.");
                        return vec![];
                    }
                    self.mode = Mode::Copied;
                    return vec![Effect::Scrollback(lines)];
                }
                self.say(
                    Tone::Said,
                    "Nothing to copy here: copy works on a hunk in Diff, or on the terminal.",
                );
                vec![]
            }
            Action::Layout => self.next_layout(),
            Action::NextPane => self.move_focus(1),
            Action::PreviousPane => self.move_focus(-1),
            Action::LayoutFocused => self.set_layout(crate::panes::Layout::Focused),
            Action::LayoutSideBySide => self.set_layout(crate::panes::Layout::SideBySide),
            Action::LayoutGrid => self.set_layout(crate::panes::Layout::Grid),
            Action::FilterAll => self.set_filter(Filter::All),
            Action::FilterThisProject => self.set_filter(Filter::ThisProject),
            Action::FilterNeedsMe => self.set_filter(Filter::NeedsMe),
            Action::FilterToday => self.set_filter(Filter::Today),
            Action::FilterWorking => self.set_filter(Filter::Working),
            Action::FilterFailed => self.set_filter(Filter::Failed),
            Action::FilterDone => self.set_filter(Filter::Done),
            Action::NextTheme => {
                self.prefs.cycle_theme();
                self.line_cache = None;
                let name = self.prefs.theme.name.key();
                self.say(Tone::Said, format!("Theme: {name}, for this session."));
                vec![]
            }
            Action::Costs => {
                let s = &mut self.prefs.settings;
                s.show_costs = !s.show_costs;
                let words = if s.show_costs {
                    "Costs shown, for this session."
                } else {
                    "Costs hidden, for this session."
                };
                self.say(Tone::Said, words);
                vec![]
            }
            Action::KeyBar => {
                let s = &mut self.prefs.settings;
                s.key_bar = !s.key_bar;
                vec![]
            }
            Action::Settings => {
                self.mode = Mode::Settings;
                vec![]
            }
            Action::Agents => crate::agents::open(self),
            Action::LineDown => {
                self.move_cursor(1);
                vec![]
            }
            Action::LineUp => {
                self.move_cursor(-1);
                vec![]
            }
            Action::Top => {
                self.diff_cursor = 0;
                vec![]
            }
            Action::NextHunk => self.hunk_step(1),
            Action::PreviousHunk => self.hunk_step(-1),
            Action::NextFile => self.diff_step(1),
            Action::PreviousFile => self.diff_step(-1),
            Action::NextNote => self.note_step(true),
            Action::PreviousNote => self.note_step(false),
            Action::Note => self.start_note(),
            Action::RemoveNote => self.remove_note(),
            Action::MoreAbove => self.expand(true),
            Action::MoreBelow => self.expand(false),
            Action::SideBySide => {
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
        }
    }

    /// `<` / `>`: with one panel, the list narrower or wider (2 columns a key); with panels side by side or in a grid,
    /// the focused panel narrower or wider (the split it shares moves). Kept per project (viewstate.rs).
    fn resize(&mut self, by: i64) {
        use crate::panes::{Layout, RATIO_STEP};
        let split = self.panes.layout != Layout::Focused && !self.zoom;
        if split {
            // The focused panel's column: left (0, 2) grows by moving the split right.
            let left = self.panes.focus.is_multiple_of(2);
            let toward = if left == (by > 0) { 1 } else { -1 };
            let next = i64::from(self.panes.ratio_x) + toward * i64::from(RATIO_STEP);
            self.panes.ratio_x = next.clamp(20, 80) as u16;
            self.say(
                Tone::Said,
                format!("Split at {}%: = evens it.", self.panes.ratio_x),
            );
            return;
        }
        if self.list_state != crate::viewstate::ListState::Full {
            self.say(Tone::Said, "The list isn't shown in full: b shows it.");
            return;
        }
        let next = i64::from(self.split) + by * 2;
        self.split = next.clamp(24, 120) as u16;
        self.say(
            Tone::Said,
            format!("List {} columns wide: = sets it back.", self.split),
        );
    }

    /// A key while searching (search.rs): typing builds the query; Enter keeps it and n / N step through the matches;
    /// Esc leaves. Only these keys, while it is open.
    fn search_key(&mut self, key: KeyEvent, mut s: crate::search::Search) -> Vec<Effect> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let mut step: i64 = 0;
        match key.code {
            KeyCode::Esc => {
                self.mode = Mode::Normal;
                self.search = None;
                self.status = None;
                return vec![];
            }
            KeyCode::Enter if s.typing => {
                s.typing = false;
            }
            KeyCode::Enter => {
                // Done: the matches stay lit until Esc or another task.
                self.mode = Mode::Normal;
                self.search = Some(s);
                return vec![];
            }
            KeyCode::Backspace if s.typing => {
                s.query.pop();
                s.at = 0;
            }
            KeyCode::Char('n') if !s.typing && !ctrl => step = 1,
            KeyCode::Char('N') if !s.typing && !ctrl => step = -1,
            KeyCode::Char(c) if s.typing && !ctrl => {
                if s.query.chars().count() < crate::search::MAX_QUERY && !c.is_control() {
                    s.query.push(c);
                }
                s.at = 0;
            }
            _ => {}
        }
        // Find, and move the pane to, the current match.
        let lines = crate::search::pane_text(self)
            .map(|(_, l)| l)
            .unwrap_or_default();
        let found = crate::search::matching(&lines, &s.query);
        s.count = found.len();
        if found.is_empty() {
            s.at = 0;
        } else {
            let n = found.len() as i64;
            s.at = (s.at as i64 + step).rem_euclid(n) as usize;
            self.show_line(found[s.at], lines.len());
        }
        self.search = Some(s.clone());
        self.mode = Mode::Search(s);
        vec![]
    }

    /// Bring line `i` (of `total`) of the focused pane into view.
    fn show_line(&mut self, i: usize, total: usize) {
        match self.tab {
            Tab::Live => {
                self.follow = false;
                self.scroll = total.saturating_sub(i + 3);
            }
            Tab::Diff => self.diff_cursor = i.min(self.rows.len().saturating_sub(1)),
            Tab::Terminal => {
                if let Some(pane) = self.term.as_mut().filter(|p| !p.sensitive) {
                    let up = total.saturating_sub(i + 3) as i64;
                    pane.scroll_by(up - pane.scroll as i64);
                }
            }
            Tab::Steps => {}
        }
    }

    /// `1`-`9`: an answer to the question on screen (a thread's, or a task's), pinned and shown before it is sent.
    fn answer_key(&mut self, n: usize) -> Vec<Effect> {
        let item = self.selected_item().cloned();
        if item.as_ref().is_some_and(|i| i.thread) {
            let picked = match self.threads.view.as_ref() {
                Some(view) => crate::thread::pin(view, n),
                None => Err("Reading this thread…".to_string()),
            };
            match picked {
                Ok(pin) => {
                    self.status = None;
                    self.mode = Mode::ConfirmThread(pin);
                    self.thread_shown = false;
                    self.thread_scroll = 0;
                }
                Err(why) => self.say(Tone::Refused, why),
            }
            return vec![];
        }
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

    /// New task: one line, in this terminal's project, to the agent that takes new work.
    fn open_new_task(&mut self) -> Vec<Effect> {
        self.mode = Mode::NewTask(String::new(), false);
        // Who it goes to is said on the line: read it when it isn't known yet.
        if self.agents.is_none() && !self.fetching_agents {
            self.fetching_agents = true;
            return vec![Effect::FetchAgents];
        }
        vec![]
    }

    /// The rows the filter keeps.
    fn filtered(&self) -> Vec<Item> {
        let name = self.project.as_deref().map(|p| {
            std::path::Path::new(p)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
        });
        let here = match (&name, &self.project) {
            (Some(n), Some(p)) => Some((n.as_str(), p.as_str())),
            _ => None,
        };
        self.all_items
            .iter()
            .filter(|i| self.filter.keeps(i, here))
            .cloned()
            .collect()
    }

    /// Show only what a filter keeps (the selection kept when it still shows).
    pub fn set_filter(&mut self, filter: Filter) -> Vec<Effect> {
        if filter == Filter::ThisProject && self.project.is_none() {
            self.say(
                Tone::Refused,
                "This terminal wasn't started in a project, so there's no project to show.",
            );
            return vec![];
        }
        let before = self.selected_id();
        self.filter = filter;
        self.items = self.filtered();
        self.selected = before
            .as_ref()
            .and_then(|id| self.items.iter().position(|i| &i.id == id))
            .unwrap_or(0)
            .min(self.items.len().saturating_sub(1));
        let words = match self.filter.words() {
            None => "Showing everything.".to_string(),
            Some(w) => format!("Showing: {w}. The palette (:) changes it."),
        };
        self.say(Tone::Said, words);
        if self.selected_id() != before {
            return self.selection_changed();
        }
        vec![]
    }

    /// Select a task by id, showing everything first when the filter hides it.
    fn show_task(&mut self, id: &str) -> Vec<Effect> {
        if !self.items.iter().any(|i| i.id == id) && self.all_items.iter().any(|i| i.id == id) {
            self.filter = Filter::All;
            self.items = self.filtered();
            self.say(Tone::Said, "Showing everything: the filter hid it.");
        }
        let Some(index) = self.items.iter().position(|i| i.id == id) else {
            self.say(Tone::Refused, "That task isn't listed any more.");
            return vec![];
        };
        if index == self.selected {
            return vec![];
        }
        self.selected = index;
        self.selection_changed()
    }

    /// `!`: the next thing waiting on you, oldest first, round and round (the filter set aside when it hides it).
    fn next_needs_you(&mut self, forward: bool) -> Vec<Effect> {
        let mut waiting: Vec<(usize, &Item)> = self
            .all_items
            .iter()
            .enumerate()
            .filter(|(_, i)| i.section == Section::NeedsYou)
            .collect();
        if waiting.is_empty() {
            self.say(Tone::Said, "Nothing needs you.");
            return vec![];
        }
        // Oldest first; ages Work doesn't say go last, in the list's order.
        waiting.sort_by_key(|(at, i)| (std::cmp::Reverse(age_secs(&i.age).unwrap_or(-1)), *at));
        let ids: Vec<String> = waiting.iter().map(|(_, i)| i.id.clone()).collect();
        let here = self.selected_id();
        let at = here
            .as_ref()
            .and_then(|id| ids.iter().position(|w| w == id));
        let next = match (at, forward) {
            (Some(at), true) => (at + 1) % ids.len(),
            (Some(at), false) => (at + ids.len() - 1) % ids.len(),
            (None, true) => 0,
            (None, false) => ids.len() - 1,
        };
        // Where this jump left from (not a needs-you task itself): jump-back returns there. The list's order stays.
        if at.is_none() {
            self.jump_from = here;
        }
        let id = ids[next].clone();
        let fx = self.show_task(&id);
        let words = format!("{} of {} waiting on you.", next + 1, ids.len());
        if !matches!(&self.status, Some((_, w)) if w.starts_with("Showing everything")) {
            self.say(Tone::Said, words);
        }
        fx
    }

    /// Where the last run left off, applied once the first work list is in: its layout, its tab, and its scroll
    /// position once that task's output (or changes) are read.
    fn resume(&mut self, r: crate::state::Resume) -> Vec<Effect> {
        let mut fx = vec![];
        if r.layout != crate::panes::Layout::Focused {
            fx.extend(self.set_layout(r.layout));
            self.status = None;
        }
        let here = self.selected_id();
        if r.task.is_some() && here == r.task {
            let task = here.unwrap_or_default();
            if r.tab == Tab::Diff {
                self.restore_diff = Some((task, r.diff_file, r.scroll));
            } else if r.tab == Tab::Live && r.scroll > 0 {
                self.restore_scroll = Some((task, r.scroll));
            }
            self.tab = r.tab;
        }
        fx
    }

    /// The dialog open now, named so a frame can say it drew exactly this one: every mode but the few that only type,
    /// move or read (fail-closed: a dialog added later is gated until it is listed here). Its scroll and whether its end
    /// was seen are left out (they change as it is read); Accept's "notes go with it" is part of it.
    pub fn dialog_key(&self) -> Option<String> {
        match &self.mode {
            Mode::Normal
            | Mode::Steer(_)
            | Mode::Note(..)
            | Mode::NewTask(..)
            | Mode::NewThread(_)
            | Mode::SendBack(..)
            | Mode::Palette(_)
            | Mode::PickModel(_)
            | Mode::Search(_)
            | Mode::Help
            | Mode::Copied
            | Mode::Sending(_)
            | Mode::Fatal(..)
            | Mode::TakeOver => None,
            Mode::Build {
                title,
                preview,
                digest,
                terms,
                ..
            } => Some(format!("Build {title:?} {preview:?} {digest:?} {terms:?}")),
            Mode::SendReview {
                pin, typed, text, ..
            } => Some(format!("SendReview {pin:?} {typed:?} {text:?}")),
            Mode::ConfirmAccept(pin) => {
                Some(format!("ConfirmAccept {pin:?} {}", self.accept_attach))
            }
            other => Some(format!("{other:?}")),
        }
    }

    /// This project's view as the view file keeps it (viewstate.rs): ids and our own words only.
    pub fn view_now(&self) -> crate::viewstate::View {
        let default_side = self.prefs.settings.list_side;
        crate::viewstate::View {
            list_width: (self.split != self.prefs.settings.list_width()).then_some(self.split),
            list: self.list_state,
            side: (self.side != default_side).then_some(self.side),
            layout: self.panes.layout,
            ratio_x: self.panes.ratio_x,
            ratio_y: self.panes.ratio_y,
            tab: self.tab,
            task: self
                .selected_item()
                .map(|i| i.id.clone())
                .filter(|id| crate::state::safe_id(id)),
            // Only tasks still listed are kept (the file never grows with tasks gone).
            unread: self
                .unread
                .iter()
                .filter(|id| self.all_items.iter().any(|i| &i.id == *id) || !self.loaded)
                .cloned()
                .collect(),
        }
    }

    /// This project's remembered view, on launch: the list's width, state and side, the splits, and the unread marks
    /// at once; its layout, tab and task through the resume road once the work list is in.
    pub fn apply_view(&mut self, v: crate::viewstate::View) {
        if let Some(w) = v.list_width {
            self.split = w;
        }
        self.list_state = v.list;
        self.side = v.side.unwrap_or(self.prefs.settings.list_side);
        self.panes.ratio_x = v.ratio_x;
        self.panes.ratio_y = v.ratio_y;
        self.unread = v.unread.into_iter().collect();
        let mut r = self.restore.take().unwrap_or_default();
        r.layout = v.layout;
        r.tab = v.tab;
        if v.task.is_some() && r.task != v.task {
            r.task = v.task;
            r.scroll = 0;
            r.diff_file = 0;
        }
        self.restore = Some(r);
    }

    /// Where the person is now, as the state file keeps it (state.rs): ids and our own words only.
    pub fn resume_state(&self) -> crate::state::Resume {
        let task = self
            .selected_item()
            .map(|i| i.id.clone())
            .filter(|id| crate::state::safe_id(id));
        let scroll = match self.tab {
            Tab::Live if !self.follow => self.scroll,
            Tab::Diff => self.diff_cursor,
            _ => 0,
        };
        crate::state::Resume {
            task,
            tab: self.tab,
            scroll,
            diff_file: if self.tab == Tab::Diff {
                self.diff_index
            } else {
                0
            },
            filter: match &self.filter {
                Filter::Project(_) => Filter::All,
                f => f.clone(),
            },
            layout: self.panes.layout,
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
        if let Some((task, file, _)) = &self.restore_diff {
            if *task == ask.task {
                self.diff_index = *file;
            }
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
        if let Some((task, _, line)) = self.restore_diff.take() {
            if task == ask.task {
                self.diff_cursor = line.min(self.rows.len().saturating_sub(1));
            }
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

    /// Retry exactly the build and approved scope the dialog showed (POST /t/<task>/requeue, the task page's Retry; the
    /// console proves them again). Never the selection's task now: the pinned one.
    fn retry(&mut self, task: String, run: i64, digest: String) -> Vec<Effect> {
        if self.retry_pins().map(|(t, p)| (t, p.run, p.digest))
            != Some((task.clone(), run, digest.clone()))
        {
            self.say(
                Tone::Refused,
                "This task changed — look again before retrying.",
            );
            return vec![];
        }
        let path = format!("/t/{}/requeue", toolroll_api::client::encode(&task));
        self.act(
            path,
            vec![
                ("run", run.to_string()),
                ("digest", digest),
                ("return", "task".into()),
            ],
            format!("Retrying build #{run}: it starts again under your approval."),
        )
    }

    /// Stop retrying (POST /t/<task>/hold): an operator's hold, as the task page's "Hold the next attempt".
    fn hold(&mut self, task: String) -> Vec<Effect> {
        if self.selected_id().as_deref() != Some(task.as_str()) {
            self.say(
                Tone::Refused,
                "This task isn't selected any more — look again.",
            );
            return vec![];
        }
        let path = format!("/t/{}/hold", toolroll_api::client::encode(&task));
        self.act(
            path,
            vec![("reason", "stopped retrying from the terminal".into())],
            "Stopped retrying: it stays, and nothing more runs until you resume it.".into(),
        )
    }

    /// Cancel exactly the task, state and build the dialog showed (POST /t/<task>/cancel with them as pins, which the
    /// cancel proves in its own transaction).
    fn cancel(&mut self, task: String, state: String, run: Option<i64>) -> Vec<Effect> {
        if self.cancel_pins().map(|(t, _, s, r)| (t, s, r))
            != Some((task.clone(), state.clone(), run))
        {
            self.say(
                Tone::Refused,
                "This task changed — look again before cancelling.",
            );
            return vec![];
        }
        let path = format!("/t/{}/cancel", toolroll_api::client::encode(&task));
        self.act(
            path,
            vec![
                ("state", state),
                ("run", run.map_or("none".into(), |r| r.to_string())),
            ],
            "Cancelled: nothing else will run for this task.".into(),
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
        crate::thread::check_pin(self);
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
            Ok(ActOutcome::Terms { .. } | ActOutcome::ThreadTerms { .. }) => {
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

    /// File a new task, as the web's New task does: "Just code" (a small one comes back as its exact terms to Build,
    /// shown before anything starts; anything else is filed straight for a build), or "Plan first" (filed for a plan).
    fn new_task(&mut self, text: String, plan_first: bool) -> Vec<Effect> {
        let title = text.trim().to_string();
        if title.is_empty() {
            return vec![];
        }
        self.filing = title.clone();
        let mut fields = vec![("title", title)];
        let done = if plan_first {
            fields.push(("plain", "1".to_string()));
            fields.push(("planning-policy", "choice".to_string()));
            fields.push(("plan-first", "1".to_string()));
            "Filed. A plan comes first."
        } else {
            fields.push(("planning-policy", "choice".to_string()));
            "Filed. Just code: no plan step."
        };
        if let Some(project) = &self.project {
            fields.push(("repo", project.clone()));
        }
        self.act("/tasks/add".into(), fields, done.into())
    }

    /// A new thread with its first message, in this terminal's project. The engine refuses it while Flexible isn't
    /// available, and says so in its own words.
    fn new_thread(&mut self, text: String) -> Vec<Effect> {
        let message = text.trim().to_string();
        if message.is_empty() {
            return vec![];
        }
        // Kept for the terms card the engine answers with (the start posts this message under its key).
        self.filing = message.clone();
        let mut fields = vec![("message", message)];
        if let Some(project) = &self.project {
            fields.push(("repo", project.clone()));
        }
        self.act(
            "/agents/live/thread".into(),
            fields,
            "The thread started.".into(),
        )
    }

    // ---- mouse -----------------------------------------------------------------------------------------------------

    pub fn mouse(&mut self, ev: MouseEvent) -> Vec<Effect> {
        // A click is the person's next act, like a key (a move or the wheel isn't).
        if matches!(ev.kind, MouseEventKind::Down(_)) {
            self.key_since_said = true;
        }
        let (x, y) = (ev.column, ev.row);
        let inside = |r: Rect| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
        if let Some(fx) = self.terminal_mouse(&ev) {
            return fx;
        }
        match ev.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                // A click on a watched panel moves focus there.
                if let Some(slot) = self
                    .panes
                    .areas
                    .iter()
                    .position(|r| inside(*r))
                    .filter(|s| *s != self.panes.focus)
                {
                    return self.focus_pane(slot);
                }
                if x.abs_diff(self.areas.split_x) <= 1
                    && inside(Rect {
                        x: 0,
                        width: u16::MAX,
                        ..self.areas.list
                    })
                {
                    // A second press soon after the first: the list back to its usual width.
                    let now = std::time::Instant::now();
                    if self
                        .divider_down
                        .is_some_and(|t| now.duration_since(t) < DOUBLE_CLICK)
                    {
                        self.divider_down = None;
                        self.dragging = false;
                        self.split = self.prefs.settings.list_width();
                        self.say(Tone::Said, "The list is back to its usual width.");
                        return vec![];
                    }
                    self.divider_down = Some(now);
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
                // A drag is not the first half of a double click.
                self.divider_down = None;
                let body = self.areas.body;
                let w = if self.side == crate::viewstate::Side::Right {
                    body.right().saturating_sub(x + 1)
                } else {
                    x.saturating_sub(body.x)
                };
                self.split = w.clamp(24, 120);
                vec![]
            }
            // Focus follows the mouse (tui.toml, off by default): resting over another panel focuses it. Never while
            // typing in a terminal or with a dialog open, so keys can't be redirected under the person's hands.
            MouseEventKind::Moved
                if self.prefs.settings.focus_follows_mouse && self.mode == Mode::Normal =>
            {
                match self
                    .panes
                    .areas
                    .iter()
                    .position(|r| inside(*r))
                    .filter(|s| *s != self.panes.focus)
                {
                    Some(slot) => self.focus_pane(slot),
                    None => vec![],
                }
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

/// The left column from Work's rows: what waits on you (Work's Decide, Review, Unblock groups, and asks that are no
/// task), what agents are working on, what is up next, and everything else Work sent (section_of: every row listed).
pub fn items_of(rows: &WorkRows) -> Vec<Item> {
    let mut needs = vec![];
    let mut rest = vec![];
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
        thread: false,
        waiting: r.waiting.clone(),
    };
    for r in &rows.rows {
        let section = section_of(r);
        if section == Section::NeedsYou {
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
        } else if r.waiting.is_some() {
            // One word while it waits to try again, whatever the status says from moment to moment.
            rest.push(item(section, r, "Waiting".into()));
        } else {
            rest.push(item(section, r, r.word.word.clone()));
        }
    }
    // Asks that are no task row (a held release, a flow card, a setup step): listed, opened in the browser.
    for group in &rows.needs {
        for n in &group.rows {
            if needs.iter().any(|i: &Item| i.id == n.id) || covered_by_welcome(n) {
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
                thread: false,
                waiting: None,
            });
        }
    }
    // Each section in the order Work sent its rows.
    rest.sort_by_key(|i| i.section.order());
    needs.into_iter().chain(rest).collect()
}

/// First-run steps the first-run screen itself offers (New task n, Agents A): not listed, and not counted as needing
/// you, so the screen isn't sent to the browser for them.
pub fn covered_by_welcome(n: &NeedRow) -> bool {
    n.ask.as_deref() == Some("setup") && matches!(n.id.as_str(), "setup:task" | "setup:agent")
}

/// Errors that end the screen whichever read they came from (a stale read's other errors are dropped).
fn fatal(e: &ApiError) -> bool {
    matches!(e, ApiError::SessionEnded | ApiError::Contract(_))
}

/// The left column's order by section (Needs you, Working, Up next, Recent), each section's rows in the order given: a
/// thread joins its section after the tasks there.
fn sort_sections(items: &mut [Item]) {
    items.sort_by_key(|i| i.section.order());
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
            self.take_over_wanted = Some(item.id.clone());
            self.say(Tone::Said, "Reading this task…");
            return vec![];
        };
        self.take_over_wanted = None;
        let newest_build = steps
            .cards
            .iter()
            .flatten()
            .filter(|c| c.key == "build")
            .flat_map(|c| c.runs.first().copied())
            .next();
        let run = steps.review.as_ref().map(|r| r.run).or(newest_build);
        match run {
            // The first time on a build, what opening it means is said first, and nothing starts until t again.
            Some(run)
                if Some(run) != steps.live_run
                    && !self.confirmed.contains(&(item.id.clone(), run)) =>
            {
                self.status = None;
                self.mode = Mode::ConfirmTakeOver { task: item.id, run };
                vec![]
            }
            Some(run) if Some(run) != steps.live_run => self.open_take_over(item.id, run),
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

    /// Open (or reattach to) the console's terminal on that build: a person's yes to it was given (ConfirmTakeOver).
    fn open_take_over(&mut self, task: String, run: i64) -> Vec<Effect> {
        let mut fx = self.drop_term();
        self.term = Some(Pane::opening(task.clone(), run));
        self.tab = Tab::Terminal;
        self.status = Some((Tone::Said, format!("Opening a terminal on build #{run}…")));
        fx.push(Effect::TermOpen { task, run });
        fx
    }

    fn term_opened(
        &mut self,
        task: String,
        run: i64,
        result: Result<(String, String, TermLink), ApiError>,
    ) -> Vec<Effect> {
        let wanted = self
            .term
            .as_ref()
            .is_some_and(|p| p.task == task && p.run == run && p.link == Link::Opening);
        match result {
            Ok((id, branch, _link)) if wanted => {
                if let Some(pane) = self.term.as_mut() {
                    pane.attached(id);
                    pane.branch = clean(&branch);
                }
                // An agent's own sign-in or install: straight to typing while its screen is open.
                if task.starts_with("agent:")
                    && self.agents_screen.is_some()
                    && matches!(self.mode, Mode::Normal)
                {
                    self.mode = Mode::TakeOver;
                    self.say(Tone::Said, TYPING_AGENT);
                    return vec![];
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
            Ok((id, _, _)) => vec![Effect::TermDetach(id)],
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
        let mut detach: Option<String> = None;
        let mut agent_ended: Option<(Option<i64>, Option<i64>)> = None;
        match event {
            TermEvent::Output(chunk) => {
                pane.input_full = false;
                if !pane.take(chunk) {
                    // Never dropped silently: the socket is let go of, and the pane says why.
                    back = true;
                    said = Some((Tone::Refused, crate::term::TOO_MUCH.into()));
                    detach = Some(id.clone());
                }
            }
            TermEvent::Hello { cols, rows, ended } => pane.hello(cols, rows, ended),
            TermEvent::Exit { code, signal } => {
                pane.link = Link::Ended { code, signal };
                back = true;
                if pane.task.starts_with("agent:") {
                    // An agent's own sign-in or install ended: nothing of it is kept (its pane goes), and this
                    // computer's agents are looked for again. How it ended stays on the screen.
                    agent_ended = Some((code, signal));
                    pane.forget();
                    detach = pane.id.clone();
                } else {
                    said = Some((
                        Tone::Said,
                        "The terminal's program ended. Press t to open a new terminal.".into(),
                    ));
                }
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
                        Some(4008) => crate::term::TOO_MUCH,
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
        let mut fx: Vec<Effect> = detach.map(Effect::TermDetach).into_iter().collect();
        if let Some((code, signal)) = agent_ended {
            self.term = None;
            fx.extend(crate::agents::check_again(self));
            crate::agents::ended(self, code, signal);
        }
        fx
    }

    /// Bytes for the terminal the pane shows (only while live).
    fn term_input(&mut self, bytes: Vec<u8>) -> Vec<Effect> {
        // Only to a terminal on screen now (the last frame drew it).
        let Some(pane) = self.term.as_mut().filter(|p| p.live() && p.drawn) else {
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
        if !pane.drawn {
            self.mode = Mode::Normal;
            self.say(Tone::Said, OFF_SCREEN);
            return vec![];
        }
        match pane.key_bytes(key) {
            Some(bytes) => self.term_input(bytes),
            None => vec![],
        }
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
