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

fn click_attention(app: &mut App) -> Vec<Effect> {
    draw(app, 120, 30);
    let chip = app.areas.needs_chip;
    assert!(chip.width > 0);
    app.mouse(MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: chip.x + 1,
        row: chip.y,
        modifiers: KeyModifiers::NONE,
    })
}

#[test]
fn attention_click_preserves_steering_draft_and_target() {
    let mut app = on("t-live");
    app.key(key('s'));
    app.paste("Use the existing runner");
    assert!(click_attention(&mut app).is_empty());
    assert_eq!(app.selected_item().unwrap().id, "t-live");
    assert_eq!(app.mode, Mode::Steer("Use the existing runner".into()));
}

#[test]
fn attention_click_stays_on_oldest_while_next_cycles() {
    let mut app = on("t-done");
    assert!(click_attention(&mut app).is_empty());
    assert_eq!(app.selected_item().unwrap().id, "t-done");
    let fx = app.key(key('!'));
    answer(&mut app, fx);
    assert_eq!(app.selected_item().unwrap().id, "t-ask");
    let fx = click_attention(&mut app);
    answer(&mut app, fx);
    assert_eq!(app.selected_item().unwrap().id, "t-done");
}

#[test]
fn filtered_jump_reloads_detail_when_tasks_share_a_row_index() {
    let mut app = on("t-live");
    app.key(key('/'));
    let fx = app.paste("test runner");
    answer(&mut app, fx);
    app.key(code(KeyCode::Enter));
    let fx = app.key(key('@'));
    answer(&mut app, fx);
    assert_eq!(app.selected_item().unwrap().id, "t-ask");
    assert_eq!(app.steps.as_ref().unwrap().task.id, "t-ask");
}

#[test]
fn only_visible_panel_owns_navigation_and_escape_reveals_list() {
    for layout in ["zoom", "hidden"] {
        let mut app = on("t-live");
        if layout == "zoom" {
            app.key(key('z'));
        } else {
            app.key(key('b'));
            app.key(key('b'));
        }
        draw(&mut app, 120, 30);
        app.key(key('j'));
        assert_eq!(app.selected_item().unwrap().id, "t-live");
        assert_eq!(app.effective_focus(), Focus::Detail);
        app.key(code(KeyCode::Esc));
        draw(&mut app, 120, 30);
        assert_eq!(app.effective_focus(), Focus::List);
        assert!(app.areas.list.width > 0);
    }
}

#[test]
fn terminal_releases_list_bindings_on_escape() {
    let mut app = on("t-live");
    app.tab = Tab::Terminal;
    app.focus = Focus::Detail;
    app.term = Some(toolroll_tui::term::Pane::opening("t-live".into(), fake::LIVE_RUN));
    draw(&mut app, 120, 30);
    app.key(code(KeyCode::Esc));
    app.key(key('n'));
    assert!(matches!(app.mode, Mode::NewTask(..)));
}

#[test]
fn compact_panel_keeps_the_live_clock_visible_as_time_passes() {
    let mut app = on("t-live");
    for seconds in [12, 13] {
        let shown = draw(&mut app, 80, 24).backend().to_string();
        assert!(shown.contains(&format!("Build · 4m {seconds}s")), "{shown}");
        app.now += 1;
    }
}

#[test]
fn help_shows_custom_shortcuts_for_filters_and_settings() {
    use toolroll_tui::keys::{Keymap, Written};
    let mut app = on("t-live");
    let (map, warnings) = Keymap::build(None, &[
        (1, "filter-needs-me".into(), Written::Keys(vec!["f3".into()])),
        (2, "next-theme".into(), Written::Keys(vec!["f4".into()])),
    ]);
    assert!(warnings.is_empty());
    app.prefs.settings.keymap = map;
    app.key(key('?'));
    let help = draw(&mut app, 160, 64).backend().to_string();
    assert!(help.lines().any(|row| row.contains("F3") && row.contains("Needs me")), "{help}");
    assert!(help.lines().any(|row| row.contains("F4") && row.contains("Next theme")), "{help}");
}

fn left_click(area: ratatui::layout::Rect) -> MouseEvent {
    MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: area.x,
        row: area.y,
        modifiers: KeyModifiers::NONE,
    }
}

