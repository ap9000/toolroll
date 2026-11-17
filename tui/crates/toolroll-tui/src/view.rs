//! Drawing the screen from the App, immediate-mode, every frame (layout from the live size each time).
//!
//! DESIGN.md: plain words in sentence case; ink for what needs you, never amber; blue only for running, green only for
//! passed, red only for failed. Every style is a theme role (theme.rs), every mark the glyph set's.
use crate::app::{App, Item, Mode, NoteKind, Section, Tab, Tone};
use crate::keys::Action;
use crate::review::{self, Checks, Kind, Note, Row};
use crate::settings::{Column, Density};
use crate::sheet;
use crate::syntax::{Highlights, Source, Token};
use crate::text::{clean, fit, width, wrap};
use crate::theme::{
    base, dim, failed, ground, ink, line, marks, needs_you, passed, running, selected, wash,
};
use crate::transcript;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Clear, Padding, Paragraph};
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

/// A waiting task in one line: "Last build failed · <reason> · next try in 1m 40s", from the engine's own due time.
pub fn waiting_words(w: &toolroll_api::Waiting, now: i64) -> String {
    let next = match w.retry_at.as_deref().and_then(epoch) {
        Some(at) if at > now => format!("next try in {}", duration(at - now)),
        Some(_) => "trying again now".to_string(),
        None => "next try when a builder is free".to_string(),
    };
    match w.last_failure.as_deref().map(clean) {
        Some(why) if !why.is_empty() => format!("Last build failed · {why} · {next}"),
        _ => format!("Waiting · {next}"),
    }
}

/// The engine's suggestion beside Retry, without its "retry as it is" (Retry is the key right under it).
pub fn suggestion_words(s: &str) -> Option<String> {
    let s = clean(s);
    let rest = s
        .strip_prefix("Retry as it is;")
        .or_else(|| s.strip_prefix("Retry as it is."))
        .map(str::trim)
        .unwrap_or(s.trim());
    let mut chars = rest.chars();
    let first = chars.next()?;
    Some(format!("{}{}", first.to_uppercase(), chars.as_str()))
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

/// A step's time on the strip: "42s", "4m", "1h 05m".
pub fn short_duration(secs: i64) -> String {
    let secs = secs.max(0);
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else {
        format!("{}h {:02}m", secs / 3600, (secs % 3600) / 60)
    }
}

/// The step strip in a panel's header, "Plan ✓ · Build ◐ 4m · Checks · Review (codex)": the chain's steps from the
/// task's step cards (a "Just code" chain has no Plan or Approval), the running one's time ticking with the clock.
pub fn strip(app: &App, steps: &StepCards, w: usize) -> Line<'static> {
    // Joined by rules when there's room ("Plan ✓ ─── Build ◐ 4m"), else by dots.
    let ruled = step_line_with(app, steps, true, " ─── ");
    if ruled.width() <= w {
        return ruled;
    }
    let full = step_line_with(app, steps, true, " · ");
    if full.width() <= w {
        return full;
    }
    fit_line(step_line_with(app, steps, false, " · "), w)
}

fn step_line_with(app: &App, steps: &StepCards, times: bool, join: &str) -> Line<'static> {
    let mut spans = vec![];
    for (i, card) in chain_cards(steps).into_iter().enumerate() {
        if i > 0 {
            spans.push(Span::styled(
                join.to_string(),
                if join == " · " { dim() } else { line() },
            ));
        }
        let (mark, style) = mark_of(card);
        let label = step_label(card);
        if card.mark == "todo" || card.mark == "wait" {
            spans.push(Span::styled(label, dim()));
            continue;
        }
        spans.push(Span::raw(format!("{label} ")));
        spans.push(Span::styled(mark.to_string(), style));
        if card.mark == "live" && times {
            // This build's own time (not the first build's).
            if let Some(start) = card
                .latest_started_at
                .as_deref()
                .or(card.started_at.as_deref())
                .and_then(epoch)
            {
                spans.push(Span::styled(
                    format!(" {}", short_duration(app.now - start)),
                    dim(),
                ));
            }
        }
    }
    Line::from(spans)
}

/// A build card's words while its task waits: on a person's hold, or to try again after a failed build (None: neither).
/// The engine's card says "Stopped" or "Waiting to start"; a person reads where it stands and the attempt it follows.
pub fn build_wait(steps: &StepCards, card: &StepCard) -> Option<&'static str> {
    if card.key != "build" || steps.live_run.is_some() || steps.task.state != "queued" {
        return None;
    }
    if steps.held.is_some() {
        Some("On hold")
    } else if steps.waiting.is_some() && !card.runs.is_empty() {
        Some("Waiting to retry")
    } else {
        None
    }
}

/// "Fix" → "Fix" ("attempt 2" → "Attempt 2").
fn upper_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().chain(c).collect(),
        None => String::new(),
    }
}

/// "claude sonnet · Building now · 4m 12s · $0.31 · attempt 2"; waiting, "Waiting to retry · 21s · after attempt 2".
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
    let wait = build_wait(steps, card);
    if let Some(words) = wait {
        parts.push(words.to_string());
    } else if !card.sentence.is_empty() {
        parts.push(clean(&card.sentence));
    }
    if let Some(secs) = build_clock(app, steps, card) {
        parts.push(duration(secs));
    }
    if let Some(cost) = card.cost_usd.filter(|_| app.prefs.settings.show_costs) {
        parts.push(format!("${cost:.2}"));
    }
    // The task's own attempt number (the console's build ids count across tasks); waiting, the one it follows.
    if let Some(n) = card
        .runs
        .first()
        .and_then(|r| crate::app::attempt_of(steps, *r))
    {
        parts.push(if wait.is_some() {
            format!("after attempt {n}")
        } else {
            format!("attempt {n}")
        });
    }
    Some(Line::from(Span::styled(parts.join(" · "), dim())))
}

/// The one clock for a step's current build, the same in the header and in Steps: running, since that build started;
/// waiting (queued again, or held), since that build stopped; finished, how long it ran.
pub fn build_clock(app: &App, steps: &StepCards, card: &StepCard) -> Option<i64> {
    let start = card
        .latest_started_at
        .as_deref()
        .or(card.started_at.as_deref())
        .and_then(epoch);
    let end = card.finished_at.as_deref().and_then(epoch);
    let running = card.mark == "live" || (card.key == "build" && steps.live_run.is_some());
    // (Only the build waits to try again; a plan or an approval that finished says how long it took.)
    let waiting = !running && card.key == "build" && steps.task.state == "queued";
    if running {
        return start.map(|s| app.now - s);
    }
    if waiting {
        return end.map(|e| app.now - e);
    }
    match (start, end) {
        (Some(s), Some(e)) => Some(e - s),
        _ => None,
    }
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
    app.areas.links.clear();
    // On screen this frame only if draw_terminal draws it, and no dialog is drawn over it.
    if let Some(pane) = app.term.as_mut() {
        pane.drawn = false;
    }
    // No dialog on screen until draw_overlay draws one this frame (a window too small draws none).
    app.drawn_dialog = None;
    draw_frame(f, app);
    let dialog = !matches!(
        app.mode,
        Mode::Normal | Mode::TakeOver | Mode::Steer(_) | Mode::NewTask(..) | Mode::Note(..)
    );
    if let Some(pane) = app.term.as_mut().filter(|_| dialog) {
        pane.drawn = false;
    }
    // A dialog may be drawn over a link's words: nothing is made clickable under it.
    if dialog {
        app.areas.links.clear();
    }
    // Typing stops when its terminal isn't on screen; t starts it again once it is.
    if app.mode == Mode::TakeOver && !app.term.as_ref().is_some_and(|p| p.drawn) {
        app.mode = Mode::Normal;
        app.status = Some((Tone::Said, crate::app::OFF_SCREEN.into()));
    }
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
    sheet::paint(f.buffer_mut(), area, ground());
    if area.height < 8 || area.width < 34 {
        f.render_widget(Paragraph::new("Make the window larger."), area);
        return;
    }
    draw_top(f, app, Rect { height: 1, ..area });
    // The frame: the top bar, a gutter row on a tall window, the sheets, then what was said and the key bar.
    let gutter = u16::from(area.height >= 30);
    let margin = u16::from(area.width >= 100);
    let keys_h = u16::from(app.prefs.settings.key_bar);
    let body = Rect {
        x: area.x + margin,
        y: area.y + 1 + gutter,
        width: area.width.saturating_sub(2 * margin),
        height: area.height.saturating_sub(1 + gutter + 1 + keys_h),
    };
    let status = Rect {
        x: area.x + margin + 1,
        y: body.bottom(),
        width: area.width.saturating_sub(2 * margin + 2),
        height: 1,
    };
    let keys = Rect {
        y: status.y + 1,
        height: keys_h,
        ..status
    };
    // The list's sheet, a one-cell gutter (the divider a drag moves), and the panels' sheets. The list is full, a slim
    // rail of status marks, or hidden; on either side; set aside while a panel is zoomed or the window is narrow.
    app.areas.body = body;
    let narrow = area.width < NARROW_WIDTH;
    app.narrow = narrow;
    let list_state = if app.zoom || narrow {
        crate::viewstate::ListState::Hidden
    } else {
        app.list_state
    };
    let split = match list_state {
        crate::viewstate::ListState::Full => list_width_drawn(app.split, body.width),
        crate::viewstate::ListState::Rail => RAIL_WIDTH,
        crate::viewstate::ListState::Hidden => 0,
    };
    let gap = u16::from(split > 0);
    let on_right = app.side == crate::viewstate::Side::Right;
    let left = Rect {
        x: if on_right {
            body.right().saturating_sub(split)
        } else {
            body.x
        },
        width: split,
        ..body
    };
    let right = Rect {
        x: if on_right {
            body.x
        } else {
            body.x + split + gap
        },
        width: body.width.saturating_sub(split + gap),
        ..body
    };
    app.areas.split_x = if split == 0 {
        u16::MAX
    } else if on_right {
        left.x.saturating_sub(1)
    } else {
        body.x + split
    };
    // The Agents screen is a screen of its own: one sheet across the body while it is open (agents.rs).
    if app.agents_screen.is_some() {
        app.areas.list = Rect::default();
        app.areas.rows.clear();
        app.areas.tabs.clear();
        app.panes.areas = vec![];
        let inner = sheet::sheet(f.buffer_mut(), body);
        app.areas.right = inner;
        crate::agents::draw(f, app, inner);
        draw_status(f, app, status);
        if app.prefs.settings.key_bar {
            draw_keys(f, app, keys);
        }
        draw_overlay(f, app, area);
        return;
    }
    // Narrow, the list asked for (b, or Esc from a panel): the list across the whole column, no panel under it.
    if narrow && app.narrow_list && !app.zoom {
        app.panes.areas = vec![];
        app.areas.tabs.clear();
        app.areas.split_x = u16::MAX;
        let list = sheet::sheet(f.buffer_mut(), body);
        draw_list(f, app, list);
        draw_status(f, app, status);
        if app.prefs.settings.key_bar {
            draw_keys(f, app, keys);
        }
        draw_overlay(f, app, area);
        return;
    }
    match list_state {
        crate::viewstate::ListState::Full => {
            let list = sheet::sheet(f.buffer_mut(), left);
            draw_list(f, app, list);
        }
        crate::viewstate::ListState::Rail => {
            let list = sheet::sheet(f.buffer_mut(), left);
            draw_rail(f, app, list);
        }
        crate::viewstate::ListState::Hidden => {
            app.areas.list = Rect::default();
            app.areas.rows.clear();
        }
    }
    // One panel, or two to four (panes.rs): each its own sheet; the focused one is the workbench's own, the others
    // watch their tasks. Zoomed, or on a narrow window: the focused panel alone.
    let alone = app.zoom || narrow;
    let layout = if alone {
        crate::panes::Layout::Focused
    } else {
        app.panes.layout
    };
    let places = crate::panes::places(layout, right, app.panes.ratio_x, app.panes.ratio_y);
    app.panes.areas = if alone { vec![] } else { places.clone() };
    let several = places.len() > 1;
    for (i, place) in places.iter().enumerate() {
        let slot = if alone { app.panes.focus } else { i };
        let inner = sheet::sheet(f.buffer_mut(), *place);
        if slot == app.panes.focus {
            draw_right(f, app, inner);
            // Search: every match in this panel lit.
            if let Some(q) = app.search.as_ref().map(|s| s.query.clone()) {
                crate::search::highlight(f.buffer_mut(), app.areas.content, &q);
            }
            // With several panels, the focused one is outlined in ink, heavy (reads without colour too).
            if several {
                sheet::outline_focus(f.buffer_mut(), *place);
            }
        } else {
            crate::panes::draw_watch(f, app, slot, inner);
        }
    }
    draw_status(f, app, status);
    if app.prefs.settings.key_bar {
        draw_keys(f, app, keys);
    }
    draw_overlay(f, app, area);
}

