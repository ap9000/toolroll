//! One state struct, drawn immediate-mode each frame (the Codex/herdr pattern).
use crate::ring::Ring;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Paragraph};
use ratatui::Frame;
use tui_term::widget::PseudoTerminal;

pub const RING_LINES: usize = 100_000;
/// Worst-case line content (bench/run `--noisy`).
pub static NOISY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

const WORDS: [&str; 8] = [
    "Edited src/auth/redirect.ts (+14 −3)",
    "Ran npm test → 212 passed (3.1 s)",
    "Read src/server/live.ts",
    "Searched \"mutation key\" in src/",
    "Redirect now preserves ?next; adding a test…",
    "Plan: keep the legacy alias, log a deprecation line",
    "Lookup ratatui::Terminal::draw",
    "Delegated: check the CSV export edge cases",
];

pub struct LogPane {
    pub title: &'static str,
    pub ring: Ring,
    pub total: u64,
    pub color: Color,
}

impl LogPane {
    fn new(title: &'static str, color: Color) -> Self {
        Self {
            title,
            ring: Ring::new(RING_LINES),
            total: 0,
            color,
        }
    }
    pub fn feed(&mut self, n: usize) {
        let noisy = NOISY.load(std::sync::atomic::Ordering::Relaxed);
        for _ in 0..n {
            let i = self.total;
            let w = WORDS[(i as usize * 7 + i as usize / 3) % WORDS.len()];
            if noisy {
                // Worst case: a different offset and padding per line, so nearly every cell changes every frame.
                let k = (i as usize * 13) % 17;
                self.ring.push(format!(
                    "{i:08} {:>pad$}{} {}",
                    "",
                    w,
                    i.wrapping_mul(2654435761) % 1_000_000_007,
                    pad = k
                ));
            } else {
                self.ring.push(format!("{i:08} {w}"));
            }
            self.total += 1;
        }
    }
}

pub struct App {
    pub panes: [LogPane; 3],
    pub vt: vt100::Parser,
    pub vt_title: String,
    pub steer: String,
    pub status: String,
    pub sent: Vec<String>,
    /// The terminal pane's inner size as last drawn (rows, cols): a live `/term` is resized to it.
    pub term_inner: std::cell::Cell<(u16, u16)>,
    pub term_focus: bool,
}

impl App {
    pub fn new(vt_rows: u16, vt_cols: u16, vt_title: String) -> Self {
        Self {
            panes: [
                LogPane::new("run 3412 · claude", Color::Cyan),
                LogPane::new("run 3413 · codex", Color::Green),
                LogPane::new("run 3414 · gemini", Color::Magenta),
            ],
            vt: vt100::Parser::new(vt_rows, vt_cols, 0),
            vt_title,
            steer: String::new(),
            status: String::new(),
            sent: Vec::new(),
            term_inner: std::cell::Cell::new((vt_rows, vt_cols)),
            term_focus: false,
        }
    }
    pub fn feed_all(&mut self, n: usize) {
        for p in &mut self.panes {
            p.feed(n);
        }
    }
}

/// The steer line's marker: the PTY harness finds the echo row by it.
pub const STEER_MARK: &str = "steer› ";

pub fn draw(f: &mut Frame, app: &App) {
    let area = f.area();
    let outer = Block::bordered().title(format!(" Toolroll spike {}x{} ", area.width, area.height));
    let inner = outer.inner(area);
    f.render_widget(outer, area);
    let [main, status, steer, keys] = Layout::vertical([
        Constraint::Min(4),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .areas(inner);
    let [top, bottom] =
        Layout::vertical([Constraint::Percentage(50), Constraint::Percentage(50)]).areas(main);
    let [a, b] =
        Layout::horizontal([Constraint::Percentage(50), Constraint::Percentage(50)]).areas(top);
    let [c, d] =
        Layout::horizontal([Constraint::Percentage(50), Constraint::Percentage(50)]).areas(bottom);
    for (pane, rect) in app.panes.iter().zip([a, b, c]) {
        draw_log(f, pane, rect);
    }
    let title = if app.term_focus {
        format!(" {} · typing goes here (Tab back) ", app.vt_title)
    } else {
        format!(" {} ", app.vt_title)
    };
    let term_block = Block::bordered().title(title);
    let ti = term_block.inner(d);
    app.term_inner.set((ti.height, ti.width));
    let term = PseudoTerminal::new(app.vt.screen()).block(term_block);
    f.render_widget(term, d);
    f.render_widget(
        Paragraph::new(Line::from(Span::styled(
            app.status.as_str(),
            Style::new().fg(Color::DarkGray),
        ))),
        status,
    );
    f.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(STEER_MARK, Style::new().add_modifier(Modifier::BOLD)),
            Span::raw(app.steer.as_str()),
            Span::styled("▏", Style::new().add_modifier(Modifier::SLOW_BLINK)),
        ])),
        steer,
    );
    f.render_widget(
        Paragraph::new(" type to steer  ⏎ send  Esc clear  Tab terminal  Ctrl-C quit")
            .style(Style::new().add_modifier(Modifier::REVERSED)),
        keys,
    );
}

fn draw_log(f: &mut Frame, pane: &LogPane, rect: Rect) {
    let block = Block::bordered().title(format!(" {} · {} lines ", pane.title, pane.total));
    let inner = block.inner(rect);
    let lines: Vec<Line> = pane
        .ring
        .tail(inner.height as usize)
        .map(|l| {
            let (seq, rest) = l.split_at(8.min(l.len()));
            Line::from(vec![
                Span::styled(seq, Style::new().fg(pane.color)),
                Span::raw(rest),
            ])
        })
        .collect();
    f.render_widget(block, rect);
    f.render_widget(Paragraph::new(lines), inner);
}
