//! Search within the focused pane (`/`): Live's output, Steps, the Diff's lines, or the Terminal pane's scrollback.
//! A search mode of its own while it is open: what is typed is the query; Enter keeps it, n and N step through the
//! matches, Esc leaves. Matches are lit on screen (whatever the theme: reversed), and the pane moves to the current one.
//!
//! What is searched is the pane's own cleaned text, line by line (the same text open-in-editor writes). An agent's own
//! sign-in or install pane is never searched, nor exported.
use crate::app::{App, Tab};

use crate::review::Row;
use crate::text::clean;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use unicode_width::UnicodeWidthStr;

/// At most this many characters are searched for.
pub const MAX_QUERY: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Search {
    pub query: String,
    /// Still typing the query (Enter ends typing; n and N then move).
    pub typing: bool,
    /// The current match, among `count` (lines matching).
    pub at: usize,
    pub count: usize,
}

/// The focused pane's text, one cleaned line per drawn line where it can be; None: nothing here may be searched or
/// exported (no task, a thread, or an agent's sign-in pane).
pub fn pane_text(app: &mut App) -> Option<(&'static str, Vec<String>)> {
    if app.thread_selected().is_some() || app.selected_item().is_none_or(|i| !i.is_task) {
        return None;
    }
    let line_text = |l: &ratatui::text::Line<'_>| -> String {
        clean(
            &l.spans
                .iter()
                .map(|s| s.content.as_ref())
                .collect::<String>(),
        )
    };
    match app.tab {
        Tab::Live => {
            let lines = match &app.line_cache {
                Some(c) => c.lines.iter().map(line_text).collect(),
                None => crate::transcript::lines(&app.transcript, 200, 0)
                    .iter()
                    .map(line_text)
                    .collect(),
            };
            Some(("live", lines))
        }
        Tab::Steps => {
            let steps = app.steps_here()?;
            let mut out = vec![];
            if let Some(h) = &steps.headline {
                out.push(clean(h));
            }
            for c in steps.cards.iter().flatten() {
                out.push(clean(&c.label));
                out.push(clean(&c.sentence));
            }
            if let Some(f) = &steps.failure {
                out.push(clean(&f.line));
                out.extend(f.agent_said.iter().flatten().map(|l| clean(l)));
            }
            Some(("steps", out))
        }
        Tab::Diff => {
            let code = app.code.as_ref()?;
            let text = |i: usize| {
                code.lines
                    .get(i)
                    .map(|l| clean(&l.text))
                    .unwrap_or_default()
            };
            let lines = app
                .rows
                .iter()
                .map(|r| match r {
                    Row::Hunk(h) => code.headers.get(*h).cloned().unwrap_or_default(),
                    Row::Code(i) => text(*i),
                    Row::Pair(a, b) => {
                        format!(
                            "{}  {}",
                            a.map(text).unwrap_or_default(),
                            b.map(text).unwrap_or_default()
                        )
                    }
                    Row::Gap { .. } | Row::Note(_) => String::new(),
                })
                .collect();
            Some(("diff", lines))
        }
        Tab::Terminal => {
            let pane = app.term.as_mut()?;
            // An agent's sign-in or install: never searched, never exported.
            if pane.sensitive || pane.task.starts_with("agent:") {
                return None;
            }
            Some(("terminal", pane.text_lines()))
        }
    }
}

/// The lines (indexes) holding the query, case aside.
pub fn matching(lines: &[String], query: &str) -> Vec<usize> {
    let q = query.to_lowercase();
    if q.is_empty() {
        return vec![];
    }
    lines
        .iter()
        .enumerate()
        .filter(|(_, l)| l.to_lowercase().contains(&q))
        .map(|(i, _)| i)
        .collect()
}

/// Light every occurrence of the query drawn in `area` (reversed: it reads in every theme, colour off included). Read
/// as `matching` reads a line: each drawn character lower-cased whole (İ is two characters then), and a wide character
/// (日) one character over both its cells, so a line counted as matching is lit where it is drawn.
pub fn highlight(buf: &mut Buffer, area: Rect, query: &str) {
    let q = query.to_lowercase();
    if q.is_empty() {
        return;
    }
    for y in area.top()..area.bottom() {
        // The characters drawn on this row: where each starts, how many cells it covers, and its lower case.
        let mut drawn: Vec<(u16, u16, String)> = vec![];
        let mut x = area.left();
        while x < area.right() {
            let symbol = buf[(x, y)].symbol();
            let width = (UnicodeWidthStr::width(symbol) as u16).clamp(1, area.right() - x);
            drawn.push((x, width, symbol.to_lowercase()));
            x += width;
        }
        let mut i = 0;
        while i < drawn.len() {
            let mut text = String::new();
            let mut j = i;
            while j < drawn.len() && text.len() < q.len() {
                text.push_str(&drawn[j].2);
                j += 1;
            }
            if text.starts_with(&q) {
                for (start, width, _) in &drawn[i..j] {
                    for k in 0..*width {
                        let cell = &mut buf[(start + k, y)];
                        cell.set_style(cell.style().add_modifier(Modifier::REVERSED));
                    }
                }
                i = j;
            } else {
                i += 1;
            }
        }
    }
}
