//! The Agents screen (agents.rs), drawn on ratatui's TestBackend from the contract's fixtures: each state held as a
//! snapshot (and at 16 colours and with colour off), what each key asks the console to do, and what never happens:
//! an install without its confirm, a models change without its confirm, a sign-in that isn't the agent's own.
#[path = "common/pairs.rs"]
mod pairs;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::style::{Color, Modifier};
use ratatui::Terminal;
use serde_json::Value;
use toolroll_api::*;
use toolroll_fake_engine as fake;
use toolroll_tui::agents::Focus;
use toolroll_tui::app::{App, Effect, Mode, Msg, TermLink};
use toolroll_tui::settings::{FileState, Prefs, Settings};
use toolroll_tui::theme::{Depth, ThemeName};

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

fn screen(app: &mut App, w: u16, h: u16) -> String {
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| toolroll_tui::view::draw(f, app)).unwrap();
    pairs::check(app, w, h);
    for cell in term.backend().buffer().content() {
        assert!(!matches!(
            cell.fg,
            Color::Yellow | Color::LightYellow | Color::Rgb(245, 165, 36)
        ));
    }
    term.backend().to_string()
}

/// The work list read, then `A`: the screen open with the agents and models read.
fn open(agents: Value) -> App {
    let mut app = App::new(false, Some("/home/me/shop".into()));
    app.now = NOW;
    app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    let fx = app.key(key('A'));
    assert!(fx.contains(&Effect::FetchModels), "{fx:?}");
    assert!(app.agents_screen.is_some());
    app.update(Msg::Agents(Ok(parse(agents))));
    app.update(Msg::Models(Ok(parse(fake::fixture("models.json")))));
    app
}

fn select(app: &mut App, id: &str) {
    for _ in 0..12 {
        if toolroll_tui::agents::current(app).map(|a| a.id.as_str()) == Some(id) {
            return;
        }
        app.key(key('j'));
    }
    panic!("no agent {id}");
}

#[test]
fn every_agent_grouped_with_how_to_add_it() {
    let mut app = open(fake::fixture("agents.json"));
    let shown = screen(&mut app, 120, 34);
    for words in [
        "Ready",
        "Needs sign-in",
        "Needs a check",
        "Not installed",
        "Sign in again",
        "Models",
        // Readable model names, from the engine's catalog.
        "Claude Opus 5.5",
    ] {
        assert!(shown.contains(words), "{words}\n{shown}");
    }
    // Installed already: no install line (y still copies it).
    assert!(
        !shown.contains("npm install -g @anthropic-ai/claude-code"),
        "{shown}"
    );
    assert!(!shown.contains("claude-opus-5-5"), "{shown}");
    insta::assert_snapshot!("agents_ready", shown);
    select(&mut app, "codex");
    insta::assert_snapshot!("agents_needs_sign_in", screen(&mut app, 120, 34));
    select(&mut app, "gemini");
    let shown = screen(&mut app, 120, 34);
    assert!(
        shown.contains("npm install -g @google/gemini-cli"),
        "{shown}"
    );
    insta::assert_snapshot!("agents_not_installed", shown);
    app.key(code(KeyCode::Tab));
    assert_eq!(app.agents_screen.as_ref().unwrap().focus, Focus::Models);
    insta::assert_snapshot!("agents_models", screen(&mut app, 120, 34));
}

#[test]
fn the_screen_at_16_colours_and_with_colour_off() {
    for (name, depth) in [
        ("agents_16", Depth::Ansi16),
        ("agents_no_color", Depth::Off),
    ] {
        let mut app = open(fake::fixture("agents.json"));
        app.prefs = Prefs::new(
            Settings {
                theme: ThemeName::Dark,
                ..Settings::default()
            },
            None,
            FileState::Missing,
            vec![],
            depth,
            None,
            Default::default(),
        );
        let mut term = Terminal::new(TestBackend::new(120, 34)).unwrap();
        term.draw(|f| toolroll_tui::view::draw(f, &mut app))
            .unwrap();
        let buf = term.backend().buffer().clone();
        if depth == Depth::Off {
            assert!(buf
                .content()
                .iter()
                .all(|c| c.fg == Color::Reset && c.bg == Color::Reset));
        }
        // The selected agent stays lit and the needs-you chip solid, with no colour at all.
        assert!(buf
            .content()
            .iter()
            .any(|c| c.modifier.contains(Modifier::REVERSED)));
        insta::assert_snapshot!(name, term.backend().to_string());
    }
}

