//! Take over (solo-workbench T4): the Terminal tab's terminal and the Steps tab's live cards, drawn on ratatui's
//! TestBackend from the fake console's scenario and held as insta snapshots; what each key sends, and to which
//! terminal; and the emulator's rule that nothing a program writes reaches the real terminal as bytes.
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::backend::{Backend, CrosstermBackend, TestBackend};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::Terminal;
use serde_json::Value;
use toolroll_api::*;
use toolroll_fake_engine as fake;
use toolroll_tui::app::{
    App, Effect, Mode, Msg, Tab, TermLink, BACK, OFF_SCREEN, STILL_BUILDING, TYPING,
};
use toolroll_tui::term::{Link, Pane};

/// 4 min 12 s after the fixtures' builds started.
const NOW: i64 = 1_794_657_852;
const ID: &str = fake::TERM_ID;

fn parse<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).expect("fixture shape")
}
fn key(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)
}
fn ctrl(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
}

fn app_on(select: &str) -> App {
    let state = fake::scenario();
    let mut app = App::new(false, Some("/home/me/shop".into()));
    app.now = NOW;
    app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    let i = app.items.iter().position(|i| i.id == select).unwrap();
    for _ in 0..i {
        app.key(key('j'));
    }
    app.update(Msg::Steps(
        select.into(),
        Ok(parse(state.steps[select].clone())),
    ));
    app
}

fn screen(app: &mut App, w: u16, h: u16) -> String {
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| toolroll_tui::view::draw(f, app)).unwrap();
    term.backend().to_string()
}

fn link() -> TermLink {
    TermLink(tokio::sync::mpsc::unbounded_channel().0)
}

/// `t` on the result waiting, the console's terminal attached, and its screen shown.
fn taken_over() -> App {
    let mut app = app_on("t-done");
    let fx = app.key(key('t'));
    assert_eq!(
        fx,
        vec![Effect::TermOpen {
            task: "t-done".into(),
            run: fake::RESULT_RUN
        }]
    );
    assert_eq!(app.tab, Tab::Terminal);
    assert!(app
        .update(Msg::TermOpened {
            task: "t-done".into(),
            run: fake::RESULT_RUN,
            result: Ok((ID.into(), "toolroll/live-0123456789ab".into(), link()))
        })
        .is_empty());
    assert_eq!(app.mode, Mode::TakeOver);
    assert_eq!(app.status.as_ref().unwrap().1, TYPING);
    // The screen as it was (before hello), then live output.
    app.update(Msg::Term(
        ID.into(),
        TermEvent::Output(
            b"\x1b[1mbuild #2\x1b[0m ready in its worktree\r\n"
                .to_vec()
                .into(),
        ),
    ));
    app.update(Msg::Term(
        ID.into(),
        TermEvent::Hello {
            cols: 100,
            rows: 30,
            ended: false,
        },
    ));
    app.update(Msg::Term(
        ID.into(),
        TermEvent::Output(
            b"$ npm test\r\n\x1b[32m212 passed\x1b[0m (3.1 s)\r\n$ "
                .to_vec()
                .into(),
        ),
    ));
    app
}

#[test]
fn the_terminal_tab_before_and_while_typing() {
    let mut app = app_on("t-done");
    app.tab = Tab::Terminal;
    insta::assert_snapshot!("terminal_tab_not_open", screen(&mut app, 120, 30));
    let mut app = taken_over();
    let shown = screen(&mut app, 120, 30);
    assert!(
        shown.contains("212 passed") && shown.contains("Typing in a separate copy"),
        "{shown}"
    );
    insta::assert_snapshot!("terminal_tab_typing", shown);
    // Resizing follows the pane: the frame's terminal area, sent once, and the emulator follows it.
    let pane = app.term.as_ref().unwrap();
    let (cols, rows) = (pane.area.width, pane.area.height);
    assert_eq!(
        app.term_resize(),
        Some(Effect::TermSend {
            id: ID.into(),
            send: TermSend::Resize { cols, rows }
        })
    );
    assert_eq!(app.term_resize(), None);
    assert_eq!(
        app.term.as_ref().unwrap().parser.screen().size(),
        (rows, cols)
    );
    screen(&mut app, 100, 24);
    assert!(matches!(
        app.term_resize(),
        Some(Effect::TermSend {
            send: TermSend::Resize { .. },
            ..
        })
    ));
}

