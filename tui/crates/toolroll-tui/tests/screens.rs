//! Every screen state, drawn on ratatui's TestBackend from the contract's fixtures (shaped by the fake console's
//! scenario) and held as insta snapshots; and what each key asks the engine to do.
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::backend::TestBackend;
use ratatui::style::Color;
use ratatui::Terminal;
use serde_json::Value;
use toolroll_api::*;
use toolroll_fake_engine as fake;
use toolroll_tui::app::{
    App, DiffAsk, Effect, FileAsk, Mode, Msg, Tab, EXIT_CLASSIC, EXIT_KEEP, EXIT_STOP,
};

/// 4 min 12 s after the fixtures' builds started.
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

/// An app that has read the scenario's work list and the selected task's steps (and, when it has one, its live window).
fn app_with(work: Value, select: &str) -> App {
    let state = fake::scenario();
    let mut app = App::new(false, Some("/home/me/shop".into()));
    app.now = NOW;
    let fx = app.update(Msg::Work(Ok(parse(work))));
    assert!(
        fx.contains(&Effect::FetchWork)
            || fx.iter().any(|e| matches!(e, Effect::FetchSteps(_)))
            || app.items.is_empty()
    );
    if let Some(i) = app.items.iter().position(|i| i.id == select) {
        for _ in 0..i {
            app.key(key('j'));
        }
    }
    if let Some(steps) = state.steps.get(select) {
        let fx = app.update(Msg::Steps(select.into(), Ok(parse(steps.clone()))));
        for e in fx {
            if let Effect::FetchLive { run, file, .. } = e {
                let records = if file == "main" {
                    state.live.get(&run).map(|(r, _)| r.clone())
                } else {
                    state.sub.get(&run).cloned()
                };
                if let Some(records) = records {
                    let window = serde_json::json!({ "version": 1, "session": { "kind": "run", "id": run, "task": select }, "room": format!("agent:{run}"), "live": true, "file": file,
                        "window": { "ok": true, "records": records, "cursor": "c1", "restarted": false, "earlier": false, "quarantined": 0, "skipped": 0, "more": false } });
                    app.update(Msg::Live(run, file, Ok(parse(window))));
                }
            }
        }
    }
    app
}

fn scenario_app(select: &str) -> App {
    app_with(fake::scenario_work(), select)
}

/// The one diff read an update asked for.
fn diff_ask(fx: &[Effect]) -> DiffAsk {
    match fx.iter().find_map(|e| match e {
        Effect::FetchDiff(ask) => Some(ask.clone()),
        _ => None,
    }) {
        Some(ask) => ask,
        None => panic!("no diff read in {fx:?}"),
    }
}

/// The one file read an update asked for.
fn file_ask(fx: &[Effect]) -> FileAsk {
    match fx.iter().find_map(|e| match e {
        Effect::FetchDiffFile(ask) => Some(ask.clone()),
        _ => None,
    }) {
        Some(ask) => ask,
        None => panic!("no file read in {fx:?}"),
    }
}

/// Answer the diff read `fx` asked for with `diff`, and its file read with the scenario's first file.
fn answer_diff(app: &mut App, fx: &[Effect], diff: Value) {
    let state = fake::scenario();
    let fx = app.update(Msg::Diff(diff_ask(fx), Ok(parse(diff))));
    let ask = file_ask(&fx);
    let mut file = state.diff_files[&format!("t-done:{}", ask.file)].clone();
    file["run"] = ask.run.into();
    app.update(Msg::DiffFile(ask, Ok(parse(file))));
}

/// `a` on t-done: its changes shown first, then `a` again opens the Accept dialog.
fn open_accept(app: &mut App) {
    let fx = app.key(key('a'));
    assert_eq!(
        app.status.as_ref().unwrap().1,
        toolroll_tui::app::SHOW_CHANGES_FIRST
    );
    assert_eq!(app.tab, Tab::Diff);
    answer_diff(app, &fx, fake::scenario().diffs["t-done"].clone());
    assert_eq!(app.key(key('a')), vec![]);
    assert!(
        matches!(app.mode, Mode::ConfirmAccept(_)),
        "{:?}",
        app.status
    );
}

fn screen(app: &mut App, w: u16, h: u16) -> String {
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| toolroll_tui::view::draw(f, app)).unwrap();
    // No amber anywhere (DESIGN.md: what needs you is ink).
    for cell in term.backend().buffer().content() {
        assert!(
            !matches!(
                cell.fg,
                Color::Yellow | Color::LightYellow | Color::Rgb(245, 165, 36)
            ),
            "amber at {:?}",
            cell.symbol()
        );
        assert!(
            !matches!(cell.bg, Color::Yellow | Color::LightYellow),
            "amber background"
        );
    }
    term.backend().to_string()
}

