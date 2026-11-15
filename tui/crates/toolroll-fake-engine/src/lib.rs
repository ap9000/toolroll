//! A stand-in Toolroll console for the terminal workbench's tests and the PTY harness: the engine API's routes over
//! real HTTP on 127.0.0.1, answering from the contract's own fixtures (test/fixtures/engine-api/) shaped into a small
//! scenario, with the same session rules a client must follow (one-time link, cookie, form token, mutation key).
//! Never shipped.
use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State as AxState};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

pub const COOKIE: &str = "standing-orders_session";
pub const SESSION: &str = "5555555555555555555555555555555555555555555555555555555555555555";
pub const CSRF: &str = "6666666666666666666666666666666666666666666666666666666666666666";
pub const KEY: &str = "7777777777777777777777777777777777777777777777777777777777777777";
pub const CODE: &str = "Fake_one-time_code_for_the_terminal_tests00";

pub fn fixtures_dir() -> String {
    concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../test/fixtures/engine-api/"
    )
    .to_string()
}

pub fn fixture(name: &str) -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(format!("{}{name}", fixtures_dir())).expect("fixture"),
    )
    .expect("fixture json")
}

/// One act the client posted: its path, its form fields, and whether it carried the session's credentials.
#[derive(Debug, Clone)]
pub struct Act {
    pub path: String,
    pub fields: Vec<(String, String)>,
    pub keyed: bool,
    pub csrf_ok: bool,
    pub cookie_ok: bool,
    pub in_place: bool,
}

impl Act {
    pub fn field(&self, name: &str) -> Option<&str> {
        self.fields
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Debug)]
pub struct State {
    pub work: Value,
    /// The agents read (GET /engine/agents).
    pub agents: Value,
    pub steps: HashMap<String, Value>,
    pub diffs: HashMap<String, Value>,
    pub diff_files: HashMap<String, Value>,
    /// Each file's lines at the result's head ("task:file"), for context reads.
    pub contexts: HashMap<String, Vec<String>>,
    /// Context reads answer this much later (a slow read, for "a stale answer is dropped").
    pub context_delay_ms: u64,
    /// Each run's main records, and whether it is still live.
    pub live: HashMap<i64, (Vec<Value>, bool)>,
    pub sub: HashMap<i64, Vec<Value>>,
    pub contract: String,
    pub acts: Vec<Act>,
    /// Every act refused with this status and these words (None: kept).
    pub refuse_acts: Option<(u16, String)>,
    /// Only completions refused so (a note saved, then Accept refused).
    pub refuse_complete: Option<(u16, String)>,
    /// Notes the console saved, by the request identity they came with (an unchanged retry saves nothing more, as the
    /// real console's sourceKey replay does): (request, note, a revision).
    pub notes_saved: Vec<(String, String, bool)>,
    /// Every read and act answers 401 (the console no longer holds the session).
    pub session_ended: bool,
    pub redeemed: bool,
    /// Reads of each path (for "re-read on change" assertions).
    pub reads: HashMap<String, usize>,
}

impl State {
    fn bump(&mut self, path: &str) {
        *self.reads.entry(path.to_string()).or_default() += 1;
    }
}

/// The contract digest the fixtures were written against.
pub fn contract_digest() -> String {
    fixture("schemas.json")["digest"]
        .as_str()
        .unwrap()
        .to_string()
}

const AT: &str = "2026-11-14T12:00:00.000Z";

#[allow(clippy::too_many_arguments)]
fn row(
    id: &str,
    title: &str,
    group: &str,
    label: &str,
    tone: &str,
    word: &str,
    detail: &str,
    age: &str,
    need: Value,
) -> Value {
    let mut r = fixture("work-rows.json")["rows"][1].clone();
    r["id"] = json!(id);
    r["title"] = json!(title);
    r["href"] = json!(format!("/t/{id}"));
    r["project"] = json!("shop");
    r["age"] = json!(age);
    r["status"] = json!({ "label": label, "tone": tone, "token": format!("assignment-{}", group) });
    r["word"] = json!({ "word": word, "tone": tone });
    r["group"] = json!(group);
    r["detail"] = json!(detail);
    r["ask"] = if need.is_null() {
        Value::Null
    } else {
        need["ask"].clone()
    };
    r["chip"] = if need.is_null() {
        Value::Null
    } else {
        json!(word)
    };
    r["need"] = need;
    r
}

