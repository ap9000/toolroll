//! A Flexible thread as one more live session (F3): listed with the work, its panel shows the agent's transcript (the
//! same cards as a build's), its questions with where each answer stands, and the turn's level and cost.
//!
//! Answering: `1-9` picks an option of the question shown (the first one waiting on you that this console can answer),
//! pinning that question's request, its card digest and the option's exact words; Enter in the dialog posts exactly
//! those (POST /agents/live/thread/<id>/answer), only while the same question still waits with the same card, and only
//! once the question and the answer were drawn whole. The engine decides and sends it through F2d with this session's
//! person: the screen never decides anything, and a model never answers. Agent text is cleaned again before it is drawn.
//!
//! Starting one: `T` takes the first message; the engine answers with the thread's terms card (the project, Full access,
//! the agent and its relay sign-in, the network, the limits, what Ship does, the disclosures). The card is drawn whole
//! (wrapped, never cut, scrolled with j/Space) and Enter starts the thread only once its end was drawn, posting the
//! message and the card's key, nothing else: the engine starts it only if the card it makes again has that same key.
use crate::app::{App, Effect, Item, Mode, Section, Tone, Transcript};
use crate::text::{clean, fit, wrap};
use crate::theme::{dim, failed, ink, marks, needs_you, passed, running, selected};
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;
use toolroll_api::{LiveThreads, ThreadFacts, ThreadQuestion, ThreadRow};

/// Said when `T` is pressed while the console says interactive agent threads are off.
pub const THREADS_OFF: &str =
    "Interactive agent threads are off: Settings → General, or `toolroll config set flexible on`.";
/// What a new thread still needs first, as the console named it, and what the terminal offers for it: the console page
/// `w` opens (tui-contract.ts TUI_PAGES) and the command `c` puts in the scrollback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NextStep {
    pub words: &'static str,
    pub page: Option<&'static str>,
    pub command: Option<&'static str>,
}
impl NextStep {
    /// The command to copy, with this terminal's project where it needs one.
    pub fn command(&self, project: Option<&str>) -> String {
        let base = self.command.unwrap_or_default();
        match (base, project) {
            ("toolroll project flexible enable", Some(p)) => format!("{base} --repo {}", clean(p)),
            _ => base.to_string(),
        }
    }
}
/// The terminal's words and doors for each step a thread start may name (toolroll_api::NEXT_STEPS).
pub fn next_step(next: &str) -> Option<NextStep> {
    Some(match next {
        "turn-on" => NextStep { words: "Threads are off. w turns them on in the browser.", page: Some("flexible"), command: Some("toolroll config set flexible on") },
        "ask-operator" => NextStep { words: "Threads are off. Ask an instance operator to turn them on.", page: None, command: None },
        "sign-in" => NextStep {
            words: "Threads use your own Claude sign-in. Run `claude setup-token`, then `toolroll config set flexible-sign-in` (c copies it), or w to paste it in the browser.",
            page: Some("flexible-sign-in"),
            command: Some("toolroll config set flexible-sign-in"),
        },
        "sign-in-refused" => NextStep {
            words: "Claude didn't accept your sign-in for threads. Run `claude setup-token` again and save the new token (c copies the command, w opens the browser).",
            page: Some("flexible-sign-in"),
            command: Some("toolroll config set flexible-sign-in"),
        },
        "project-terms" => NextStep { words: "This project isn't set up for threads yet. w opens its terms.", page: Some("project"), command: Some("toolroll project flexible enable") },
        _ => return None,
    })
}

/// Said when a thread's question changed (or was answered elsewhere) while its dialog was open.
pub const THREAD_QUESTION_CHANGED: &str = "This question changed — look again.";
/// Said when Enter is pressed before the dialog drew the end of what would be allowed.
pub const READ_TO_THE_END: &str =
    "Read it to the end first (j or Space), then press Enter. Nothing was sent.";
/// Said when Allow is picked for a request whose card couldn't show all of it.
pub const CANT_ALLOW_UNSHOWN: &str =
    "This request couldn't be shown in full, so it can't be allowed from here. Press 2 to deny it.";
/// Said when a question can't be answered here (more than one part, or no options to pick from).
/// How many of a card's lines the panel shows (the dialog shows them all).
const PANEL_DETAIL: usize = 6;
pub const THREAD_ANSWER_ELSEWHERE: &str =
    "This question can't be answered with a number here — it has more than one part or no options.";

/// The look a thread's laid-out lines were coloured with.
pub type ThreadLook = (crate::theme::Theme, crate::theme::Glyphs);

/// The threads the console listed, and the one being watched.
#[derive(Debug, Default)]
pub struct Threads {
    /// The console's last answer said interactive agent threads are off (asked again with the next work read, so turning
    /// them on in the browser or the CLI shows here).
    pub off: bool,
    /// The console has answered at least once (on or off): until then the settings screen says it isn't known.
    pub answered: bool,
    pub fetching: bool,
    pub rows: Vec<ThreadRow>,
    pub view: Option<ThreadView>,
    /// What the person has looked at, per thread: the news key (news_key) of its latest turn and Ship when it was last
    /// selected or its view open. Kept in the workbench's own view state (viewstate.rs), like task unread marks.
    pub seen: std::collections::BTreeMap<String, String>,
    /// The reply on its way (its thread and the text typed), until the console answers: a refusal puts it back in its
    /// box, so the text is never lost and never falls through to the workbench's keys.
    pub reply_sent: Option<(String, String)>,
}

/// A thread's news: its latest turn (number and state) and its latest Ship (number and state). A new finished turn, a
/// new Ship or a Ship that moved is news again (a second refusal on the same turn too); reading it clears only the
/// news, never answers anything.
pub fn news_key(t: &ThreadRow) -> String {
    format!(
        "{}:{}:{}:{}",
        t.turn_seq.unwrap_or(0),
        t.turn.as_deref().unwrap_or("-"),
        t.ship_seq.unwrap_or(0),
        t.ship.as_deref().unwrap_or("-")
    )
}