#[test]
fn empty() {
    let mut app = app_with(fake::empty_work(), "");
    insta::assert_snapshot!(screen(&mut app, 120, 30));
}

#[test]
fn reading() {
    let mut app = App::new(false, None);
    insta::assert_snapshot!(screen(&mut app, 120, 30));
}

#[test]
fn needs_you_result_to_check() {
    let mut app = scenario_app("t-done");
    insta::assert_snapshot!(screen(&mut app, 120, 30));
}

#[test]
fn working_live_transcript_with_a_helper() {
    let mut app = scenario_app("t-live");
    insta::assert_snapshot!(screen(&mut app, 120, 30));
}

#[test]
fn a_question() {
    let mut app = scenario_app("t-ask");
    insta::assert_snapshot!("a_question", screen(&mut app, 120, 30));
    // 2 picks "Remove it" and asks for Enter before anything is sent.
    assert_eq!(app.key(key('2')), vec![]);
    assert!(
        matches!(&app.mode, Mode::ConfirmAnswer(pin) if pin.index == 1 && pin.question == 31 && pin.option == "no")
    );
    insta::assert_snapshot!("a_question_confirm", screen(&mut app, 120, 30));
    let fx = app.key(code(KeyCode::Enter));
    // (drawn whole above, so Enter sends it)
    assert_eq!(
        fx,
        vec![Effect::Act {
            path: "/d/31/answer".into(),
            fields: vec![
                ("choice".into(), "no".into()),
                ("confirm".into(), "yes".into()),
                ("return".into(), "next".into())
            ],
            done: "Answered: Remove it.".into()
        }]
    );
    // A number with no such answer, or no question, says so and sends nothing.
    assert_eq!(app.key(key('7')), vec![]);
    assert!(app.status.as_ref().unwrap().1.contains("no answer 7"));
}

#[test]
fn steering() {
    let mut app = scenario_app("t-live");
    app.key(key('s'));
    for c in "keep the alias, log a deprecation".chars() {
        app.key(key(c));
    }
    insta::assert_snapshot!(screen(&mut app, 120, 30));
    let fx = app.key(code(KeyCode::Enter));
    let Effect::Act { path, fields, done } = &fx[0] else {
        panic!("{fx:?}")
    };
    assert_eq!(path, "/t/t-live/steer");
    assert_eq!(done, "Note sent to build #7.");
    let field = |k: &str| fields.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    assert_eq!(
        field("note").as_deref(),
        Some("keep the alias, log a deprecation")
    );
    assert_eq!(field("run").as_deref(), Some("7"));
    assert_eq!(field("return").as_deref(), Some("task"));
    let draft = field("key").unwrap();
    assert!(
        draft.len() >= 8
            && draft.len() <= 64
            && draft.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    );
}

#[test]
fn refused_act() {
    let mut app = scenario_app("t-live");
    let fx = app.update(Msg::Acted(Ok(ActOutcome::Refused(
        "run #7 already ended before the stop — reload to see the current state".into(),
    ))));
    // A refusal re-reads what's on screen.
    assert!(fx.contains(&Effect::FetchWork));
    insta::assert_snapshot!(screen(&mut app, 120, 30));
}

#[test]
fn contract_mismatch() {
    let mut app = scenario_app("t-live");
    app.mode = Mode::Fatal("This terminal workbench was built for another Toolroll version than the one running (0.9.110). Opening the classic screen instead.".into(), EXIT_CLASSIC);
    insta::assert_snapshot!(screen(&mut app, 120, 30));
    assert_eq!(app.key(key('x')), vec![Effect::Exit(EXIT_CLASSIC)]);
}

#[test]
fn session_ended() {
    let mut app = scenario_app("t-live");
    app.update(Msg::Live(
        fake::LIVE_RUN,
        "main",
        Err(ApiError::SessionEnded),
    ));
    insta::assert_snapshot!(screen(&mut app, 100, 24));
    assert_eq!(app.key(key('q')), vec![Effect::Exit(1)]);
}

#[test]
fn narrow_80x24() {
    let mut app = scenario_app("t-live");
    insta::assert_snapshot!(screen(&mut app, 80, 24));
}

#[test]
fn wide_200x60() {
    let mut app = scenario_app("t-live");
    insta::assert_snapshot!(screen(&mut app, 200, 60));
}

