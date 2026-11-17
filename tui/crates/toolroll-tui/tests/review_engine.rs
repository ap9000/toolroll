//! Diff review end to end through the fake console over real HTTP (solo-workbench plan T2): the screen's own effects run
//! by the real client with the session's cookie, form token and mutation key, the console recording every act. Notes
//! are never sent by moving around; Send back with notes posts exactly the notes the dialog drew; Accept with notes saves
//! them then completes; a context answer that comes back after the file changed is dropped.
#[path = "common/pairs.rs"]
mod pairs;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use toolroll_api::Client;
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, Effect, Mode, Msg, Tab, STEPS_UNREADABLE};
use toolroll_tui::review::{Kind, Row};

fn key(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)
}
fn enter() -> KeyEvent {
    KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
}

/// One effect run as run.rs runs it; its answer, if it has one.
async fn run_fx(client: &Client, fx: Effect) -> Option<Msg> {
    Some(match fx {
        Effect::FetchWork => Msg::Work(client.work_rows().await),
        Effect::FetchSteps(task) => {
            let r = client.steps(&task).await;
            Msg::Steps(task, r)
        }
        Effect::FetchLive { run, file, cursor } => Msg::Live(
            run,
            file,
            client.live_window(run, file, cursor.as_deref()).await,
        ),
        Effect::FetchDiff(ask) => {
            let r = client.diff(&ask.task, ask.run).await;
            Msg::Diff(ask, r)
        }
        Effect::FetchDiffFile(ask) => {
            let r = client.diff_file(&ask.task, ask.run, ask.file).await;
            Msg::DiffFile(ask, r)
        }
        Effect::FetchContext(ask) => {
            let r = client
                .diff_context(&ask.task, ask.run, ask.file, ask.from, ask.count)
                .await;
            Msg::Context(ask, r)
        }
        Effect::Act { path, fields, done } => {
            let pairs: Vec<(&str, &str)> = fields
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect();
            Msg::Acted(client.act(&path, &pairs, &done).await)
        }
        Effect::Send {
            acts,
            task,
            run,
            text,
        } => toolroll_tui::run::send_batch(client, acts, task, run, text).await,
        _ => return None,
    })
}

/// Run effects and the effects their answers ask for, until nothing is left.
async fn pump(app: &mut App, client: &Client, fx: Vec<Effect>) {
    let mut queue = fx;
    for _ in 0..500 {
        let Some(next) = queue.pop() else { return };
        if let Some(msg) = run_fx(client, next).await {
            queue.extend(app.update(msg));
        }
    }
    panic!("effects never settled");
}

fn screen(app: &mut App, w: u16, h: u16) -> String {
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| toolroll_tui::view::draw(f, app)).unwrap();
    pairs::check(app, w, h);
    term.backend().to_string()
}

fn to_new_line(app: &mut App, n: i64) {
    let code = app.code.clone().unwrap();
    app.diff_cursor = app
        .rows
        .iter()
        .position(|r| matches!(r, Row::Code(c) if code.lines[*c].new == Some(n) && code.lines[*c].kind != Kind::Deletion))
        .expect("line shown");
}

async fn note(app: &mut App, client: &Client, words: &str) {
    let mut fx = app.key(key('c'));
    for c in words.chars() {
        fx.extend(app.key(key(c)));
    }
    fx.extend(app.key(enter()));
    pump(app, client, fx).await;
}

/// Signed in, t-done selected and its changes open.
async fn open_review() -> (fake::FakeEngine, Client, App) {
    let engine = fake::FakeEngine::start(fake::scenario(), 0).await;
    let client = toolroll_api::redeem(&engine.link()).await.unwrap();
    let mut app = App::new(false, None);
    app.syntax_on = false;
    pump(&mut app, &client, vec![Effect::FetchWork]).await;
    let fx = app.key(key('j'));
    pump(&mut app, &client, fx).await;
    let fx = app.key(enter());
    pump(&mut app, &client, fx).await;
    assert_eq!(app.tab, Tab::Diff);
    let shown = app.file_shown().map(|(t, r, f, _)| (t, r, f));
    assert_eq!(shown, Some(("t-done".into(), 2, 0)));
    (engine, client, app)
}

