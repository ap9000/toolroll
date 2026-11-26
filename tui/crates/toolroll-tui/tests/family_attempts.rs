//! "attempt N" counts every build of the task, its revisions' included (stranger 17): sent back twice, the third build is
//! attempt 3 in the head and the Accept dialog, as the task page numbers its results, though its own version built once.
use serde_json::{json, Value};
use toolroll_api::StepCards;
use toolroll_fake_engine as fake;

fn parse<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).expect("fixture shape")
}

fn sent_back_twice(family: Option<Value>) -> StepCards {
    let mut steps = fake::steps_for("t-old", "Old work", None, None);
    for card in steps["cards"].as_array_mut().unwrap().iter_mut() {
        if card["key"] == "build" {
            card["runs"] = json!([6]);
        }
    }
    if let Some(family) = family {
        steps["familyBuilds"] = family;
    }
    parse(steps)
}

#[test]
fn the_third_build_of_a_twice_sent_back_task_is_attempt_three() {
    let steps = sent_back_twice(Some(json!([6, 4, 2])));
    assert_eq!(toolroll_tui::app::attempt_of(&steps, 6), Some(3));
    assert_eq!(toolroll_tui::app::attempt_of(&steps, 2), Some(1));
}

#[test]
fn an_older_console_without_the_family_counts_this_versions_builds() {
    let steps = sent_back_twice(None);
    assert_eq!(toolroll_tui::app::attempt_of(&steps, 6), Some(1));
}
