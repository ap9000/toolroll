//! The engine API's responses (src/contracts/engine-api.ts), as serde models.
//!
//! Hand-written from `test/fixtures/engine-api/schemas.json` and held to it by `tests/fixtures.rs`: every fixture parses
//! here and serialises back to exactly the same JSON (nothing dropped, nothing added), and the contract digest this
//! build was written against is the one in that file (`CONTRACT_DIGEST`). Objects are strict where the contract is
//! (`deny_unknown_fields`): a field this client doesn't know is a contract change, said by the `hello` handshake.
//!
//! Field rules, so a round trip is exact: a field the schema makes required but nullable is an `Option` that serialises
//! `null`; a field the schema makes optional is an `Option` that is left out when absent.
use serde::{Deserialize, Serialize};
use std::fmt;

/// The contract file this client was written against (its `digest` is what `hello` must answer).
pub const SCHEMAS_JSON: &str = include_str!("../../../../test/fixtures/engine-api/schemas.json");
/// The engine API version this client speaks.
pub const API_VERSION: u32 = 1;

/// The contract digest in `schemas.json` (sha256 of every schema with the API version, computed by the engine).
pub fn contract_digest() -> String {
    serde_json::from_str::<serde_json::Value>(SCHEMAS_JSON)
        .ok()
        .and_then(|v| v["digest"].as_str().map(str::to_owned))
        .unwrap_or_default()
}

// ---- LiveSession ------------------------------------------------------------------------------------------------

/// One record of a live window (live-records.ts LiveRecord): display only, already sanitised and redacted by the
/// engine. `s` is a subagent's stream number (records from the `sub` file).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "k", rename_all = "lowercase")]
pub enum LiveRecord {
    Open {
        at: String,
        detail: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        s: Option<i64>,
    },
    Start {
        at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        s: Option<i64>,
    },
    Say {
        at: String,
        t: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        s: Option<i64>,
    },
    Step {
        at: String,
        id: String,
        kind: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        once: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        s: Option<i64>,
    },
    Done {
        at: String,
        id: String,
        ok: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        out: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        s: Option<i64>,
    },
    Cut {
        at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        s: Option<i64>,
    },
    Cap {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        s: Option<i64>,
    },
    Child {
        s: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<String>,
        parent: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        via: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        desc: Option<String>,
    },
    End {
        s: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<String>,
        ok: Option<bool>,
    },
    Over {},
}

