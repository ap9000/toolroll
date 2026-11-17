//! The colour pairs a screen actually draws, read back as roles: drawn again with every role given a colour of its own
//! (and the code accent its own), each cell's text and background named. Every pair found must be one the contrast
//! check reads (theme::DRAWN_PAIRS; code on theme::CODE_ACCENT_ON; a role on itself only in theme::SAME_ROLE_DRAWN),
//! and a colour that is none of them fails: nothing drawn escapes the check. Every test that draws a screen calls it.
#![allow(dead_code)]
use ratatui::backend::TestBackend;
use ratatui::style::{Color, Modifier};
use ratatui::Terminal;
use std::collections::{BTreeSet, HashMap};
use toolroll_tui::app::App;
use toolroll_tui::theme::{self, Depth, Paint, Rgb, Role, Theme, ThemeName};

/// What a colour on screen is: a role, or the code accent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Ink {
    Role(Role),
    Accent,
}

/// A theme whose every role has a colour of its own (none equal to another, nor to the code accent).
pub fn unique() -> (Theme, HashMap<(u8, u8, u8), Ink>) {
    let (mut t, _) = Theme::build(ThemeName::Dark, Depth::TrueColor, None, &[]);
    let mut back = HashMap::new();
    let a = t.code_accent();
    back.insert((a.0, a.1, a.2), Ink::Accent);
    for (i, role) in Role::ALL.iter().enumerate() {
        let c = Rgb(10 + i as u8 * 13, 3 + i as u8 * 7, 250 - i as u8 * 11);
        assert!(!back.contains_key(&(c.0, c.1, c.2)));
        t.palette.set(*role, Paint::Rgb(c));
        back.insert((c.0, c.1, c.2), Ink::Role(*role));
    }
    t.reference = Rgb(10, 3, 250);
    (t, back)
}

/// Everything drawn at w×h: the (text, background) pairs, and the cells whose colours are no role at all.
pub fn found(app: &mut App, w: u16, h: u16) -> (BTreeSet<(Ink, Ink)>, Vec<String>) {
    let (t, back) = unique();
    let saved = app.prefs.theme;
    app.prefs.theme = t;
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| toolroll_tui::view::draw(f, app)).unwrap();
    app.prefs.theme = saved;
    let ink = |c: Color| match c {
        Color::Rgb(r, g, b) => back.get(&(r, g, b)).copied(),
        _ => None,
    };
    // The one exception, explicit: a terminal pane shows the program's own colours (vt100's indexed palette), which
    // are the program's, never the theme's.
    let pane = app.tab == toolroll_tui::app::Tab::Terminal
        || matches!(app.mode, toolroll_tui::app::Mode::TakeOver);
    let programs = |c: Color| pane && !matches!(c, Color::Rgb(..));
    let mut pairs = BTreeSet::new();
    let mut unknown = vec![];
    let buf = term.backend().buffer();
    for (i, cell) in buf.content().iter().enumerate() {
        let (mut fg, mut bg) = (cell.fg, cell.bg);
        if cell.modifier.contains(Modifier::REVERSED) {
            std::mem::swap(&mut fg, &mut bg);
        }
        // A blank cell shows only its background, which must still be a role.
        let blank = cell.symbol().trim().is_empty();
        match (ink(fg), ink(bg)) {
            (Some(f), Some(b)) => {
                if !blank {
                    pairs.insert((f, b));
                }
            }
            (f, b) => {
                let bad_bg = b.is_none() && !programs(bg);
                let bad_fg = !blank && f.is_none() && !programs(fg);
                if bad_bg || bad_fg {
                    let (x, y) = (i as u16 % w, i as u16 / w);
                    unknown.push(format!("({x},{y}) {:?} fg {fg:?} bg {bg:?}", cell.symbol()));
                }
            }
        }
    }
    (pairs, unknown)
}

/// The pairs the contrast check reads, as Inks.
pub fn checked() -> BTreeSet<(Ink, Ink)> {
    let mut out: BTreeSet<(Ink, Ink)> = theme::DRAWN_PAIRS
        .iter()
        .map(|(f, b, _)| (Ink::Role(*f), Ink::Role(*b)))
        .collect();
    out.extend(
        theme::CODE_ACCENT_ON
            .iter()
            .map(|(b, _)| (Ink::Accent, Ink::Role(*b))),
    );
    out.extend(
        theme::SAME_ROLE_DRAWN
            .iter()
            .map(|r| (Ink::Role(*r), Ink::Role(*r))),
    );
    out
}

/// Draw `app` again at w×h with the unique palette and fail on any pair the check doesn't read, or any colour that
/// is no role. Returns the pairs found (for a caller that gathers them).
pub fn check(app: &mut App, w: u16, h: u16) -> BTreeSet<(Ink, Ink)> {
    let (pairs, unknown) = found(app, w, h);
    assert!(
        unknown.is_empty(),
        "colours that are no role ({w}x{h}): {:?}",
        &unknown[..unknown.len().min(8)]
    );
    let table = checked();
    let missing: Vec<_> = pairs.difference(&table).collect();
    assert!(
        missing.is_empty(),
        "drawn at {w}x{h} but not checked (theme::DRAWN_PAIRS): {missing:?}"
    );
    pairs
}