fn need(id: &str, title: &str, ask: &str, line: &str, question: Value) -> Value {
    let mut n = fixture("work-rows.json")["rows"][0]["need"].clone();
    n["id"] = json!(id);
    n["title"] = json!(title);
    n["href"] = json!(format!("/t/{id}"));
    n["ask"] = json!(ask);
    n["group"] = json!(if ask == "answer" { "decide" } else { "review" });
    n["line"] = json!(line);
    n["question"] = question;
    n
}

/// The scenario's work list: one question, one result to check, two builds working, one finished today.
pub fn scenario_work() -> Value {
    let mut w = fixture("work-rows.json");
    let question = json!({ "id": 31, "text": "Keep the legacy /login?return= alias?", "recap": "The old alias still has callers.",
        "options": [
            { "id": "yes", "label": "Keep it", "consequence": "Adds a deprecation log line.", "recommended": true },
            { "id": "no", "label": "Remove it", "consequence": "Old links stop working.", "recommended": false },
            { "id": "later", "label": "Ask me later", "consequence": "The build waits.", "recommended": false } ] });
    w["projectName"] = json!("shop");
    w["project"] = json!("/home/me/shop");
    w["needsCount"] = json!(2);
    w["rows"] = json!([
        row(
            "t-ask",
            "Fix the login redirect",
            "decide",
            "Needs you",
            "attention",
            "Question",
            "The agent asked a question.",
            "3m ago",
            need(
                "t-ask",
                "Fix the login redirect",
                "answer",
                "Keep the legacy /login?return= alias?",
                question
            )
        ),
        row(
            "t-done",
            "Add CSV export",
            "review",
            "Needs you",
            "attention",
            "Result",
            "Ready for you to check.",
            "12m ago",
            need(
                "t-done",
                "Add CSV export",
                "review",
                "Ready for you to check.",
                Value::Null
            )
        ),
        row(
            "t-live",
            "Upgrade the test runner",
            "building",
            "Building",
            "live",
            "Building",
            "An agent is working on it.",
            "2m ago",
            Value::Null
        ),
        row(
            "t-rate",
            "Rate-limit middleware",
            "building",
            "Planning",
            "live",
            "Planning",
            "An agent is planning it.",
            "7m ago",
            Value::Null
        ),
        row(
            "t-old",
            "Bump dependencies",
            "rest",
            "Complete",
            "done",
            "Complete",
            "Accepted.",
            "3h ago",
            Value::Null
        ),
    ]);
    w["groups"] = json!([{ "key": "decide", "label": "Decide", "count": 1 }, { "key": "review", "label": "Review", "count": 1 },
        { "key": "building", "label": "Building", "count": 2 }, { "key": "rest", "label": "Recent", "count": 1 }]);
    w["needs"] = json!([]);
    w
}

/// An empty work list (a new install).
pub fn empty_work() -> Value {
    let mut w = scenario_work();
    w["rows"] = json!([]);
    w["groups"] = Value::Null;
    w["needsCount"] = json!(0);
    w
}

