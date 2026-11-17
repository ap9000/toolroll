//! The colour pairs the screen actually draws, found by drawing it: every role given a colour of its own, the main
//! screens drawn, and each cell's text and background read back as roles. Every pair found must be in
//! theme::DRAWN_PAIRS, the one table the contrast check reads (Theme::problem), so a screen can't start drawing a pair
//! the check doesn't know.
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::style::{Color, Modifier};
use ratatui::Terminal;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, Effect, Msg, Tab};
use toolroll_tui::theme::{self, Depth, Paint, Rgb, Role, Theme, ThemeName};

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

/// A theme whose every role has a colour no other role has (and no colour any role shares), and how to read them back.
fn unique() -> (Theme, HashMap<(u8, u8, u8), Role>) {
    let (mut t, _) = Theme::build(ThemeName::Dark, Depth::TrueColor, None, &[]);
    let mut back = HashMap::new();
    for (i, role) in Role::ALL.iter().enumerate() {
        let c = Rgb(10 + i as u8 * 13, 3 + i as u8 * 7, 250 - i as u8 * 11);
        t.palette.set(*role, Paint::Rgb(c));
        back.insert((c.0, c.1, c.2), *role);
    }
    t.reference = Rgb(10, 3, 250);
    (t, back)
}

/// The roles drawn: (text, background) for every cell with a glyph, reversal undone, in role terms where both are
/// roles (a cell's own default background is the paper the sheets were filled with).
fn pairs(
    app: &mut App,
    back: &HashMap<(u8, u8, u8), Role>,
    w: u16,
    h: u16,
    into: &mut BTreeSet<(Role, Role)>,
) {
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| toolroll_tui::view::draw(f, app)).unwrap();
    let role = |c: Color| match c {
        Color::Rgb(r, g, b) => back.get(&(r, g, b)).copied(),
        Color::Reset => Some(Role::Paper),
        _ => None,
    };
    for cell in term.backend().buffer().content() {
        if cell.symbol().trim().is_empty() {
            continue;
        }
        let (mut fg, mut bg) = (cell.fg, cell.bg);
        if cell.modifier.contains(Modifier::REVERSED) {
            std::mem::swap(&mut fg, &mut bg);
        }
        if let (Some(f), Some(b)) = (role(fg), role(bg)) {
            if f != b {
                into.insert((f, b));
            }
        }
    }
}

fn scenes() -> Vec<(&'static str, App)> {
    let mut out = vec![];
    for select in ["t-ask", "t-done", "t-live", "t-rate", "t-old"] {
        let mut app = App::new(false, Some("/home/me/shop".into()));
        app.now = NOW;
        let fx = app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
        answer(&mut app, fx);
        let at = app.items.iter().position(|i| i.id == select).unwrap();
        while app.selected < at {
            let fx = app.key(key('j'));
            answer(&mut app, fx);
        }
        for tab in [Tab::Live, Tab::Steps, Tab::Diff, Tab::Terminal] {
            let mut a = App::new(false, Some("/home/me/shop".into()));
            a.now = NOW;
            let fx = a.update(Msg::Work(Ok(parse(fake::scenario_work()))));
            answer(&mut a, fx);
            while a.selected < at {
                let fx = a.key(key('j'));
                answer(&mut a, fx);
            }
            // Tab moves through Live → Steps → Diff → Terminal.
            while a.tab != tab {
                let fx = a.key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
                answer(&mut a, fx);
            }
            out.push((select, a));
        }
        out.push((select, app));
    }
    // Dialogs and screens over them.
    for keys in ["?", ":", "n", "X", "x", "?s", "1", "b", "LL"] {
        let mut app = App::new(false, Some("/home/me/shop".into()));
        app.now = NOW;
        let fx = app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
        answer(&mut app, fx);
        for c in keys.chars() {
            let fx = app.key(key(c));
            answer(&mut app, fx);
        }
        out.push(("dialog", app));
    }
    out
}

#[test]
fn every_pair_the_screen_draws_is_one_the_contrast_check_reads() {
    let (t, back) = unique();
    let mut found = BTreeSet::new();
    for (_, mut app) in scenes() {
        app.prefs.theme = t;
        for (w, h) in [(160, 40), (100, 30)] {
            pairs(&mut app, &back, w, h, &mut found);
        }
    }
    let table: BTreeSet<(Role, Role)> = theme::DRAWN_PAIRS
        .iter()
        .map(|(f, b, _)| (*f, *b))
        .collect();
    let missing: Vec<_> = found.difference(&table).collect();
    assert!(
        missing.is_empty(),
        "drawn but not checked (add them to theme::DRAWN_PAIRS): {missing:?}\nall drawn: {found:?}"
    );
    // The table isn't padding: most of it is drawn by these screens.
    assert!(found.len() * 2 >= table.len(), "{found:?}");
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
