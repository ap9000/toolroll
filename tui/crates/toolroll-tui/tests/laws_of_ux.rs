//! Behavioral contracts for the Laws of UX TUI pass:
//! - Explicit List vs. Detail focus (`Focus::List` / `Focus::Detail`) eliminating `j`/`k` and `n` collisions
//! - Contextual `/` (live list filter in List focus, pane search in Detail focus)
//! - Single-home pipeline strip (Goal-Gradient + Prägnanz, preserving Question chips mid-build)
//! - Von Restorff / One Signal Rule (top-bar mode flags never steal solid ink from "Needs you"; clickable chip)
//! - Context-ranked command palette (state-valid actions surface first)
#[path = "common/pairs.rs"]
mod pairs;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::backend::TestBackend;
use ratatui::style::Modifier;
use ratatui::Terminal;
use serde_json::Value;
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, Effect, Focus, Mode, Msg, Tab};
use toolroll_tui::keys::Action;
use toolroll_tui::palette::{self, Pick};

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

fn answer(app: &mut App, fx: Vec<Effect>) {
    let state = fake::scenario();
    let mut todo = fx;
    for _ in 0..8 {
        let mut next = vec![];
        for e in todo.drain(..) {
            match e {
                Effect::FetchSteps(task) => {
                    if let Some(steps) = state.steps.get(&task) {
                        next.extend(app.update(Msg::Steps(task, Ok(parse(steps.clone())))));
                    }
                }
                Effect::FetchLive {
                    run,
                    file,
                    cursor: None,
                } => {
                    let records = if file == "main" {
                        state.live.get(&run).map(|(r, _)| r.clone())
                    } else {
                        state.sub.get(&run).cloned()
                    };
                    if let Some(records) = records {
                        let window = serde_json::json!({
                            "version": 1,
                            "session": { "kind": "run", "id": run, "task": null },
                            "room": format!("agent:{run}"),
                            "live": true,
                            "file": file,
                            "window": {
                                "ok": true, "records": records, "cursor": "c1",
                                "restarted": false, "earlier": false,
                                "quarantined": 0, "skipped": 0, "more": false
                            }
                        });
                        next.extend(app.update(Msg::Live(run, file, Ok(parse(window)))));
                    }
                }
                Effect::FetchDiff(ask) => {
                    if let Some(diff) = state.diffs.get(&ask.task) {
                        next.extend(app.update(Msg::Diff(ask, Ok(parse(diff.clone())))));
                    }
                }
                Effect::FetchDiffFile(ask) => {
                    if let Some(file) = state.diff_files.get(&format!("{}:{}", ask.task, ask.file))
                    {
                        let mut file = file.clone();
                        file["run"] = ask.run.into();
                        next.extend(app.update(Msg::DiffFile(ask, Ok(parse(file)))));
                    }
                }
                _ => {}
            }
        }
        if next.is_empty() {
            return;
        }
        todo = next;
    }
}

fn on(select: &str) -> App {
    let mut app = App::new(false, Some("/home/me/shop".into()));
    app.now = NOW;
    let fx = app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    answer(&mut app, fx);
    if let Some(i) = app.items.iter().position(|i| i.id == select) {
        for _ in 0..i {
            let fx = app.key(key('j'));
            answer(&mut app, fx);
        }
    }
    app
}

fn draw(app: &mut App, w: u16, h: u16) -> Terminal<TestBackend> {
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| toolroll_tui::view::draw(f, app)).unwrap();
    pairs::check(app, w, h);
    term
}

#[test]
fn explicit_list_vs_detail_focus_prevents_diff_key_collisions() {
    let mut app = on("t-done");
    assert_eq!(app.focus, Focus::List);

    // Enter opens Diff and moves focus into Detail.
    let fx = app.key(code(KeyCode::Enter));
    answer(&mut app, fx);
    assert_eq!(app.tab, Tab::Diff);
    assert_eq!(app.focus, Focus::Detail);

    // In Detail on Diff: j moves diff cursor, not task selection.
    let task_before = app.selected;
    let cursor_before = app.diff_cursor;
    app.key(key('j'));
    assert_eq!(app.selected, task_before);
    assert_eq!(app.diff_cursor, cursor_before + 1);

    // Esc returns focus cleanly to List while keeping the Diff tab visible on the right.
    app.key(code(KeyCode::Esc));
    assert_eq!(app.focus, Focus::List);
    assert_eq!(app.tab, Tab::Diff);

    // In List focus, `n` is ALWAYS New task (never hijacked by Diff's Next note).
    app.key(key('n'));
    assert!(matches!(app.mode, Mode::NewTask(..)));
    app.key(code(KeyCode::Esc));

    // In List focus, `j` moves to the next task even while Diff is shown on the right.
    let fx = app.key(key('j'));
    answer(&mut app, fx);
    assert_eq!(app.selected, task_before + 1);

    // Right focuses Detail again; Left returns to List.
    app.key(code(KeyCode::Right));
    assert_eq!(app.focus, Focus::Detail);
    app.key(code(KeyCode::Left));
    assert_eq!(app.focus, Focus::List);
}