/// The watched thread: its records, its facts (level, cost, questions) and the answer on its way.
#[derive(Debug, Default)]
pub struct ThreadView {
    pub id: String,
    pub transcript: Transcript,
    pub facts: Option<ThreadFacts>,
    pub fetching: bool,
    /// The request whose answer was posted and hasn't been answered yet (shown as sending).
    pub sending: Option<String>,
    /// Reads in a row that changed nothing (polls back off with it), and ticks until the next one.
    pub quiet: u32,
    pub due: u32,
    /// The transcript's laid-out lines for (transcript version, width, look): rebuilt only when one moves.
    pub lines: Option<(u64, usize, ThreadLook, Vec<Line<'static>>)>,
}

/// A card's detail as lines, each cleaned (agent text: drawn inert).
pub fn detail_lines(detail: &str) -> Vec<String> {
    detail.split('\n').map(clean).collect()
}

/// What a dialog showed, pinned when it opened: the request, the card digest, the option's place and exact words, and
/// what is posted for it.
#[derive(Debug, Clone, PartialEq)]
pub struct ThreadPin {
    pub thread: String,
    pub request: String,
    pub digest: String,
    pub index: usize,
    pub label: String,
    /// `decision` (accept or decline) for a permission; `question` and `answer` (the label) for a question.
    pub fields: Vec<(String, String)>,
}

impl Threads {
    /// The list's rows from the console's answer.
    pub fn listed(&mut self, list: LiveThreads) {
        self.fetching = false;
        self.rows = list.threads;
    }

    /// The thread items for the left column: waiting on you, or working.
    pub fn items(&self) -> Vec<Item> {
        self.rows
            .iter()
            .map(|t| {
                let level = level_words(t.level.as_deref());
                let cost = t
                    .cost_usd
                    .map(|c| format!(" · ${c:.2}"))
                    .unwrap_or_default();
                let seen = self.seen.get(&t.id).is_some_and(|k| *k == news_key(t));
                let (section, word) = thread_place(t, seen);
                let outcome = ship_outcome(t.ship.as_deref())
                    .map(|o| format!(" · {o}"))
                    .unwrap_or_default();
                Item {
                    section,
                    id: t.id.clone(),
                    title: clean(&t.title),
                    word: word.into(),
                    detail: if t.ended {
                        format!("Thread · ended{outcome}")
                    } else {
                        format!("Thread · {level}{cost}{outcome}")
                    },
                    tone: match section {
                        Section::NeedsYou => "attention",
                        Section::Working => "live",
                        _ => "ended",
                    }
                    .into(),
                    paused: false,
                    age: String::new(),
                    project: t.project.as_deref().map(clean),
                    need: None,
                    is_task: false,
                    thread: true,
                    waiting: None,
                }
            })
            .collect()
    }
}

/// Where a thread sits in the list, and its one word (the owner's placement decision): a question or permission waiting
/// always needs you; an ended thread (one the person closed) is in Recent; a working turn or a Ship on its way is
/// Working; anything else that is news (a turn that finished, stopped or ended unknown; a Ship that merged, stopped or
/// was refused) needs you until you have looked at it once (`seen`), then sits in Recent with the same word.
pub fn thread_place(t: &ThreadRow, seen: bool) -> (Section, &'static str) {
    if t.waiting > 0 {
        return (Section::NeedsYou, "Question");
    }
    if t.ended {
        return (Section::Recent, "Ended");
    }
    if matches!(t.turn.as_deref(), Some("admitted" | "running")) {
        return (Section::Working, "Working");
    }
    if matches!(
        t.ship.as_deref(),
        Some("approved" | "imported" | "armed" | "completed" | "merging")
    ) {
        return (Section::Working, "Shipping");
    }
    // The latest turn's own end comes first (an older Ship never hides why the newest turn stopped).
    let word = match (t.turn.as_deref(), t.ship.as_deref()) {
        (Some("unknown"), _) => "Outcome unknown",
        (Some("interrupted"), _) => "Stopped",
        (_, Some("cancelled")) => "Ship stopped",
        (_, Some("refused" | "failed")) => "Ship refused",
        _ => "Ready",
    };
    (
        if seen {
            Section::Recent
        } else {
            Section::NeedsYou
        },
        word,
    )
}

/// A thread's Ship outcome for its row's second line, kept apart from the thread's own state: the ones its word
/// doesn't already say (the browser's shipOutcome and the CLI's say the same).
pub fn ship_outcome(ship: Option<&str>) -> Option<&'static str> {
    match ship? {
        "merged" => Some("Ship: Merged"),
        "sent-back" => Some("Ship: sent back"),
        _ => None,
    }
}

/// Said when a thread act is asked for with no thread selected.
pub const NO_THREAD_SELECTED: &str = "Select a thread first.";
/// Said in the reply box when the thread's agent isn't running: the reply starts a fresh one (no `--resume`: D7).
pub const REPLY_STARTS_FRESH: &str =
    "This starts a fresh agent: it won't remember earlier turns. Your files are as it left them.";

/// Said when a reply can't go yet because the thread's turn is still working: the box stays open with what was typed.
pub const REPLY_WAITS_FOR_TURN: &str =
    "The agent is still working on your last message. Your reply stays here: press Enter once it finishes, or stop it with x.";

/// Whether the thread's latest turn is still working (admitted or running), as the console last listed it.
fn turn_working(app: &App, thread: &str) -> bool {
    app.threads
        .rows
        .iter()
        .any(|t| t.id == thread && matches!(t.turn.as_deref(), Some("admitted" | "running")))
}

/// `s` on a thread: the reply box, unless the thread ended (End is final). While a turn is still working the box opens
/// anyway, saying so: what the person types goes into it, never to the workbench's keys, and Enter sends it only once
/// the turn finishes.
pub fn open_reply(app: &mut App) -> Vec<crate::app::Effect> {
    let Some(id) = app.thread_selected() else {
        app.status = Some((Tone::Refused, NO_THREAD_SELECTED.into()));
        return vec![];
    };
    let row = app.threads.rows.iter().find(|t| t.id == id);
    if row.is_some_and(|t| t.ended) {
        app.status = Some((
            Tone::Refused,
            "This thread has ended. Press T to start a new one.".into(),
        ));
        return vec![];
    }
    app.status = turn_working(app, &id).then(|| (Tone::Refused, REPLY_WAITS_FOR_TURN.into()));
    app.mode = Mode::ThreadReply(id, String::new());
    vec![]
}