pub fn steps_for(task: &str, title: &str, live_run: Option<i64>, review: Option<i64>) -> Value {
    let mut s = fixture(if live_run.is_some() {
        "step-cards-plan-first.json"
    } else {
        "step-cards-just-code.json"
    });
    s["task"]["id"] = json!(task);
    s["task"]["root"] = json!(task);
    s["task"]["title"] = json!(title);
    s["task"]["project"] = json!("/home/me/shop");
    s["room"] = json!(format!("task:{task}"));
    s["liveRun"] = json!(live_run);
    if let Some(run) = live_run {
        // Plan done, build running now, on claude sonnet.
        for card in s["cards"].as_array_mut().unwrap().iter_mut() {
            match card["key"].as_str().unwrap() {
                "plan" | "approve" => {
                    card["state"] = json!("done");
                    card["mark"] = json!("done");
                    card["startedAt"] = json!(AT);
                    card["finishedAt"] = json!(AT);
                }
                "build" => {
                    card["state"] = json!("current");
                    card["mark"] = json!("live");
                    card["sentence"] = json!("Building now");
                    card["agent"] = json!({ "provider": "claude", "model": "sonnet" });
                    card["startedAt"] = json!(AT);
                    card["finishedAt"] = Value::Null;
                    card["costUsd"] = json!(0.31);
                    card["runs"] = json!([run]);
                }
                _ => {}
            }
        }
    }
    s["review"] = match review {
        Some(run) => json!({ "run": run, "receipt": "a".repeat(64), "source": "b".repeat(64),
            "accept": { "owed": null, "blockers": [], "needs": null } }),
        None => Value::Null,
    };
    s
}

fn record(i: usize) -> Value {
    match i % 5 {
        0 => {
            json!({ "k": "say", "at": AT, "t": [format!("Working on step {i}: the redirect keeps ?next now.")] })
        }
        1 => {
            json!({ "k": "step", "at": AT, "id": format!("s{i}"), "kind": "edit", "target": format!("src/auth/redirect-{}.ts", i % 7) })
        }
        2 => {
            json!({ "k": "done", "at": AT, "id": format!("s{}", i - 1), "ok": true, "out": ["+14 −3"] })
        }
        3 => {
            json!({ "k": "step", "at": AT, "id": format!("s{i}"), "kind": "command", "target": "npm test" })
        }
        _ => {
            json!({ "k": "done", "at": AT, "id": format!("s{}", i - 1), "ok": true, "out": ["212 passed (3.1 s)"] })
        }
    }
}

/// `n` records of a busy build (say / edit / command, each step done).
pub fn busy_records(from: usize, n: usize) -> Vec<Value> {
    (from..from + n).map(record).collect()
}

pub const LIVE_RUN: i64 = 7;
pub const RESULT_RUN: i64 = 2;

