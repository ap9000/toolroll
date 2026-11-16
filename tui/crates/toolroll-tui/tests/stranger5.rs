//! The stranger test's fourth round (0.9.113): a cancelled task offers no Resume; every act's toast says the console's
//! answer (a refusal in its words, never an assumed success); a status line about a new task goes once that task fails,
//! with no key pressed; the waiting header names the attempt it follows; attempt numbers are the task's own; a newly
//! filed task is selected and shown; and the wording fixes.
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use serde_json::{json, Value};
use toolroll_api::*;
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, Effect, Mode, Msg, Tab, Tone, HOLD_REASON, STATUS_HOLD};

/// 2026-11-14T12:04:12Z.
const NOW: i64 = 1_794_657_852;
const NO: &str = "The console said no: this task changed.";

fn parse<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).expect("fixture shape")
}
fn key(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)
}
fn code(c: KeyCode) -> KeyEvent {
    KeyEvent::new(c, KeyModifiers::NONE)
}
fn screen(app: &mut App, w: u16, h: u16) -> String {
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| toolroll_tui::view::draw(f, app)).unwrap();
    term.backend().to_string()
}
fn status(app: &App) -> Option<(Tone, String)> {
    app.status.clone()
}

/// One effect run as run.rs runs it; its answer, if it has one.
async fn run_fx(client: &Client, fx: Effect) -> Option<Msg> {
    Some(match fx {
        Effect::FetchWork => Msg::Work(client.work_rows().await),
        Effect::FetchSteps(task) => {
            let r = client.steps(&task).await;
            Msg::Steps(task, r)
        }
        Effect::FetchDiff(ask) => {
            let r = client.diff(&ask.task, ask.run).await;
            Msg::Diff(ask, r)
        }
        Effect::FetchDiffFile(ask) => {
            let r = client.diff_file(&ask.task, ask.run, ask.file).await;
            Msg::DiffFile(ask, r)
        }
        Effect::Act { path, fields, done } => {
            let pairs: Vec<(&str, &str)> = fields
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect();
            Msg::Acted(client.act(&path, &pairs, &done).await)
        }
        Effect::Send {
            acts,
            task,
            run,
            text,
        } => toolroll_tui::run::send_batch(client, acts, task, run, text).await,
        _ => return None,
    })
}

/// Run effects and the effects their answers ask for, until nothing is left.
async fn pump(app: &mut App, client: &Client, fx: Vec<Effect>) {
    let mut queue = fx;
    for _ in 0..500 {
        let Some(next) = queue.pop() else { return };
        if let Some(msg) = run_fx(client, next).await {
            queue.extend(app.update(msg));
        }
    }
    panic!("effects never settled");
}

/// t-retry's steps: its builds #9, #5 and #3 (its third attempt is #9), in `state`.
fn steps(state: &str) -> Value {
    let mut s = fake::steps_for("t-retry", "Rename the config loader", None, None);
    s["task"]["state"] = json!(state);
    for card in s["cards"].as_array_mut().unwrap() {
        if card["key"] == "build" {
            let stuck = state == "failed" || state == "cancelled";
            card["state"] = json!(if stuck { "stuck" } else { "todo" });
            card["mark"] = json!(if stuck { "stuck" } else { "todo" });
            card["sentence"] = json!(if state == "queued" {
                "Stopped"
            } else {
                "The agent stopped with an error"
            });
            card["startedAt"] = json!("2026-11-14T11:30:00.000Z");
            card["latestStartedAt"] = json!("2026-11-14T12:02:32.000Z");
            card["finishedAt"] = json!("2026-11-14T12:03:32.000Z");
            card["runs"] = json!([9, 5, 3]);
        }
    }
    s
}
fn waiting_steps() -> Value {
    let mut s = steps("queued");
    s["cards"].as_array_mut().unwrap().iter_mut().for_each(|c| {
        if c["key"] == "build" {
            c["sentence"] = json!("Waiting to start");
        }
    });
    s["waiting"] = json!({ "retryAt": "2026-11-14T12:05:52.000Z", "lastFailure": "The agent stopped with an error", "agentSaid": null });
    s
}
fn held_steps() -> Value {
    let mut s = steps("queued");
    s["held"] = json!({ "id": 41, "reason": HOLD_REASON, "lastFailure": "The agent stopped with an error" });
    s
}
fn failed_steps(in_a_row: i64) -> Value {
    let mut s = steps("failed");
    s["failure"] = json!({ "line": "The agent stopped with an error.", "failedInARow": in_a_row, "suggestion": null, "agentSaid": null });
    s["retry"] = json!({ "run": 9, "digest": "d".repeat(64) });
    s
}