/// The narrowest list drawn beside a panel.
pub const LIST_MIN: u16 = 24;

/// The widest list this body width gives beside a panel: under half of it, and room left for the panel.
pub fn list_width_max(body_width: u16) -> u16 {
    (body_width * 45 / 100)
        .min(body_width.saturating_sub(28))
        .max(LIST_MIN)
}

/// The list's width as drawn for the width asked (`split`) in a body this wide.
pub fn list_width_drawn(split: u16, body_width: u16) -> u16 {
    split
        .min(body_width * 45 / 100)
        .max(LIST_MIN)
        .min(body_width.saturating_sub(28))
}

/// Below this many columns the screen is one column: the focused panel alone (the list hidden, splits set aside).
pub const NARROW_WIDTH: u16 = 64;
/// The list as a slim rail: its status marks and the needs-you count.
pub const RAIL_WIDTH: u16 = 6;

/// The list as a slim rail: the needs-you count on top, then each task's status mark in the list's order (the
/// selected one lit, an unread one marked). Clicking a mark selects its task.
fn draw_rail(f: &mut Frame, app: &mut App, area: Rect) {
    app.areas.list = area;
    app.areas.rows.clear();
    let mut lines: Vec<Line<'static>> = vec![];
    let count = app.needs_count.max(0);
    lines.push(Line::from(if count > 0 {
        sheet::chip(&count.to_string())
    } else {
        Span::styled("0", dim())
    }));
    lines.push(Line::raw(""));
    for (i, item) in app.items.iter().enumerate() {
        if lines.len() >= area.height as usize {
            break;
        }
        let (mark, style, _) = look_of(item);
        let unread = if app.unread.contains(&item.id) {
            "•"
        } else {
            " "
        };
        let l = Line::from(vec![
            Span::styled(mark.to_string(), style),
            Span::styled(unread.to_string(), ink()),
        ]);
        app.areas.rows.push((area.y + lines.len() as u16, Some(i)));
        lines.push(if i == app.selected {
            sheet::band(l, area.width as usize, selected())
        } else {
            l
        });
    }
    f.render_widget(Paragraph::new(lines), area);
}

/// The top bar's items, each with its place in the keep order when the bar is short of room (highest kept first). The
/// same items and the same order on every screen (the list, a task, narrow or wide), so what a screen shows depends
/// only on the room, never on which screen it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum TopItem {
    /// Dropped first.
    Working,
    Unread,
    Cost,
    Project,
    /// What is set aside: ZOOM, NARROW, RAIL, LIST HIDDEN.
    Marks,
    /// Never dropped (with "Toolroll").
    Needs,
}

