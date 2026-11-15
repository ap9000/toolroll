//! Drawing the screen from the App, immediate-mode, every frame (layout from the live size each time).
//!
//! DESIGN.md: plain words in sentence case; ink (the terminal's own foreground, bold) for what needs you, never amber;
//! blue only for running, green only for passed, red only for failed.
use crate::app::{App, Item, Mode, NoteKind, Section, Tab, Tone};
use crate::text::{clean, fit, width, wrap};
use crate::transcript;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use ratatui::Frame;
use toolroll_api::{StepCard, StepCards};

fn ink() -> Style {
    Style::default().add_modifier(Modifier::BOLD)
}
fn dim() -> Style {
    Style::default().add_modifier(Modifier::DIM)
}
fn running() -> Style {
    Style::default().fg(Color::Blue)
}
fn passed() -> Style {
    Style::default().fg(Color::Green)
}
fn failed() -> Style {
    Style::default().fg(Color::Red)
}

/// "2026-11-14T12:00:00.000Z" → seconds since the epoch (UTC only; anything else is None).
pub fn epoch(iso: &str) -> Option<i64> {
    let b = iso.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || !iso.ends_with('Z') {
        return None;
    }
    let n = |r: std::ops::Range<usize>| iso.get(r).and_then(|s| s.parse::<i64>().ok());
    let (y, m, d, hh, mm, ss) = (
        n(0..4)?,
        n(5..7)?,
        n(8..10)?,
        n(11..13)?,
        n(14..16)?,
        n(17..19)?,
    );
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) * 86_400 + hh * 3600 + mm * 60 + ss)
}

pub fn duration(secs: i64) -> String {
    let secs = secs.max(0);
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m {:02}s", secs / 60, secs % 60)
    } else {
        format!("{}h {:02}m", secs / 3600, (secs % 3600) / 60)
    }
}

fn mark_of(card: &StepCard) -> (&'static str, Style) {
    match card.mark.as_str() {
        "done" => ("✓", passed()),
        "live" => ("◐", running()),
        "needs" => ("●", ink()),
        "stuck" => ("✕", failed()),
        "skipped" => ("–", dim()),
        _ => ("○", dim()),
    }
}

fn chain_cards(steps: &StepCards) -> Vec<&StepCard> {
    steps
        .cards
        .iter()
        .flatten()
        .filter(|c| c.in_chain)
        .collect()
}

/// "Plan ✓ · Build ◐ 4m 12s · Checks · Ready": the chain's steps (a "Just code" chain has no Plan or Approval).
fn step_line(app: &App, steps: &StepCards, w: usize) -> Line<'static> {
    let full = step_line_with(app, steps, true);
    if full.width() <= w {
        return full;
    }
    fit_line(step_line_with(app, steps, false), w)
}

fn step_line_with(app: &App, steps: &StepCards, times: bool) -> Line<'static> {
    let mut spans = vec![Span::styled("Steps  ", dim())];
    for (i, card) in chain_cards(steps).into_iter().enumerate() {
        if i > 0 {
            spans.push(Span::styled(" · ", dim()));
        }
        let (mark, style) = mark_of(card);
        let label = clean(&card.label);
        if card.mark == "todo" || card.mark == "wait" {
            spans.push(Span::styled(label, dim()));
            continue;
        }
        spans.push(Span::raw(format!("{label} ")));
        spans.push(Span::styled(mark.to_string(), style));
        if card.mark == "live" && times {
            if let Some(start) = card.started_at.as_deref().and_then(epoch) {
                spans.push(Span::styled(
                    format!(" {}", duration(app.now - start)),
                    dim(),
                ));
            }
        }
    }
    Line::from(spans)
}

