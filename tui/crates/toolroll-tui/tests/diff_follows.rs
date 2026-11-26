//! The Diff tab follows the result waiting (everyday-9 E4): a revision that reached Ready while another tab was open is
//! a new result, so entering Diff reads its own changes, never the previous attempt's kept diff.
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::{json, Value};
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, Effect, Msg, Tab};

fn parse<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).expect("fixture shape")
}

/// t-old with its result waiting as build `waiting`, and the Diff kept from build `kept`; then Tab until Diff.
fn enter_diff(waiting: i64, kept: i64) -> Vec<Effect> {
    let mut app = App::new(false, Some("/home/me/shop".into()));
    app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    let at = app
        .items
        .iter()
        .position(|i| i.id == "t-old")
        .expect("listed");
    while app.selected < at {
        app.key(KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE));
    }
    app.update(Msg::Steps(
        "t-old".into(),
        Ok(parse(fake::steps_for(
            "t-old",
            "Old work",
            None,
            Some(waiting),
        ))),
    ));
    app.diff = Some(parse(
        json!({ "version": 1, "task": "t-old", "run": kept, "totals": null, "files": [], "patchTruncated": false, "problem": null }),
    ));
    let mut fx = vec![];
    for _ in 0..8 {
        if app.tab == Tab::Diff {
            break;
        }
        fx = app.key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    }
    assert_eq!(app.tab, Tab::Diff);
    fx
}

#[test]
fn a_newer_result_waiting_is_read_again_on_entering_diff() {
    let fx = enter_diff(7, 5);
    assert!(
        fx.iter().any(
            |e| matches!(e, Effect::FetchDiff(ask) if ask.task == "t-old" && ask.run == Some(7))
        ),
        "{fx:?}"
    );
}

#[test]
fn the_same_result_keeps_its_diff() {
    let fx = enter_diff(7, 7);
    assert!(
        !fx.iter().any(|e| matches!(e, Effect::FetchDiff(_))),
        "{fx:?}"
    );
}
