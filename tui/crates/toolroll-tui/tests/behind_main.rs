//! Accepted work behind main (stranger 17): Land refuses it, so r is the way on from the terminal too. It opens Send
//! back with the task page's own feedback prefilled and posts exactly the task page's Send back (POST /r/<build>/comment
//! intent=revise, the build and source its step cards offer); the next attempt starts with main merged in. Without the
//! offer, r says there's nothing waiting, as before.
#[path = "common/pairs.rs"]
mod pairs;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use serde_json::{json, Value};
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, Effect, Mode, Msg};

const NOTE: &str = "main moved on since this work started. Make sure the work still fits with main's newer changes.";

fn parse<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).expect("fixture shape")
}
fn screen(app: &mut App, w: u16, h: u16) -> String {
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| toolroll_tui::view::draw(f, app)).unwrap();
    pairs::check(app, w, h);
    term.backend().to_string()
}
fn key(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)
}

/// t-old, Complete, with or without the step cards' behind-main offer.
fn on(offer: Option<Value>) -> App {
    let work = fake::scenario_work();
    let mut app = App::new(false, Some("/home/me/shop".into()));
    app.update(Msg::Work(Ok(parse(work))));
    let at = app
        .items
        .iter()
        .position(|i| i.id == "t-old")
        .expect("listed");
    while app.selected < at {
        app.key(key('j'));
    }
    let mut steps = fake::steps_for("t-old", "Old work", None, None);
    if let Some(offer) = offer {
        steps["behindMain"] = offer;
    }
    app.update(Msg::Steps("t-old".into(), Ok(parse(steps))));
    app
}

fn offer() -> Value {
    json!({ "run": 12, "receipt": "c".repeat(64), "source": "d".repeat(64), "main": "main", "behind": 1, "note": NOTE })
}

#[test]
fn r_on_accepted_work_behind_main_sends_it_back_with_the_task_pages_note() {
    let mut app = on(Some(offer()));
    assert!(screen(&mut app, 120, 32).contains("send back"));
    app.key(key('r'));
    assert!(
        matches!(&app.mode, Mode::SendBack(pin, typed) if pin.run == 12 && typed == NOTE),
        "{:?}",
        app.mode
    );
    assert_eq!(
        app.key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        vec![]
    );
    assert!(
        matches!(app.mode, Mode::SendReview { .. }),
        "{:?}",
        app.mode
    );
    screen(&mut app, 120, 32);
    let fx = app.key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    let Some(Effect::Send { acts, .. }) = fx.first() else {
        panic!("{fx:?}")
    };
    let field = |k: &str| {
        acts[0]
            .fields
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.clone())
            .unwrap()
    };
    assert_eq!(acts[0].path, "/r/12/comment");
    assert_eq!(
        (field("intent"), field("note"), field("source")),
        ("revise".into(), NOTE.into(), "d".repeat(64))
    );
}

#[test]
fn a_changed_offer_closes_the_send_back_and_sends_nothing() {
    let mut app = on(Some(offer()));
    app.key(key('r'));
    assert!(matches!(app.mode, Mode::SendBack(..)));
    // Someone landed or sent it back meanwhile: the offer is gone.
    app.update(Msg::Steps(
        "t-old".into(),
        Ok(parse(fake::steps_for("t-old", "Old work", None, None))),
    ));
    assert!(matches!(app.mode, Mode::Normal), "{:?}", app.mode);
}

#[test]
fn without_the_offer_r_still_says_nothing_waits() {
    let mut app = on(None);
    assert_eq!(app.key(key('r')), vec![]);
    assert_eq!(
        app.status.as_ref().unwrap().1,
        "No result is waiting for you on this task."
    );
}
