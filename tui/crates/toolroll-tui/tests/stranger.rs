//! What a stranger's first run of the published workbench found (scratchpad stranger test, 0.9.110), each held here:
//! every row Work sends is listed (and found by the palette), a failed task says why and offers Retry, the first run is
//! the workbench's own welcome, help is made from the keymap, a key that does nothing says so, the Agents screen's
//! sign-in states, the screen glitches, and Settings writing tui.toml.
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use serde_json::{json, Value};
use toolroll_api::*;
use toolroll_fake_engine as fake;
use toolroll_tui::app::{items_of, section_of, App, Effect, Mode, Msg, Section, TermLink};
use toolroll_tui::keys::{help_rows, Keymap, Scope, SPECS};
use toolroll_tui::settings::{set_in_toml, Choice, FileState, Prefs, Settings};

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
    term.backend().to_string()
}
fn app_on(work: Value) -> App {
    let mut app = App::new(false, Some("/work/proj".into()));
    app.now = NOW;
    app.update(Msg::Work(Ok(parse(work))));
    app
}
fn select(app: &mut App, id: &str) -> Vec<Effect> {
    let at = app.items.iter().position(|i| i.id == id).expect("listed");
    let mut fx = vec![];
    while app.selected < at {
        fx = app.key(key('j'));
    }
    while app.selected > at {
        fx = app.key(key('k'));
    }
    fx
}
fn status(app: &App) -> String {
    app.status
        .as_ref()
        .map(|(_, w)| w.clone())
        .unwrap_or_default()
}

/// The contract's own closed enums for a Work row (schemas.json, generated from src/contracts/engine-api.ts).
fn contract_enum(path: &[&str]) -> Vec<String> {
    let schemas: Value = serde_json::from_str(toolroll_api::SCHEMAS_JSON).unwrap();
    let mut at = &schemas["responses"]["workRows"]["properties"]["rows"]["items"]["properties"];
    for p in path {
        at = &at[*p];
    }
    at["enum"]
        .as_array()
        .unwrap_or_else(|| panic!("{path:?} is no enum in the contract"))
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect()
}

// ---- 1. every row Work sends is listed ---------------------------------------------------------------------------

#[test]
fn every_group_tone_rank_and_token_the_contract_allows_is_listed() {
    let groups = contract_enum(&["group"]);
    let tones = contract_enum(&["status", "properties", "tone"]);
    assert!(groups.contains(&"rest".to_string()) && tones.contains(&"muted".to_string()));
    // The token is open (dozens of status words): the ones the stranger hit, and one no client has seen.
    let tokens = [
        "ready",
        "assignment-working",
        "failed",
        "cancelled",
        "a-token-from-next-year",
    ];
    let base = fake::fixture("work-rows.json");
    let mut rows = vec![];
    for g in &groups {
        for t in &tones {
            for rank in 0..=4 {
                for token in tokens {
                    let mut r = base["rows"][1].clone();
                    r["id"] = json!(format!("t-{g}-{t}-{rank}-{token}"));
                    r["group"] = json!(g);
                    r["status"] = json!({ "label": "Something", "tone": t, "token": token });
                    r["rank"] = json!(rank);
                    rows.push(r);
                }
            }
        }
    }
    let n = rows.len();
    let mut work = base.clone();
    work["rows"] = json!(rows);
    work["needs"] = json!([]);
    let read: WorkRows = parse(work);
    let items = items_of(&read);
    assert_eq!(items.len(), n, "a row was dropped");
    for r in &read.rows {
        let listed: Vec<_> = items.iter().filter(|i| i.id == r.id).collect();
        assert_eq!(listed.len(), 1, "{} listed {} times", r.id, listed.len());
        assert_eq!(listed[0].section, section_of(r));
        assert!(Section::ALL.contains(&listed[0].section));
    }
}