/// Enter in the reply box: the message, posted with a fresh key of its own (the same post twice takes one turn).
pub fn send_reply(app: &mut App, thread: String, text: String) -> Vec<crate::app::Effect> {
    let message = text.trim().to_string();
    if message.is_empty() {
        return vec![];
    }
    if app.thread_selected().as_deref() != Some(thread.as_str()) {
        app.status = Some((
            Tone::Refused,
            "Another thread is selected now. Nothing was sent.".into(),
        ));
        return vec![];
    }
    if turn_working(app, &thread) {
        app.status = Some((Tone::Refused, REPLY_WAITS_FOR_TURN.into()));
        app.mode = Mode::ThreadReply(thread, text);
        return vec![];
    }
    app.threads.reply_sent = Some((thread.clone(), text));
    let key = app.token(32);
    vec![Effect::Act {
        path: format!(
            "/agents/live/thread/{}/turn",
            toolroll_api::client::encode(&thread)
        ),
        fields: vec![("message".to_string(), message), ("key".to_string(), key)],
        done: "Sent.".into(),
    }]
}

/// Said when Ship's yes takes a password typed now: the workbench hands it to the command line.
pub const SHIP_NEEDS_PASSWORD: &str =
    "Shipping needs your password typed now. The command is in your scrollback: run it in a terminal (it shows these terms again first).";

/// `a` on a thread: its Ship terms, asked of the console (nothing is shipped by asking).
pub fn ask_ship(app: &mut App) -> Vec<crate::app::Effect> {
    let Some(id) = app.thread_selected() else {
        app.status = Some((Tone::Refused, NO_THREAD_SELECTED.into()));
        return vec![];
    };
    let row = app.threads.rows.iter().find(|t| t.id == id);
    if row.is_some_and(|t| matches!(t.turn.as_deref(), Some("admitted" | "running"))) {
        app.status = Some((Tone::Refused, "The agent is still working on your last message. Wait for it, or stop it with x, then ship.".into()));
        return vec![];
    }
    if row.is_some_and(|t| {
        matches!(
            t.ship.as_deref(),
            Some("approved" | "imported" | "armed" | "completed" | "merging")
        )
    }) {
        app.status = Some((Tone::Refused, "This thread's work is already shipping. x stops that Ship; r sends it back with a note.".into()));
        return vec![];
    }
    app.status = Some((Tone::Said, "Reading the Ship's terms…".into()));
    vec![Effect::Act {
        path: format!(
            "/agents/live/thread/{}/ship",
            toolroll_api::client::encode(&id)
        ),
        fields: vec![],
        done: "Shipping.".into(),
    }]
}

/// The console refused the reply on its way (or never answered): it goes back in its box, text and all, while its thread
/// is still the one selected and nothing else is open. Never a second send by itself.
pub fn keep_refused_reply(app: &mut App) {
    let Some((thread, text)) = app.threads.reply_sent.take() else {
        return;
    };
    if matches!(app.mode, Mode::Normal) && app.thread_selected().as_deref() == Some(thread.as_str())
    {
        app.mode = Mode::ThreadReply(thread, text);
    }
}

/// Whether the selected thread's Ship is armed (x cancels it, r sends it back).
pub fn shipping(app: &App) -> bool {
    app.thread_selected().is_some_and(|id| {
        app.threads
            .rows
            .iter()
            .any(|t| t.id == id && matches!(t.ship.as_deref(), Some("armed" | "completed")))
    })
}

/// `r` on a thread whose Ship is armed: the note box (Send back).
pub fn open_send_back(app: &mut App) -> Vec<crate::app::Effect> {
    let Some(id) = app.thread_selected() else {
        app.status = Some((Tone::Refused, NO_THREAD_SELECTED.into()));
        return vec![];
    };
    if app.threads.rows.iter().any(|t| t.id == id && t.ended) {
        app.status = Some((Tone::Refused, "This thread has ended, so it can't take your note. Cancel the Ship (x), or start a new thread.".into()));
        return vec![];
    }
    app.mode = Mode::ThreadSendBack(id, String::new());
    vec![]
}

/// Enter in the note box: the Ship ends and the note goes to the thread as its next message, with a key of its own.
pub fn send_back(app: &mut App, thread: String, text: String) -> Vec<crate::app::Effect> {
    let feedback = text.trim().to_string();
    if feedback.is_empty() {
        return vec![];
    }
    if app.thread_selected().as_deref() != Some(thread.as_str()) {
        app.status = Some((
            Tone::Refused,
            "Another thread is selected now. Nothing was sent.".into(),
        ));
        return vec![];
    }
    let key = app.token(32);
    vec![Effect::Act {
        path: format!(
            "/agents/live/thread/{}/ship/send-back",
            toolroll_api::client::encode(&thread)
        ),
        fields: vec![("feedback".to_string(), feedback), ("key".to_string(), key)],
        done: "Sent back.".into(),
    }]
}

/// What `x` and `X` do on a thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadAct {
    /// Stop its agent's turn; the thread stays open.
    Stop,
    /// End the thread, for good (its work can still be shipped).
    End,
    /// Stop the thread's armed Ship for good (x while it ships).
    CancelShip,
}

/// `x` or `X` on a thread: asked first (an ended thread is said so, and its agent is stopped already).
pub fn ask_act(app: &mut App, act: ThreadAct) -> Vec<crate::app::Effect> {
    let Some(id) = app.thread_selected() else {
        app.status = Some((Tone::Refused, NO_THREAD_SELECTED.into()));
        return vec![];
    };
    if app.threads.rows.iter().any(|t| t.id == id && t.ended) {
        app.status = Some((Tone::Refused, "This thread has ended.".into()));
        return vec![];
    }
    app.status = None;
    let act = if act == ThreadAct::Stop && shipping(app) {
        ThreadAct::CancelShip
    } else {
        act
    };
    app.mode = Mode::ConfirmThreadAct(id, act);
    vec![]
}

