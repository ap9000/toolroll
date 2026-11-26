//! Landed work reads as landed in the workbench (stranger 17): the list row and the head under the title say where it
//! landed, as the task page leads with it, and Land on it answers with that fact, never a refusal.
#[path = "common/pairs.rs"]
mod pairs;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use serde_json::{json, Value};
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, Msg, Tone};
use toolroll_tui::keys::Action;
use toolroll_tui::palette::Pick;

fn parse<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).expect("fixture shape")
}
fn screen(app: &mut App, w: u16, h: u16) -> String {
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| toolroll_tui::view::draw(f, app)).unwrap();
    pairs::check(app, w, h);
    term.backend().to_string()
}

/// t-old, Complete, its work landed on main (Work's `landed` and the step cards' own landing).
fn landed(reverted: bool) -> App {
    let words = if reverted {
        "Landed on main (6a87b47) · a later commit reverted it"
    } else {
        "Landed on main (6a87b47)."
    };
    let mut work = fake::scenario_work();
    for row in work["rows"].as_array_mut().unwrap().iter_mut() {
        if row["id"] == "t-old" {
            row["landed"] = json!(words.trim_end_matches('.'));
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
    steps["landing"] = json!({ "words": words, "reverted": reverted });
    app.update(Msg::Steps("t-old".into(), Ok(parse(steps))));
    app
}

#[test]
fn the_row_and_the_head_say_where_it_landed() {
    let mut app = landed(false);
    let shown = screen(&mut app, 140, 32);
    assert!(shown.contains("landed on main (6a87b47)"), "{shown}");
    assert!(shown.contains("Landed on main (6a87b47)"), "{shown}");
}

#[test]
fn land_on_landed_work_says_the_fact_and_asks_nothing() {
    let mut app = landed(false);
    assert_eq!(app.run_pick(Pick::Action(Action::Land)), vec![]);
    assert_eq!(
        app.status,
        Some((Tone::Said, "Already landed on main (6a87b47).".to_string()))
    );
    let mut app = landed(true);
    assert_eq!(app.run_pick(Pick::Action(Action::Land)), vec![]);
    assert_eq!(
        app.status,
        Some((
            Tone::Said,
            "Landed on main (6a87b47) · a later commit reverted it.".to_string()
        ))
    );
}