impl LiveRecord {
    /// The subagent stream a record belongs to (None: the run's own).
    pub fn stream(&self) -> Option<i64> {
        match self {
            LiveRecord::Open { s, .. }
            | LiveRecord::Start { s, .. }
            | LiveRecord::Say { s, .. }
            | LiveRecord::Step { s, .. }
            | LiveRecord::Done { s, .. }
            | LiveRecord::Cut { s, .. }
            | LiveRecord::Cap { s, .. } => *s,
            LiveRecord::Child { s, .. } | LiveRecord::End { s, .. } => Some(*s),
            LiveRecord::Over {} => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum SessionRef {
    Run { id: i64, task: Option<String> },
    Thread { id: String, task: Option<String> },
}

/// A window that was read: its records and the cursor to read on from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowRead {
    pub ok: bool,
    pub records: Vec<LiveRecord>,
    pub cursor: String,
    pub restarted: bool,
    pub earlier: bool,
    pub quarantined: i64,
    pub skipped: i64,
    pub more: bool,
}

/// No readable window: `off` (the run isn't this computer's), `missing` or `unavailable`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowMissing {
    pub ok: bool,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Window {
    Read(WindowRead),
    Missing(WindowMissing),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveSessionWindow {
    pub version: u32,
    pub session: SessionRef,
    pub room: String,
    pub live: bool,
    pub file: String,
    pub window: Window,
    /// A Flexible thread's facts (its window only; a run's never has them).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<ThreadFacts>,
}

// ---- Flexible threads (F3) ----------------------------------------------------------------------------------------

/// One part of an agent's question: its id (what the answer names), its words, and the options offered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThreadPart {
    pub id: String,
    pub question: String,
    pub options: Vec<String>,
}

/// One request of a thread's agent as its owner is shown it: the card (its `digest` is what an answer names), where
/// its answer stands (`state`), and whether it can be answered from this console now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThreadQuestion {
    pub request: String,
    pub kind: String,
    pub title: String,
    /// Every line of what an allow would allow, or a preview and why it can't all be shown.
    pub detail: Option<String>,
    pub tool: Option<String>,
    /// Whether the card shows the whole request (false: it can only be denied here).
    pub complete: bool,
    pub digest: String,
    pub state: String,
    pub answerable: bool,
    pub parts: Vec<ThreadPart>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThreadAgent {
    pub provider: String,
    pub model: String,
}

/// The thread's current turn and its cost so far (`cost_usd` None until a call is charged; `cost_basis` how sure).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ThreadTurn {
    pub seq: i64,
    pub status: String,
    pub cost_usd: Option<f64>,
    pub cost_basis: Option<String>,
    /// Toolroll's own words for how the turn ended when it didn't simply finish (an older engine leaves it out).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_words: Option<String>,
    /// `subscription` (the person's plan) or `api-key` (an older engine leaves it out).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub billing: Option<String>,
}

/// Attach preparation only; facts never confer launch, viewing or control authority.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThreadRuntime {
    StreamJson,
    Interactive,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalLifecycle {
    Starting,
    Live,
    Stopping,
    Exited,
    Unresolved,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalViewing {
    Detached,
    Viewing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalControl {
    None,
    #[serde(rename = "self")]
    ThisClient,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThreadTerminal {
    pub available: bool,
    pub launch: String,
    pub generation: u64,
    pub lifecycle: TerminalLifecycle,
    pub viewing: TerminalViewing,
    pub control: TerminalControl,
    pub protocol: u8,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThreadFacts {
    /// The facts' digest: sent back as `known`, an unchanged thread's window comes without them.
    pub version: String,
    pub title: String,
    pub project: Option<String>,
    pub level: Option<String>,
    pub agent: Option<ThreadAgent>,
    pub turn: Option<ThreadTurn>,
    pub questions: Vec<ThreadQuestion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<ThreadRuntime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<ThreadTerminal>,
    /// Ended (End is final): Toolroll's words for it, and whether its agent's stop is still being verified.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended: Option<ThreadEnded>,
    /// Its latest Ship, in Toolroll's words (absent before its first).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ship: Option<ThreadShip>,
}

/// A thread's latest Ship, as its facts say it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThreadShip {
    pub seq: i64,
    pub state: String,
    pub words: String,
}

/// How a thread ended (End is final).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ThreadEnded {
    pub words: String,
    pub stop_pending: bool,
}

/// One of the person's threads, as the work list shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ThreadRow {
    pub id: String,
    pub title: String,
    pub project: Option<String>,
    pub level: Option<String>,
    pub live: bool,
    pub waiting: i64,
    pub cost_usd: Option<f64>,
    /// Its latest turn's state (None before its first; an older engine leaves it out).
    #[serde(default)]
    pub turn: Option<String>,
    /// Ended (End is final; an older engine leaves it out: false).
    #[serde(default)]
    pub ended: bool,
    /// Its agent's stop is still being verified.
    #[serde(default)]
    pub stop_pending: bool,
    /// Its latest Ship's state (None before its first; an older engine leaves it out).
    #[serde(default)]
    pub ship: Option<String>,
    /// Its latest turn's number (None before its first; an older engine leaves it out).
    #[serde(default)]
    pub turn_seq: Option<i64>,
    /// Its latest Ship's number (None before its first; an older engine leaves it out).
    #[serde(default)]
    pub ship_seq: Option<i64>,
}

/// `GET /agents/live/threads`: the person's own Flexible threads, and whether interactive agent threads are on (`on`;
/// an older engine leaves it out, and refused the whole list while they were off).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveThreads {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<bool>,
    pub threads: Vec<ThreadRow>,
}

// ---- Work rows ------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Action {
    pub label: String,
    pub href: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuestionOption {
    pub id: String,
    pub label: String,
    pub consequence: String,
    pub recommended: bool,
}

/// An agent's question, answered in place (POST /d/<id>/answer).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Question {
    pub id: i64,
    pub text: String,
    pub recap: String,
    pub options: Vec<QuestionOption>,
}