#[test]
fn click_the_field_to_steer_and_send_to_the_displayed_attempt() {
    use toolroll_tui::app::ComposerClick;
    let mut app = on("t-live");
    draw(&mut app, 80, 24);
    let (field, run, hit) = app.areas.steer_targets[0];
    assert_eq!(hit, ComposerClick::Action(Action::Steer));
    assert!(app.mouse(left_click(field)).is_empty());
    assert_eq!(app.mode, Mode::Steer(String::new()));
    app.paste("Check the navigation");
    draw(&mut app, 160, 40);
    let (button, _, _) = app.areas.steer_targets.iter().find(|(_, _, hit)| *hit == ComposerClick::Send).copied().unwrap();
    let effects = app.mouse(left_click(button));
    assert!(matches!(effects.as_slice(), [Effect::Act { path, fields, .. }]
        if path.ends_with("/steer") && fields.contains(&("note".into(), "Check the navigation".into()))
            && fields.contains(&("run".into(), run.to_string()))));
}

#[test]
fn only_a_visible_live_stage_animates_and_reduced_motion_keeps_the_clock() {
    let mut app = on("t-live");
    app.spinner_frame = 1;
    let shown = draw(&mut app, 80, 24).backend().to_string();
    assert!(app.areas.spinner_visible && shown.contains("◓ Build · 4m 12s"), "{shown}");
    app.prefs.settings.reduced_motion = true;
    app.now += 1;
    let shown = draw(&mut app, 80, 24).backend().to_string();
    assert!(!app.areas.spinner_visible && shown.contains("◐ Build · 4m 13s"), "{shown}");
    app.prefs.settings.reduced_motion = false;
    app.key(key('?'));
    draw(&mut app, 80, 24);
    assert!(!app.areas.spinner_visible);
    app = on("t-done");
    draw(&mut app, 80, 24);
    assert!(app.areas.steer_targets.is_empty() && !app.areas.spinner_visible);
}

#[test]
fn every_visible_stage_opens_from_its_drawn_cells_without_sending_an_action() {
    for key in ["plan", "approve", "build", "checks", "ready"] {
        let mut app = on("t-live");
        let drawn = draw(&mut app, 160, 42);
        let (rect, _, link) = app
            .areas
            .steps
            .iter()
            .find(|(_, _, l)| l.step == key)
            .unwrap()
            .clone();
        let label = &link.step;
        let cell = drawn.backend().buffer()[(rect.x, rect.y)].symbol();
        assert!(!cell.is_empty(), "{label}");
        let fx = app.mouse(left_click(rect));
        assert!(fx.iter().all(|e| !matches!(e, Effect::Act { .. })));
        assert_eq!(app.focus, Focus::Detail);
        if key == "build" {
            assert_eq!(app.tab, Tab::Live);
        } else {
            assert_eq!(app.tab, Tab::Steps);
            assert_eq!(app.step_nav.expanded.as_deref(), Some(key));
            draw(&mut app, 48, 23);
            let (row, _, _) = app
                .areas
                .steps
                .iter()
                .rev()
                .find(|(_, _, l)| l.step == key)
                .unwrap()
                .clone();
            app.mouse(left_click(row));
            assert!(app.step_nav.expanded.is_none(), "{key}");
        }
    }
    let mut app = on("t-done");
    draw(&mut app, 160, 42);
    let (ready, _, _) = app
        .areas
        .steps
        .iter()
        .find(|(_, _, l)| l.step == "ready")
        .unwrap()
        .clone();
    let fx = app.mouse(left_click(ready));
    assert_eq!(app.tab, Tab::Diff);
    assert!(fx.iter().all(|e| !matches!(e, Effect::Act { .. })));
}

#[test]
fn step_navigation_scrolls_independently_and_ignores_a_stale_build_target() {
    let mut app = on("t-live");
    app.tab = Tab::Steps;
    app.focus = Focus::Detail;
    draw(&mut app, 120, 24);
    let (rect, _, _) = app
        .areas
        .steps
        .iter()
        .find(|(_, _, l)| l.step == "build")
        .unwrap()
        .clone();
    app.steps.as_mut().unwrap().live_run = Some(12345);
    assert!(app.mouse(left_click(rect)).is_empty());
    assert_eq!(app.tab, Tab::Steps);
    for _ in 0..5 {
        app.key(key('j'));
    }
    draw(&mut app, 48, 20);
    assert_eq!(app.step_nav.selected.as_deref(), Some("ready"));
    assert!(app.step_nav.offset > 0);
    app.key(code(KeyCode::Enter));
    assert_eq!(app.step_nav.expanded.as_deref(), Some("ready"));
    assert_eq!(app.scroll, 0);
    app.scroll_by(100);
    draw(&mut app, 48, 20);
    assert_eq!(app.step_nav.offset, 0);
}