#[test]
fn a_queued_task_a_retry_waiting_and_finished_ones_are_listed_and_found() {
    let mut app = app_on(fake::fixture("work-rows-every-kind.json"));
    let at = |app: &App, id: &str| app.items.iter().find(|i| i.id == id).map(|i| i.section);
    assert_eq!(at(&app, "t-failed"), Some(Section::NeedsYou));
    assert_eq!(at(&app, "t-retry"), Some(Section::UpNext));
    assert_eq!(at(&app, "t-queued"), Some(Section::UpNext));
    assert_eq!(at(&app, "t-done"), Some(Section::Recent));
    assert_eq!(at(&app, "t-cancelled"), Some(Section::Recent));
    let shown = screen(&mut app, 120, 30);
    for words in [
        "Up next",
        "Recent",
        "Retrying in 2 min",
        "Add a changelog entry",
        "Work  5",
    ] {
        assert!(shown.contains(words), "{words}\n{shown}");
    }
    assert!(!shown.contains("Nothing yet"), "{shown}");
    insta::assert_snapshot!("every_kind_listed", shown);
    // The palette finds the queued one.
    app.key(key(':'));
    for c in "changelog".chars() {
        app.key(key(c));
    }
    let shown = screen(&mut app, 120, 30);
    assert!(shown.contains("Add a changelog entry"), "{shown}");
}

// ---- 2. a failed task says why and offers Retry ------------------------------------------------------------------

fn failed_steps() -> Value {
    let mut s = fake::steps_for("t-failed", "Add a subtract function", None, None);
    s["task"]["state"] = json!("failed");
    s["headline"] = json!("Failed");
    s["failure"] = json!({ "line": "A temporary problem on the machine stopped it.", "failedInARow": 3,
        "suggestion": "Retry as it is; if it stops the same way, try another agent." });
    s["retry"] = json!({ "run": 3, "digest": "d".repeat(64) });
    s["approval"] = json!({ "by": "me", "you": true, "automatic": false });
    s
}

fn failed_app() -> App {
    let mut app = app_on(fake::fixture("work-rows-every-kind.json"));
    select(&mut app, "t-failed");
    app.update(Msg::Steps("t-failed".into(), Ok(parse(failed_steps()))));
    app
}

#[test]
fn a_failed_task_says_why_and_offers_retry_only() {
    let mut app = failed_app();
    let wide = screen(&mut app, 160, 30);
    assert!(
        wide.contains("A temporary problem on the machine stopped it · 3 consecutive failures"),
        "{wide}"
    );
    let shown = screen(&mut app, 120, 30);
    assert!(shown.contains("Retry (Review and retry)"), "{shown}");
    // The key bar: only what a failed task allows.
    let bar = shown.lines().last().unwrap().to_string();
    assert!(bar.contains("r retry"), "{bar}");
    assert!(!bar.contains("steer") && !bar.contains("accept"), "{bar}");
    insta::assert_snapshot!("failed_live", shown);
    // Steps: who approved, truthfully.
    app.key(code(KeyCode::Tab));
    let shown = screen(&mut app, 120, 30);
    assert!(
        shown.contains("You approved: just code (no plan)."),
        "{shown}"
    );
    assert!(!shown.contains("no plan or approval step"), "{shown}");
    insta::assert_snapshot!("failed_steps", shown);
}

#[test]
fn retry_posts_exactly_the_build_and_scope_shown_after_its_confirm() {
    let mut app = failed_app();
    assert_eq!(app.key(key('r')), vec![]);
    assert!(
        matches!(&app.mode, Mode::ConfirmRetry { run: 3, .. }),
        "{:?}",
        app.mode
    );
    insta::assert_snapshot!("retry_confirm", screen(&mut app, 120, 30));
    let fx = app.key(code(KeyCode::Enter));
    assert_eq!(
        fx,
        vec![Effect::Act {
            path: "/t/t-failed/requeue".into(),
            fields: vec![
                ("run".into(), "3".into()),
                ("digest".into(), "d".repeat(64)),
                ("return".into(), "task".into())
            ],
            done: "Retrying build #3: it starts again under your approval.".into(),
        }]
    );
    // Any other key: nothing is posted.
    app.key(key('r'));
    assert_eq!(app.key(key('x')), vec![]);
    assert_eq!(app.mode, Mode::Normal);
    // A task that changed under the dialog isn't retried.
    app.key(key('r'));
    let mut changed = failed_steps();
    changed["retry"] = json!({ "run": 4, "digest": "d".repeat(64) });
    app.update(Msg::Steps("t-failed".into(), Ok(parse(changed))));
    assert_eq!(app.key(code(KeyCode::Enter)), vec![]);
    assert!(status(&app).contains("changed"), "{}", status(&app));
}

#[test]
fn steer_and_accept_say_why_not_on_a_failed_task() {
    let mut app = failed_app();
    app.key(key('s'));
    assert!(
        status(&app).contains("Nothing is building"),
        "{}",
        status(&app)
    );
    app.key(key('a'));
    assert!(
        status(&app).contains("No result is waiting"),
        "{}",
        status(&app)
    );
}