/// What a waiting row asks (browser-workspace.ts BrowserHomeRow).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NeedRow {
    pub id: String,
    pub title: String,
    pub href: String,
    pub project: Option<String>,
    pub age: String,
    pub state: String,
    pub ask: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    pub reason: Option<String>,
    pub line: Option<String>,
    pub action: Option<Action>,
    pub question: Option<Question>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Status {
    pub label: String,
    pub tone: String,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Word {
    pub word: String,
    pub tone: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkRow {
    pub id: String,
    pub title: String,
    pub href: String,
    pub project: Option<String>,
    pub age: String,
    pub status: Status,
    pub word: Word,
    pub ask: Option<String>,
    pub chip: Option<String>,
    pub group: String,
    pub rank: i64,
    pub detail: Option<String>,
    pub problem: Option<String>,
    pub need: Option<NeedRow>,
    /// A queued task waiting to start again (null for every other row).
    pub waiting: Option<Waiting>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Group {
    pub key: String,
    pub label: String,
    pub count: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NeedGroup {
    pub key: String,
    pub label: String,
    pub count: i64,
    pub rows: Vec<NeedRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkRows {
    pub version: u32,
    pub project: Option<String>,
    pub project_name: String,
    pub needs_count: i64,
    pub groups: Option<Vec<Group>>,
    pub rows: Vec<WorkRow>,
    pub needs: Vec<NeedGroup>,
    pub next: Option<String>,
    pub room: String,
    /// The cost line: today's spend and the fullest current plan window (an instance operator's only; else None).
    pub spend: Option<Spend>,
}

/// "$1.84 today · plan 62%": today's spend (the UTC day) and the fullest current subscription window, rounded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Spend {
    pub today_usd: f64,
    pub plan_percent: Option<i64>,
}

// ---- Step cards -----------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Agent {
    pub provider: String,
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StepCard {
    pub key: String,
    pub label: String,
    pub state: String,
    pub mark: String,
    pub sentence: String,
    pub at: Option<String>,
    pub needs_you: bool,
    pub in_chain: bool,
    pub agent: Option<Agent>,
    pub started_at: Option<String>,
    /// When the step's newest run started (`started_at` is its first run's).
    pub latest_started_at: Option<String>,
    pub finished_at: Option<String>,
    pub cost_usd: Option<f64>,
    pub runs: Vec<i64>,
    /// The Approval step's terms while an approval waits (absent on every other card): a task sent back with a note
    /// waits for its revision's yes, and its Approval card carries them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terms: Option<StepTerms>,
}

/// A waiting approval's terms (approval-summary.ts, the summary every surface shows): `key` is what a yes pins, so a
/// change to what was shown refuses. Display only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StepTerms {
    pub key: String,
    pub revision: Option<String>,
    pub rows: Vec<TermsRow>,
    pub warnings: Vec<String>,
    pub usual_label: String,
    pub usual: Vec<UsualTerm>,
}

/// A decision or difference in the terms, with its lines when it has more than one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TermsRow {
    pub label: String,
    pub words: String,
    pub lines: Vec<String>,
}

/// One of the project's usual settings, by name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UsualTerm {
    pub label: String,
    pub words: String,
}

/// The approval waiting on a task, as its page's approval form carries it (GET /t/<task>/approval): every term the yes
/// agrees to, the form's `digest` and a `nonce` minted for this person and digest. The yes is the page's own
/// POST /t/<task>/approve with exactly these; `problem` (with neither) when nothing here can take this person's yes.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovalCard {
    pub version: u32,
    pub task: String,
    /// The terms' key (a step card's `terms.key`): which terms this card shows; the digest binds them.
    pub key: Option<String>,
    pub digest: Option<String>,
    pub nonce: Option<String>,
    pub terms: Vec<Term>,
    pub problem: Option<String>,
}