/// "claude sonnet · Building now · 4m 12s · $0.31 · build #7".
fn facts_line(app: &App, steps: &StepCards) -> Option<Line<'static>> {
    let card = steps
        .cards
        .iter()
        .flatten()
        .find(|c| c.key == "build" && (c.state == "current" || !c.runs.is_empty()))?;
    let mut parts = vec![];
    if let Some(agent) = &card.agent {
        parts.push(
            clean(&format!(
                "{} {}",
                agent.provider,
                agent.model.as_deref().unwrap_or("")
            ))
            .trim()
            .to_string(),
        );
    }
    if !card.sentence.is_empty() {
        parts.push(clean(&card.sentence));
    }
    if let Some(start) = card.started_at.as_deref().and_then(epoch) {
        let end = card
            .finished_at
            .as_deref()
            .and_then(epoch)
            .unwrap_or(app.now);
        parts.push(duration(end - start));
    }
    if let Some(cost) = card.cost_usd {
        parts.push(format!("${cost:.2}"));
    }
    if let Some(run) = card.runs.first() {
        parts.push(format!("build #{run}"));
    }
    Some(Line::from(Span::styled(parts.join(" · "), dim())))
}

/// A line cut to `w` cells with an ellipsis (ratatui would cut it silently).
fn fit_line(line: Line<'static>, w: usize) -> Line<'static> {
    if line.width() <= w {
        return line;
    }
    let mut out = vec![];
    let mut used = 0;
    for span in line.spans {
        let sw = width(&span.content);
        if used + sw < w {
            used += sw;
            out.push(span);
        } else {
            out.push(Span::styled(fit(&span.content, w - used), span.style));
            break;
        }
    }
    Line::from(out)
}

pub fn draw(f: &mut Frame, app: &mut App) {
    let area = f.area();
    let title_right = if !app.loaded {
        "Reading…".to_string()
    } else if app.needs_count == 0 {
        "Nothing needs you".to_string()
    } else if app.needs_count == 1 {
        "1 needs you".to_string()
    } else {
        format!("{} need you", app.needs_count)
    };
    let name = if app.project_name.is_empty() {
        String::new()
    } else {
        format!(" · {}", app.project_name)
    };
    let outer = Block::default()
        .borders(Borders::ALL)
        .title(Line::from(vec![
            Span::styled(" Toolroll", ink()),
            Span::raw(format!(
                "{} ",
                fit(&name, (area.width as usize).saturating_sub(24))
            )),
        ]))
        .title(
            Line::from(Span::styled(
                format!(" {title_right} "),
                if app.needs_count > 0 { ink() } else { dim() },
            ))
            .right_aligned(),
        );
    let inner = outer.inner(area);
    f.render_widget(outer, area);
    if inner.height < 4 || inner.width < 30 {
        f.render_widget(Paragraph::new("Make the window larger."), inner);
        return;
    }
    let [body, status, keys] = Layout::vertical([
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .areas(inner);
    let split = app
        .split
        .min(inner.width * 45 / 100)
        .max(20)
        .min(inner.width.saturating_sub(24));
    let [left, sep, right] = Layout::horizontal([
        Constraint::Length(split),
        Constraint::Length(1),
        Constraint::Min(1),
    ])
    .areas(body);
    app.areas.split_x = sep.x;
    draw_list(f, app, left);
    f.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled("│", dim()));
            sep.height as usize
        ]),
        sep,
    );
    draw_right(f, app, right);
    draw_status(f, app, status);
    draw_keys(f, keys);
    draw_overlay(f, app, area);
}

