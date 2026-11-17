//! The stranger test's second round (0.9.111): a waiting or retrying task can be stopped or cancelled, its wait is
//! explained from the engine's own due time, what the agent said is shown, build numbers and durations are the current
//! build's, the Build card folds its usual settings, the palette matches words, and the new-thread composer says where.
#[path = "common/pairs.rs"]
mod pairs;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use serde_json::{json, Value};
use toolroll_api::*;
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, Effect, Mode, Msg};
use toolroll_tui::keys::{parse_chord, Keymap, Preset, HELP_EXAMPLE, SPECS};
use toolroll_tui::palette::score;

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
    pairs::check(app, w, h);
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

/// t-retry's steps: queued, its third build failed 40 s ago, the next try due in 1m 40s.
fn waiting_steps() -> Value {
    let mut s = fake::steps_for("t-retry", "Rename the config loader", None, None);
    s["task"]["state"] = json!("queued");
    s["headline"] = json!("Waiting");
    for card in s["cards"].as_array_mut().unwrap() {
        if card["key"] == "build" {
            card["state"] = json!("todo");
            card["mark"] = json!("todo");
            card["sentence"] = json!("Waiting to start");
            card["startedAt"] = json!("2026-11-14T11:30:00.000Z");
            card["latestStartedAt"] = json!("2026-11-14T12:02:32.000Z");
            card["finishedAt"] = json!("2026-11-14T12:03:32.000Z");
            card["runs"] = json!([9, 5, 3]);
        }
    }
    s["waiting"] = json!({ "retryAt": "2026-11-14T12:05:52.000Z", "lastFailure": "The agent stopped with an error" });
    s
}
fn waiting_app() -> App {
    let mut app = app_on(fake::fixture("work-rows-every-kind.json"));
    select(&mut app, "t-retry");
    app.update(Msg::Steps("t-retry".into(), Ok(parse(waiting_steps()))));
    app
}

// ---- 1. stop retrying, cancel -------------------------------------------------------------------------------------

#[test]
fn x_on_a_waiting_task_stops_retrying_after_a_confirm() {
    let mut app = waiting_app();
    assert_eq!(app.key(key('x')), vec![]);
    assert!(
        matches!(&app.mode, Mode::ConfirmHold { task } if task == "t-retry"),
        "{:?}",
        app.mode
    );
    let shown = screen(&mut app, 120, 30);
    assert!(shown.contains("Stop retrying this task?"), "{shown}");
    insta::assert_snapshot!("stop_retrying_confirm", shown);
    assert_eq!(
        app.key(code(KeyCode::Enter)),
        vec![Effect::Act {
            path: "/t/t-retry/hold".into(),
            fields: vec![("reason".into(), "stopped retrying from the terminal".into())],
            done: "Stopped retrying: it stays, and nothing more runs until you resume it.".into(),
        }]
    );
    // Any other key keeps it retrying.
    app.key(key('x'));
    assert_eq!(app.key(key('q')), vec![]);
    assert_eq!(status(&app), "Nothing changed.");
}

#[test]
fn cancel_asks_first_and_posts_the_state_and_build_shown() {
    let mut app = waiting_app();
    assert_eq!(app.key(key('X')), vec![]);
    let Mode::ConfirmCancel { state, run, .. } = &app.mode else {
        panic!("{:?}", app.mode)
    };
    assert_eq!((state.as_str(), *run), ("queued", Some(9)));
    let shown = screen(&mut app, 120, 30);
    assert!(
        shown.contains("Cancel “Rename the config loader”?"),
        "{shown}"
    );
    assert!(shown.contains("its latest is attempt "), "{shown}");
    insta::assert_snapshot!("cancel_confirm", shown);
    assert_eq!(
        app.key(code(KeyCode::Enter)),
        vec![Effect::Act {
            path: "/t/t-retry/cancel".into(),
            fields: vec![
                ("state".into(), "queued".into()),
                ("run".into(), "9".into())
            ],
            done: "Cancelled: nothing else will run for this task.".into(),
        }]
    );
    // What changed under the dialog is never cancelled.
    app.key(key('X'));
    let mut moved = waiting_steps();
    moved["task"]["state"] = json!("running");
    moved["liveRun"] = json!(11);
    app.update(Msg::Steps("t-retry".into(), Ok(parse(moved))));
    assert_eq!(app.key(code(KeyCode::Enter)), vec![]);
    assert!(status(&app).contains("changed"), "{}", status(&app));
    // And it is in the palette.
    app.key(key(':'));
    for c in "cancel".chars() {
        app.key(key(c));
    }
    let found = toolroll_tui::palette::matches(&app, "cancel");
    assert_eq!(found[0].label, "Cancel task (asks first)");
}

// ---- 2. the retry wait explained -----------------------------------------------------------------------------------

