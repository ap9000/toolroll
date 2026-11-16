//! The stranger test's third round (0.9.112): Stop retrying shows it worked and can be resumed; one build number and
//! one clock on a screen; a status line about an old state goes; the cancel dialog says the real state; a cancelled
//! task keeps its history; an agent's error shows on Live; what the agent said shows while it waits.
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use serde_json::{json, Value};
use toolroll_api::*;
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, Effect, Mode, Msg, HOLD_REASON, NOTHING_CHANGED, STATUS_HOLD};

/// 2026-11-14T12:04:12Z.
const NOW: i64 = 1_794_657_852;

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
fn status(app: &App) -> String {
    app.status
        .as_ref()
        .map(|(_, w)| w.clone())
        .unwrap_or_default()
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

/// t-retry's steps: queued; its build #9 (after #5 and #3) started 12:02:32 and stopped 12:03:32.
fn steps(state: &str) -> Value {
    let mut s = fake::steps_for("t-retry", "Rename the config loader", None, None);
    s["task"]["state"] = json!(state);
    for card in s["cards"].as_array_mut().unwrap() {
        if card["key"] == "build" {
            card["state"] = json!(if state == "failed" { "stuck" } else { "todo" });
            card["mark"] = json!(if state == "failed" { "stuck" } else { "todo" });
            card["sentence"] = json!("Stopped");
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
    s["waiting"] = json!({ "retryAt": "2026-11-14T12:05:52.000Z", "lastFailure": "The agent stopped with an error",
        "agentSaid": ["TypeError: subtract is not a function", "Stopping here."] });
    s
}
fn held_steps(hold: i64) -> Value {
    let mut s = steps("queued");
    s["held"] = json!({ "id": hold, "reason": HOLD_REASON, "lastFailure": "The agent stopped with an error" });
    s
}
fn on(steps: Value) -> App {
    let mut app = app_on(fake::fixture("work-rows-every-kind.json"));
    select(&mut app, "t-retry");
    app.update(Msg::Steps("t-retry".into(), Ok(parse(steps))));
    app
}

// ---- 1. stop retrying shows it worked ------------------------------------------------------------------------------

#[test]
fn stop_retrying_stops_the_countdown_at_once() {
    let mut app = on(waiting_steps());
    assert!(screen(&mut app, 160, 34).contains("next try in 1m 40s"));
    app.key(key('x'));
    let fx = app.key(code(KeyCode::Enter));
    assert!(
        matches!(&fx[..], [Effect::Act { path, .. }] if path == "/t/t-retry/hold"),
        "{fx:?}"
    );
    // No next try is coming: gone from the panel and the list before the console answers.
    let shown = screen(&mut app, 160, 34);
    assert!(!shown.contains("next try"), "{shown}");
    // The answer reads the task again (and its steps) at once, never waiting for the poll.
    let fx = app.update(Msg::Acted(Ok(ActOutcome::Done("Stopped retrying.".into()))));
    assert!(fx.contains(&Effect::FetchSteps("t-retry".into())), "{fx:?}");
    assert!(fx.contains(&Effect::FetchWork), "{fx:?}");
}

#[test]
fn a_held_task_says_so_and_offers_resume_never_a_next_try() {
    let mut app = on(held_steps(41));
    let shown = screen(&mut app, 160, 34);
    for words in [
        "On hold · you stopped retrying",
        "Last build failed · The agent stopped with an error",
        "x  Resume retrying",
    ] {
        assert!(shown.contains(words), "{words}\n{shown}");
    }
    for never in [
        "next try",
        "Stop retrying",
        "when a builder is free",
        "stop retrying",
    ] {
        assert!(!shown.contains(never), "{never}\n{shown}");
    }
    let bar = shown.lines().last().unwrap().to_string();
    assert!(bar.contains("x resume"), "{bar}");
    insta::assert_snapshot!("held_live", screen(&mut app, 120, 30));
    app.key(code(KeyCode::Tab));
    let shown = screen(&mut app, 160, 34);
    assert!(
        shown.contains("On hold · you stopped retrying") && !shown.contains("next try"),
        "{shown}"
    );
}

// ---- 2. resume -----------------------------------------------------------------------------------------------------

#[test]
fn x_on_a_held_task_resumes_the_hold_shown_after_a_confirm() {
    let mut app = on(held_steps(41));
    assert_eq!(app.key(key('x')), vec![]);
    assert!(
        matches!(&app.mode, Mode::ConfirmResume { hold: 41, .. }),
        "{:?}",
        app.mode
    );
    insta::assert_snapshot!("resume_confirm", screen(&mut app, 120, 30));
    assert_eq!(
        app.key(code(KeyCode::Enter)),
        vec![Effect::Act {
            path: "/t/t-retry/unhold".into(),
            fields: vec![("hold".into(), "41".into())],
            done: "Resumed: it tries again when a builder is free.".into(),
        }]
    );
    // Esc says what is true.
    app.key(key('x'));
    assert_eq!(app.key(code(KeyCode::Esc)), vec![]);
    assert_eq!(status(&app), NOTHING_CHANGED);
    // A hold that changed under the dialog isn't released.
    app.key(key('x'));
    app.update(Msg::Steps("t-retry".into(), Ok(parse(held_steps(42)))));
    assert_eq!(app.key(code(KeyCode::Enter)), vec![]);
    assert!(status(&app).contains("changed"), "{}", status(&app));
    // The palette has it.
    let found = toolroll_tui::palette::matches(&app, "resume");
    assert!(
        found[0].label.starts_with("Resume retrying"),
        "{}",
        found[0].label
    );
    // Esc on Stop retrying and Cancel says the same plain truth.
    let mut app = on(waiting_steps());
    for k in ['x', 'X'] {
        app.key(key(k));
        app.key(code(KeyCode::Esc));
        assert_eq!(status(&app), NOTHING_CHANGED);
    }
}

// ---- 3. one build number, one clock --------------------------------------------------------------------------------

#[test]
fn the_confirm_the_toast_the_header_and_steps_name_one_build() {
    let mut s = steps("failed");
    s["failure"] = json!({ "line": "The agent stopped with an error.", "failedInARow": 2, "suggestion": null, "agentSaid": null });
    // (The pin is the console's own fact; what every line names is the current build, #9.)
    s["retry"] = json!({ "run": 5, "digest": "d".repeat(64) });
    let mut app = on(s);
    let shown = screen(&mut app, 160, 34);
    // Failed: how long that build ran (12:02:32 to 12:03:32), its number, and "failed" (never "stuck").
    assert!(shown.contains("1m 00s · attempt 3"), "{shown}");
    app.key(code(KeyCode::Tab));
    let steps_tab = screen(&mut app, 160, 34);
    assert!(steps_tab.contains("failed · 1m 00s"), "{steps_tab}");
    assert!(!steps_tab.contains("stuck"), "{steps_tab}");
    app.key(key('r'));
    assert!(screen(&mut app, 120, 34).contains("Retry: starts a new attempt after attempt 3."));
    let fx = app.key(code(KeyCode::Enter));
    assert!(
        matches!(&fx[..], [Effect::Act { done, .. }] if done == "Retrying: a new attempt starts after attempt 3."),
        "{fx:?}"
    );
    // Waiting: since that build stopped (12:03:32), in the header and in Steps alike.
    let mut app = on(waiting_steps());
    let shown = screen(&mut app, 160, 34);
    assert!(
        shown.contains("Waiting to retry · 40s · after attempt 3"),
        "{shown}"
    );
    app.key(code(KeyCode::Tab));
    assert!(screen(&mut app, 160, 34).contains("· 40s"));
}

// ---- 4. a status line about an old state goes ----------------------------------------------------------------------

#[test]
fn building_it_goes_once_the_task_has_failed() {
    let mut app = on(steps("running"));
    app.update(Msg::Acted(Ok(ActOutcome::Done("Building it.".into()))));
    assert_eq!(status(&app), "Building it.");
    // Said just now (no key since): held a moment, even when the task moves.
    let mut failed = steps("failed");
    failed["failure"] = json!({ "line": "The agent stopped with an error.", "failedInARow": 1, "suggestion": null, "agentSaid": null });
    app.update(Msg::Steps("t-retry".into(), Ok(parse(failed.clone()))));
    assert_eq!(status(&app), "Building it.");
    // Once the hold is over, the next read of the moved task clears it.
    app.said_at = Some(std::time::Instant::now() - STATUS_HOLD);
    app.update(Msg::Steps("t-retry".into(), Ok(parse(failed.clone()))));
    assert_eq!(status(&app), "");
    // Words about the state it is still in stay.
    app.update(Msg::Acted(Ok(ActOutcome::Done(
        "Opened in your browser.".into(),
    ))));
    app.said_at = Some(std::time::Instant::now() - STATUS_HOLD);
    app.update(Msg::Steps("t-retry".into(), Ok(parse(failed))));
    assert_eq!(status(&app), "Opened in your browser.");
}

// ---- 5. the cancel dialog's facts ----------------------------------------------------------------------------------

#[test]
fn cancel_says_the_real_state_and_build() {
    for (steps, words) in [
        (held_steps(41), "It is on hold · its latest is attempt 3."),
        (
            waiting_steps(),
            "It is waiting to retry · its latest is attempt 3.",
        ),
        (steps("queued"), "It is queued · its latest is attempt 3."),
    ] {
        let mut app = on(steps);
        app.key(key('X'));
        let shown = screen(&mut app, 120, 30);
        assert!(shown.contains(words), "{words}\n{shown}");
    }
}

// ---- 6. a cancelled task keeps its history -------------------------------------------------------------------------

#[test]
fn a_cancelled_task_keeps_its_builds_and_ends_cancelled() {
    let mut work = fake::fixture("work-rows-every-kind.json");
    work["rows"][4]["status"]["label"] = json!("Cancelled");
    work["rows"][4]["word"]["word"] = json!("Stopped");
    let mut app = app_on(work);
    select(&mut app, "t-cancelled");
    let mut s = fake::steps_for("t-cancelled", "Try a new logger", None, None);
    s["task"]["state"] = json!("cancelled");
    s["headline"] = json!("Cancelled");
    s["cards"] = json!([
        { "key": "build", "label": "Build", "state": "stuck", "mark": "stuck", "sentence": "The agent stopped with an error",
          "at": "2026-11-14T12:03:32.000Z", "needsYou": false, "inChain": true, "agent": { "provider": "claude", "model": "haiku" },
          "startedAt": "2026-11-14T11:30:00.000Z", "latestStartedAt": "2026-11-14T12:02:32.000Z", "finishedAt": "2026-11-14T12:03:32.000Z",
          "costUsd": null, "runs": [9, 5] },
        { "key": "ready", "label": "Cancelled", "state": "skipped", "mark": "skipped", "sentence": "Cancelled: nothing else will run for this task.",
          "at": "2026-11-14T12:04:00.000Z", "needsYou": false, "inChain": true, "agent": null, "startedAt": null, "latestStartedAt": null,
          "finishedAt": null, "costUsd": null, "runs": [] }
    ]);
    app.update(Msg::Steps("t-cancelled".into(), Ok(parse(s))));
    app.key(code(KeyCode::Tab));
    let shown = screen(&mut app, 160, 34);
    assert!(
        shown.contains("Cancelled") && !shown.contains("Stopped"),
        "{shown}"
    );
    assert!(shown.contains("attempt 2 (build #9)"), "{shown}");
    assert!(
        shown.contains("Cancelled: nothing else will run for this task."),
        "{shown}"
    );
    // Its failed build reads failed, never stuck.
    assert!(
        shown.contains("failed · 1m 00s") && !shown.contains("stuck"),
        "{shown}"
    );
    assert!(!shown.contains("has no steps"), "{shown}");
    insta::assert_snapshot!("cancelled_steps", screen(&mut app, 120, 30));
}

// ---- 7/8. the agent's words on Live, and while waiting -------------------------------------------------------------

#[test]
fn an_agent_error_shows_on_live_above_its_output() {
    let mut s = steps("failed");
    s["failure"] = json!({ "line": "The agent stopped with an error.", "failedInARow": 1, "suggestion": null,
        "agentSaid": ["TypeError: subtract is not a function"] });
    let mut app = on(s);
    let window = json!({ "version": 1, "session": { "kind": "run", "id": 9, "task": "t-retry" }, "room": "agent:9", "live": false, "file": "main",
        "window": { "ok": true, "records": [{ "k": "start", "at": "2026-11-14T12:02:32.000Z" }], "cursor": "c1",
        "restarted": false, "earlier": false, "quarantined": 0, "skipped": 0, "more": false } });
    app.update(Msg::Live(9, "main", Ok(parse(window))));
    let shown = screen(&mut app, 160, 34);
    assert!(shown.contains("The agent stopped with an error"), "{shown}");
    assert!(
        shown.contains("What the agent said")
            && shown.contains("TypeError: subtract is not a function"),
        "{shown}"
    );
    // Its output still under it.
    assert!(shown.contains("Started."), "{shown}");
    insta::assert_snapshot!("agent_error_live", screen(&mut app, 120, 30));
}

#[test]
fn what_the_agent_said_shows_while_it_waits() {
    let mut app = on(waiting_steps());
    app.key(code(KeyCode::Tab));
    let shown = screen(&mut app, 160, 40);
    assert!(
        shown.contains("What the agent said")
            && shown.contains("TypeError: subtract is not a function"),
        "{shown}"
    );
}