#[test]
fn steps_tab_just_code_hides_plan_and_approval() {
    let mut app = scenario_app("t-done");
    app.key(code(KeyCode::Tab));
    assert_eq!(app.tab, Tab::Steps);
    let shown = screen(&mut app, 120, 30);
    assert!(
        !shown.contains("Plan ") && !shown.contains("Approval"),
        "{shown}"
    );
    insta::assert_snapshot!(shown);
}

#[test]
fn diff_tab() {
    let state = fake::scenario();
    let mut app = scenario_app("t-done");
    // Enter on a result opens its changes.
    let fx = app.key(code(KeyCode::Enter));
    assert_eq!(app.tab, Tab::Diff);
    // The build waiting for review is the one read.
    let ask = diff_ask(&fx);
    assert_eq!((ask.task.as_str(), ask.run), ("t-done", Some(2)));
    let fx = app.update(Msg::Diff(ask, Ok(parse(state.diffs["t-done"].clone()))));
    let file = file_ask(&fx);
    assert_eq!((file.task.as_str(), file.run, file.file), ("t-done", 2, 0));
    app.update(Msg::DiffFile(
        file,
        Ok(parse(state.diff_files["t-done:0"].clone())),
    ));
    insta::assert_snapshot!(screen(&mut app, 120, 30));
    // } is the next file now ([ ] move between hunks).
    let next = file_ask(&app.key(key('}')));
    assert_eq!((next.task.as_str(), next.run, next.file), ("t-done", 2, 1));
}

#[test]
fn terminal_tab_and_help_and_quit() {
    let mut app = scenario_app("t-live");
    app.tab = Tab::Terminal;
    insta::assert_snapshot!("terminal_tab", screen(&mut app, 120, 30));
    app.key(key('?'));
    insta::assert_snapshot!("help", screen(&mut app, 120, 30));
    app.key(key('x'));
    assert_eq!(app.mode, Mode::Normal);
    // Owned: quitting asks whether the agents stop.
    app.owned = true;
    assert_eq!(app.key(key('q')), vec![]);
    insta::assert_snapshot!("quit", screen(&mut app, 120, 30));
    assert_eq!(app.key(key('s')), vec![Effect::Exit(EXIT_STOP)]);
    app.mode = Mode::Quit;
    assert_eq!(app.key(key('b')), vec![Effect::Exit(EXIT_KEEP)]);
}

#[test]
fn accept_and_send_back_post_the_review_facts() {
    let mut app = scenario_app("t-done");
    // a shows the changes first, then asks; Enter posts the plain completion of the receipt read: never an acceptance
    // (accept=1) of terms the terminal didn't show (a result that owes one is refused in words and accepted in the
    // browser).
    open_accept(&mut app);
    assert!(
        matches!(&app.mode, Mode::ConfirmAccept(pin) if pin.run == 2 && pin.receipt == "a".repeat(64))
    );
    insta::assert_snapshot!("accept_confirm", screen(&mut app, 120, 30));
    let fx = app.key(code(KeyCode::Enter));
    assert_eq!(
        fx,
        vec![Effect::Act {
            path: "/t/t-done/complete".into(),
            fields: vec![
                ("receipt".into(), "a".repeat(64)),
                ("run".into(), "2".into())
            ],
            done: "Accepted. The task is complete.".into()
        }]
    );
    app.key(key('a'));
    assert_eq!(app.key(key('x')), vec![]);
    assert_eq!(app.status.as_ref().unwrap().1, "Not accepted.");
    // Send back needs words, then shows the whole text to read to its end; Enter there sends exactly it.
    app.key(key('r'));
    assert_eq!(app.key(code(KeyCode::Enter)), vec![]);
    assert!(matches!(app.mode, Mode::SendBack(..)));
    for c in "keep the old column order".chars() {
        app.key(key(c));
    }
    assert_eq!(app.key(code(KeyCode::Enter)), vec![]);
    assert!(matches!(app.mode, Mode::SendReview { .. }));
    screen(&mut app, 120, 30);
    let fx = app.key(code(KeyCode::Enter));
    let Effect::Send { acts, .. } = &fx[0] else {
        panic!("{fx:?}")
    };
    let (path, fields) = (&acts[0].path, &acts[0].fields);
    assert_eq!(path, "/r/2/comment");
    let field = |k: &str| {
        fields
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.clone())
            .unwrap()
    };
    assert_eq!(
        (
            field("intent"),
            field("note"),
            field("batch"),
            field("source")
        ),
        (
            "revise".into(),
            "keep the old column order".into(),
            String::new(),
            "b".repeat(64)
        )
    );
    assert!(
        field("request").len() == 32 && field("request").chars().all(|c| c.is_ascii_hexdigit())
    );
    // No result waiting: nothing to accept, said in one line.
    let mut live = scenario_app("t-live");
    assert_eq!(live.key(key('a')), vec![]);
    assert_eq!(
        live.status.as_ref().unwrap().1,
        "No result is waiting for you on this task."
    );
}

