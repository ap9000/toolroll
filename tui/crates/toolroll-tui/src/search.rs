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

/// Light every occurrence of the query drawn in `area` (reversed: it reads in every theme, colour off included).
pub fn highlight(buf: &mut Buffer, area: Rect, query: &str) {
    let q: Vec<char> = query.to_lowercase().chars().collect();
    if q.is_empty() {
        return;
    }
    for y in area.top()..area.bottom() {
        let cells: Vec<char> = (area.left()..area.right())
            .map(|x| {
                buf[(x, y)]
                    .symbol()
                    .chars()
                    .next()
                    .unwrap_or(' ')
                    .to_lowercase()
                    .next()
                    .unwrap_or(' ')
            })
            .collect();
        let mut i = 0;
        while i + q.len() <= cells.len() {
            if cells[i..i + q.len()] == q[..] {
                for k in 0..q.len() {
                    let x = area.left() + (i + k) as u16;
                    let cell = &mut buf[(x, y)];
                    cell.set_style(cell.style().add_modifier(Modifier::REVERSED));
                }
                i += q.len();
            } else {
                i += 1;
            }
        }
    }
}
