//! The thread's answer flow end to end against the stand-in console over real HTTP (toolroll-fake-engine, the
//! contract's fixtures): the screen reads the threads and the thread's window through the real client, the person
//! picks an option, and the act the console receives carries exactly the request, the card digest and the choice the
//! screen showed, with the session's credentials. With Flexible off (as this build ships), nothing is listed and a new
//! thread is refused in the console's words.
#[path = "common/pairs.rs"]
mod pairs;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use toolroll_api::{redeem, Client};
use toolroll_fake_engine::{scenario, scenario_with_threads, FakeEngine, THREAD};
use toolroll_tui::app::{App, Effect, Msg, Tone};

fn key(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)
}
fn code(c: KeyCode) -> KeyEvent {
    KeyEvent::new(c, KeyModifiers::NONE)
}
fn screen(app: &mut App) -> String {
    let mut term = Terminal::new(TestBackend::new(120, 30)).unwrap();
    term.draw(|f| toolroll_tui::view::draw(f, app)).unwrap();
    let (w, h) = (
        term.backend().buffer().area.width,
        term.backend().buffer().area.height,
    );
    pairs::check(app, w, h);
    term.backend().to_string()
}

/// Run the reads and acts an update asked for through the real client, feeding each answer back, until none is left.
async fn settle(app: &mut App, client: &Client, mut fx: Vec<Effect>) {
    while let Some(effect) = fx.pop() {
        let more = match effect {
            Effect::FetchWork => app.update(Msg::Work(client.work_rows().await)),
            // A held read waits for the thread's next change, which the stand-in console never makes.
            Effect::FetchThread { wait: true, .. } => vec![],
            Effect::FetchThreads => app.update(Msg::Threads(client.threads().await)),
            Effect::FetchThread {
                thread,
                cursor,
                known,
                wait,
            } => {
                let read = client
                    .thread_window(&thread, cursor.as_deref(), known.as_deref(), wait)
                    .await;
                app.update(Msg::Thread(thread, read))
            }
            Effect::Act { path, fields, done } => {
                let pairs: Vec<(&str, &str)> = fields
                    .iter()
                    .map(|(k, v)| (k.as_str(), v.as_str()))
                    .collect();
                app.update(Msg::Acted(client.act(&path, &pairs, &done).await))
            }
            // Steps, agents and the live rooms aren't what this test is about.
            _ => vec![],
        };
        fx.extend(more);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_answer_posts_exactly_what_the_screen_showed() {
    let engine = FakeEngine::start(scenario_with_threads(), 0).await;
    let client = redeem(&engine.link()).await.unwrap();
    let mut app = App::new(false, Some("/home/me/shop".into()));
    settle(&mut app, &client, vec![Effect::FetchWork]).await;
    let at = app
        .items
        .iter()
        .position(|i| i.id == THREAD)
        .expect("the thread is listed");
    while app.selected < at {
        let fx = app.key(key('j'));
        settle(&mut app, &client, fx).await;
    }
    // What the screen shows for the question waiting: its words and its options.
    let shown = screen(&mut app);
    assert!(
        shown.contains("Allow this command?")
            && shown.contains("1 Allow")
            && shown.contains("2 Deny"),
        "{shown}"
    );
    let view = app.threads.view.as_ref().unwrap();
    let question = view
        .facts
        .as_ref()
        .unwrap()
        .questions
        .iter()
        .find(|q| q.state == "pending")
        .unwrap()
        .clone();
    // Pick Allow, see the dialog (drawn whole), send it.
    app.key(key('1'));
    assert!(screen(&mut app).contains("Your answer: Allow"));
    let fx = app.key(code(KeyCode::Enter));
    settle(&mut app, &client, fx).await;
    let acts = engine.acts();
    let posted = acts.last().expect("an act");
    assert_eq!(posted.path, format!("/agents/live/thread/{THREAD}/answer"));
    assert_eq!(
        posted.fields,
        vec![
            ("request".to_string(), question.request.clone()),
            ("card".to_string(), question.digest.clone()),
            ("decision".to_string(), "accept".to_string()),
        ]
    );
    assert!(
        posted.keyed && posted.csrf_ok && posted.cookie_ok && posted.in_place,
        "{posted:?}"
    );
    assert_eq!(app.status, Some((Tone::Said, "Sent to the agent.".into())));
    // Exactly one answer was posted.
    assert_eq!(
        acts.iter().filter(|a| a.path.ends_with("/answer")).count(),
        1
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn with_threads_off_nothing_is_listed_and_t_says_where_to_turn_them_on() {
    let engine = FakeEngine::start(scenario(), 0).await;
    let client = redeem(&engine.link()).await.unwrap();
    let mut app = App::new(false, Some("/home/me/shop".into()));
    settle(&mut app, &client, vec![Effect::FetchWork]).await;
    assert!(app.threads.off);
    assert!(app.items.iter().all(|i| !i.thread));
    assert_eq!(app.status, None);
    // Never a dead key: T says threads are off and where to turn them on, and opens nothing.
    assert_eq!(app.key(key('T')), vec![]);
    assert_eq!(
        app.status,
        Some((Tone::Refused, toolroll_tui::thread::THREADS_OFF.into()))
    );
    assert!(!matches!(app.mode, toolroll_tui::app::Mode::NewThread(_)));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_thread_starts_only_under_the_key_of_the_terms_card_the_screen_drew_whole() {
    let engine = FakeEngine::start(scenario_with_threads(), 0).await;
    let client = redeem(&engine.link()).await.unwrap();
    let mut app = App::new(false, Some("/home/me/shop".into()));
    settle(&mut app, &client, vec![Effect::FetchWork]).await;
    app.key(key('T'));
    for c in "Fix the README".chars() {
        app.key(key(c));
    }
    let fx = app.key(code(KeyCode::Enter));
    settle(&mut app, &client, fx).await;
    // The console answered with the card; nothing was started, and the card is on screen.
    assert!(matches!(app.mode, toolroll_tui::app::Mode::StartThread(_)));
    assert!(screen(&mut app).contains("Starting this thread agrees to exactly this:"));
    assert_eq!(engine.acts().last().unwrap().field("terms"), None);
    // Read to the end, then start: the act carries the message, the project and exactly the card's key.
    for _ in 0..10 {
        app.key(key(' '));
        screen(&mut app);
    }
    let fx = app.key(code(KeyCode::Enter));
    settle(&mut app, &client, fx).await;
    let acts = engine.acts();
    let posted = acts.last().unwrap();
    assert_eq!(posted.path, "/agents/live/thread");
    assert_eq!(posted.field("terms"), Some(toolroll_fake_engine::START_KEY));
    assert_eq!(posted.field("message"), Some("Fix the README"));
    assert_eq!(posted.field("repo"), Some("/home/me/shop"));
    assert!(
        posted.keyed && posted.csrf_ok && posted.cookie_ok && posted.in_place,
        "{posted:?}"
    );
    assert_eq!(app.status, Some((Tone::Said, "The thread started.".into())));
    // The thread it started is selected once it is listed, not the task that was selected before.
    assert_eq!(
        app.selected_item().map(|i| (i.id.as_str(), i.thread)),
        Some((toolroll_fake_engine::THREAD, true))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_start_refused_for_your_sign_in_offers_its_page_and_its_command() {
    let mut state = scenario_with_threads();
    state.thread_next = Some("sign-in".into());
    let engine = FakeEngine::start(state, 0).await;
    let client = redeem(&engine.link()).await.unwrap();
    let mut app = App::new(false, Some("/home/me/shop".into()));
    settle(&mut app, &client, vec![Effect::FetchWork]).await;
    let start = |app: &mut App| {
        app.key(key('T'));
        for c in "Fix the README".chars() {
            app.key(key(c));
        }
        app.key(code(KeyCode::Enter))
    };
    let fx = start(&mut app);
    settle(&mut app, &client, fx).await;
    // The console's words, naming `claude setup-token`; nothing started; the next step's doors one key away.
    assert!(
        matches!(&app.status, Some((Tone::Refused, w)) if w.contains("claude setup-token")),
        "{:?}",
        app.status
    );
    assert!(matches!(&app.mode, toolroll_tui::app::Mode::ThreadNext(n) if n == "sign-in"));
    let shown = screen(&mut app);
    assert!(shown.contains("Before a thread can start"), "{shown}");
    assert!(shown.contains("copies the command"), "{shown}");
    // w opens the sign-in page in the browser (by its fixed name, nothing else).
    assert_eq!(
        app.key(key('w')),
        vec![Effect::OpenPage("flexible-sign-in")]
    );
    // Again: c puts exactly the command in the terminal's scrollback (never the clipboard, never a token).
    let fx = start(&mut app);
    settle(&mut app, &client, fx).await;
    assert_eq!(
        app.key(key('c')),
        vec![Effect::Scrollback(vec![
            "toolroll config set flexible-sign-in".into()
        ])]
    );
    // An unknown step is an ordinary refusal (no doors).
    assert!(toolroll_tui::thread::next_step("anything-else").is_none());
    assert_eq!(
        toolroll_tui::thread::next_step("project-terms")
            .unwrap()
            .command(Some("/home/me/shop")),
        "toolroll project flexible enable --repo '/home/me/shop'"
    );
}
