//! Split layouts: two to four live panels side by side, each pinned to its own task.
//!
//! One panel is focused: it is the workbench's own panel (tabs, acts, the Diff and Terminal tabs) and follows the
//! list's selection. Every other panel is a watch: pinned to the task it showed when focus left it, it reads that
//! task's step cards and the tail of its live output, and takes no keys at all. Moving focus (o / O, or a click) pins
//! the panel left behind and makes the next one the workbench's, so keys only ever reach the focused panel; the
//! Terminal tab's rule from T4 holds as before (only a drawn, focused terminal takes input).
use crate::app::{App, Effect, Section, Transcript, RECORDS_KEPT};
use crate::text::{clean, fit};
use crate::theme::{dim, ink, line, needs_you};
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;
use toolroll_api::{LiveSessionWindow, StepCards, Window};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layout {
    Focused,
    SideBySide,
    Grid,
}

impl Layout {
    pub const ALL: [Layout; 3] = [Layout::Focused, Layout::SideBySide, Layout::Grid];
    pub fn count(self) -> usize {
        match self {
            Layout::Focused => 1,
            Layout::SideBySide => 2,
            Layout::Grid => 4,
        }
    }
    pub fn key(self) -> &'static str {
        match self {
            Layout::Focused => "focused",
            Layout::SideBySide => "side-by-side",
            Layout::Grid => "grid",
        }
    }
    pub fn from_key(key: &str) -> Option<Layout> {
        Layout::ALL.into_iter().find(|l| l.key() == key)
    }
    pub fn words(self) -> &'static str {
        match self {
            Layout::Focused => "Focused: one panel.",
            Layout::SideBySide => "Side by side: two panels. o moves between them.",
            Layout::Grid => "A grid of four panels. o moves between them.",
        }
    }
    fn next(self) -> Layout {
        match self {
            Layout::Focused => Layout::SideBySide,
            Layout::SideBySide => Layout::Grid,
            Layout::Grid => Layout::Focused,
        }
    }
}

/// A panel that isn't focused: the task it is pinned to, its step cards and its live output's tail.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Watch {
    pub task: String,
    pub steps: Option<StepCards>,
    pub transcript: Transcript,
    pub fetching: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Panes {
    pub layout: Layout,
    /// The focused panel's place (its slot holds None: it is the workbench's own).
    pub focus: usize,
    pub slots: Vec<Option<Watch>>,
    /// Where each panel was drawn last frame (for the mouse).
    pub areas: Vec<Rect>,
}

impl Default for Panes {
    fn default() -> Panes {
        Panes {
            layout: Layout::Focused,
            focus: 0,
            slots: vec![None],
            areas: vec![],
        }
    }
}

impl Panes {
    pub fn watches(&self) -> impl Iterator<Item = &Watch> {
        self.slots.iter().flatten()
    }
}

/// The build a task's steps name for its live output: the live build, else the newest build.
pub fn run_of(steps: &StepCards) -> Option<i64> {
    steps.live_run.or_else(|| {
        steps
            .cards
            .as_ref()?
            .iter()
            .filter(|c| c.key == "build")
            .flat_map(|c| c.runs.first().copied())
            .next()
    })
}

/// The panels' places in the area given: one, two side by side, or a grid of four (rows first), with a one-cell rule
/// between them (drawn by `draw_rules`).
pub fn places(layout: Layout, area: Rect) -> Vec<Rect> {
    let half_w = area.width.saturating_sub(1) / 2;
    let half_h = area.height.saturating_sub(1) / 2;
    let left = |y: u16, h: u16| Rect {
        x: area.x,
        y,
        width: half_w,
        height: h,
    };
    let right = |y: u16, h: u16| Rect {
        x: area.x + half_w + 1,
        y,
        width: area.width.saturating_sub(half_w + 1),
        height: h,
    };
    match layout {
        Layout::Focused => vec![area],
        Layout::SideBySide => vec![left(area.y, area.height), right(area.y, area.height)],
        Layout::Grid => {
            let bottom_y = area.y + half_h + 1;
            let bottom_h = area.height.saturating_sub(half_h + 1);
            vec![
                left(area.y, half_h),
                right(area.y, half_h),
                left(bottom_y, bottom_h),
                right(bottom_y, bottom_h),
            ]
        }
    }
}

/// The rules between panels, in the line colour.
pub fn draw_rules(f: &mut Frame, layout: Layout, area: Rect) {
    if layout == Layout::Focused || area.width < 3 {
        return;
    }
    let x = area.x + area.width.saturating_sub(1) / 2;
    for y in area.y..area.y + area.height {
        f.buffer_mut()[(x, y)].set_symbol("│").set_style(line());
    }
    if layout == Layout::Grid && area.height >= 3 {
        let y = area.y + area.height.saturating_sub(1) / 2;
        for x2 in area.x..area.x + area.width {
            let sym = if x2 == x { "┼" } else { "─" };
            f.buffer_mut()[(x2, y)].set_symbol(sym).set_style(line());
        }
    }
}

