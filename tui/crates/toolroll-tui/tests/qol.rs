//! The workbench's second quality-of-life slice, drawn from the fake console's scenario: the command palette (and that
//! it runs exactly what each key runs), split layouts (and that keys reach only the focused panel), jumping to what
//! needs you, quick new task's line, the cost line, the step strip, saved filters, resuming where you left off, our own
//! clickable links, and a keymap warning.
#[path = "common/pairs.rs"]
mod pairs;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::backend::TestBackend;
use ratatui::style::Color;
use ratatui::Terminal;
use serde_json::Value;
use toolroll_api::*;
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, Effect, Filter, Mode, Msg, Section, Tab};
use toolroll_tui::keys::{Action, Scope, SPECS};
use toolroll_tui::palette::{self, Pick};
use toolroll_tui::panes::Layout;
use toolroll_tui::settings::{self, FileState, Prefs};
use toolroll_tui::state::Resume;

/// 4 min 12 s after the fixtures' builds started.
const NOW: i64 = 1_794_657_852;
const ORIGIN: &str = "http://127.0.0.1:4180";

fn parse<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).expect("fixture shape")
}
fn key(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)
}
fn code(c: KeyCode) -> KeyEvent {
    KeyEvent::new(c, KeyModifiers::NONE)
}

/// Answer the reads an update asked for from the scenario (steps, live windows), and the reads those answers ask.
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
                        let window = serde_json::json!({ "version": 1, "session": { "kind": "run", "id": run, "task": null }, "room": format!("agent:{run}"), "live": true, "file": file,
                            "window": { "ok": true, "records": records, "cursor": "c1", "restarted": false, "earlier": false, "quarantined": 0, "skipped": 0, "more": false } });
                        next.extend(app.update(Msg::Live(run, file, Ok(parse(window)))));
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

/// The scenario's work list read and `select` chosen, with its steps and live output.
fn app_with(prefs: Prefs, select: &str) -> App {
    let mut app = App::new(false, Some("/home/me/shop".into()));
    app.prefs = prefs;
    app.now = NOW;
    app.origin = Some(ORIGIN.into());
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

fn on(select: &str) -> App {
    app_with(Prefs::default(), select)
}

fn screen(app: &mut App, w: u16, h: u16) -> String {
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| toolroll_tui::view::draw(f, app)).unwrap();
    pairs::check(app, w, h);
    for cell in term.backend().buffer().content() {
        assert!(
            !matches!(
                cell.fg,
                Color::Yellow | Color::LightYellow | Color::Rgb(245, 165, 36)
            ),
            "amber at {:?}",
            cell.symbol()
        );
    }
    term.backend().to_string()
}

/// Effects with a fresh request identity's value left out (it is new on every press, by design).
fn shape(fx: &[Effect]) -> Vec<String> {
    fx.iter()
        .map(|e| match e {
            Effect::Act { path, fields, done } => {
                let fields: Vec<String> = fields
                    .iter()
                    .map(|(k, v)| {
                        if k == "request" || k == "key" {
                            k.clone()
                        } else {
                            format!("{k}={v}")
                        }
                    })
                    .collect();
                format!("Act {path} {fields:?} {done}")
            }
            other => format!("{other:?}"),
        })
        .collect()
}

/// What an app shows after a key or a pick: its mode, tab, selection, message and layout.
fn state_of(app: &App) -> String {
    format!(
        "{:?} | {:?} | {} | {:?} | {:?} | {:?}",
        app.mode, app.tab, app.selected, app.status, app.panes.layout, app.filter
    )
}

/// Run `action` through the palette the way a person would: open it, type its words, move to it, press Enter.
fn through_palette(app: &mut App, action: Action) -> Vec<Effect> {
    assert_eq!(app.key(key(':')), vec![]);
    assert!(matches!(app.mode, Mode::Palette(_)));
    let words = palette::entries(app)
        .into_iter()
        .find(|e| e.pick == Pick::Action(action))
        .map(|e| e.label)
        .unwrap_or_else(|| panic!("{} isn't offered here", action.id()));
    for c in words.chars() {
        app.key(key(c));
    }
    let Mode::Palette(p) = &app.mode else {
        panic!()
    };
    let found = palette::matches(app, &p.query);
    let at = found
        .iter()
        .position(|e| e.pick == Pick::Action(action))
        .unwrap_or_else(|| panic!("{} isn't offered for {words:?}", action.id()));
    for _ in 0..at {
        app.key(code(KeyCode::Down));
    }
    app.key(code(KeyCode::Enter))
}