fn app_on(work: Value) -> App {
    let mut app = App::new(false, Some("/work/proj".into()));
    app.now = NOW;
    app.update(Msg::Work(Ok(parse(work))));
    app
}
fn select(app: &mut App, id: &str) {
    let at = app.items.iter().position(|i| i.id == id).expect("listed");
    while app.selected < at {
        app.key(key('j'));
    }
    while app.selected > at {
        app.key(key('k'));
    }
}
fn on(steps: Value) -> App {
    let mut app = app_on(fake::fixture("work-rows-every-kind.json"));
    select(&mut app, "t-retry");
    app.update(Msg::Steps("t-retry".into(), Ok(parse(steps))));
    app
}

// ---- 1. a cancelled task offers no resume; every act says the console's answer -------------------------------------

#[test]
fn a_cancelled_task_offers_no_resume_whatever_a_read_says() {
    // Even a read that still names a hold (an older console): a cancelled task has nothing to resume.
    let mut s = held_steps();
    s["task"]["state"] = json!("cancelled");
    s["waiting"] = json!({ "retryAt": null, "lastFailure": "x", "agentSaid": null });
    let mut app = on(s);
    let shown = screen(&mut app, 160, 34);
    for never in ["Resume retrying", "On hold", "x resume", "next try"] {
        assert!(!shown.contains(never), "{never}\n{shown}");
    }
    assert!(!matches!(app.mode, Mode::ConfirmResume { .. }));
    app.key(key('x'));
    assert!(
        !matches!(app.mode, Mode::ConfirmResume { .. }),
        "{:?}",
        app.mode
    );
}

/// Each act the workbench confirms, refused by the console: the toast is the console's words, as a refusal, and never
/// the words a success would have said.
#[tokio::test(flavor = "multi_thread")]
async fn a_refused_act_says_the_consoles_words_never_success() {
    type Opens = fn(&mut App) -> Vec<Effect>;
    let acts: Vec<(&str, Value, Opens, &str)> = vec![
        (
            "resume",
            held_steps(),
            |a| {
                a.key(key('x'));
                a.key(code(KeyCode::Enter))
            },
            "Resumed",
        ),
        (
            "stop retrying",
            waiting_steps(),
            |a| {
                a.key(key('x'));
                a.key(code(KeyCode::Enter))
            },
            "Stopped retrying",
        ),
        (
            "retry",
            failed_steps(2),
            |a| {
                a.key(key('r'));
                a.key(code(KeyCode::Enter))
            },
            "Retrying",
        ),
        (
            "cancel",
            failed_steps(1),
            |a| {
                a.key(key('X'));
                a.key(code(KeyCode::Enter))
            },
            "Cancelled",
        ),
    ];
    for (what, s, open, success) in acts {
        let mut state = fake::scenario();
        state.work = fake::fixture("work-rows-every-kind.json");
        state.steps.insert("t-retry".into(), s.clone());
        state.refuse_acts = Some((409, NO.into()));
        let engine = fake::FakeEngine::start(state, 0).await;
        let client = toolroll_api::redeem(&engine.link()).await.unwrap();
        let mut app = on(s);
        let fx = open(&mut app);
        assert!(
            fx.iter().any(|e| matches!(e, Effect::Act { .. })),
            "{what}: {fx:?}"
        );
        pump(&mut app, &client, fx).await;
        assert_eq!(status(&app), Some((Tone::Refused, NO.into())), "{what}");
        assert!(
            !status(&app).unwrap().1.starts_with(success),
            "{what}: said success"
        );
    }
}

/// Accept and Send back, refused: the console's words, never "Accepted" or "Sent back".
#[tokio::test(flavor = "multi_thread")]
async fn a_refused_accept_or_send_back_says_the_consoles_words() {
    for what in ["accept", "send back"] {
        let engine = fake::FakeEngine::start(fake::scenario(), 0).await;
        let client = toolroll_api::redeem(&engine.link()).await.unwrap();
        let mut app = App::new(false, None);
        app.syntax_on = false;
        pump(&mut app, &client, vec![Effect::FetchWork]).await;
        let fx = app.key(key('j'));
        pump(&mut app, &client, fx).await;
        let fx = app.key(code(KeyCode::Enter));
        pump(&mut app, &client, fx).await;
        assert_eq!(app.tab, Tab::Diff);
        engine.state.lock().unwrap().refuse_acts = Some((409, NO.into()));
        let fx = if what == "accept" {
            app.key(key('a'));
            screen(&mut app, 120, 34);
            app.key(code(KeyCode::Enter))
        } else {
            app.key(key('r'));
            for c in "use cents".chars() {
                app.key(key(c));
            }
            app.key(code(KeyCode::Enter));
            for _ in 0..40 {
                if matches!(app.mode, Mode::SendReview { seen_end: true, .. }) {
                    break;
                }
                app.key(key(' '));
                screen(&mut app, 120, 34);
            }
            app.key(code(KeyCode::Enter))
        };
        assert!(!fx.is_empty(), "{what}: nothing sent");
        pump(&mut app, &client, fx).await;
        let (tone, words) = status(&app).unwrap();
        assert_eq!(tone, Tone::Refused, "{what}: {words}");
        assert!(words.contains(NO), "{what}: {words}");
        assert!(
            !words.starts_with("Accepted") && !words.starts_with("Sent back"),
            "{what}: {words}"
        );
    }
}