/// The question over the screen.
pub fn confirm_act_lines(act: ThreadAct) -> (&'static str, Vec<Line<'static>>) {
    let (title, question, more, yes) = match act {
        ThreadAct::CancelShip => (
            " Stop the Ship ",
            "Stop this Ship for good?",
            "Nothing more is merged from it. A pull request already open stays open.",
            "Stop it",
        ),
        ThreadAct::Stop => (
            " Stop ",
            "Stop the agent's turn?",
            "The thread stays open: reply to go on.",
            "Stop it",
        ),
        ThreadAct::End => (
            " End thread ",
            "End this thread?",
            "Its agent stops and it can't be reopened. You can still ship its work.",
            "End it",
        ),
    };
    (
        title,
        vec![
            Line::raw(""),
            Line::from(Span::styled(question, ink())),
            Line::from(Span::styled(more, dim())),
            Line::raw(""),
            Line::from(crate::sheet::act("y", yes, true)),
            Line::from(Span::styled("Any other key cancels.", dim())),
        ],
    )
}

/// A key on that question: `y` posts it for the thread it was asked about (only while that thread is still selected).
pub fn confirm_act_key(
    app: &mut App,
    thread: String,
    act: ThreadAct,
    key: KeyEvent,
) -> Vec<crate::app::Effect> {
    app.mode = Mode::Normal;
    if !matches!(key.code, KeyCode::Char('y') | KeyCode::Char('Y')) {
        app.status = Some((
            Tone::Said,
            match act {
                ThreadAct::Stop | ThreadAct::CancelShip => "Not stopped.",
                ThreadAct::End => "Not ended.",
            }
            .into(),
        ));
        return vec![];
    }
    if app.thread_selected().as_deref() != Some(thread.as_str()) {
        app.status = Some((
            Tone::Refused,
            "Another thread is selected now. Nothing changed.".into(),
        ));
        return vec![];
    }
    let verb = match act {
        ThreadAct::Stop => "stop",
        ThreadAct::End => "end",
        ThreadAct::CancelShip => "ship/cancel",
    };
    vec![Effect::Act {
        path: format!(
            "/agents/live/thread/{}/{verb}",
            toolroll_api::client::encode(&thread)
        ),
        fields: vec![],
        done: match act {
            ThreadAct::Stop | ThreadAct::CancelShip => "Stopped.",
            ThreadAct::End => "Ended.",
        }
        .into(),
    }]
}

pub fn level_words(level: Option<&str>) -> &'static str {
    match level {
        Some("supervised") => "Supervised",
        Some("auto") => "Auto",
        Some("full") => "Full access",
        _ => "level not set",
    }
}

/// The question the panel offers to answer: the first one waiting on you that this console can answer.
pub fn shown_question(facts: &ThreadFacts) -> Option<&ThreadQuestion> {
    facts
        .questions
        .iter()
        .find(|q| q.state == "pending" && q.answerable)
}

/// The options a question offers, in order: Allow and Deny for a permission, the one part's options for a question.
pub fn options_of(q: &ThreadQuestion) -> Option<Vec<String>> {
    if q.kind == "permission" {
        return Some(vec!["Allow".into(), "Deny".into()]);
    }
    match q.parts.as_slice() {
        [one] if !one.options.is_empty() => Some(one.options.iter().take(9).cloned().collect()),
        _ => None,
    }
}

/// Pin option `n` (0-based) of the question shown, or say why there's nothing to pin.
pub fn pin(view: &ThreadView, n: usize) -> Result<ThreadPin, String> {
    let q = view
        .facts
        .as_ref()
        .and_then(shown_question)
        .ok_or_else(|| "No question is waiting on you in this thread.".to_string())?;
    let options = options_of(q).ok_or_else(|| THREAD_ANSWER_ELSEWHERE.to_string())?;
    let label = options
        .get(n)
        .ok_or_else(|| format!("There's no answer {}.", n + 1))?
        .clone();
    // An allow covers the agent's whole request: never one whose card couldn't show all of it.
    if q.kind == "permission" && n == 0 && !q.complete {
        return Err(CANT_ALLOW_UNSHOWN.to_string());
    }
    let fields = if q.kind == "permission" {
        vec![(
            "decision".to_string(),
            if n == 0 { "accept" } else { "decline" }.to_string(),
        )]
    } else {
        vec![
            ("question".to_string(), q.parts[0].id.clone()),
            ("answer".to_string(), label.clone()),
        ]
    };
    Ok(ThreadPin {
        thread: view.id.clone(),
        request: q.request.clone(),
        digest: q.digest.clone(),
        index: n,
        label,
        fields,
    })
}

/// Whether a pin still names what the panel shows: the same thread, the same question still waiting with the same
/// card, and the same option in the same place.
pub fn stands(view: Option<&ThreadView>, pin: &ThreadPin) -> bool {
    let Some(view) = view.filter(|v| v.id == pin.thread) else {
        return false;
    };
    let Some(q) = view.facts.as_ref().and_then(shown_question) else {
        return false;
    };
    q.request == pin.request
        && q.digest == pin.digest
        && options_of(q).is_some_and(|o| o.get(pin.index) == Some(&pin.label))
}

/// The form an answer posts: the request, the card digest shown, and the choice.
pub fn answer_fields(pin: &ThreadPin) -> Vec<(&str, String)> {
    let mut fields = vec![
        ("request", pin.request.clone()),
        ("card", pin.digest.clone()),
    ];
    fields.extend(pin.fields.iter().map(|(k, v)| (k.as_str(), v.clone())));
    fields
}

/// Where an answer stands, in plain words, with its mark and style.
pub fn state_words(q: &ThreadQuestion, sending: bool) -> (&'static str, &'static str, Style) {
    let m = marks();
    if sending {
        return (m.running, "Sending…", running());
    }
    match q.state.as_str() {
        "pending" if q.answerable => (m.needs, "Waiting for you", needs_you()),
        "pending" => (m.todo, "Can't be answered here", dim()),
        "decided" | "sending" => (m.running, "Sending…", running()),
        "sent" => (m.running, "Sent, not yet confirmed", running()),
        "delivered" => (m.passed, "Received by the agent", passed()),
        "uncertain" => (m.failed, "Not confirmed — check its activity", failed()),
        "not-sent" => (m.skipped, "Not sent", dim()),
        "withdrawn" => (m.ended, "Withdrawn — the turn ended", dim()),
        _ => (m.ended, "Unknown", dim()),
    }
}