impl App {
    /// The rooms that say when a watched panel's task changed.
    pub fn watch_rooms(&self) -> Vec<String> {
        let mut rooms = vec![];
        for w in self.panes.watches() {
            if let Some(steps) = &w.steps {
                rooms.push(steps.room.clone());
            }
            if let Some(run) = w.transcript.run {
                rooms.push(format!("agent:{run}"));
            }
        }
        rooms
    }

    /// The next layout (focused → side by side → grid of four → focused).
    pub fn next_layout(&mut self) -> Vec<Effect> {
        let next = self.panes.layout.next();
        self.set_layout(next)
    }

    /// Change the layout: panels already pinned stay pinned (as many as fit); new ones are pinned to tasks not yet on
    /// screen, the working ones first, then what needs you, then what finished today.
    pub fn set_layout(&mut self, layout: Layout) -> Vec<Effect> {
        let count = layout.count();
        let mut kept: Vec<Watch> = self.panes.slots.drain(..).flatten().collect();
        let focus = self.panes.focus.min(count - 1);
        kept.truncate(count - 1);
        let mut shown: Vec<String> = kept.iter().map(|w| w.task.clone()).collect();
        if let Some(id) = self.selected_item().map(|i| i.id.clone()) {
            shown.push(id);
        }
        let rank = |s: Section| match s {
            Section::Working => 0,
            Section::NeedsYou => 1,
            Section::DoneToday => 2,
        };
        let mut candidates: Vec<&crate::app::Item> = self
            .items
            .iter()
            .filter(|i| i.is_task && !i.thread && !shown.contains(&i.id))
            .collect();
        candidates.sort_by_key(|i| rank(i.section));
        let mut fresh: Vec<String> = candidates
            .into_iter()
            .map(|i| i.id.clone())
            .take((count - 1).saturating_sub(kept.len()))
            .collect();
        let mut fx = vec![];
        let mut slots: Vec<Option<Watch>> = vec![];
        for place in 0..count {
            if place == focus {
                slots.push(None);
            } else if !kept.is_empty() {
                slots.push(Some(kept.remove(0)));
            } else if !fresh.is_empty() {
                let task = fresh.remove(0);
                fx.push(Effect::FetchSteps(task.clone()));
                slots.push(Some(Watch {
                    task,
                    ..Watch::default()
                }));
            } else {
                slots.push(None);
            }
        }
        self.panes = Panes {
            layout,
            focus,
            slots,
            areas: vec![],
        };
        self.line_cache = None;
        self.say(crate::app::Tone::Said, layout.words());
        fx.push(Effect::Watch(self.rooms()));
        fx
    }

    /// Move focus to another panel (`by` places on, wrapping): the panel left behind is pinned to its task, and the
    /// one moved to becomes the workbench's own, showing its pinned task (an empty one keeps the selection).
    pub fn move_focus(&mut self, by: i64) -> Vec<Effect> {
        let count = self.panes.layout.count();
        if count < 2 {
            self.say(
                crate::app::Tone::Said,
                "One panel only: L (or the palette) splits the screen.",
            );
            return vec![];
        }
        let to = (self.panes.focus as i64 + by).rem_euclid(count as i64) as usize;
        self.focus_pane(to)
    }

    pub fn focus_pane(&mut self, to: usize) -> Vec<Effect> {
        if to == self.panes.focus || to >= self.panes.slots.len() {
            return vec![];
        }
        // Where the panel moved to points, before anything moves: a pinned task that is no longer listed empties it.
        let target = self.panes.slots[to].as_ref().map(|w| w.task.clone());
        let index = target
            .as_ref()
            .and_then(|t| self.items.iter().position(|i| &i.id == t));
        let left = self
            .selected_item()
            .filter(|i| i.is_task && !i.thread)
            .map(|i| Watch {
                task: i.id.clone(),
                steps: self.steps.clone(),
                transcript: self.transcript.clone(),
                fetching: false,
            });
        let from = self.panes.focus;
        self.panes.slots[from] = left;
        self.panes.slots[to] = None;
        self.panes.focus = to;
        self.line_cache = None;
        let mut fx = match (target, index) {
            (Some(_), Some(i)) if i != self.selected => {
                self.selected = i;
                self.selection_changed()
            }
            (Some(_), None) => {
                self.say(
                    crate::app::Tone::Said,
                    "That panel's task isn't listed now, so it shows the selected one.",
                );
                vec![]
            }
            _ => vec![],
        };
        fx.push(Effect::Watch(self.rooms()));
        fx
    }

    /// Step cards for a watched panel's task: kept, and its live output read from the start when its build changed.
    pub fn watch_steps(&mut self, task: &str, steps: &StepCards) -> Vec<Effect> {
        let mut fx = vec![];
        for w in self.panes.slots.iter_mut().flatten() {
            if w.task != task {
                continue;
            }
            let run = run_of(steps);
            w.steps = Some(steps.clone());
            if w.transcript.run != run {
                w.transcript = Transcript {
                    run,
                    ..Transcript::default()
                };
                w.fetching = false;
                if let Some(run) = run {
                    w.fetching = true;
                    fx.push(Effect::FetchLive {
                        run,
                        file: "main",
                        cursor: None,
                    });
                }
            }
        }
        fx
    }

