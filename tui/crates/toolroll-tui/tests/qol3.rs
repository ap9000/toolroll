//! The workbench's third quality-of-life slice (herdr-inspired), drawn from the fake console's scenario: the view kept
//! per project, resizing and collapsing the list, zoom, the list's side, the narrow layout, jumping to what needs you
//! and back, unread marks, searching a pane, opening it in an editor, and focus following the mouse.
#[path = "common/pairs.rs"]
mod pairs;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::backend::TestBackend;
use ratatui::style::{Color, Modifier};
use ratatui::Terminal;
use serde_json::Value;
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, Effect, Filter, Mode, Msg, Section, Tab};
use toolroll_tui::keys::Action;
use toolroll_tui::palette::{self, Pick};
use toolroll_tui::panes::Layout;
use toolroll_tui::settings::{self, Prefs};
use toolroll_tui::viewstate::{self, ListState, Side, View, ViewFile};

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

fn app_with(prefs: Prefs, select: &str) -> App {
    let mut app = App::new(false, Some("/home/me/shop".into()));
    app.prefs = prefs;
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

fn on(select: &str) -> App {
    app_with(Prefs::default(), select)
}

fn draw(app: &mut App, w: u16, h: u16) -> Terminal<TestBackend> {
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
    term
}

fn screen(app: &mut App, w: u16, h: u16) -> String {
    draw(app, w, h).backend().to_string()
}

fn ids(app: &App) -> Vec<String> {
    app.items.iter().map(|i| i.id.clone()).collect()
}

fn selected(app: &App) -> String {
    app.selected_item().unwrap().id.clone()
}

fn said(app: &App) -> String {
    app.status.as_ref().map(|s| s.1.clone()).unwrap_or_default()
}

fn mouse(app: &mut App, kind: MouseEventKind, column: u16, row: u16) -> Vec<Effect> {
    app.mouse(MouseEvent {
        kind,
        column,
        row,
        modifiers: KeyModifiers::NONE,
    })
}

/// Run `action` through the palette: open it, type its words, move to it, press Enter.
fn through_palette(app: &mut App, action: Action) -> Vec<Effect> {
    app.key(key(':'));
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
        .unwrap();
    for _ in 0..at {
        app.key(code(KeyCode::Down));
    }
    app.key(code(KeyCode::Enter))
}

#[test]
fn needs_you_steps_both_ways_without_reordering_and_jumps_back() {
    let mut app = on("t-live");
    let order = ids(&app);
    let fx = app.key(key('!'));
    answer(&mut app, fx);
    assert_eq!(selected(&app), "t-done");
    let fx = app.key(key('!'));
    answer(&mut app, fx);
    assert_eq!(selected(&app), "t-ask");
    // Backwards with @.
    let fx = app.key(key('@'));
    answer(&mut app, fx);
    assert_eq!(selected(&app), "t-done");
    let fx = app.key(key('@'));
    answer(&mut app, fx);
    assert_eq!(selected(&app), "t-ask");
    assert_eq!(ids(&app), order, "the list's order never changes");
    // ' goes back to where the jumps started, and again returns.
    let fx = app.key(key('\''));
    answer(&mut app, fx);
    assert_eq!(selected(&app), "t-live");
    assert_eq!(said(&app), "Back where you were.");
    let fx = app.key(key('\''));
    answer(&mut app, fx);
    assert_eq!(selected(&app), "t-ask");
    // Nothing to go back to before any jump.
    let mut fresh = on("t-live");
    fresh.key(key('\''));
    assert_eq!(selected(&fresh), "t-live");
    assert!(said(&fresh).contains("Nowhere to go back to"));
}

#[test]
fn needs_filters_in_the_palette() {
    let mut app = on("t-live");
    for (action, filter, want) in [
        (
            Action::FilterNeedsMe,
            Filter::NeedsMe,
            vec!["t-ask", "t-done"],
        ),
        (
            Action::FilterWorking,
            Filter::Working,
            vec!["t-live", "t-rate"],
        ),
        (Action::FilterDone, Filter::Done, vec!["t-old"]),
        (Action::FilterFailed, Filter::Failed, vec![]),
    ] {
        let fx = through_palette(&mut app, action);
        answer(&mut app, fx);
        assert_eq!(app.filter, filter);
        let mut got = ids(&app);
        got.sort();
        assert_eq!(got, want, "{filter:?}");
    }
    // Each is offered under "needs".
    app.key(code(KeyCode::Esc));
    app.key(key(':'));
    for c in "needs".chars() {
        app.key(key(c));
    }
    let Mode::Palette(p) = &app.mode else {
        panic!()
    };
    let found: Vec<Pick> = palette::matches(&app, &p.query)
        .into_iter()
        .map(|e| e.pick)
        .collect();
    for a in [
        Action::FilterNeedsMe,
        Action::FilterWorking,
        Action::FilterFailed,
        Action::FilterDone,
    ] {
        assert!(found.contains(&Pick::Action(a)), "{a:?} under :needs");
    }
}

#[test]
fn the_list_cycles_full_rail_hidden_and_says_so_on_top() {
    let mut app = on("t-live");
    let full = screen(&mut app, 120, 30);
    assert!(full.contains("Upgrade the test runner"));
    app.key(key('b'));
    assert_eq!(app.list_state, ListState::Rail);
    let rail = screen(&mut app, 120, 30);
    let top = rail.lines().next().unwrap();
    assert!(top.contains("RAIL"), "{top}");
    // The rail: the needs-you count, then each task's mark; no titles.
    assert!(!rail.contains("Bump dependencies"), "{rail}");
    assert!(rail.lines().nth(3).unwrap().contains(" 2 "), "{rail}");
    // A click on a rail mark selects its task.
    let (y, _) = app
        .areas
        .rows
        .iter()
        .find(|(_, i)| *i == Some(0))
        .copied()
        .unwrap();
    let x = app.areas.list.x + 1;
    let fx = mouse(&mut app, MouseEventKind::Down(MouseButton::Left), x, y);
    answer(&mut app, fx);
    assert_eq!(app.selected, 0);
    insta::assert_snapshot!("qol3_rail", screen(&mut app, 120, 30));
    app.key(key('b'));
    assert_eq!(app.list_state, ListState::Hidden);
    let hidden = screen(&mut app, 120, 30);
    assert!(hidden.lines().next().unwrap().contains("LIST HIDDEN"));
    assert!(!hidden.contains("Needs you 2"), "{hidden}");
    insta::assert_snapshot!("qol3_hidden", hidden);
    // Keys still move through the hidden list.
    app.key(key('j'));
    assert_eq!(app.selected, 1);
    app.key(key('b'));
    assert_eq!(app.list_state, ListState::Full);
    assert!(!screen(&mut app, 120, 30)
        .lines()
        .next()
        .unwrap()
        .contains("HIDDEN"));
}

#[test]
fn resize_the_list_or_the_focused_split_and_even_them() {
    let mut app = on("t-live");
    let usual = app.split;
    app.key(key('>'));
    app.key(key('>'));
    assert_eq!(app.split, usual + 4);
    app.key(key('<'));
    assert_eq!(app.split, usual + 2);
    // Bounded both ways.
    for _ in 0..100 {
        app.key(key('<'));
    }
    assert_eq!(app.split, 24);
    for _ in 0..100 {
        app.key(key('>'));
    }
    assert_eq!(app.split, 120);
    app.key(key('='));
    assert_eq!(app.split, usual);
    // Side by side: the same keys move the split the focused panel shares.
    let fx = app.key(key('L'));
    answer(&mut app, fx);
    app.key(key('>'));
    assert_eq!(app.panes.ratio_x, 55);
    assert_eq!(app.split, usual, "the list stays put");
    // The right panel focused: wider moves the split left.
    app.focus_pane(1);
    app.key(key('>'));
    app.key(key('>'));
    assert_eq!(app.panes.ratio_x, 45);
    let shown = draw(&mut app, 160, 34);
    let [a, b] = [app.panes.areas[0], app.panes.areas[1]];
    assert!(b.width > a.width, "{a:?} {b:?}");
    drop(shown);
    for _ in 0..20 {
        app.key(key('>'));
    }
    assert_eq!(app.panes.ratio_x, 20);
    app.key(key('='));
    assert_eq!((app.panes.ratio_x, app.panes.ratio_y), (50, 50));
}

#[test]
fn zoom_shows_the_focused_panel_alone_and_comes_back() {
    let mut app = on("t-live");
    let fx = app.key(key('L'));
    answer(&mut app, fx);
    let fx = app.key(key('L'));
    answer(&mut app, fx);
    assert_eq!(app.panes.layout, Layout::Grid);
    app.key(key('z'));
    assert!(app.zoom);
    let zoomed = screen(&mut app, 160, 40);
    assert!(zoomed.lines().next().unwrap().contains("ZOOM"), "{zoomed}");
    // One panel: no watched panel's title, no list.
    assert!(!zoomed.contains("Pinned"), "{zoomed}");
    assert!(!zoomed.contains("Needs you 2"), "{zoomed}");
    insta::assert_snapshot!("qol3_zoom", zoomed);
    // The layout is kept underneath, and z brings it back.
    assert_eq!(app.panes.layout, Layout::Grid);
    app.key(key('z'));
    assert!(!app.zoom);
    let back = screen(&mut app, 160, 40);
    assert!(back.contains("Pinned"), "{back}");
    // The focused one is outlined heavy (it reads without colour too).
    assert!(back.contains('┏') && back.contains('┛'), "{back}");
}

#[test]
fn the_list_on_the_right_and_its_divider() {
    let mut prefs = Prefs::default();
    prefs.settings.list_side = Side::Right;
    let mut app = app_with(prefs, "t-live");
    app.side = Side::Right;
    let shown = screen(&mut app, 120, 30);
    let row = shown.lines().nth(3).unwrap();
    // The list's heading on the right half, the panel's tabs on the left.
    let work = row.find("Work").unwrap_or_else(|| panic!("{shown}"));
    let live = row.find("Live").unwrap_or_else(|| panic!("{shown}"));
    assert!(live < work, "{row}");
    insta::assert_snapshot!("qol3_right", shown);
    // Dragging the divider counts the width from the right edge.
    let split = app.areas.split_x;
    mouse(&mut app, MouseEventKind::Down(MouseButton::Left), split, 5);
    mouse(&mut app, MouseEventKind::Drag(MouseButton::Left), 70, 5);
    mouse(&mut app, MouseEventKind::Up(MouseButton::Left), 70, 5);
    // The list begins just right of where the divider was dropped, and runs to the frame's own edge.
    assert_eq!(app.split, app.areas.body.right() - 71);
    // The palette switches it back.
    let fx = through_palette(&mut app, Action::ListSide);
    assert!(fx.is_empty());
    assert_eq!(app.side, Side::Left);
}

#[test]
fn a_double_click_on_the_divider_resets_the_width() {
    let mut app = on("t-live");
    let usual = app.split;
    screen(&mut app, 120, 30);
    let split = app.areas.split_x;
    mouse(&mut app, MouseEventKind::Down(MouseButton::Left), split, 5);
    mouse(&mut app, MouseEventKind::Drag(MouseButton::Left), 60, 5);
    mouse(&mut app, MouseEventKind::Up(MouseButton::Left), 60, 5);
    assert_ne!(app.split, usual);
    screen(&mut app, 120, 30);
    let split = app.areas.split_x;
    mouse(&mut app, MouseEventKind::Down(MouseButton::Left), split, 5);
    mouse(&mut app, MouseEventKind::Up(MouseButton::Left), split, 5);
    mouse(&mut app, MouseEventKind::Down(MouseButton::Left), split, 5);
    assert_eq!(app.split, usual);
    assert_eq!(said(&app), "The list is back to its usual width.");
    assert!(!app.dragging);
}

#[test]
fn a_narrow_window_is_one_column() {
    let mut app = on("t-live");
    let fx = app.key(key('L'));
    answer(&mut app, fx);
    let shown = screen(&mut app, 60, 26);
    assert!(shown.lines().next().unwrap().contains("NARROW"), "{shown}");
    assert!(!shown.contains("Pinned"), "{shown}");
    assert!(!shown.contains("Needs you 2"), "{shown}");
    assert!(shown.contains("Live"), "{shown}");
    insta::assert_snapshot!("qol3_narrow", shown);
    // Wide again: everything back as it was.
    let wide = screen(&mut app, 160, 34);
    assert!(wide.contains("Pinned") && !wide.contains("NARROW"));
}

#[test]
fn unread_until_opened_and_counted_on_top() {
    let mut app = on("t-ask");
    // t-live finishes while another task is open.
    let mut work = fake::scenario_work();
    let rows = work["rows"].as_array_mut().unwrap();
    let old = rows.iter().find(|r| r["id"] == "t-old").unwrap().clone();
    let at = rows.iter().position(|r| r["id"] == "t-live").unwrap();
    let mut done = old;
    done["id"] = "t-live".into();
    done["title"] = "Upgrade the test runner".into();
    rows[at] = done;
    let fx = app.update(Msg::Work(Ok(parse(work))));
    answer(&mut app, fx);
    assert!(app.unread.contains("t-live"), "{:?}", app.unread);
    assert_eq!(app.unread.len(), 1);
    let item = app.items.iter().find(|i| i.id == "t-live").unwrap();
    assert_eq!(item.section, Section::Recent);
    let shown = screen(&mut app, 120, 30);
    assert!(
        shown.lines().next().unwrap().contains("1 unread"),
        "{shown}"
    );
    assert!(shown.contains("•"), "{shown}");
    // Kept in the view file's words until opened.
    assert_eq!(app.view_now().unread, vec!["t-live".to_string()]);
    let at = app.items.iter().position(|i| i.id == "t-live").unwrap();
    while app.selected != at {
        let fx = app.key(key(if app.selected < at { 'j' } else { 'k' }));
        answer(&mut app, fx);
    }
    assert!(app.unread.is_empty());
    assert!(!screen(&mut app, 120, 30).contains("unread"));
}

#[test]
fn the_view_round_trips_through_the_file_per_project() {
    let mut app = on("t-live");
    app.key(key('>'));
    app.key(key('b'));
    let fx = app.key(key('L'));
    answer(&mut app, fx);
    app.key(key('>'));
    app.unread.insert("t-old".into());
    let v = app.view_now();
    assert_eq!(v.list, ListState::Rail);
    assert_eq!(v.layout, Layout::SideBySide);
    assert_eq!(v.ratio_x, 55);
    assert_eq!(v.task.as_deref(), Some("t-live"));
    let mut file = ViewFile::default();
    let key_a = viewstate::project_key("/home/me/shop");
    file.put(&key_a, v.clone(), NOW);
    let back = ViewFile::parse(&file.text());
    assert_eq!(back.projects.get(&key_a).map(|(v, _)| v), Some(&v));
    // Another project's view is its own.
    assert!(!back
        .projects
        .contains_key(&viewstate::project_key("/home/me/other")));
    // A new run restores it: width, rail, splits and unread at once; layout, tab and task once work is in.
    let mut fresh = App::new(false, Some("/home/me/shop".into()));
    fresh.now = NOW;
    fresh.apply_view(v.clone());
    let fx = fresh.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    answer(&mut fresh, fx);
    assert_eq!(fresh.split, app.split);
    assert_eq!(fresh.list_state, ListState::Rail);
    assert_eq!(fresh.panes.layout, Layout::SideBySide);
    assert_eq!(fresh.panes.ratio_x, 55);
    assert_eq!(selected(&fresh), "t-live");
    assert!(fresh.unread.contains("t-old"));
    // Bad values never land: defaults instead.
    let bad = r#"{"version":1,"projects":{"p0123456789abcdef":{"listWidth":9999,"list":"sideways","ratioX":3,"task":"../x","unread":["a b"],"at":1}}}"#;
    let f = ViewFile::parse(bad);
    let (v, _) = f.projects.get("p0123456789abcdef").unwrap();
    assert_eq!(v, &View::default());
}

#[test]
fn search_the_focused_pane() {
    let mut app = on("t-live");
    assert_eq!(app.tab, Tab::Live);
    let reversed = |t: &Terminal<TestBackend>| {
        t.backend()
            .buffer()
            .content()
            .iter()
            .filter(|c| c.modifier.contains(Modifier::REVERSED))
            .count()
    };
    let unlit = reversed(&draw(&mut app, 120, 30));
    let live = screen(&mut app, 120, 30);
    assert!(live.contains("npm test"), "{live}");
    app.key(key('/'));
    assert!(matches!(app.mode, Mode::Search(_)));
    for c in "NPM".chars() {
        app.key(key(c));
    }
    let Mode::Search(s) = app.mode.clone() else {
        panic!()
    };
    assert!(s.count >= 1, "{s:?}");
    // Keys are the search's while it is open: j is typed, not a move.
    let before = app.selected;
    app.key(key('j'));
    assert_eq!(app.selected, before);
    app.key(code(KeyCode::Backspace));
    app.key(code(KeyCode::Enter));
    let Mode::Search(s) = app.mode.clone() else {
        panic!()
    };
    assert!(!s.typing);
    let n = s.count;
    app.key(key('n'));
    let Mode::Search(s2) = app.mode.clone() else {
        panic!()
    };
    assert_eq!(s2.at, 1 % n);
    app.key(key('N'));
    let Mode::Search(s3) = app.mode.clone() else {
        panic!()
    };
    assert_eq!(s3.at, 0);
    // Lit on screen: reversed, every theme.
    let term = draw(&mut app, 120, 30);
    let buf = term.backend().buffer();
    let lit = buf
        .content()
        .iter()
        .filter(|c| c.modifier.contains(Modifier::REVERSED))
        .map(|c| c.symbol().to_lowercase())
        .collect::<String>();
    assert!(lit.contains("npm"), "{lit:?}");
    let shown = term.backend().to_string();
    assert!(shown.contains("Search: NPM"), "{shown}");
    insta::assert_snapshot!("qol3_search", shown);
    // Esc leaves, and the lights go.
    app.key(code(KeyCode::Esc));
    assert_eq!(app.mode, Mode::Normal);
    assert!(app.search.is_none());
    assert_eq!(reversed(&draw(&mut app, 120, 30)), unlit);
}

#[test]
fn a_sign_in_pane_is_never_searched_or_exported() {
    for (task, sensitive) in [("agent:codex", true), ("agent:codex", false)] {
        let mut app = on("t-live");
        let mut pane = if sensitive {
            toolroll_tui::term::Pane::opening_sensitive(task.into())
        } else {
            toolroll_tui::term::Pane::opening(task.into(), 0)
        };
        pane.drawn = true;
        app.term = Some(pane);
        app.tab = Tab::Terminal;
        assert!(toolroll_tui::search::pane_text(&mut app).is_none());
        assert_eq!(app.key(key('/')), vec![]);
        assert_eq!(app.mode, Mode::Normal);
        assert_eq!(app.key(ctrl('e')), vec![]);
        assert_eq!(said(&app), "Nothing here to open in an editor.");
    }
}

#[test]
fn open_in_editor_hands_over_the_panes_cleaned_text() {
    let mut app = on("t-live");
    let fx = app.key(ctrl('e'));
    let [Effect::OpenInEditor { name, text }] = &fx[..] else {
        panic!("{fx:?}")
    };
    assert_eq!(name, "live");
    assert!(text.contains("npm test"), "{text}");
    assert!(!text.contains('\u{1b}'));
    // Nothing on a thread or the empty list.
    let mut empty = App::new(false, None);
    empty.update(Msg::Work(Ok(parse(fake::empty_work()))));
    assert_eq!(empty.key(ctrl('e')), vec![]);
}

#[test]
fn focus_follows_the_mouse_only_when_set() {
    for on_setting in [false, true] {
        let mut prefs = Prefs::default();
        prefs.settings.focus_follows_mouse = on_setting;
        let mut app = app_with(prefs, "t-live");
        let fx = app.key(key('L'));
        answer(&mut app, fx);
        screen(&mut app, 160, 34);
        let b = app.panes.areas[1];
        mouse(&mut app, MouseEventKind::Moved, b.x + 3, b.y + 3);
        assert_eq!(app.panes.focus, usize::from(on_setting));
        // Never while a dialog or the palette is open.
        if on_setting {
            app.key(key(':'));
            let a = app.panes.areas[0];
            mouse(&mut app, MouseEventKind::Moved, a.x + 3, a.y + 3);
            assert_eq!(app.panes.focus, 1);
        }
    }
}

#[test]
fn tui_toml_takes_the_side_and_focus_follows_mouse() {
    let (s, warns) = settings::parse("list_side = \"right\"\nfocus_follows_mouse = true\n");
    assert!(warns.is_empty(), "{warns:?}");
    assert_eq!(s.list_side, Side::Right);
    assert!(s.focus_follows_mouse);
    let (s, warns) = settings::parse("list_side = \"up\"\n");
    assert_eq!(s.list_side, Side::Left);
    assert_eq!(warns.len(), 1);
}

/// Accept's "the notes go with it" is part of the dialog: switched without a frame between, Enter waits for it to be
/// shown.
#[test]
fn accept_with_notes_switched_is_shown_before_enter() {
    use toolroll_tui::app::{ReviewPin, UNDRAWN};
    let mut app = on("t-done");
    app.mode = Mode::ConfirmAccept(ReviewPin {
        task: "t-done".into(),
        run: 2,
        receipt: "a".repeat(64),
        source: "b".repeat(64),
        totals: None,
    });
    screen(&mut app, 120, 30);
    let before = app.dialog_key();
    app.accept_attach = true;
    assert_ne!(app.dialog_key(), before);
    assert_eq!(app.key(code(KeyCode::Enter)), vec![]);
    assert_eq!(said(&app), UNDRAWN);
}

/// A dialog acts only once it was drawn, exactly as it is, in the last frame: a window too small to draw it (or two
/// keys in one read) never confirms anything. Esc still closes it. (Answer, stop, cancel, stop retrying, resume,
/// accept, build terms.)
#[test]
fn an_undrawn_dialog_takes_no_keys() {
    use toolroll_tui::app::{ReviewPin, UNDRAWN};
    type Opens = Box<dyn Fn(&mut App)>;
    let dialogs: Vec<(&str, &str, Opens, KeyEvent)> = vec![
        (
            "answer",
            "t-ask",
            Box::new(|a: &mut App| {
                a.key(key('1'));
            }),
            code(KeyCode::Enter),
        ),
        (
            "stop",
            "t-live",
            Box::new(|a: &mut App| {
                a.key(key('x'));
            }),
            key('y'),
        ),
        (
            "cancel",
            "t-live",
            Box::new(|a: &mut App| {
                a.key(key('X'));
            }),
            code(KeyCode::Enter),
        ),
        (
            "stop retrying",
            "t-live",
            Box::new(|a: &mut App| {
                a.mode = Mode::ConfirmHold {
                    task: "t-live".into(),
                };
            }),
            code(KeyCode::Enter),
        ),
        (
            "resume",
            "t-live",
            Box::new(|a: &mut App| {
                a.mode = Mode::ConfirmResume {
                    task: "t-live".into(),
                    hold: 41,
                };
            }),
            code(KeyCode::Enter),
        ),
        (
            "accept",
            "t-done",
            Box::new(|a: &mut App| {
                a.mode = Mode::ConfirmAccept(ReviewPin {
                    task: "t-done".into(),
                    run: 2,
                    receipt: "a".repeat(64),
                    source: "b".repeat(64),
                    totals: None,
                });
            }),
            code(KeyCode::Enter),
        ),
        (
            "build terms",
            "t-live",
            Box::new(|a: &mut App| {
                a.mode = Mode::Build {
                    title: "Fix it".into(),
                    preview: "p".into(),
                    digest: "d".repeat(64),
                    terms: vec![("Agent".into(), "claude sonnet".into())],
                    scroll: 0,
                    seen_end: true,
                };
            }),
            code(KeyCode::Enter),
        ),
    ];
    for (what, task, open, confirm) in dialogs {
        // Too small to draw anything.
        let mut app = on(task);
        open(&mut app);
        let opened = app.mode.clone();
        assert!(app.dialog_key().is_some(), "{what}");
        screen(&mut app, 30, 6);
        assert_eq!(app.drawn_dialog, None, "{what}");
        assert_eq!(app.key(confirm), vec![], "{what}");
        assert_eq!(said(&app), UNDRAWN, "{what}");
        assert_eq!(app.mode, opened, "{what}: still open, nothing done");
        // Opened and confirmed in one read (no frame between): the same.
        let mut app = on(task);
        screen(&mut app, 120, 30);
        open(&mut app);
        assert_eq!(app.key(confirm), vec![], "{what}");
        assert_eq!(said(&app), UNDRAWN, "{what}");
        // Drawn once, then a frame too small: no longer on screen, so refused again.
        let mut app = on(task);
        open(&mut app);
        screen(&mut app, 120, 30);
        assert!(app.drawn_dialog.is_some(), "{what}");
        screen(&mut app, 30, 6);
        assert_eq!(app.key(confirm), vec![], "{what}");
        assert_eq!(said(&app), UNDRAWN, "{what}");
        // Esc closes it, drawn or not.
        app.key(code(KeyCode::Esc));
        assert_eq!(app.mode, Mode::Normal, "{what}");
        // Drawn: the dialog is the one on screen, and its keys reach it.
        let mut app = on(task);
        open(&mut app);
        screen(&mut app, 120, 30);
        assert_eq!(app.drawn_dialog, app.dialog_key(), "{what}");
        app.key(confirm);
        assert_ne!(said(&app), UNDRAWN, "{what}");
    }
}