#[test]
fn stop_and_pause_and_new_task() {
    let mut app = scenario_app("t-live");
    assert_eq!(app.key(key('x')), vec![]);
    insta::assert_snapshot!("confirm_stop", screen(&mut app, 120, 30));
    assert_eq!(
        app.key(key('y')),
        vec![Effect::Act {
            path: "/t/t-live/stop".into(),
            fields: vec![("run".into(), "7".into()), ("return".into(), "task".into())],
            done: "Stopping build #7.".into()
        }]
    );
    assert_eq!(app.key(key('x')), vec![]);
    assert_eq!(app.key(key('n')), vec![]);
    assert_eq!(app.status.as_ref().unwrap().1, "Not stopped.");
    let fx = app.key(key('p'));
    let Effect::Act { path, fields, done } = &fx[0] else {
        panic!()
    };
    assert_eq!(
        (path.as_str(), done.as_str()),
        ("/t/t-live/pause", "Pausing build #7.")
    );
    assert!(fields.iter().any(|(k, v)| k == "request" && v.len() >= 8));
    app.mode = Mode::Normal;
    app.key(key('n'));
    for c in "add a dark mode toggle".chars() {
        app.key(key(c));
    }
    insta::assert_snapshot!("new_task", screen(&mut app, 120, 30));
    assert_eq!(
        app.key(code(KeyCode::Enter)),
        vec![Effect::Act {
            path: "/tasks/add".into(),
            fields: vec![
                ("title".into(), "add a dark mode toggle".into()),
                ("repo".into(), "/home/me/shop".into())
            ],
            done: "Filed. A plan comes first.".into()
        }]
    );
    // A small task comes back as its exact terms: Enter is Build, p plans it first, Esc files nothing.
    let terms = ActOutcome::Terms {
        preview: "p".repeat(32),
        digest: "d".repeat(64),
        terms: vec![
            ("Goal".into(), "add a dark mode toggle".into()),
            ("Project".into(), "/home/me/shop".into()),
            (
                "Done when".into(),
                "The toggle switches the theme.\nThe choice is remembered.".into(),
            ),
        ],
    };
    assert_eq!(app.update(Msg::Acted(Ok(terms.clone()))), vec![]);
    assert!(matches!(app.mode, Mode::Build { .. }));
    // Not drawn yet: Enter builds nothing.
    assert_eq!(app.key(code(KeyCode::Enter)), vec![]);
    insta::assert_snapshot!("build_terms", screen(&mut app, 120, 30));
    assert_eq!(
        app.key(code(KeyCode::Enter)),
        vec![Effect::Act {
            path: "/tasks/fast".into(),
            fields: vec![
                ("preview".into(), "p".repeat(32)),
                ("digest".into(), "d".repeat(64))
            ],
            done: "Building it.".into()
        }]
    );
    app.update(Msg::Acted(Ok(terms.clone())));
    let fx = app.key(key('p'));
    let Effect::Act { path, fields, .. } = &fx[0] else {
        panic!()
    };
    assert_eq!(path, "/tasks/add");
    assert!(
        fields.contains(&("plan-first".into(), "1".into()))
            && fields.contains(&("title".into(), "add a dark mode toggle".into()))
    );
    app.update(Msg::Acted(Ok(terms)));
    assert_eq!(app.key(code(KeyCode::Esc)), vec![]);
    assert_eq!(app.status.as_ref().unwrap().1, "Nothing filed.");
}