#[test]
fn a_waiting_task_says_why_and_when_in_the_list_live_and_steps() {
    let mut app = waiting_app();
    let line = "Last build failed · The agent stopped with an error · next try in 1m 40s";
    let wide = screen(&mut app, 200, 40);
    assert!(wide.contains(line), "{wide}");
    let shown = screen(&mut app, 120, 30);
    // The list: one steady word, and the reason and due time under the card.
    assert!(
        shown.contains("Waiting") && shown.contains("next try in 1m 40s"),
        "{shown}"
    );
    // Live: the same line (never blank), and the keys that stop it.
    assert!(
        shown.contains("x  Stop retrying") && shown.contains("X  Cancel task"),
        "{shown}"
    );
    // How long it has waited since the attempt it follows, and which attempt that was on this task.
    assert!(
        shown.contains("Waiting to retry · 40s · after attempt 3"),
        "{shown}"
    );
    insta::assert_snapshot!("waiting_live", shown);
    app.key(code(KeyCode::Tab));
    let wide = screen(&mut app, 200, 40);
    assert!(wide.contains(line), "{wide}");
    // Due: it says so, never a negative wait.
    app.now = NOW + 200;
    assert!(screen(&mut app, 200, 40).contains("trying again now"));
}

#[test]
fn a_running_build_counts_from_its_own_start() {
    let mut s = fake::steps_for("t-live", "Upgrade the test runner", Some(9), None);
    for card in s["cards"].as_array_mut().unwrap() {
        if card["key"] == "build" {
            card["startedAt"] = json!("2026-11-14T11:00:00.000Z");
            card["latestStartedAt"] = json!("2026-11-14T12:03:32.000Z");
            card["runs"] = json!([9, 4]);
        }
    }
    let mut app = app_on(fake::scenario_work());
    select(&mut app, "t-live");
    app.update(Msg::Steps("t-live".into(), Ok(parse(s))));
    let shown = screen(&mut app, 160, 34);
    assert!(
        shown.contains("Building now · 40s ·") && shown.contains("attempt 2"),
        "{shown}"
    );
    assert!(!shown.contains("1h 04m"), "{shown}");
}

// ---- 3. what the agent said ---------------------------------------------------------------------------------------

fn failed_steps(said: Value) -> Value {
    let mut s = fake::steps_for("t-failed", "Add a subtract function", None, None);
    s["task"]["state"] = json!("failed");
    s["failure"] = json!({ "line": "The agent stopped with an error.", "failedInARow": 3,
        "suggestion": "Retry as it is; if it stops the same way, try another agent.", "agentSaid": said });
    s["retry"] = json!({ "run": 3, "digest": "d".repeat(64) });
    for card in s["cards"].as_array_mut().unwrap() {
        if card["key"] == "build" {
            card["runs"] = json!([3]);
        }
    }
    s
}

#[test]
fn what_the_agent_said_is_shown_cleaned_and_capped() {
    let mut lines: Vec<String> = (1..=12)
        .map(|i| format!("line {i} of the agent's output"))
        .collect();
    lines[10] = "\u{1b}]52;c;ZXZpbA==\u{7}evil \u{202e}esrever".into();
    let mut app = app_on(fake::fixture("work-rows-every-kind.json"));
    select(&mut app, "t-failed");
    app.update(Msg::Steps(
        "t-failed".into(),
        Ok(parse(failed_steps(json!(lines)))),
    ));
    let shown = screen(&mut app, 160, 40);
    assert!(shown.contains("What the agent said"), "{shown}");
    // At most 8, the last ones.
    assert!(
        shown.contains("line 12 of the agent's output") && shown.contains("line 5 of"),
        "{shown}"
    );
    assert!(!shown.contains("line 4 of"), "{shown}");
    // Drawn inert: no escape or bidi control reaches the screen (each is a visible stand-in).
    assert!(
        !shown.contains('\u{1b}') && !shown.contains('\u{7}') && !shown.contains('\u{202e}'),
        "{shown}"
    );
    assert!(shown.contains('\u{fffd}'), "{shown}");
    // Beside r Retry, no "retry as it is".
    assert!(
        shown.contains("If it stops the same way, try another agent."),
        "{shown}"
    );
    assert!(!shown.contains("Retry as it is"), "{shown}");
    insta::assert_snapshot!("agent_said", screen(&mut app, 120, 34));
    // The retry confirm names the attempt it starts, and the build it follows.
    app.key(key('r'));
    let shown = screen(&mut app, 120, 34);
    assert!(
        shown.contains("Retry: starts a new attempt after attempt 1."),
        "{shown}"
    );
}

// ---- 5. the Build card's usual settings ----------------------------------------------------------------------------