fn draw_list(f: &mut Frame, app: &mut App, area: Rect) {
    app.areas.list = area;
    app.areas.rows.clear();
    let mut lines: Vec<(Line<'static>, Option<usize>)> = vec![];
    if app.loaded && app.items.is_empty() {
        lines.push((Line::from(Span::styled("Nothing yet.", dim())), None));
    }
    let mut last: Option<Section> = None;
    let w = area.width as usize;
    for (index, item) in app.items.iter().enumerate() {
        if last != Some(item.section) {
            if last.is_some() {
                lines.push((Line::raw(""), None));
            }
            let count = app
                .items
                .iter()
                .filter(|i| i.section == item.section)
                .count();
            lines.push((
                Line::from(vec![
                    Span::styled(item.section.label().to_string(), ink()),
                    Span::styled(format!(" {count}"), dim()),
                ]),
                None,
            ));
            last = Some(item.section);
        }
        lines.push((item_line(item, index == app.selected, w), Some(index)));
    }
    // Keep the selected row in view.
    let h = area.height as usize;
    let at = lines
        .iter()
        .position(|(_, i)| *i == Some(app.selected))
        .unwrap_or(0);
    let top = (at + 1).saturating_sub(h);
    let shown: Vec<Line<'static>> = lines
        .iter()
        .skip(top)
        .take(h)
        .map(|(l, _)| l.clone())
        .collect();
    for (row, (_, index)) in lines.iter().skip(top).take(h).enumerate() {
        app.areas.rows.push((area.y + row as u16, *index));
    }
    f.render_widget(Paragraph::new(shown), area);
}

fn item_line(item: &Item, selected: bool, w: usize) -> Line<'static> {
    let (mark, style) = match item.section {
        Section::NeedsYou => ("●", ink()),
        Section::Working if item.paused => ("‖", dim()),
        Section::Working => ("◐", running()),
        Section::DoneToday => ("✓", passed()),
    };
    let word = fit(&item.word, 12);
    let room = w.saturating_sub(width(&word) + 4);
    let title = fit(&item.title, room);
    let pad = w.saturating_sub(2 + width(&title) + width(&word) + 1);
    let base = if selected {
        Style::default().add_modifier(Modifier::REVERSED)
    } else {
        Style::default()
    };
    let title_style = if item.section == Section::NeedsYou {
        base.add_modifier(Modifier::BOLD)
    } else {
        base
    };
    Line::from(vec![
        Span::styled(format!("{mark} "), if selected { base } else { style }),
        Span::styled(title, title_style),
        Span::styled(" ".repeat(pad + 1), base),
        Span::styled(word, if selected { base } else { dim() }),
    ])
}

fn draw_right(f: &mut Frame, app: &mut App, area: Rect) {
    app.areas.right = area;
    app.areas.tabs.clear();
    let item = app.selected_item().cloned();
    // The bottom: a question waiting, the step line, and an open text box.
    let question = item.as_ref().and_then(|i| i.question()).cloned();
    let q_lines = question
        .as_ref()
        .map(|q| 2 + q.options.len().min(9) as u16)
        .unwrap_or(0);
    let input = matches!(app.mode, Mode::Steer(_) | Mode::Note(..) | Mode::NewTask(_));
    let [tabs, head, content, qa, steps_row, input_row] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(2),
        Constraint::Min(1),
        Constraint::Length(q_lines),
        Constraint::Length(1),
        Constraint::Length(if input { 1 } else { 0 }),
    ])
    .areas(area);
    // Tabs.
    let mut spans = vec![];
    let mut x = tabs.x;
    for (i, tab) in Tab::ALL.iter().enumerate() {
        if i > 0 {
            spans.push(Span::styled(" · ", dim()));
            x += 3;
        }
        let label = tab.label();
        let style = if *tab == app.tab {
            ink().add_modifier(Modifier::UNDERLINED)
        } else {
            dim()
        };
        app.areas.tabs.push((x, x + label.len() as u16, *tab));
        x += label.len() as u16;
        spans.push(Span::styled(label.to_string(), style));
    }
    f.render_widget(Paragraph::new(Line::from(spans)), tabs);
    let Some(item) = item else {
        let words = if app.loaded {
            "No tasks yet. Press n and describe a change you want made."
        } else {
            "Reading your tasks…"
        };
        f.render_widget(
            Paragraph::new(
                wrap(words, content.width as usize)
                    .into_iter()
                    .map(Line::raw)
                    .collect::<Vec<_>>(),
            ),
            content,
        );
        return;
    };
    // Head: the task, then what's running it.
    let mut head_lines = vec![Line::from(Span::styled(
        fit(&item.title, head.width as usize),
        ink(),
    ))];
    match app.steps.as_ref().and_then(|s| facts_line(app, s)) {
        Some(l) => head_lines.push(fit_line(l, head.width as usize)),
        None => head_lines.push(Line::from(Span::styled(
            fit(&item.detail, head.width as usize),
            dim(),
        ))),
    }
    f.render_widget(Paragraph::new(head_lines), head);
    match app.tab {
        Tab::Live => draw_live(f, app, &item, content),
        Tab::Steps => draw_steps(f, app, content),
        Tab::Diff => draw_diff(f, app, content),
        Tab::Terminal => {
            let lines = vec![
                Line::raw(""),
                Line::from(Span::styled("Take over arrives in week 6.", ink())),
                Line::from(Span::styled(
                    "Press w to open this task in the browser.",
                    dim(),
                )),
            ];
            f.render_widget(Paragraph::new(lines).centered(), content);
        }
    }
    if let Some(q) = question {
        let mut lines = vec![Line::from(vec![
            Span::styled("Question: ", ink()),
            Span::styled(fit(&clean(&q.text), qa.width as usize - 10), ink()),
        ])];
        for (i, o) in q.options.iter().take(9).enumerate() {
            let chosen = matches!(&app.mode, Mode::ConfirmAnswer(pin) if pin.index == i);
            let tag = if o.recommended { " (suggested)" } else { "" };
            let text = format!(
                "{} {}{} — {}",
                i + 1,
                clean(&o.label),
                tag,
                clean(&o.consequence)
            );
            lines.push(Line::from(Span::styled(
                format!("  {}", fit(&text, qa.width as usize - 2)),
                if chosen {
                    ink().add_modifier(Modifier::REVERSED)
                } else {
                    Style::default()
                },
            )));
        }
        lines.push(Line::raw(""));
        f.render_widget(Paragraph::new(lines), qa);
    }
    if let Some(steps) = &app.steps {
        f.render_widget(
            Paragraph::new(step_line(app, steps, steps_row.width as usize)),
            steps_row,
        );
    }
    if input {
        let (label, text) = match &app.mode {
            Mode::Steer(t) => ("Steer: ", t),
            Mode::Note(NoteKind::SendBack(_), t) => ("Send back, saying what to change: ", t),
            Mode::NewTask(t) => ("New task: ", t),
            _ => unreachable!(),
        };
        // The end of what's typed stays in view.
        let room = (input_row.width as usize).saturating_sub(width(label) + 1);
        let shown: String = {
            let chars: Vec<char> = text.chars().collect();
            let mut w = 0;
            let mut start = chars.len();
            while start > 0 && w + crate::text::width(&chars[start - 1].to_string()) <= room {
                start -= 1;
                w += crate::text::width(&chars[start].to_string());
            }
            chars[start..].iter().collect()
        };
        f.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(label, ink()),
                Span::raw(shown),
                Span::styled("▏", ink()),
            ])),
            input_row,
        );
    }
}

