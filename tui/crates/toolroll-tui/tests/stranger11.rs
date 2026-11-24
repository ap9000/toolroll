//! The stranger test's eleventh round (0.9.115): typed text ran as workbench keys. After an Accept the Diff tab kept
//! its keys (`n` said "No notes yet…", Esc and `o` didn't leave it), so a typed sentence opened Agents (`A`) and started
//! a sign-in (`s`); and after "The agent is still working on your last message" the reply typed went to the workbench
//! and opened New task. Now Esc leaves the Diff, a done Accept or Send back leaves it too (a refused one stays, its
//! notes there to change), `n` there says how to start a task, and a reply box stays open with its text whenever the
//! reply can't go (an ended thread's included): typing never falls through to the workbench's keys. An unchanged
//! retry of a reply posts its first request key again, so a reply whose answer was lost never starts two turns.
#[path = "common/pairs.rs"]
mod pairs;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use serde_json::{json, Value};
use toolroll_api::*;
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, Effect, Mode, Msg, Tab};

/// 2026-11-14T12:04:12Z.
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
fn type_words(app: &mut App, words: &str) {
    for c in words.chars() {
        app.key(key(c));
    }
}
fn screen(app: &mut App, w: u16, h: u16) -> String {
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| toolroll_tui::view::draw(f, app)).unwrap();
    pairs::check(app, w, h);
    term.backend().to_string()
}
fn status(app: &App) -> String {
    app.status
        .as_ref()
        .map(|(_, w)| w.clone())
        .unwrap_or_default()
}

/// The scenario's work with t-done selected and its steps read: a result waiting for this person.
fn result_app() -> App {
    let state = fake::scenario();
    let mut app = App::new(false, Some("/home/me/shop".into()));
    app.now = NOW;
    app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    let at = app.items.iter().position(|i| i.id == "t-done").unwrap();
    while app.selected < at {
        app.key(key('j'));
    }
    app.update(Msg::Steps(
        "t-done".into(),
        Ok(parse(state.steps["t-done"].clone())),
    ));
    app
}