#[test]
fn one_notification_per_ask() {
    let mut app = scenario_app("t-live");
    // The same list again: nothing new waits.
    let fx = app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    assert!(!fx.iter().any(|e| matches!(e, Effect::Notify(_))));
    // A build finishes and waits for review: one notification, once.
    let mut work = fake::scenario_work();
    work["rows"][2]["need"] = work["rows"][1]["need"].clone();
    work["rows"][2]["need"]["id"] = "t-live".into();
    work["rows"][2]["group"] = "review".into();
    work["rows"][2]["chip"] = "Result".into();
    let fx = app.update(Msg::Work(Ok(parse(work.clone()))));
    let notes: Vec<_> = fx
        .iter()
        .filter_map(|e| {
            if let Effect::Notify(w) = e {
                Some(w.clone())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(
        notes,
        vec!["Toolroll: Upgrade the test runner — result".to_string()]
    );
    let fx = app.update(Msg::Work(Ok(parse(work))));
    assert!(!fx.iter().any(|e| matches!(e, Effect::Notify(_))));
}

#[test]
fn a_record_reaches_the_screen_on_the_next_read() {
    let mut app = scenario_app("t-live");
    let before = screen(&mut app, 120, 30);
    assert!(!before.contains("Working on step 1000"));
    // The live room says it changed: the next window is read from the cursor at once.
    let fx = app.update(Msg::Signal(LiveSignal::Change(format!(
        "agent:{}",
        fake::LIVE_RUN
    ))));
    assert_eq!(
        fx,
        vec![
            Effect::FetchLive {
                run: fake::LIVE_RUN,
                file: "main",
                cursor: Some("c1".into())
            },
            Effect::FetchLive {
                run: fake::LIVE_RUN,
                file: "sub",
                cursor: Some("c1".into())
            },
        ]
    );
    let window = serde_json::json!({ "version": 1, "session": { "kind": "run", "id": 7, "task": "t-live" }, "room": "agent:7", "live": true, "file": "main",
        "window": { "ok": true, "records": fake::busy_records(1000, 1), "cursor": "c2", "restarted": false, "earlier": false, "quarantined": 0, "skipped": 0, "more": false } });
    app.update(Msg::Live(fake::LIVE_RUN, "main", Ok(parse(window))));
    assert!(screen(&mut app, 120, 30).contains("Working on step 1000"));
    // Without a signal, the tick reads on every 250 ms while the Live tab shows a live build.
    assert!(
        matches!(app.update(Msg::Tick).as_slice(), [Effect::FetchLive { cursor: Some(c), .. }, ..] if c == "c2")
    );
}

#[test]
fn hostile_text_is_drawn_inert() {
    let mut work = fake::scenario_work();
    work["rows"][0]["title"] = "evil\u{1b}]52;c;aGk=\u{7}\u{1b}[2J title".into();
    let mut app = app_with(work, "t-ask");
    let shown = screen(&mut app, 120, 30);
    assert!(!shown.contains('\u{1b}') && !shown.contains('\u{7}'));
}

#[test]
fn mouse_selects_scrolls_and_drags_the_divider() {
    let mut app = scenario_app("t-ask");
    screen(&mut app, 120, 30);
    let row_of = |app: &App, id: &str| {
        let index = app.items.iter().position(|i| i.id == id).unwrap();
        app.areas
            .rows
            .iter()
            .find(|(_, i)| *i == Some(index))
            .unwrap()
            .0
    };
    let y = row_of(&app, "t-live");
    let fx = app.mouse(MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: 3,
        row: y,
        modifiers: KeyModifiers::NONE,
    });
    assert_eq!(app.selected_item().unwrap().id, "t-live");
    assert!(fx.contains(&Effect::FetchSteps("t-live".into())));
    let split = app.areas.split_x;
    app.mouse(MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: split,
        row: 5,
        modifiers: KeyModifiers::NONE,
    });
    app.mouse(MouseEvent {
        kind: MouseEventKind::Drag(MouseButton::Left),
        column: 50,
        row: 5,
        modifiers: KeyModifiers::NONE,
    });
    app.mouse(MouseEvent {
        kind: MouseEventKind::Up(MouseButton::Left),
        column: 50,
        row: 5,
        modifiers: KeyModifiers::NONE,
    });
    assert_eq!(app.split, 50);
    // A click on a tab label switches to it.
    screen(&mut app, 120, 30);
    let (from, _, _) = *app
        .areas
        .tabs
        .iter()
        .find(|(_, _, t)| *t == Tab::Steps)
        .unwrap();
    app.mouse(MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: from,
        row: app.areas.right.y,
        modifiers: KeyModifiers::NONE,
    });
    assert_eq!(app.tab, Tab::Steps);
}