fn draw_live(f: &mut Frame, app: &mut App, item: &Item, area: Rect) {
    let w = area.width as usize;
    let t = &app.transcript;
    if t.run.is_none() || (t.main.is_empty() && t.sub.is_empty()) {
        let review = item.need.as_ref().and_then(|n| n.ask.as_deref()) == Some("review");
        let words = if review && app.steps.as_ref().is_some_and(|s| s.review.is_some()) {
            "Ready for you to check. Press Enter for the changes, a to accept, or r to send it back.".to_string()
        } else if review && app.steps.is_some() {
            format!(
                "{} Press Enter for the changes, or w to open it in the browser.",
                item.detail
            )
        } else if let Some(missing) = &t.missing {
            missing.clone()
        } else if t.run.is_some() {
            "No output yet.".to_string()
        } else if app.steps.is_none() && item.is_task {
            "Reading…".to_string()
        } else if !item.is_task {
            format!("{} Press w to open it in the browser.", item.detail)
        } else {
            "Nothing is building on this task.".to_string()
        };
        f.render_widget(
            Paragraph::new(
                wrap(&words, w)
                    .into_iter()
                    .map(Line::raw)
                    .collect::<Vec<_>>(),
            ),
            area,
        );
        return;
    }
    // Following the newest: only the tail that fills the pane is laid out (cheap at any length). Scrolled back: the
    // whole transcript, laid out again at most twice a second while records keep arriving.
    let h = area.height as usize;
    let from = if app.follow {
        t.main.len().saturating_sub((h * 3).max(300))
    } else {
        0
    };
    let stale = match &app.line_cache {
        Some(c) => {
            c.width != w
                || c.from != from
                || (c.version != t.version
                    && (app.follow || c.built.elapsed() > std::time::Duration::from_millis(500)))
        }
        None => true,
    };
    if stale {
        app.line_cache = Some(crate::app::LineCache {
            version: t.version,
            width: w,
            from,
            built: std::time::Instant::now(),
            lines: transcript::lines(t, w, from),
        });
    }
    let lines = &app.line_cache.as_ref().unwrap().lines;
    let max_scroll = lines.len().saturating_sub(h);
    if app.scroll > max_scroll {
        app.scroll = max_scroll;
    }
    let end = lines.len() - if app.follow { 0 } else { app.scroll };
    let start = end.saturating_sub(h);
    let mut shown: Vec<Line<'static>> = lines[start..end].to_vec();
    if !app.follow && app.scroll > 0 && h > 1 {
        shown.pop();
        shown.push(Line::from(Span::styled(
            format!("↓ {} newer lines · End follows", app.scroll),
            dim(),
        )));
    }
    f.render_widget(Paragraph::new(shown), area);
}