/// The top bar, on the ground: Toolroll, the project and the cost line on the left; what's working, what's set aside,
/// unread tasks and what needs you on the right. Short of room, items are kept in TopItem's order, the same everywhere.
fn draw_top(f: &mut Frame, app: &App, area: Rect) {
    let needs = if !app.loaded {
        Span::styled("Reading…", dim())
    } else if app.needs_count == 0 {
        Span::styled("Nothing needs you", dim())
    } else if app.needs_count == 1 {
        sheet::chip("1 needs you")
    } else {
        sheet::chip(&format!("{} need you", app.needs_count))
    };
    let working = app
        .all_items
        .iter()
        .filter(|i| i.section == Section::Working && !i.paused)
        .count();
    // (item, spans, on the right)
    let mut items: Vec<(TopItem, Vec<Span<'static>>, bool)> = vec![];
    if !app.project_name.is_empty() {
        let name = fit(&app.project_name, 32);
        items.push((
            TopItem::Project,
            vec![if crate::theme::fills() {
                Span::styled(format!(" {name} "), ink().patch(crate::theme::fill()))
            } else {
                Span::styled(format!("· {name}"), Style::default())
            }],
            false,
        ));
    }
    // The cost line: "$1.84 today · plan 62%" (show-costs = false hides it).
    if let Some(c) = cost_line(app) {
        items.push((TopItem::Cost, vec![Span::styled(c, dim())], false));
    }
    if working > 0 && app.loaded {
        items.push((
            TopItem::Working,
            vec![sheet::badge(
                &format!("{} {working} working", marks().running),
                crate::theme::Role::Running,
            )],
            true,
        ));
    }
    // What is set aside, said where it can't be missed: zoomed, narrow, the list as a rail or hidden.
    let narrow = f.area().width < NARROW_WIDTH;
    let mut marks_on: Vec<Span<'static>> = vec![];
    let mut mark = |m: &str| {
        if !marks_on.is_empty() {
            marks_on.push(Span::raw("  "));
        }
        marks_on.push(sheet::chip(m));
    };
    if app.zoom {
        mark("ZOOM");
    }
    if narrow {
        mark("NARROW");
    } else if !app.zoom {
        match app.list_state {
            crate::viewstate::ListState::Rail => mark("RAIL"),
            crate::viewstate::ListState::Hidden => mark("LIST HIDDEN"),
            crate::viewstate::ListState::Full => {}
        }
    }
    if !marks_on.is_empty() {
        items.push((TopItem::Marks, marks_on, true));
    }
    if !app.unread.is_empty() && app.loaded {
        items.push((
            TopItem::Unread,
            vec![Span::styled(format!("{} unread", app.unread.len()), ink())],
            true,
        ));
    }
    items.push((TopItem::Needs, vec![needs], true));
    // Short of room: items are kept highest first (TopItem's order), each only if it still fits, so the lowest go
    // first, and one that fits after a wider one is left out is still shown. " Toolroll", two cells between items.
    let mut room = (area.width as usize).saturating_sub(1 + width("Toolroll") + 1);
    let mut order: Vec<usize> = (0..items.len()).collect();
    order.sort_by_key(|i| std::cmp::Reverse(items[*i].0));
    let mut keep = vec![false; items.len()];
    for i in order {
        let need = sheet::spans_width(&items[i].1) + 2;
        if items[i].0 == TopItem::Needs || need <= room {
            room = room.saturating_sub(need);
            keep[i] = true;
        }
    }
    let items: Vec<_> = items
        .into_iter()
        .zip(keep)
        .filter(|(_, k)| *k)
        .map(|(item, _)| item)
        .collect();
    let mut left = vec![Span::raw(" "), Span::styled("Toolroll", ink())];
    let mut right: Vec<Span<'static>> = vec![];
    for (_, spans, on_right) in items {
        if on_right {
            if !right.is_empty() {
                right.push(Span::raw("  "));
            }
            right.extend(spans);
        } else {
            left.push(Span::raw("  "));
            left.extend(spans);
        }
    }
    let right_w = sheet::spans_width(&right) as u16;
    f.render_widget(Paragraph::new(Line::from(left)), area);
    let r = Rect {
        x: area.right().saturating_sub(right_w + 1),
        width: right_w.min(area.width),
        ..area
    };
    f.render_widget(Paragraph::new(Line::from(right)), r);
}

/// "$1.84 today · plan 62%": what the console says today's work cost and how full the plan is (None: costs hidden,
/// or the console doesn't say).
pub fn cost_line(app: &App) -> Option<String> {
    if !app.prefs.settings.show_costs {
        return None;
    }
    let spend = app.spend.as_ref()?;
    let mut out = format!("${:.2} today", spend.today_usd.max(0.0));
    if let Some(p) = spend.plan_percent {
        out.push_str(&format!(" · plan {}%", p.clamp(0, 100)));
    }
    Some(out)
}

fn draw_list(f: &mut Frame, app: &mut App, area: Rect) {
    app.areas.list = area;
    app.areas.rows.clear();
    let w = area.width as usize;
    let mut lines: Vec<(Line<'static>, Option<usize>)> = vec![];
    // The sheet's head: "Work 5".
    if area.height >= 6 {
        lines.push((
            Line::from(vec![
                Span::styled("Work ", ink()),
                sheet::count(app.items.len(), false),
            ]),
            None,
        ));
        lines.push((Line::raw(""), None));
    }
    // The filter in use, said once at the top (the palette changes it).
    if let Some(words) = app.filter.words() {
        lines.push((
            Line::from(vec![
                Span::styled("Showing: ", dim()),
                Span::styled(fit(&words, w.saturating_sub(9)), ink()),
            ]),
            None,
        ));
        lines.push((Line::raw(""), None));
    }
    if app.loaded && app.items.is_empty() {
        let words = if app.all_items.is_empty() {
            "Nothing yet."
        } else {
            "Nothing here. : changes the filter."
        };
        lines.push((Line::from(Span::styled(words, dim())), None));
    }
    let cols = columns(app);
    let comfortable = app.prefs.settings.density == Density::Comfortable;
    // Each row is a card of two lines (three when comfortable); a blank line between cards when they all fit.
    let per = if comfortable { 3 } else { 2 };
    let sections = {
        let mut v: Vec<Section> = app.items.iter().map(|i| i.section).collect();
        v.dedup();
        v.len()
    };
    let spaced = lines.len() + sections * 3 + app.items.len() * (per + 1) <= area.height as usize;
    let mut last: Option<Section> = None;
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
            // "Needs you 2": the label, then its count (the needs-you count solid).
            lines.push((
                Line::from(vec![
                    Span::styled(item.section.label().to_string(), ink()),
                    sheet::count(count, item.section == Section::NeedsYou),
                ]),
                None,
            ));
            if spaced {
                lines.push((Line::raw(""), None));
            }
            last = Some(item.section);
        } else if spaced {
            lines.push((Line::raw(""), None));
        }
        let here = index == app.selected;
        for l in card_lines(app, item, here, w, &cols, comfortable) {
            lines.push((l, Some(index)));
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

/// A row's mark, its colour and its badge's role (None: the needs-you chip), by section and, for Recent, by how it
/// ended (failed in red, done in green, anything else quiet).
pub fn look_of(item: &Item) -> (&'static str, Style, Option<crate::theme::Role>) {
    use crate::theme::Role;
    let m = marks();
    match item.section {
        Section::NeedsYou => (m.needs, needs_you(), None),
        Section::Working if item.paused => (m.paused, dim(), Some(Role::Fill)),
        Section::Working => (m.running, running(), Some(Role::Running)),
        Section::UpNext => (m.todo, dim(), Some(Role::Fill)),
        Section::Recent if item.tone == "problem" => (m.failed, failed(), Some(Role::Failed)),
        Section::Recent if item.tone == "done" => (m.passed, passed(), Some(Role::Passed)),
        Section::Recent => (m.skipped, dim(), Some(Role::Fill)),
    }
}

/// A row as a card: its mark and title with any columns and its badge on the right, then the project and age (and,
/// comfortable, what it is doing). The selected card is filled across.
fn card_lines(
    app: &App,
    item: &Item,
    here: bool,
    w: usize,
    cols: &[(Column, usize)],
    comfortable: bool,
) -> Vec<Line<'static>> {
    let (mark, mark_style, role) = look_of(item);
    // The step column is the badge; the others sit before it.
    let step = cols.iter().any(|(c, _)| *c == Column::Step);
    let others: Vec<(Column, usize)> = cols
        .iter()
        .copied()
        .filter(|(c, _)| *c != Column::Step)
        .collect();
    let badge = step.then(|| {
        // Room for a word like "Retrying in 2 min" whole.
        let word = fit(&item.word, 18);
        match role {
            None => sheet::chip(&word),
            Some(r) => sheet::badge(&word, r),
        }
    });
    let badge_w = badge.as_ref().map(|b| width(&b.content)).unwrap_or(0);
    // Columns that leave the title too little room are left off, from the right.
    let mut right = cells(app, item, &others).trim_start().to_string();
    while !right.is_empty() && w.saturating_sub(width(&right) + badge_w + 5) < 10 {
        right = match right.rfind("  ") {
            Some(i) => right[..i].trim_end().to_string(),
            None => String::new(),
        };
    }
    // Unread (it changed while you weren't on it): its mark, a space, a dot and a space before the title, in ink.
    let unread = app.unread.contains(&item.id);
    let dot_w = if unread { 2 } else { 0 };
    let right_w = width(&right) + if right.is_empty() { 0 } else { 2 };
    let room = w.saturating_sub(right_w + badge_w + 3 + dot_w);
    let title = fit(&item.title, room);
    let gap = w.saturating_sub(2 + dot_w + width(&title) + right_w + badge_w);
    let title_style = if item.section == Section::NeedsYou || here || unread {
        ink().add_modifier(Modifier::BOLD)
    } else {
        Style::default()
    };
    let mut first = vec![
        Span::styled(mark.to_string(), mark_style),
        Span::styled(if unread { " • " } else { " " }, ink()),
        Span::styled(title, title_style),
        Span::raw(" ".repeat(gap)),
    ];
    if !right.is_empty() {
        first.push(Span::styled(format!("{right}  "), dim()));
    }
    if let Some(b) = badge {
        first.push(b);
    }
    let mut meta: Vec<String> = vec![];
    if let Some(p) = item.project.as_deref().filter(|p| !p.is_empty()) {
        meta.push(clean(p));
    }
    if !item.age.is_empty() {
        meta.push(item.age.clone());
    }
    if meta.is_empty() {
        meta.push(item.detail.clone());
    }
    let mut out = vec![
        Line::from(first),
        Line::from(Span::styled(
            format!("  {}", fit(&meta.join(" · "), w.saturating_sub(2))),
            dim(),
        )),
    ];
    // Waiting to try again: why, and when, wrapped whole under the card.
    if let Some(wait) = &item.waiting {
        for piece in wrap(&waiting_words(wait, app.now), w.saturating_sub(2).max(10)) {
            out.push(Line::from(Span::styled(format!("  {piece}"), dim())));
        }
    }
    if comfortable {
        // Comfortable: a third line with what it is doing, quiet.
        out.push(Line::from(Span::styled(
            format!("  {}", fit(&item.detail, w.saturating_sub(2))),
            dim(),
        )));
    }
    if here {
        let row = if crate::theme::fills() {
            selected()
        } else {
            Style::default()
        };
        out = out.into_iter().map(|l| sheet::band(l, w, row)).collect();
        if !crate::theme::fills() {
            // Without fills the selected card's first line is reversed, as the selected row always was.
            let first = out.remove(0);
            out.insert(0, sheet::band(first, w, selected()));
        }
    }
    out
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

fn draw_right(f: &mut Frame, app: &mut App, area: Rect) {
    app.areas.right = area;
    app.areas.tabs.clear();
    let item = app.selected_item().cloned();
    let w = area.width as usize;
    // The bottom: a question waiting (a card), and the composer (steering, a note, a new task or thread).
    let question = item.as_ref().and_then(|i| i.question()).cloned();
    let roomy = area.height >= 22;
    let q_lines = question
        .as_ref()
        .map(|q| q.options.len().min(9) as u16 + if roomy { 5 } else { 2 })
        .unwrap_or(0);
    let input = matches!(
        app.mode,
        Mode::Steer(_) | Mode::Note(..) | Mode::NewTask(..) | Mode::NewThread(_)
    );
    // The composer stays at the foot of a running build's Live tab, ready for a note; any other time only while typing.
    let live_build = item.as_ref().is_some_and(|i| i.is_task && !i.thread)
        && app.tab == Tab::Live
        && app.steps.as_ref().is_some_and(|s| s.live_run.is_some());
    // (A question waiting takes the foot instead: the composer shows again once it is answered, or while typing.)
    let composer_h = if input || (live_build && roomy && question.is_none()) {
        let rows = if matches!(app.mode, Mode::NewTask(..) | Mode::NewThread(_)) {
            2
        } else {
            1
        };
        if roomy {
            // A gutter row, then the box: its outline and its rows.
            rows + 3
        } else {
            rows
        }
    } else {
        0
    };
    // The head: the tab track, the task with its badge, what runs it, and its step strip (when its steps are read).
    let head_h: u16 = if app.steps.is_some() { 3 } else { 2 } + if roomy { 2 } else { 0 };
    let [tabs, _, head, content, qa, input_row] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(u16::from(roomy)),
        Constraint::Length(head_h),
        Constraint::Min(1),
        Constraint::Length(q_lines),
        Constraint::Length(composer_h),
    ])
    .areas(area);
    app.areas.content = content;
    // The tab track: the tab on screen lit, the others on the fill.
    let mut spans = vec![];
    let mut x = tabs.x;
    let fills = crate::theme::fills();
    for (i, tab) in Tab::ALL.iter().enumerate() {
        let label = tab.label();
        let shown = if fills {
            format!("  {label}  ")
        } else {
            label.to_string()
        };
        if i > 0 && !fills {
            spans.push(Span::styled(" · ", dim()));
            x += 3;
        }
        let style = if *tab == app.tab {
            crate::theme::tab_on()
        } else {
            crate::theme::tab_off()
        };
        let lw = width(&shown) as u16;
        app.areas.tabs.push((x, x + lw, *tab));
        x += lw;
        spans.push(Span::styled(shown, style));
    }
    // Narrow (one column): where this task is in the list, and the way back to it.
    if app.narrow && !app.items.is_empty() {
        let back = key_name(app, Action::ListCycle);
        let at = format!(
            "{} of {}{}",
            app.selected + 1,
            app.items.len(),
            if back.is_empty() {
                String::new()
            } else {
                format!(" · {back} list")
            }
        );
        let used = sheet::spans_width(&spans);
        let room = (tabs.width as usize).saturating_sub(used);
        if room > width(&at) + 1 {
            spans.push(Span::raw(" ".repeat(room - width(&at))));
            spans.push(Span::styled(at, dim()));
        } else if room > 6 {
            // No room for the way back: the position alone.
            let short = format!("{}/{}", app.selected + 1, app.items.len());
            if room > width(&short) + 1 {
                spans.push(Span::raw(" ".repeat(room - width(&short))));
                spans.push(Span::styled(short, dim()));
            }
        }
    }
    f.render_widget(Paragraph::new(Line::from(spans)), tabs);
    // A Flexible thread: its own panel under the tabs (thread.rs).
    if let Some(it) = item.as_ref().filter(|i| i.thread) {
        let rest = Rect {
            y: area.y + 2,
            height: area.height.saturating_sub(2),
            ..area
        };
        crate::thread::draw_panel(f, app, it, rest);
        return;
    }
    let Some(item) = item else {
        // No task yet: the welcome, with the composer at its foot while a new task (or thread) is typed.
        let rest = Rect {
            y: area.y + 2,
            height: area.height.saturating_sub(2 + composer_h),
            ..area
        };
        draw_first_run(f, app, rest);
        if composer_h > 0 {
            draw_composer(f, app, input_row, roomy);
        }
        return;
    };
    // Head: the task (a link to its page in the console, ours: link.rs) and its badge, what's running it, its steps.
    let badge = match look_of(&item).2 {
        None => sheet::chip(&fit(&item.word, 14)),
        Some(role) => sheet::badge(&fit(&item.word, 14), role),
    };
    let badge_w = width(&badge.content);
    let title = fit(&item.title, w.saturating_sub(badge_w + 2));
    if item.is_task {
        if let Some(url) = app
            .origin
            .as_deref()
            .and_then(|o| crate::link::task_url(o, &item.id))
        {
            app.areas.links.push(crate::link::LinkArea {
                x: head.x,
                y: head.y,
                width: (width(&title) as u16).min(head.width),
                url,
            });
        }
    }
    let mut head_lines = vec![Line::from(vec![
        Span::styled(title, ink()),
        Span::raw("  "),
        badge,
    ])];
    match app.steps.as_ref().and_then(|s| facts_line(app, s)) {
        Some(l) => head_lines.push(fit_line(l, w)),
        None => head_lines.push(Line::from(Span::styled(fit(&item.detail, w), dim()))),
    }
    if let Some(steps) = &app.steps {
        if roomy {
            head_lines.push(Line::raw(""));
        }
        head_lines.push(strip(app, steps, w));
    }
    if roomy {
        // A rule under the head, across the sheet (joining the sheet's outline when it has one).
        head_lines.push(Line::from(Span::styled(
            if crate::theme::ruled() {
                format!("├{}┤", "─".repeat(w + 2))
            } else {
                "─".repeat(w + 4)
            },
            line(),
        )));
        let wide = Rect {
            x: head.x.saturating_sub(2),
            width: head.width + 4,
            ..head
        };
        let rule = head_lines.pop().unwrap();
        f.render_widget(Paragraph::new(head_lines), head);
        f.render_widget(
            Paragraph::new(rule),
            Rect {
                y: wide.bottom().saturating_sub(1),
                height: 1,
                ..wide
            },
        );
    } else {
        f.render_widget(Paragraph::new(head_lines), head);
    }
    match app.tab {
        Tab::Live => draw_live(f, app, &item, content),
        Tab::Steps => draw_steps(f, app, content),
        Tab::Diff => draw_diff(f, app, content),
        Tab::Terminal => draw_terminal(f, app, &item, content),
    }
    if let Some(q) = question {
        draw_question(f, app, &q, qa, roomy);
    }
    if composer_h > 0 {
        draw_composer(f, app, input_row, roomy);
    }
}

/// The question waiting, as a card outlined in ink with the needs-you chip: its words, then each answer (the one
/// picked lit). Small windows: the question and the answers only.
fn draw_question(f: &mut Frame, app: &App, q: &toolroll_api::Question, area: Rect, roomy: bool) {
    if area.height == 0 {
        return;
    }
    let inner = if roomy {
        sheet::outline(
            f.buffer_mut(),
            Rect {
                height: area.height.saturating_sub(1),
                ..area
            },
            needs_you(),
        );
        Rect {
            x: area.x + 2,
            y: area.y + 1,
            width: area.width.saturating_sub(4),
            height: area.height.saturating_sub(3),
        }
    } else {
        area
    };
    let w = inner.width as usize;
    let mut lines = vec![];
    if roomy {
        lines.push(Line::from(vec![
            sheet::chip("Needs you"),
            Span::styled("  The agent asks", dim()),
        ]));
    }
    lines.push(Line::from(vec![
        Span::styled("Question: ", ink()),
        Span::styled(fit(&clean(&q.text), w.saturating_sub(10)), ink()),
    ]));
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
        let l = Line::from(Span::styled(
            format!("  {}", fit(&text, w.saturating_sub(2))),
            if chosen {
                Style::default().add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            },
        ));
        lines.push(if chosen {
            sheet::band(l, w, selected())
        } else {
            l
        });
    }
    if roomy {
        let mut hint = vec![sheet::keycap("1-9")];
        hint.push(Span::styled(
            " picks an answer; you see it whole before it's sent",
            dim(),
        ));
        lines.push(Line::from(hint));
    }
    f.render_widget(Paragraph::new(lines), inner);
}