#[tokio::test(flavor = "multi_thread")]
async fn notes_stay_here_until_sent_and_go_back_exactly_as_shown() {
    let (engine, client, mut app) = open_review().await;
    to_new_line(&mut app, 2);
    note(&mut app, &client, "round to cents").await;
    // Moving everywhere: lines, hunks, files, notes, the view, tabs, another task and back.
    for k in ['j', 'k', '[', ']', 'n', 'N', 'g', 'G', 'v', 'v', '}'] {
        let fx = app.key(key(k));
        pump(&mut app, &client, fx).await;
    }
    assert_eq!(app.file_shown().unwrap().3, "README.md");
    to_new_line(&mut app, 2);
    note(&mut app, &client, "mention VAT").await;
    let fx = app.key(key('{'));
    pump(&mut app, &client, fx).await;
    app.tab = Tab::Live;
    for k in ['k', 'j'] {
        let fx = app.key(key(k));
        pump(&mut app, &client, fx).await;
    }
    assert!(engine.acts().is_empty(), "moving sent {:?}", engine.acts());
    let fx = app.key(enter());
    pump(&mut app, &client, fx).await;
    assert_eq!(app.notes_of("t-done", 2).len(), 2, "notes lost on the way");

    // Send back: the dialog shows every note; what reaches the console is exactly that, plus the words typed.
    let fx = app.key(key('r'));
    pump(&mut app, &client, fx).await;
    for c in "Thanks.".chars() {
        app.key(key(c));
    }
    assert_eq!(app.key(enter()), vec![]);
    let shown = screen(&mut app, 120, 34);
    let fx = app.key(enter());
    pump(&mut app, &client, fx).await;
    let acts = engine.acts();
    assert_eq!(acts.len(), 1, "{acts:?}");
    let act = &acts[0];
    assert_eq!(act.path, "/r/2/comment");
    assert!(act.keyed && act.csrf_ok && act.cookie_ok && act.in_place);
    assert_eq!(act.field("intent"), Some("revise"));
    let posted = act.field("note").unwrap();
    assert_eq!(
        posted,
        "Notes on the changes:\n- src/total.ts line 2 — round to cents\n- README.md line 2 — mention VAT\n\nThanks."
    );
    for line in posted.lines().filter(|l| !l.is_empty() && *l != "Thanks.") {
        assert!(
            shown.contains(line),
            "posted but not on screen: {line}\n{shown}"
        );
    }
    assert!(
        app.notes_of("t-done", 2).is_empty(),
        "a sent draft is cleared"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn accept_with_notes_saves_them_then_completes() {
    let (engine, client, mut app) = open_review().await;
    to_new_line(&mut app, 2);
    note(&mut app, &client, "round to cents").await;
    let fx = app.key(key('a'));
    pump(&mut app, &client, fx).await;
    screen(&mut app, 120, 34);
    app.key(key('t'));
    let shown = screen(&mut app, 120, 34);
    assert!(
        shown.contains("- src/total.ts line 2 — round to cents"),
        "{shown}"
    );
    let fx = app.key(enter());
    pump(&mut app, &client, fx).await;
    let acts = engine.acts();
    assert_eq!(
        acts.iter().map(|a| a.path.as_str()).collect::<Vec<_>>(),
        vec!["/r/2/comment", "/t/t-done/complete"]
    );
    assert_eq!(acts[0].field("intent"), None);
    assert_eq!(
        acts[0].field("note"),
        Some("Notes on the changes:\n- src/total.ts line 2 — round to cents")
    );
    assert_eq!(acts[1].field("receipt"), Some("a".repeat(64).as_str()));
    assert!(acts.iter().all(|a| a.keyed && a.csrf_ok && a.cookie_ok));
    assert!(app.notes_of("t-done", 2).is_empty());
    // A refused Accept with nothing kept: the notes stay for another try.
    let (engine, client, mut app) = open_review().await;
    engine.state.lock().unwrap().refuse_acts = Some((409, "This result changed.".into()));
    to_new_line(&mut app, 2);
    note(&mut app, &client, "round to cents").await;
    let fx = app.key(key('a'));
    pump(&mut app, &client, fx).await;
    app.key(key('t'));
    screen(&mut app, 120, 34);
    let fx = app.key(enter());
    pump(&mut app, &client, fx).await;
    assert_eq!(engine.acts().len(), 1, "stopped at the first refusal");
    assert_eq!(app.notes_of("t-done", 2).len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_context_answer_for_a_file_no_longer_shown_is_dropped() {
    let (engine, client, mut app) = open_review().await;
    engine.state.lock().unwrap().context_delay_ms = 300;
    to_new_line(&mut app, 3);
    let fx = app.key(key('E'));
    let [Effect::FetchContext(ask)] = fx.as_slice() else {
        panic!("{fx:?}")
    };
    assert_eq!((ask.from, ask.count), (4, 20));
    // The slow read runs while the person moves to the next file.
    let (c2, a2) = (client.clone(), ask.clone());
    let late = tokio::spawn(async move { run_fx(&c2, Effect::FetchContext(a2)).await.unwrap() });
    let fx = app.key(key('}'));
    pump(&mut app, &client, fx).await;
    assert_eq!(app.file_shown().unwrap().3, "README.md");
    let answer = late.await.unwrap();
    assert!(
        matches!(&answer, Msg::Context(_, Ok(c)) if c.lines.len() == 20),
        "the console answered"
    );
    assert_eq!(app.update(answer), vec![]);
    assert!(app.revealed.is_empty(), "a stale answer was drawn");
    // Back on the file, asked again with no delay: taken, and drawn.
    engine.state.lock().unwrap().context_delay_ms = 0;
    let fx = app.key(key('{'));
    pump(&mut app, &client, fx).await;
    to_new_line(&mut app, 3);
    let fx = app.key(key('E'));
    pump(&mut app, &client, fx).await;
    assert_eq!(app.revealed.len(), 20);
    assert!(screen(&mut app, 120, 40).contains("// line 8"));
    assert!(engine.acts().is_empty());
}

/// The note's answer is lost on the way back (the console saved it): the retry carries the same identity, the console
/// saves nothing more, and the completion follows. A completion refused after the note saved: the retry only completes.
#[tokio::test(flavor = "multi_thread")]
async fn a_lost_or_refused_answer_never_saves_the_notes_twice() {
    let (engine, client, mut app) = open_review().await;
    to_new_line(&mut app, 2);
    note(&mut app, &client, "round to cents").await;
    let submit = |app: &mut App| {
        app.key(key('a'));
        screen(app, 120, 34);
        app.key(key('t'));
        screen(app, 120, 34);
        app.key(enter())
    };
    // The first try reaches the console (the note is saved), but its answer never comes back.
    let fx = submit(&mut app);
    let [Effect::Send {
        acts,
        task,
        run,
        text,
    }] = fx.as_slice()
    else {
        panic!("{fx:?}")
    };
    let first_try = vec![acts[0].clone()];
    let _lost =
        toolroll_tui::run::send_batch(&client, first_try, task.clone(), *run, text.clone()).await;
    app.update(Msg::Sent {
        task: task.clone(),
        run: *run,
        text: text.clone(),
        kept: 0,
        result: Err(toolroll_api::ApiError::Unreachable(
            "connection reset".into(),
        )),
    });
    assert_eq!(engine.state.lock().unwrap().notes_saved.len(), 1);
    // The retry: same identity, nothing saved twice, then the completion.
    let fx = submit(&mut app);
    pump(&mut app, &client, fx).await;
    let acts = engine.acts();
    assert_eq!(
        acts.iter().map(|a| a.path.as_str()).collect::<Vec<_>>(),
        vec!["/r/2/comment", "/r/2/comment", "/t/t-done/complete"]
    );
    assert_eq!(acts[0].field("request"), acts[1].field("request"));
    assert_eq!(
        engine.state.lock().unwrap().notes_saved.len(),
        1,
        "the notes were saved twice"
    );
    assert!(app.notes_of("t-done", 2).is_empty());

    // The note saves, the completion is refused; once it is allowed, the retry posts only the completion.
    let (engine, client, mut app) = open_review().await;
    engine.state.lock().unwrap().refuse_complete = Some((409, "Not yet.".into()));
    to_new_line(&mut app, 2);
    note(&mut app, &client, "round to cents").await;
    let fx = submit(&mut app);
    pump(&mut app, &client, fx).await;
    assert_eq!(
        app.notes_of("t-done", 2).len(),
        1,
        "kept for the retry: {:?} {:?}",
        engine
            .acts()
            .iter()
            .map(|a| a.path.clone())
            .collect::<Vec<_>>(),
        app.status
    );
    engine.state.lock().unwrap().refuse_complete = None;
    let fx = submit(&mut app);
    pump(&mut app, &client, fx).await;
    let acts = engine.acts();
    assert_eq!(
        acts.iter().map(|a| a.path.as_str()).collect::<Vec<_>>(),
        vec!["/r/2/comment", "/t/t-done/complete", "/t/t-done/complete"]
    );
    assert_eq!(engine.state.lock().unwrap().notes_saved.len(), 1);
    assert!(app.notes_of("t-done", 2).is_empty());
}

/// One task's steps in a shape this version doesn't know (as a sent-back task's Approval terms once were) never end the
/// workbench: that task says so on its own tabs, nothing of its earlier read stays to accept, and the other tasks read
/// and act as before (q still asks first).
#[tokio::test(flavor = "multi_thread")]
async fn one_tasks_unreadable_steps_never_end_the_workbench() {
    let (engine, client, mut app) = open_review().await;
    app.owned = true;
    // Accept is open on t-done's result when its steps come back with a field this version doesn't know.
    let fx = app.key(key('a'));
    pump(&mut app, &client, fx).await;
    assert!(matches!(app.mode, Mode::ConfirmAccept(_)), "{:?}", app.mode);
    engine
        .state
        .lock()
        .unwrap()
        .steps
        .get_mut("t-done")
        .unwrap()["cards"][0]["surprise"] = serde_json::json!(true);
    pump(&mut app, &client, vec![Effect::FetchSteps("t-done".into())]).await;
    assert_eq!(app.mode, Mode::Normal, "the dialog on the old read closes");
    assert!(app.steps.is_none(), "nothing of the old read stays");
    assert_eq!(
        app.status.as_ref().map(|(_, w)| w.as_str()),
        Some(STEPS_UNREADABLE)
    );
    // Fail closed: Accept has nothing to accept, so nothing is sent.
    let fx = app.key(key('a'));
    pump(&mut app, &client, fx).await;
    assert!(
        !matches!(app.mode, Mode::ConfirmAccept(_)),
        "{:?}",
        app.mode
    );
    assert!(engine.acts().is_empty(), "{:?}", engine.acts());
    // Its Steps and Live tabs say so plainly, never "Reading…".
    for tab in [Tab::Steps, Tab::Live] {
        app.tab = tab;
        let shown = screen(&mut app, 200, 34);
        assert!(
            shown.contains("This version can't show this task's steps."),
            "{shown}"
        );
        assert!(!shown.contains("Reading…"), "{shown}");
    }
    // Another task reads and shows as before.
    app.tab = Tab::Steps;
    let fx = app.key(key('k'));
    pump(&mut app, &client, fx).await;
    let here = app.steps.as_ref().map(|s| s.task.id.clone());
    assert_eq!(here.as_deref(), Some("t-ask"));
    assert!(!screen(&mut app, 200, 34).contains("This version can't show"));
    // And q asks before leaving, as it always does.
    let fx = app.key(key('q'));
    assert!(
        fx.is_empty() && app.mode == Mode::Quit,
        "{fx:?} {:?}",
        app.mode
    );
}