    /// A live window for a watched panel's build: appended (a restart clears first), read on while there is more.
    pub fn watch_live(&mut self, run: i64, window: &LiveSessionWindow) -> Vec<Effect> {
        let mut fx = vec![];
        for w in self.panes.slots.iter_mut().flatten() {
            if w.transcript.run != Some(run) {
                continue;
            }
            w.fetching = false;
            w.transcript.live = window.live;
            match &window.window {
                Window::Missing(m) => {
                    w.transcript.missing = Some(if m.reason == "off" {
                        "This build runs on another computer; its output is there.".into()
                    } else {
                        "No output yet.".into()
                    });
                    w.transcript.version += 1;
                }
                Window::Read(read) => {
                    if read.restarted {
                        w.transcript.main.clear();
                    }
                    if read.restarted || !read.records.is_empty() {
                        w.transcript.main.extend(read.records.iter().cloned());
                        if w.transcript.main.len() > RECORDS_KEPT {
                            let drop = w.transcript.main.len() - RECORDS_KEPT;
                            w.transcript.main.drain(..drop);
                        }
                        w.transcript.missing = None;
                        w.transcript.version += 1;
                    }
                    w.transcript.cursor_main = Some(read.cursor.clone());
                    if read.more {
                        w.fetching = true;
                        fx.push(Effect::FetchLive {
                            run,
                            file: "main",
                            cursor: Some(read.cursor.clone()),
                        });
                    }
                }
            }
        }
        fx
    }

    /// Read on in every watched panel's live build (one read at a time each); a finished one is read no more.
    pub fn poll_watches(&mut self) -> Vec<Effect> {
        let mut fx = vec![];
        for w in self.panes.slots.iter_mut().flatten() {
            let Some(run) = w.transcript.run else {
                continue;
            };
            if w.fetching || (!w.transcript.live && w.transcript.cursor_main.is_some()) {
                continue;
            }
            w.fetching = true;
            fx.push(Effect::FetchLive {
                run,
                file: "main",
                cursor: w.transcript.cursor_main.clone(),
            });
        }
        fx
    }

    /// A watched task's room changed: its steps again.
    pub fn watch_changed(&self, room: &str) -> Vec<Effect> {
        self.panes
            .watches()
            .filter(|w| w.steps.as_ref().is_some_and(|s| s.room == room))
            .map(|w| Effect::FetchSteps(w.task.clone()))
            .collect()
    }
}

/// A watched panel: its task's title, its step strip, and the tail of its live output. It takes no keys.
pub fn draw_watch(f: &mut Frame, app: &App, slot: usize, area: Rect) {
    if area.height == 0 || area.width == 0 {
        return;
    }
    let w = area.width as usize;
    let Some(watch) = app.panes.slots.get(slot).and_then(|s| s.as_ref()) else {
        let words = if w >= 24 {
            "Empty panel. Press o to move here, then pick a task."
        } else {
            "Empty panel."
        };
        let lines: Vec<Line> = crate::text::wrap(words, w)
            .into_iter()
            .map(|l| Line::from(Span::styled(l, dim())))
            .collect();
        f.render_widget(Paragraph::new(lines), area);
        return;
    };
    let item = app.all_items.iter().find(|i| i.id == watch.task);
    let title = item
        .map(|i| i.title.clone())
        .or_else(|| watch.steps.as_ref().map(|s| clean(&s.task.title)))
        .unwrap_or_else(|| watch.task.clone());
    let waits = item.is_some_and(|i| i.section == Section::NeedsYou);
    // The first row, level with the focused panel's tabs: what this panel is.
    let mut lines = vec![
        Line::from(Span::styled(fit("Pinned · Live", w), dim())),
        Line::from(Span::styled(
            fit(&title, w),
            if waits { needs_you() } else { ink() },
        )),
    ];
    match &watch.steps {
        Some(steps) => lines.push(crate::view::strip(app, steps, w)),
        None => lines.push(Line::from(Span::styled("Reading…", dim()))),
    }
    let h = (area.height as usize).saturating_sub(lines.len());
    let t = &watch.transcript;
    if t.main.is_empty() {
        let words = match (&t.missing, t.run, item.map(|i| i.detail.as_str())) {
            (Some(m), _, _) => m.clone(),
            (None, Some(_), _) => "No output yet.".into(),
            (None, None, Some(d)) if !d.is_empty() => d.to_string(),
            _ => "Nothing is building on this task.".into(),
        };
        lines.extend(
            crate::text::wrap(&words, w)
                .into_iter()
                .map(|l| Line::from(Span::styled(l, dim()))),
        );
    } else if h > 0 {
        let from = t.main.len().saturating_sub((h * 3).max(60));
        let body = crate::transcript::lines(t, w, from);
        let start = body.len().saturating_sub(h);
        lines.extend(body[start..].iter().cloned());
    }
    f.render_widget(Paragraph::new(lines), area);
}