pub fn scenario() -> State {
    let mut steps = HashMap::new();
    steps.insert(
        "t-ask".into(),
        steps_for("t-ask", "Fix the login redirect", Some(9), None),
    );
    steps.insert(
        "t-done".into(),
        steps_for("t-done", "Add CSV export", None, Some(RESULT_RUN)),
    );
    steps.insert(
        "t-live".into(),
        steps_for("t-live", "Upgrade the test runner", Some(LIVE_RUN), None),
    );
    steps.insert(
        "t-rate".into(),
        steps_for("t-rate", "Rate-limit middleware", None, None),
    );
    steps.insert(
        "t-old".into(),
        steps_for("t-old", "Bump dependencies", None, None),
    );
    let mut diffs = HashMap::new();
    let mut d = fixture("result-diff.json");
    d["task"] = json!("t-done");
    d["run"] = json!(RESULT_RUN);
    diffs.insert("t-done".into(), d);
    let mut diff_files = HashMap::new();
    for f in 0..2 {
        let mut one = fixture("result-diff-file.json");
        one["task"] = json!("t-done");
        one["run"] = json!(RESULT_RUN);
        if f == 1 {
            one["file"]["file"] = json!(1);
            one["file"]["path"] = json!("README.md");
            one["file"]["oldPath"] = json!("README.md");
            one["file"]["hunks"] = json!([{ "header": "@@ -1 +1,2 @@", "lines": [
                { "kind": "context", "text": "# Shop", "oldLine": 1, "newLine": 1 },
                { "kind": "addition", "text": "Totals include tax.", "oldLine": null, "newLine": 2 } ] }]);
        }
        diff_files.insert(format!("t-done:{f}"), one);
    }
    // src/total.ts as the result left it (the fixture's hunk is its lines 1-3), and README.md.
    let mut contexts = HashMap::new();
    let mut total: Vec<String> = vec![
        "export function total(items) {".into(),
        "  return sum(items) + tax(items);".into(),
        "}".into(),
        "".into(),
        "export function tax(items) {".into(),
        "  return sum(items) * 0.2;".into(),
        "}".into(),
    ];
    total.extend((8..=60).map(|n| format!("// line {n}")));
    contexts.insert("t-done:0".to_string(), total);
    contexts.insert(
        "t-done:1".to_string(),
        vec!["# Shop".into(), "Totals include tax.".into()],
    );
    let mut live = HashMap::new();
    let main = vec![
        json!({ "k": "open", "at": AT, "detail": "base" }),
        json!({ "k": "start", "at": AT }),
        json!({ "k": "say", "at": AT, "t": ["Reading the test setup before switching runners."] }),
        json!({ "k": "step", "at": AT, "id": "e1", "kind": "edit", "target": "vitest.config.ts" }),
        json!({ "k": "done", "at": AT, "id": "e1", "ok": true, "out": ["+14 −3"] }),
        json!({ "k": "step", "at": AT, "id": "d1", "kind": "delegate", "target": "Check the CSV export edge cases" }),
        json!({ "k": "step", "at": AT, "id": "c1", "kind": "command", "target": "npm test" }),
        json!({ "k": "done", "at": AT, "id": "c1", "ok": true, "out": ["212 passed (3.1 s)"] }),
        json!({ "k": "say", "at": AT, "t": ["Tests pass on the new runner. Removing the old config next."] }),
    ];
    live.insert(LIVE_RUN, (main, true));
    let mut sub = HashMap::new();
    sub.insert(LIVE_RUN, vec![
        json!({ "k": "child", "s": 1, "at": AT, "parent": "d1", "desc": "Check the CSV export edge cases" }),
        json!({ "k": "say", "at": AT, "t": ["Empty rows export as a header line only."], "s": 1 }),
        json!({ "k": "step", "at": AT, "id": "r1", "kind": "read", "target": "src/export.ts", "s": 1 }),
        json!({ "k": "end", "s": 1, "at": AT, "ok": true }),
    ]);
    live.insert(
        9,
        (
            vec![json!({ "k": "say", "at": AT, "t": ["Waiting for your answer."] })],
            true,
        ),
    );
    State {
        work: scenario_work(),
        agents: fixture("agents.json"),
        steps,
        diffs,
        diff_files,
        contexts,
        context_delay_ms: 0,
        live,
        sub,
        contract: contract_digest(),
        acts: Vec::new(),
        refuse_acts: None,
        refuse_complete: None,
        notes_saved: Vec::new(),
        session_ended: false,
        redeemed: false,
        reads: HashMap::new(),
    }
}

#[derive(Clone)]
struct Shared {
    state: Arc<Mutex<State>>,
    changes: broadcast::Sender<String>,
}

pub struct FakeEngine {
    pub addr: SocketAddr,
    pub state: Arc<Mutex<State>>,
    changes: broadcast::Sender<String>,
}

impl FakeEngine {
    /// Serve `state` on 127.0.0.1 (`port` 0: any free one) from the current tokio runtime.
    pub async fn start(state: State, port: u16) -> FakeEngine {
        let state = Arc::new(Mutex::new(state));
        let (changes, _) = broadcast::channel(4096);
        let shared = Shared {
            state: state.clone(),
            changes: changes.clone(),
        };
        let app = Router::new()
            .route("/login/once", post(redeem))
            .route("/engine/hello", get(hello))
            .route("/work/rows", get(work))
            .route("/engine/agents", get(agents))
            .route("/t/{task}/steps", get(steps))
            .route("/t/{task}/diff", get(diff))
            .route("/agents/live/run/{run}", get(live_window))
            .route("/live", get(live_stream))
            .fallback(post(act))
            .with_state(shared);
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .expect("bind");
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        FakeEngine {
            addr,
            state,
            changes,
        }
    }

