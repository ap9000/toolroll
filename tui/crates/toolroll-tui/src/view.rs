//! Drawing the screen from the App, immediate-mode, every frame (layout from the live size each time).
//!
//! DESIGN.md: plain words in sentence case; ink for what needs you, never amber; blue only for running, green only for
//! passed, red only for failed. Every style is a theme role (theme.rs), every mark the glyph set's.
use crate::app::{App, Item, Mode, NoteKind, Section, Tab, Tone};
use crate::review::{self, Checks, Kind, Note, Row};
use crate::settings::{Column, Density};
use crate::syntax::{Highlights, Source, Token};
use crate::text::{clean, fit, width, wrap};
use crate::theme::{base, dim, failed, ink, line, marks, needs_you, passed, running, selected};
use crate::transcript;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use ratatui::Frame;
use toolroll_api::{StepCard, StepCards};

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
    let m = marks();
    match card.mark.as_str() {
        "done" => (m.passed, passed()),
        "live" => (m.running, running()),
        "needs" => (m.needs, needs_you()),
        "stuck" => (m.failed, failed()),
        "skipped" => (m.skipped, dim()),
        _ => (m.todo, dim()),
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
    if let Some(cost) = card.cost_usd.filter(|_| app.prefs.settings.show_costs) {
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
    crate::theme::set_look(app.prefs.theme, app.prefs.settings.glyphs);
    draw_frame(f, app);
    if app.prefs.settings.glyphs == crate::theme::Glyphs::Ascii {
        // Every symbol drawn, borders included, as its ASCII stand-in.
        for cell in f.buffer_mut().content.iter_mut() {
            let mut chars = cell.symbol().chars();
            if let (Some(c), None) = (chars.next(), chars.next()) {
                if let Some(a) = crate::theme::ascii_of(c) {
                    cell.set_char(a);
                }
            }
        }
    }
}

fn draw_frame(f: &mut Frame, app: &mut App) {
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
        .style(base())
        .border_style(line())
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
                if app.needs_count > 0 {
                    needs_you()
                } else {
                    dim()
                },
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
        Constraint::Length(u16::from(app.prefs.settings.key_bar)),
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
            Line::from(Span::styled("│", line()));
            sep.height as usize
        ]),
        sep,
    );
    draw_right(f, app, right);
    draw_status(f, app, status);
    if app.prefs.settings.key_bar {
        draw_keys(f, app.tab, keys);
    }
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
    let cols = columns(app);
    let comfortable = app.prefs.settings.density == Density::Comfortable;
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
        let here = index == app.selected;
        lines.push((
            item_line(item, here, w, &cells(app, item, &cols)),
            Some(index),
        ));
        if comfortable {
            // Comfortable: a second line with what it is doing, quiet.
            let style = if here { selected() } else { dim() };
            let text = fit(&format!("  {}", item.detail), w);
            let pad = w.saturating_sub(width(&text));
            lines.push((
                Line::from(vec![
                    Span::styled(text, style),
                    Span::styled(
                        " ".repeat(pad),
                        if here { selected() } else { Style::default() },
                    ),
                ]),
                Some(index),
            ));
        }
    }
    // Keep the selected row in view (all of its lines).
    let h = area.height as usize;
    let at = lines
        .iter()
        .rposition(|(_, i)| *i == Some(app.selected))
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

/// The list's right-hand columns (tui.toml `columns`), each with its width: the widest value shown, capped.
fn columns(app: &App) -> Vec<(Column, usize)> {
    let s = &app.prefs.settings;
    s.columns
        .iter()
        .copied()
        .filter(|c| *c != Column::Cost || s.show_costs)
        .map(|c| {
            let w = app
                .items
                .iter()
                .map(|i| width(&cell(app, i, c)))
                .max()
                .unwrap_or(0);
            (c, w)
        })
        .filter(|(_, w)| *w > 0)
        .collect()
}

fn cell(app: &App, item: &Item, column: Column) -> String {
    match column {
        Column::Step => fit(&item.word, 12),
        Column::Age => fit(item.age.trim_end_matches(" ago"), 8),
        Column::Project => fit(item.project.as_deref().unwrap_or(""), 12),
        Column::Agent => fit(app.facts.agent(&item.id).unwrap_or(""), 16),
        Column::Cost => app
            .facts
            .cost(&item.id)
            .map(|c| format!("${c:.2}"))
            .unwrap_or_default(),
    }
}

