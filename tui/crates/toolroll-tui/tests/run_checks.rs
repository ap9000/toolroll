//! Run checks again from the workbench (everyday-9 E2): on accepted work whose checks are out of date or failed, the
//! palette's "Run checks again" posts exactly the task page's own Run checks (POST /r/<build>/checks, its level and
//! return), the build and level its step cards offer; the console decides who may. The list says the check fact on the
//! row, and an out-of-date check is never read as a failure.
#[path = "common/pairs.rs"]
mod pairs;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use serde_json::{json, Value};
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, Effect, Msg};
use toolroll_tui::keys::Action;
use toolroll_tui::palette::{self, Pick};
use toolroll_tui::review::Checks;

fn parse<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).expect("fixture shape")
}
fn screen(app: &mut App, w: u16, h: u16) -> String {
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| toolroll_tui::view::draw(f, app)).unwrap();
    pairs::check(app, w, h);
    term.backend().to_string()
}

/// t-old, Complete, with its check fact on the list row and the step cards' own check and offer.
fn on(check: &str, offer: Option<Value>) -> App {
    let mut work = fake::scenario_work();
    for row in work["rows"].as_array_mut().unwrap().iter_mut() {
        if row["id"] == "t-old" {
            row["check"] = json!(check);
        }
    }
    let mut app = App::new(false, Some("/home/me/shop".into()));
    app.update(Msg::Work(Ok(parse(work))));
    let at = app
        .items
        .iter()
        .position(|i| i.id == "t-old")
        .expect("listed");
    while app.selected < at {
        app.key(KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE));
    }
    let mut steps = fake::steps_for("t-old", "Old work", None, None);
    steps["check"] = json!(check);
    if let Some(offer) = offer {
        steps["runChecks"] = offer;
    }
    app.update(Msg::Steps("t-old".into(), Ok(parse(steps))));
    app
}

#[test]
fn out_of_date_checks_run_again_through_the_task_pages_own_post() {
    let mut app = on("stale", Some(json!({ "run": 12, "level": "full" })));
    // Said on the list row; never the failure word.
    let shown = screen(&mut app, 120, 32);
    assert!(shown.contains("checks out of date"), "{shown}");
    assert_eq!(toolroll_tui::view::facts_of(&app).checks, Checks::Stale);
    assert!(palette::entries(&app)
        .iter()
        .any(|e| e.pick == Pick::Action(Action::RunChecks)
            && e.label.starts_with("Run checks again")));
    let fx = app.run_pick(Pick::Action(Action::RunChecks));
    assert!(
        matches!(&fx[..], [Effect::Act { path, fields, .. }]
            if path == "/r/12/checks"
                && fields.as_slice() == [("level".to_string(), "full".to_string()), ("return".to_string(), "/t/t-old".to_string())]),
        "{fx:?}"
    );
}

#[test]
fn a_failed_check_after_acceptance_is_said_as_one_and_offered_again() {
    let mut app = on("failed", Some(json!({ "run": 12, "level": "quick" })));
    let shown = screen(&mut app, 120, 32);
    assert!(shown.contains("checks failed after acceptance"), "{shown}");
    let fx = app.run_pick(Pick::Action(Action::RunChecks));
    assert!(
        matches!(&fx[..], [Effect::Act { path, fields, .. }]
            if path == "/r/12/checks" && fields[0] == ("level".to_string(), "quick".to_string())),
        "{fx:?}"
    );
}

#[test]
fn nothing_is_asked_without_the_step_cards_offer() {
    let mut app = on("stale", None);
    assert!(!palette::entries(&app)
        .iter()
        .any(|e| e.pick == Pick::Action(Action::RunChecks)));
    assert_eq!(app.run_pick(Pick::Action(Action::RunChecks)), vec![]);
}