/// The head's second line: agent, level, turn and its cost.
fn facts_line(facts: &ThreadFacts) -> String {
    let mut parts = vec![];
    if let Some(agent) = &facts.agent {
        parts.push(format!(
            "{} · {}",
            clean(&agent.provider),
            clean(&agent.model)
        ));
    }
    parts.push(level_words(facts.level.as_deref()).to_string());
    if let Some(turn) = &facts.turn {
        // A plan's turn costs nothing extra: it says so, never "$0.00 so far, total unknown".
        let cost = match (
            turn.billing.as_deref(),
            turn.cost_usd,
            turn.cost_basis.as_deref(),
        ) {
            (Some("subscription"), _, _) => " · on your plan".into(),
            (_, Some(c), Some("estimated")) => format!(" · about ${c:.2}"),
            (_, Some(c), Some("unknown")) => format!(" · ${c:.2} so far, total unknown"),
            (_, Some(c), _) => format!(" · ${c:.2}"),
            (_, None, _) => " · no cost yet".into(),
        };
        parts.push(format!(
            "turn {} {}{cost}",
            turn.seq,
            turn_status_words(&turn.status)
        ));
    }
    parts.join(" · ")
}

/// A turn's state in plain words (the record's own status otherwise, cleaned).
pub fn turn_status_words(status: &str) -> String {
    match status {
        "admitted" => "starting".into(),
        "running" => "working".into(),
        "finished" => "done".into(),
        "interrupted" => "stopped".into(),
        "unknown" => "outcome unknown".into(),
        "withdrawn" => "didn't start".into(),
        other => clean(other),
    }
}

/// Toolroll's own note on how the turn ended, when it didn't simply finish: at most three lines at `w`.
pub fn end_note(facts: Option<&ThreadFacts>, w: usize) -> Vec<String> {
    // The latest turn's own end first (why it stopped, with what to do next), then the thread's end, then its Ship
    // (secondary: an older Ship never hides why the newest turn stopped). Toolroll's own words for each.
    let Some(f) = facts else {
        return vec![];
    };
    let mut said: Vec<String> = vec![];
    if let Some(turn) = f.turn.as_ref() {
        match (turn.status.as_str(), turn.end_words.as_deref()) {
            ("unknown", words) => said.push(format!(
                "Outcome unknown: {} Check its activity.",
                words
                    .map(clean)
                    .unwrap_or_else(|| "Toolroll couldn't tell how the turn ended.".into())
            )),
            // Toolroll's recorded explanation of a stop already says what to do next; without one, the recovery.
            ("interrupted", None) => said.push("This turn was stopped. Reply to go on.".into()),
            (_, Some(words)) => said.push(clean(words)),
            _ => {}
        }
    }
    if let Some(e) = f.ended.as_ref() {
        let words = clean(&e.words);
        if !said.contains(&words) {
            said.push(if e.stop_pending {
                format!("{words} Stopping its agent…")
            } else {
                words
            });
        }
    }
    if let Some(ship) = f.ship.as_ref() {
        said.push(clean(&ship.words));
    }
    if said.is_empty() {
        return vec![];
    }
    let mut lines = wrap(&format!("Toolroll: {}", said[0]), w);
    for more in &said[1..] {
        lines.extend(wrap(more, w));
    }
    lines.truncate(3);
    lines
}