/// One term a yes agrees to: its label and its words (a new line in them is a line of its own).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Term {
    pub label: String,
    pub words: String,
}

impl fmt::Debug for ApprovalCard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The nonce is a single-use form token: never printed.
        f.debug_struct("ApprovalCard")
            .field("task", &self.task)
            .field("key", &self.key)
            .field("digest", &self.digest)
            .field("nonce", &self.nonce.as_ref().map(|_| "<held>"))
            .field("terms", &self.terms.len())
            .field("problem", &self.problem)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StepTask {
    pub id: String,
    pub root: String,
    pub title: String,
    pub state: String,
    pub project: Option<String>,
}

/// The result waiting for Accept or Send back: what the task page's own forms carry, and what accepting it means for
/// the person reading (said before they press Accept).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Review {
    pub run: i64,
    pub receipt: String,
    pub source: String,
    pub accept: ReviewAccept,
}

/// What Accept owes (`person-check`, `exception`), what refuses a completion now, and who else has to complete it, in
/// the engine's words. Display only: the completion decides again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewAccept {
    pub owed: Option<String>,
    pub blockers: Vec<String>,
    pub needs: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StepCards {
    pub version: u32,
    pub task: StepTask,
    pub chain: String,
    pub headline: Option<String>,
    pub live_run: Option<i64>,
    pub cards: Option<Vec<StepCard>>,
    pub review: Option<Review>,
    /// Open build shell's build and why a terminal can't be opened on it (null `why`: it can be); null with no build.
    #[serde(default)]
    pub shell: Option<Shell>,
    /// Why a failed task stopped (null unless it failed).
    pub failure: Option<Failure>,
    /// A queued task waiting to start again (null otherwise).
    pub waiting: Option<StepWaiting>,
    /// A person's hold on the task: what Resume releases (null when none stands).
    pub held: Option<TaskHold>,
    /// What Retry posts to `/t/<task>/requeue` (null unless a failed task can be retried as it stands).
    pub retry: Option<RetryPins>,
    /// A plan that stopped on this version and waits for Plan again (null when none did).
    #[serde(default)]
    pub plan_stopped: Option<PlanStopped>,
    /// What asking for a plan posts to `/t/<task>/plan` (null when a plan can't be asked for).
    #[serde(default)]
    pub plan: Option<PlanAsk>,
    /// A plan asked for that waits to start (its planner starts on its own): Stop retrying applies to it.
    #[serde(default)]
    pub plan_queued: bool,
    /// Who approved the task's scope (null while no approval stands).
    pub approval: Option<Approval>,
    pub room: String,
}

/// Open build shell's build (StepCards.shell): the run it would open, and why it can't (None: it can).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Shell {
    pub run: i64,
    pub why: Option<String>,
}

/// Why a failed task stopped.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Failure {
    pub line: String,
    pub failed_in_a_row: i64,
    pub suggestion: Option<String>,
    /// The agent's last lines before it stopped, cleaned by the engine (at most 8).
    pub agent_said: Option<Vec<String>>,
}

/// A step read's waiting task: the Work row's facts, and what the agent said on its way out of the last attempt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StepWaiting {
    pub retry_at: Option<String>,
    pub last_failure: Option<String>,
    /// "build" or "plan": what failed, and what is tried again.
    #[serde(default = "build_attempt")]
    pub attempt: String,
    pub agent_said: Option<Vec<String>>,
}

impl StepWaiting {
    /// As a Work row says it.
    pub fn facts(&self) -> Waiting {
        Waiting {
            retry_at: self.retry_at.clone(),
            last_failure: self.last_failure.clone(),
            attempt: self.attempt.clone(),
        }
    }
}

fn build_attempt() -> String {
    "build".into()
}

