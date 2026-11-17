//! The stranger test's sixth round, toward 9: Ctrl-E exports the whole text (never the drawn, cut one), Live always
//! shows the task's situation above its output, and the narrow top bar is one bar on every screen.
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use serde_json::{json, Value};
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, Effect, Msg, Tab, HOLD_REASON};

/// 2026-11-14T12:04:12Z.
const NOW: i64 = 1_794_657_852;

fn parse<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).expect("fixture shape")
}
fn key(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)
}
fn ctrl(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
}
fn screen(app: &mut App, w: u16, h: u16) -> String {
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| toolroll_tui::view::draw(f, app)).unwrap();
    term.backend().to_string()
}

/// t-retry's steps: its builds #9, #5 and #3, in `state`.
fn steps(state: &str) -> Value {
    let mut s = fake::steps_for("t-retry", "Rename the config loader", None, None);
    s["task"]["state"] = json!(state);
    for card in s["cards"].as_array_mut().unwrap() {
        if card["key"] == "build" {
            let stuck = state == "failed";
            card["state"] = json!(if stuck { "stuck" } else { "todo" });
            card["mark"] = json!(if stuck { "stuck" } else { "todo" });
            card["sentence"] = json!("The agent stopped with an error");
            card["startedAt"] = json!("2026-11-14T11:30:00.000Z");
            card["latestStartedAt"] = json!("2026-11-14T12:02:32.000Z");
            card["finishedAt"] = json!("2026-11-14T12:03:32.000Z");
            card["runs"] = json!([9, 5, 3]);
        }
    }
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

/// What the agent said, longer than any pane is wide.
const LONG: &str = "API Error: stand-in claude refuses to run a model (STUB-AGENT-ERROR) because this machine has no model access at all, and here is the rest of a long line that a narrow pane would cut";

fn failed_long() -> Value {
    let mut s = steps("failed");
    s["failure"] = json!({ "line": "The agent stopped with an error.", "failedInARow": 1, "suggestion": null,
        "agentSaid": ["[path]: line 3: [path]: Operation not permitted", LONG] });
    s["retry"] = json!({ "run": 9, "digest": "d".repeat(64) });
    s
}
fn waiting_steps() -> Value {
    let mut s = steps("queued");
    s["waiting"] = json!({ "retryAt": "2026-11-14T12:05:52.000Z", "lastFailure": "A temporary problem on the machine stopped it", "agentSaid": [LONG] });
    s
}
fn held_steps() -> Value {
    let mut s = steps("queued");
    s["held"] = json!({ "id": 41, "reason": HOLD_REASON, "lastFailure": "The agent stopped with an error" });
    s
}
/// A started build's output: one record, "Started.".
fn with_output(app: &mut App) {
    let run = 9;
    app.transcript.run = Some(run);
    let window = json!({ "version": 1, "session": { "kind": "run", "id": run, "task": "t-retry" }, "room": format!("agent:{run}"), "live": true, "file": "main",
        "window": { "ok": true, "records": [{ "k": "say", "at": "2026-11-14T12:00:00.000Z", "t": ["Started."] }],
            "cursor": "c2", "restarted": false, "earlier": false, "quarantined": 0, "skipped": 0, "more": false } });
    app.update(Msg::Live(run, "main", Ok(parse(window))));
}
/// Spaces folded and the cut mark taken off, to compare a drawn line with the whole text.
fn folded(s: &str) -> String {
    s.replace('…', "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

// ---- 1. Ctrl-E exports the whole text --------------------------------------------------------------------------------

#[test]
fn an_agent_error_longer_than_the_pane_exports_whole_without_key_hints() {
    for tab in [Tab::Live, Tab::Steps] {
        let mut app = on(failed_long());
        app.tab = tab;
        screen(&mut app, 70, 30);
        let fx = app.key(ctrl('e'));
        let [Effect::OpenInEditor { text: file, .. }] = &fx[..] else {
            panic!("{fx:?}")
        };
        // Whole: the long line in one piece, never cut ("…") or wrapped.
        assert!(file.lines().any(|l| l.trim() == LONG), "{tab:?}:\n{file}");
        assert!(!file.contains('…') || !file.contains(&LONG[..40]), "{file}");
        // No key hints, no rules.
        assert!(
            !file.contains("r  Retry") && !file.lines().any(|l| l.trim() == "Retry"),
            "{file}"
        );
        assert!(!file.contains("──"), "{file}");
        assert!(!file.contains("a accepts"), "{file}");
        // Every line drawn (search's text, the same content at the drawn width), cut mark and hints aside, is in it.
        let drawn = toolroll_tui::search::pane_text(&mut app).unwrap().1;
        let w = app.areas.content.width as usize;
        let hintless = toolroll_tui::search::pane_text_in(
            &mut app,
            toolroll_tui::view::Room { w, hints: false },
        )
        .unwrap()
        .1;
        let whole = folded(file);
        for l in &hintless {
            assert!(
                whole.contains(&folded(l)),
                "{tab:?}: drawn but not exported: {l:?}\n{file}"
            );
        }
        // And what drawing adds beyond that is only hints and rules.
        let extra: Vec<&String> = drawn.iter().filter(|l| !hintless.contains(l)).collect();
        assert!(
            extra
                .iter()
                .all(|l| l.trim().is_empty() || l.contains("Retry") || l.chars().all(|c| c == '─')),
            "{extra:?}"
        );
    }
}

#[test]
fn search_still_matches_what_is_drawn() {
    let mut app = on(failed_long());
    app.tab = Tab::Live;
    let shown = screen(&mut app, 70, 30);
    let (_, text) = toolroll_tui::search::pane_text(&mut app).unwrap();
    // Search's lines are the drawn lines (cut to the pane), the key hint among them.
    assert!(text.iter().any(|l| l.contains("Retry")));
    assert!(
        text.iter()
            .all(|l| toolroll_tui::text::width(l) <= app.areas.content.width as usize),
        "{text:#?}"
    );
    assert!(shown.contains("What the agent said"));
}

// ---- 2. Live shows the task's situation above its output -----------------------------------------------------------

#[test]
fn live_shows_the_wait_hold_and_failure_above_the_output() {
    for (name, s, words) in [
        (
            "waiting",
            waiting_steps(),
            vec![
                "Last build failed",
                "next try",
                "What the agent said",
                "Stop retrying",
                "Cancel task",
            ],
        ),
        (
            "held",
            held_steps(),
            vec!["On hold", "Resume retrying", "Cancel task"],
        ),
        (
            "failed",
            failed_long(),
            vec![
                "The agent stopped with an error.",
                "What the agent said",
                "Retry",
            ],
        ),
    ] {
        let mut app = on(s);
        app.tab = Tab::Live;
        with_output(&mut app);
        let shown = screen(&mut app, 120, 34);
        for w in &words {
            assert!(shown.contains(w), "{name}: {w:?} missing\n{shown}");
        }
        // Above the stream.
        let at = |w: &str| shown.find(w).unwrap_or(usize::MAX);
        assert!(at(words[0]) < at("Started."), "{name}\n{shown}");
        assert!(shown.contains("Started."), "{name}\n{shown}");
        if name == "waiting" {
            insta::assert_snapshot!("nine2_waiting_live", shown);
        }
    }
}

// ---- 4. the top bar: the same items in the same order on every screen -----------------------------------------------

fn top_row(app: &mut App, w: u16) -> String {
    let shown = screen(app, w, 24);
    shown.lines().next().unwrap().to_string()
}

#[test]
fn narrow_list_and_task_screens_share_one_top_bar() {
    for w in [40u16, 52, 60, 63] {
        let mut app = on(waiting_steps());
        app.spend = Some(parse(json!({ "todayUsd": 0.0, "planPercent": null })));
        app.unread.insert("t-other".into());
        screen(&mut app, w, 24);
        app.narrow_list = true;
        let list = top_row(&mut app, w);
        app.narrow_list = false;
        let task = top_row(&mut app, w);
        assert_eq!(list, task, "at {w} columns");
    }
    // Room for the cost and not for unread as well: the cost stays (it outranks unread) on both screens.
    let mut app = on(waiting_steps());
    app.spend = Some(parse(json!({ "todayUsd": 0.0, "planPercent": null })));
    app.unread.insert("t-other".into());
    screen(&mut app, 60, 24);
    app.narrow_list = true;
    let list = top_row(&mut app, 60);
    assert!(list.contains("$0.00 today"), "{list}");
}

// ---- 3. jump back is in qol3.rs (jump_back_remembers_needs_you_jumps_and_goes_further_back) -----------------------

// Wrapping is part of the shared content contract: screen/search agree; exports remain whole.
#[test]
fn agent_messages_wrap_on_live_and_steps_and_only_clip_at_the_row_cap() {
    for tab in [Tab::Live, Tab::Steps] {
        for width in [120, 40] {
            let mut app = on(failed_long());
            app.tab = tab;
            app.narrow_list = false;
            let shown = screen(&mut app, width, 60);
            let (_, rows) = toolroll_tui::search::pane_text(&mut app).unwrap();
            assert!(
                folded(&rows.join(" ")).contains(LONG),
                "{tab:?} at {width}: {rows:?}"
            );
            assert!(shown.contains("would cut"), "{shown}");
            let start = rows
                .iter()
                .position(|r| r == "What the agent said")
                .unwrap()
                + 1;
            assert!(
                !rows[start..]
                    .iter()
                    .take_while(|r| !r.is_empty())
                    .any(|r| r.contains('…')),
                "{rows:?}"
            );
        }
        let mut s = failed_long();
        let huge = "An unusually long diagnostic message ".repeat(200);
        s["failure"]["agentSaid"] = json!([huge]);
        s["failure"]["line"] = json!(huge);
        let mut app = on(s);
        app.tab = tab;
        screen(&mut app, 120, 60);
        let (_, rows) = toolroll_tui::search::pane_text(&mut app).unwrap();
        let reason_start = rows
            .iter()
            .position(|r| r.starts_with("An unusually long diagnostic"))
            .unwrap();
        let reason: Vec<_> = rows[reason_start..]
            .iter()
            .take_while(|r| !r.is_empty())
            .collect();
        assert_eq!(reason.len(), toolroll_tui::view::AGENT_SAID_ROWS);
        assert!(reason.last().unwrap().ends_with('…'));
        let start = rows
            .iter()
            .position(|r| r == "What the agent said")
            .unwrap()
            + 1;
        let message: Vec<_> = rows[start..].iter().take_while(|r| !r.is_empty()).collect();
        assert_eq!(message.len(), toolroll_tui::view::AGENT_SAID_ROWS);
        assert!(message.last().unwrap().ends_with('…'));
        assert!(message[1].starts_with("    "));
        let (_, whole) = toolroll_tui::search::export_text(&mut app).unwrap();
        assert!(whole.iter().any(|r| r.trim() == huge.trim()));
    }
}