/// A row's columns, each right-aligned in its width, two spaces apart.
fn cells(app: &App, item: &Item, cols: &[(Column, usize)]) -> String {
    cols.iter()
        .map(|(c, w)| {
            let v = cell(app, item, *c);
            format!("{}{v}", " ".repeat(w.saturating_sub(width(&v))))
        })
        .collect::<Vec<_>>()
        .join("  ")
}

fn item_line(item: &Item, here: bool, w: usize, right: &str) -> Line<'static> {
    let m = marks();
    let (mark, style) = match item.section {
        Section::NeedsYou => (m.needs, needs_you()),
        Section::Working if item.paused => (m.paused, dim()),
        Section::Working => (m.running, running()),
        Section::DoneToday => (m.passed, passed()),
    };
    // Columns that leave the title too little room are left off, from the right.
    let mut right = right.trim_start().to_string();
    while !right.is_empty() && w.saturating_sub(width(&right) + 4) < 10 {
        right = match right.rfind("  ") {
            Some(i) => right[..i].trim_end().to_string(),
            None => String::new(),
        };
    }
    let room = w.saturating_sub(width(&right) + 4);
    let title = fit(&item.title, room);
    let gap = w.saturating_sub(2 + width(&title) + width(&right));
    let row = if here { selected() } else { Style::default() };
    let title_style = if item.section == Section::NeedsYou {
        if here {
            row.add_modifier(Modifier::BOLD)
        } else {
            needs_you()
        }
    } else {
        row
    };
    Line::from(vec![
        Span::styled(format!("{mark} "), if here { row } else { style }),
        Span::styled(title, title_style),
        Span::styled(" ".repeat(gap), row),
        Span::styled(right, if here { row } else { dim() }),
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
        let width = content.width as usize;
        let mut lines: Vec<Line> = wrap(words, width).into_iter().map(Line::raw).collect();
        // The first run's lines (the engine's agents read, the same words every screen shows): who the first task goes
        // to, or one "Sign in to <Agent>: run …" per installed agent, or how to install one.
        if let Some(agents) = app.agents.as_ref().filter(|_| app.loaded) {
            lines.push(Line::raw(""));
            for said in &agents.lines {
                lines.extend(
                    wrap(&clean(said), width)
                        .into_iter()
                        .map(|l| Line::from(Span::styled(l, ink()))),
                );
            }
        }
        f.render_widget(Paragraph::new(lines), content);
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
                    selected().add_modifier(Modifier::BOLD)
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
        let note_label: String;
        let (label, text) = match &app.mode {
            Mode::Steer(t) => ("Steer: ", t),
            Mode::Note(NoteKind::Line(target), t) => {
                let place = Note {
                    file: target.file,
                    path: target.path.clone(),
                    at: target.at.clone(),
                    order: target.order,
                    text: String::new(),
                }
                .place();
                note_label = format!("Note on {}: ", fit(&place, 48));
                (note_label.as_str(), t)
            }
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
        if let Some(cost) = card.cost_usd.filter(|_| app.prefs.settings.show_costs) {
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

/// What accepting the result on screen means, from the facts the engine already gave (the diff's totals, the step
/// cards' checks and cost) and the review's own accept facts: said before the dialog, and whole in it.
pub struct Facts {
    pub totals: Option<(i64, i64, i64)>,
    pub checks: Checks,
    pub cost: Option<f64>,
    pub owed: Option<String>,
    pub blockers: Vec<String>,
    pub needs: Option<String>,
}

pub fn facts_of(app: &App) -> Facts {
    let steps = app.steps.as_ref();
    let cards: Vec<&StepCard> = steps.map(chain_cards).unwrap_or_default();
    let checks = Checks::of(
        cards
            .iter()
            .find(|c| c.key == "checks")
            .map(|c| c.mark.as_str()),
    );
    let costs: Vec<f64> = cards.iter().filter_map(|c| c.cost_usd).collect();
    let accept = steps.and_then(|s| s.review.as_ref()).map(|r| &r.accept);
    Facts {
        // The saved stat's totals, else the file list's own counts (the same patch).
        totals: app.diff.as_ref().and_then(|d| {
            d.totals
                .as_ref()
                .map(|t| (t.files, t.additions, t.deletions))
                .or_else(|| {
                    (!d.files.is_empty()).then(|| {
                        (
                            d.files.len() as i64,
                            d.files.iter().map(|f| f.additions).sum(),
                            d.files.iter().map(|f| f.deletions).sum(),
                        )
                    })
                })
        }),
        checks,
        cost: (!costs.is_empty()).then(|| costs.iter().sum()),
        owed: accept.and_then(|a| a.owed.clone()),
        blockers: accept
            .map(|a| a.blockers.iter().map(|b| clean(b)).collect())
            .unwrap_or_default(),
        needs: accept.and_then(|a| a.needs.as_deref().map(clean)),
    }
}

fn checks_style(c: Checks) -> Style {
    match c {
        Checks::Passed => passed(),
        Checks::Failed => failed(),
        Checks::Running => running(),
        _ => dim(),
    }
}

/// What an owed acceptance means, in a few words.
fn owed_words(owed: &str) -> &'static str {
    match owed {
        "person-check" => "Accepting records that you checked this work yourself.",
        _ => "It needs a reason to be accepted: accept it in the browser (w).",
    }
}

/// The Diff tab: what accepting means, the files, then the file on screen as rows (unified or side by side), each note
/// under its line, the cursor's row marked, and colours added a few milliseconds a frame.
fn draw_diff(f: &mut Frame, app: &mut App, area: Rect) {
    let Some(diff) = app.diff.clone() else {
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
    app.set_diff_width(area.width);
    let facts = facts_of(app);
    let mut head: Vec<Line<'static>> = vec![];
    // What accepting means: files and lines, checks, cost, notes kept.
    let mut spans = vec![];
    if let Some((files, add, del)) = facts.totals {
        spans.push(Span::raw(format!("{files} files  ")));
        spans.push(Span::styled(format!("+{add}"), passed()));
        spans.push(Span::raw(" "));
        spans.push(Span::styled(format!("−{del}"), failed()));
        spans.push(Span::styled(" · ", dim()));
    }
    spans.push(Span::styled(
        facts.checks.word(),
        checks_style(facts.checks),
    ));
    if let Some(cost) = facts.cost {
        spans.push(Span::styled(format!(" · ${cost:.2}"), dim()));
    }
    let kept = diff
        .run
        .map(|run| app.notes_of(&diff.task, run).len())
        .unwrap_or(0);
    if kept > 0 {
        spans.push(Span::styled(
            format!(
                " · {kept} {} kept",
                if kept == 1 { "note" } else { "notes" }
            ),
            ink(),
        ));
    }
    head.push(fit_line(Line::from(spans), w));
    if let Some(needs) = &facts.needs {
        head.push(Line::from(Span::styled(fit(needs, w), ink())));
    } else if let Some(b) = facts.blockers.first() {
        head.push(Line::from(Span::styled(
            fit(&format!("Can't complete yet: {b}"), w),
            failed(),
        )));
    } else if let Some(owed) = &facts.owed {
        head.push(Line::from(Span::styled(fit(owed_words(owed), w), dim())));
    }
    // The files: a window of at most five around the one on screen.
    let n = diff.files.len();
    let shown_files = 5.min(n);
    let first = app
        .diff_index
        .saturating_sub(shown_files / 2)
        .min(n.saturating_sub(shown_files));
    for (i, file) in diff.files.iter().enumerate().skip(first).take(shown_files) {
        let here = i == app.diff_index;
        let style = if here {
            selected().add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        let name = fit(&clean(&file.path), w.saturating_sub(16));
        head.push(Line::from(vec![
            Span::styled(format!("{} {name}", if here { "›" } else { " " }), style),
            Span::raw("  "),
            Span::styled(format!("+{}", file.additions), passed()),
            Span::raw(" "),
            Span::styled(format!("−{}", file.deletions), failed()),
            Span::styled(if file.binary { "  binary" } else { "" }, dim()),
        ]));
    }
    if n > shown_files {
        head.push(Line::from(Span::styled(
            format!("  {} more files · {{ }} another file", n - shown_files),
            dim(),
        )));
    }
    let body_h = (area.height as usize).saturating_sub(head.len() + 1);
    let mut lines = head;
    lines.push(Line::raw(""));
    if app.diff_file.is_none() || app.code.is_none() {
        lines.push(Line::from(Span::styled("Reading the file…", dim())));
        f.render_widget(Paragraph::new(lines), area);
        return;
    }
    // Keep the cursor in sight.
    let total = app.rows.len();
    if app.diff_cursor < app.diff_scroll {
        app.diff_scroll = app.diff_cursor;
    }
    if body_h > 0 && app.diff_cursor >= app.diff_scroll + body_h {
        app.diff_scroll = app.diff_cursor + 1 - body_h;
    }
    app.diff_scroll = app.diff_scroll.min(total.saturating_sub(1));
    colour_code(app);
    let file = app.diff_file.as_ref().unwrap();
    let code = app.code.as_ref().unwrap();
    let notes = app.notes_here();
    let split = app.split_on();
    let hl = app.highlights.as_ref();
    let end = (app.diff_scroll + body_h).min(total);
    for r in app.diff_scroll..end {
        let here = r == app.diff_cursor;
        let mark = Span::styled(if here { "›" } else { " " }, ink());
        let line = match &app.rows[r] {
            Row::Hunk(h) => {
                let header = clean(&file.file.hunks[*h].header);
                Line::from(vec![
                    mark,
                    Span::styled(
                        header,
                        if here {
                            dim().add_modifier(Modifier::REVERSED)
                        } else {
                            dim()
                        },
                    ),
                ])
            }
            Row::Gap { hidden, .. } => {
                let words = match hidden {
                    Some(1) => "⋯ 1 hidden line · e shows it".to_string(),
                    Some(k) => format!("⋯ {k} hidden lines · e/E show more"),
                    None => "⋯ more lines below · E shows them".to_string(),
                };
                Line::from(vec![mark, Span::styled(words, dim())])
            }
            Row::Code(c) => {
                let mut spans = vec![mark];
                let pieces = hl.and_then(|h| h.line(*c));
                spans.extend(code_spans(&code.lines[*c], pieces.as_ref(), w >= 60));
                Line::from(spans)
            }
            Row::Pair(l, rgt) => {
                let half = (w.saturating_sub(3)) / 2;
                let side = |c: Option<usize>, old: bool| -> Line<'static> {
                    match c {
                        None => Line::raw(""),
                        Some(c) => {
                            let line = &code.lines[c];
                            let pieces = hl.and_then(|h| h.line(c));
                            Line::from(half_spans(line, pieces.as_ref(), old))
                        }
                    }
                };
                let left = fit_line(side(*l, true), half);
                let right = fit_line(side(*rgt, false), half);
                let pad = half.saturating_sub(left.width());
                let mut spans = vec![mark];
                spans.extend(left.spans);
                spans.push(Span::raw(" ".repeat(pad)));
                spans.push(Span::styled("│", dim()));
                spans.extend(right.spans);
                Line::from(spans)
            }
            Row::Note(k) => {
                let text = notes.get(*k).map(|n| n.text.clone()).unwrap_or_default();
                Line::from(vec![
                    mark,
                    Span::styled(
                        if split {
                            "  Note: "
                        } else {
                            "            Note: "
                        },
                        dim(),
                    ),
                    Span::styled(
                        text,
                        if here {
                            Style::default().add_modifier(Modifier::REVERSED)
                        } else {
                            Style::default().add_modifier(Modifier::ITALIC)
                        },
                    ),
                ])
            }
        };
        lines.push(fit_line(line, w));
    }
    if end >= total && file.lines_truncated && lines.len() < area.height as usize {
        lines.push(Line::from(Span::styled(
            "The rest of this file is in the browser (w).",
            dim(),
        )));
    }
    f.render_widget(Paragraph::new(lines), area);
}

/// Start colouring the file on screen (keyed to its layout, so a new file or reveal starts over), and say whether more
/// is coming (the loop draws again while it is).
fn colour_code(app: &mut App) {
    let (Some((task, run, file, path)), Some(code), true) =
        (app.file_shown(), app.code.as_ref(), app.syntax_on)
    else {
        app.highlight_pending = false;
        app.highlights = None;
        return;
    };
    let key = (task, run, file, app.code_version);
    if app.highlights.as_ref().map(|h| &h.key) != Some(&key) {
        let sources = code
            .lines
            .iter()
            .map(|l| Source {
                text: l.text.clone(),
                fresh: l.fresh,
            })
            .collect();
        app.highlights = Some(Highlights::new(key, &path, sources));
    }
    app.highlight_pending = !app.highlights.as_ref().unwrap().done();
}

/// A code line's text as spans: its colours (when coloured), the words that changed marked, the whole line red when
/// removed (and green when added with no colours to show).
fn text_spans(
    line: &review::CodeLine,
    pieces: Option<&Vec<(Token, String)>>,
) -> Vec<Span<'static>> {
    let base = match line.kind {
        Kind::Deletion => failed(),
        Kind::Addition if pieces.is_none_or(|p| p.iter().all(|(t, _)| *t == Token::Plain)) => {
            passed()
        }
        Kind::Revealed | Kind::Meta => dim(),
        _ => Style::default(),
    };
    let coloured = line.kind != Kind::Deletion && line.kind != Kind::Meta;
    let owned;
    let pieces: &[(Token, String)] = match pieces {
        Some(p) if coloured => p,
        _ => {
            owned = vec![(Token::Plain, line.text.clone())];
            &owned
        }
    };
    let mut out = vec![];
    let mut at = 0usize;
    for (token, text) in pieces {
        let style = if *token == Token::Plain {
            base
        } else {
            base.patch(crate::theme::code(*token))
        };
        // Split this piece where a changed range starts or ends.
        let end = at + text.len();
        let mut cut = vec![at, end];
        for r in &line.changed {
            for p in [r.start, r.end] {
                if p > at && p < end && text.is_char_boundary(p - at) {
                    cut.push(p);
                }
            }
        }
        cut.sort_unstable();
        cut.dedup();
        for pair in cut.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            let changed = line.changed.iter().any(|r| r.start <= a && b <= r.end);
            let s = if changed {
                style.add_modifier(Modifier::REVERSED)
            } else {
                style
            };
            out.push(Span::styled(text[a - at..b - at].to_string(), s));
        }
        at = end;
    }
    out
}

fn sign_of(kind: Kind) -> (&'static str, Style) {
    match kind {
        Kind::Addition => ("+", passed()),
        Kind::Deletion => ("−", failed()),
        _ => (" ", dim()),
    }
}

fn num(n: Option<i64>) -> String {
    n.map(|n| format!("{n:>4}"))
        .unwrap_or_else(|| "    ".into())
}

/// Unified: old and new numbers (one column when narrow), the sign, the code.
fn code_spans(
    line: &review::CodeLine,
    pieces: Option<&Vec<(Token, String)>>,
    both: bool,
) -> Vec<Span<'static>> {
    let (sign, sign_style) = sign_of(line.kind);
    let numbers = if both {
        format!("{} {} ", num(line.old), num(line.new))
    } else {
        format!("{} ", num(line.new.or(line.old)))
    };
    let mut spans = vec![
        Span::styled(numbers, dim()),
        Span::styled(format!("{sign} "), sign_style),
    ];
    spans.extend(text_spans(line, pieces));
    spans
}

/// Side by side: one side's number, sign and code (a context line shows on both sides).
fn half_spans(
    line: &review::CodeLine,
    pieces: Option<&Vec<(Token, String)>>,
    old: bool,
) -> Vec<Span<'static>> {
    let (sign, sign_style) = sign_of(line.kind);
    let n = if old { line.old } else { line.new };
    let mut spans = vec![
        Span::styled(format!("{} ", num(n)), dim()),
        Span::styled(format!("{sign} "), sign_style),
    ];
    spans.extend(text_spans(line, pieces));
    spans
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
    ("Enter", "open"),
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

/// The Diff tab's keys: moving through the changes, notes, more lines, the view, copy, and the acts.
const DIFF_KEYS: &[(&str, &str)] = &[
    ("j/k", "line"),
    ("[ ]", "hunk"),
    ("{ }", "file"),
    ("c", "note"),
    ("a", "accept"),
    ("r", "send back"),
    ("e/E", "more lines"),
    ("v", "side by side"),
    ("y", "copy"),
    ("n/N", "notes"),
    ("w", "browser"),
    ("?", "help"),
    ("q", "quit"),
];

fn draw_keys(f: &mut Frame, tab: Tab, area: Rect) {
    let keys = if tab == Tab::Diff { DIFF_KEYS } else { KEYS };
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
    let mut keep = keys.len();
    loop {
        let mut set: Vec<(&str, &str)> = keys[..keep.min(keys.len() - 2)]
            .iter()
            .map(|&(k, what)| (if k == "Enter" { marks().enter } else { k }, what))
            .collect();
        set.extend_from_slice(&keys[keys.len() - 2..]);
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
                "PgUp PgDn    scroll; End follows the newest",
                "",
                "In Diff: j/k a line  [ ] a hunk  { } a file  n/N a note",
                "  c          a note on the line or hunk (kept here until you send)",
                "  e / E      more lines above / below the hunk",
                "  v          side by side (on a wide window)",
                "  y          copy the hunk to your terminal's scrollback",
                "  r          send back with your notes;  a  accept (t attaches them)",
                "n            new task",
                "w            open Toolroll in your browser",
                "q            quit",
                "",
                "Mouse: click to select, wheel to scroll, drag the divider.",
                "Press s for settings, any other key to close.",
            ]
            .into_iter()
            .map(Line::raw)
            .collect(),
        ),
        Mode::Settings => (
            " Settings ",
            app.prefs
                .screen((area.width as usize).saturating_sub(8).min(88)),
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
                    .map(|l| Line::from(Span::styled(l, ink()))),
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
            // What is shown is the pinned result: the same facts the act posts, and what accepting means.
            let pin = pin.clone();
            let facts = facts_of(app);
            let w = (area.width as usize).saturating_sub(8).min(84);
            let notes = app.notes_of(&pin.task, pin.run);
            let label = |l: &str| Span::styled(format!("{l:<10}"), dim());
            let mut lines = vec![
                Line::raw(""),
                Line::from(Span::styled(
                    format!("Accept the result of build #{}?", pin.run),
                    ink(),
                )),
                Line::raw(""),
            ];
            if let Some((files, add, del)) = pin.totals.or(facts.totals) {
                lines.push(Line::from(vec![
                    label("Changes"),
                    Span::raw(format!("{files} files, ")),
                    Span::styled(format!("+{add}"), passed()),
                    Span::raw(" "),
                    Span::styled(format!("−{del}"), failed()),
                ]));
            }
            lines.push(Line::from(vec![
                label("Checks"),
                Span::styled(facts.checks.short(), checks_style(facts.checks)),
            ]));
            lines.push(Line::from(vec![
                label("Cost"),
                Span::raw(
                    facts
                        .cost
                        .map_or("not recorded".to_string(), |c| format!("${c:.2}")),
                ),
            ]));
            let wrapped = |lines: &mut Vec<Line<'static>>, l: &str, words: &str, style: Style| {
                for (i, piece) in wrap(words, w.saturating_sub(10).max(16))
                    .into_iter()
                    .enumerate()
                {
                    lines.push(Line::from(vec![
                        if i == 0 {
                            label(l)
                        } else {
                            Span::raw(" ".repeat(10))
                        },
                        Span::styled(piece, style),
                    ]));
                }
            };
            if let Some(needs) = &facts.needs {
                wrapped(&mut lines, "Who", needs, ink());
            }
            for b in &facts.blockers {
                wrapped(&mut lines, "Blocked", b, failed());
            }
            if let Some(owed) = &facts.owed {
                wrapped(&mut lines, "Means", owed_words(owed), Style::default());
            }
            if !notes.is_empty() {
                if app.accept_attach {
                    lines.push(Line::raw(""));
                    lines.push(Line::from(Span::styled(
                        "These notes go with it (saved on the result):",
                        ink(),
                    )));
                    for part in review::batch_text(&notes, "").split('\n') {
                        lines.extend(wrap(part, w).into_iter().map(Line::raw));
                    }
                } else {
                    wrapped(
                        &mut lines,
                        "Notes",
                        &format!("{} kept · t attaches them", notes.len()),
                        Style::default(),
                    );
                }
            }
            lines.push(Line::raw(""));
            lines.push(Line::raw("It completes the task."));
            lines.push(Line::raw(""));
            lines.push(Line::from(vec![
                Span::styled("Enter  ", ink()),
                Span::raw(if app.accept_attach {
                    "Accept with the notes"
                } else {
                    "Accept"
                }),
            ]));
            if !notes.is_empty() {
                lines.push(Line::from(vec![
                    Span::styled("t      ", ink()),
                    Span::raw(if app.accept_attach {
                        "Don't attach the notes"
                    } else {
                        "Attach the notes"
                    }),
                ]));
            }
            lines.push(Line::from(Span::styled("Any other key cancels.", dim())));
            let fits = lines.len() + 2 <= area.height as usize;
            app.batch_shown = fits;
            if fits || !app.accept_attach {
                (" Accept ", lines)
            } else {
                (
                    " Accept ",
                    wrap(crate::app::NOTES_TOO_LONG, w.max(16))
                        .into_iter()
                        .map(|l| Line::from(Span::styled(l, ink())))
                        .collect(),
                )
            }
        }
        Mode::SendBack(pin, typed) => {
            // The notes going back, and the words for the whole change being typed. Not yet a send: Enter shows the
            // whole text to read to its end (SendReview), and only that text is posted.
            let pin = pin.clone();
            let typed = typed.clone();
            let w = (area.width as usize).saturating_sub(8).min(84);
            let notes = app.notes_of(&pin.task, pin.run);
            let room_lines = (area.height as usize).saturating_sub(12).max(1);
            let head = if notes.is_empty() {
                format!("Send back build #{}, saying what to change:", pin.run)
            } else {
                format!("Send back build #{} with:", pin.run)
            };
            let mut lines = vec![
                Line::raw(""),
                Line::from(Span::styled(head, ink())),
                Line::raw(""),
            ];
            let mut body: Vec<Line<'static>> = vec![];
            if !notes.is_empty() {
                for part in review::batch_text(&notes, "").split('\n') {
                    body.extend(wrap(part, w).into_iter().map(Line::raw));
                }
                body.push(Line::raw(""));
            }
            if body.len() > room_lines {
                let more = body.len() - room_lines + 1;
                body.truncate(room_lines - 1);
                body.push(Line::from(Span::styled(
                    format!("… {more} more lines: you read them all before it's sent"),
                    dim(),
                )));
            }
            lines.extend(body);
            let label = if notes.is_empty() {
                "What to change: "
            } else {
                "For the whole change: "
            };
            let room = w.saturating_sub(width(label) + 1);
            let shown: String = {
                let chars: Vec<char> = typed.chars().collect();
                let mut used = 0;
                let mut start = chars.len();
                while start > 0 && used + width(&chars[start - 1].to_string()) <= room {
                    start -= 1;
                    used += width(&chars[start].to_string());
                }
                chars[start..].iter().collect()
            };
            lines.push(Line::from(vec![
                Span::styled(label, dim()),
                Span::raw(shown),
                Span::styled("▏", ink()),
            ]));
            lines.push(Line::raw(""));
            lines.push(Line::from(vec![
                Span::styled("Enter  ", ink()),
                Span::raw("Read it all, then send"),
                Span::styled("   Esc  ", ink()),
                Span::raw("Keep the notes"),
            ]));
            (" Send back ", lines)
        }
        Mode::SendReview { .. } => return draw_send_review(f, app, area),
        Mode::Sending(words) => (
            " Saving ",
            vec![
                Line::raw(""),
                Line::from(Span::styled(words.clone(), ink())),
                Line::raw(""),
                Line::from(Span::styled("Wait for Toolroll's answer.", dim())),
            ],
        ),
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
                .style(base())
                .border_style(line())
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
        .style(base())
        .border_style(line())
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