fn draw_steps(f: &mut Frame, app: &App, area: Rect) {
    let Some(steps) = &app.steps else {
        f.render_widget(Paragraph::new("Reading…"), area);
        return;
    };
    let mut lines = vec![];
    if let Some(headline) = &steps.headline {
        lines.push(Line::from(Span::styled(clean(headline), ink())));
        lines.push(Line::raw(""));
    }
    let cards = chain_cards(steps);
    if cards.is_empty() {
        lines.push(Line::from(Span::styled(
            "This task has no steps (it was cancelled, or hasn't started).",
            dim(),
        )));
    }
    for card in cards {
        let (mark, style) = mark_of(card);
        let mut spans = vec![
            Span::styled(format!("{mark} "), style),
            Span::styled(
                clean(&card.label),
                if card.needs_you {
                    ink()
                } else {
                    Style::default()
                },
            ),
        ];
        if !card.sentence.is_empty() {
            spans.push(Span::raw(format!("  {}", clean(&card.sentence))));
        }
        lines.push(Line::from(spans));
        let mut facts = vec![];
        if let Some(agent) = &card.agent {
            facts.push(
                clean(&format!(
                    "{} {}",
                    agent.provider,
                    agent.model.as_deref().unwrap_or("")
                ))
                .trim()
                .to_string(),
            );
        }
        if let (Some(s), Some(e)) = (
            card.started_at.as_deref().and_then(epoch),
            card.finished_at
                .as_deref()
                .and_then(epoch)
                .or(Some(app.now)),
        ) {
            facts.push(duration(e - s));
        }
        if let Some(cost) = card.cost_usd {
            facts.push(format!("${cost:.2}"));
        }
        if !facts.is_empty() {
            lines.push(Line::from(Span::styled(
                format!("  {}", facts.join(" · ")),
                dim(),
            )));
        }
    }
    if steps.chain == "just-code" {
        lines.push(Line::raw(""));
        lines.push(Line::from(Span::styled(
            "Just code: no plan or approval step.",
            dim(),
        )));
    }
    f.render_widget(Paragraph::new(lines), area);
}

fn draw_diff(f: &mut Frame, app: &App, area: Rect) {
    let Some(diff) = &app.diff else {
        f.render_widget(Paragraph::new("Reading the changes…"), area);
        return;
    };
    let w = area.width as usize;
    if let Some(problem) = &diff.problem {
        f.render_widget(
            Paragraph::new(
                wrap(&clean(problem), w)
                    .into_iter()
                    .map(Line::raw)
                    .collect::<Vec<_>>(),
            ),
            area,
        );
        return;
    }
    let mut lines = vec![];
    if let Some(t) = &diff.totals {
        lines.push(Line::from(vec![
            Span::raw(format!("{} files  ", t.files)),
            Span::styled(format!("+{}", t.additions), passed()),
            Span::raw(" "),
            Span::styled(format!("−{}", t.deletions), failed()),
            Span::styled("   [ ] another file", dim()),
        ]));
    }
    for (i, file) in diff.files.iter().enumerate() {
        let here = i == app.diff_index;
        let style = if here {
            ink().add_modifier(Modifier::REVERSED)
        } else {
            Style::default()
        };
        let name = fit(&clean(&file.path), w.saturating_sub(16));
        lines.push(Line::from(vec![
            Span::styled(format!("{} {name}", if here { "›" } else { " " }), style),
            Span::raw("  "),
            Span::styled(format!("+{}", file.additions), passed()),
            Span::raw(" "),
            Span::styled(format!("−{}", file.deletions), failed()),
            Span::styled(if file.binary { "  binary" } else { "" }, dim()),
        ]));
    }
    lines.push(Line::raw(""));
    match &app.diff_file {
        None => lines.push(Line::from(Span::styled("Reading the file…", dim()))),
        Some(file) => {
            for hunk in &file.file.hunks {
                lines.push(Line::from(Span::styled(
                    fit(&clean(&hunk.header), w),
                    dim(),
                )));
                for line in &hunk.lines {
                    let (sign, style) = match line.kind.as_str() {
                        "addition" => ("+", passed()),
                        "deletion" => ("−", failed()),
                        "meta" => (" ", dim()),
                        _ => (" ", Style::default()),
                    };
                    let num = line
                        .new_line
                        .or(line.old_line)
                        .map(|n| format!("{n:>5} "))
                        .unwrap_or_else(|| "      ".into());
                    lines.push(Line::from(vec![
                        Span::styled(num, dim()),
                        Span::styled(
                            fit(
                                &format!("{sign} {}", clean(&line.text)),
                                w.saturating_sub(6),
                            ),
                            style,
                        ),
                    ]));
                }
            }
            if file.lines_truncated {
                lines.push(Line::from(Span::styled(
                    "The rest of this file is in the browser (w).",
                    dim(),
                )));
            }
        }
    }
    let skip = app.diff_scroll.min(lines.len().saturating_sub(1));
    f.render_widget(
        Paragraph::new(lines.into_iter().skip(skip).collect::<Vec<_>>()),
        area,
    );
}