/// Long terms: every line whole, wrapped and scrolled; Enter builds only once the end was drawn, with exactly the
/// preview and digest the engine gave.
#[test]
fn build_terms_long_wrap_scroll_and_build_only_after_the_end() {
    let mut app = scenario_app("t-live");
    let long: String = (1..=30).map(|i| format!("Requirement {i}: the export keeps every column in the same order and escapes quotes properly.")).collect::<Vec<_>>().join("\n");
    let last = "Requirement 30: the export keeps every column in the same order and escapes quotes properly.";
    let terms = ActOutcome::Terms {
        preview: "p".repeat(32),
        digest: "d".repeat(64),
        terms: vec![("Goal".into(), "add CSV export with a header row, quoting, and a download button on the orders page".into()), ("Done when".into(), long)],
    };
    app.update(Msg::Acted(Ok(terms)));
    let first = screen(&mut app, 100, 30);
    assert!(first.contains("more lines: j or Space reads on") && !first.contains("Requirement 30"));
    insta::assert_snapshot!("build_terms_long_top", first);
    // Before the end: Enter refuses, in words, and sends nothing.
    assert_eq!(app.key(code(KeyCode::Enter)), vec![]);
    assert!(app
        .status
        .as_ref()
        .unwrap()
        .1
        .starts_with("Read the terms to the end first"));
    // Read on to the end (each step drawn), then Enter builds.
    let mut shown = String::new();
    for _ in 0..60 {
        app.key(key('j'));
        shown.push_str(&screen(&mut app, 100, 30));
    }
    // Every line of every term was drawn whole at some point (nothing cut with an ellipsis).
    for i in 1..=30 {
        assert!(
            shown.contains(&format!("Requirement {i}:")),
            "requirement {i} never shown"
        );
    }
    assert!(!shown
        .lines()
        .any(|l| l.contains("Requirement") && l.contains('…')));
    let end = screen(&mut app, 100, 30);
    assert!(end.contains(&last[..15]) && end.contains("Enter  Build"));
    insta::assert_snapshot!("build_terms_long_end", end);
    assert_eq!(
        app.key(code(KeyCode::Enter)),
        vec![Effect::Act {
            path: "/tasks/fast".into(),
            fields: vec![
                ("preview".into(), "p".repeat(32)),
                ("digest".into(), "d".repeat(64))
            ],
            done: "Building it.".into()
        }]
    );
}

/// A window too small to show the terms at all: no in-terminal Build, and the words say where to review them.
#[test]
fn build_terms_too_small_disables_build() {
    let mut app = scenario_app("t-live");
    app.update(Msg::Acted(Ok(ActOutcome::Terms {
        preview: "p".repeat(32),
        digest: "d".repeat(64),
        terms: vec![("Goal".into(), "add a dark mode toggle".into())],
    })));
    let small = screen(&mut app, 60, 10);
    assert!(
        small.contains("press w to review") || small.contains("too long to show"),
        "{small}"
    );
    insta::assert_snapshot!("build_terms_too_small", small);
    assert_eq!(app.key(code(KeyCode::Enter)), vec![]);
    assert!(matches!(app.mode, Mode::Build { .. }));
    assert_eq!(app.key(key('w')), vec![Effect::OpenBrowser]);
}

/// An answer is sent only once its question, the answer and its consequence were drawn whole.
#[test]
fn an_answer_is_sent_only_after_it_was_shown_whole() {
    let mut app = scenario_app("t-ask");
    app.key(key('1'));
    // Not drawn yet: Enter sends nothing.
    assert_eq!(app.key(code(KeyCode::Enter)), vec![]);
    assert_eq!(
        app.status.as_ref().unwrap().1,
        toolroll_tui::app::ANSWER_TOO_LONG
    );
    // Too small to hold it: still nothing.
    app.key(key('1'));
    let small = screen(&mut app, 60, 9);
    assert!(small.contains("too long to show here"), "{small}");
    assert_eq!(app.key(code(KeyCode::Enter)), vec![]);
    // Drawn whole: Enter sends exactly the option shown.
    app.key(key('1'));
    let shown = screen(&mut app, 120, 30);
    assert!(
        shown.contains("Keep the legacy /login?return= alias?")
            && shown.contains("Adds a deprecation log line.")
    );
    assert!(
        matches!(app.key(code(KeyCode::Enter)).as_slice(), [Effect::Act { path, fields, .. }] if path == "/d/31/answer" && fields[0] == ("choice".into(), "yes".into()))
    );
}