/// A plan that stopped and waits for Plan again: its planning incident, what stopped it, why the plan was refused and
/// what the agent said (cleaned by the engine), and what Plan again binds to (None: it can't be asked as it stands).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PlanStopped {
    pub incident: i64,
    /// "plan", "question" or "stalled".
    pub kind: String,
    pub line: String,
    pub problems: Option<Vec<String>>,
    pub agent_said: Option<Vec<String>>,
    pub again: Option<PlanAsk>,
}

/// The planning source a plan request (or Plan again) binds to: `/t/<task>/plan` `source`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PlanAsk {
    pub source: String,
}

/// A person's hold on a task (the operator's own): its id (what Resume names), reason and the last failure.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TaskHold {
    pub id: i64,
    pub reason: String,
    pub last_failure: Option<String>,
}

/// A queued task waiting to start again: when the next try is due, and the last build's failure in a line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Waiting {
    pub retry_at: Option<String>,
    pub last_failure: Option<String>,
    /// "build" or "plan": what failed, and what is tried again.
    #[serde(default = "build_attempt")]
    pub attempt: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetryPins {
    pub run: i64,
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Approval {
    pub by: String,
    pub you: bool,
    pub automatic: bool,
}

// ---- Result diff ----------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DiffTotals {
    pub files: i64,
    pub additions: i64,
    pub deletions: i64,
    pub binary: i64,
    pub files_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DiffFile {
    pub file: i64,
    pub path: String,
    pub old_path: Option<String>,
    pub additions: i64,
    pub deletions: i64,
    pub binary: bool,
    pub hunks: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ResultDiff {
    pub version: u32,
    pub task: String,
    pub run: Option<i64>,
    pub totals: Option<DiffTotals>,
    pub files: Vec<DiffFile>,
    pub patch_truncated: bool,
    pub problem: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: String,
    pub text: String,
    pub old_line: Option<i64>,
    pub new_line: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FileHunks {
    pub file: i64,
    pub path: String,
    pub old_path: Option<String>,
    pub meta: Vec<String>,
    pub hunks: Vec<Hunk>,
    /// The file's length at the result when the patch itself says it (an added file; a deleted one is 0).
    #[serde(default)]
    pub line_count: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ResultDiffFile {
    pub version: u32,
    pub task: String,
    pub run: i64,
    pub file: FileHunks,
    pub lines_truncated: bool,
}

/// One line of a result's file at its head, shown as context a hunk hides.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ContextLine {
    pub new_line: i64,
    pub text: String,
}

/// `GET /t/<task>/diff?run=&file=&from=&count=`: lines of one file around its hunks (at most 100 a read).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ResultDiffContext {
    pub version: u32,
    pub task: String,
    pub run: i64,
    pub file: i64,
    pub from: i64,
    pub lines: Vec<ContextLine>,
    pub line_count: Option<i64>,
    pub problem: Option<String>,
}

// ---- Sign-in, refusals, the handshake ------------------------------------------------------------------------

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionCookie {
    pub name: String,
    pub value: String,
}

/// `POST /login/once`: the local owner's session for this client's memory only. Its Debug prints no secret.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinkRedemption {
    pub version: u32,
    pub account: String,
    pub cookie: SessionCookie,
    pub csrf: String,
    pub key: String,
    pub epoch: String,
}

impl fmt::Debug for LinkRedemption {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "LinkRedemption {{ version: {}, account: {:?}, cookie: <{} chars>, csrf: <held>, key: <held>, epoch: <{} chars> }}",
            self.version,
            self.account,
            self.cookie.value.len(),
            self.epoch.len()
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Refusal {
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hello {
    pub version: u32,
    pub toolroll: String,
    pub contract: String,
    pub responses: Vec<String>,
    /// The install's solo or team mode as the engine derives it now (display only: every act derives it again). A solo
    /// screen shows no team concepts.
    pub mode: InstallMode,
    /// The steps a new task starts with on this install.
    #[serde(rename = "defaultChain")]
    pub default_chain: DefaultChain,
}

/// Solo (one person on their own install) or team (install-mode.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallMode {
    Solo,
    Team,
}

/// The chain a new task starts with: straight to code (solo) or plan first (team).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DefaultChain {
    JustCode,
    PlanFirst,
}

// ---- Agents on this computer ------------------------------------------------------------------------------------

/// One supported coding agent as the console's last detection saw it (agent-detect.ts): facts only, never a credential.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentRow {
    pub id: String,
    pub name: String,
    /// signed-in | signed-out | unknown | not-installed
    pub state: String,
    pub how: Option<String>,
    #[serde(rename = "signIn")]
    pub sign_in: Option<String>,
    pub ready: bool,
    pub next: Option<String>,
    pub setup: AgentSetup,
}