#[test]
fn every_key_goes_to_the_terminal_but_ctrl_close_bracket() {
    let mut app = taken_over();
    screen(&mut app, 120, 30);
    let input = |fx: Vec<Effect>| match fx.as_slice() {
        [Effect::TermSend {
            id,
            send: TermSend::Input(text),
        }] if id == ID => text.clone(),
        other => panic!("{other:?}"),
    };
    assert_eq!(input(app.key(key('l'))), "l");
    // Ctrl-C and q are the program's while typing (never quit the workbench).
    assert_eq!(input(app.key(ctrl('c'))), "\u{3}");
    assert_eq!(input(app.key(key('q'))), "q");
    assert_eq!(
        input(app.key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))),
        "\r"
    );
    assert_eq!(
        input(app.key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE))),
        "\x1b[A"
    );
    // A paste is bracketed when the program asked, with no way to end the bracket early.
    app.update(Msg::Term(
        ID.into(),
        TermEvent::Output(b"\x1b[?2004h".to_vec().into()),
    ));
    assert_eq!(
        input(app.paste("ls\x1b[20\x1b[201~1~; rm x\n")),
        "\x1b[200~ls[20[201~1~; rm x\r\x1b[201~"
    );
    // Mouse: a click in the pane only when the program asked for the mouse.
    let pane = app.term.as_ref().unwrap().area;
    let click = MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: pane.x + 2,
        row: pane.y + 1,
        modifiers: KeyModifiers::NONE,
    };
    assert_eq!(app.mouse(click), vec![]);
    app.update(Msg::Term(
        ID.into(),
        TermEvent::Output(b"\x1b[?1000h\x1b[?1006h".to_vec().into()),
    ));
    assert_eq!(input(app.mouse(click)), "\x1b[<0;3;2M");
    // Ctrl-] comes back; the terminal keeps running, and keys are the workbench's again.
    assert_eq!(app.key(ctrl(']')), vec![]);
    assert_eq!(app.mode, Mode::Normal);
    assert_eq!(app.status.as_ref().unwrap().1, BACK);
    insta::assert_snapshot!("terminal_tab_back", screen(&mut app, 120, 30));
    assert!(app
        .key(key('l'))
        .iter()
        .all(|e| !matches!(e, Effect::TermSend { .. })));
    // t types in the same terminal again (nothing new asked of the console).
    assert_eq!(app.key(key('t')), vec![]);
    assert_eq!(app.mode, Mode::TakeOver);
}

#[test]
fn keys_reach_only_the_terminal_on_screen() {
    let mut app = taken_over();
    // Another task: its socket is let go of (the program runs on), and no key reaches it any more.
    app.key(ctrl(']'));
    let fx = app.key(key('k'));
    assert!(fx.contains(&Effect::TermDetach(ID.into())), "{fx:?}");
    assert!(app.term.is_none());
    // Output for a terminal no pane shows is dropped; an attach for a pane no longer wanted is let go of.
    app.update(Msg::Term(
        ID.into(),
        TermEvent::Output(b"late".to_vec().into()),
    ));
    let fx = app.update(Msg::TermOpened {
        task: "t-done".into(),
        run: fake::RESULT_RUN,
        result: Ok((ID.into(), "toolroll/live-0123456789ab".into(), link())),
    });
    assert_eq!(fx, vec![Effect::TermDetach(ID.into())]);
}

#[test]
fn a_running_build_has_nothing_saved_to_take_over() {
    let mut app = app_on("t-live");
    assert_eq!(app.key(key('t')), vec![]);
    assert_eq!(app.status.as_ref().unwrap().1, STILL_BUILDING);
}