#[test]
fn the_first_run_offers_the_agents_screen() {
    let mut app = App::new(false, Some("/home/me/shop".into()));
    app.now = NOW;
    app.update(Msg::Work(Ok(parse(fake::empty_work()))));
    app.update(Msg::Agents(Ok(parse(fake::fixture("agents.json")))));
    let shown = screen(&mut app, 120, 30);
    assert!(shown.contains("Agents  A"), "{shown}");
    insta::assert_snapshot!("first_run_agents_button", shown);
    let fx = app.key(key('A'));
    assert!(fx.contains(&Effect::FetchModels));
    assert!(app.agents_screen.is_some());
    // Esc goes back.
    app.key(code(KeyCode::Esc));
    assert!(app.agents_screen.is_none());
}

#[test]
fn sign_in_opens_the_agents_own_sign_in_and_looks_again_when_it_ends() {
    let mut app = open(fake::fixture("agents.json"));
    select(&mut app, "codex");
    let fx = app.key(key('s'));
    assert_eq!(
        fx,
        vec![Effect::AgentTerm {
            kind: "sign-in".into(),
            agent: "codex".into(),
            confirm: None
        }]
    );
    assert_eq!(app.term.as_ref().unwrap().task, "agent:codex");
    app.update(Msg::TermOpened {
        task: "agent:codex".into(),
        run: 0,
        result: Ok((
            fake::TERM_ID.into(),
            String::new(),
            TermLink(tokio::sync::mpsc::unbounded_channel().0),
        )),
    });
    assert_eq!(app.mode, Mode::TakeOver);
    app.update(Msg::Term(
        fake::TERM_ID.into(),
        TermEvent::Hello {
            cols: 80,
            rows: 20,
            ended: false,
        },
    ));
    app.update(Msg::Term(
        fake::TERM_ID.into(),
        TermEvent::Output(b"Opening your browser to sign in to Codex...\r\n\x1b]52;c;ZXZpbA==\x07Waiting for the browser...\r\n".to_vec().into()),
    ));
    let shown = screen(&mut app, 120, 34);
    assert!(
        shown.contains("Waiting for the browser") && !shown.contains("52;"),
        "{shown}"
    );
    insta::assert_snapshot!("agents_sign_in_pane", shown);
    // Typing goes to the pane only (it is drawn).
    let fx = app.key(key('x'));
    assert!(
        matches!(&fx[..], [Effect::TermSend { id, .. }] if id == fake::TERM_ID),
        "{fx:?}"
    );
    let fx = app.update(Msg::Term(
        fake::TERM_ID.into(),
        TermEvent::Exit {
            code: Some(0),
            signal: None,
        },
    ));
    assert!(fx.contains(&Effect::CheckAgents), "{fx:?}");
    assert_eq!(app.mode, Mode::Normal);
}

#[test]
fn an_agent_that_signs_in_another_way_opens_nothing() {
    let mut app = open(fake::fixture("agents.json"));
    select(&mut app, "openrouter");
    assert_eq!(app.key(key('s')), vec![]);
    assert_eq!(app.key(key('i')), vec![]);
    assert!(app.term.is_none());
}

