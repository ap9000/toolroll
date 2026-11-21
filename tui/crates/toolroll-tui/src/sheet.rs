//! The sheets look (DESIGN.md "Signal", B): a ground with paper sheets set into it, raised blocks, soft status badges,
//! keycaps, a solid ink chip for what needs you and one ink verb. Where the terminal can't fill (16 colours, NO_COLOR)
//! the same shapes are drawn with rules, weight and reversal, so nothing disappears: a sheet becomes a rounded outline,
//! a raised block a titled group, a badge its hue (or its words), a keycap bold, and the chip and the verb reversed.
//!
//! Drawing only: every style comes from a theme role (theme.rs), and every word drawn is given by the caller.
use crate::text::width;
use crate::theme::{self, Role};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

/// Fill `r` with blanks in `style` (the sheet's paper, the ground, a raised block).
pub fn paint(buf: &mut Buffer, r: Rect, style: Style) {
    let r = r.intersection(buf.area);
    for y in r.y..r.y + r.height {
        for x in r.x..r.x + r.width {
            let cell = &mut buf[(x, y)];
            cell.reset();
            cell.set_symbol(" ");
            cell.set_style(style);
        }
    }
}

/// A rounded outline around `r` in `style`.
pub fn outline(buf: &mut Buffer, r: Rect, style: Style) {
    let r = r.intersection(buf.area);
    if r.width < 2 || r.height < 2 {
        return;
    }
    let (x0, y0, x1, y1) = (r.x, r.y, r.right() - 1, r.bottom() - 1);
    for x in x0 + 1..x1 {
        buf[(x, y0)].set_symbol("─").set_style(style);
        buf[(x, y1)].set_symbol("─").set_style(style);
    }
    for y in y0 + 1..y1 {
        buf[(x0, y)].set_symbol("│").set_style(style);
        buf[(x1, y)].set_symbol("│").set_style(style);
    }
    buf[(x0, y0)].set_symbol("╭").set_style(style);
    buf[(x1, y0)].set_symbol("╮").set_style(style);
    buf[(x0, y1)].set_symbol("╰").set_style(style);
    buf[(x1, y1)].set_symbol("╯").set_style(style);
}

/// The focused panel's outline, when panels share the screen: heavy lines in ink, bold (it reads in every theme, and
/// without colour by its weight).
pub fn outline_focus(buf: &mut Buffer, r: Rect) {
    let r = r.intersection(buf.area);
    if r.width < 2 || r.height < 2 {
        return;
    }
    let style = theme::ink().add_modifier(ratatui::style::Modifier::BOLD);
    let (x0, y0, x1, y1) = (r.x, r.y, r.right() - 1, r.bottom() - 1);
    for x in x0 + 1..x1 {
        buf[(x, y0)].set_symbol("━").set_style(style);
        buf[(x, y1)].set_symbol("━").set_style(style);
    }
    for y in y0 + 1..y1 {
        buf[(x0, y)].set_symbol("┃").set_style(style);
        buf[(x1, y)].set_symbol("┃").set_style(style);
    }
    buf[(x0, y0)].set_symbol("┏").set_style(style);
    buf[(x1, y0)].set_symbol("┓").set_style(style);
    buf[(x0, y1)].set_symbol("┗").set_style(style);
    buf[(x1, y1)].set_symbol("┛").set_style(style);
}

/// The focused sheet's top accent bar (List vs. Detail): a crisp heavy rule across its top padding row in bold ink,
/// costing zero content rows and reading clearly in every theme and without colour.
pub fn focus_bar(buf: &mut Buffer, r: Rect) {
    let r = r.intersection(buf.area);
    if r.width < 6 || r.height < 2 {
        return;
    }
    let style = theme::ink().add_modifier(Modifier::BOLD);
    let x0 = r.x + 2;
    let x1 = r.right().saturating_sub(2);
    for x in x0..x1 {
        buf[(x, r.y)].set_symbol("━").set_style(style);
    }
}

/// A sheet: paper filled (or, without fills, outlined in the line colour). Returns the area inside it: one row and two
/// columns in from its edge either way, so the layout is the same at every depth.
pub fn sheet(buf: &mut Buffer, r: Rect) -> Rect {
    paint(buf, r, theme::base());
    if theme::ruled() {
        outline(buf, r, theme::line());
    }
    inside(r)
}

/// The area inside a sheet of `r`.
pub fn inside(r: Rect) -> Rect {
    Rect {
        x: r.x + 2.min(r.width / 2),
        y: r.y + 1.min(r.height / 2),
        width: r.width.saturating_sub(4),
        height: r.height.saturating_sub(2),
    }
}