#[test]
fn palette_open_and_filtered() {
    let mut app = on("t-live");
    app.key(key(':'));
    insta::assert_snapshot!("palette_open", screen(&mut app, 120, 32));
    for c in "acc".chars() {
        app.key(key(c));
    }
    insta::assert_snapshot!("palette_filtered", screen(&mut app, 120, 32));
    // Esc closes it, and nothing happened.
    assert_eq!(app.key(code(KeyCode::Esc)), vec![]);
    assert_eq!(app.mode, Mode::Normal);
    // Ctrl-K opens it too; it lists tasks and projects, with each action's key.
    app.key(KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL));
    assert!(matches!(app.mode, Mode::Palette(_)));
    let all = palette::entries(&app);
    assert!(all.iter().any(|e| e.pick == Pick::Task("t-done".into())));
    assert!(all.iter().any(|e| e.pick == Pick::Project("shop".into())));
    assert!(all
        .iter()
        .any(|e| e.pick == Pick::Action(Action::Accept) && e.key == "a"));
    // Picking a task shows it.
    let fx = app.run_pick(Pick::Task("t-done".into()));
    assert_eq!(app.selected_item().unwrap().id, "t-done");
    assert!(fx.contains(&Effect::FetchSteps("t-done".into())));
}

#[test]
fn every_palette_action_runs_the_same_path_as_its_key() {
    // Each action with a key, from the same screen both ways: the same effects, mode, tab, selection and words.
    for select in ["t-live", "t-done", "t-ask"] {
        for spec in SPECS
            .iter()
            .filter(|s| s.scope == Scope::Global && !s.keys.is_empty())
        {
            if spec.action == Action::Palette {
                continue;
            }
            let mut by_key = on(select);
            let mut by_palette = on(select);
            let chord = toolroll_tui::keys::parse_chord(spec.keys[0]).unwrap();
            let pressed = by_key.key(KeyEvent::new(chord.code, chord.mods));
            let picked = through_palette(&mut by_palette, spec.action);
            assert_eq!(shape(&pressed), shape(&picked), "{} on {select}", spec.id);
            assert_eq!(
                state_of(&by_key),
                state_of(&by_palette),
                "{} on {select}",
                spec.id
            );
        }
    }
    // The Diff tab's own, on a result's changes.
    for spec in SPECS.iter().filter(|s| s.scope == Scope::Diff) {
        let mk = || {
            let mut app = on("t-done");
            let fx = app.key(code(KeyCode::Enter));
            assert_eq!(app.tab, Tab::Diff);
            let state = fake::scenario();
            let ask = fx
                .iter()
                .find_map(|e| match e {
                    Effect::FetchDiff(a) => Some(a.clone()),
                    _ => None,
                })
                .unwrap();
            let fx = app.update(Msg::Diff(ask, Ok(parse(state.diffs["t-done"].clone()))));
            let ask = fx
                .iter()
                .find_map(|e| match e {
                    Effect::FetchDiffFile(a) => Some(a.clone()),
                    _ => None,
                })
                .unwrap();
            let mut file = state.diff_files[&format!("t-done:{}", ask.file)].clone();
            file["run"] = ask.run.into();
            app.update(Msg::DiffFile(ask, Ok(parse(file))));
            app.key(key('j'));
            app.key(key('j'));
            app
        };
        let (mut by_key, mut by_palette) = (mk(), mk());
        let chord = toolroll_tui::keys::parse_chord(spec.keys[0]).unwrap();
        let pressed = by_key.key(KeyEvent::new(chord.code, chord.mods));
        let picked = through_palette(&mut by_palette, spec.action);
        assert_eq!(shape(&pressed), shape(&picked), "{}", spec.id);
        assert_eq!(state_of(&by_key), state_of(&by_palette), "{}", spec.id);
        assert_eq!(by_key.diff_cursor, by_palette.diff_cursor, "{}", spec.id);
    }
    // An answer from the palette is its number: the same pinned question and the same dialog to confirm.
    let mut by_key = on("t-ask");
    let mut by_palette = on("t-ask");
    by_key.key(key('2'));
    by_palette.key(key(':'));
    for c in "Remove it".chars() {
        by_palette.key(key(c));
    }
    by_palette.key(code(KeyCode::Enter));
    assert!(matches!(by_key.mode, Mode::ConfirmAnswer(_)));
    assert_eq!(state_of(&by_key), state_of(&by_palette));
    // Accept from the palette still asks first (the same dialog, the same pins), and nothing is posted by the pick.
    let mut app = on("t-done");
    let fx = through_palette(&mut app, Action::Accept);
    assert!(
        fx.iter().all(|e| !matches!(e, Effect::Act { .. })),
        "{fx:?}"
    );
}

