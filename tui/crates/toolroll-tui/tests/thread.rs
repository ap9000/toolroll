//! A Flexible thread as one more live session (F3), drawn from the contract's fixtures: listed with the work, its panel
//! (transcript, questions, the turn's level and cost) in each answer state, and the answer flow: `1-9` pins the
//! question shown, Enter posts exactly what was pinned, and a question that changed meanwhile is refused.
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use serde_json::{json, Value};
use toolroll_api::*;
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, Effect, Mode, Msg, Tone, ANSWER_TOO_LONG};
use toolroll_tui::thread::THREAD_QUESTION_CHANGED;

const NOW: i64 = 1_794_657_852;
const PERMISSION: &str = "c0ffee00c0ffee00c0ffee00c0ffee02";

fn parse<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).expect("fixture shape")
}
fn key(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)
}
fn enter() -> KeyEvent {
    KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
}
fn window() -> Value {
    fake::fixture("live-session-window-thread.json")
}
fn screen(app: &mut App, w: u16, h: u16) -> String {
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| toolroll_tui::view::draw(f, app)).unwrap();
    term.backend().to_string()
}

/// An app that read the scenario's work and the threads list, with the thread selected and its window read.
fn thread_app(window: Value) -> App {
    let mut app = App::new(false, Some("/home/me/shop".into()));
    app.now = NOW;
    let fx = app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    assert!(fx.contains(&Effect::FetchThreads), "{fx:?}");
    app.update(Msg::Threads(Ok(parse(fake::fixture("live-threads.json")))));
    let at = app
        .items
        .iter()
        .position(|i| i.id == fake::THREAD)
        .expect("the thread is listed");
    let mut asked = vec![];
    while app.selected < at {
        asked.extend(app.key(key('j')));
    }
    assert!(
        asked.iter().any(
            |e| matches!(e, Effect::FetchThread { thread, cursor: None } if thread == fake::THREAD)
        ),
        "{asked:?}"
    );
    app.update(Msg::Thread(fake::THREAD.into(), Ok(parse(window))));
    app
}

/// The window with the questions' states set, by request.
fn with_states(states: &[(&str, &str, bool)]) -> Value {
    let mut w = window();
    for q in w["thread"]["questions"].as_array_mut().unwrap() {
        if let Some((_, state, answerable)) = states.iter().find(|(r, _, _)| q["request"] == *r) {
            q["state"] = json!(state);
            q["answerable"] = json!(answerable);
        }
    }
    w
}

#[test]
fn a_thread_is_one_more_live_session_in_the_list() {
    let mut app = thread_app(window());
    let item = app.selected_item().unwrap().clone();
    assert!(item.thread && !item.is_task);
    assert_eq!(item.word, "Question");
    // Its panel: the transcript's cards, the turn's agent, level and cost, the question waiting on you.
    insta::assert_snapshot!("thread_waiting", screen(&mut app, 120, 30));
}

#[test]
fn each_answer_state_is_said_plainly() {
    // Picked and confirming.
    let mut app = thread_app(window());
    assert_eq!(app.key(key('1')), vec![]);
    assert!(matches!(app.mode, Mode::ConfirmThread(_)));
    insta::assert_snapshot!("thread_confirm", screen(&mut app, 120, 30));
    // Sending: posted, no reply yet.
    let fx = app.key(enter());
    assert!(matches!(fx.as_slice(), [Effect::Act { .. }]), "{fx:?}");
    insta::assert_snapshot!("thread_sending", screen(&mut app, 120, 30));
    // Sent, then each other end.
    for (name, state) in [("thread_sent", "sent"), ("thread_uncertain", "uncertain")] {
        let mut app = thread_app(with_states(&[(PERMISSION, state, false)]));
        insta::assert_snapshot!(name, screen(&mut app, 120, 30));
    }
    let mut app = thread_app(with_states(&[
        (PERMISSION, "not-sent", false),
        ("c0ffee00c0ffee00c0ffee00c0ffee01", "delivered", false),
    ]));
    insta::assert_snapshot!("thread_outcomes", screen(&mut app, 120, 30));
    let mut app = thread_app(with_states(&[(PERMISSION, "withdrawn", false)]));
    assert!(screen(&mut app, 120, 30).contains("Withdrawn — the turn ended"));
}