#[test]
fn the_console_saying_no_or_closing_is_said_plainly() {
    let mut app = app_on("t-done");
    app.key(key('t'));
    app.update(Msg::TermOpened {
        task: "t-done".into(),
        run: fake::RESULT_RUN,
        result: Err(ApiError::Refused(
            "Taking over works while you're the only person using this Toolroll.".into(),
        )),
    });
    assert_eq!(app.mode, Mode::Normal);
    assert!(matches!(app.term.as_ref().unwrap().link, Link::Closed(_)));
    insta::assert_snapshot!("terminal_tab_refused", screen(&mut app, 120, 30));
    // Signed out (or a second person joined) while typing: back to the workbench, and why.
    let mut app = taken_over();
    app.update(Msg::Term(ID.into(), TermEvent::Closed { code: Some(4401) }));
    assert_eq!(app.mode, Mode::Normal);
    assert!(app.status.as_ref().unwrap().1.contains("no longer yours"));
    // The program ended: the screen stays readable.
    let mut app = taken_over();
    app.update(Msg::Term(
        ID.into(),
        TermEvent::Exit {
            code: Some(0),
            signal: None,
        },
    ));
    assert_eq!(app.mode, Mode::Normal);
    assert!(screen(&mut app, 120, 30).contains("Ended (exit 0)"));
}