/// How an agent is added (agent-detect.ts AGENT_SETUP): Toolroll's own commands, whether the console runs its install
/// or sign-in in a pane (`can_install`, `can_sign_in`), what key it needs and where, an ACP agent's one-time check.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentSetup {
    pub install: Option<String>,
    #[serde(rename = "canInstall")]
    pub can_install: bool,
    #[serde(rename = "signIn")]
    pub sign_in: Option<String>,
    #[serde(rename = "canSignIn")]
    pub can_sign_in: bool,
    pub key: Option<String>,
    pub check: Option<String>,
    pub note: Option<String>,
    /// For an npm install: the registry the person's own ~/.npmrc sends this package to, when not the public one.
    pub registry: Option<String>,
    /// That file may set another registry this can't follow.
    #[serde(rename = "registryUnsure")]
    pub registry_unsure: bool,
}

/// `GET /engine/models`: the installation's planner, builder and reviewer as Settings → Models shows them, the digest a
/// change posts back (POST /settings/models/agent), and each default agent's preset as the fields that change posts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelsRead {
    pub version: u32,
    #[serde(rename = "canChange")]
    pub can_change: bool,
    pub digest: String,
    pub problem: Option<String>,
    pub roles: Vec<ModelRole>,
    #[serde(rename = "defaultAgent")]
    pub default_agent: Option<String>,
    pub presets: Vec<AgentPreset>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelRole {
    /// plan | build | review
    pub key: String,
    pub label: String,
    /// "provider|model" as the form posts it; "" when not set.
    pub current: String,
    pub words: String,
    pub choices: Vec<ModelChoice>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelChoice {
    pub provider: String,
    pub label: String,
    pub models: Vec<ModelOption>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelOption {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentPreset {
    pub agent: String,
    pub name: String,
    pub words: String,
    pub fields: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FirstTask {
    pub id: String,
    pub name: String,
}

/// `GET /engine/agents`: the agents on the console's computer, who the first task goes to, and the first run's lines
/// (the same words every screen shows). `checked_at` None: not looked for yet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentsRead {
    pub version: u32,
    #[serde(rename = "checkedAt")]
    pub checked_at: Option<String>,
    pub agents: Vec<AgentRow>,
    #[serde(rename = "firstTask")]
    pub first_task: Option<FirstTask>,
    pub lines: Vec<String>,
}

// ---- Central Lead chat ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LeadLink {
    pub label: String,
    pub href: String,
    pub task: Option<String>,
    pub tab: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum LeadCardPrimary {
    Confirm {
        label: String,
        irreversible: bool,
        native: bool,
    },
    Link {
        label: String,
        href: String,
        task: Option<String>,
        tab: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatCardFact {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatCardColumn {
    pub label: String,
    pub numeric: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatCardChartPoint {
    pub label: String,
    pub value: serde_json::Number,
    pub shown: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum ChatCardBlock {
    Text {
        text: String,
    },
    Divider {},
    Facts {
        heading: String,
        items: Vec<ChatCardFact>,
    },
    Table {
        heading: String,
        origin: String,
        columns: Vec<ChatCardColumn>,
        rows: Vec<Vec<String>>,
        more: i64,
    },
    Notes {
        heading: String,
        origin: String,
        items: Vec<String>,
        more: i64,
    },
    Chart {
        heading: String,
        chart: String,
        points: Vec<ChatCardChartPoint>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatCardButton {
    pub label: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatCardAction {
    pub proposal: i64,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ChatCard {
    pub version: u32,
    pub title: String,
    pub as_of: String,
    pub repos: Vec<String>,
    pub blocks: Vec<ChatCardBlock>,
    pub buttons: Vec<ChatCardButton>,
    pub actions: Vec<ChatCardAction>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LeadCard {
    pub id: i64,
    pub kind: String,
    pub label: String,
    pub state: String,
    pub data: bool,
    pub lines: Vec<String>,
    pub card: Option<ChatCard>,
    pub said: Option<String>,
    pub note: Option<String>,
    pub primary: Option<LeadCardPrimary>,
    pub dismissable: bool,
    pub links: Vec<LeadLink>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LeadAsk {
    pub turn: i64,
    pub question: String,
    pub options: Vec<String>,
    pub open: bool,
    pub stale: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LeadMessage {
    pub id: i64,
    pub role: String,
    pub text: String,
    pub activity: Option<String>,
    pub created_at: String,
    pub cards: Vec<LeadCard>,
    pub ask: Option<LeadAsk>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LeadQueued {
    pub id: i64,
    pub text: String,
    pub status: String,
    pub detail: Option<String>,
}

/// `GET /engine/chat`: the person's central Lead conversation (messages, structured cards, proposals, queue).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LeadChat {
    pub version: u32,
    pub room: String,
    pub session: Option<i64>,
    pub lead_name: String,
    pub can_send: bool,
    pub problem: Option<String>,
    pub project: Option<String>,
    pub busy: bool,
    pub pending_proposals: i64,
    pub queued: Vec<LeadQueued>,
    pub messages: Vec<LeadMessage>,
}

/// A live reply snapshot carried on `GET /live?room=chat` as `event: turn`.
/// When no turn is running, the server sends `{"room":"chat","state":"idle"}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTurn {
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub steps: Vec<LiveTurnStep>,
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub ok: bool,
}

impl LiveTurn {
    /// True when the server sent `{"state":"idle"}` (no active turn).
    pub fn is_idle(&self) -> bool {
        self.state.as_deref() == Some("idle")
            || (!self.done
                && self.phase.is_empty()
                && self.status.is_empty()
                && self.text.is_empty()
                && self.steps.is_empty())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTurnStep {
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub tool_calls: Vec<LiveTurnTool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTurnTool {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub summary: Option<String>,
}

// ---- Live terminals (take over) -------------------------------------------------------------------------------------

/// `GET /term/state`: this session's live terminals. `task` and `run`: the build a take-over opened on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TermState {
    pub available: bool,
    pub problem: Option<String>,
    pub programs: Vec<String>,
    pub projects: Vec<TermProject>,
    pub sessions: Vec<TermSession>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TermProject {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TermSession {
    pub id: String,
    pub repo: String,
    pub project: String,
    pub program: String,
    pub branch: String,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "endedAt")]
    pub ended_at: Option<String>,
    pub exit: Option<TermExit>,
    pub cleanup: Option<String>,
    pub task: Option<String>,
    pub run: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TermExit {
    pub code: Option<i64>,
    pub signal: Option<i64>,
}

/// `POST /term/start`: the terminal started (`id`), or why not (`error`, in words).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TermStarted {
    Started { ok: TrueOnly, id: String },
    Refused { ok: FalseOnly, error: String },
}

/// `true` and nothing else (a discriminant the JSON carries).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "bool", into = "bool")]
pub struct TrueOnly;
impl TryFrom<bool> for TrueOnly {
    type Error = &'static str;
    fn try_from(b: bool) -> Result<Self, Self::Error> {
        b.then_some(TrueOnly).ok_or("expected true")
    }
}
impl From<TrueOnly> for bool {
    fn from(_: TrueOnly) -> bool {
        true
    }
}

/// `false` and nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "bool", into = "bool")]
pub struct FalseOnly;
impl TryFrom<bool> for FalseOnly {
    type Error = &'static str;
    fn try_from(b: bool) -> Result<Self, Self::Error> {
        (!b).then_some(FalseOnly).ok_or("expected false")
    }
}
impl From<FalseOnly> for bool {
    fn from(_: FalseOnly) -> bool {
        false
    }
}
