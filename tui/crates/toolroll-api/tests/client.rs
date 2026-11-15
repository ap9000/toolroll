//! The client against a stand-in console (toolroll-fake-engine) over real HTTP: sign-in, the handshake, reads, acts
//! with the session's credentials, refusals in words, a session that ended, and `/live` signals.
use std::time::Duration;
use toolroll_api::*;
use toolroll_fake_engine::{scenario, FakeEngine, LIVE_RUN};

#[tokio::test(flavor = "multi_thread")]
async fn signs_in_once_and_reads_the_contract() {
    let engine = FakeEngine::start(scenario(), 0).await;
    let client = redeem(&engine.link()).await.expect("redeem");
    assert_eq!(client.account, "alex");
    check_hello(&client.hello().await.unwrap()).expect("same contract");
    // The link is spent: a second redemption is refused in words.
    assert_eq!(
        redeem(&engine.link()).await.unwrap_err(),
        ApiError::Refused("that sign-in link was already used or expired".into())
    );
    let rows = client.work_rows().await.unwrap();
    assert_eq!(rows.rows.len(), 5);
    let agents = client.agents().await.unwrap();
    assert_eq!(agents.first_task.as_ref().unwrap().id, "claude");
    assert_eq!(agents.lines, vec!["Your first task goes to Claude Code."]);
    let steps = client.steps("t-done").await.unwrap();
    assert_eq!(steps.review.as_ref().unwrap().run, 2);
    let diff = client.diff("t-done", None).await.unwrap();
    assert_eq!(diff.files.len(), 2);
    let file = client.diff_file("t-done", 2, 0).await.unwrap();
    assert!(!file.file.hunks.is_empty());
    let live = client.live_window(LIVE_RUN, "main", None).await.unwrap();
    let Window::Read(read) = live.window else {
        panic!("window")
    };
    assert!(!read.records.is_empty());
    let next = client
        .live_window(LIVE_RUN, "main", Some(&read.cursor))
        .await
        .unwrap();
    let Window::Read(next) = next.window else {
        panic!("window")
    };
    assert!(next.records.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_mismatched_contract_is_said_plainly() {
    let mut state = scenario();
    state.contract = "0".repeat(64);
    let engine = FakeEngine::start(state, 0).await;
    let client = redeem(&engine.link()).await.unwrap();
    let words = check_hello(&client.hello().await.unwrap()).unwrap_err();
    assert!(
        words.starts_with("This terminal workbench was built for another Toolroll version"),
        "{words}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn acts_carry_the_form_token_the_key_and_ask_for_words() {
    let engine = FakeEngine::start(scenario(), 0).await;
    let client = redeem(&engine.link()).await.unwrap();
    let done = client
        .act(
            "/t/t-live/stop",
            &[("run", "7"), ("return", "task")],
            "Stopping build #7.",
        )
        .await
        .unwrap();
    assert_eq!(done, ActOutcome::Done("Stopping build #7.".into()));
    let accepted = client
        .act(
            "/t/t-done/complete",
            &[("run", "2"), ("receipt", &"a".repeat(64)), ("accept", "1")],
            "Accepted.",
        )
        .await
        .unwrap();
    assert_eq!(
        accepted,
        ActOutcome::Done("Accepted. The task is complete.".into())
    );
    let acts = engine.acts();
    assert!(
        acts.iter()
            .all(|a| a.keyed && a.csrf_ok && a.cookie_ok && a.in_place),
        "{acts:?}"
    );
    assert_eq!(acts[0].field("run"), Some("7"));
    engine.state.lock().unwrap().refuse_acts =
        Some((409, "run #7 already ended before the stop".into()));
    assert_eq!(
        client
            .act("/t/t-live/stop", &[("run", "7")], "x")
            .await
            .unwrap(),
        ActOutcome::Refused("run #7 already ended before the stop".into())
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_the_console_no_longer_holds_ends() {
    let engine = FakeEngine::start(scenario(), 0).await;
    let client = redeem(&engine.link()).await.unwrap();
    engine.state.lock().unwrap().session_ended = true;
    assert_eq!(
        client.work_rows().await.unwrap_err(),
        ApiError::SessionEnded
    );
    assert_eq!(
        client
            .live_window(LIVE_RUN, "main", None)
            .await
            .unwrap_err(),
        ApiError::SessionEnded
    );
    assert_eq!(
        client
            .act("/t/t-live/stop", &[("run", "7")], "x")
            .await
            .unwrap_err(),
        ApiError::SessionEnded
    );
    assert_eq!(
        ApiError::SessionEnded.to_string(),
        "Session ended: run toolroll again."
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn live_signals_name_the_room_that_changed() {
    let engine = FakeEngine::start(scenario(), 0).await;
    let client = redeem(&engine.link()).await.unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let c2 = client.clone();
    tokio::spawn(async move {
        c2.live(&["workspace".into(), format!("agent:{LIVE_RUN}")], tx)
            .await
    });
    tokio::time::sleep(Duration::from_millis(150)).await;
    engine.change("elsewhere");
    engine.change("workspace");
    let got = tokio::time::timeout(Duration::from_secs(3), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got, LiveSignal::Change("workspace".into()));
}