/// The thread's panel (everything under the tabs): head, transcript, questions and the answer flow.
pub fn draw_panel(f: &mut Frame, app: &mut App, item: &Item, area: Rect) {
    let w = area.width as usize;
    let facts = app
        .threads
        .view
        .as_ref()
        .filter(|v| v.id == item.id)
        .and_then(|v| v.facts.clone());
    let sending = app.threads.view.as_ref().and_then(|v| v.sending.clone());
    let shown = facts.as_ref().and_then(shown_question).cloned();
    let options = shown.as_ref().and_then(options_of);
    // The question shown takes its words, its options and a blank line; every other question of the turn one line each.
    let others: Vec<ThreadQuestion> = facts
        .as_ref()
        .map(|f| {
            f.questions
                .iter()
                .filter(|q| Some(&q.request) != shown.as_ref().map(|s| &s.request))
                .rev()
                .take(3)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let q_lines = shown
        .as_ref()
        .map(|q| {
            3 + q
                .detail
                .as_deref()
                .map(|d| detail_lines(d).len().min(PANEL_DETAIL + 1) as u16)
                .unwrap_or(0)
                + options.as_ref().map(|o| o.len() as u16).unwrap_or(1)
        })
        .unwrap_or(0)
        + others.len() as u16;
    // A question waiting for you is a card outlined in ink (two rows and two columns more), when there's room.
    let waits = shown
        .as_ref()
        .is_some_and(|q| q.state == "pending" && q.answerable);
    let card = waits && area.height >= 20 && w >= 40;
    let q_lines = q_lines + if card { 2 } else { 0 };
    // A new task (n works everywhere) gets the same composer as a task's panel (view.rs draw_composer): never typed
    // into unseen. A new thread keeps its own line here.
    let roomy = area.height >= 22;
    let input_h: u16 = match &app.mode {
        Mode::ThreadSendBack(t, _) if *t == item.id => 1,
        Mode::ThreadReply(t, _) if *t == item.id => {
            if app.threads.rows.iter().any(|r| r.id == item.id && !r.live) {
                2
            } else {
                1
            }
        }
        Mode::NewThread(_) => 1,
        Mode::NewTask(..) if roomy => 5,
        Mode::NewTask(..) => 2,
        _ => 0,
    };
    let note = end_note(facts.as_ref(), w);
    let [head, content, note_row, qa, input_row] = Layout::vertical([
        Constraint::Length(2),
        Constraint::Min(1),
        Constraint::Length(note.len() as u16),
        Constraint::Length(q_lines),
        Constraint::Length(input_h),
    ])
    .areas(area);
    let title = facts
        .as_ref()
        .map(|f| clean(&f.title))
        .unwrap_or_else(|| item.title.clone());
    let second = facts
        .as_ref()
        .map(facts_line)
        .unwrap_or_else(|| item.detail.clone());
    f.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled(fit(&title, w), ink())),
            Line::from(Span::styled(fit(&second, w), dim())),
        ]),
        head,
    );
    // The transcript: the same cards as a build's live output.
    let lines: Vec<Line<'static>> = match app.threads.view.as_mut().filter(|v| v.id == item.id) {
        Some(v) if !v.transcript.main.is_empty() => {
            // Laid out again only when a record arrived or the width moved: an unchanged poll rebuilds nothing.
            let version = v.transcript.version;
            // And when the look changed (a reload of tui.toml, `t`): the lines carry its colours.
            let look = (app.prefs.theme, app.prefs.settings.glyphs);
            if !matches!(&v.lines, Some((at, width, was, _)) if *at == version && *width == w && *was == look)
            {
                v.lines = Some((
                    version,
                    w,
                    look,
                    crate::transcript::lines(&v.transcript, w, 0),
                ));
            }
            let all = &v.lines.as_ref().unwrap().3;
            let h = content.height as usize;
            all[all.len().saturating_sub(h)..].to_vec()
        }
        Some(v) if v.facts.is_none() => vec![Line::raw("Reading…")],
        _ => wrap("No output from the agent yet.", w)
            .into_iter()
            .map(Line::raw)
            .collect(),
    };
    f.render_widget(Paragraph::new(lines), content);
    // Toolroll's own note on the turn's end, in Toolroll's voice (never the agent's): under its transcript.
    if !note.is_empty() {
        f.render_widget(
            Paragraph::new(
                note.into_iter()
                    .map(|l| Line::from(Span::styled(l, ink())))
                    .collect::<Vec<_>>(),
            ),
            note_row,
        );
    }
    // Questions (inside the card when there is one).
    let w = if card { w.saturating_sub(4) } else { w };
    let mut lines = vec![];
    if let Some(q) = &shown {
        let (mark, words, style) = state_words(q, sending.as_deref() == Some(q.request.as_str()));
        lines.push(Line::from(vec![
            Span::styled(format!("{mark} "), style),
            Span::styled(
                fit(&clean(&q.title), w.saturating_sub(4 + words.len())),
                ink(),
            ),
            Span::styled(format!("  {words}"), dim()),
        ]));
        if let Some(detail) = &q.detail {
            // Its first lines here; every line in the dialog, which must be read to the end before Enter sends.
            let all = detail_lines(detail);
            for line in all.iter().take(PANEL_DETAIL) {
                lines.push(Line::from(Span::styled(
                    format!("  {}", fit(line, w.saturating_sub(2))),
                    dim(),
                )));
            }
            if all.len() > PANEL_DETAIL {
                lines.push(Line::from(Span::styled(
                    format!(
                        "  … {} more lines: picking an answer shows them all",
                        all.len() - PANEL_DETAIL
                    ),
                    dim(),
                )));
            }
        }
        if let Some(part) = q.parts.first().filter(|_| q.kind == "question") {
            lines.push(Line::from(Span::styled(
                format!("  {}", fit(&clean(&part.question), w.saturating_sub(2))),
                ink(),
            )));
        }
        match &options {
            Some(options) => {
                for (i, o) in options.iter().enumerate() {
                    let chosen = matches!(&app.mode, Mode::ConfirmThread(pin) if pin.index == i && pin.request == q.request);
                    let unshown = q.kind == "permission" && i == 0 && !q.complete;
                    let text = if unshown {
                        format!(
                            "{} {} — not from here: it can't all be shown",
                            i + 1,
                            clean(o)
                        )
                    } else {
                        format!("{} {}", i + 1, clean(o))
                    };
                    lines.push(Line::from(Span::styled(
                        format!("  {}", fit(&text, w.saturating_sub(2))),
                        if chosen {
                            selected().add_modifier(Modifier::BOLD)
                        } else {
                            Style::default()
                        },
                    )));
                }
            }
            None => lines.push(Line::from(Span::styled(
                format!("  {}", fit(THREAD_ANSWER_ELSEWHERE, w.saturating_sub(2))),
                dim(),
            ))),
        }
        lines.push(Line::raw(""));
    }
    for q in &others {
        let (mark, words, style) = state_words(q, sending.as_deref() == Some(q.request.as_str()));
        // A question by its own words; a permission by what it asks. Then where its answer stands.
        let what = match q.parts.first() {
            Some(part) if q.kind == "question" => &part.question,
            _ => &q.title,
        };
        let room = w.saturating_sub(4 + crate::text::width(words)).max(10);
        lines.push(Line::from(vec![
            Span::styled(format!("{mark} "), style),
            Span::raw(fit(&clean(what), room)),
            Span::styled(format!("  {words}"), dim()),
        ]));
    }
    let qa = if card {
        crate::sheet::outline(f.buffer_mut(), qa, needs_you());
        Rect {
            x: qa.x + 2,
            y: qa.y + 1,
            width: qa.width.saturating_sub(4),
            height: qa.height.saturating_sub(2),
        }
    } else {
        qa
    };
    f.render_widget(Paragraph::new(lines), qa);
    if matches!(app.mode, Mode::NewTask(..)) {
        crate::view::draw_composer(f, app, input_row, roomy);
    }
    if let Mode::ThreadSendBack(t, text) = &app.mode {
        if *t == item.id {
            f.render_widget(
                Paragraph::new(Line::from(vec![
                    Span::styled("Send back: ", ink()),
                    Span::raw(fit(text, w.saturating_sub(12))),
                    Span::styled("▏", ink()),
                ])),
                input_row,
            );
        }
    }
    if let Mode::ThreadReply(t, text) = &app.mode {
        if *t == item.id {
            let mut lines = vec![];
            if input_h > 1 {
                lines.push(Line::from(Span::styled(fit(REPLY_STARTS_FRESH, w), dim())));
            }
            lines.push(Line::from(vec![
                Span::styled("Reply: ", ink()),
                Span::raw(fit(text, w.saturating_sub(8))),
                Span::styled("▏", ink()),
            ]));
            f.render_widget(Paragraph::new(lines), input_row);
        }
    }
    if let Mode::NewThread(text) = &app.mode {
        f.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled("New thread: ", ink()),
                Span::raw(fit(text, w.saturating_sub(13))),
                Span::styled("▏", ink()),
            ])),
            input_row,
        );
    }
}