/// The composer at the foot of the panel: what is being typed (steering, a note, a new task or thread) with its caret,
/// or, on a running build, a quiet line saying a note can be sent; the keys on the right. Roomy: a filled box.
fn draw_composer(f: &mut Frame, app: &App, area: Rect, roomy: bool) {
    let inner = if roomy {
        let r = Rect {
            height: area.height.saturating_sub(1),
            y: area.y + 1,
            ..area
        };
        if crate::theme::fills() {
            sheet::paint(f.buffer_mut(), r, base().patch(crate::theme::raised()));
        }
        sheet::outline(f.buffer_mut(), r, line());
        Rect {
            x: r.x + 2,
            y: r.y + 1,
            width: r.width.saturating_sub(4),
            height: r.height.saturating_sub(2),
        }
    } else {
        area
    };
    let rows = if let Mode::NewTask(_, plan) = &app.mode {
        // New task: where it goes, to whom, and how Enter files it, on the line above what's typed.
        let [hint, typed] =
            Layout::vertical([Constraint::Length(1), Constraint::Length(1)]).areas(inner);
        f.render_widget(
            Paragraph::new(new_task_hint(app, *plan, hint.width as usize)),
            hint,
        );
        typed
    } else if matches!(app.mode, Mode::NewThread(_)) {
        // New thread: the same context line, where it runs and which agent.
        let [hint, typed] =
            Layout::vertical([Constraint::Length(1), Constraint::Length(1)]).areas(inner);
        f.render_widget(
            Paragraph::new(new_thread_hint(app, hint.width as usize)),
            hint,
        );
        typed
    } else {
        Rect {
            height: 1.min(inner.height),
            ..inner
        }
    };
    let note_label: String;
    let typing = match &app.mode {
        Mode::Steer(t) => Some(("Steer: ", t)),
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
            Some((note_label.as_str(), t))
        }
        Mode::NewTask(t, _) => Some(("New task: ", t)),
        Mode::NewThread(t) => Some(("New thread: ", t)),
        _ => None,
    };
    // The keys on the right: Enter and Esc while typing; else steer, pause, stop.
    let keys: Vec<Span<'static>> = if typing.is_some() {
        let mut v = vec![sheet::button("Send", marks().enter, true)];
        v.push(Span::raw(" "));
        v.push(sheet::button("Cancel", "Esc", false));
        v
    } else {
        let mut v = vec![];
        for (action, words) in [
            (Action::Steer, "Steer"),
            (Action::Pause, "Pause"),
            (Action::Stop, "Stop"),
        ] {
            let k = key_name(app, action);
            if k.is_empty() {
                continue;
            }
            if !v.is_empty() {
                v.push(Span::raw(" "));
            }
            v.push(sheet::button(words, &k, false));
        }
        v
    };
    let keys_w = sheet::spans_width(&keys);
    let show_keys = rows.width as usize >= keys_w + 24;
    let room_all = (rows.width as usize).saturating_sub(if show_keys { keys_w + 2 } else { 0 });
    let mut spans = vec![];
    match typing {
        Some((label, text)) => {
            // The end of what's typed stays in view.
            let room = room_all.saturating_sub(width(label) + 1);
            let shown: String = {
                let chars: Vec<char> = text.chars().collect();
                let mut used = 0;
                let mut start = chars.len();
                while start > 0 && used + width(&chars[start - 1].to_string()) <= room {
                    start -= 1;
                    used += width(&chars[start].to_string());
                }
                chars[start..].iter().collect()
            };
            spans.push(Span::styled(label.to_string(), ink()));
            spans.push(Span::raw(shown));
            spans.push(Span::styled("▏", ink()));
        }
        None => {
            let run = app
                .steps
                .as_ref()
                .and_then(|s| s.live_run)
                .map(|r| format!(" (it goes to {})", app.attempt_words(r)))
                .unwrap_or_default();
            spans.push(Span::styled(
                fit(&format!("Steer the agent: a note{run}"), room_all),
                dim(),
            ));
        }
    }
    let used = sheet::spans_width(&spans);
    if show_keys {
        spans.push(Span::raw(
            " ".repeat((rows.width as usize).saturating_sub(used + keys_w)),
        ));
        spans.extend(keys);
    }
    f.render_widget(Paragraph::new(Line::from(spans)), rows);
}

/// No task chosen: the first run (no tasks yet) asks what to work on, with the agents on this computer and the
/// engine's own lines (who the first task goes to, or how to sign in to one).
fn draw_first_run(f: &mut Frame, app: &App, area: Rect) {
    let w = (area.width as usize).min(84);
    let x = area.x + (area.width.saturating_sub(w as u16)) / 2;
    let mut lines: Vec<Line<'static>> = vec![];
    if !app.loaded {
        lines.push(Line::from(Span::styled("Reading your tasks…", dim())));
    } else {
        lines.push(Line::from(Span::styled(
            "What would you like to work on?",
            ink(),
        )));
        lines.push(Line::raw(""));
        lines.extend(
            wrap(
                "No tasks yet. Press n and describe a change you want made.",
                w,
            )
            .into_iter()
            .map(|l| Line::from(Span::styled(l, dim()))),
        );
        lines.push(Line::raw(""));
        let new = key_name(app, Action::NewTask);
        let agents_key = key_name(app, Action::Agents);
        let mut acts = vec![];
        if !new.is_empty() {
            acts.push(sheet::button("New task", &new, true));
        }
        if !agents_key.is_empty() {
            if !acts.is_empty() {
                acts.push(Span::raw("  "));
            }
            // The agents below: add one, sign in, choose who builds (agents.rs).
            acts.push(sheet::button("Agents", &agents_key, false));
        }
        if !acts.is_empty() {
            lines.push(Line::from(acts));
            lines.push(Line::raw(""));
        }
        if let Some(agents) = app.agents.as_ref() {
            // The agents read: each one ready, signed in or out (the ones not installed counted).
            let mut row: Vec<Span<'static>> = vec![];
            let mut missing = 0;
            for a in &agents.agents {
                let name = fit(&clean(&a.name), 24);
                let (words, role) = match (a.state.as_str(), a.ready) {
                    ("signed-in", true) => (
                        format!("{} {name} ready", marks().passed),
                        crate::theme::Role::Passed,
                    ),
                    ("signed-in", false) => {
                        (format!("{name} · needs a check"), crate::theme::Role::Fill)
                    }
                    ("signed-out", _) => (format!("{name} · signed out"), crate::theme::Role::Fill),
                    _ => {
                        missing += 1;
                        continue;
                    }
                };
                let b = sheet::badge(&words, role);
                if sheet::spans_width(&row) + width(&b.content) + 1 > w && !row.is_empty() {
                    lines.push(Line::from(std::mem::take(&mut row)));
                }
                if !row.is_empty() {
                    row.push(Span::raw(if crate::theme::fills() { " " } else { "  " }));
                }
                row.push(b);
            }
            if missing > 0 {
                let more = Span::styled(format!("  {missing} more not installed"), dim());
                if sheet::spans_width(&row) + width(&more.content) > w {
                    lines.push(Line::from(std::mem::take(&mut row)));
                }
                row.push(more);
            }
            if !row.is_empty() {
                lines.push(Line::from(row));
                lines.push(Line::raw(""));
            }
            for said in &agents.lines {
                lines.extend(
                    wrap(&clean(said), w)
                        .into_iter()
                        .map(|l| Line::from(Span::styled(l, ink()))),
                );
            }
        }
    }
    let h = lines.len() as u16;
    let y = area.y + (area.height.saturating_sub(h) / 3);
    f.render_widget(
        Paragraph::new(lines),
        Rect {
            x,
            y,
            width: w as u16,
            height: area.bottom().saturating_sub(y),
        },
    );
}

/// New task's line: "In shop · to Claude Code · ⏎ Just code · Tab plan first" (or, with Tab, the other way round).
/// The context line above a new thread's first message: its project and agent, and what Enter does.
fn new_thread_hint(app: &App, w: usize) -> Line<'static> {
    let project = app
        .project
        .as_deref()
        .and_then(|p| std::path::Path::new(p).file_name())
        .map(|n| clean(&n.to_string_lossy()))
        .unwrap_or_else(|| "no project".into());
    let mut spans = vec![Span::styled("In ", dim()), Span::styled(project, ink())];
    if let Some(agent) = app
        .agents
        .as_ref()
        .and_then(|a| a.first_task.as_ref())
        .map(|t| clean(&t.name))
    {
        spans.push(Span::styled(" · with ", dim()));
        spans.push(Span::styled(agent, ink()));
    }
    spans.push(Span::styled(" · ", dim()));
    spans.push(Span::styled(
        format!("{} shows its terms first", marks().enter),
        dim(),
    ));
    fit_line(Line::from(spans), w)
}

fn new_task_hint(app: &App, plan: bool, w: usize) -> Line<'static> {
    let project = app
        .project
        .as_deref()
        .and_then(|p| std::path::Path::new(p).file_name())
        .map(|n| clean(&n.to_string_lossy()))
        .unwrap_or_else(|| "no project".into());
    let agent = app
        .agents
        .as_ref()
        .and_then(|a| a.first_task.as_ref())
        .map(|t| clean(&t.name));
    let enter = marks().enter;
    let mut spans = vec![Span::styled("In ", dim()), Span::styled(project, ink())];
    if let Some(agent) = agent {
        spans.push(Span::styled(" · to ", dim()));
        spans.push(Span::styled(agent, ink()));
    }
    spans.push(Span::styled(" · ", dim()));
    // The long form when it fits, else a shorter one: never cut.
    let long = {
        let mut v = spans.clone();
        if plan {
            v.push(Span::styled(format!("{enter} Plan first"), ink()));
            v.push(Span::styled(" · Tab: Just code", dim()));
        } else {
            v.push(Span::styled(format!("{enter} Just code"), ink()));
            v.push(Span::styled(" · Tab or Shift-", dim()));
            v.push(Span::styled(format!("{enter} Plan first"), dim()));
        }
        v
    };
    if sheet::spans_width(&long) <= w {
        return Line::from(long);
    }
    if plan {
        spans.push(Span::styled(format!("{enter} plan first"), ink()));
        spans.push(Span::styled(" · Tab: just code", dim()));
    } else {
        spans.push(Span::styled(format!("{enter} just code"), ink()));
        spans.push(Span::styled(" · Tab: plan first", dim()));
    }
    fit_line(Line::from(spans), w)
}

/// What Live shows above the agent's output, or instead of it: why a failed task stopped and what the agent said
/// (with a rule under it when output follows), a waiting task's words, or one line saying what there is. The bool: the
/// agent's output follows it. One source for drawing, search and export (search.rs pane_text).
/// How a pane's content is laid out: for the screen (wrapped and cut to its width, with its key hints and rules), or
/// whole for export (no width to cut to, no key hints, no rules). One content, laid out either way: what is drawn,
/// searched and exported can't drift apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Room {
    pub w: usize,
    /// Key hints ("r  Retry") and rules drawn.
    pub hints: bool,
}

/// The width an export is laid out at: wide enough that no line is ever cut.
pub const EXPORT_WIDTH: usize = 10_000;

impl Room {
    /// As drawn, `w` cells wide.
    pub fn screen(w: usize) -> Room {
        Room { w, hints: true }
    }
    /// Whole, for export: no width, no key hints, no rules.
    pub fn export() -> Room {
        Room {
            w: EXPORT_WIDTH,
            hints: false,
        }
    }
    /// Laid out whole (never cut, never padded out to a width).
    pub fn whole(self) -> bool {
        self.w >= EXPORT_WIDTH
    }
}

/// The task's situation now, when it has one: why it failed and how to retry, or that it is on hold, or waiting to try
/// again (why the last build stopped, when the next starts, what the agent said, and its keys). Live puts it above
/// the output, Steps above the steps.
pub fn situation_lines(app: &App, room: Room) -> Vec<Line<'static>> {
    let failed = failure_lines(app, room);
    if !failed.is_empty() {
        return failed;
    }
    waiting_lines(app, room)
}