// ---- 3. the first run is the workbench's own welcome --------------------------------------------------------------

#[test]
fn the_first_run_welcome_is_not_hijacked_by_the_engines_setup_step() {
    let mut work = fake::empty_work();
    let mut need = fake::fixture("work-rows.json")["rows"][0]["need"].clone();
    need["id"] = json!("setup:task");
    need["title"] = json!("File your first task");
    need["ask"] = json!("setup");
    need["group"] = json!("unblock");
    need["question"] = Value::Null;
    let mut agent = need.clone();
    agent["id"] = json!("setup:agent");
    agent["title"] = json!("Sign in to a coding agent");
    work["needsCount"] = json!(2);
    work["needs"] =
        json!([{ "key": "unblock", "label": "Unblock", "count": 2, "rows": [need, agent] }]);
    let mut app = app_on(work);
    app.update(Msg::Agents(Ok(parse(fake::fixture("agents.json")))));
    assert!(app.items.is_empty(), "{:?}", app.items);
    assert_eq!(app.needs_count, 0);
    let shown = screen(&mut app, 120, 30);
    for words in [
        "What would you like to work on?",
        "New task",
        "Agents",
        "Nothing needs you",
        "n new task",
        "A agents",
    ] {
        assert!(shown.contains(words), "{words}\n{shown}");
    }
    for never in [
        "File your first task",
        "open it in the browser",
        "1 needs you",
    ] {
        assert!(!shown.contains(never), "{never}\n{shown}");
    }
    insta::assert_snapshot!("first_run_welcome", shown);
}

// ---- 4. help is the keymap; a key that does nothing says so --------------------------------------------------------

#[test]
fn help_lists_every_bound_key_from_the_keymap() {
    for map in [
        Keymap::default(),
        Keymap::preset(toolroll_tui::keys::Preset::Vim),
    ] {
        let rows = help_rows(&map);
        for spec in SPECS {
            if map.keys_of(spec.action).is_empty() {
                continue;
            }
            assert!(
                rows.iter().any(|r| r.actions.contains(&spec.action)
                    && r.keys.contains(&map.key_words(spec.action))),
                "{} isn't in help",
                spec.id
            );
        }
    }
    let mut app = app_on(fake::scenario_work());
    app.key(key('?'));
    let shown = screen(&mut app, 120, 30);
    let rows = help_rows(&app.prefs.settings.keymap);
    for r in rows.iter().filter(|r| r.scope == Scope::Global) {
        let keys = if r.keys == "Enter" {
            "⏎".to_string()
        } else {
            r.keys.clone()
        };
        assert!(shown.contains(&keys), "{keys}\n{shown}");
    }
    for words in [
        "Agents",
        "New thread",
        "These keys",
        "Esc",
        "Ctrl-]",
        "[keys]",
        "Press s for settings",
    ] {
        assert!(shown.contains(words), "{words}\n{shown}");
    }
    insta::assert_snapshot!("help_from_keymap", shown);
}

#[test]
fn a_key_that_does_nothing_says_so() {
    let mut app = app_on(fake::scenario_work());
    for c in ['c', 'b'] {
        assert_eq!(app.key(key(c)), vec![]);
        assert_eq!(
            status(&app),
            format!("{c} does nothing here · : shows every action")
        );
    }
}