#[test]
fn install_runs_only_after_its_confirm_of_exactly_that_command() {
    let mut app = open(fake::fixture("agents.json"));
    select(&mut app, "gemini");
    assert_eq!(app.key(key('i')), vec![]);
    assert!(
        matches!(&app.mode, Mode::ConfirmInstall { command, .. } if command == "npm install -g @google/gemini-cli")
    );
    let shown = screen(&mut app, 120, 34);
    assert!(
        shown.contains("npm install -g @google/gemini-cli") && shown.contains("Install it"),
        "{shown}"
    );
    assert!(
        shown.contains("your own npm settings (~/.npmrc: registry, proxy, sign-in)")
            && shown.contains("install scripts run"),
        "{shown}"
    );
    insta::assert_snapshot!("agents_install_confirm", shown);
    // A registry the person's ~/.npmrc names (not the public one) is said in the confirm.
    let mut read = app.agents.clone().unwrap();
    let gemini = read.agents.iter_mut().find(|a| a.id == "gemini").unwrap();
    gemini.setup.registry = Some("https://npm.example.corp/repo/".into());
    app.agents = Some(read.clone());
    let shown = screen(&mut app, 120, 34);
    assert!(
        shown.contains("Registry: https://npm.example.corp/repo/ (from your ~/.npmrc)"),
        "{shown}"
    );
    // A file it can't follow (an environment variable, say): said plainly, never a guess.
    let gemini = read.agents.iter_mut().find(|a| a.id == "gemini").unwrap();
    gemini.setup.registry = None;
    gemini.setup.registry_unsure = true;
    app.agents = Some(read);
    let shown = screen(&mut app, 120, 34);
    assert!(
        shown.contains("Your ~/.npmrc may set a different registry."),
        "{shown}"
    );
    // Any other key cancels: nothing runs.
    assert_eq!(app.key(key('x')), vec![]);
    assert_eq!(app.mode, Mode::Normal);
    assert!(app.term.is_none());
    app.key(key('i'));
    assert_eq!(
        app.key(code(KeyCode::Enter)),
        vec![Effect::AgentTerm {
            kind: "install".into(),
            agent: "gemini".into(),
            confirm: Some("npm install -g @google/gemini-cli".into())
        }]
    );
    // A curl installer is never run here: copied instead.
    select(&mut app, "goose");
    assert_eq!(app.key(key('i')), vec![]);
    assert_eq!(app.mode, Mode::Normal);
}

#[test]
fn y_copies_every_command_to_the_scrollback() {
    let mut app = open(fake::fixture("agents.json"));
    select(&mut app, "opencode");
    let fx = app.key(key('y'));
    let [Effect::Scrollback(lines)] = &fx[..] else {
        panic!("{fx:?}")
    };
    assert_eq!(lines[0], "OpenCode");
    assert!(lines
        .iter()
        .any(|l| l == "Install:  npm install -g opencode-ai"));
    assert!(lines.iter().any(|l| l == "Sign in:  opencode auth login"));
    assert!(lines
        .iter()
        .any(|l| l == "Check:    toolroll agents check opencode --model <model>"));
    assert_eq!(app.mode, Mode::Copied);
}

#[test]
fn a_models_change_is_shown_before_it_is_saved_through_settings_models() {
    let mut app = open(fake::fixture("agents.json"));
    app.key(code(KeyCode::Tab));
    app.key(key('j'));
    app.key(key('j'));
    assert_eq!(app.key(code(KeyCode::Enter)), vec![]);
    let Mode::PickModel(pick) = &app.mode else {
        panic!("{:?}", app.mode)
    };
    assert_eq!(pick.role, "build");
    insta::assert_snapshot!("agents_pick_model", screen(&mut app, 120, 34));
    // Codex · GPT-6 Sol: four down from Claude Sonnet.
    for _ in 0..3 {
        app.key(key('j'));
    }
    assert_eq!(app.key(code(KeyCode::Enter)), vec![]);
    let shown = screen(&mut app, 120, 34);
    assert!(
        shown
            .contains("Builder for routine tasks: Claude Sonnet 5.5 · $$ → Codex · GPT-6 Sol · $$"),
        "{shown}"
    );
    insta::assert_snapshot!("agents_models_confirm", shown);
    let fx = app.key(code(KeyCode::Enter));
    let [Effect::Act { path, fields, .. }] = &fx[..] else {
        panic!("{fx:?}")
    };
    assert_eq!(path, "/settings/models/agent");
    let field = |k: &str| fields.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    assert_eq!(field("build"), Some("codex|gpt-6-sol"));
    assert_eq!(field("digest"), Some("d".repeat(64).as_str()));
    assert_eq!(field("scope"), Some("installation"));
    // No password is ever carried here: the console proves the person itself.
    assert_eq!(field("password"), Some(""));
    assert_eq!(fields.len(), 4);
}