/// The answer dialog: the question, the chosen answer, every word (wrapped, never cut). When the window can't hold it
/// all, Enter sends nothing (`thread_shown` stays false).
pub fn confirm_lines(app: &mut App, area: Rect) -> Option<(&'static str, Vec<Line<'static>>)> {
    let Mode::ConfirmThread(pin) = &app.mode else {
        return None;
    };
    let view = app.threads.view.as_ref()?;
    let q = view
        .facts
        .as_ref()
        .and_then(shown_question)
        .filter(|q| q.request == pin.request)?
        .clone();
    let w = (area.width as usize).saturating_sub(8).min(72);
    let mut body: Vec<Line<'static>> = vec![];
    let said = |text: &str, style: Style, lines: &mut Vec<Line<'static>>| {
        lines.extend(
            wrap(text, w)
                .into_iter()
                .map(|l| Line::from(Span::styled(l, style))),
        );
    };
    said(&clean(&q.title), ink(), &mut body);
    if let Some(tool) = q.tool.as_deref().filter(|_| q.kind == "permission") {
        said(&format!("Tool: {}", clean(tool)), dim(), &mut body);
    }
    // Every line of what an allow would allow, wrapped, never cut.
    if let Some(detail) = &q.detail {
        for line in detail_lines(detail) {
            said(&line, Style::default(), &mut body);
        }
    }
    if let Some(part) = q.parts.first().filter(|_| q.kind == "question") {
        said(&clean(&part.question), Style::default(), &mut body);
    }
    body.push(Line::raw(""));
    said(
        &format!("Your answer: {}", clean(&pin.label)),
        ink(),
        &mut body,
    );
    // As many lines as the window holds, from where the person has read to; Enter sends only once the end was drawn.
    let room = (area.height as usize).saturating_sub(6).max(1);
    if w < 20 {
        app.thread_shown = false;
        return Some((
            " Answer ",
            wrap(READ_TO_THE_END, 16)
                .into_iter()
                .map(|l| Line::from(Span::styled(l, ink())))
                .collect(),
        ));
    }
    let top = app.thread_scroll.min(body.len().saturating_sub(room));
    app.thread_scroll = top;
    let end = (top + room).min(body.len());
    if end == body.len() {
        app.thread_shown = true;
    }
    let mut lines = vec![Line::raw("")];
    lines.extend(body[top..end].iter().cloned());
    lines.push(Line::raw(""));
    if app.thread_shown {
        lines.push(Line::from(crate::sheet::act(
            "Enter",
            "Send it to the agent",
            true,
        )));
        lines.push(Line::from(Span::styled("Esc cancels.", dim())));
    } else {
        lines.push(Line::from(crate::sheet::act(
            "j/Space",
            &format!("Read on ({} more lines)", body.len() - end),
            false,
        )));
        lines.push(Line::from(Span::styled(
            "Enter sends once you've read to the end. Esc cancels.",
            dim(),
        )));
    }
    Some((" Answer ", lines))
}

/// After a refresh: a dialog whose question no longer stands closes, saying so (nothing is sent).
pub fn check_pin(app: &mut App) {
    if let Mode::ConfirmThread(pin) = &app.mode {
        if !stands(app.threads.view.as_ref(), pin) {
            app.mode = Mode::Normal;
            app.status = Some((Tone::Refused, THREAD_QUESTION_CHANGED.into()));
        }
    }
}

// ---- starting a thread: its terms card -------------------------------------------------------------------------------

/// Said when Enter is pressed before the card's end was drawn.
pub const START_READ_TO_THE_END: &str =
    "Read the terms to the end first (j or Space), then press Enter. Nothing was started.";
/// The words that stand in for the card when the window can't show it at all.
pub const START_TOO_SMALL: &str =
    "These terms don't fit this window. Make it larger to read them. Nothing was started.";

/// A new thread's terms card as the engine made it: every line, the key the start posts, the message and project it was
/// made for, and how far it has been read. `drawn` is how many rows from the top have all been drawn without a gap (at
/// the width `drawn_width` laid them out); `seen_end` is set only when that covers every row, by drawing, never by a key.
/// `page` is how many rows the last draw showed: Space and PageDown move by exactly that, so paging never skips a row.
#[derive(Debug, Clone, PartialEq)]
pub struct StartTerms {
    pub message: String,
    pub repo: Option<String>,
    pub key: String,
    pub lines: Vec<String>,
    pub scroll: usize,
    pub seen_end: bool,
    pub page: usize,
    pub drawn: usize,
    pub drawn_width: usize,
    /// Set when these are a Ship's terms (not a new thread's): what Enter presses, or hands off.
    pub ship: Option<ShipPress>,
}

/// A Ship sheet's press: its thread, the digest the press names with the key, whether this session presses it here
/// (the laptop road), and otherwise the command that ships with a password typed now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShipPress {
    pub thread: String,
    pub digest: String,
    pub laptop: bool,
    pub command: Option<String>,
}

impl StartTerms {
    pub fn new(message: String, repo: Option<String>, key: String, lines: Vec<String>) -> Self {
        StartTerms {
            message,
            repo,
            key,
            lines,
            scroll: 0,
            seen_end: false,
            page: 1,
            drawn: 0,
            drawn_width: 0,
            ship: None,
        }
    }
}