/// A dialog posts exactly the facts it showed; a refresh that changes them closes it, says so, and sends nothing.
#[test]
fn dialogs_post_the_facts_they_showed_and_close_when_those_change() {
    use toolroll_tui::app::{QUESTION_CHANGED, RESULT_CHANGED};
    let state = fake::scenario();
    let steps_with = |run: i64, receipt: &str| {
        let mut v = state.steps["t-done"].clone();
        v["review"] = serde_json::json!({ "run": run, "receipt": receipt, "source": "b".repeat(64), "accept": { "owed": null, "blockers": [], "needs": null } });
        parse::<StepCards>(v)
    };
    // Accept: a newer result arrives while the dialog is open.
    let mut app = scenario_app("t-done");
    open_accept(&mut app);
    app.update(Msg::Steps(
        "t-done".into(),
        Ok(steps_with(3, &"c".repeat(64))),
    ));
    assert_eq!(app.mode, Mode::Normal);
    assert_eq!(app.status.as_ref().unwrap().1, RESULT_CHANGED);
    assert!(no_act(app.key(code(KeyCode::Enter))));
    // Unchanged (the same steps read again): exactly the pinned run and receipt.
    let mut app = scenario_app("t-done");
    open_accept(&mut app);
    app.update(Msg::Steps(
        "t-done".into(),
        Ok(steps_with(2, &"a".repeat(64))),
    ));
    assert_eq!(
        app.key(code(KeyCode::Enter)),
        vec![Effect::Act {
            path: "/t/t-done/complete".into(),
            fields: vec![
                ("receipt".into(), "a".repeat(64)),
                ("run".into(), "2".into())
            ],
            done: "Accepted. The task is complete.".into()
        }]
    );
    // Send back: the result changes while the note is typed.
    let mut app = scenario_app("t-done");
    app.key(key('r'));
    for c in "keep the order".chars() {
        app.key(key(c));
    }
    app.update(Msg::Steps(
        "t-done".into(),
        Ok(steps_with(3, &"c".repeat(64))),
    ));
    assert_eq!(app.mode, Mode::Normal);
    assert_eq!(app.status.as_ref().unwrap().1, RESULT_CHANGED);
    // Answer: the question is replaced by another while the dialog is open.
    let mut app = scenario_app("t-ask");
    app.key(key('1'));
    screen(&mut app, 120, 30);
    let mut work = fake::scenario_work();
    work["rows"][0]["need"]["question"]["id"] = 32.into();
    app.update(Msg::Work(Ok(parse(work))));
    assert_eq!(app.mode, Mode::Normal);
    assert_eq!(app.status.as_ref().unwrap().1, QUESTION_CHANGED);
    assert!(no_act(app.key(code(KeyCode::Enter))));
    // Unchanged question: exactly the pinned question and option.
    let mut app = scenario_app("t-ask");
    app.key(key('2'));
    screen(&mut app, 120, 30);
    app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    assert!(
        matches!(app.key(code(KeyCode::Enter)).as_slice(), [Effect::Act { path, fields, .. }] if path == "/d/31/answer" && fields[0] == ("choice".into(), "no".into()))
    );
}

fn no_act(fx: Vec<Effect>) -> bool {
    !fx.iter().any(|e| matches!(e, Effect::Act { .. }))
}