fn draw_status(f: &mut Frame, app: &App, area: Rect) {
    let line = match &app.status {
        Some((Tone::Refused, words)) => Line::from(vec![
            Span::styled("Refused: ", ink()),
            Span::raw(fit(words, (area.width as usize).saturating_sub(9))),
        ]),
        Some((Tone::Said, words)) => Line::from(Span::raw(fit(words, area.width as usize))),
        None => Line::raw(""),
    };
    f.render_widget(Paragraph::new(line), area);
}

const KEYS: &[(&str, &str)] = &[
    ("j/k", "move"),
    ("⏎", "open"),
    ("s", "steer"),
    ("p", "pause"),
    ("x", "stop"),
    ("1-9", "answer"),
    ("a", "accept"),
    ("r", "send back"),
    ("n", "new"),
    ("w", "browser"),
    ("?", "help"),
    ("q", "quit"),
];

fn draw_keys(f: &mut Frame, area: Rect) {
    // Everything that fits, always ending with help and quit.
    let render = |set: &[(&str, &str)]| -> (Vec<Span<'static>>, usize) {
        let mut spans = vec![];
        let mut w = 0;
        for (i, (k, what)) in set.iter().enumerate() {
            if i > 0 {
                spans.push(Span::raw("  "));
                w += 2;
            }
            spans.push(Span::styled(k.to_string(), ink()));
            spans.push(Span::styled(format!(" {what}"), dim()));
            w += width(k) + 1 + width(what);
        }
        (spans, w)
    };
    let mut keep = KEYS.len();
    loop {
        let mut set: Vec<(&str, &str)> = KEYS[..keep.min(KEYS.len() - 2)].to_vec();
        set.extend_from_slice(&KEYS[KEYS.len() - 2..]);
        let (spans, w) = render(&set);
        if w <= area.width as usize || keep == 0 {
            f.render_widget(Paragraph::new(Line::from(spans)), area);
            return;
        }
        keep -= 1;
    }
}

fn centered(area: Rect, w: u16, h: u16) -> Rect {
    let w = w.min(area.width.saturating_sub(4));
    let h = h.min(area.height.saturating_sub(2));
    Rect {
        x: area.x + (area.width - w) / 2,
        y: area.y + (area.height - h) / 2,
        width: w,
        height: h,
    }
}

