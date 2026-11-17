//! The stranger test's fifth round, toward 9: "Building it." goes as soon as the task moves on; narrow mode shows the
//! list and the task in turn, with where you are; search reads everything Live draws; the list's width said is the
//! width drawn; unread marks every change you didn't see; and what is drawn, searched and exported are one text.
#[path = "common/pairs.rs"]
mod pairs;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use serde_json::{json, Value};
use toolroll_api::*;
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, Effect, Mode, Msg, Tab, Tone, FAST_READ, STATUS_HOLD};

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
fn ctrl(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
}
fn screen(app: &mut App, w: u16, h: u16) -> String {
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| toolroll_tui::view::draw(f, app)).unwrap();
    pairs::check(app, w, h);
    term.backend().to_string()
}
fn said(app: &App) -> String {
    app.status
        .as_ref()
        .map(|(_, w)| w.clone())
        .unwrap_or_default()
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
fn failed_steps() -> Value {
    let mut s = steps("failed");
    s["failure"] = json!({ "line": "The agent stopped with an error.", "failedInARow": 1, "suggestion": null,
        "agentSaid": ["Running npm test…", "API Error: stand-in claude refuses (STUB-AGENT-ERROR)"] });
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

// ---- 1. "Building it." goes as soon as the task moves on ------------------------------------------------------------

#[test]
fn a_status_line_goes_the_moment_its_task_moves_on_even_while_held() {
    let mut app = on(steps("queued"));
    app.update(Msg::Acted(Ok(ActOutcome::Done("Retrying.".into()))));
    assert_eq!(said(&app), "Retrying.");
    // Within the hold (no key since): the read that shows it failed doesn't wait for a later poll.
    app.update(Msg::Steps("t-retry".into(), Ok(parse(failed_steps()))));
    assert_eq!(said(&app), "Retrying.", "cleared inside the hold");
    // The hold ends: the next tick (a quarter second) clears it, with no read and no key.
    app.said_at = Some(std::time::Instant::now() - STATUS_HOLD);
    app.update(Msg::Tick);
    assert!(app.status.is_none(), "{:?}", app.status);
}

#[test]
fn the_task_an_answer_is_about_is_read_fast_until_it_moves_on() {
    let mut app = on(steps("queued"));
    app.update(Msg::Acted(Ok(ActOutcome::Done("Retrying.".into()))));
    // A fast read is due at once, then every FAST_READ: the task's steps, nothing else.
    let fx = app.update(Msg::Tick);
    assert!(fx.contains(&Effect::FetchSteps("t-retry".into())), "{fx:?}");
    let fx = app.update(Msg::Tick);
    assert!(
        !fx.contains(&Effect::FetchSteps("t-retry".into())),
        "{fx:?}"
    );
    app.fast_read_at = Some(std::time::Instant::now() - FAST_READ);
    let fx = app.update(Msg::Tick);
    assert!(fx.contains(&Effect::FetchSteps("t-retry".into())), "{fx:?}");
    // That read finds it failed; the hold over, the line goes; and the fast reads stop with it.
    app.said_at = Some(std::time::Instant::now() - STATUS_HOLD);
    app.update(Msg::Steps("t-retry".into(), Ok(parse(failed_steps()))));
    assert!(app.status.is_none());
    app.fast_read_at = Some(std::time::Instant::now() - FAST_READ);
    let fx = app.update(Msg::Tick);
    assert!(
        !fx.contains(&Effect::FetchSteps("t-retry".into())),
        "{fx:?}"
    );
    // A line said by a key (not an act's answer) is never followed: no extra reads.
    let mut app = on(steps("queued"));
    app.key(key('z'));
    app.fast_read_at = None;
    let fx = app.update(Msg::Tick);
    assert!(
        !fx.contains(&Effect::FetchSteps("t-retry".into())),
        "{fx:?}"
    );
}

// ---- 2. narrow: the list, then the task -----------------------------------------------------------------------------

#[test]
fn narrow_shows_the_list_then_the_task_with_where_you_are() {
    let mut app = on(steps("queued"));
    let shown = screen(&mut app, 60, 26);
    assert!(app.narrow);
    // The task, where it is in the list, and the way back.
    let at = app.selected + 1;
    let n = app.items.len();
    assert!(shown.contains(&format!("{at} of {n} · b list")), "{shown}");
    // b: the list, across the whole column, and the toast says so.
    app.key(key('b'));
    assert!(app.narrow_list);
    assert!(said(&app).starts_with("The list"), "{}", said(&app));
    let list = screen(&mut app, 60, 26);
    assert!(list.contains("Rename the config loader"), "{list}");
    assert!(list.contains("Add a changelog entry"), "{list}");
    assert!(!list.contains("Live"), "{list}");
    insta::assert_snapshot!("nine1_narrow_list", list);
    // Moving and Enter: that task's panel.
    app.key(key('j'));
    let picked = app.selected;
    app.key(code(KeyCode::Enter));
    assert!(!app.narrow_list);
    let shown = screen(&mut app, 60, 26);
    assert!(
        shown.contains(&format!("{} of {n} · b list", picked + 1)),
        "{shown}"
    );
    insta::assert_snapshot!("nine1_narrow_task", shown);
    // Esc from the panel: the list again.
    app.key(code(KeyCode::Esc));
    assert!(app.narrow_list);
    assert!(screen(&mut app, 60, 26).contains("Rename the config loader"));
    // b again: the task, and it says so.
    app.key(key('b'));
    assert_eq!(said(&app), "The task: b shows the list.");
    // Wide again: the list beside the task, as before.
    let wide = screen(&mut app, 140, 34);
    assert!(!app.narrow);
    assert!(wide.contains("Live") && wide.contains("Add a changelog entry"));
}

// ---- 3 and 6. search and export read what is drawn ------------------------------------------------------------------

#[test]
fn search_finds_what_live_draws_above_the_output() {
    let mut app = on(failed_steps());
    assert_eq!(app.tab, Tab::Live);
    let shown = screen(&mut app, 140, 34);
    assert!(shown.contains("STUB-AGENT"), "{shown}");
    app.key(key('/'));
    for c in "stub".chars() {
        app.key(key(c));
    }
    let Mode::Search(s) = app.mode.clone() else {
        panic!()
    };
    assert_eq!(s.count, 1, "{s:?}");
    // The failure line too.
    app.key(code(KeyCode::Esc));
    app.key(key('/'));
    for c in "stopped with".chars() {
        app.key(key(c));
    }
    let Mode::Search(s) = app.mode.clone() else {
        panic!()
    };
    assert!(s.count >= 1, "{s:?}");
}

/// The rows of the panel's content as drawn, trimmed, blank rows left out.
fn drawn_rows(app: &mut App, w: u16, h: u16) -> Vec<String> {
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| toolroll_tui::view::draw(f, app)).unwrap();
    pairs::check(app, w, h);
    let c = app.areas.content;
    let buf = term.backend().buffer();
    (c.top()..c.bottom())
        .map(|y| {
            (c.left()..c.right())
                .map(|x| buf[(x, y)].symbol().to_string())
                .collect::<String>()
                .trim()
                .to_string()
        })
        .filter(|l| !l.is_empty())
        .collect()
}

#[test]
fn drawn_searched_and_exported_text_are_one() {
    for tab in [Tab::Steps, Tab::Live] {
        let mut s = failed_steps();
        s["chain"] = json!("just-code");
        s["approval"] = json!({ "by": "sam", "you": true, "automatic": false });
        let mut app = on(s);
        app.tab = tab;
        let rows = drawn_rows(&mut app, 140, 40);
        let (_, text) = toolroll_tui::search::pane_text(&mut app).unwrap();
        let exported: Vec<String> = text
            .iter()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        // Every row drawn is a line of the text searched (Steps draws it all here).
        for row in &rows {
            assert!(
                exported.iter().any(|l| l == row),
                "{tab:?}: drawn but not exported: {row:?}\n{exported:#?}"
            );
        }
        // And the export is the same content laid out whole (nine2: no width, no key hints, no rules), the editor's
        // file and nothing else.
        let (_, whole) = toolroll_tui::search::export_text(&mut app).unwrap();
        let fx = app.key(ctrl('e'));
        let [Effect::OpenInEditor { text: file, .. }] = &fx[..] else {
            panic!("{fx:?}")
        };
        let mut want = whole.join("\n");
        want.push('\n');
        assert_eq!(file, &want);
        if tab == Tab::Steps {
            // What the screen says (just code, no plan), never cards it doesn't draw.
            assert!(file.contains("just code (no plan)"), "{file}");
            assert!(!file.contains("Plan written"), "{file}");
            assert_eq!(exported, rows, "Steps draws all of it here");
        }
    }
}

// ---- 4. the width said is the width drawn ---------------------------------------------------------------------------

#[test]
fn the_list_width_said_is_the_width_drawn() {
    let mut app = on(steps("queued"));
    screen(&mut app, 120, 30);
    let max = toolroll_tui::view::list_width_max(app.areas.body.width);
    for _ in 0..60 {
        app.key(key('>'));
        screen(&mut app, 120, 30);
        let drawn = app.areas.split_x - app.areas.body.x;
        if said(&app).starts_with("List ") {
            assert_eq!(
                said(&app),
                format!("List {drawn} columns wide: = sets it back.")
            );
        }
    }
    assert_eq!(app.split, max);
    assert_eq!(
        said(&app),
        format!("The list can't get wider at this window size ({max} columns).")
    );
    for _ in 0..60 {
        app.key(key('<'));
    }
    assert!(said(&app).starts_with("The list can't get narrower"));
}

// ---- 5. unread ------------------------------------------------------------------------------------------------------

#[test]
fn unread_marks_any_change_you_didnt_see_with_a_space_before_the_dot() {
    let work = fake::fixture("work-rows-every-kind.json");
    let mut app = app_on(work.clone());
    select(&mut app, "t-retry");
    // Another row (waiting to retry) changes while t-retry is open: its retry moved (a background attempt failed).
    let other = app
        .items
        .iter()
        .find(|i| i.id != "t-retry" && i.is_task && !i.thread)
        .unwrap()
        .id
        .clone();
    let mut changed = work.clone();
    for r in changed["rows"].as_array_mut().unwrap() {
        if r["id"] == json!(other) {
            r["waiting"] = json!({ "retryAt": "2026-11-14T12:30:00.000Z", "lastFailure": "A temporary problem" });
        }
    }
    app.update(Msg::Work(Ok(parse(changed.clone()))));
    assert!(app.unread.contains(&other), "{:?}", app.unread);
    // Its next try moved again (another background attempt failed), the same words: still news.
    app.unread.clear();
    for r in changed["rows"].as_array_mut().unwrap() {
        if r["id"] == json!(other) {
            r["waiting"]["retryAt"] = json!("2026-11-14T12:45:00.000Z");
        }
    }
    app.update(Msg::Work(Ok(parse(changed.clone()))));
    assert!(app.unread.contains(&other), "{:?}", app.unread);
    // An attempt that started or finished there: its word moved.
    app.unread.clear();
    let mut moved = changed.clone();
    for r in moved["rows"].as_array_mut().unwrap() {
        if r["id"] == json!(other) {
            r["word"] = json!({ "word": "Building", "tone": "live" });
            r["group"] = json!("building");
            r["rank"] = json!(1);
            r["status"]["tone"] = json!("live");
            r["status"]["label"] = json!("Building");
        }
    }
    app.update(Msg::Work(Ok(parse(moved))));
    assert!(app.unread.contains(&other));
    // Time passing (its age) is no news.
    let mut aged = app_on(work.clone());
    select(&mut aged, "t-retry");
    let mut older = work.clone();
    for r in older["rows"].as_array_mut().unwrap() {
        r["age"] = json!("9m ago");
    }
    aged.update(Msg::Work(Ok(parse(older))));
    assert!(aged.unread.is_empty(), "{:?}", aged.unread);
    // The dot: the mark, a space, the dot, a space, the title.
    let title = app
        .items
        .iter()
        .find(|i| i.id == other)
        .unwrap()
        .title
        .clone();
    let shown = screen(&mut app, 140, 34);
    let row = shown
        .lines()
        .find(|l| l.contains(&title[..10]))
        .unwrap()
        .to_string();
    assert!(
        row.contains(&format!(" • {}", &title[..10])),
        "{row}\n{:?} {other}\n{shown}",
        app.unread
    );
    assert!(!row.contains(&format!("•{}", &title[..1])), "{row}");
    let _ = Tone::Said;
}