#[test]
fn split_layouts() {
    let mut app = on("t-live");
    let fx = app.key(key('L'));
    assert_eq!(app.panes.layout, Layout::SideBySide);
    answer(&mut app, fx);
    insta::assert_snapshot!("split_side_by_side", screen(&mut app, 160, 34));
    let fx = app.key(key('L'));
    assert_eq!(app.panes.layout, Layout::Grid);
    answer(&mut app, fx);
    let pinned: Vec<String> = app.panes.watches().map(|w| w.task.clone()).collect();
    assert_eq!(pinned, vec!["t-rate", "t-ask", "t-done"]);
    insta::assert_snapshot!("split_grid", screen(&mut app, 160, 40));
    // Back to one panel through the palette.
    let fx = through_palette(&mut app, Action::LayoutFocused);
    answer(&mut app, fx);
    assert_eq!(app.panes.layout, Layout::Focused);
    insta::assert_snapshot!("split_focused", screen(&mut app, 120, 30));
}

#[test]
fn keys_go_only_to_the_focused_panel() {
    let mut app = on("t-live");
    let fx = app.key(key('L'));
    answer(&mut app, fx);
    let watched = app.panes.slots[1].clone().unwrap();
    assert_eq!(watched.task, "t-rate");
    // Stop: the focused panel's build, never the watched one's.
    app.key(key('x'));
    assert_eq!(app.mode, Mode::ConfirmStop(fake::LIVE_RUN));
    screen(&mut app, 160, 34);
    let fx = app.key(key('y'));
    assert!(
        shape(&fx)
            .iter()
            .all(|e| e.contains("/t/t-live/") && !e.contains("t-rate")),
        "{fx:?}"
    );
    // Steering goes to the focused panel's agent.
    app.key(key('s'));
    for c in "use vitest".chars() {
        app.key(key(c));
    }
    let fx = app.key(code(KeyCode::Enter));
    assert!(shape(&fx)[0].starts_with("Act /t/t-live/steer"), "{fx:?}");
    assert_eq!(
        app.panes.slots[1].as_ref().unwrap().task,
        "t-rate",
        "the watched panel stays pinned"
    );
    // o moves focus: t-live is pinned where focus left, and t-rate is now the workbench's own.
    let fx = app.key(key('o'));
    assert_eq!(app.panes.focus, 1);
    assert_eq!(app.selected_item().unwrap().id, "t-rate");
    assert_eq!(app.panes.slots[0].as_ref().unwrap().task, "t-live");
    assert!(fx.contains(&Effect::FetchSteps("t-rate".into())));
    answer(&mut app, fx);
    // Now x is about t-rate (nothing builds there), never about the pinned t-live.
    let fx = app.key(key('x'));
    assert_eq!(fx, vec![]);
    assert_eq!(
        app.status.as_ref().unwrap().1,
        "Nothing is building or waiting on this task to stop."
    );
    // A click on the other panel moves focus back.
    screen(&mut app, 160, 34);
    let left = app.panes.areas[0];
    let fx = app.mouse(MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: left.x + 2,
        row: left.y + 3,
        modifiers: KeyModifiers::NONE,
    });
    answer(&mut app, fx);
    assert_eq!(app.panes.focus, 0);
    assert_eq!(app.selected_item().unwrap().id, "t-live");
    // A focused task with nothing building, a building one pinned beside it: stop, steer and pause are about the
    // focused task only (nothing to act on), never the pinned build.
    let mut app = on("t-done");
    let fx = app.key(key('L'));
    answer(&mut app, fx);
    assert_eq!(app.panes.slots[1].as_ref().unwrap().task, "t-live");
    for c in ['x', 's', 'p'] {
        assert_eq!(app.key(key(c)), vec![], "{c}");
        assert_eq!(app.mode, Mode::Normal, "{c}");
    }
}

