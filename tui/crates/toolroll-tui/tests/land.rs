//! Land from the workbench (everyday-9 A4): B (or the palette's "Land") on a finished task asks the console what landing
//! does, shows exactly its lines, and Enter posts back exactly the key it read; any other key lands nothing.
#[path = "common/pairs.rs"]
mod pairs;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use serde_json::Value;
use toolroll_api::*;
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, Effect, Mode, Msg};
use toolroll_tui::keys::Action;
use toolroll_tui::palette::{self, Pick};

const KEY: &str = "0123456789abcdef";

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
fn on(select: &str) -> App {
    let mut app = App::new(false, Some("/home/me/shop".into()));
    app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    let at = app.items.iter().position(|i| i.id == select).expect("listed");
    while app.selected < at {
        app.key(key('j'));
    }
    app
}
fn terms(app: &mut App) {
    app.update(Msg::Acted(Ok(ActOutcome::LandTerms {
        key: KEY.into(),
        lines: vec![
            "Lands 1 commit on main: a.txt (+1 −1).".into(),
            "Checks passed on 540e3cc, whose files it lands exactly.".into(),
        ],
    })));
}

#[test]
fn land_on_a_finished_task_shows_the_consoles_lines_and_posts_exactly_that_key() {
    let mut app = on("t-old");
    assert!(palette::entries(&app).iter().any(|e| e.pick == Pick::Action(Action::Land)));
    let fx = app.run_pick(Pick::Action(Action::Land));
    assert!(
        matches!(&fx[..], [Effect::Act { path, fields, .. }] if path == "/t/t-old/land" && fields.is_empty()),
        "{fx:?}"
    );
    terms(&mut app);
    assert!(
        matches!(&app.mode, Mode::ConfirmLand { task, key, .. } if task == "t-old" && key == KEY),
        "{:?}",
        app.mode
    );
    let shown = screen(&mut app, 120, 32);
    assert!(shown.contains("Lands 1 commit on main"), "{shown}");
    let fx = app.key(code(KeyCode::Enter));
    assert!(
        matches!(&fx[..], [Effect::Act { path, fields, .. }]
            if path == "/t/t-old/land" && fields.as_slice() == [("key".to_string(), KEY.to_string())]),
        "{fx:?}"
    );
}

#[test]
fn any_other_key_lands_nothing() {
    let mut app = on("t-old");
    app.run_pick(Pick::Action(Action::Land));
    terms(&mut app);
    screen(&mut app, 120, 32);
    assert_eq!(app.key(code(KeyCode::Esc)), vec![]);
    assert_eq!(app.mode, Mode::Normal);
}

#[test]
fn land_is_not_offered_on_work_that_isnt_finished() {
    let mut app = on("t-live");
    assert!(!palette::entries(&app).iter().any(|e| e.pick == Pick::Action(Action::Land)));
    assert_eq!(app.run_pick(Pick::Action(Action::Land)), vec![]);
    // Terms arriving for a selection that isn't finished open nothing.
    terms(&mut app);
    assert_eq!(app.mode, Mode::Normal);
}

#[test]
fn b_lands_a_finished_task_through_the_same_path_and_the_key_bar_says_so() {
    let mut app = on("t-old");
    assert!(screen(&mut app, 120, 30).contains("B land"));
    let fx = app.key(key('B'));
    assert!(
        matches!(&fx[..], [Effect::Act { path, fields, .. }] if path == "/t/t-old/land" && fields.is_empty()),
        "{fx:?}"
    );
    // Not on work that isn't finished: nothing is asked.
    let mut live = on("t-live");
    assert!(!screen(&mut live, 120, 30).contains("B land"));
    assert_eq!(live.key(key('B')), vec![]);
}