/// Accept approves only the diff on screen: every read is keyed to task, build, file and generation, a late answer for
/// another build is dropped (never drawn under this build's facts), a new index drops the old hunks, and the dialog
/// opens and posts only while the diff shown, the pin and the steps' receipt agree; on any disagreement it closes and
/// says why.
#[test]
fn accept_never_approves_a_diff_other_than_the_one_shown() {
    use toolroll_tui::app::{ReviewPin, DIFF_DISAGREES};
    let state = fake::scenario();
    let steps_with = |run: i64, receipt: &str| {
        let mut v = state.steps["t-done"].clone();
        v["review"] = serde_json::json!({ "run": run, "receipt": receipt, "source": "b".repeat(64), "accept": { "owed": null, "blockers": [], "needs": null } });
        parse::<StepCards>(v)
    };
    let diff_of = |run: i64| {
        let mut d = state.diffs["t-done"].clone();
        d["run"] = run.into();
        d
    };
    let file_of = |run: i64, file: i64| {
        let mut f = state.diff_files[&format!("t-done:{file}")].clone();
        f["run"] = run.into();
        parse::<ResultDiffFile>(f)
    };

    // 1. Build 2's changes are asked; build 3 becomes the result waiting before they arrive.
    let mut app = scenario_app("t-done");
    let first = diff_ask(&app.key(code(KeyCode::Enter)));
    assert_eq!(first.run, Some(2));
    let second = diff_ask(&app.update(Msg::Steps(
        "t-done".into(),
        Ok(steps_with(3, &"c".repeat(64))),
    )));
    assert_eq!(second.run, Some(3));
    // Build 2's late answer is dropped: nothing is drawn, nothing more is asked.
    assert_eq!(
        app.update(Msg::Diff(first.clone(), Ok(parse(diff_of(2))))),
        vec![]
    );
    assert!(app.diff.is_none());
    // Nor does an answer that claims another build than the one its read asked for get in.
    assert_eq!(
        app.update(Msg::Diff(second.clone(), Ok(parse(diff_of(2))))),
        vec![]
    );
    assert!(app.diff.is_none());
    // Accept with no diff of build 3 on screen: it shows the changes first and opens nothing.
    let fx = app.key(key('a'));
    assert!(matches!(app.mode, Mode::Normal));
    let third = diff_ask(&fx);
    assert_eq!(third.run, Some(3));
    // The superseded read for build 3 is stale too (generation): only the newest read is taken.
    assert_eq!(app.update(Msg::Diff(second, Ok(parse(diff_of(3))))), vec![]);
    let fx = app.update(Msg::Diff(third, Ok(parse(diff_of(3)))));
    let file = file_ask(&fx);
    assert_eq!((file.run, file.file), (3, 0));
    // A file answer for another build, or another file, or an older read, is dropped.
    let stale = FileAsk {
        run: 2,
        ..file.clone()
    };
    app.update(Msg::DiffFile(stale.clone(), Ok(file_of(2, 0))));
    app.update(Msg::DiffFile(file.clone(), Ok(file_of(2, 0))));
    app.update(Msg::DiffFile(file.clone(), Ok(file_of(3, 1))));
    assert!(app.diff_file.is_none());
    app.update(Msg::DiffFile(file, Ok(file_of(3, 0))));
    assert_eq!(
        app.diff_file.as_ref().map(|f| (f.run, f.file.file)),
        Some((3, 0))
    );
    // Now the diff, the pin and the receipt agree: Accept posts build 3's receipt.
    assert_eq!(app.key(key('a')), vec![]);
    assert!(matches!(&app.mode, Mode::ConfirmAccept(pin) if pin.run == 3));
    assert_eq!(
        app.key(code(KeyCode::Enter)),
        vec![Effect::Act {
            path: "/t/t-done/complete".into(),
            fields: vec![
                ("receipt".into(), "c".repeat(64)),
                ("run".into(), "3".into())
            ],
            done: "Accepted. The task is complete.".into()
        }]
    );

    // 2. A new index drops the hunks drawn for the old one.
    let mut app = scenario_app("t-done");
    let fx = app.key(code(KeyCode::Enter));
    answer_diff(&mut app, &fx, diff_of(2));
    assert!(app.diff_file.is_some());
    let again = diff_ask(&app.update(Msg::Acted(Ok(ActOutcome::Done("ok".into())))));
    let mut changed = diff_of(2);
    changed["files"].as_array_mut().unwrap().remove(0);
    let fx = app.update(Msg::Diff(again, Ok(parse(changed))));
    assert!(app.diff_file.is_none(), "old hunks kept under a new index");
    assert_eq!(file_ask(&fx).file, 1);

    // 3. The dialog is open and a refreshed diff of the same build no longer matches what it showed: it closes, says
    // why, and Enter sends nothing.
    let mut app = scenario_app("t-done");
    open_accept(&mut app);
    let again = diff_ask(&app.update(Msg::Acted(Ok(ActOutcome::Refused("no".into())))));
    let mut grown = diff_of(2);
    grown["totals"] = serde_json::json!({ "files": 3, "additions": 9, "deletions": 1, "binary": 0, "filesTruncated": false });
    app.update(Msg::Diff(again, Ok(parse(grown))));
    assert_eq!(app.mode, Mode::Normal);
    assert_eq!(app.status.as_ref().unwrap().1, DIFF_DISAGREES);
    assert!(no_act(app.key(code(KeyCode::Enter))));

    // 4. A dialog pinned to build 2 while build 3's diff is on screen never posts (Accept rechecks at Enter).
    let mut app = scenario_app("t-done");
    let fx = app.key(code(KeyCode::Enter));
    answer_diff(&mut app, &fx, diff_of(2));
    let mut shown = app.diff.clone().unwrap();
    shown.run = Some(3);
    app.diff = Some(shown);
    app.mode = Mode::ConfirmAccept(ReviewPin {
        task: "t-done".into(),
        run: 2,
        receipt: "a".repeat(64),
        source: "b".repeat(64),
        totals: None,
    });
    assert!(no_act(app.key(code(KeyCode::Enter))));
    assert_eq!(app.status.as_ref().unwrap().1, DIFF_DISAGREES);
}