#[test]
fn typing_in_a_terminal_stops_when_focus_moves() {
    use toolroll_tui::app::TermLink;
    // Take over t-done's result in the focused panel of a split.
    let mut app = on("t-done");
    let fx = app.key(key('L'));
    answer(&mut app, fx);
    app.key(key('t'));
    screen(&mut app, 160, 34);
    app.key(key('t'));
    app.update(Msg::TermOpened {
        task: "t-done".into(),
        run: fake::RESULT_RUN,
        result: Ok((
            fake::TERM_ID.into(),
            "toolroll/live".into(),
            TermLink(tokio::sync::mpsc::unbounded_channel().0),
        )),
    });
    app.update(Msg::Term(
        fake::TERM_ID.into(),
        TermEvent::Hello {
            cols: 60,
            rows: 20,
            ended: false,
        },
    ));
    assert_eq!(app.mode, Mode::TakeOver);
    screen(&mut app, 160, 34);
    // Typing reaches the focused terminal (o is the terminal's, not a panel move).
    let fx = app.key(key('o'));
    assert!(matches!(&fx[..], [Effect::TermSend { .. }]), "{fx:?}");
    assert_eq!(app.panes.focus, 0);
    // A click on the watched panel: typing stops, the terminal is let go of, focus moves.
    let right = app.panes.areas[1];
    let fx = app.mouse(MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: right.x + 2,
        row: right.y + 3,
        modifiers: KeyModifiers::NONE,
    });
    assert_ne!(app.mode, Mode::TakeOver);
    assert!(
        fx.contains(&Effect::TermDetach(fake::TERM_ID.into())),
        "{fx:?}"
    );
    assert_eq!(app.panes.focus, 1);
    assert!(app.term.is_none());
}

#[test]
fn jump_to_what_needs_you_oldest_first() {
    let mut app = on("t-live");
    // t-done waited 12 minutes, t-ask 3: the oldest first, then round again.
    app.key(key('!'));
    assert_eq!(app.selected_item().unwrap().id, "t-done");
    assert_eq!(app.status.as_ref().unwrap().1, "1 of 2 waiting on you.");
    app.key(key('!'));
    assert_eq!(app.selected_item().unwrap().id, "t-ask");
    app.key(key('!'));
    assert_eq!(app.selected_item().unwrap().id, "t-done");
    // A filter that hides it is set aside, saying so.
    app.set_filter(Filter::Project("nowhere".into()));
    assert!(app.items.is_empty());
    app.key(key('!'));
    assert_eq!(app.filter, Filter::All);
    assert_eq!(app.selected_item().unwrap().section, Section::NeedsYou);
}

#[test]
fn saved_filters_from_the_palette() {
    let mut app = on("t-live");
    through_palette(&mut app, Action::FilterNeedsMe);
    assert_eq!(app.filter, Filter::NeedsMe);
    assert_eq!(app.items.len(), 2);
    assert!(screen(&mut app, 120, 30).contains("Showing: Needs me"));
    // Remembered between runs.
    assert_eq!(app.resume_state().filter, Filter::NeedsMe);
    through_palette(&mut app, Action::FilterThisProject);
    assert_eq!(
        app.items.len(),
        app.all_items.len(),
        "every scenario task is in /home/me/shop"
    );
    through_palette(&mut app, Action::FilterToday);
    assert_eq!(app.filter, Filter::Today);
    // A project picked by name (not remembered).
    app.run_pick(Pick::Project("shop".into()));
    assert_eq!(app.filter, Filter::Project("shop".into()));
    assert_eq!(app.resume_state().filter, Filter::All);
    through_palette(&mut app, Action::FilterAll);
    assert_eq!(app.filter, Filter::All);
    // Without a project there is no "this project".
    let mut nowhere = App::new(false, None);
    nowhere.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    assert!(nowhere.set_filter(Filter::ThisProject).is_empty());
    assert_eq!(nowhere.filter, Filter::All);
}

