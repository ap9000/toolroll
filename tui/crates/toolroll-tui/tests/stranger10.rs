//! The stranger test's tenth round (0.9.114): a sent-back task whose revision's plan failed its checks was a dead end in
//! the terminal (Failed above "x stop retrying"; r "No result is waiting for you"; the palette's Retry "Only a failed task
//! can be retried here"), and every act aimed at the row's root, not the revision its steps read. Now a stopped plan
//! says why and offers Plan again (r); p asks for a plan on a task filed without one; every act posts to the version the
//! steps read, and a dialog frozen on one version refuses once a newer one is shown, never moving to it on its own.
#[path = "common/pairs.rs"]
mod pairs;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use serde_json::{json, Value};
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, Effect, Mode, Msg, RESULT_CHANGED, TASK_CHANGED};

/// 2026-11-14T12:04:12Z.
const NOW: i64 = 1_794_657_852;
const SOURCE: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

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
    pairs::check(app, w, h);
    term.backend().to_string()
}
fn status(app: &App) -> String {
    app.status
        .as_ref()
        .map(|(_, w)| w.clone())
        .unwrap_or_default()
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
/// t-retry's steps as its version `version` reads them (a revision has its own id; the row keeps the root's).
fn steps(version: &str, state: &str) -> Value {
    let mut s = fake::steps_for("t-retry", "Rename the config loader", None, None);
    s["task"]["id"] = json!(version);
    s["task"]["root"] = json!("t-retry");
    s["task"]["state"] = json!(state);
    s
}
/// A revision whose plan failed its checks: queued under an incident (no backoff), its problems and what the agent said.
fn stopped(version: &str) -> Value {
    let mut s = steps(version, "queued");
    s["planStopped"] = json!({ "incident": 7, "kind": "plan", "line": "The plan didn't pass its checks.",
        "problems": ["plan must start with ## Approach", "plan: Proof must name acceptance criterion c1"],
        "agentSaid": ["Wrote the plan to [path]"], "again": { "source": SOURCE } });
    s
}
fn on(steps: Value) -> App {
    let mut app = App::new(false, Some("/work/proj".into()));
    app.now = NOW;
    app.update(Msg::Work(Ok(parse(fake::fixture(
        "work-rows-every-kind.json",
    )))));
    select(&mut app, "t-retry");
    app.update(Msg::Steps("t-retry".into(), Ok(parse(steps))));
    app
}

#[test]
fn a_stopped_plan_says_why_and_r_plans_again_on_the_revision() {
    let mut app = on(stopped("t-retry-v2"));
    let shown = screen(&mut app, 160, 40);
    for words in [
        "Plan didn't pass",
        "The plan didn't pass its checks.",
        "Why the plan was refused",
        "plan must start with ## Approach",
        "Proof must name acceptance criterion c1",
        "What the agent said",
        "Wrote the plan to [path]",
    ] {
        assert!(shown.contains(words), "{words}\n{shown}");
    }
    let bar = shown.lines().last().unwrap().to_string();
    assert!(bar.contains("r plan again"), "{bar}");
    assert!(
        !shown.contains("stop retrying") && !shown.contains("no reason was recorded"),
        "{shown}"
    );
    // x has nothing to stop: a stopped plan isn't retrying.
    assert_eq!(app.key(key('x')), vec![]);
    assert!(
        !matches!(app.mode, Mode::ConfirmHold { .. }),
        "{:?}",
        app.mode
    );
    // r opens Plan again on the revision the steps read, and Enter posts exactly its incident and source there.
    assert_eq!(app.key(key('r')), vec![]);
    assert!(
        matches!(&app.mode, Mode::ConfirmPlanAgain { version, incident: 7, .. } if version == "t-retry-v2"),
        "{:?}",
        app.mode
    );
    let shown = screen(&mut app, 120, 30);
    assert!(
        shown.contains("Plan again?") && shown.contains("before anything is built."),
        "{shown}"
    );
    assert_eq!(
        app.key(code(KeyCode::Enter)),
        vec![Effect::Act {
            path: "/t/t-retry-v2/plan".into(),
            fields: vec![
                ("incident".into(), "7".into()),
                ("source".into(), SOURCE.into())
            ],
            done: "Planning again. You approve the plan before anything is built.".into(),
        }]
    );
}

#[test]
fn p_asks_for_a_plan_on_a_task_filed_without_one() {
    let mut s = steps("t-retry", "queued");
    s["plan"] = json!({ "source": SOURCE });
    let mut app = on(s);
    let bar = screen(&mut app, 160, 34)
        .lines()
        .last()
        .unwrap()
        .to_string();
    assert!(bar.contains("p plan"), "{bar}");
    assert_eq!(app.key(key('p')), vec![]);
    assert!(
        matches!(&app.mode, Mode::ConfirmPlan { .. }),
        "{:?}",
        app.mode
    );
    assert!(screen(&mut app, 120, 30).contains("Ask for a plan?"));
    assert_eq!(
        app.key(code(KeyCode::Enter)),
        vec![Effect::Act {
            path: "/t/t-retry/plan".into(),
            fields: vec![("source".into(), SOURCE.into())],
            done: "Asked for a plan. You approve the plan before anything is built.".into(),
        }]
    );
    // With no plan to ask for and nothing building, p still says there's nothing to pause.
    let mut app = on(steps("t-retry", "queued"));
    assert_eq!(app.key(key('p')), vec![]);
    assert!(
        status(&app).contains("Nothing is building on this task to pause."),
        "{}",
        status(&app)
    );
}

#[test]
fn a_planners_backoff_names_the_plan_attempt_and_what_the_agent_said() {
    let mut s = steps("t-retry", "queued");
    s["waiting"] = json!({ "retryAt": "2026-11-14T12:04:52.000Z", "lastFailure": "The agent stopped with an error",
        "attempt": "plan", "agentSaid": ["claude: refusing to plan"] });
    let mut app = on(s);
    let shown = screen(&mut app, 160, 34);
    for words in [
        "Last plan attempt failed · The agent stopped with an error · next try in 40s",
        "What the agent said",
        "claude: refusing to plan",
    ] {
        assert!(shown.contains(words), "{words}\n{shown}");
    }
    assert!(!shown.contains("Last build failed"), "{shown}");
}

#[test]
fn every_act_posts_to_the_version_the_steps_read() {
    let mut s = steps("t-retry-v2", "queued");
    s["waiting"] = json!({ "retryAt": "2026-11-14T12:05:52.000Z", "lastFailure": "The agent stopped with an error", "attempt": "build", "agentSaid": null });
    let mut app = on(s);
    app.key(key('x'));
    assert!(
        matches!(&app.mode, Mode::ConfirmHold { version, .. } if version == "t-retry-v2"),
        "{:?}",
        app.mode
    );
    screen(&mut app, 120, 30);
    let fx = app.key(code(KeyCode::Enter));
    assert!(
        matches!(&fx[..], [Effect::Act { path, .. }] if path == "/t/t-retry-v2/hold"),
        "{fx:?}"
    );
    app.key(key('X'));
    assert!(
        matches!(&app.mode, Mode::ConfirmCancel { version, .. } if version == "t-retry-v2"),
        "{:?} {}",
        app.mode,
        status(&app)
    );
    screen(&mut app, 120, 30);
    let fx = app.key(code(KeyCode::Enter));
    assert!(
        matches!(&fx[..], [Effect::Act { path, .. }] if path == "/t/t-retry-v2/cancel"),
        "{fx:?}"
    );
}

#[test]
fn a_dialog_frozen_on_one_version_refuses_once_a_newer_one_is_shown() {
    // Plan again opened on v2; a revision v3 is filed and read before Enter: closed, nothing sent.
    let mut app = on(stopped("t-retry-v2"));
    app.key(key('r'));
    assert!(matches!(app.mode, Mode::ConfirmPlanAgain { .. }));
    screen(&mut app, 120, 30);
    app.update(Msg::Steps(
        "t-retry".into(),
        Ok(parse(stopped("t-retry-v3"))),
    ));
    assert_eq!(app.mode, Mode::Normal);
    assert_eq!(status(&app), TASK_CHANGED);
    // Stop retrying the same way.
    let mut waiting = steps("t-retry-v2", "queued");
    waiting["waiting"] = json!({ "retryAt": "2026-11-14T12:05:52.000Z", "lastFailure": null, "attempt": "build", "agentSaid": null });
    let mut app = on(waiting.clone());
    app.key(key('x'));
    assert!(matches!(app.mode, Mode::ConfirmHold { .. }));
    let mut newer = waiting.clone();
    newer["task"]["id"] = json!("t-retry-v3");
    app.update(Msg::Steps("t-retry".into(), Ok(parse(newer))));
    assert_eq!(app.mode, Mode::Normal);
    assert_eq!(status(&app), TASK_CHANGED);
    // Send back on v2's result; v3's steps (even with the same result) close it: a result is its own version's.
    let mut review = fake::steps_for("t-retry", "Rename the config loader", None, Some(9));
    review["task"]["id"] = json!("t-retry-v2");
    review["task"]["root"] = json!("t-retry");
    let mut app = on(review.clone());
    app.key(key('r'));
    assert!(
        matches!(&app.mode, Mode::SendBack(pin, _) if pin.version == "t-retry-v2"),
        "{:?}",
        app.mode
    );
    let mut moved = review.clone();
    moved["task"]["id"] = json!("t-retry-v3");
    app.update(Msg::Steps("t-retry".into(), Ok(parse(moved))));
    assert_eq!(app.mode, Mode::Normal);
    assert_eq!(status(&app), RESULT_CHANGED);
}

#[test]
fn an_added_file_shown_whole_draws_no_more_lines_below() {
    use std::collections::BTreeMap;
    use toolroll_tui::review::{layout, Item};
    let file = |line_count: Option<i64>| -> toolroll_api::ResultDiffFile {
        parse(
            json!({ "version": 1, "task": "t-retry", "run": 9, "linesTruncated": false,
            "file": { "file": 0, "path": "notes.md", "oldPath": null, "meta": ["new file mode 100644"], "lineCount": line_count,
                "hunks": [{ "header": "@@ -0,0 +1,2 @@", "lines": [
                    { "kind": "addition", "text": "one", "oldLine": null, "newLine": 1 },
                    { "kind": "addition", "text": "two", "oldLine": null, "newLine": 2 }] }] } }),
        )
    };
    let gaps = |f: &toolroll_api::ResultDiffFile| {
        layout(f, &BTreeMap::new(), f.file.line_count)
            .items
            .iter()
            .filter(|i| matches!(i, Item::Gap { .. }))
            .count()
    };
    // The patch says the whole file (2 lines): nothing hidden after it.
    assert_eq!(gaps(&file(Some(2))), 0);
    // Not known (a changed file): the marker stays, as before.
    assert_eq!(gaps(&file(None)), 1);
}