/// A key on the terms card: j/k read on and back, Enter starts the thread (only once the end was drawn), Esc starts
/// nothing.
pub fn start_key(app: &mut App, mut terms: StartTerms, key: KeyEvent) -> Vec<Effect> {
    match key.code {
        KeyCode::Char('j') | KeyCode::Down | KeyCode::PageDown | KeyCode::Char(' ') => {
            terms.scroll += if matches!(key.code, KeyCode::PageDown | KeyCode::Char(' ')) {
                terms.page.max(1)
            } else {
                1
            };
            app.mode = Mode::StartThread(terms);
            vec![]
        }
        KeyCode::Char('k') | KeyCode::Up | KeyCode::PageUp => {
            let by = if key.code == KeyCode::PageUp {
                terms.page.max(1)
            } else {
                1
            };
            terms.scroll = terms.scroll.saturating_sub(by);
            app.mode = Mode::StartThread(terms);
            vec![]
        }
        KeyCode::Enter if !terms.seen_end => {
            app.mode = Mode::StartThread(terms);
            app.status = Some((Tone::Refused, START_READ_TO_THE_END.into()));
            vec![]
        }
        KeyCode::Enter if terms.ship.is_some() => {
            app.mode = Mode::Normal;
            let ship = terms.ship.unwrap();
            if app.thread_selected().as_deref() != Some(ship.thread.as_str()) {
                app.status = Some((
                    Tone::Refused,
                    "Another thread is selected now. Nothing was shipped.".into(),
                ));
                return vec![];
            }
            if !ship.laptop {
                // Ship takes a password typed now, which the workbench never takes: the command that does, in the
                // terminal's scrollback (it shows these same terms again before it asks).
                let Some(command) = ship.command else {
                    app.status = Some((
                        Tone::Refused,
                        "Shipping needs your password typed now. Nothing was shipped.".into(),
                    ));
                    return vec![];
                };
                app.mode = Mode::Copied;
                app.status = Some((Tone::Said, SHIP_NEEDS_PASSWORD.into()));
                return vec![Effect::Scrollback(vec![command])];
            }
            vec![Effect::Act {
                path: format!(
                    "/agents/live/thread/{}/ship",
                    toolroll_api::client::encode(&ship.thread)
                ),
                fields: vec![
                    ("terms".to_string(), terms.key),
                    ("digest".to_string(), ship.digest),
                ],
                done: "Shipping.".into(),
            }]
        }
        KeyCode::Enter => {
            app.mode = Mode::Normal;
            let mut fields = vec![
                ("message".to_string(), terms.message),
                ("terms".to_string(), terms.key),
            ];
            if let Some(repo) = terms.repo {
                fields.push(("repo".to_string(), repo));
            }
            vec![Effect::Act {
                path: "/agents/live/thread".into(),
                fields,
                done: "The thread started.".into(),
            }]
        }
        KeyCode::Esc => {
            app.mode = Mode::Normal;
            let words = if terms.ship.is_some() {
                "Nothing was shipped."
            } else {
                "Nothing was started."
            };
            app.status = Some((Tone::Said, words.into()));
            vec![]
        }
        _ => {
            app.mode = Mode::StartThread(terms);
            vec![]
        }
    }
}

/// The terms card over the screen: every line wrapped, never cut, from where it has been read to. Drawing its last line
/// is what lets Enter start the thread.
pub fn draw_start(f: &mut Frame, app: &mut App, area: Rect) {
    let Mode::StartThread(terms) = &mut app.mode else {
        return;
    };
    let w = area.width.saturating_sub(4).min(102);
    let h = area.height.saturating_sub(2);
    // Inside the border and its padding.
    let inner = w.saturating_sub(4) as usize;
    // Head 2 lines, foot 4 lines, the border 2: what's left shows the card.
    let visible = (h as usize).saturating_sub(8);
    let r = Rect {
        x: area.x + (area.width.saturating_sub(w)) / 2,
        y: area.y + 1,
        width: w,
        height: h,
    };
    let shipping = terms.ship.is_some();
    let laptop = terms.ship.as_ref().is_some_and(|p| p.laptop);
    let block = crate::view::dialog(f, r, if shipping { " Ship " } else { " New thread " });
    if inner < 24 || visible < 3 {
        terms.seen_end = false;
        terms.drawn = 0;
        terms.drawn_width = 0;
        let lines: Vec<Line<'static>> = wrap(START_TOO_SMALL, inner.max(8))
            .into_iter()
            .map(|l| Line::from(Span::styled(l, ink())))
            .collect();
        f.render_widget(Paragraph::new(lines).block(block), r);
        return;
    }
    let mut body: Vec<Line<'static>> = vec![];
    for raw in &terms.lines {
        // The card's own layout (summaryLines): a labelled row is two spaces, its label and the spaces that pad it, then
        // its words; its further lines start where the words do. Each line's words are wrapped to what is left after
        // that lead and every wrapped piece starts at the same column, so nothing is ever cut at the edge.
        let shown = clean(raw);
        let indent = shown.len() - shown.trim_start().len();
        let start = if indent == 2 {
            let after = shown[2..].find(' ').map_or(shown.len(), |i| i + 2);
            after + (shown[after..].len() - shown[after..].trim_start().len())
        } else {
            indent
        };
        let start = start.min(inner / 2);
        let (lead, words) = shown.split_at(shown.floor_char_boundary(start));
        let labelled = indent == 2;
        for (i, piece) in wrap(words, inner.saturating_sub(lead.len()).max(8))
            .into_iter()
            .enumerate()
        {
            body.push(Line::from(vec![
                if i == 0 {
                    Span::styled(
                        lead.to_string(),
                        if labelled { dim() } else { Style::default() },
                    )
                } else {
                    Span::raw(" ".repeat(lead.len()))
                },
                Span::raw(piece),
            ]));
        }
    }
    // Laid out at another width: the rows aren't the ones read before, so reading starts again from the top.
    if terms.drawn_width != inner {
        terms.drawn_width = inner;
        terms.drawn = 0;
        terms.scroll = 0;
        terms.seen_end = false;
    }
    let max = body.len().saturating_sub(visible);
    if terms.scroll > max {
        terms.scroll = max;
    }
    let end = (terms.scroll + visible).min(body.len());
    terms.page = visible;
    // Only rows that join what was already drawn count: a jump past unread rows covers nothing.
    if terms.scroll <= terms.drawn {
        terms.drawn = terms.drawn.max(end);
    }
    terms.seen_end = terms.drawn >= body.len();
    let mut lines = vec![
        Line::from(Span::styled(
            if shipping {
                "Ship approves exactly this:"
            } else {
                "Starting this thread agrees to exactly this:"
            },
            ink(),
        )),
        Line::raw(""),
    ];
    lines.extend(body[terms.scroll..end].iter().cloned());
    lines.push(Line::raw(""));
    if end < body.len() {
        lines.push(Line::from(Span::styled(
            format!("↓ {} more lines: j or Space reads on", body.len() - end),
            ink(),
        )));
    } else {
        lines.push(Line::raw(""));
    }
    if terms.seen_end {
        lines.push(Line::from(crate::sheet::act(
            "Enter",
            if !shipping {
                "Start the thread"
            } else if laptop {
                "Ship it"
            } else {
                "Ship it with your password (in a terminal)"
            },
            true,
        )));
    } else {
        lines.push(Line::from(Span::styled(
            if shipping {
                "Enter ships it once you've read to the end."
            } else {
                "Enter starts it once you've read to the end."
            },
            dim(),
        )));
    }
    lines.push(Line::from(Span::styled(
        if shipping {
            "Esc ships nothing."
        } else {
            "Esc starts nothing."
        },
        dim(),
    )));
    f.render_widget(Paragraph::new(lines).block(block), r);
}