#[test]
fn a_stage_in_another_panel_opens_on_that_task_after_its_steps_arrive() {
    let mut app = on("t-live");
    let fx = app.run_action(Action::LayoutGrid);
    answer(&mut app, fx);
    draw(&mut app, 220, 50);
    let (rect, _, link) = app.areas.steps.iter()
        .find(|(_, _, link)| link.task == "t-done" && link.step == "ready")
        .expect("visible Ready stage in the watched panel").clone();
    let fx = app.mouse(left_click(rect));
    answer(&mut app, fx);
    assert_eq!(app.items[app.selected].id, link.task);
    assert_eq!(app.tab, Tab::Diff);
}

#[test]
fn change_builder_on_an_existing_task_by_mouse_only_changes_its_build_route() {
    use toolroll_tui::app::BuilderControl;
    let mut app = on("t-rate");
    let s = app.steps.as_mut().unwrap();
    s.live_run = None;
    s.review = None;
    s.task.state = "queued".into();
    draw(&mut app, 100, 28);
    let (button, task) = app.areas.builder_button.clone().unwrap();
    let fx = app.mouse(left_click(button));
    assert!(matches!(fx.as_slice(), [Effect::FetchTaskBuilder {task: t, ..}] if t == &task));
    app.update(Msg::TaskBuilder(
        task.clone(),
        Ok(toolroll_api::BuilderPicker::Choices(
            toolroll_api::TaskBuilder {
                digest: "a".repeat(32),
                current: Some("claude|opus".into()),
                choices: vec!["claude|opus".into(), "codex|sol".into()],
            },
        )),
    ));
    draw(&mut app, 48, 24);
    assert!(!app
        .areas
        .builder_controls
        .iter()
        .any(|(_, c)| matches!(c, BuilderControl::Save)));
    let (row, _) = *app
        .areas
        .builder_controls
        .iter()
        .find(|(_, c)| matches!(c, BuilderControl::Choose(1)))
        .unwrap();
    assert!(app.mouse(left_click(row)).is_empty());
    let screen = draw(&mut app, 48, 24).backend().to_string();
    assert!(screen.contains("Next builder: codex · sol"), "{screen}");
    let (save, _) = *app
        .areas
        .builder_controls
        .iter()
        .find(|(_, c)| matches!(c, BuilderControl::Save))
        .unwrap();
    let fx = app.mouse(left_click(save));
    assert!(matches!(fx.as_slice(), [Effect::Act {path,fields,..}]
        if path == &format!("/t/{task}/route") && fields.contains(&("phase".into(),"build".into()))
        && fields.contains(&("agent".into(),"codex|sol".into())) && fields.contains(&("sawDigest".into(),"a".repeat(32)))));
    assert_eq!(app.mode, Mode::Normal);
}

#[test]
fn a_password_required_to_change_builders_opens_only_the_selected_task() {
    use toolroll_tui::app::BuilderControl;
    let mut app = on("t-rate");
    let s = app.steps.as_mut().unwrap();
    s.live_run = None;
    s.review = None;
    s.task.state = "failed".into();
    let task = s.task.id.clone();
    let fx = app.update(Msg::Acted(Ok(toolroll_api::ActOutcome::BuilderPassword {
        task: task.clone(),
        setup: false,
    })));
    assert!(fx.is_empty());
    for (w, h) in [(48, 24), (120, 40)] {
        let screen = draw(&mut app, w, h).backend().to_string();
        assert!(screen.contains("Change builder in browser"), "{screen}");
        assert!(screen.contains("Open task"), "{screen}");
    }
    let (button, _) = *app
        .areas
        .builder_controls
        .iter()
        .find(|(_, c)| matches!(c, BuilderControl::Save))
        .unwrap();
    assert_eq!(
        app.mouse(left_click(button)),
        vec![Effect::OpenBuilderPassword { task, setup: false }]
    );
}

#[test]
fn changing_the_builder_shows_the_saved_plan_above_the_previous_attempt() {
    let mut app = on("t-rate");
    let steps = app.steps.as_mut().unwrap();
    steps.task.state = "failed".into();
    steps.live_run = None;
    steps.review = None;
    let approval = steps
        .cards
        .as_mut()
        .unwrap()
        .iter_mut()
        .find(|card| card.key == "approve")
        .unwrap();
    approval.terms = Some(parse(serde_json::json!({
        "key": "new-plan", "revision": null, "warnings": [], "usualLabel": "", "usual": [],
        "rows": [{"label": "Your pick", "words": "builder Codex · gpt-6-sol", "lines": []}]
    })));
    let screen = draw(&mut app, 150, 36).backend().to_string();
    assert!(
        screen.contains("Awaiting approval · builder Codex · gpt-6-sol"),
        "{screen}"
    );
    assert!(screen.contains("Last build:"), "{screen}");
}
