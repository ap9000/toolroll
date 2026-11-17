//! The colour pairs the screen actually draws, found by drawing it (common/pairs.rs, which every test that draws a
//! screen also calls): here every item on every tab, every layout (list full, rail, hidden; one, two and four panels;
//! zoomed; the list on the right; no key bar; compact), toasts, and dialogs, each at three sizes. Every pair found must
//! be one theme::DRAWN_PAIRS (or CODE_ACCENT_ON, SAME_ROLE_DRAWN) lists, and a colour that is no role fails.
#[path = "common/pairs.rs"]
mod pairs;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::Value;
use std::collections::BTreeSet;
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, Effect, Msg, Tab, Tone};
use toolroll_tui::theme::{self, Depth, Paint, Role, Theme, ThemeName};

const NOW: i64 = 1_794_657_852;

fn parse<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).expect("fixture shape")
}
fn key(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)
}

/// Answer the reads an update asked for from the scenario (steps, live windows, a diff and its first file).
fn answer(app: &mut App, fx: Vec<Effect>) {
    let state = fake::scenario();
    let mut todo = fx;
    for _ in 0..8 {
        let mut next = vec![];
        for e in todo.drain(..) {
            match e {
                Effect::FetchSteps(task) => {
                    if let Some(steps) = state.steps.get(&task) {
                        next.extend(app.update(Msg::Steps(task, Ok(parse(steps.clone())))));
                    }
                }
                Effect::FetchLive {
                    run,
                    file,
                    cursor: None,
                } => {
                    let records = if file == "main" {
                        state.live.get(&run).map(|(r, _)| r.clone())
                    } else {
                        state.sub.get(&run).cloned()
                    };
                    if let Some(records) = records {
                        let window = serde_json::json!({ "version": 1, "session": { "kind": "run", "id": run, "task": null }, "room": format!("agent:{run}"), "live": true, "file": file,
                            "window": { "ok": true, "records": records, "cursor": "c1", "restarted": false, "earlier": false, "quarantined": 0, "skipped": 0, "more": false } });
                        next.extend(app.update(Msg::Live(run, file, Ok(parse(window)))));
                    }
                }
                Effect::FetchDiff(ask) => {
                    if let Some(diff) = state.diffs.get(&ask.task) {
                        next.extend(app.update(Msg::Diff(ask, Ok(parse(diff.clone())))));
                    }
                }
                Effect::FetchDiffFile(ask) => {
                    if let Some(file) = state.diff_files.get(&format!("{}:{}", ask.task, ask.file))
                    {
                        let mut file = file.clone();
                        file["run"] = ask.run.into();
                        next.extend(app.update(Msg::DiffFile(ask, Ok(parse(file)))));
                    }
                }
                _ => {}
            }
        }
        if next.is_empty() {
            return;
        }
        todo = next;
    }
}

const SIZES: [(u16, u16); 3] = [(160, 44), (100, 30), (60, 20)];

/// The scenario's workbench with `select` selected, as a person reaches it.
fn on(select: &str) -> App {
    let mut app = App::new(false, Some("/home/me/shop".into()));
    app.now = NOW;
    let fx = app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    answer(&mut app, fx);
    let at = app.items.iter().position(|i| i.id == select).unwrap();
    while app.selected < at {
        let fx = app.key(key('j'));
        answer(&mut app, fx);
    }
    app
}

fn keys(app: &mut App, keys: &str) {
    for c in keys.chars() {
        let k = match c {
            '\t' => KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE),
            '\n' => KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            c => key(c),
        };
        let fx = app.key(k);
        answer(app, fx);
    }
}