#[test]
fn scrollback_and_copy_into_the_real_terminals_own_scrollback() {
    let mut app = taken_over();
    let mut lines = String::new();
    for i in 0..200 {
        lines.push_str(&format!("line {i}\r\n"));
    }
    app.update(Msg::Term(
        ID.into(),
        TermEvent::Output(lines.into_bytes().into()),
    ));
    screen(&mut app, 120, 30);
    app.key(ctrl(']'));
    app.key(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE));
    let shown = screen(&mut app, 120, 30);
    assert!(
        shown.contains("lines back") && shown.contains("line 160"),
        "{shown}"
    );
    match app.key(key('y')).as_slice() {
        [Effect::Scrollback(lines)] => {
            assert!(
                lines.iter().any(|l| l.ends_with(" line 0"))
                    && lines.iter().any(|l| l == "line 199"),
                "{lines:?}"
            );
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(app.mode, Mode::Copied);
}

#[test]
fn step_cards_live_elapsed_cost_and_outcome() {
    let mut app = app_on("t-live");
    app.tab = Tab::Steps;
    let shown = screen(&mut app, 120, 30);
    assert!(shown.contains("running · 4m 12s · $0.31"), "{shown}");
    insta::assert_snapshot!("step_cards_live", shown);
    // A second later, the running card's time has moved on.
    app.now += 1;
    assert!(screen(&mut app, 120, 30).contains("running · 4m 13s"));
    let mut app = app_on("t-done");
    app.tab = Tab::Steps;
    insta::assert_snapshot!("step_cards_result_waiting", screen(&mut app, 120, 30));
}

// ---- the emulator: nothing the program writes reaches the real terminal ----------------------------------------------

/// What drawing `bytes` through a pane writes to a real terminal: the cells, as crossterm's backend writes them.
fn written(bytes: &[u8]) -> (String, String) {
    let mut pane = Pane::opening("t".into(), 1);
    pane.attached(ID.into());
    pane.hello(60, 6, false);
    pane.output(bytes);
    let area = Rect::new(0, 0, 60, 6);
    let mut buf = Buffer::empty(area);
    toolroll_tui::term::draw(&mut buf, area, pane.parser.screen(), Style::default());
    let mut out: Vec<u8> = Vec::new();
    {
        let mut backend = CrosstermBackend::new(&mut out);
        let cells: Vec<(u16, u16, &ratatui::buffer::Cell)> = buf
            .content
            .iter()
            .enumerate()
            .map(|(i, c)| ((i % 60) as u16, (i / 60) as u16, c))
            .collect();
        backend.draw(cells.into_iter()).unwrap();
        Backend::flush(&mut backend).unwrap();
    }
    let text: String = buf.content.iter().map(|c| c.symbol()).collect();
    (String::from_utf8_lossy(&out).into_owned(), text)
}

#[test]
fn osc_52_osc_8_titles_and_notifications_never_reach_the_real_terminal() {
    let hostile = concat!(
        "before ",
        "\x1b]52;c;ZXZpbC1jbGlwYm9hcmQ=\x07", // clipboard write
        "\x1b]52;c;?\x07",                    // clipboard read
        "\x1b]8;;https://evil.example/x\x1b\\click me\x1b]8;;\x1b\\", // a link: its text only
        "\x1b]0;evil-title\x07\x1b]2;evil-title-2\x1b\\", // window titles
        "\x1b]9;evil-notify\x07",             // a notification (iTerm2)
        "\x1b]777;notify;evil;body\x07",      // a notification (urxvt)
        "\x1b]1337;File=evil\x07",            // an inline image
        "\x1bP+q544e\x1b\\",                  // a terminfo query (DCS)
        "\x07",                               // the bell
        " after"
    );
    let (out, text) = written(hostile.as_bytes());
    for leak in [
        "\x1b]",
        "\x1bP",
        "\x07",
        "ZXZpbC1jbGlwYm9hcmQ",
        "evil.example",
        "evil-title",
        "evil-notify",
        "evil;body",
        "File=evil",
    ] {
        assert!(
            !out.contains(leak),
            "{leak:?} reached the terminal: {out:?}"
        );
    }
    assert!(text.contains("before click me after"), "{text}");
}

#[test]
fn bidi_and_control_characters_are_drawn_harmlessly() {
    // A right-to-left override, isolates, zero-width characters and C1 controls (as UTF-8) in printed text.
    let (out, text) =
        written("a\u{202e}gnp.exe\u{2066}x\u{2069}\u{200b}b\u{9b}31mc\u{85}d".as_bytes());
    for c in [
        '\u{202e}', '\u{2066}', '\u{2069}', '\u{200b}', '\u{9b}', '\u{85}',
    ] {
        assert!(!out.contains(c) && !text.contains(c), "{c:?} drawn");
    }
    assert!(text.contains("agnp.exe"), "{text}");
    // Wide characters keep their two cells; combining marks stay on their letter.
    let (_, text) = written("日本 e\u{301}!".as_bytes());
    assert!(text.starts_with("日本 e\u{301}!"), "{text}");
}

#[test]
fn a_hostile_program_cannot_make_the_emulator_panic() {
    // Huge parameters, absurd cursor moves, scroll regions and resizes, broken UTF-8, then normal text.
    let mut junk: Vec<u8> =
        b"\x1b[99999;99999H\x1b[999999999999999999A\x1b[0;0r\x1b[8;9999;9999t\x1b[?1049h\x1b[2J"
            .to_vec();
    junk.extend_from_slice(&[0xff, 0xfe, 0xc3, 0x28, 0xe2, 0x28, 0xa1]);
    junk.extend(std::iter::repeat_n(b'\x1b', 1000));
    junk.extend_from_slice(b"\x1b[?1049lstill here");
    let (out, text) = written(&junk);
    assert!(text.contains("still here"), "{text}");
    assert!(!out.contains("\x1b]"));
}

#[test]
fn a_terminal_off_screen_takes_no_keys_until_t() {
    let sends = |fx: &[Effect]| {
        fx.iter().any(|e| {
            matches!(
                e,
                Effect::TermSend {
                    send: TermSend::Input(_),
                    ..
                }
            )
        })
    };
    let mut app = taken_over();
    screen(&mut app, 120, 30);
    assert!(sends(&app.key(key('a'))));
    // The window shrinks below what the workbench can draw: typing stops, and nothing typed reaches the terminal.
    screen(&mut app, 25, 8);
    assert_eq!(app.mode, Mode::Normal);
    assert_eq!(app.status.as_ref().unwrap().1, OFF_SCREEN);
    for c in "echo hi".chars() {
        assert!(!sends(&app.key(key(c))));
    }
    assert!(!sends(&app.paste("rm -rf build\n")));
    assert_eq!(
        app.term_resize(),
        None,
        "no size is sent for a terminal that isn't drawn"
    );
    // Back to a size it fits: still not typing until t; its new size is sent.
    screen(&mut app, 120, 30);
    assert_eq!(app.mode, Mode::Normal);
    assert!(matches!(
        app.term_resize(),
        Some(Effect::TermSend {
            send: TermSend::Resize { .. },
            ..
        })
    ));
    assert!(!sends(&app.key(key('l'))));
    app.key(key('t'));
    assert_eq!(app.mode, Mode::TakeOver);
    assert!(sends(&app.key(key('l'))));
    // A key that arrives while the last frame didn't draw it (another tab drawn) is never sent either.
    app.tab = Tab::Steps;
    screen(&mut app, 120, 30);
    assert_eq!(app.mode, Mode::Normal);
    app.tab = Tab::Terminal;
    app.mode = Mode::TakeOver;
    app.term.as_mut().unwrap().drawn = false;
    assert!(!sends(&app.key(key('l'))));
    assert_eq!(app.mode, Mode::Normal);
}

#[test]
fn the_pane_says_it_is_a_separate_copy_on_its_own_branch() {
    let mut app = taken_over();
    let shown = screen(&mut app, 120, 30);
    assert!(
        shown.contains("separate copy at build #2 on toolroll/live-0123456789ab"),
        "{shown}"
    );
}

#[test]
fn nested_dcs_and_apc_strings_and_raw_8_bit_c1_never_reach_the_real_terminal() {
    let mut bytes: Vec<u8> = b"one ".to_vec();
    // A DCS holding another DCS and an APC, an APC holding an OSC, and a PM and SOS for good measure.
    bytes.extend_from_slice(b"\x1bPq\x1bP1$tevil-dcs\x1b\\inner\x1b_evil-apc\x1b\\\x1b\\");
    bytes.extend_from_slice(b"\x1b_G\x1b]52;c;U0VWRU4=\x07evil-apc2\x1b\\");
    bytes.extend_from_slice(b"\x1b^evil-pm\x1b\\\x1bXevil-sos\x1b\\");
    // Raw 8-bit C1 bytes: CSI, OSC (with a clipboard payload), DCS, APC and ST as single bytes. In UTF-8 they are no
    // sequence at all: nothing reaches the terminal but inert text (at most the payload, drawn as characters).
    bytes.extend_from_slice(b"\x9b31m\x9d52;c;OCTET==\x9c\x90evil-dcs8\x9c\x9fevil-apc8\x9c");
    bytes.extend_from_slice(b"two");
    let (out, text) = written(&bytes);
    for leak in [
        "\x1b]", "\x1bP", "\x1b_", "\x1b^", "\x1bX", "U0VWRU4", "\u{9b}", "\u{9d}", "\u{90}",
        "\u{9c}", "\u{9f}",
    ] {
        assert!(
            !out.contains(leak),
            "{leak:?} reached the terminal: {out:?}"
        );
    }
    assert!(
        !out.contains("evil-dcs\x1b") && !out.contains("\x1b\\"),
        "{out:?}"
    );
    assert!(text.contains("one") && text.contains("two"), "{text}");
    // Every escape the backend wrote is its own: cursor moves and colours (CSI), nothing else.
    let mut rest = out.as_str();
    while let Some(at) = rest.find('\x1b') {
        assert_eq!(rest.as_bytes().get(at + 1), Some(&b'['), "{out:?}");
        rest = &rest[at + 1..];
    }
}

#[test]
fn sequences_split_across_chunks_are_still_parsed_whole() {
    let mut pane = Pane::opening("t".into(), 1);
    pane.attached(ID.into());
    pane.hello(60, 6, false);
    // An OSC 52 cut into one-byte pieces, a CSI cut mid-parameter, and a UTF-8 character cut between its bytes.
    let osc = b"\x1b]52;c;ZXZpbC1zcGxpdA==\x07";
    for b in osc {
        pane.output(&[*b]);
    }
    pane.output(b"\x1b[3");
    pane.output(b"1mred\x1b[0m ");
    let ja = "日".as_bytes();
    pane.output(&ja[..1]);
    pane.output(&ja[1..]);
    pane.output(b" end");
    let area = Rect::new(0, 0, 60, 6);
    let mut buf = Buffer::empty(area);
    toolroll_tui::term::draw(&mut buf, area, pane.parser.screen(), Style::default());
    let text: String = buf.content.iter().map(|c| c.symbol()).collect();
    assert!(text.starts_with("red 日 end"), "{text:?}");
    assert!(!text.contains("ZXZp") && !text.contains("52;"), "{text:?}");
    assert_eq!(buf[(0, 0)].fg, ratatui::style::Color::Indexed(1));
}