/// Send back's whole text, exactly as it will be posted: every line wrapped (never cut), scrolled with j/k or Space.
/// Drawing its end is what lets Enter send (app.rs Mode::SendReview `seen_end`), as with Build's terms.
fn draw_send_review(f: &mut Frame, app: &mut App, area: Rect) {
    let Mode::SendReview {
        pin,
        text,
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
        .title(Span::styled(" Send back ", ink()));
    if inner_w < 16 || visible < 3 {
        *seen_end = false;
        let lines: Vec<Line<'static>> = wrap(crate::app::NOTES_TOO_LONG, inner_w.max(8))
            .into_iter()
            .map(|l| Line::from(Span::styled(l, ink())))
            .collect();
        f.render_widget(Paragraph::new(lines).block(block), r);
        return;
    }
    let mut body: Vec<Line<'static>> = vec![];
    for part in text.split('\n') {
        body.extend(wrap(part, inner_w).into_iter().map(Line::raw));
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
        Line::from(Span::styled(
            format!("Build #{} goes back with exactly this:", pin.run),
            ink(),
        )),
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
            Span::raw("Send back"),
        ]));
    } else {
        lines.push(Line::from(Span::styled(
            "Enter sends once you've read to the end.",
            dim(),
        )));
    }
    lines.push(Line::from(vec![
        Span::styled("Esc  ", ink()),
        Span::raw("Back to your words (nothing is sent)"),
    ]));
    f.render_widget(Paragraph::new(lines).block(block), r);
}