/// Every scene, by name: each item on each tab, each layout, toasts and dialogs.
fn scenes() -> Vec<(String, App)> {
    let items = ["t-ask", "t-done", "t-live", "t-rate", "t-old"];
    let mut out = vec![];
    for select in items {
        for tab in [Tab::Live, Tab::Steps, Tab::Diff, Tab::Terminal] {
            let mut app = on(select);
            while app.tab != tab {
                keys(&mut app, "\t");
            }
            out.push((format!("{select} {tab:?}"), app));
        }
        // Layouts: the list as a rail and hidden, two and four panels, zoomed.
        for (name, k) in [
            ("rail", "b"),
            ("hidden", "bb"),
            ("two", "L"),
            ("four", "LL"),
            ("zoom", "z"),
            ("four zoomed", "LLz"),
        ] {
            let mut app = on(select);
            keys(&mut app, k);
            out.push((format!("{select} {name}"), app));
        }
        // The list on the right; no key bar and compact.
        let mut right = on(select);
        right.prefs.settings.list_side = toolroll_tui::viewstate::Side::Right;
        out.push((format!("{select} right"), right));
        let mut bare = on(select);
        bare.prefs.settings.key_bar = false;
        bare.prefs.settings.density = toolroll_tui::settings::Density::Compact;
        out.push((format!("{select} no key bar, compact"), bare));
        // Toasts: said and refused.
        for tone in [Tone::Said, Tone::Refused] {
            let mut app = on(select);
            app.status = Some((tone, "Saved: a toast's words.".into()));
            out.push((format!("{select} toast {tone:?}"), app));
        }
    }
    // Dialogs, opened as a person opens them (the rest are drawn by the suites that open them, which check too).
    for (select, k) in [
        ("t-live", "?"),
        ("t-live", ":"),
        ("t-live", "n"),
        ("t-live", "T"),
        ("t-live", "s"),
        ("t-live", "x"),
        ("t-live", "X"),
        ("t-live", "/"),
        ("t-live", "q"),
        ("t-live", "?s"),
        ("t-live", "A"),
        ("t-ask", "1"),
        ("t-ask", "2"),
        ("t-done", "a"),
        ("t-done", "aa"),
        ("t-done", "r"),
        ("t-rate", "r"),
        ("t-done", "\t\t\tc"),
        ("t-live", "t"),
    ] {
        let mut app = on(select);
        keys(&mut app, k);
        out.push((format!("{select} keys {k:?}"), app));
    }
    out
}

#[test]
fn every_pair_the_screen_draws_is_one_the_contrast_check_reads() {
    let mut found = BTreeSet::new();
    for (name, mut app) in scenes() {
        for (w, h) in SIZES {
            // Drawn first in its own theme, as a person sees it: whatever the screen keeps between frames (laid-out
            // lines) must follow a change of theme, never carry the old one's colours.
            let mut term =
                ratatui::Terminal::new(ratatui::backend::TestBackend::new(w, h)).unwrap();
            term.draw(|f| toolroll_tui::view::draw(f, &mut app))
                .unwrap();
            let drawn = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                pairs::check(&mut app, w, h)
            }));
            match drawn {
                Ok(p) => found.extend(p),
                Err(_) => panic!("scene {name} at {w}x{h} (above)"),
            }
        }
    }
    // The table isn't padding: most of it is drawn by these scenes.
    let table = pairs::checked();
    assert!(
        found.len() * 3 >= table.len() * 2,
        "{} of {}: {found:?}",
        found.len(),
        table.len()
    );
}

/// The built-in themes' own colours, as drawn (true colour, and quantized at 256): the pairs that fall short.
fn short_pairs(t: &Theme) -> Vec<String> {
    let resolve = |r: Role| match t.palette.get(r) {
        Paint::Rgb(c) => Some(c),
        Paint::Terminal => None,
    };
    let mut out = vec![];
    for &(fg, bg, floor) in theme::DRAWN_PAIRS {
        if let (Some(f), Some(b)) = (resolve(fg), resolve(bg)) {
            for (f2, b2, at) in [(f, b, "true"), (f.quantized256(), b.quantized256(), "256")] {
                let c = f2.contrast(b2);
                if c < floor {
                    out.push(format!(
                        "{:?} {fg:?} on {bg:?} {at}: {c:.2} < {floor}",
                        t.name
                    ));
                }
            }
        }
    }
    // Code's accent on the backgrounds code is drawn on.
    if resolve(Role::Paper).is_some() {
        let a = t.code_accent();
        for &(bg, floor) in theme::CODE_ACCENT_ON {
            if let Some(b) = resolve(bg) {
                for (f2, b2, at) in [(a, b, "true"), (a.quantized256(), b.quantized256(), "256")] {
                    let c = f2.contrast(b2);
                    if c < floor {
                        out.push(format!(
                            "{:?} code accent on {bg:?} {at}: {c:.2} < {floor}",
                            t.name
                        ));
                    }
                }
            }
        }
    }
    out
}

#[test]
fn the_built_in_themes_keep_every_floor_as_drawn() {
    let mut all = vec![];
    for name in [ThemeName::Light, ThemeName::Dark, ThemeName::HighContrast] {
        let (t, _) = Theme::build(name, Depth::TrueColor, None, &[]);
        all.extend(short_pairs(&t));
    }
    assert!(all.is_empty(), "{all:#?}");
}