#[test]
fn the_cli_help_says_the_workbench_keys() {
    let help = std::fs::read_to_string(format!(
        "{}/../../../src/cli-help.ts",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let line = help.lines().find(|l| l.contains("keys:")).unwrap();
    let map = Keymap::default();
    for (action, words) in [
        (toolroll_tui::keys::Action::NewTask, "new task"),
        (toolroll_tui::keys::Action::Accept, "accept"),
        (toolroll_tui::keys::Action::SendBack, "send back"),
        (toolroll_tui::keys::Action::Agents, "agents"),
        (toolroll_tui::keys::Action::Help, "all keys"),
    ] {
        let said = format!("{} {words}", map.key_words(action));
        assert!(line.contains(&said), "{said} not in {line}");
    }
    for never in ["c accept", "b send back"] {
        assert!(!line.contains(never), "{line}");
    }
}

// ---- 5. the Agents screen ------------------------------------------------------------------------------------------

fn agents_app() -> App {
    let mut app = app_on(fake::scenario_work());
    app.key(key('A'));
    app.update(Msg::Agents(Ok(parse(fake::fixture("agents.json")))));
    app.update(Msg::Models(Ok(parse(fake::fixture("models.json")))));
    app
}
fn select_agent(app: &mut App, id: &str) {
    for _ in 0..12 {
        if toolroll_tui::agents::current(app).map(|a| a.id.as_str()) == Some(id) {
            return;
        }
        app.key(key('j'));
    }
    panic!("no agent {id}");
}

#[test]
fn a_ready_agent_offers_sign_in_again_behind_a_confirm() {
    let mut app = agents_app();
    select_agent(&mut app, "claude");
    let shown = screen(&mut app, 120, 34);
    assert!(shown.contains("Sign in again"), "{shown}");
    assert_eq!(app.key(key('s')), vec![]);
    let Mode::ConfirmSignInAgain { words, .. } = &app.mode else {
        panic!("{:?}", app.mode)
    };
    assert_eq!(
        words,
        "You're signed in as a Claude account. Start a new sign-in?"
    );
    insta::assert_snapshot!("sign_in_again_confirm", screen(&mut app, 120, 34));
    assert_eq!(app.key(key('x')), vec![]);
    assert_eq!(app.mode, Mode::Normal);
    app.key(key('s'));
    let fx = app.key(code(KeyCode::Enter));
    assert!(
        matches!(&fx[..], [Effect::AgentTerm { kind, agent, .. }] if kind == "sign-in" && agent == "claude"),
        "{fx:?}"
    );
}

#[test]
fn a_failed_sign_in_says_so_and_keeps_saying_it() {
    let mut app = agents_app();
    select_agent(&mut app, "codex");
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
            rows: 10,
            ended: false,
        },
    ));
    app.update(Msg::Term(
        fake::TERM_ID.into(),
        TermEvent::Output(b"secret-looking output\r\n".to_vec().into()),
    ));
    let fx = app.update(Msg::Term(
        fake::TERM_ID.into(),
        TermEvent::Exit {
            code: Some(1),
            signal: None,
        },
    ));
    assert!(fx.contains(&Effect::CheckAgents), "{fx:?}");
    let said = "codex login exited with an error (code 1). Try again with s.";
    assert_eq!(status(&app), said);
    // Detection answers: the outcome stays, on the status line and the agent's screen; the output never.
    app.update(Msg::Agents(Ok(parse(fake::fixture("agents.json")))));
    assert_eq!(status(&app), said);
    let shown = screen(&mut app, 120, 34);
    assert!(
        shown.contains("codex login exited with an error (code 1)"),
        "{shown}"
    );
    assert!(!shown.contains("secret-looking"), "{shown}");
    assert!(app.term.is_none());
    insta::assert_snapshot!("sign_in_failed", shown);
}

#[test]
fn checked_at_is_the_persons_own_clock() {
    use toolroll_tui::agents::local_hhmm;
    assert_eq!(local_hhmm("2026-11-16T06:49:12.000Z", 0), "06:49");
    assert_eq!(local_hhmm("2026-11-16T06:49:12.000Z", -8 * 3600), "22:49");
    assert_eq!(local_hhmm("2026-11-16T23:30:00Z", 5 * 3600 + 1800), "05:00");
    assert_eq!(local_hhmm("not a time", 3600), "not a time");
}

#[test]
fn the_default_agent_picker_says_who_is_signed_in_and_offers_a_sign_in() {
    let mut app = agents_app();
    app.key(code(KeyCode::Tab));
    assert_eq!(app.key(code(KeyCode::Enter)), vec![]);
    let shown = screen(&mut app, 120, 34);
    assert!(shown.contains("Claude Code (ready)"), "{shown}");
    assert!(
        shown.contains("Codex (installed, not signed in)"),
        "{shown}"
    );
    // No choice is cut mid-word: each is wrapped whole.
    assert!(!shown.contains('…'), "{shown}");
    insta::assert_snapshot!("default_agent_picker", shown);
    app.key(key('j'));
    app.key(code(KeyCode::Enter));
    let Mode::ConfirmModels(change) = &app.mode else {
        panic!("{:?}", app.mode)
    };
    assert_eq!(change.sign_in.as_deref(), Some("codex"));
    let shown = screen(&mut app, 120, 34);
    assert!(shown.contains("Codex isn't signed in yet"), "{shown}");
    assert!(shown.contains("Sign in to it first"), "{shown}");
    let fx = app.key(key('s'));
    assert!(
        matches!(&fx[..], [Effect::AgentTerm { kind, agent, .. }] if kind == "sign-in" && agent == "codex"),
        "{fx:?}"
    );
}