    pub fn link(&self) -> String {
        format!("http://127.0.0.1:{}/login/once/{CODE}", self.addr.port())
    }

    /// Say on `/live` that a room changed.
    pub fn change(&self, room: &str) {
        let _ = self.changes.send(room.to_string());
    }

    /// Append records to a run's main window and say its room changed.
    pub fn push_records(&self, run: i64, records: Vec<Value>) {
        self.state
            .lock()
            .unwrap()
            .live
            .entry(run)
            .or_insert_with(|| (Vec::new(), true))
            .0
            .extend(records);
        self.change(&format!("agent:{run}"));
    }

    pub fn acts(&self) -> Vec<Act> {
        self.state.lock().unwrap().acts.clone()
    }
}

fn cookie_ok(headers: &HeaderMap) -> bool {
    let want = format!("{COOKIE}={SESSION}");
    headers
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|c| c.split("; ").any(|p| p == want))
}

fn json_answer(status: u16, value: Value) -> Response {
    (
        StatusCode::from_u16(status).unwrap(),
        [("content-type", "application/json; charset=utf-8")],
        value.to_string(),
    )
        .into_response()
}

/// The session check every read makes: 401 once the console no longer holds it, a sign-in redirect without the cookie.
#[allow(clippy::result_large_err)]
fn admitted(s: &Shared, headers: &HeaderMap, path: &str) -> Result<(), Response> {
    let mut st = s.state.lock().unwrap();
    st.bump(path);
    if st.session_ended {
        return Err(json_answer(401, json!({ "error": "session" })));
    }
    if !cookie_ok(headers) {
        return Err((StatusCode::SEE_OTHER, [("location", "/login")]).into_response());
    }
    Ok(())
}

async fn redeem(AxState(s): AxState<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    let mut st = s.state.lock().unwrap();
    let code = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v["code"].as_str().map(str::to_owned));
    if st.redeemed || code.as_deref() != Some(CODE) {
        return json_answer(410, json!({ "error": "used" }));
    }
    st.redeemed = true;
    if headers.get("origin").is_some()
        || headers
            .get("x-toolroll-client")
            .and_then(|v| v.to_str().ok())
            != Some("terminal")
    {
        return json_answer(403, json!({ "error": "browser" }));
    }
    let mut r = fixture("link-redemption.json");
    r["cookie"] = json!({ "name": COOKIE, "value": SESSION });
    r["csrf"] = json!(CSRF);
    r["key"] = json!(KEY);
    json_answer(200, r)
}

async fn hello(AxState(s): AxState<Shared>, headers: HeaderMap) -> Response {
    if let Err(r) = admitted(&s, &headers, "/engine/hello") {
        return r;
    }
    let mut h = fixture("hello.json");
    h["contract"] = json!(s.state.lock().unwrap().contract.clone());
    json_answer(200, h)
}

async fn work(AxState(s): AxState<Shared>, headers: HeaderMap) -> Response {
    if let Err(r) = admitted(&s, &headers, "/work/rows") {
        return r;
    }
    json_answer(200, s.state.lock().unwrap().work.clone())
}

async fn agents(AxState(s): AxState<Shared>, headers: HeaderMap) -> Response {
    if let Err(r) = admitted(&s, &headers, "/engine/agents") {
        return r;
    }
    json_answer(200, s.state.lock().unwrap().agents.clone())
}

async fn steps(
    AxState(s): AxState<Shared>,
    Path(task): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(r) = admitted(&s, &headers, &format!("/t/{task}/steps")) {
        return r;
    }
    let found = s.state.lock().unwrap().steps.get(&task).cloned();
    match found {
        Some(v) => json_answer(200, v),
        None => json_answer(404, json!({ "error": "task" })),
    }
}