fn draw_overlay(f: &mut Frame, app: &mut App, area: Rect) {
    let (title, lines): (&str, Vec<Line<'static>>) = match &app.mode {
        Mode::Help => (
            " Keys ",
            vec![
                "j / k        move up and down the list",
                "Enter        open: the changes for a result, else the live output",
                "Tab          next tab (Live, Steps, Diff, Terminal)",
                "s            steer: send the running agent a note",
                "p            pause the build (again to resume)",
                "x            stop the build",
                "1-9          answer the agent's question",
                "a            accept the result",
                "r            send the result back, with a note",
                "[ ]          another file, in Diff",
                "PgUp PgDn    scroll; End follows the newest",
                "n            new task",
                "w            open Toolroll in your browser",
                "q            quit",
                "",
                "Mouse: click to select, wheel to scroll, drag the divider.",
                "Press any key to close.",
            ]
            .into_iter()
            .map(Line::raw)
            .collect(),
        ),
        Mode::Quit => (
            " Quit Toolroll? ",
            vec![
                Line::raw(""),
                Line::from(vec![
                    Span::styled("s  ", ink()),
                    Span::raw("Stop agents and quit (running work is saved)"),
                ]),
                Line::from(vec![
                    Span::styled("b  ", ink()),
                    Span::raw("Keep running, and start when you log in"),
                ]),
                Line::from(vec![Span::styled("Esc  ", ink()), Span::raw("Back")]),
            ],
        ),
        Mode::ConfirmStop(run) => (
            " Stop ",
            vec![
                Line::raw(""),
                Line::from(Span::styled(format!("Stop build #{run}?"), ink())),
                Line::raw(""),
                Line::from(vec![Span::styled("y  ", ink()), Span::raw("Stop it")]),
                Line::from(Span::styled("Any other key keeps it running.", dim())),
            ],
        ),
        Mode::ConfirmAnswer(pin) => {
            let Some((q, o)) = app
                .selected_item()
                .and_then(|it| it.question())
                .filter(|q| q.id == pin.question)
                .and_then(|q| {
                    q.options
                        .get(pin.index)
                        .filter(|o| o.id == pin.option)
                        .map(|o| (q.clone(), o.clone()))
                })
            else {
                return;
            };
            // The question, the answer and what it does, every word (wrapped, never cut): a person's yes to exactly
            // this. When the window can't hold it all, Enter sends nothing and the words say where to answer.
            let w = (area.width as usize).saturating_sub(8).min(72);
            let mut lines = vec![Line::raw("")];
            lines.extend(
                wrap(&clean(&q.text), w)
                    .into_iter()
                    .map(|l| Line::from(Span::styled(l, dim()))),
            );
            lines.push(Line::raw(""));
            lines.extend(
                wrap(&clean(&o.label), w)
                    .into_iter()
                    .map(|l| Line::from(Span::styled(l, ink()))),
            );
            lines.extend(wrap(&clean(&o.consequence), w).into_iter().map(Line::raw));
            lines.push(Line::raw(""));
            lines.push(Line::from(vec![
                Span::styled("Enter  ", ink()),
                Span::raw("Send this answer"),
            ]));
            lines.push(Line::from(Span::styled("Any other key cancels.", dim())));
            let fits = w >= 20 && lines.len() + 2 <= area.height as usize;
            app.answer_shown = fits;
            if fits {
                (" Answer ", lines)
            } else {
                (
                    " Answer ",
                    wrap(crate::app::ANSWER_TOO_LONG, w.max(16))
                        .into_iter()
                        .map(|l| Line::from(Span::styled(l, ink())))
                        .collect(),
                )
            }
        }
        Mode::Build { .. } => return draw_build(f, app, area),
        Mode::ConfirmAccept(pin) => {
            // What is shown is the pinned result: the same facts the act posts.
            let files = pin
                .totals
                .map(|(f, a, d)| format!(" ({f} files, +{a} −{d})"))
                .unwrap_or_default();
            let run = pin.run;
            (
                " Accept ",
                vec![
                    Line::raw(""),
                    Line::from(Span::styled(
                        format!("Accept the result of build #{run}{files}?"),
                        ink(),
                    )),
                    Line::raw("It completes the task."),
                    Line::raw(""),
                    Line::from(vec![Span::styled("Enter  ", ink()), Span::raw("Accept")]),
                    Line::from(Span::styled("Any other key cancels.", dim())),
                ],
            )
        }
        Mode::Fatal(words, _) => {
            let mut lines = vec![Line::raw("")];
            lines.extend(
                wrap(words, 56)
                    .into_iter()
                    .map(|l| Line::from(Span::styled(l, ink()))),
            );
            lines.push(Line::raw(""));
            lines.push(Line::from(Span::styled("Press any key to close.", dim())));
            (" Toolroll ", lines)
        }
        _ => return,
    };
    let w = lines
        .iter()
        .map(|l| l.width())
        .max()
        .unwrap_or(20)
        .max(title.len()) as u16
        + 4;
    let r = centered(area, w, lines.len() as u16 + 2);
    f.render_widget(Clear, r);
    f.render_widget(
        Paragraph::new(lines).block(
            Block::default()
                .borders(Borders::ALL)
                .title(Span::styled(title, ink())),
        ),
        r,
    );
}