#[test]
fn no_agents_line_is_cut_mid_word_at_120_columns() {
    let mut app = agents_app();
    for id in [
        "claude",
        "codex",
        "opencode",
        "gemini",
        "openrouter",
        "cursor",
        "cline",
        "qwen",
        "goose",
    ] {
        if toolroll_tui::agents::current(&app).is_none() {
            break;
        }
        let _ = id;
        let shown = screen(&mut app, 120, 34);
        assert!(!shown.contains('…'), "{shown}");
        app.key(key('j'));
    }
}

// ---- 6. glitches ---------------------------------------------------------------------------------------------------

#[test]
fn the_new_task_hint_fits_at_120_by_30() {
    let mut app = app_on(fake::scenario_work());
    app.update(Msg::Agents(Ok(parse(fake::fixture("agents.json")))));
    app.key(key('n'));
    let shown = screen(&mut app, 120, 30);
    let hint = shown.lines().find(|l| l.contains("In proj")).expect("hint");
    assert!(!hint.contains('…'), "{hint}");
    assert!(hint.contains("plan first"), "{hint}");
}

#[test]
fn leaving_a_screen_clears_what_it_said() {
    let mut app = agents_app();
    app.key(key('y'));
    app.key(key('x'));
    assert!(status(&app).contains("scrollback"), "{}", status(&app));
    app.key(code(KeyCode::Esc));
    assert!(app.agents_screen.is_none());
    assert_eq!(status(&app), "");
}

#[test]
fn the_palette_keeps_one_width() {
    let mut app = app_on(fake::scenario_work());
    let width_of = |app: &mut App| {
        let shown = screen(app, 120, 30);
        let top = shown
            .lines()
            .find(|l| l.contains("Commands"))
            .unwrap()
            .to_string();
        top.trim_matches(|c| c == '"')
            .trim()
            .chars()
            .filter(|c| *c == '─' || *c == '╭' || *c == '╮')
            .count()
    };
    app.key(key(':'));
    let open = width_of(&mut app);
    for c in "zzzz".chars() {
        app.key(key(c));
    }
    assert_eq!(width_of(&mut app), open);
    app.key(code(KeyCode::Backspace));
    app.key(code(KeyCode::Backspace));
    app.key(code(KeyCode::Backspace));
    app.key(code(KeyCode::Backspace));
    for c in "quit".chars() {
        app.key(key(c));
    }
    assert_eq!(width_of(&mut app), open);
}

// ---- 7. Settings writes tui.toml -----------------------------------------------------------------------------------

#[test]
fn a_setting_is_set_in_place_keeping_comments_and_unknown_keys() {
    let text = "# mine\ntheme = \"dark\"   # night\nsurprise = 1\n\n[notifications]\nasks = true\n\n[keys]\npreset = \"vim\"\n";
    let out = set_in_toml(text, "", "theme", "\"light\"");
    assert_eq!(
        out,
        text.replace("theme = \"dark\"   # night", "theme = \"light\"  # night")
    );
    let out = set_in_toml(text, "", "density", "\"comfortable\"");
    assert!(
        out.contains("surprise = 1\ndensity = \"comfortable\"\n\n[notifications]"),
        "{out}"
    );
    let out = set_in_toml(text, "notifications", "failed", "false");
    assert!(
        out.contains("[notifications]\nasks = true\nfailed = false\n"),
        "{out}"
    );
    let out = set_in_toml(text, "notifications", "asks", "false");
    assert!(
        out.contains("[notifications]\nasks = false\n") && out.contains("[keys]\npreset = \"vim\""),
        "{out}"
    );
    // A dotted key at the top is the same setting.
    let out = set_in_toml(
        "notifications.asks = true\n",
        "notifications",
        "asks",
        "false",
    );
    assert_eq!(out, "notifications.asks = false\n");
    // No section yet: it is made.
    let out = set_in_toml("theme = \"dark\"\n", "notifications", "finished", "true");
    assert_eq!(
        out,
        "theme = \"dark\"\n\n[notifications]\nfinished = true\n"
    );
    // What it writes reads back as the change.
    let (s, warnings) = toolroll_tui::settings::parse(&set_in_toml(text, "", "theme", "\"light\""));
    assert_eq!(s.theme, toolroll_tui::theme::ThemeName::Light);
    assert!(
        warnings.iter().all(|w| w.contains("surprise")),
        "{warnings:?}"
    );
}