/// Answer the diff read `fx` asked for, and its first file's read, from the scenario.
fn answer_diff(app: &mut App, fx: &[Effect]) {
    let state = fake::scenario();
    let ask = fx
        .iter()
        .find_map(|e| match e {
            Effect::FetchDiff(a) => Some(a.clone()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no diff read in {fx:?}"));
    let fx = app.update(Msg::Diff(ask, Ok(parse(state.diffs["t-done"].clone()))));
    let ask = fx
        .iter()
        .find_map(|e| match e {
            Effect::FetchDiffFile(a) => Some(a.clone()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no file read in {fx:?}"));
    let mut file = state.diff_files[&format!("t-done:{}", ask.file)].clone();
    file["run"] = ask.run.into();
    app.update(Msg::DiffFile(ask, Ok(parse(file))));
}

/// t-done's changes on the Diff tab (Enter on a result opens them).
fn on_diff() -> App {
    let mut app = result_app();
    let fx = app.key(code(KeyCode::Enter));
    assert_eq!(app.tab, Tab::Diff);
    answer_diff(&mut app, &fx);
    app
}

#[test]
fn esc_leaves_the_diff_and_n_there_says_how_to_start_a_task() {
    let mut app = on_diff();
    // The key bar says how to leave; n here is the next note, and with none it says how to get to New task.
    assert!(screen(&mut app, 120, 30).contains("Esc list"));
    assert_eq!(app.key(key('n')), vec![]);
    assert_eq!(app.mode, Mode::Normal);
    assert_eq!(app.tab, Tab::Diff);
    assert!(
        status(&app).contains("No notes yet")
            && status(&app).contains("Esc leaves the diff; then n is a new task"),
        "{}",
        status(&app)
    );
    // Esc leaves the Diff for Live; n is New task there.
    app.key(code(KeyCode::Esc));
    assert_eq!(app.tab, Tab::Live);
    assert_eq!(app.mode, Mode::Normal);
    app.key(key('n'));
    assert!(matches!(app.mode, Mode::NewTask(..)), "{:?}", app.mode);
    // Narrow, a task's panel showing its Diff: Esc goes back to the list.
    let mut narrow = on_diff();
    narrow.narrow = true;
    narrow.narrow_list = false;
    narrow.key(code(KeyCode::Esc));
    assert!(narrow.tab == Tab::Live && narrow.narrow_list);
}

#[test]
fn a_done_accept_or_send_back_leaves_the_diff_and_a_refused_one_stays() {
    // Accept: refused, it stays on the Diff; done, the Diff gives way to Live.
    let mut app = on_diff();
    app.key(key('a'));
    assert!(
        matches!(app.mode, Mode::ConfirmAccept(_)),
        "{}",
        status(&app)
    );
    screen(&mut app, 120, 30);
    let fx = app.key(code(KeyCode::Enter));
    assert!(matches!(fx.as_slice(), [Effect::Act { path, .. }] if path == "/t/t-done/complete"));
    app.update(Msg::Acted(Ok(ActOutcome::Refused("Not yet.".into()))));
    assert_eq!(app.tab, Tab::Diff);
    app.key(key('a'));
    screen(&mut app, 120, 30);
    app.key(code(KeyCode::Enter));
    app.update(Msg::Acted(Ok(ActOutcome::Done(
        "Accepted. The task is complete.".into(),
    ))));
    assert_eq!(app.tab, Tab::Live);
    // Another act answered later never moves the tab: the Accept's answer was the one that did.
    let mut app = on_diff();
    app.update(Msg::Acted(Ok(ActOutcome::Done("Paused.".into()))));
    assert_eq!(app.tab, Tab::Diff);
    // Send back: refused, it stays (its words kept for a retry); done, it leaves.
    let send_back = |app: &mut App| {
        app.key(key('r'));
        type_words(app, "keep the old column order");
        app.key(code(KeyCode::Enter));
        assert!(
            matches!(app.mode, Mode::SendReview { .. }),
            "{}",
            status(app)
        );
        screen(app, 120, 30);
        let fx = app.key(code(KeyCode::Enter));
        let [Effect::Send { text, .. }] = fx.as_slice() else {
            panic!("{fx:?}")
        };
        text.clone()
    };
    let answer = |app: &mut App, text: &str, result: ActOutcome| {
        app.update(Msg::Sent {
            task: "t-done".into(),
            run: 2,
            text: text.into(),
            kept: 0,
            result: Ok(result),
        });
    };
    let text = send_back(&mut app);
    answer(&mut app, &text, ActOutcome::Refused("Not now.".into()));
    assert_eq!(app.tab, Tab::Diff);
    let text = send_back(&mut app);
    answer(
        &mut app,
        &text,
        ActOutcome::Done("Sent back. The revision is filed.".into()),
    );
    assert_eq!(app.tab, Tab::Live);
}

/// The threads list with the selected thread's turn in `turn`.
fn threads_with(turn: &str) -> Value {
    let mut list = fake::fixture("live-threads.json");
    list["threads"][0]["turn"] = json!(turn);
    list["threads"][0]["live"] = json!(turn == "running");
    list
}

/// The scenario's work and threads read, the thread selected and its window read (its turn still working).
fn thread_app() -> App {
    let mut app = App::new(false, Some("/home/me/shop".into()));
    app.now = NOW;
    app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    app.update(Msg::Threads(Ok(parse(threads_with("running")))));
    let at = app
        .items
        .iter()
        .position(|i| i.id == fake::THREAD)
        .expect("the thread is listed");
    while app.selected < at {
        app.key(key('j'));
    }
    app.update(Msg::Thread(
        fake::THREAD.into(),
        Ok(parse(fake::fixture("live-session-window-thread.json"))),
    ));
    app
}

fn reply_text(app: &App) -> Option<String> {
    match &app.mode {
        Mode::ThreadReply(t, text) if t == fake::THREAD => Some(text.clone()),
        _ => None,
    }
}

#[test]
fn a_reply_that_cant_go_stays_in_its_box_and_typing_never_reaches_the_workbench() {
    let mut app = thread_app();
    // Its turn still working: s opens the box anyway, saying so; what is typed goes into it (n included, never New
    // task), and Enter keeps it there.
    assert_eq!(app.key(key('s')), vec![]);
    assert!(status(&app).contains("still working"), "{}", status(&app));
    type_words(&mut app, "Now add a test");
    assert_eq!(reply_text(&app).as_deref(), Some("Now add a test"));
    assert_eq!(app.key(code(KeyCode::Enter)), vec![]);
    assert_eq!(reply_text(&app).as_deref(), Some("Now add a test"));
    assert!(
        status(&app).contains("Your reply stays here"),
        "{}",
        status(&app)
    );
    // The turn finished: Enter sends it.
    app.update(Msg::Threads(Ok(parse(threads_with("finished")))));
    let fx = app.key(code(KeyCode::Enter));
    assert!(
        matches!(fx.as_slice(), [Effect::Act { path, fields, .. }]
            if path.ends_with("/turn") && fields[0] == ("message".to_string(), "Now add a test".to_string())),
        "{fx:?}"
    );
    assert_eq!(app.mode, Mode::Normal);
    // The console refuses it (another turn began meanwhile): back in its box, text and all; typing goes on there.
    app.update(Msg::Acted(Ok(ActOutcome::Refused(
        "The agent is still working on your last message.".into(),
    ))));
    assert_eq!(reply_text(&app).as_deref(), Some("Now add a test"));
    type_words(&mut app, " now");
    assert_eq!(reply_text(&app).as_deref(), Some("Now add a test now"));
    // An answer that never came keeps it too.
    app.key(code(KeyCode::Enter));
    app.update(Msg::Acted(Err(ApiError::Unreachable("reset".into()))));
    assert_eq!(reply_text(&app).as_deref(), Some("Now add a test now"));
    // Sent: the box is done with, and a later refusal of something else never brings it back.
    app.key(code(KeyCode::Enter));
    app.update(Msg::Acted(Ok(ActOutcome::Done("Sent.".into()))));
    assert_eq!(app.mode, Mode::Normal);
    app.update(Msg::Acted(Ok(ActOutcome::Refused("Not now.".into()))));
    assert_eq!(app.mode, Mode::Normal);
}

/// The request key an Enter in the reply box posted.
fn posted_key(fx: &[Effect]) -> String {
    match fx {
        [Effect::Act { path, fields, .. }] if path.ends_with("/turn") => fields
            .iter()
            .find(|(k, _)| k == "key")
            .map(|(_, v)| v.clone())
            .unwrap(),
        _ => panic!("{fx:?}"),
    }
}

#[test]
fn an_unchanged_retry_posts_the_same_key_and_an_edited_reply_a_new_one() {
    let mut app = thread_app();
    app.update(Msg::Threads(Ok(parse(threads_with("finished")))));
    app.key(key('s'));
    type_words(&mut app, "Now add a test");
    let first = posted_key(&app.key(code(KeyCode::Enter)));
    // The answer never came (the turn may have started): the retry, unchanged, is the same request.
    app.update(Msg::Acted(Err(ApiError::Unreachable("reset".into()))));
    let again = posted_key(&app.key(code(KeyCode::Enter)));
    assert_eq!(again, first);
    // Refused, unchanged: still the same.
    app.update(Msg::Acted(Ok(ActOutcome::Refused("Not now.".into()))));
    assert_eq!(posted_key(&app.key(code(KeyCode::Enter))), first);
    // Edited: a new request.
    app.update(Msg::Acted(Ok(ActOutcome::Refused("Not now.".into()))));
    type_words(&mut app, " please");
    let edited = posted_key(&app.key(code(KeyCode::Enter)));
    assert_ne!(edited, first);
    // Done: the next reply, even with the same words, is a new request.
    app.update(Msg::Acted(Ok(ActOutcome::Done("Sent.".into()))));
    app.key(key('s'));
    type_words(&mut app, "Now add a test please");
    let next = posted_key(&app.key(code(KeyCode::Enter)));
    assert_ne!(next, edited);
}

#[test]
fn typing_after_s_on_an_ended_thread_never_reaches_the_workbench() {
    let mut app = thread_app();
    let mut list = threads_with("finished");
    list["threads"][0]["ended"] = json!(true);
    app.update(Msg::Threads(Ok(parse(list))));
    app.selected = app.items.iter().position(|i| i.id == fake::THREAD).unwrap();
    app.key(key('s'));
    assert!(
        status(&app).contains("This thread has ended"),
        "{}",
        status(&app)
    );
    // n, A and s would be New task, Agents and Steer: here they are only text.
    type_words(&mut app, "nAs");
    assert_eq!(reply_text(&app).as_deref(), Some("nAs"));
    assert_eq!(app.key(code(KeyCode::Enter)), vec![]);
    assert_eq!(reply_text(&app).as_deref(), Some("nAs"));
    assert!(app.agents_screen.is_none());
    app.key(code(KeyCode::Esc));
    assert_eq!(app.mode, Mode::Normal);
}