async fn diff(
    AxState(s): AxState<Shared>,
    Path(task): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Err(r) = admitted(&s, &headers, &format!("/t/{task}/diff")) {
        return r;
    }
    if let (Some(file), Some(from), Some(count)) = (q.get("file"), q.get("from"), q.get("count")) {
        let delay = s.state.lock().unwrap().context_delay_ms;
        if delay > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }
        let st = s.state.lock().unwrap();
        let (Ok(from), Ok(count), Ok(file_n)) = (
            from.parse::<i64>(),
            count.parse::<i64>(),
            file.parse::<i64>(),
        ) else {
            return json_answer(400, json!({ "error": "request" }));
        };
        if from < 1 || !(1..=100).contains(&count) {
            return json_answer(400, json!({ "error": "request" }));
        }
        let Some(lines) = st.contexts.get(&format!("{task}:{file}")) else {
            return json_answer(404, json!({ "error": "file" }));
        };
        let run = q
            .get("run")
            .and_then(|r| r.parse::<i64>().ok())
            .unwrap_or(0);
        let shown: Vec<Value> = lines
            .iter()
            .enumerate()
            .skip((from - 1) as usize)
            .take(count as usize)
            .map(|(i, t)| json!({ "newLine": i as i64 + 1, "text": t }))
            .collect();
        return json_answer(
            200,
            json!({ "version": 1, "task": task, "run": run, "file": file_n, "from": from, "lines": shown,
                "lineCount": lines.len(), "problem": null }),
        );
    }
    let st = s.state.lock().unwrap();
    if let Some(file) = q.get("file") {
        return match st.diff_files.get(&format!("{task}:{file}")) {
            Some(v) => json_answer(200, v.clone()),
            None => json_answer(404, json!({ "error": "file" })),
        };
    }
    match st.diffs.get(&task) {
        Some(v) => json_answer(200, v.clone()),
        None => {
            let mut none = fixture("result-diff-no-result.json");
            none["task"] = json!(task);
            json_answer(200, none)
        }
    }
}

async fn live_window(
    AxState(s): AxState<Shared>,
    Path(run): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Err(r) = admitted(&s, &headers, &format!("/agents/live/run/{run}")) {
        return r;
    }
    let st = s.state.lock().unwrap();
    let file = q.get("file").cloned().unwrap_or_else(|| "main".into());
    let missing = |live: bool| json!({ "version": 1, "session": { "kind": "run", "id": run, "task": null }, "room": format!("agent:{run}"), "live": live, "file": file, "window": { "ok": false, "reason": "missing" } });
    let (records, live) = match (file.as_str(), st.live.get(&run)) {
        ("main", Some((r, live))) => (r.clone(), *live),
        ("sub", Some((_, live))) => match st.sub.get(&run) {
            Some(r) => (r.clone(), *live),
            None => return json_answer(200, missing(*live)),
        },
        _ => return json_answer(404, json!({ "error": "run" })),
    };
    let from: usize = q
        .get("cursor")
        .and_then(|c| c.strip_prefix('c'))
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
        .min(records.len());
    let to = (from + 500).min(records.len());
    json_answer(
        200,
        json!({ "version": 1, "session": { "kind": "run", "id": run, "task": null }, "room": format!("agent:{run}"), "live": live, "file": file,
        "window": { "ok": true, "records": records[from..to], "cursor": format!("c{to}"), "restarted": false, "earlier": false, "quarantined": 0, "skipped": 0, "more": to < records.len() } }),
    )
}

async fn live_stream(
    AxState(s): AxState<Shared>,
    Query(q): Query<Vec<(String, String)>>,
    headers: HeaderMap,
) -> Response {
    if let Err(r) = admitted(&s, &headers, "/live") {
        return r;
    }
    let rooms: Vec<String> = q
        .into_iter()
        .filter(|(k, _)| k == "room")
        .map(|(_, v)| v)
        .collect();
    let rx = s.changes.subscribe();
    let hello = futures_util::stream::once(async {
        Ok::<Bytes, Infallible>(Bytes::from("event: hello\ndata: {\"tick\":15000}\n\n"))
    });
    let changes = tokio_stream::wrappers::BroadcastStream::new(rx).filter_map(move |room| {
        let rooms = rooms.clone();
        async move {
            let room = room.ok()?;
            rooms.contains(&room).then(|| {
                Ok::<Bytes, Infallible>(Bytes::from(format!(
                    "event: change\ndata: {{\"room\":{}}}\n\n",
                    json!(room)
                )))
            })
        }
    });
    (
        StatusCode::OK,
        [
            ("content-type", "text/event-stream"),
            ("cache-control", "no-store"),
        ],
        Body::from_stream(hello.chain(changes)),
    )
        .into_response()
}