// ---- 2 and 5. a newly filed task is selected; its status line goes once it fails, no key pressed --------------------

/// t-new, filed by Build: listed, building, then failed.
fn new_row(word: &str, tone: &str, group: &str) -> Value {
    let work = fake::scenario_work();
    let mut row = work["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == "t-live")
        .unwrap()
        .clone();
    row["id"] = json!("t-new");
    row["title"] = json!("Add a divide function");
    row["href"] = json!("/t/t-new");
    row["status"]["label"] = json!(word);
    row["status"]["tone"] = json!(tone);
    row["status"]["token"] = json!(format!("assignment-{group}"));
    row["word"] = json!({ "word": word, "tone": if tone == "problem" { "failed" } else { tone } });
    if tone == "problem" {
        row["rank"] = json!(0);
    }
    row
}
fn work_with(row: Value) -> Value {
    let mut w = fake::scenario_work();
    w["rows"].as_array_mut().unwrap().push(row);
    w
}
fn new_steps(state: &str) -> Value {
    let live = (state == "running").then_some(44);
    let mut s = fake::steps_for("t-new", "Add a divide function", live, None);
    s["task"]["state"] = json!(state);
    for card in s["cards"].as_array_mut().unwrap() {
        if card["key"] == "build" {
            card["runs"] = json!([44]);
            if state == "failed" {
                card["state"] = json!("stuck");
                card["mark"] = json!("stuck");
                card["sentence"] = json!("The agent stopped with an error");
            }
        }
    }
    s
}

#[tokio::test(flavor = "multi_thread")]
async fn a_filed_task_is_selected_and_its_status_goes_once_it_fails_with_no_key() {
    let mut state = fake::scenario();
    state.work = work_with(new_row("Building", "live", "building"));
    state.steps.insert("t-new".into(), new_steps("running"));
    let engine = fake::FakeEngine::start(state, 0).await;
    let client = toolroll_api::redeem(&engine.link()).await.unwrap();
    let mut app = App::new(false, None);
    app.syntax_on = false;
    pump(&mut app, &client, vec![Effect::FetchWork]).await;
    let before = app.selected_item().unwrap().id.clone();
    assert_ne!(before, "t-new");
    // Build's terms, read to the end, then Enter: the console files it and answers with its page.
    app.mode = Mode::Build {
        title: "Add a divide function".into(),
        preview: "p1".into(),
        digest: "d".repeat(64),
        terms: vec![("Agent".into(), "claude haiku".into())],
        scroll: 0,
        seen_end: true,
    };
    let fx = app.key(code(KeyCode::Enter));
    pump(&mut app, &client, fx).await;
    // Selected and shown: its detail read.
    assert_eq!(app.selected_item().unwrap().id, "t-new");
    assert_eq!(app.steps_here().map(|s| s.task.id.as_str()), Some("t-new"));
    assert_eq!(status(&app), Some((Tone::Said, "Building it.".into())));
    let shown = screen(&mut app, 160, 34);
    assert!(shown.contains("Add a divide function"), "{shown}");
    assert!(shown.contains("attempt 1"), "{shown}");
    // It fails in the console. No key is pressed; the next reads (the poll's own) find it failed, and the line goes.
    {
        let mut st = engine.state.lock().unwrap();
        st.work = work_with(new_row("Failed", "problem", "failed"));
        st.steps.insert("t-new".into(), new_steps("failed"));
    }
    app.said_at = Some(std::time::Instant::now() - STATUS_HOLD);
    pump(
        &mut app,
        &client,
        vec![Effect::FetchWork, Effect::FetchSteps("t-new".into())],
    )
    .await;
    assert_eq!(app.steps_here().unwrap().task.state, "failed");
    assert_eq!(status(&app), None, "a stale 'Building it.' stayed");
    assert!(!screen(&mut app, 160, 34).contains("Building it."));
}

#[test]
fn a_filed_task_listed_later_is_selected_then() {
    let mut app = app_on(fake::scenario_work());
    // The task selected before has its steps on screen.
    let here = app.selected_item().unwrap().id.clone();
    app.update(Msg::Steps(
        here.clone(),
        Ok(parse(fake::steps_for(&here, "Before", None, None))),
    ));
    assert!(app.steps.is_some());
    let fx = app.update(Msg::Acted(Ok(ActOutcome::Filed {
        words: "Filed.".into(),
        task: "t-new".into(),
    })));
    assert!(fx.contains(&Effect::FetchWork), "{fx:?}");
    // Not listed yet: nothing moves.
    let first = app.selected_item().unwrap().id.clone();
    app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    assert_eq!(app.selected_item().unwrap().id, first);
    // Listed: selected, and its steps asked for.
    let fx = app.update(Msg::Work(Ok(parse(work_with(new_row(
        "Building", "live", "building",
    ))))));
    assert_eq!(app.selected_item().unwrap().id, "t-new");
    assert!(fx.contains(&Effect::FetchSteps("t-new".into())), "{fx:?}");
    // A selection like any other: the old task's steps let go, its rooms left.
    assert!(app.steps.is_none(), "the old task's steps stayed");
    assert!(fx.contains(&Effect::Watch(vec![])), "{fx:?}");
}

// ---- 3 and 4. the waiting header; attempt numbers ------------------------------------------------------------------

#[test]
fn waiting_names_the_attempt_it_follows_never_a_waiting_build() {
    let mut app = on(waiting_steps());
    let shown = screen(&mut app, 160, 34);
    assert!(
        shown.contains("Waiting to retry · 40s · after attempt 3"),
        "{shown}"
    );
    for never in ["Waiting to start", "build #9", "before)"] {
        assert!(!shown.contains(never), "{never}\n{shown}");
    }
    insta::assert_snapshot!("waiting_header", screen(&mut app, 120, 30));
}

#[test]
fn attempt_numbers_are_the_tasks_own_everywhere_a_person_reads() {
    // Failed: the header, the retry confirm and its toast.
    let mut app = on(failed_steps(2));
    let shown = screen(&mut app, 160, 34);
    assert!(shown.contains("1m 00s · attempt 3"), "{shown}");
    app.key(key('r'));
    let shown = screen(&mut app, 120, 34);
    assert!(
        shown.contains("Retry: starts a new attempt after attempt 3."),
        "{shown}"
    );
    let fx = app.key(code(KeyCode::Enter));
    assert!(
        matches!(&fx[..], [Effect::Act { done, .. }] if done == "Retrying: a new attempt starts after attempt 3."),
        "{fx:?}"
    );
    // The cancel confirm.
    let mut app = on(failed_steps(1));
    app.key(key('X'));
    let shown = screen(&mut app, 120, 30);
    assert!(
        shown.contains("It failed · its latest is attempt 3."),
        "{shown}"
    );
    assert!(!shown.contains("It is failed"), "{shown}");
    // The global build id only in Steps details.
    let mut app = on(failed_steps(1));
    app.tab = Tab::Steps;
    let shown = screen(&mut app, 160, 34);
    assert!(shown.contains("attempt 3 (build #9)"), "{shown}");
    let header = shown.lines().take(8).collect::<Vec<_>>().join("\n");
    assert!(!header.contains("build #"), "{header}");
    // A task's first build is attempt 1, whatever its console id.
    let mut s = steps("failed");
    s["cards"].as_array_mut().unwrap().iter_mut().for_each(|c| {
        if c["key"] == "build" {
            c["runs"] = json!([4]);
        }
    });
    let mut app = on(s);
    assert!(screen(&mut app, 160, 34).contains("attempt 1"));
    assert_eq!(app.attempt_words(4), "attempt 1");
}

// ---- 6. wording ----------------------------------------------------------------------------------------------------

#[test]
fn on_hold_steps_say_on_hold_with_its_clock() {
    let mut app = on(held_steps());
    app.tab = Tab::Steps;
    let shown = screen(&mut app, 160, 34);
    assert!(shown.contains("on hold · 40s"), "{shown}");
    assert!(!shown.contains("waiting · "), "{shown}");
    // The card's "Stopped" isn't said over it.
    let build = shown
        .lines()
        .skip_while(|l| !l.contains("○ Build") && !l.contains("Build    "))
        .take(2)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!build.contains("Stopped"), "{build}");
    let header = shown.lines().nth(6).unwrap_or_default();
    assert!(
        header.contains("On hold · 40s · after attempt 3"),
        "{shown}"
    );
    insta::assert_snapshot!("held_steps", screen(&mut app, 120, 30));
}

#[test]
fn repeated_failures_only_when_there_were() {
    for (n, said) in [(1, false), (2, true)] {
        let mut app = on(failed_steps(n));
        app.key(key('r'));
        let shown = screen(&mut app, 120, 34);
        assert_eq!(
            shown.contains("repeated failures"),
            said,
            "{n} in a row\n{shown}"
        );
    }
}