/// Live's head: the task's situation (situation_lines) when it has one, above its output; else, with no output, what
/// the pane says instead. The bool: the output follows.
pub fn live_head(app: &App, item: &Item, room: Room) -> (Vec<Line<'static>>, bool) {
    let w = room.w;
    let t = &app.transcript;
    let has_output = t.run.is_some() && !(t.main.is_empty() && t.sub.is_empty());
    let situation = situation_lines(app, room);
    if has_output {
        if situation.is_empty() {
            return (vec![], true);
        }
        let mut top = situation;
        if room.hints {
            top.push(Line::from(Span::styled("─".repeat(w), line())));
        }
        return (top, true);
    }
    // Failed, on hold or waiting to try again: never a blank pane.
    if !situation.is_empty() {
        return (situation, false);
    }
    let review = item.need.as_ref().and_then(|n| n.ask.as_deref()) == Some("review");
    let words = if review && app.steps.as_ref().is_some_and(|s| s.review.is_some()) {
        "Ready for you to check. Press Enter for the changes, a to accept, or r to send it back."
            .to_string()
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
    (wrap(&words, w).into_iter().map(Line::raw).collect(), false)
}

fn draw_live(f: &mut Frame, app: &mut App, item: &Item, area: Rect) {
    let w = area.width as usize;
    // Why it stopped and what the agent said first (live_head), the output under it.
    let (head, output) = live_head(app, item, Room::screen(w));
    if !output {
        f.render_widget(Paragraph::new(head), area);
        return;
    }
    let area = if head.is_empty() {
        area
    } else {
        // At most two thirds of the pane (its rule included), so some of the output always shows under it.
        let h = (head.len() as u16)
            .min(area.height * 2 / 3)
            .min(area.height);
        f.render_widget(Paragraph::new(head), Rect { height: h, ..area });
        Rect {
            y: area.y + h,
            height: area.height - h,
            ..area
        }
    };
    let t = &app.transcript;
    // Following the newest: only the tail that fills the pane is laid out (cheap at any length). Scrolled back: the
    // whole transcript, laid out again at most twice a second while records keep arriving.
    let h = area.height as usize;
    let from = if app.follow {
        t.main.len().saturating_sub((h * 3).max(300))
    } else {
        0
    };
    let look = (app.prefs.theme, app.prefs.settings.glyphs);
    let stale = match &app.line_cache {
        Some(c) => {
            c.look != look
                || c.width != w
                || c.from != from
                || (c.version != t.version
                    && (app.follow || c.built.elapsed() > std::time::Duration::from_millis(500)))
        }
        None => true,
    };
    if stale {
        app.line_cache = Some(crate::app::LineCache {
            version: t.version,
            look,
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

/// A step's name as the cards say it: the engine's label, with the reviewing agent when one reviewed ("Review (codex)").
fn step_label(card: &StepCard) -> String {
    let label = clean(&card.label);
    match (&card.agent, card.key.as_str()) {
        (Some(agent), "review") => format!("{label} ({})", clean(&agent.provider)),
        _ => label,
    }
}

/// A step's outcome in a word, in its theme role (DESIGN.md: blue running, green passed, red failed, ink needs you).
fn outcome_of(card: &StepCard) -> (&'static str, Style) {
    match card.mark.as_str() {
        "done" => ("done", passed()),
        "live" => ("running", running()),
        "needs" => ("needs you", needs_you()),
        "stuck" => ("stuck", failed()),
        "skipped" => ("skipped", dim()),
        _ => ("waiting", dim()),
    }
}

/// The Steps tab (T4): one card per step of the task's chain, from the engine's step cards: its mark and name, its
/// outcome, how long it has taken (live while it runs), what it cost, then its sentence and who ran it. The Ready card
/// carries what the result waiting asks (the review facts Accept and Send back are pinned to).
fn draw_steps(f: &mut Frame, app: &App, area: Rect) {
    f.render_widget(
        Paragraph::new(steps_lines(app, Room::screen(area.width as usize))),
        area,
    );
}

/// Everything the Steps tab shows, at width `w`: one source for drawing, search and export (search.rs pane_text).
pub fn steps_lines(app: &App, room: Room) -> Vec<Line<'static>> {
    let w = room.w;
    let Some(steps) = &app.steps else {
        return vec![Line::raw("Reading…")];
    };
    let mut lines = vec![];
    let why = failure_lines(app, room);
    if !why.is_empty() {
        lines.push(Line::from(Span::styled("Failed", crate::theme::failed())));
        lines.extend(why);
        lines.push(Line::raw(""));
    } else if !waiting_lines(app, room).is_empty() {
        lines.extend(waiting_lines(app, room));
        lines.push(Line::raw(""));
    } else if let Some(headline) = &steps.headline {
        for l in wrap(&clean(headline), w) {
            lines.push(Line::from(Span::styled(l, ink())));
        }
        lines.push(Line::raw(""));
    }
    let cards = chain_cards(steps);
    if cards.is_empty() {
        lines.push(Line::from(Span::styled(
            "This task has no steps (it was cancelled, or hasn't started).",
            dim(),
        )));
    }
    // Laid out whole (export): no raised blocks, so nothing is padded out to a width.
    let fills = crate::theme::fills() && !room.whole();
    // Each step a raised block (without fills, its lines with a blank line between).
    let w = if fills { w.saturating_sub(4) } else { w };
    for (i, card) in cards.iter().enumerate() {
        if i > 0 && !fills {
            lines.push(Line::raw(""));
        }
        let mut c: Vec<Line<'static>> = vec![];
        let (mark, mark_style) = mark_of(card);
        let (outcome, outcome_style) = outcome_of(card);
        // A failed task's stuck build failed (never "stuck").
        let outcome =
            if outcome == "stuck" && matches!(steps.task.state.as_str(), "failed" | "cancelled") {
                "failed"
            } else {
                outcome
            };
        // Waiting on a person's hold, or to retry: said so (never "waiting" over "Stopped").
        let wait = build_wait(steps, card);
        let outcome = match wait {
            Some("On hold") => "on hold",
            Some(_) => "waiting to retry",
            None => outcome,
        };
        let mut right = vec![Span::styled(outcome, outcome_style)];
        // The step's current build, on the header's own clock (build_clock).
        if let Some(secs) = build_clock(app, steps, card) {
            right.push(Span::styled(format!(" · {}", duration(secs)), dim()));
        }
        if let Some(cost) = card.cost_usd.filter(|_| app.prefs.settings.show_costs) {
            right.push(Span::styled(format!(" · ${cost:.2}"), dim()));
        }
        let right_w: usize = right.iter().map(|s| width(&s.content)).sum();
        let name_style = if card.needs_you {
            ink().add_modifier(Modifier::BOLD)
        } else {
            ink()
        };
        let name = fit(&step_label(card), w.saturating_sub(right_w + 4).max(4));
        let gap = if room.whole() {
            2
        } else {
            w.saturating_sub(2 + width(&name) + right_w).max(1)
        };
        let mut head = vec![
            Span::styled(format!("{mark} "), mark_style),
            Span::styled(name, name_style),
            Span::raw(" ".repeat(gap)),
        ];
        head.extend(right);
        c.push(fit_line(Line::from(head), w));
        if !card.sentence.is_empty() && wait.is_none() {
            for l in wrap(&clean(&card.sentence), w.saturating_sub(2)) {
                c.push(Line::raw(format!("  {l}")));
            }
        }
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
        // The task's attempt, and the console's own build id beside it (here only: the details).
        if let Some(newest) = card.runs.first() {
            let n = card.runs.len();
            facts.push(if wait.is_some() {
                format!("after attempt {n} (build #{newest})")
            } else {
                format!("attempt {n} (build #{newest})")
            });
        }
        if !facts.is_empty() {
            c.push(fit_line(
                Line::from(Span::styled(format!("  {}", facts.join(" · ")), dim())),
                w,
            ));
        }
        // The result waiting for you: what Accept and Send back act on, said on the Ready card.
        if card.key == "ready" {
            if let Some(review) = &steps.review {
                let who = upper_first(&app.attempt_words(review.run));
                c.push(fit_line(
                    Line::from(if room.hints {
                        vec![
                            Span::styled(format!("  {who} waits for you: "), ink()),
                            Span::styled("a accepts · r sends back · t takes over", dim()),
                        ]
                    } else {
                        vec![Span::styled(format!("  {who} waits for you."), ink())]
                    }),
                    w,
                ));
                for blocker in &review.accept.blockers {
                    for l in wrap(&clean(blocker), w.saturating_sub(4)) {
                        c.push(Line::from(Span::styled(format!("  {l}"), failed())));
                    }
                }
                if let Some(needs) = &review.accept.needs {
                    for l in wrap(&clean(needs), w.saturating_sub(4)) {
                        c.push(Line::from(Span::styled(format!("  {l}"), dim())));
                    }
                }
            }
        }
        if fills {
            let full = w + 4;
            let raised = crate::theme::raised();
            lines.push(sheet::band(Line::raw(""), full, raised));
            for l in c {
                let mut spans = vec![Span::raw("  ")];
                spans.extend(l.spans);
                lines.push(sheet::band(Line::from(spans), full, raised));
            }
            lines.push(sheet::band(Line::raw(""), full, raised));
            lines.push(Line::raw(""));
        } else {
            lines.extend(c);
        }
    }
    if steps.chain == "just-code" {
        lines.push(Line::raw(""));
        lines.push(Line::from(Span::styled(just_code_words(steps), dim())));
    }
    lines
}

/// A "Just code" task's chain in words, saying who gave its yes (it came with the task, so there is no Approval card).
pub fn just_code_words(steps: &StepCards) -> String {
    match &steps.approval {
        Some(a) if a.automatic => "Approved automatically: just code (no plan).".into(),
        Some(a) if a.you => "You approved: just code (no plan).".into(),
        Some(a) => format!("{} approved: just code (no plan).", clean(&a.by)),
        None => "Just code: no plan step.".into(),
    }
}

/// Why a failed task stopped, in one line: the engine's reason, and how many attempts in a row failed.
pub fn failure_words(f: &toolroll_api::Failure) -> String {
    let line = clean(&f.line);
    let line = line.trim_end_matches('.');
    if f.failed_in_a_row > 1 {
        format!("{line} · {} consecutive failures", f.failed_in_a_row)
    } else {
        format!("{line}.")
    }
}

/// A failed task's Live and Steps words: why it stopped, what to change, and how to retry (when it can be).
fn failure_lines(app: &App, room: Room) -> Vec<Line<'static>> {
    let w = room.w;
    let Some(steps) = app.steps_here() else {
        return vec![];
    };
    let Some(failure) = &steps.failure else {
        return vec![];
    };
    // (The head's badge already says Failed.)
    let mut lines = vec![];
    for l in if room.whole() {
        vec![failure_words(failure)]
    } else {
        message_rows(&failure_words(failure), w, 0)
    } {
        lines.push(Line::from(Span::styled(l, ink())));
    }
    if let Some(next) = failure.suggestion.as_deref().and_then(suggestion_words) {
        for l in wrap(&next, w) {
            lines.push(Line::from(Span::styled(l, dim())));
        }
    }
    lines.extend(agent_said_lines(failure.agent_said.as_ref(), room));
    let retry = key_name(app, Action::SendBack);
    if steps.retry.is_some() && !retry.is_empty() {
        if room.hints {
            lines.push(Line::raw(""));
            lines.push(Line::from(sheet::act(&retry, "Retry", true)));
        }
    } else {
        lines.push(Line::raw(""));
        for l in wrap(
            "It can't be retried here as it stands: press w to review it in the browser.",
            w,
        ) {
            lines.push(Line::from(Span::styled(l, dim())));
        }
    }
    lines
}

/// What waiting_lines says: its lines, what the agent said, and the two keys it offers.
type WaitingWords<'a> = (
    Vec<String>,
    Option<&'a Vec<String>>,
    [(Action, &'static str); 2],
);

/// A held or waiting task's Live and Steps words. Held (a person stopped it): "On hold · you stopped retrying", its last
/// failure, and Resume; never a next try. Waiting: why the last build stopped, when the next one starts, what the agent
/// said, and the keys that stop it.
fn waiting_lines(app: &App, room: Room) -> Vec<Line<'static>> {
    let w = room.w;
    let Some(steps) = app.steps_here() else {
        return vec![];
    };
    let (head, said, acts): WaitingWords =
        if let Some(held) = steps.held.as_ref().filter(|_| steps.live_run.is_none()) {
            let who = if held.reason == crate::app::HOLD_REASON {
                "On hold · you stopped retrying".to_string()
            } else {
                format!("On hold · {}", clean(&held.reason))
            };
            let mut head = vec![who];
            if let Some(why) = held.last_failure.as_deref() {
                head.push(format!("Last build failed · {}", clean(why)));
            }
            head.push("Nothing more runs until you resume it.".into());
            (
                head,
                None,
                [
                    (Action::Stop, "Resume retrying"),
                    (Action::CancelTask, "Cancel task"),
                ],
            )
        } else if let Some(wait) = steps.waiting.as_ref() {
            (
                vec![waiting_words(&wait.facts(), app.now)],
                wait.agent_said.as_ref(),
                [
                    (Action::Stop, "Stop retrying"),
                    (Action::CancelTask, "Cancel task"),
                ],
            )
        } else {
            return vec![];
        };
    let mut lines: Vec<Line<'static>> = vec![];
    for (i, h) in head.iter().enumerate() {
        for l in wrap(h, w) {
            lines.push(Line::from(Span::styled(
                l,
                if i == 0 { ink() } else { dim() },
            )));
        }
    }
    lines.extend(agent_said_lines(said, room));
    if !room.hints {
        return lines;
    }
    lines.push(Line::raw(""));
    let mut keys = vec![];
    for (action, words) in acts {
        let k = key_name(app, action);
        if k.is_empty() {
            continue;
        }
        if !keys.is_empty() {
            keys.push(Span::raw("   "));
        }
        keys.extend(sheet::act(&k, words, false));
    }
    if !keys.is_empty() {
        lines.push(Line::from(keys));
    }
    lines
}

/// At most this many of the agent's own last lines are drawn (the engine keeps at most 8).
pub const AGENT_SAID_SHOWN: usize = 8;

/// Maximum drawn rows for one message; exports retain all of its text.
pub const AGENT_SAID_ROWS: usize = 12;

/// "What the agent said": the same wrapped rows for drawing and search, whole for export.
fn agent_said_lines(said: Option<&Vec<String>>, room: Room) -> Vec<Line<'static>> {
    let Some(said) = said.filter(|s| !s.is_empty()) else {
        return vec![];
    };
    let mut lines = vec![
        Line::raw(""),
        Line::from(Span::styled("What the agent said", ink())),
    ];
    let from = if room.whole() {
        0
    } else {
        said.len().saturating_sub(AGENT_SAID_SHOWN)
    };
    let mut rows = vec![];
    for l in &said[from..] {
        let text = clean(l);
        if room.whole() {
            rows.push(format!("  {text}"));
        } else {
            rows.extend(message_rows(&text, room.w, 2));
        }
    }
    if !room.whole() {
        cap_message_rows(&mut rows, room.w);
    }
    lines.extend(rows.into_iter().map(|l| Line::from(Span::styled(l, dim()))));
    lines
}

/// A hanging indent keeps continuations distinct. The ellipsis means the row cap, never the pane edge.
fn message_rows(text: &str, w: usize, indent: usize) -> Vec<String> {
    let indent = indent.min(w.saturating_sub(1));
    let continuation = (indent + 2).min(w.saturating_sub(1));
    let mut rows = wrap(text, w.saturating_sub(continuation));
    cap_message_rows(&mut rows, w.saturating_sub(continuation));
    rows.into_iter()
        .enumerate()
        .map(|(i, l)| {
            format!(
                "{}{l}",
                " ".repeat(if i == 0 { indent } else { continuation })
            )
        })
        .collect()
}

fn cap_message_rows(rows: &mut Vec<String>, w: usize) {
    if rows.len() <= AGENT_SAID_ROWS {
        return;
    }
    rows.truncate(AGENT_SAID_ROWS);
    if let Some(last) = rows.last_mut() {
        *last = fit(&format!("{last}…"), w);
    }
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
    if let Some(problem) = &diff.problem {
        f.render_widget(
            Paragraph::new(
                wrap(&clean(problem), area.width as usize)
                    .into_iter()
                    .map(Line::raw)
                    .collect::<Vec<_>>(),
            ),
            area,
        );
        return;
    }
    let fills = crate::theme::fills();
    // A wide panel keeps a "Changed files" column on the left (unless it would cost side by side its room).
    const FILES_W: u16 = 30;
    let column = area.width >= 110
        && !(app.diff_split
            && area.width >= review::SPLIT_MIN_WIDTH
            && area.width.saturating_sub(FILES_W + 2) < review::SPLIT_MIN_WIDTH);
    // A result waiting for you: the decision row at the foot, outlined in ink, with Accept and Send back.
    let waits = app.steps.as_ref().is_some_and(|s| s.review.is_some()) && area.height >= 16;
    let foot_h: u16 = if waits { 4 } else { 0 };
    let main = Rect {
        height: area.height.saturating_sub(foot_h),
        ..area
    };
    let code_area = if column {
        Rect {
            x: main.x + FILES_W + 2,
            width: main.width.saturating_sub(FILES_W + 2),
            ..main
        }
    } else {
        main
    };
    let w = code_area.width as usize;
    app.set_diff_width(code_area.width);
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
    let n = diff.files.len();
    if column {
        draw_files(
            f,
            app,
            &diff,
            Rect {
                width: FILES_W,
                ..main
            },
        );
    } else {
        // The files: a window of at most five around the one on screen.
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
    }
    if waits {
        draw_decision(
            f,
            app,
            Rect {
                y: main.bottom() + 1,
                height: foot_h - 1,
                ..area
            },
        );
    }
    let area = code_area;
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
        // A changed line's wash behind its whole row (the cursor's row the selection's); none without fills.
        let mut row_bg = Style::default();
        let line = match &app.rows[r] {
            Row::Hunk(h) => {
                let header = clean(&file.file.hunks[*h].header);
                row_bg = crate::theme::raised();
                Line::from(vec![
                    mark,
                    Span::styled(
                        header,
                        if here && !fills {
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
                let line = &code.lines[*c];
                row_bg = match line.kind {
                    Kind::Addition => wash(crate::theme::Role::Passed),
                    Kind::Deletion => wash(crate::theme::Role::Failed),
                    _ => Style::default(),
                };
                spans.extend(code_spans(line, pieces.as_ref(), w >= 60));
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
                            let bg = match line.kind {
                                Kind::Addition => wash(crate::theme::Role::Passed),
                                Kind::Deletion => wash(crate::theme::Role::Failed),
                                _ => Style::default(),
                            };
                            let l = Line::from(half_spans(line, pieces.as_ref(), old));
                            if bg.bg.is_some() {
                                sheet::band(fit_line(l, half), half, bg)
                            } else {
                                l
                            }
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
        let line = fit_line(line, w);
        let line = if here && fills {
            sheet::band(line, w, row_bg.patch(selected()))
        } else if row_bg.bg.is_some() {
            sheet::band(line, w, row_bg)
        } else {
            line
        };
        lines.push(line);
    }
    if end >= total && file.lines_truncated && lines.len() < area.height as usize {
        lines.push(Line::from(Span::styled(
            "The rest of this file is in the browser (w).",
            dim(),
        )));
    }
    f.render_widget(Paragraph::new(lines), area);
}

/// The changed files as a column: each file's name, then its folder and counts, the one on screen lit (a window of
/// them around it when they don't all fit).
fn draw_files(f: &mut Frame, app: &App, diff: &toolroll_api::ResultDiff, area: Rect) {
    let fills = crate::theme::fills();
    if fills {
        sheet::paint(f.buffer_mut(), area, base().patch(crate::theme::raised()));
    } else {
        for y in area.y..area.bottom() {
            f.buffer_mut()[(area.right(), y)]
                .set_symbol("│")
                .set_style(line());
        }
    }
    let inner = Rect {
        x: area.x + 1,
        y: area.y + 1,
        width: area.width.saturating_sub(2),
        height: area.height.saturating_sub(1),
    };
    let w = inner.width as usize;
    let mut lines = vec![
        Line::from(Span::styled(
            "Changed files",
            dim().add_modifier(Modifier::BOLD),
        )),
        Line::raw(""),
    ];
    let n = diff.files.len();
    let fit_n = (inner.height as usize).saturating_sub(3) / 3;
    let shown = fit_n.max(1).min(n);
    let first = app
        .diff_index
        .saturating_sub(shown / 2)
        .min(n.saturating_sub(shown));
    for (i, file) in diff.files.iter().enumerate().skip(first).take(shown) {
        let here = i == app.diff_index;
        let path = clean(&file.path);
        let (dir, name) = match path.rsplit_once('/') {
            Some((d, n)) => (d.to_string(), n.to_string()),
            None => (String::new(), path.clone()),
        };
        let name_style = if here {
            ink().add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        let mut a = Line::from(vec![
            Span::styled(if here { "› " } else { "  " }, ink()),
            Span::styled(fit(&name, w.saturating_sub(2)), name_style),
        ]);
        let mut b = Line::from(vec![
            Span::raw("  "),
            Span::styled(fit(&dir, w.saturating_sub(14)), dim()),
            Span::raw(" "),
            Span::styled(format!("+{}", file.additions), passed()),
            Span::raw(" "),
            Span::styled(format!("−{}", file.deletions), failed()),
            Span::styled(if file.binary { " binary" } else { "" }, dim()),
        ]);
        if here && fills {
            a = sheet::band(a, w, selected());
            b = sheet::band(b, w, selected());
        }
        lines.push(a);
        lines.push(b);
        lines.push(Line::raw(""));
    }
    if n > shown {
        lines.push(Line::from(Span::styled(
            format!("{} files · {{ }} another", n),
            dim(),
        )));
    }
    f.render_widget(Paragraph::new(lines), inner);
}

/// The decision row under a result waiting for you: the needs-you chip, what it is, and its two acts (Accept the one
/// ink verb), all inside an ink outline.
fn draw_decision(f: &mut Frame, app: &App, area: Rect) {
    sheet::outline(f.buffer_mut(), area, needs_you());
    let inner = Rect {
        x: area.x + 2,
        y: area.y + 1,
        width: area.width.saturating_sub(4),
        height: 1,
    };
    let mut acts = vec![];
    let accept = key_name(app, Action::Accept);
    let back = key_name(app, Action::SendBack);
    if !accept.is_empty() {
        acts.push(sheet::button("Accept", &accept, true));
    }
    if !back.is_empty() {
        acts.push(Span::raw(" "));
        acts.push(sheet::button("Send back", &back, false));
    }
    let acts_w = sheet::spans_width(&acts);
    let mut spans = vec![sheet::chip("Needs you"), Span::raw("  ")];
    let room = (inner.width as usize).saturating_sub(acts_w + 14);
    spans.push(Span::styled(fit("Check this result", room), ink()));
    let used = sheet::spans_width(&spans);
    spans.push(Span::raw(
        " ".repeat((inner.width as usize).saturating_sub(used + acts_w)),
    ));
    spans.extend(acts);
    f.render_widget(Paragraph::new(Line::from(spans)), inner);
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
    // With fills the row's wash says added or removed, so the words keep their own colours; without, the words carry
    // it (red removed, green added with no colours to show).
    let fills = crate::theme::fills();
    let base = match line.kind {
        Kind::Deletion if !fills => failed(),
        Kind::Addition
            if !fills && pieces.is_none_or(|p| p.iter().all(|(t, _)| *t == Token::Plain)) =>
        {
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
            // A changed word: reversed; with fills (the row's wash already says added or removed), bold and
            // underlined in its own colour.
            let s = match (changed, fills) {
                (false, _) => style,
                (true, true) => style.add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
                (true, false) => style.add_modifier(Modifier::REVERSED),
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
    // Searching: the query, where it is among the matches, and its keys.
    if let Mode::Search(s) = &app.mode {
        let found = if s.query.is_empty() {
            String::new()
        } else if s.count == 0 {
            "  no match".to_string()
        } else {
            format!("  {} of {}", s.at + 1, s.count)
        };
        let keys = if s.typing {
            "  ⏎ keeps it · Esc leaves"
        } else {
            "  n next · N previous · ⏎ done · Esc leaves"
        };
        let line = Line::from(vec![
            Span::styled("Search: ", ink()),
            Span::raw(fit(&clean(&s.query), 40)),
            Span::styled(if s.typing { "▏" } else { "" }, ink()),
            Span::styled(found, ink()),
            Span::styled(keys, dim()),
        ]);
        f.render_widget(Paragraph::new(fit_line(line, area.width as usize)), area);
        return;
    }
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

/// While typing in the terminal: one way back (Ctrl-] is never remapped).
const TYPING_KEY: (&str, &str) = ("Ctrl-]", "back to the workbench");

/// An action's first key as the key bar and help say it ("⏎" for Enter, with the glyph set's mark).
fn key_name(app: &App, action: Action) -> String {
    let words = app.prefs.settings.keymap.key_words(action);
    if words == "Enter" {
        marks().enter.to_string()
    } else {
        words
    }
}

/// One or two actions' keys as one name: "j/k", "PgUp/PgDn", "{/}".
fn keys_name(app: &App, actions: &[Action]) -> String {
    actions
        .iter()
        .map(|a| key_name(app, *a))
        .filter(|k| !k.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

/// The key bar: the five keys that matter most where the person is, then the palette, which has every other.
fn bar_keys(app: &App) -> Vec<(String, &'static str)> {
    use Action::*;
    if app.agents_screen.is_some() {
        return crate::agents::bar_keys(app);
    }
    // Only the acts this task's state allows: steer while it builds, accept and send back while a result waits,
    // retry once it failed (r, the same key as send back).
    let review = app.review_waiting();
    let retry = !review && app.retry_pins().is_some();
    let live = app.live_run().is_some();
    let waiting = !live && app.queued_here();
    let held = !live && app.held_here().is_some();
    let acts = |v: &mut Vec<(&'static [Action], &'static str)>| {
        if live {
            v.push((&[Steer], "steer"));
        }
        if review {
            v.push((&[Accept], "accept"));
            v.push((&[SendBack], "send back"));
        } else if retry {
            v.push((&[SendBack], "retry"));
        } else if held {
            v.push((&[Stop], "resume"));
        } else if waiting {
            v.push((&[Stop], "stop retrying"));
        }
    };
    let five: Vec<(&[Action], &'static str)> = match app.tab {
        _ if app.items.is_empty() => vec![
            (&[NewTask], "new task"),
            (&[Agents], "agents"),
            (&[Help], "keys"),
        ],
        Tab::Diff if app.thread_selected().is_none() => {
            let mut v: Vec<(&[Action], &str)> =
                vec![(&[LineDown, LineUp], "line"), (&[Note], "note")];
            if review {
                v.push((&[Accept], "accept"));
                v.push((&[SendBack], "send back"));
            }
            v.push((&[PreviousFile, NextFile], "file"));
            v
        }
        Tab::Terminal if app.pane_here().is_some() => vec![
            (&[TakeOver], "Open build shell"),
            (&[ScrollUp, ScrollDown], "scroll"),
            (&[Copy], "copy"),
            (&[MoveDown, MoveUp], "task"),
            (&[NextTab], "next tab"),
        ],
        _ if app.panes.layout.count() > 1 => {
            let mut v: Vec<(&[Action], &str)> = vec![
                (&[MoveDown, MoveUp], "move"),
                (&[NextPane], "next panel"),
                (&[Open], "open"),
            ];
            acts(&mut v);
            v.push((&[NewTask], "new"));
            v
        }
        _ => {
            let mut v: Vec<(&[Action], &str)> =
                vec![(&[MoveDown, MoveUp], "move"), (&[Open], "open")];
            acts(&mut v);
            v.push((&[NewTask], "new"));
            v
        }
    };
    let mut out: Vec<(String, &'static str)> = five
        .into_iter()
        .map(|(a, what)| (keys_name(app, a), what))
        .filter(|(k, _)| !k.is_empty())
        .collect();
    let palette = key_name(app, Palette);
    if !palette.is_empty() {
        out.push((palette, "all actions"));
    }
    out
}

fn draw_keys(f: &mut Frame, app: &App, area: Rect) {
    if app.mode == Mode::TakeOver {
        let line = Line::from(vec![
            sheet::keycap(TYPING_KEY.0),
            Span::styled(format!(" {}", TYPING_KEY.1), dim()),
        ]);
        f.render_widget(Paragraph::new(line), area);
        return;
    }
    let keys = bar_keys(app);
    // Everything that fits, always ending with the palette.
    let render = |set: &[(String, &str)]| -> (Vec<Span<'static>>, usize) {
        let mut spans = vec![];
        let mut w = 0;
        for (i, (k, what)) in set.iter().enumerate() {
            if i > 0 {
                spans.push(Span::raw("  "));
                w += 2;
            }
            let cap = sheet::keycap(k);
            w += width(&cap.content) + 1 + width(what);
            spans.push(cap);
            spans.push(Span::styled(format!(" {what}"), dim()));
        }
        (spans, w)
    };
    let last = keys.len().saturating_sub(1);
    let mut keep = last;
    loop {
        let mut set: Vec<(String, &str)> = keys[..keep.min(last)].to_vec();
        if let Some(l) = keys.get(last) {
            set.push(l.clone());
        }
        let (spans, w) = render(&set);
        if w <= area.width as usize || keep == 0 {
            f.render_widget(Paragraph::new(Line::from(spans)), area);
            return;
        }
        keep -= 1;
    }
}

/// The help overlay's lines, made from the keymap in use (keys.rs help_rows: every action with a key, tui.toml's own
/// included), two columns when the window is wide enough, then the keys no file changes and how to change the rest.
fn help_lines(app: &App, area: Rect) -> Vec<Line<'static>> {
    let map = &app.prefs.settings.keymap;
    let rows = crate::keys::help_rows(map);
    let inner = (area.width as usize).saturating_sub(10).clamp(30, 118);
    let two = inner >= 90;
    let col = if two { (inner - 3) / 2 } else { inner };
    let key_w = 15;
    // One cell: its keys, then its words wrapped under themselves.
    let cell = |keys: &str, words: &str| -> Vec<Line<'static>> {
        let keys = if keys == "Enter" {
            marks().enter.to_string()
        } else {
            keys.to_string()
        };
        wrap(words, col.saturating_sub(key_w).max(8))
            .into_iter()
            .enumerate()
            .map(|(i, piece)| {
                let pad = col.saturating_sub(key_w + width(&piece));
                Line::from(vec![
                    Span::styled(
                        format!(
                            "{:<key_w$}",
                            if i == 0 {
                                fit(&keys, key_w - 1)
                            } else {
                                String::new()
                            }
                        ),
                        ink(),
                    ),
                    Span::raw(piece),
                    Span::raw(" ".repeat(pad)),
                ])
            })
            .collect()
    };
    let columns = |cells: Vec<Vec<Line<'static>>>| -> Vec<Line<'static>> {
        if !two {
            return cells.into_iter().flatten().collect();
        }
        let half = cells.len().div_ceil(2);
        let (left, right) = cells.split_at(half);
        let mut out = vec![];
        for (i, l) in left.iter().enumerate() {
            let r = right.get(i).cloned().unwrap_or_default();
            for j in 0..l.len().max(r.len()) {
                let mut spans = l
                    .get(j)
                    .cloned()
                    .unwrap_or_else(|| Line::raw(" ".repeat(col)))
                    .spans;
                spans.push(Span::raw("   "));
                if let Some(x) = r.get(j) {
                    spans.extend(x.spans.clone());
                }
                out.push(Line::from(spans));
            }
        }
        out
    };
    let mut lines = vec![];
    let global: Vec<Vec<Line<'static>>> = rows
        .iter()
        .filter(|r| r.scope == crate::keys::Scope::Global)
        .map(|r| cell(&r.keys, &r.words))
        .collect();
    lines.extend(columns(global));
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled("In Diff", ink())));
    let diff: Vec<Vec<Line<'static>>> = rows
        .iter()
        .filter(|r| r.scope == crate::keys::Scope::Diff)
        .map(|r| cell(&r.keys, &r.words))
        .collect();
    lines.extend(columns(diff));
    let fixed: Vec<Vec<Line<'static>>> = crate::keys::FIXED_KEYS
        .iter()
        .map(|(k, w)| cell(k, w))
        .collect();
    lines.extend(columns(fixed));
    for l in wrap(
        &format!(
            "Keys: the {} preset. Change any in tui.toml under [keys], e.g. preset = \"vim\" or {} = \"{}\".",
            map.preset.key(),
            crate::keys::HELP_EXAMPLE.0,
            crate::keys::HELP_EXAMPLE.1
        ),
        inner,
    ) {
        lines.push(Line::from(Span::styled(l, dim())));
    }
    lines.push(Line::from(Span::styled(
        "Press s for settings, any other key to close.",
        dim(),
    )));
    lines
}

/// The palette: what is typed, then the matching lines (kind, words, key), the picked one marked.
fn palette_lines(app: &App, area: Rect) -> Vec<Line<'static>> {
    let Mode::Palette(p) = &app.mode else {
        return vec![];
    };
    let w = (area.width as usize).saturating_sub(8).clamp(24, 76);
    let rows = (area.height as usize).saturating_sub(8).clamp(3, 14);
    let found = crate::palette::matches(app, &p.query);
    // The query line is padded to the box's full width: the box keeps one width whatever matches.
    let query = fit(&p.query, w.saturating_sub(4));
    let pad = w.saturating_sub(3 + width(&query));
    let mut lines = vec![Line::from(vec![
        Span::styled(": ", ink()),
        Span::raw(query),
        Span::styled("▏", ink()),
        Span::raw(" ".repeat(pad)),
    ])];
    lines.push(Line::raw(""));
    if found.is_empty() {
        lines.push(Line::from(Span::styled("Nothing matches.", dim())));
    }
    // A window of the matches that keeps the picked one in it.
    let top = p.selected.saturating_sub(rows.saturating_sub(1));
    for (i, e) in found.iter().enumerate().skip(top).take(rows) {
        let here = i == p.selected;
        let kind = format!("{:<10}", e.kind);
        let key = if e.key.is_empty() {
            String::new()
        } else {
            format!(
                "  {}",
                if e.key == "Enter" {
                    marks().enter.to_string()
                } else {
                    e.key.clone()
                }
            )
        };
        let room = w.saturating_sub(10 + width(&key));
        let label = fit(&e.label, room);
        let gap = room.saturating_sub(width(&label));
        let row = if here { selected() } else { Style::default() };
        lines.push(Line::from(vec![
            Span::styled(kind, if here { row } else { dim() }),
            Span::styled(label, row),
            Span::styled(" ".repeat(gap), row),
            Span::styled(key, if here { row } else { ink() }),
        ]));
    }
    if found.len() > rows {
        lines.push(Line::from(Span::styled(
            format!("{} matches · Up and Down move", found.len()),
            dim(),
        )));
    }
    lines.push(Line::raw(""));
    let mut keys = sheet::act(marks().enter, "runs it, as its key would", true);
    keys.push(Span::raw("   "));
    keys.extend(sheet::act("Esc", "closes", false));
    lines.push(Line::from(keys));
    lines
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

/// The dialog over the screen, if any; the frame says it drew exactly this one (App::dialog_key), unless it can't be.
fn draw_overlay(f: &mut Frame, app: &mut App, area: Rect) {
    // Named after it is drawn (drawing a card marks how far it was read); draw_dialog clears the mark when it can't
    // draw the dialog open now.
    app.drawn_dialog = Some(String::new());
    draw_dialog(f, app, area);
    if app.drawn_dialog.is_some() {
        app.drawn_dialog = app.dialog_key();
    }
}

fn draw_dialog(f: &mut Frame, app: &mut App, area: Rect) {
    let (title, lines): (&str, Vec<Line<'static>>) = match &app.mode {
        Mode::Help => (" Keys ", help_lines(app, area)),
        Mode::Palette(_) => (" Commands ", palette_lines(app, area)),
        Mode::Settings => (
            " Settings ",
            app.prefs.screen(
                (area.width as usize).saturating_sub(8).min(88),
                app.settings_row,
            ),
        ),
        Mode::Quit => (
            " Quit Toolroll? ",
            vec![
                Line::raw(""),
                Line::from(sheet::act("s", "Stop agents and quit", false)),
                Line::from(sheet::act(
                    "b",
                    "Keep agents running (reopen with `toolroll`)",
                    false,
                )),
                Line::from(sheet::act("Esc", "Back", false)),
            ],
        ),
        Mode::ConfirmTakeOver { run, .. } => {
            let w = (area.width as usize).saturating_sub(10).clamp(20, 72);
            let mut lines = vec![Line::raw("")];
            lines.extend(
                wrap(&crate::app::take_over_scope(&app.attempt_words(*run)), w)
                    .into_iter()
                    .map(|l| Line::from(Span::styled(l, ink()))),
            );
            lines.push(Line::raw(""));
            let mut keys = sheet::act("t", "to open,", true);
            keys.push(Span::raw("  "));
            keys.extend(sheet::act("Esc", "to cancel", false));
            lines.push(Line::from(keys));
            (" Open build shell ", lines)
        }
        Mode::ConfirmHold { .. } => {
            let w = (area.width as usize).saturating_sub(10).clamp(24, 72);
            let mut lines = vec![
                Line::raw(""),
                Line::from(Span::styled("Stop retrying this task?", ink())),
                Line::raw(""),
            ];
            if let Some(wait) = app.steps_here().and_then(|s| s.waiting.as_ref()) {
                for l in wrap(&waiting_words(&wait.facts(), app.now), w) {
                    lines.push(Line::raw(l));
                }
                lines.push(Line::raw(""));
            }
            for l in wrap(
                "It stays in your list with its branch and workspace; nothing more runs until you resume it.",
                w,
            ) {
                lines.push(Line::raw(l));
            }
            lines.push(Line::raw(""));
            lines.push(Line::from(sheet::act("Enter", "Stop retrying", true)));
            lines.push(Line::from(Span::styled(
                "Any other key changes nothing.",
                dim(),
            )));
            (" Stop retrying ", lines)
        }
        Mode::ConfirmResume { .. } => {
            let w = (area.width as usize).saturating_sub(10).clamp(24, 72);
            let mut lines = vec![
                Line::raw(""),
                Line::from(Span::styled("Resume retrying this task?", ink())),
                Line::raw(""),
            ];
            if let Some(why) = app.held_here().and_then(|h| h.last_failure.as_deref()) {
                for l in wrap(&format!("Last build failed · {}", clean(why)), w) {
                    lines.push(Line::raw(l));
                }
                lines.push(Line::raw(""));
            }
            for l in wrap(
                "Your hold is released: it tries again when a builder is free, on the same branch, under your approval. It may cost again.",
                w,
            ) {
                lines.push(Line::raw(l));
            }
            lines.push(Line::raw(""));
            lines.push(Line::from(sheet::act("Enter", "Resume retrying", true)));
            lines.push(Line::from(Span::styled(
                "Any other key changes nothing.",
                dim(),
            )));
            (" Resume ", lines)
        }
        Mode::ConfirmCancel {
            title, state, run, ..
        } => {
            let w = (area.width as usize).saturating_sub(10).clamp(24, 72);
            let mut lines = vec![Line::raw("")];
            for l in wrap(&format!("Cancel “{}”?", clean(title)), w) {
                lines.push(Line::from(Span::styled(l, ink())));
            }
            lines.push(Line::raw(""));
            // Its real state as the screen shows it, and its current build (the one every surface names).
            let steps = app.steps_here();
            let now_state = match state.as_str() {
                "queued" if steps.is_some_and(|s| s.held.is_some()) => "is on hold".to_string(),
                "queued" if steps.is_some_and(|s| s.waiting.is_some()) => {
                    "is waiting to retry".to_string()
                }
                "running" => "is building".to_string(),
                "failed" => "failed".to_string(),
                other => format!("is {}", clean(other)),
            };
            let shown = match app.current_build().or(*run) {
                Some(r) => format!("It {now_state} · its latest is {}.", app.attempt_words(r)),
                None => format!("It {now_state} · nothing has run yet."),
            };
            lines.push(Line::raw(shown));
            lines.push(Line::raw(""));
            for l in wrap(
                "Nothing else will run for it, and it can't be resumed. If it changes before Toolroll gets this, nothing is cancelled.",
                w,
            ) {
                lines.push(Line::raw(l));
            }
            lines.push(Line::raw(""));
            lines.push(Line::from(sheet::act("Enter", "Cancel task", true)));
            lines.push(Line::from(Span::styled(
                "Any other key changes nothing.",
                dim(),
            )));
            (" Cancel task ", lines)
        }
        Mode::ConfirmRetry { run, .. } => {
            let w = (area.width as usize).saturating_sub(10).clamp(24, 76);
            // The console's build ids count across every task: what is said is the attempt it follows, on this task.
            let after = app.current_build().unwrap_or(*run);
            let mut lines = vec![
                Line::raw(""),
                Line::from(Span::styled(
                    format!(
                        "Retry: starts a new attempt after {}.",
                        app.attempt_words(after)
                    ),
                    ink(),
                )),
                Line::raw(""),
            ];
            if let Some(failure) = app.steps_here().and_then(|s| s.failure.as_ref()) {
                for l in wrap(&failure_words(failure), w) {
                    lines.push(Line::raw(l));
                }
                if let Some(next) = failure.suggestion.as_deref().and_then(suggestion_words) {
                    for l in wrap(&next, w) {
                        lines.push(Line::from(Span::styled(l, dim())));
                    }
                }
                lines.push(Line::raw(""));
            }
            // "Repeated failures" only when there were (2 or more in a row): one failure is just a failure.
            let repeated = app
                .steps_here()
                .and_then(|s| s.failure.as_ref())
                .is_some_and(|f| f.failed_in_a_row >= 2);
            for l in wrap(
                if repeated {
                    "It clears the repeated failures and starts again under your approval, keeping the branch and workspace. It may cost again."
                } else {
                    "It starts again under your approval, keeping the branch and workspace. It may cost again."
                },
                w,
            ) {
                lines.push(Line::raw(l));
            }
            lines.push(Line::raw(""));
            lines.push(Line::from(sheet::act("Enter", "Retry it", true)));
            lines.push(Line::from(Span::styled("Any other key cancels.", dim())));
            (" Retry ", lines)
        }
        Mode::ConfirmStop(run) => (
            " Stop ",
            vec![
                Line::raw(""),
                Line::from(Span::styled(
                    format!("Stop {}?", app.attempt_words(*run)),
                    ink(),
                )),
                Line::raw(""),
                Line::from(sheet::act("y", "Stop it", true)),
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
                app.drawn_dialog = None;
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
            lines.push(Line::from(sheet::act("Enter", "Send this answer", true)));
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
        Mode::ConfirmInstall { .. }
        | Mode::PickModel(_)
        | Mode::ConfirmModels(_)
        | Mode::ConfirmSignInAgain { .. } => match crate::agents::dialog_lines(app, area) {
            Some(shown) => shown,
            None => return,
        },
        Mode::StartThread(_) => return crate::thread::draw_start(f, app, area),
        Mode::ConfirmThread(_) => match crate::thread::confirm_lines(app, area) {
            Some(shown) => shown,
            None => return,
        },
        Mode::ConfirmAccept(pin) => {
            // What is shown is the pinned result: the same facts the act posts, and what accepting means.
            let pin = pin.clone();
            let facts = facts_of(app);
            let w = (area.width as usize).saturating_sub(8).min(84);
            let notes = app.notes_of(&pin.task, pin.run);
            let label = |l: &str| Span::styled(format!("{l:<10}"), dim());
            let run = pin.run;
            // (scripts/tui-e2e.mjs waits for exactly this heading; src/tui-e2e-env.test.ts holds the two together.)
            let mut lines = vec![
                Line::raw(""),
                Line::from(Span::styled(
                    format!("Accept the result of {}?", app.attempt_words(run)),
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
            lines.push(Line::from(sheet::act(
                "Enter",
                if app.accept_attach {
                    "Accept with the notes"
                } else {
                    "Accept"
                },
                true,
            )));
            if !notes.is_empty() {
                lines.push(Line::from(sheet::act(
                    "t",
                    if app.accept_attach {
                        "Don't attach the notes"
                    } else {
                        "Attach the notes"
                    },
                    false,
                )));
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
            let attempt = app.attempt_words(pin.run);
            let head = if notes.is_empty() {
                format!("Send back {attempt}, saying what to change:")
            } else {
                format!("Send back {attempt} with:")
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
            let mut keys = sheet::act("Enter", "Read it all, then send", true);
            keys.push(Span::raw("   "));
            keys.extend(sheet::act("Esc", "Keep the notes", false));
            lines.push(Line::from(keys));
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
    let r = centered(area, w + 2, lines.len() as u16 + 2);
    let block = dialog(f, r, title);
    f.render_widget(Paragraph::new(lines).block(block), r);
}

/// A dialog's sheet over the screen: what is behind it fades (the scrim), and the dialog is paper with a rounded
/// outline and its title in it.
pub fn dialog(f: &mut Frame, r: Rect, title: &str) -> Block<'static> {
    sheet::scrim(f.buffer_mut());
    f.render_widget(Clear, r);
    Block::bordered()
        .border_type(BorderType::Rounded)
        .style(base().patch(crate::theme::raised()))
        .border_style(dim())
        .padding(Padding::horizontal(1))
        .title(Span::styled(title.to_string(), ink()))
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
    let w = area.width.saturating_sub(4).min(98);
    let h = area.height.saturating_sub(2);
    // Inside the border and its padding.
    let inner_w = w.saturating_sub(4) as usize;
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
    let block = dialog(f, r, " New task ");
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
    let unfold = app.build_unfold;
    for (label, words) in terms.iter() {
        let mut first = true;
        // The Usual row is its summary line, then each setting on its own line: folded to the summary, with how to
        // see them all (the summary is the engine's own words for them).
        let parts: Vec<&str> = words.split('\n').collect();
        let folded = label == "Usual" && parts.len() > 1 && !unfold;
        let shown: Vec<String> = if folded {
            vec![
                parts[0].to_string(),
                format!("f shows all {} settings", parts.len() - 1),
            ]
        } else {
            parts.iter().map(|p| p.to_string()).collect()
        };
        for (pi, part) in shown.iter().enumerate() {
            let hint = folded && pi == 1;
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
                    if hint {
                        Span::styled(piece, dim())
                    } else {
                        Span::raw(piece)
                    },
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
        lines.push(Line::from(sheet::act("Enter", "Build", true)));
    } else {
        lines.push(Line::from(Span::styled(
            "Enter builds once you've read to the end.",
            dim(),
        )));
    }
    let mut keys = sheet::act("p", "Plan it first", false);
    keys.push(Span::raw("   "));
    keys.extend(sheet::act("w", "Review in the browser", false));
    lines.push(Line::from(keys));
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
    let w = area.width.saturating_sub(4).min(98);
    let h = area.height.saturating_sub(2);
    // Inside the border and its padding.
    let inner_w = w.saturating_sub(4) as usize;
    let visible = (h as usize).saturating_sub(2 + 6);
    let r = Rect {
        x: area.x + (area.width.saturating_sub(w)) / 2,
        y: area.y + 1,
        width: w,
        height: h,
    };
    let block = dialog(f, r, " Send back ");
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
        lines.push(Line::from(sheet::act("Enter", "Send back", true)));
    } else {
        lines.push(Line::from(Span::styled(
            "Enter sends once you've read to the end.",
            dim(),
        )));
    }
    lines.push(Line::from(sheet::act(
        "Esc",
        "Back to your words (nothing is sent)",
        false,
    )));
    f.render_widget(Paragraph::new(lines).block(block), r);
}

/// The Terminal tab (T4, take over): the task's terminal drawn from its emulator's cells (term.rs), under one line that
/// says which build it is on and what the keys do; or, before one is open, how to open it.
fn draw_terminal(f: &mut Frame, app: &mut App, item: &Item, area: Rect) {
    let w = area.width as usize;
    let typing = app.mode == Mode::TakeOver;
    // Its attempt on this task, named before the pane is borrowed.
    let attempt = app
        .term
        .as_ref()
        .map(|p| app.attempt_words(p.run))
        .unwrap_or_default();
    let Some(pane) = app.term.as_mut().filter(|p| p.task == item.id) else {
        let words = if item.is_task {
            "Open build shell: a real terminal in a separate copy of this task's latest build. Press t to open it; Ctrl-] comes back here, and the terminal keeps running in Toolroll."
        } else {
            "This isn't a task. Press w to open it in the browser."
        };
        let lines: Vec<Line> = wrap(words, w)
            .into_iter()
            .map(|l| Line::from(Span::styled(l, dim())))
            .collect();
        f.render_widget(Paragraph::new(lines), area);
        return;
    };
    let [head, _, frame] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(u16::from(area.height >= 12)),
        Constraint::Min(1),
    ])
    .areas(area);
    let fills = crate::theme::fills();
    let (state, style) = match &pane.link {
        crate::term::Link::Opening => ("Opening…".to_string(), dim()),
        crate::term::Link::Attaching => ("Attaching…".to_string(), dim()),
        // The way back is on the key bar; said here only when the key bar is off.
        crate::term::Link::Live if typing && app.prefs.settings.key_bar => {
            ("Typing".to_string(), ink().patch(crate::theme::fill()))
        }
        crate::term::Link::Live if typing => (
            "Typing · Ctrl-] goes back".to_string(),
            ink().patch(crate::theme::fill()),
        ),
        crate::term::Link::Live if app.prefs.settings.key_bar => (
            "Running".to_string(),
            crate::theme::badge(crate::theme::Role::Running),
        ),
        crate::term::Link::Live => (
            "Running · t to type".to_string(),
            crate::theme::badge(crate::theme::Role::Running),
        ),
        crate::term::Link::Ended { code, signal } => (
            match (code, signal) {
                (Some(c), _) => format!("Ended (exit {c}) · t opens a new one"),
                (None, Some(s)) => format!("Ended (signal {s}) · t opens a new one"),
                _ => "Ended · t opens a new one".to_string(),
            },
            dim(),
        ),
        crate::term::Link::Closed(words) => (clean(words), dim()),
    };
    // Said plainly: a separate copy at that build, on its own branch.
    let place = if pane.branch.is_empty() {
        format!("separate copy at {attempt}")
    } else {
        format!("separate copy at {attempt} on {}", pane.branch)
    };
    // What it's doing first (and how far back it's scrolled); where it is after, cut first when the pane is narrow.
    let state = if fills && style.bg.is_some() {
        format!(" {state} ")
    } else {
        state
    };
    let mut spans = vec![Span::styled(state, style)];
    if pane.scroll > 0 {
        spans.push(Span::styled(
            format!(" · {} lines back, End returns", pane.scroll),
            dim(),
        ));
    }
    if !matches!(
        pane.link,
        crate::term::Link::Closed(_) | crate::term::Link::Opening
    ) {
        spans.push(Span::styled(format!(" · {place}"), dim()));
    }
    f.render_widget(Paragraph::new(fit_line(Line::from(spans), w)), head);
    // The terminal sits in its own window: a rounded outline, the ground behind its cells.
    let inset = if fills { ground() } else { base() };
    sheet::paint(f.buffer_mut(), frame, inset);
    sheet::outline(f.buffer_mut(), frame, line().patch(inset));
    let body = Rect {
        x: frame.x + 1,
        y: frame.y + 1,
        width: frame.width.saturating_sub(2),
        height: frame.height.saturating_sub(2),
    };
    pane.area = body;
    if matches!(pane.link, crate::term::Link::Opening) {
        return;
    }
    crate::term::draw(f.buffer_mut(), body, pane.parser.screen(), inset);
    pane.drawn = body.width > 0 && body.height > 0;
    if typing {
        if let Some((x, y)) = pane.cursor() {
            f.set_cursor_position((x, y));
        }
    }
}