#[test]
fn slash_filters_list_when_list_focused_and_searches_pane_when_detail_focused() {
    let mut app = on("t-live");
    let total = app.items.len();
    assert!(total >= 3);

    // In List focus: `/` opens live ListFilter and narrows visible tasks.
    app.key(key('/'));
    assert!(matches!(app.mode, Mode::ListFilter(_)));
    for c in "csv".chars() {
        let fx = app.key(key(c));
        answer(&mut app, fx);
    }
    assert_eq!(app.items.len(), 1);
    assert_eq!(app.selected_item().unwrap().id, "t-done");
    let shown = draw(&mut app, 120, 30).backend().to_string();
    assert!(shown.contains("Filter: csv"), "{shown}");

    // Enter opens the matched task and focuses Detail (keeping filter active until cleared).
    let fx = app.key(code(KeyCode::Enter));
    answer(&mut app, fx);
    assert_eq!(app.mode, Mode::Normal);
    assert_eq!(app.focus, Focus::Detail);

    // In Detail focus: `/` searches the focused pane instead of the list.
    app.key(key('/'));
    assert!(matches!(app.mode, Mode::Search(_)));
    app.key(code(KeyCode::Esc));

    // Returning to List (Esc) then pressing Esc clears the active list filter.
    app.key(code(KeyCode::Esc));
    assert_eq!(app.focus, Focus::List);
    let fx = app.key(code(KeyCode::Esc));
    answer(&mut app, fx);
    assert!(app.list_query.is_empty());
    assert_eq!(app.items.len(), total);
}

#[test]
fn pipeline_gives_each_fact_one_home_and_highlights_active_stage() {
    // Live build: exact clock on pipeline pill, no duplicate "Building now" in provenance.
    let mut app = on("t-live");
    let shown = draw(&mut app, 120, 30).backend().to_string();
    assert!(shown.contains("✓ Plan"), "{shown}");
    assert!(shown.contains("◐ Build · 4m 12s"), "{shown}");
    assert!(!shown.contains("Building now"), "{shown}");
    assert!(shown.contains("claude sonnet · $0.31 · attempt 1"), "{shown}");

    // Ready result: solid ink Ready chip on pipeline, no duplicate Result badge beside title.
    let mut app = on("t-done");
    let shown = draw(&mut app, 120, 30).backend().to_string();
    assert!(shown.contains("● Ready"), "{shown}");

    // Mid-build Question: keeps the Question ask chip visible on the title line.
    let mut app = on("t-ask");
    let shown = draw(&mut app, 120, 30).backend().to_string();
    assert!(shown.contains("Question"), "{shown}");
}

#[test]
fn top_bar_mode_flags_do_not_steal_solid_ink_and_needs_chip_is_clickable() {
    let mut app = on("t-live");
    app.key(key('z'));
    let term = draw(&mut app, 120, 30);
    let buf = term.backend().buffer();
    let top: String = (0..120).map(|x| buf[(x, 0)].symbol()).collect();
    let zoom_x = top.find("ZOOM").expect("ZOOM mark");
    let needs_x = top.find("2 need you").expect("needs chip");

    // Von Restorff / One Signal Rule: ZOOM is NOT reversed solid ink; "2 need you" IS.
    assert!(!buf[(zoom_x as u16, 0)].modifier.contains(Modifier::REVERSED));
    assert!(buf[(needs_x as u16, 0)].modifier.contains(Modifier::REVERSED));

    // Clicking the "2 need you" chip jumps straight to a waiting task (Fitts's Law).
    app.key(key('z'));
    draw(&mut app, 120, 30);
    assert_eq!(app.selected_item().unwrap().id, "t-live");
    let chip = app.areas.needs_chip;
    assert!(chip.width > 0);
    let fx = app.mouse(MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: chip.x + 1,
        row: chip.y,
        modifiers: KeyModifiers::NONE,
    });
    answer(&mut app, fx);
    assert_eq!(app.selected_item().unwrap().section, toolroll_tui::app::Section::NeedsYou);
}

#[test]
fn palette_ranks_state_relevant_actions_first() {
    // On a building task, Steer/Pause/Stop rank ahead of Accept.
    let app = on("t-live");
    let list = palette::matches(&app, "");
    let pos = |a: Action| list.iter().position(|e| e.pick == Pick::Action(a)).unwrap();
    assert!(pos(Action::Steer) < pos(Action::Accept));
    assert!(pos(Action::Pause) < pos(Action::Accept));

    // On a Ready result, Accept and SendBack rank ahead of Steer.
    let app = on("t-done");
    let list = palette::matches(&app, "");
    let pos = |a: Action| list.iter().position(|e| e.pick == Pick::Action(a)).unwrap();
    assert!(pos(Action::Accept) < pos(Action::Steer));
    assert!(pos(Action::SendBack) < pos(Action::Steer));

    // On a waiting Question, its Answer choices rank at the very top.
    let app = on("t-ask");
    let list = palette::matches(&app, "");
    assert!(matches!(list.first().map(|e| &e.pick), Some(Pick::Answer(0))));
}