#[test]
fn builds_usual_row_is_its_summary_until_f() {
    let mut app = app_on(fake::scenario_work());
    app.update(Msg::Acted(Ok(ActOutcome::Terms {
        preview: "p".repeat(64),
        digest: "d".repeat(64),
        terms: vec![
            ("Goal".into(), "Add a subtract function".into()),
            (
                "Usual".into(),
                "Your usual project settings: sandboxed, writes only its checkout\nChecks: Default\nWrites: only its checkout\nTime limit: 20 min".into(),
            ),
            ("Project tools".into(), "None".into()),
        ],
    })));
    assert!(matches!(app.mode, Mode::Build { .. }), "{:?}", app.mode);
    let shown = screen(&mut app, 120, 34);
    assert!(
        shown.contains("Your usual project settings: sandboxed"),
        "{shown}"
    );
    assert!(shown.contains("f shows all 3 settings"), "{shown}");
    assert!(!shown.contains("Time limit: 20 min"), "{shown}");
    insta::assert_snapshot!("build_usual_folded", shown);
    app.key(key('f'));
    let shown = screen(&mut app, 120, 34);
    assert!(
        shown.contains("Time limit: 20 min") && !shown.contains("f shows all"),
        "{shown}"
    );
}

// ---- 6. wording ---------------------------------------------------------------------------------------------------

#[test]
fn helps_keys_example_binds_nothing_already_bound() {
    let chord = parse_chord(HELP_EXAMPLE.1).expect("the example's key reads");
    assert!(toolroll_tui::keys::Action::from_id(HELP_EXAMPLE.0).is_some());
    for preset in Preset::ALL {
        let map = Keymap::preset(preset);
        for spec in SPECS {
            assert!(
                !map.keys_of(spec.action).contains(&chord),
                "{} already has {}",
                spec.id,
                HELP_EXAMPLE.1
            );
        }
    }
    let mut app = app_on(fake::scenario_work());
    app.key(key('?'));
    let shown = screen(&mut app, 120, 30);
    assert!(shown.contains("accept = \"f2\""), "{shown}");
    assert!(!shown.contains("accept = \"A\""), "{shown}");
}

// ---- 7. palette matching ------------------------------------------------------------------------------------------

#[test]
fn the_palette_matches_words_and_ranks_the_task_first() {
    let mut app = app_on(fake::fixture("work-rows-every-kind.json"));
    let found = toolroll_tui::palette::matches(&app, "subtract");
    assert!(!found.is_empty());
    assert_eq!(found[0].label, "Add a subtract function");
    assert!(
        found
            .iter()
            .all(|e| !e.label.starts_with("Send the result back")),
        "{:?}",
        found.iter().map(|e| &e.label).collect::<Vec<_>>()
    );
    app.key(key(':'));
    assert!(score(
        "subtract",
        "Send the result back, with a note (on a failed task: retry it)"
    )
    .is_none());
}

// ---- 8. the new-thread composer -----------------------------------------------------------------------------------

#[test]
fn the_new_thread_composer_says_where_and_with_whom() {
    let mut app = app_on(fake::scenario_work());
    app.update(Msg::Agents(Ok(parse(fake::fixture("agents.json")))));
    app.key(key('T'));
    assert!(matches!(app.mode, Mode::NewThread(_)));
    let shown = screen(&mut app, 120, 30);
    assert!(shown.contains("In proj · with Claude Code"), "{shown}");
    assert!(shown.contains("New thread: "), "{shown}");
    insta::assert_snapshot!("new_thread_composer", shown);
    // Threads run Claude Code only for now: said whole where it fits, and Enter's words never cut for it.
    let wide = screen(&mut app, 200, 30);
    assert!(
        wide.contains("with Claude Code · Codex threads come later · ⏎ shows its terms first"),
        "{wide}"
    );
}

#[cfg(unix)]
#[test]
fn the_settings_file_line_says_saved_after_a_save() {
    use std::os::unix::fs::PermissionsExt;
    use toolroll_tui::settings::{Choice, FileState, Prefs, Settings};
    let home = std::env::temp_dir().join(format!("tr-saved-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
    let home = home.canonicalize().unwrap();
    let mut p = Prefs {
        settings: Settings::default(),
        path: Some(home.join(".config").join("toolroll").join("tui.toml")),
        home: Some(home.clone()),
        file: FileState::Missing,
        ..Default::default()
    };
    let text = |p: &Prefs| {
        p.screen(80, 0, None)
            .iter()
            .map(|l| l.to_string())
            .collect::<Vec<_>>()
            .join("\n")
    };
    assert!(text(&p).contains("not there yet"));
    p.change(Choice::Density).unwrap();
    assert!(
        text(&p).lines().any(|l| l.trim() == "saved"),
        "{}",
        text(&p)
    );
    let _ = std::fs::remove_dir_all(&home);
}