#[test]
fn an_answer_posts_exactly_the_question_and_option_shown() {
    let mut app = thread_app(window());
    app.key(key('2'));
    let shown = screen(&mut app, 120, 30);
    assert!(shown.contains("Your answer: Deny"), "{shown}");
    let fx = app.key(enter());
    let [Effect::Act { path, fields, .. }] = fx.as_slice() else {
        panic!("{fx:?}")
    };
    assert_eq!(
        path,
        &format!("/agents/live/thread/{}/answer", fake::THREAD)
    );
    let digest = window()["thread"]["questions"][1]["digest"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        fields,
        &vec![
            ("request".to_string(), PERMISSION.to_string()),
            ("card".to_string(), digest),
            ("decision".to_string(), "decline".to_string()),
        ]
    );
    // A question's answer is its option's words, for its one part.
    let mut w = with_states(&[
        (PERMISSION, "sent", false),
        ("c0ffee00c0ffee00c0ffee00c0ffee01", "pending", true),
    ]);
    w["thread"]["questions"][0]["digest"] = json!("e".repeat(64));
    let mut app = thread_app(w);
    app.key(key('2'));
    screen(&mut app, 120, 30);
    let fx = app.key(enter());
    let [Effect::Act { fields, .. }] = fx.as_slice() else {
        panic!("{fx:?}")
    };
    assert_eq!(
        fields,
        &vec![
            (
                "request".to_string(),
                "c0ffee00c0ffee00c0ffee00c0ffee01".to_string()
            ),
            ("card".to_string(), "e".repeat(64)),
            ("question".to_string(), "1".to_string()),
            ("answer".to_string(), "On the total".to_string()),
        ]
    );
}

#[test]
fn a_question_that_changed_is_refused_and_nothing_is_sent() {
    // The card changed (another digest) while the dialog was open: it closes, saying so.
    let mut app = thread_app(window());
    app.key(key('1'));
    screen(&mut app, 120, 30);
    let mut changed = window();
    changed["thread"]["questions"][1]["digest"] = json!("0".repeat(64));
    app.update(Msg::Thread(fake::THREAD.into(), Ok(parse(changed))));
    assert_eq!(app.mode, Mode::Normal);
    assert_eq!(
        app.status,
        Some((Tone::Refused, THREAD_QUESTION_CHANGED.into()))
    );
    // Enter now opens nothing and sends nothing.
    assert!(!app
        .key(enter())
        .iter()
        .any(|e| matches!(e, Effect::Act { .. })));
    // Answered elsewhere (no longer waiting): the same.
    let mut app = thread_app(window());
    app.key(key('1'));
    screen(&mut app, 120, 30);
    app.update(Msg::Thread(
        fake::THREAD.into(),
        Ok(parse(with_states(&[(PERMISSION, "sent", false)]))),
    ));
    assert_eq!(app.mode, Mode::Normal);
    // Too small to show the question and the answer whole: Enter sends nothing and says where to answer.
    let mut app = thread_app(window());
    app.key(key('1'));
    screen(&mut app, 40, 9);
    assert_eq!(app.key(enter()), vec![]);
    assert_eq!(app.status, Some((Tone::Refused, ANSWER_TOO_LONG.into())));
    // No option of that number is refused in words.
    let mut app = thread_app(window());
    assert_eq!(app.key(key('3')), vec![]);
    assert_eq!(
        app.status,
        Some((Tone::Refused, "There's no answer 3.".into()))
    );
}

#[test]
fn threads_refused_by_the_console_are_never_listed_or_asked_for_again() {
    let mut app = App::new(false, None);
    let fx = app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    assert!(fx.contains(&Effect::FetchThreads));
    let before = app.items.len();
    assert_eq!(
        app.update(Msg::Threads(Err(ApiError::Refused(
            "Couldn't read your threads (not-available).".into()
        )))),
        vec![]
    );
    assert!(app.threads.off);
    assert_eq!(app.items.len(), before);
    assert_eq!(app.status, None);
    let fx = app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    assert!(!fx.contains(&Effect::FetchThreads));
}

#[test]
fn agent_text_is_drawn_inert() {
    let mut w = window();
    w["thread"]["title"] = json!("Totals\u{1b}]0;owned\u{7} \u{1b}[31mred\u{202e}");
    w["thread"]["questions"][1]["detail"] = json!("rm -rf /\u{1b}[2J");
    let mut app = thread_app(w);
    let shown = screen(&mut app, 120, 30);
    assert!(
        !shown.contains('\u{1b}') && !shown.contains('\u{202e}') && !shown.contains('\u{7}'),
        "{shown}"
    );
}