/// `line` widened to `w` cells with `band` behind every cell (a raised block's row, a selected row, a changed line).
pub fn band(line: Line<'static>, w: usize, band: Style) -> Line<'static> {
    let used = line.width();
    // The selected row: every word on it in the selection's own ink (theme.rs DRAWN_PAIRS checks only that pair), so a
    // colour that reads on the sheet can never vanish on the selection. A word on its own background (a badge) keeps it.
    let selection = theme::fills() && band == theme::selected();
    let mut spans: Vec<Span<'static>> = line
        .spans
        .into_iter()
        // A span's own background (a changed word) wins; elsewhere the band's.
        .map(|s| {
            let mut style = s.style;
            if selection && style.bg.is_none() {
                style.fg = band.fg;
            }
            Span::styled(s.content, band.patch(style))
        })
        .collect();
    if used < w {
        spans.push(Span::styled(" ".repeat(w - used), band));
    }
    Line::from(spans)
}

/// A key as a cap: " Enter " on the fill. Without fills, the key in bold with no padding (`"Enter"`).
pub fn keycap(key: &str) -> Span<'static> {
    if theme::fills() {
        Span::styled(format!(" {key} "), theme::keycap())
    } else {
        Span::styled(key.to_string(), theme::ink())
    }
}

/// A key and what it does, for a dialog's foot: " Enter  Send this answer" (the key a cap; for the screen's one verb the
/// cap is solid ink). Without fills it reads exactly as before, "Enter  Send this answer".
pub fn act(key: &str, words: &str, verb: bool) -> Vec<Span<'static>> {
    if theme::fills() {
        let cap = if verb {
            theme::primary()
        } else {
            theme::keycap()
        };
        vec![
            Span::styled(format!(" {key} "), cap),
            Span::raw(format!(" {words}")),
        ]
    } else {
        vec![
            Span::styled(format!("{key}  "), theme::ink()),
            Span::raw(words.to_string()),
        ]
    }
}

/// A button: words and key on a fill, " Accept  a ". The verb is solid ink; without fills the verb is reversed and the
/// others bracketed, "[Send back  r]".
pub fn button(words: &str, key: &str, verb: bool) -> Span<'static> {
    let text = if key.is_empty() {
        format!(" {words} ")
    } else {
        format!(" {words}  {key} ")
    };
    if verb {
        Span::styled(text, theme::primary())
    } else if theme::fills() {
        Span::styled(text, theme::keycap().remove_modifier(Modifier::BOLD))
    } else {
        Span::styled(format!("[{}]", text.trim()), theme::ink())
    }
}

/// A status badge: " ● Building " on its wash (at 16 colours the hue alone; with colour off, the words).
pub fn badge(words: &str, role: Role) -> Span<'static> {
    if theme::fills() {
        Span::styled(format!(" {words} "), theme::badge(role))
    } else {
        Span::styled(words.to_string(), theme::badge(role))
    }
}

/// The solid ink chip on what needs you: " Question ", reversed at every depth.
pub fn chip(words: &str) -> Span<'static> {
    Span::styled(format!(" {words} "), theme::chip())
}

/// A count in a pill: the needs-you count solid, every other count on the fill.
pub fn count(n: usize, needs: bool) -> Span<'static> {
    if needs {
        Span::styled(format!(" {n} "), theme::chip())
    } else if theme::fills() {
        Span::styled(format!(" {n} "), theme::dim().patch(theme::fill()))
    } else {
        Span::styled(format!(" {n}"), theme::dim())
    }
}

/// Behind a dialog: everything already drawn fades (its words muted and unweighted), so the dialog is the one thing lit.
pub fn scrim(buf: &mut Buffer) {
    let fills = theme::fills();
    let muted = theme::dim();
    for cell in buf.content.iter_mut() {
        if fills {
            if let Some(fg) = muted.fg {
                cell.set_fg(fg);
            }
            cell.modifier.remove(Modifier::BOLD);
        } else {
            cell.modifier.insert(Modifier::DIM);
        }
    }
}

/// A line of words in the style, cut to `w` with an ellipsis.
pub fn words(text: &str, w: usize, style: Style) -> Line<'static> {
    Line::from(Span::styled(crate::text::fit(text, w), style))
}

/// The width of spans.
pub fn spans_width(spans: &[Span<'_>]) -> usize {
    spans.iter().map(|s| width(&s.content)).sum()
}