async fn act(
    AxState(s): AxState<Shared>,
    uri: axum::http::Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let path = uri.path().to_string();
    let fields: Vec<(String, String)> = url_decode_form(&String::from_utf8_lossy(&body));
    let mut st = s.state.lock().unwrap();
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let record = Act {
        path: path.clone(),
        keyed: header("x-toolroll-key").as_deref() == Some(KEY),
        csrf_ok: fields.iter().any(|(k, v)| k == "csrf" && v == CSRF),
        cookie_ok: cookie_ok(&headers),
        in_place: header("x-toolroll-act").as_deref() == Some("in-place")
            && header("x-toolroll-client").as_deref() == Some("terminal"),
        fields: fields.into_iter().filter(|(k, _)| k != "csrf").collect(),
    };
    let ok = record.keyed && record.csrf_ok && record.cookie_ok;
    st.acts.push(record);
    if st.session_ended {
        return json_answer(401, json!({ "error": "session" }));
    }
    if !ok {
        return json_answer(
            403,
            json!({ "outcome": "refused", "words": "This tab isn't connected to Toolroll." }),
        );
    }
    if let Some((status, words)) = st.refuse_acts.clone() {
        return json_answer(status, json!({ "outcome": "refused", "words": words }));
    }
    if path.ends_with("/complete") {
        if let Some((status, words)) = st.refuse_complete.clone() {
            return json_answer(status, json!({ "outcome": "refused", "words": words }));
        }
    }
    if path == "/tasks/add" {
        return (StatusCode::SEE_OTHER, [("location", "/t/t-new")]).into_response();
    }
    if path.ends_with("/complete") {
        return json_answer(
            200,
            json!({ "outcome": "done", "words": "Accepted. The task is complete." }),
        );
    }
    if path.ends_with("/comment") {
        let last = st.acts.last().cloned().unwrap();
        let (request, note) = (
            last.field("request").unwrap_or("").to_string(),
            last.field("note").unwrap_or("").to_string(),
        );
        let revise = last.field("intent") == Some("revise");
        match st.notes_saved.iter().find(|(r, _, _)| *r == request) {
            Some((_, earlier, _)) if *earlier != note => {
                return json_answer(
                    409,
                    json!({ "outcome": "refused", "words": "This request identity already recorded a different note." }),
                );
            }
            Some(_) => {}
            None => st.notes_saved.push((request, note, revise)),
        }
    }
    if path.ends_with("/comment") && record_intent(&st) != Some("revise") {
        // A saved note (no intent): the real console lands back on the result (303).
        return (
            StatusCode::SEE_OTHER,
            [("location", "/r/2?noted=1#request-changes")],
        )
            .into_response();
    }
    if path.ends_with("/comment") {
        return json_answer(
            200,
            json!({ "outcome": "done", "words": "Sent back. The revision is filed." }),
        );
    }
    (StatusCode::SEE_OTHER, [("location", "/t/x#task-control")]).into_response()
}

fn record_intent(st: &State) -> Option<&str> {
    st.acts.last().and_then(|a| a.field("intent"))
}

fn url_decode_form(body: &str) -> Vec<(String, String)> {
    body.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (decode(k), decode(v))
        })
        .collect()
}

fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'+' {
            out.push(b' ');
        } else if bytes[i] == b'%' && i + 2 < bytes.len() {
            match std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                Some(b) => {
                    out.push(b);
                    i += 2;
                }
                None => out.push(b'%'),
            }
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