#[test]
fn resume_where_you_left_off() {
    // The result's changes, scrolled, under the Needs me filter.
    let mut app = App::new(false, Some("/home/me/shop".into()));
    app.now = NOW;
    app.restore = Some(Resume {
        task: Some("t-done".into()),
        tab: Tab::Diff,
        scroll: 3,
        diff_file: 1,
        filter: Filter::NeedsMe,
        layout: Layout::Focused,
    });
    let fx = app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    assert_eq!(app.selected_item().unwrap().id, "t-done");
    assert_eq!(app.tab, Tab::Diff);
    assert_eq!(app.filter, Filter::NeedsMe);
    let state = fake::scenario();
    let ask = fx
        .iter()
        .find_map(|e| match e {
            Effect::FetchDiff(a) => Some(a.clone()),
            _ => None,
        })
        .expect("the diff is read");
    let fx = app.update(Msg::Diff(ask, Ok(parse(state.diffs["t-done"].clone()))));
    let ask = fx
        .iter()
        .find_map(|e| match e {
            Effect::FetchDiffFile(a) => Some(a.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(ask.file, 1, "the file left on");
    let mut file = state.diff_files[&format!("t-done:{}", ask.file)].clone();
    file["run"] = ask.run.into();
    app.update(Msg::DiffFile(ask, Ok(parse(file))));
    assert_eq!(app.diff_cursor, 3.min(app.rows.len() - 1));
    // The live output, scrolled up.
    let mut live = App::new(false, Some("/home/me/shop".into()));
    live.restore = Some(Resume {
        task: Some("t-live".into()),
        tab: Tab::Live,
        scroll: 2,
        layout: Layout::SideBySide,
        ..Resume::default()
    });
    let fx = live.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    answer(&mut live, fx);
    assert_eq!(live.selected_item().unwrap().id, "t-live");
    assert_eq!((live.scroll, live.follow), (2, false));
    assert_eq!(live.panes.layout, Layout::SideBySide);
    assert_eq!(live.resume_state().scroll, 2);
    // A task no longer listed: the list's first, nothing else carried.
    let mut gone = App::new(false, None);
    gone.restore = Some(Resume {
        task: Some("t-gone".into()),
        tab: Tab::Steps,
        ..Resume::default()
    });
    gone.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    assert_eq!((gone.selected, gone.tab), (0, Tab::Live));
}

#[test]
fn quick_new_task_line() {
    let mut app = on("t-live");
    app.agents = Some(parse(fake::scenario().agents.clone()));
    app.key(key('n'));
    for c in "Add a dark mode toggle".chars() {
        app.key(key(c));
    }
    insta::assert_snapshot!("quick_new_task", screen(&mut app, 120, 30));
    // Who it goes to is read when it isn't known yet.
    let mut fresh = on("t-live");
    assert_eq!(fresh.key(key('n')), vec![Effect::FetchAgents]);
}

#[test]
fn the_cost_line_and_its_switch() {
    let mut app = on("t-live");
    let top = |s: String| s.lines().next().unwrap().to_string();
    insta::assert_snapshot!("cost_line", top(screen(&mut app, 120, 30)));
    // The list's cost column, the task's steps together.
    let mut with_column = app_with(
        Prefs::new(
            settings::parse("columns = [\"cost\", \"step\"]").0,
            None,
            FileState::Missing,
            vec![],
            toolroll_tui::theme::Depth::Ansi16,
            None,
            Default::default(),
        ),
        "t-live",
    );
    assert!(screen(&mut with_column, 120, 30).contains("$0.31"));
    // show-costs = false: no cost anywhere.
    let hidden = settings::parse("show-costs = false").0;
    let mut quiet = app_with(
        Prefs::new(
            hidden,
            None,
            FileState::Missing,
            vec![],
            toolroll_tui::theme::Depth::Ansi16,
            None,
            Default::default(),
        ),
        "t-live",
    );
    assert!(!screen(&mut quiet, 120, 30).contains('$'));
    // The palette hides them for the session too.
    through_palette(&mut app, Action::Costs);
    assert!(!top(screen(&mut app, 120, 30)).contains("today"));
    // No spend from the console (someone who isn't an operator): nothing is said.
    let mut work = fake::scenario_work();
    work["spend"] = Value::Null;
    let mut none = App::new(false, None);
    none.update(Msg::Work(Ok(parse(work))));
    assert!(!top(screen(&mut none, 120, 30)).contains('$'));
}

#[test]
fn the_step_strip_ticks() {
    let mut app = on("t-live");
    let head = |s: String| s.lines().take(6).collect::<Vec<_>>().join("\n");
    insta::assert_snapshot!("step_strip", head(screen(&mut app, 120, 30)));
    app.now += 60;
    assert!(screen(&mut app, 120, 30).contains("Build ◐ 5m"));
}

#[test]
fn a_keymap_warning_is_said_and_the_default_kept() {
    let text = "[keys]\npreset = \"vim\"\naccept = \"j\"\nshout = \"!\"\n";
    let (s, warnings) = settings::parse(text);
    let p = Prefs::new(
        s,
        Some("/home/me/.config/toolroll/tui.toml".into()),
        FileState::Read,
        warnings
            .into_iter()
            .map(|w| format!("tui.toml: {w}"))
            .collect(),
        toolroll_tui::theme::Depth::Ansi16,
        None,
        Default::default(),
    );
    let first = p.first_warning();
    let mut app = app_with(p, "t-done");
    app.status = first.map(|w| (toolroll_tui::app::Tone::Said, w));
    insta::assert_snapshot!("remap_warning", screen(&mut app, 120, 30));
    // The preset is in use, and accept kept its own key.
    assert_eq!(app.prefs.settings.keymap.key_words(Action::Accept), "a");
    assert_eq!(
        app.prefs.settings.keymap.lookup(
            Scope::Global,
            &KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL)
        ),
        Some(Action::ScrollDown)
    );
}

#[test]
fn links_are_only_ours() {
    let mut app = on("t-live");
    screen(&mut app, 120, 30);
    assert_eq!(app.areas.links.len(), 1);
    assert_eq!(app.areas.links[0].url, "http://127.0.0.1:4180/t/t-live");
    // A transcript that carries a link of its own: drawn inert (no escape), never linked.
    let mut hostile = on("t-live");
    let run = fake::LIVE_RUN;
    let window = serde_json::json!({ "version": 1, "session": { "kind": "run", "id": run, "task": "t-live" }, "room": format!("agent:{run}"), "live": true, "file": "main",
        "window": { "ok": true, "records": [{ "k": "say", "at": "2026-11-14T12:00:00.000Z", "t": ["see \u{1b}]8;;https://evil.example\u{1b}\\the docs\u{1b}]8;;\u{1b}\\ https://evil.example/x"] }],
            "cursor": "c2", "restarted": false, "earlier": false, "quarantined": 0, "skipped": 0, "more": false } });
    hostile.update(Msg::Live(run, "main", Ok(parse(window))));
    let shown = screen(&mut hostile, 120, 30);
    assert!(shown.contains("https://evil.example/x"));
    assert!(!shown.contains('\u{1b}'));
    assert_eq!(hostile.areas.links.len(), 1);
    assert!(hostile
        .areas
        .links
        .iter()
        .all(|l| l.url.starts_with(ORIGIN) && !l.url.contains("evil")));
    // No console origin known: no link at all; a thread or an ask that is no task: none either.
    let mut no_origin = on("t-live");
    no_origin.origin = None;
    screen(&mut no_origin, 120, 30);
    assert!(no_origin.areas.links.is_empty());
    // Nothing is clickable under a dialog (its words may be drawn over the link's).
    let mut covered = on("t-live");
    covered.key(key(':'));
    screen(&mut covered, 120, 30);
    assert!(covered.areas.links.is_empty());
}
