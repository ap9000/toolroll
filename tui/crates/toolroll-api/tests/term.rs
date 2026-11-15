//! A take-over's socket against the fake console (solo-workbench T4): output the screen hasn't let go of is bounded
//! across every hop. A screen that stops parsing holds at most the budget plus one message; once it lets go, reading
//! resumes, and a sustained stream keeps what's held flat.
use std::time::Duration;
use toolroll_api::*;
use toolroll_fake_engine as fake;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sustained_stream_keeps_what_is_held_flat() {
    const CHUNK: usize = 64 * 1024;
    let mut state = fake::scenario();
    state
        .terms
        .push(fake::term_session("t-done", fake::RESULT_RUN));
    state.term_echo = false;
    // 256 MiB of output, generated as it is sent.
    state.term_stream = vec![vec![b'y'; CHUNK]];
    state.term_stream_repeat = 4096;
    let engine = fake::FakeEngine::start(state, 0).await;
    let client = redeem(&engine.link()).await.unwrap();
    let (_send, mut events, held) = client.term_connect(fake::TERM_ID).await.unwrap();
    let most = OUTPUT_BUDGET + 8 * CHUNK;

    // A stalled screen: every chunk kept, none let go. Reading stops at the budget.
    let mut kept = vec![];
    let mut taken = 0usize;
    while let Ok(Some(event)) =
        tokio::time::timeout(Duration::from_millis(800), events.recv()).await
    {
        if let TermEvent::Output(chunk) = &event {
            taken += chunk.len();
        }
        kept.push(event);
        assert!(taken <= most, "took {taken} bytes while nothing was let go");
    }
    assert!(taken >= OUTPUT_BUDGET, "only {taken} bytes arrived");
    assert_eq!(held.bytes(), taken);

    // Let go: reading resumes, and over 64 MiB more of a sustained stream, what's held never grows past the bound.
    drop(kept);
    let mut more = 0usize;
    let mut peak = 0usize;
    while more < 64 << 20 {
        let event = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("reading resumed")
            .expect("open");
        if let TermEvent::Output(chunk) = event {
            more += chunk.len();
            peak = peak.max(held.bytes());
        }
    }
    assert!(peak <= most, "held {peak} bytes");
    assert!(held.bytes() <= most);
}