/// The words that end Build's terms when the window can't show them at all.
pub const TERMS_TOO_LONG: &str =
    "These terms are too long to show here — press w to review them in the browser.";

/// Build's terms, every term and every line whole (wrapped, never cut), scrolled with j/k. The end having been drawn
/// is what lets Enter build (app.rs Mode::Build `seen_end`): a person's yes is to exactly what they were shown.
fn draw_build(f: &mut Frame, app: &mut App, area: Rect) {
    let Mode::Build {
        terms,
        scroll,
        seen_end,
        ..
    } = &mut app.mode
    else {
        return;
    };
    let w = area.width.saturating_sub(6).min(96);
    let h = area.height.saturating_sub(2);
    let inner_w = w.saturating_sub(2) as usize;
    let label_w = terms
        .iter()
        .map(|(l, _)| width(l))
        .max()
        .unwrap_or(0)
        .min(18);
    let text_w = inner_w.saturating_sub(label_w + 2);
    // Head 2 lines, foot 4 lines: what's left shows the terms.
    let visible = (h as usize).saturating_sub(2 + 6);
    let r = Rect {
        x: area.x + (area.width.saturating_sub(w)) / 2,
        y: area.y + 1,
        width: w,
        height: h,
    };
    f.render_widget(Clear, r);
    let block = Block::default()
        .borders(Borders::ALL)
        .title(Span::styled(" New task ", ink()));
    if text_w < 16 || visible < 3 {
        // Too small to show them: no in-terminal Build.
        *seen_end = false;
        let lines: Vec<Line<'static>> = wrap(TERMS_TOO_LONG, inner_w.max(8))
            .into_iter()
            .map(|l| Line::from(Span::styled(l, ink())))
            .collect();
        f.render_widget(Paragraph::new(lines).block(block), r);
        return;
    }
    let mut body: Vec<Line<'static>> = vec![];
    for (label, words) in terms.iter() {
        let mut first = true;
        for part in words.split('\n') {
            for piece in wrap(&clean(part), text_w) {
                let lead = if first {
                    format!("{:<width$}  ", label, width = label_w)
                } else {
                    " ".repeat(label_w + 2)
                };
                let lead = if first && width(label) > label_w {
                    format!("{label}  ")
                } else {
                    lead
                };
                first = false;
                body.push(Line::from(vec![
                    Span::styled(lead, dim()),
                    Span::raw(piece),
                ]));
            }
        }
    }
    let max_scroll = body.len().saturating_sub(visible);
    if *scroll > max_scroll {
        *scroll = max_scroll;
    }
    let end = (*scroll + visible).min(body.len());
    if end >= body.len() {
        *seen_end = true;
    }
    let mut lines = vec![
        Line::from(Span::styled("Build approves exactly this:", ink())),
        Line::raw(""),
    ];
    lines.extend(body[*scroll..end].iter().cloned());
    lines.push(Line::raw(""));
    if end < body.len() {
        lines.push(Line::from(Span::styled(
            format!("↓ {} more lines: j or Space reads on", body.len() - end),
            ink(),
        )));
    } else {
        lines.push(Line::raw(""));
    }
    if *seen_end {
        lines.push(Line::from(vec![
            Span::styled("Enter  ", ink()),
            Span::raw("Build"),
        ]));
    } else {
        lines.push(Line::from(Span::styled(
            "Enter builds once you've read to the end.",
            dim(),
        )));
    }
    lines.push(Line::from(vec![
        Span::styled("p  ", ink()),
        Span::raw("Plan it first   "),
        Span::styled("w  ", ink()),
        Span::raw("Review in the browser"),
    ]));
    lines.push(Line::from(Span::styled("Esc files nothing.", dim())));
    f.render_widget(Paragraph::new(lines).block(block), r);
}