#[test]
fn the_default_agent_moves_every_role_to_its_preset() {
    let mut app = open(fake::fixture("agents.json"));
    app.key(code(KeyCode::Tab));
    app.key(code(KeyCode::Enter));
    app.key(key('j'));
    app.key(code(KeyCode::Enter));
    screen(&mut app, 120, 34);
    let fx = app.key(code(KeyCode::Enter));
    let [Effect::Act { fields, .. }] = &fx[..] else {
        panic!("{fx:?}")
    };
    for (k, v) in [
        ("plan", "codex|gpt-6-astra"),
        ("build", "codex|gpt-6-sol"),
        ("review", "codex|gpt-6-astra"),
    ] {
        assert!(
            fields.contains(&(k.to_string(), v.to_string())),
            "{fields:?}"
        );
    }
}

#[test]
fn a_session_that_cant_change_models_is_told_where_and_sends_nothing() {
    let mut app = open(fake::fixture("agents.json"));
    let mut locked: ModelsRead = parse(fake::fixture("models.json"));
    locked.can_change = false;
    app.update(Msg::Models(Ok(locked)));
    app.key(code(KeyCode::Tab));
    assert_eq!(app.key(code(KeyCode::Enter)), vec![]);
    assert_eq!(app.mode, Mode::Normal);
    assert_eq!(
        app.status.as_ref().unwrap().1,
        toolroll_tui::agents::MODELS_LOCKED
    );
}

#[test]
fn check_again_asks_the_console_and_agent_text_is_drawn_inert() {
    let mut read = fake::fixture("agents.json");
    read["agents"][0]["name"] = "Claude\u{1b}]8;;https://evil.example\u{7}Code\u{1b}[2J".into();
    let mut app = open(read);
    assert_eq!(app.key(key('r')), vec![Effect::CheckAgents]);
    assert!(app.agents_screen.as_ref().unwrap().checking);
    let shown = screen(&mut app, 120, 34);
    assert!(
        // Every control character is a visible stand-in (text.rs clean), never sent to the terminal.
        !shown.contains('\u{1b}') && shown.contains("Claude\u{fffd}]8;;"),
        "{shown}"
    );
    app.update(Msg::Agents(Ok(parse(fake::fixture("agents.json")))));
    assert!(!app.agents_screen.as_ref().unwrap().checking);
}

/// A sign-in's output is kept nowhere here: no scrollback, never copied, and the pane (its screen and all) is gone once
/// the program ends or the screen closes.
#[test]
fn a_sign_in_pane_keeps_nothing_once_it_ends_or_closes() {
    let token = "sk-ant-oat01-FAKE-0123456789abcdef";
    for ending in ["exit", "close"] {
        let mut app = open(fake::fixture("agents.json"));
        select(&mut app, "codex");
        app.key(key('s'));
        app.update(Msg::TermOpened {
            task: "agent:codex".into(),
            run: 0,
            result: Ok((
                fake::TERM_ID.into(),
                String::new(),
                TermLink(tokio::sync::mpsc::unbounded_channel().0),
            )),
        });
        app.update(Msg::Term(
            fake::TERM_ID.into(),
            TermEvent::Hello {
                cols: 80,
                rows: 5,
                ended: false,
            },
        ));
        let mut long = String::new();
        for i in 0..40 {
            long.push_str(&format!("line {i}\r\n"));
        }
        long.push_str(&format!("Your token: {token}\r\n"));
        app.update(Msg::Term(
            fake::TERM_ID.into(),
            TermEvent::Output(long.into_bytes().into()),
        ));
        assert!(screen(&mut app, 120, 34).contains(token));
        // No scrollback: the 40 lines above the 5-row screen were never kept.
        let pane = app.term.as_mut().unwrap();
        pane.parser.screen_mut().set_scrollback(usize::MAX);
        assert_eq!(pane.parser.screen().scrollback(), 0, "scrollback kept");
        pane.parser.screen_mut().set_scrollback(0);
        // And it is never copied (the copy action and `y` read nothing of it).
        assert!(pane.sensitive && pane.text_lines().is_empty());
        app.mode = Mode::Normal;
        let fx = if ending == "exit" {
            app.update(Msg::Term(
                fake::TERM_ID.into(),
                TermEvent::Exit {
                    code: Some(0),
                    signal: None,
                },
            ))
        } else {
            app.key(code(KeyCode::Esc))
        };
        assert!(
            fx.contains(&Effect::TermDetach(fake::TERM_ID.into())),
            "{ending}: {fx:?}"
        );
        assert!(app.term.is_none(), "{ending}: the pane is kept");
        assert!(!screen(&mut app, 120, 34).contains(token), "{ending}");
    }
}