#[cfg(unix)]
mod files {
    use super::*;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("tr-settings-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700)).unwrap();
        d.canonicalize().unwrap()
    }
    fn prefs_at(path: std::path::PathBuf, home: std::path::PathBuf, file: FileState) -> Prefs {
        Prefs {
            settings: Settings::default(),
            path: Some(path),
            home: Some(home),
            file,
            ..Default::default()
        }
    }

    #[test]
    fn a_change_writes_a_fresh_file_0600_then_edits_it_in_place() {
        let home = dir("fresh");
        let path = home.join(".config").join("toolroll").join("tui.toml");
        let mut p = prefs_at(path.clone(), home.clone(), FileState::Missing);
        let said = p.change(Choice::Density).unwrap();
        assert_eq!(said, "Density: comfortable. Saved to tui.toml.");
        let m = std::fs::metadata(&path).unwrap();
        assert_eq!(m.mode() & 0o777, 0o600);
        assert_eq!(
            std::fs::metadata(path.parent().unwrap()).unwrap().mode() & 0o777,
            0o700
        );
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            text.starts_with("# Toolroll's terminal workbench settings"),
            "{text}"
        );
        assert!(text.contains("density = \"comfortable\""), "{text}");
        // Edited in place: a comment and a key it doesn't know are kept.
        std::fs::write(&path, format!("{text}# mine\nmystery = \"x\"\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        p.change(Choice::Asks).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            text.contains("# mine\nmystery = \"x\"")
                && text.contains("[notifications]\nasks = false"),
            "{text}"
        );
        // And it reads back.
        let (s, _) = toolroll_tui::settings::parse(&text);
        assert_eq!(
            (s.density, s.notify.asks),
            (toolroll_tui::settings::Density::Comfortable, false)
        );
        // No temporary file is left behind.
        let left: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left.len(), 1, "{left:?}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn it_never_writes_through_a_link_or_into_a_folder_others_can_change() {
        let home = dir("unsafe");
        let real = home.join("dotfiles-tui.toml");
        std::fs::write(&real, "theme = \"dark\"\n").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o600)).unwrap();
        let conf = home.join("conf");
        std::fs::create_dir_all(&conf).unwrap();
        std::fs::set_permissions(&conf, std::fs::Permissions::from_mode(0o700)).unwrap();
        let link = conf.join("tui.toml");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let mut p = prefs_at(link.clone(), home.clone(), FileState::Read);
        let said = p.change(Choice::Theme).unwrap_err();
        assert!(said.contains("is a link"), "{said}");
        assert_eq!(
            std::fs::read_to_string(&real).unwrap(),
            "theme = \"dark\"\n"
        );
        // The change still holds for the session.
        assert_ne!(p.settings.theme, Settings::default().theme);
        let open = home.join("open");
        std::fs::create_dir_all(&open).unwrap();
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o777)).unwrap();
        let mut p = prefs_at(open.join("tui.toml"), home.clone(), FileState::Missing);
        let said = p.change(Choice::Glyphs).unwrap_err();
        assert!(said.contains("other people"), "{said}");
        assert!(!open.join("tui.toml").exists());
        // An ignored file is never written over.
        let mut p = prefs_at(
            home.join("tui.toml"),
            home.clone(),
            FileState::Ignored("it belongs to another user".into()),
        );
        assert!(p.change(Choice::Failed).unwrap_err().contains("ignored"));
        assert!(!home.join("tui.toml").exists());
        let _ = std::fs::remove_dir_all(&home);
    }
}

#[test]
fn the_settings_screen_changes_a_choice_with_enter() {
    let mut app = app_on(fake::scenario_work());
    app.key(key('?'));
    app.key(key('s'));
    assert_eq!(app.mode, Mode::Settings);
    app.key(key('j'));
    app.key(code(KeyCode::Enter));
    // No settings file here (no home): the change holds for the session, said plainly.
    assert_eq!(
        app.prefs.settings.density,
        toolroll_tui::settings::Density::Comfortable
    );
    assert!(
        status(&app).starts_with("Density: comfortable"),
        "{}",
        status(&app)
    );
    assert_eq!(app.mode, Mode::Settings);
    let shown = screen(&mut app, 120, 34);
    assert!(shown.contains("› Density"), "{shown}");
    insta::assert_snapshot!("settings_changeable", shown);
}
