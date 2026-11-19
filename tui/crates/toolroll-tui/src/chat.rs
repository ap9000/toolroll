//! Central Lead chat in the terminal workbench (Slices 2 & 3):
//!
//! Renders the person's central Lead conversation (`GET /engine/chat`, the exact same source of truth as `/chat` in the
//! browser), streams live `event: turn` snapshots from `GET /live?room=chat`, displays structured `ChatCard` blocks
//! (facts, tables, notes, charts) and confirmable `Proposal` cards, and lets task links jump the Peek inspector
//! straight to that task's `Diff` / `Steps` / `Live` panel.
use crate::app::{App, Mode};
use crate::sheet;
use crate::text::{clean, fit, width, wrap};
use crate::theme::{dim, failed, ink, line, marks, passed, running, selected, Role};
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;
use toolroll_api::{ChatCard, ChatCardBlock, LeadCard, LeadCardPrimary, LeadChat, LiveTurn};

/// Which side holds keyboard focus when Lead Chat and a Peeked Task are docked side by side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ChatFocus {
    #[default]
    Chat,
    Peek,
}

/// An interactive element inside the Lead Chat stream (selected with `[` / `]`, activated with `Enter` or mouse click).
#[derive(Debug, Clone, PartialEq)]
pub enum ChatHit {
    ConfirmProposal(i64),
    DismissProposal(i64),
    PeekTask {
        task: String,
        tab: Option<String>,
        label: String,
    },
    AnswerAsk(String),
    RemoveQueued(i64),
}

/// Pinned state for `Mode::ConfirmProposal`: every line shown to the person is frozen at open time, and a live refresh
/// that changes or removes the proposal closes the dialog rather than confirming something unseen.
#[derive(Debug, Clone, PartialEq)]
pub struct ProposalPin {
    pub id: i64,
    pub kind: String,
    pub label: String,
    pub action_label: String,
    pub lines: Vec<String>,
    pub irreversible: bool,
    pub armed: bool,
    pub scroll: usize,
    pub seen_end: bool,
}

/// State of the central Lead chat panel.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LeadChatState {
    pub data: Option<LeadChat>,
    pub loaded: bool,
    pub loading: bool,
    pub error: Option<String>,
    /// Live streaming turn snapshot received on `GET /live?room=chat` (`event: turn`).
    pub live_turn: Option<LiveTurn>,
    /// Scroll offset from top (lines). When `follow` is true, viewport stays pinned to the bottom.
    pub scroll: usize,
    pub follow: bool,
    pub total_lines: usize,
    pub view_height: usize,
    /// Whether tool-step summaries inside assistant messages and live turns are expanded.
    pub tools_expanded: bool,
    /// Index into the current list of selectable `ChatHit` items (defaults to the newest actionable item).
    pub selected_hit: usize,
    /// True while a `POST /chat` request is in flight.
    pub sending: bool,
    /// Persistent composer draft (preserved when leaving typing mode to inspect tasks or scroll).
    pub draft: String,
    /// Optimistically displayed operator message immediately after hitting Enter, cleared once synced from server.
    pub optimistic_sent: Option<String>,
    pub last_submission: Option<String>,
    pub seen_provider_issue: Option<(String, Option<i64>, Option<i64>, String)>,
    pub checking_providers: bool,
    pub switching_provider: bool,
    pub checked_providers: Option<toolroll_api::AgentsRead>,
    pub provider_problem: Option<String>,
    /// Clickable hitboxes captured during the last draw.
    pub hits: Vec<(Rect, ChatHit)>,
    /// Ordered selectable items from the latest state (kept in sync with `data`).
    pub items: Vec<ChatHit>,
    /// Clickable composer strip at the bottom of the Lead Chat sheet.
    pub composer_area: Rect,
}

impl LeadChatState {
    pub fn new() -> Self {
        Self {
            follow: true,
            ..Self::default()
        }
    }

    pub fn lead_name(&self) -> String {
        self.data
            .as_ref()
            .map(|d| clean(&d.lead_name))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Lead".into())
    }

    pub fn room(&self) -> String {
        self.data
            .as_ref()
            .map(|d| d.room.clone())
            .unwrap_or_else(|| "chat".into())
    }

    pub fn is_busy(&self) -> bool {
        self.data.as_ref().is_some_and(|d| d.busy)
            || self
                .live_turn
                .as_ref()
                .is_some_and(|t| !t.done && !t.is_idle())
    }

    pub fn pending_proposals(&self) -> i64 {
        self.data.as_ref().map(|d| d.pending_proposals).unwrap_or(0)
    }

    pub fn apply_data(&mut self, chat: LeadChat) {
        let was_empty = self.data.is_none();
        if !chat.busy && self.live_turn.as_ref().is_some_and(|t| t.done || t.is_idle()) {
            self.live_turn = None;
        }
        if let Some(opt) = &self.optimistic_sent {
            if chat
                .messages
                .iter()
                .rev()
                .take(4)
                .any(|m| m.role == "operator" && m.text.trim() == opt.trim())
                || chat.queued.iter().any(|q| q.text.trim() == opt.trim())
            {
                self.optimistic_sent = None;
            }
        }
        self.data = Some(chat);
        self.loaded = true;
        self.loading = false;
        self.error = None;
        self.rebuild_items(was_empty);
    }

    pub fn apply_turn(&mut self, turn: LiveTurn) {
        if turn.is_idle() {
            self.live_turn = None;
            return;
        }
        self.live_turn = Some(turn);
        if self.follow {
            self.scroll = usize::MAX;
        }
    }

    pub fn rebuild_items(&mut self, select_latest: bool) {
        let prev = self.items.get(self.selected_hit).cloned();
        let mut items = Vec::new();
        if let Some(chat) = &self.data {
            for msg in &chat.messages {
                for card in &msg.cards {
                    if !card.data && card.state == "pending" {
                        if let Some(LeadCardPrimary::Confirm { .. }) = &card.primary {
                            items.push(ChatHit::ConfirmProposal(card.id));
                        } else if let Some(LeadCardPrimary::Link {
                            label, task, tab, ..
                        }) = &card.primary
                        {
                            if let Some(task) = task {
                                items.push(ChatHit::PeekTask {
                                    task: task.clone(),
                                    tab: tab.clone(),
                                    label: label.clone(),
                                });
                            }
                        }
                    }
                    for link in &card.links {
                        if let Some(task) = &link.task {
                            let hit = ChatHit::PeekTask {
                                task: task.clone(),
                                tab: link.tab.clone(),
                                label: link.label.clone(),
                            };
                            if !items.contains(&hit) {
                                items.push(hit);
                            }
                        }
                    }
                }
                if let Some(ask) = &msg.ask {
                    if ask.open && !ask.stale {
                        for opt in &ask.options {
                            items.push(ChatHit::AnswerAsk(opt.clone()));
                        }
                    }
                }
            }
            for q in &chat.queued {
                if q.status == "queued" {
                    items.push(ChatHit::RemoveQueued(q.id));
                }
            }
            if chat.messages.is_empty() && chat.can_send {
                for (_, prompt) in STARTER_PROMPTS {
                    items.push(ChatHit::AnswerAsk((*prompt).to_string()));
                }
            }
        }
        self.items = items;
        if self.items.is_empty() {
            self.selected_hit = 0;
        } else if !select_latest {
            if let Some(prev) = prev {
                if let Some(idx) = self.items.iter().position(|x| x == &prev) {
                    self.selected_hit = idx;
                    return;
                }
            }
            self.selected_hit = self.selected_hit.min(self.items.len() - 1);
        } else {
            // Default to the latest pending proposal if any, else the latest interactive item.
            if let Some(idx) = self
                .items
                .iter()
                .rposition(|h| matches!(h, ChatHit::ConfirmProposal(_)))
            {
                self.selected_hit = idx;
            } else {
                self.selected_hit = self.items.len() - 1;
            }
        }
    }

    pub fn current_hit(&self) -> Option<&ChatHit> {
        self.items.get(self.selected_hit)
    }

    pub fn select_next_hit(&mut self) {
        if !self.items.is_empty() {
            self.selected_hit = (self.selected_hit + 1) % self.items.len();
        }
    }

    pub fn select_prev_hit(&mut self) {
        if !self.items.is_empty() {
            self.selected_hit = if self.selected_hit == 0 {
                self.items.len() - 1
            } else {
                self.selected_hit - 1
            };
        }
    }

    pub fn scroll_up(&mut self, n: usize) {
        self.follow = false;
        self.scroll = self.scroll.saturating_sub(n);
    }

    pub fn scroll_down(&mut self, n: usize) {
        let max = self.total_lines.saturating_sub(self.view_height);
        self.scroll = self.scroll.saturating_add(n).min(max);
        if self.scroll >= max {
            self.follow = true;
        }
    }

    pub fn follow_end(&mut self) {
        self.follow = true;
        self.scroll = self.total_lines.saturating_sub(self.view_height);
    }

    pub fn find_proposal(&self, id: i64) -> Option<&LeadCard> {
        self.data.as_ref()?.messages.iter().find_map(|m| {
            m.cards
                .iter()
                .find(|c| c.id == id && !c.data && c.state == "pending")
        })
    }

    pub fn pin_proposal(&self, id: i64) -> Option<ProposalPin> {
        let card = self.find_proposal(id)?;
        let LeadCardPrimary::Confirm {
            label,
            irreversible,
            ..
        } = card.primary.as_ref()?
        else {
            return None;
        };
        Some(ProposalPin {
            id: card.id,
            kind: card.kind.clone(),
            label: clean(&card.label),
            action_label: clean(label),
            lines: card.lines.iter().map(|l| clean(l)).collect(),
            irreversible: *irreversible,
            armed: !*irreversible,
            scroll: 0,
            seen_end: false,
        })
    }
}

/// One rendered line in the Lead Chat stream, optionally associated with a clickable hit.
struct ChatRow {
    line: Line<'static>,
    hit: Option<ChatHit>,
}

impl ChatRow {
    fn plain(line: Line<'static>) -> Self {
        Self { line, hit: None }
    }
    fn clickable(line: Line<'static>, hit: ChatHit) -> Self {
        Self {
            line,
            hit: Some(hit),
        }
    }
}

/// Quick-start prompts offered in an empty Lead conversation (matching `/chat` starters).
const STARTER_PROMPTS: &[(&str, &str)] = &[
    (
        "Brief me on what needs attention",
        "Brief me on what needs my attention, what is building, and the highest-leverage next action across every project.",
    ),
    (
        "Walk me through open decisions",
        "Walk me through the open decisions, their options, and what you recommend I inspect first.",
    ),
    (
        "Help me start a new task",
        "Help me define a new task. Ask only about choices that materially change the result; otherwise use your judgment and sensible reversible defaults.",
    ),
];

/// Render the central Lead chat sheet into `area`.
pub fn draw(f: &mut Frame, app: &mut App, area: Rect, docked: bool) {
    if area.width < 12 || area.height < 8 {
        return;
    }
    app.chat.hits.clear();
    let w = usize::from(area.width);
    let m = marks();
    let typing = matches!(app.mode, Mode::ChatCompose(_));
    let active_hit = if typing { None } else { app.chat.current_hit().cloned() };

    // ---- Header (2 rows) ----
    let lead_name = app.chat.lead_name();
    let mut head_spans: Vec<Span<'static>> = vec![Span::styled(
        format!("◆ {lead_name}"),
        ink().add_modifier(Modifier::BOLD),
    )];
    if let Some(proj) = app
        .chat
        .data
        .as_ref()
        .and_then(|d| d.project.as_deref())
        .map(clean)
        .filter(|s| !s.is_empty())
    {
        head_spans.push(Span::styled("  ", dim()));
        head_spans.push(sheet::badge(&proj, Role::Fill));
    }
    head_spans.push(Span::styled("  ", dim()));
    if app.chat.is_busy() {
        let status = app
            .chat
            .live_turn
            .as_ref()
            .filter(|t| !t.done && !t.is_idle() && !t.status.trim().is_empty())
            .map(|t| clean(&t.status))
            .unwrap_or_else(|| "Working…".into());
        let mark = crate::view::live_mark(app);
        head_spans.push(sheet::badge(&format!("{mark} {status}"), Role::Running));
    } else {
        let pending = app.chat.pending_proposals();
        if pending > 0 {
            head_spans.push(sheet::chip(&format!("{} {pending} waiting", m.needs)));
        } else if app.chat.loaded {
            head_spans.push(Span::styled("Synced · /chat", dim()));
        } else if app.chat.loading {
            head_spans.push(Span::styled("Loading…", dim()));
        }
    }
    let providers = sheet::button("Providers", "F2", false);
    let header_w = w.saturating_sub(providers.width() + 1);
    let header = crate::view::fit_line(Line::from(head_spans), header_w);
    let mut head_spans = header.spans;
    let x = area.x + area.width.saturating_sub(providers.width() as u16);
    app.areas.lead_providers_button = Rect::new(x, area.y, (area.right()-x).min(providers.width() as u16), 1);
    if docked {
        head_spans.push(Span::styled("  ", dim()));
        head_spans.push(sheet::badge("DOCKED", Role::Fill));
    }
    f.render_widget(
        Paragraph::new(Line::from(head_spans)),
        Rect { height: 1, ..area },
    );

    f.render_widget(Paragraph::new(Line::from(providers)), app.areas.lead_providers_button);

    let rule_y = area.y + 1;
    f.render_widget(
        Paragraph::new(Line::from(Span::styled("─".repeat(w), line()))),
        Rect {
            y: rule_y,
            height: 1,
            ..area
        },
    );
    let draft_text: &str = match &app.mode {
        Mode::ChatCompose(s) => s.as_str(),
        _ => app.chat.draft.as_str(),
    };
    let box_inner_w = w.saturating_sub(6).max(10);
    let wrapped_draft = wrap_draft_lines(draft_text, box_inner_w);
    let visible_draft_lines = wrapped_draft.len().clamp(1, 4) as u16;
    let composer_h = (visible_draft_lines + 2).min(area.height.saturating_sub(4)).max(3);
    let stream_y = rule_y + 1;
    let stream_h = area.height.saturating_sub(2 + composer_h);
    let stream_area = Rect {
        x: area.x,
        y: stream_y,
        width: area.width,
        height: stream_h,
    };
    let composer_area = Rect {
        x: area.x,
        y: stream_y + stream_h,
        width: area.width,
        height: composer_h,
    };
    app.chat.composer_area = composer_area;

    // ---- Build stream rows ----
    let mut rows: Vec<ChatRow> = Vec::new();
    let tools_expanded = app.chat.tools_expanded;
    if let Some(err) = &app.chat.error {
        rows.push(ChatRow::plain(Line::from(Span::styled(
            fit(&clean(err), w),
            failed(),
        ))));
    } else if let Some(chat) = app.chat.data.clone() {
        if let Some(prob) = &chat.problem {
            for l in wrap(&clean(prob), w.saturating_sub(2).max(10)) {
                rows.push(ChatRow::plain(Line::from(Span::styled(l, failed()))));
            }
            rows.push(ChatRow::plain(Line::raw("")));
        }
        if chat.messages.is_empty()
            && app.chat.optimistic_sent.is_none()
            && app.chat.live_turn.as_ref().is_none_or(|t| t.done || t.is_idle())
        {
            rows.push(ChatRow::plain(Line::raw("")));
            rows.push(ChatRow::plain(Line::from(Span::styled(
                format!("◆ {lead_name} — central agent across all projects"),
                ink().add_modifier(Modifier::BOLD),
            ))));
            rows.push(ChatRow::plain(Line::from(Span::styled(
                fit(
                    "Ask about any task, review diffs, file new work, or steer running builds.",
                    w,
                ),
                dim(),
            ))));
            rows.push(ChatRow::plain(Line::raw("")));
            if chat.can_send {
                rows.push(ChatRow::plain(Line::from(Span::styled(
                    "Try asking:",
                    dim(),
                ))));
                for (label, prompt) in STARTER_PROMPTS {
                    let hit = ChatHit::AnswerAsk((*prompt).to_string());
                    let is_sel = active_hit.as_ref() == Some(&hit);
                    rows.push(ChatRow::clickable(
                        Line::from(Span::styled(
                            fit(&format!("  [→ {label}]"), w),
                            if is_sel { selected() } else { running() },
                        )),
                        hit,
                    ));
                }
            }
        }
        for msg in &chat.messages {
            if msg.role == "operator" {
                let text = clean(&msg.text);
                for (i, wrapped) in wrap(&text, w.saturating_sub(2).max(10))
                    .into_iter()
                    .enumerate()
                {
                    let prefix = if i == 0 { "› " } else { "  " };
                    rows.push(ChatRow::plain(Line::from(vec![
                        Span::styled(prefix, dim()),
                        Span::styled(wrapped, ink().add_modifier(Modifier::BOLD)),
                    ])));
                }
                rows.push(ChatRow::plain(Line::raw("")));
                continue;
            }
            // Assistant reply
            if let Some(act) = msg.activity.as_deref().map(clean).filter(|s| !s.is_empty()) {
                let tri = if tools_expanded { "▾" } else { "▸" };
                rows.push(ChatRow::plain(Line::from(Span::styled(
                    fit(&format!("{tri} Worked · {act}"), w),
                    dim(),
                ))));
            }
            for para in msg.text.split('\n') {
                let cleaned = clean(para);
                if cleaned.trim().is_empty() {
                    continue;
                }
                for l in wrap(&cleaned, w.max(10)) {
                    rows.push(ChatRow::plain(Line::from(Span::styled(l, ink()))));
                }
            }
            for card in &msg.cards {
                push_card(&mut rows, card, w, active_hit.as_ref());
            }
            if let Some(ask) = &msg.ask {
                rows.push(ChatRow::plain(Line::from(Span::styled(
                    fit(&clean(&ask.question), w),
                    ink().add_modifier(Modifier::BOLD),
                ))));
                if ask.stale {
                    rows.push(ChatRow::plain(Line::from(Span::styled(
                        "Out of date: the task moved after this was asked.",
                        dim(),
                    ))));
                } else if ask.open {
                    for opt in &ask.options {
                        let hit = ChatHit::AnswerAsk(opt.clone());
                        let is_sel = active_hit.as_ref() == Some(&hit);
                        let style = if is_sel { selected() } else { ink() };
                        rows.push(ChatRow::clickable(
                            Line::from(Span::styled(
                                fit(&format!("  [→ {}]", clean(opt)), w),
                                style,
                            )),
                            hit,
                        ));
                    }
                }
            }
            rows.push(ChatRow::plain(Line::raw("")));
        }
        // Optimistic sent message immediately shown until server echoes it in GET /engine/chat
        if let Some(opt) = app.chat.optimistic_sent.clone() {
            let text = clean(&opt);
            for (i, wrapped) in wrap(&text, w.saturating_sub(2).max(10))
                .into_iter()
                .enumerate()
            {
                let prefix = if i == 0 { "› " } else { "  " };
                rows.push(ChatRow::plain(Line::from(vec![
                    Span::styled(prefix, dim()),
                    Span::styled(wrapped, ink().add_modifier(Modifier::BOLD)),
                ])));
            }
            rows.push(ChatRow::plain(Line::raw("")));
        }
        // Live streaming turn at bottom (only when genuinely active, never for `state: "idle"`)
        if let Some(turn) = app.chat.live_turn.clone().filter(|t| !t.done && !t.is_idle()) {
            push_live_turn(&mut rows, app, &turn, w);
            rows.push(ChatRow::plain(Line::raw("")));
        } else if chat.busy {
            let mark = crate::view::live_mark(app);
            rows.push(ChatRow::plain(Line::from(vec![
                Span::styled(format!("{mark} "), running()),
                Span::styled("Thinking…", running()),
            ])));
            rows.push(ChatRow::plain(Line::raw("")));
        }
        // Queued follow-up messages
        for q in &chat.queued {
            let text = clean(&q.text);
            let status_word = match q.status.as_str() {
                "queued" => "Queued",
                "starting" => "Starting",
                "uncertain" => "Not confirmed",
                _ => "Not sent",
            };
            let hit = (q.status == "queued").then_some(ChatHit::RemoveQueued(q.id));
            let is_sel = hit.is_some() && active_hit.as_ref() == hit.as_ref();
            let line_text = if q.status == "queued" {
                format!("{status_word}: {text}  [Remove]")
            } else {
                format!(
                    "{status_word}: {text}{}",
                    q.detail
                        .as_deref()
                        .map(|d| format!(" · {}", clean(d)))
                        .unwrap_or_default()
                )
            };
            let style = if is_sel { selected() } else { dim() };
            let line_obj = Line::from(Span::styled(fit(&line_text, w), style));
            if let Some(h) = hit {
                rows.push(ChatRow::clickable(line_obj, h));
            } else {
                rows.push(ChatRow::plain(line_obj));
            }
        }
    } else {
        rows.push(ChatRow::plain(Line::from(Span::styled(
            if app.chat.loading {
                "Loading central Lead conversation…"
            } else {
                "Press C to load the central Lead conversation."
            },
            dim(),
        ))));
    }

    // ---- Scroll & render visible stream ----
    let view_h = usize::from(stream_area.height);
    app.chat.total_lines = rows.len();
    app.chat.view_height = view_h;
    let max_scroll = rows.len().saturating_sub(view_h);
    if app.chat.follow {
        app.chat.scroll = max_scroll;
    } else {
        app.chat.scroll = app.chat.scroll.min(max_scroll);
    }
    let start = app.chat.scroll;
    let visible: Vec<Line<'static>> = rows
        .iter()
        .skip(start)
        .take(view_h)
        .enumerate()
        .map(|(i, row)| {
            if let Some(hit) = &row.hit {
                app.chat.hits.push((
                    Rect {
                        x: stream_area.x,
                        y: stream_area.y + i as u16,
                        width: stream_area.width,
                        height: 1,
                    },
                    hit.clone(),
                ));
            }
            row.line.clone()
        })
        .collect();
    f.render_widget(Paragraph::new(visible), stream_area);

    // ---- Real Rounded Bordered Chatbox ----
    draw_chatbox(f, app, composer_area, &lead_name, typing, &wrapped_draft);
}

fn wrap_draft_lines(draft: &str, max_w: usize) -> Vec<String> {
    if draft.is_empty() {
        return vec![String::new()];
    }
    let mut out = Vec::new();
    for raw in draft.split('\n') {
        let cleaned = clean(raw);
        if cleaned.is_empty() {
            out.push(String::new());
        } else {
            out.extend(wrap(&cleaned, max_w));
        }
    }
    if out.is_empty() {
        out.push(String::new());
    }
    out
}

fn draw_chatbox(
    f: &mut Frame,
    app: &mut App,
    area: Rect,
    lead_name: &str,
    typing: bool,
    wrapped: &[String],
) {
    if area.width < 10 || area.height < 3 {
        return;
    }
    let w = usize::from(area.width);
    let inner_w = w.saturating_sub(2);
    let border_style = if typing {
        ink().add_modifier(Modifier::BOLD)
    } else {
        line()
    };
    let can_send = app.chat.data.as_ref().is_none_or(|d| d.can_send);
    let busy = app.chat.is_busy();

    // Top border: ╭─ Message Lead ───────────────────────╮
    let title = if !can_send {
        " Read-only ".to_string()
    } else {
        format!(" Message {lead_name} ")
    };
    let title_fit = fit(&title, inner_w.saturating_sub(2));
    let top_fill = inner_w.saturating_sub(1 + width(&title_fit));
    let top = Line::from(vec![
        Span::styled("╭─", border_style),
        Span::styled(
            title_fit,
            if typing {
                ink().add_modifier(Modifier::BOLD)
            } else {
                dim()
            },
        ),
        Span::styled(format!("{}╮", "─".repeat(top_fill)), border_style),
    ]);

    // Body rows (1..=4 lines)
    let body_h = usize::from(area.height.saturating_sub(2)).max(1);
    let skip = wrapped.len().saturating_sub(body_h);
    let shown = &wrapped[skip..];
    let has_text = !(wrapped.len() == 1 && wrapped[0].is_empty());

    let mut box_lines: Vec<Line<'static>> = Vec::with_capacity(usize::from(area.height));
    box_lines.push(top);

    for row in 0..body_h {
        let is_first = row == 0 && skip == 0;
        let is_last = row + 1 == shown.len();
        let prompt = if is_first { " › " } else { "   " };
        let text_w = inner_w.saturating_sub(4);
        if !has_text && row == 0 {
            let placeholder = if app.chat.sending {
                "Sending to Lead…"
            } else if !can_send {
                "Start a Lead session in the browser"
            } else if busy {
                "Lead is working — type to queue a follow-up…"
            } else {
                "Ask Lead anything across all projects…"
            };
            let shown_p = fit(placeholder, text_w.saturating_sub(usize::from(typing)));
            let cursor_w = usize::from(typing);
            let pad = text_w.saturating_sub(width(&shown_p) + cursor_w);
            let mut spans = vec![
                Span::styled("│", border_style),
                Span::styled(
                    prompt,
                    if typing {
                        ink().add_modifier(Modifier::BOLD)
                    } else {
                        dim()
                    },
                ),
            ];
            if typing {
                spans.push(Span::styled("▏", ink()));
            }
            spans.push(Span::styled(shown_p, dim()));
            spans.push(Span::styled(format!("{} ", " ".repeat(pad)), dim()));
            spans.push(Span::styled("│", border_style));
            box_lines.push(Line::from(spans));
        } else if let Some(line_str) = shown.get(row) {
            let cursor_w = usize::from(typing && is_last);
            let fit_s = fit(line_str, text_w.saturating_sub(cursor_w));
            let pad = text_w.saturating_sub(width(&fit_s) + cursor_w);
            let mut spans = vec![
                Span::styled("│", border_style),
                Span::styled(
                    prompt,
                    if typing {
                        ink().add_modifier(Modifier::BOLD)
                    } else {
                        dim()
                    },
                ),
                Span::styled(fit_s, ink()),
            ];
            if typing && is_last {
                spans.push(Span::styled("▏", ink()));
            }
            spans.push(Span::styled(format!("{} ", " ".repeat(pad)), dim()));
            spans.push(Span::styled("│", border_style));
            box_lines.push(Line::from(spans));
        } else {
            box_lines.push(Line::from(vec![
                Span::styled("│", border_style),
                Span::raw(" ".repeat(inner_w)),
                Span::styled("│", border_style),
            ]));
        }
    }

    let can_submit = can_send && !app.chat.sending && !app.chat.draft.trim().is_empty();
    let bottom = if can_submit {
        let label = if busy { " Queue " } else { " Send " };
        let fill = inner_w - width(label) - 1;
        app.areas.lead_send = Rect::new(area.x + 1 + fill as u16, area.bottom() - 1, width(label) as u16, 1);
        Line::from(vec![
            Span::styled(format!("╰{}", "─".repeat(fill)), border_style),
            Span::styled(label, selected()),
            Span::styled("─╯", border_style),
        ])
    } else {
        Line::from(Span::styled(format!("╰{}╯", "─".repeat(inner_w)), border_style))
    };
    box_lines.push(bottom);

    f.render_widget(Paragraph::new(box_lines), area);
}

fn push_live_turn(rows: &mut Vec<ChatRow>, app: &App, turn: &LiveTurn, w: usize) {
    let mark = crate::view::live_mark(app);
    let status = if turn.status.trim().is_empty() {
        "Thinking…".to_string()
    } else {
        clean(&turn.status)
    };
    rows.push(ChatRow::plain(Line::from(vec![
        Span::styled(format!("{mark} "), running()),
        Span::styled(fit(&status, w.saturating_sub(2)), running()),
    ])));
    let tool_count: usize = turn
        .steps
        .iter()
        .map(|s| s.tool_calls.len().max(s.tools.len()))
        .sum();
    if tool_count > 0 {
        let tri = if app.chat.tools_expanded { "▾" } else { "▸" };
        let noun = if tool_count == 1 {
            "tool step"
        } else {
            "tool steps"
        };
        rows.push(ChatRow::plain(Line::from(Span::styled(
            format!("  {tri} {tool_count} {noun} (e to toggle)"),
            dim(),
        ))));
        if app.chat.tools_expanded {
            let m = marks();
            for step in &turn.steps {
                if !step.tool_calls.is_empty() {
                    for tc in &step.tool_calls {
                        let (sym, st) = match tc.state.as_str() {
                            "ok" | "done" => (m.passed, passed()),
                            "error" | "failed" => (m.failed, failed()),
                            _ => (mark, running()),
                        };
                        let sum = tc
                            .summary
                            .as_deref()
                            .map(|s| format!(" · {}", clean(s)))
                            .unwrap_or_default();
                        rows.push(ChatRow::plain(Line::from(vec![
                            Span::styled(format!("    {sym} "), st),
                            Span::styled(
                                fit(&format!("{}{sum}", clean(&tc.label)), w.saturating_sub(6)),
                                dim(),
                            ),
                        ])));
                    }
                } else {
                    for label in &step.tools {
                        rows.push(ChatRow::plain(Line::from(Span::styled(
                            fit(&format!("    · {}", clean(label)), w),
                            dim(),
                        ))));
                    }
                }
            }
        }
    }
    if !turn.text.trim().is_empty() {
        for para in turn.text.split('\n') {
            let cleaned = clean(para);
            if cleaned.trim().is_empty() {
                continue;
            }
            for l in wrap(&cleaned, w.max(10)) {
                rows.push(ChatRow::plain(Line::from(Span::styled(l, ink()))));
            }
        }
    }
}

fn push_card(rows: &mut Vec<ChatRow>, card: &LeadCard, w: usize, active_hit: Option<&ChatHit>) {
    let m = marks();
    let inner_w = w.saturating_sub(3).max(12);
    // Data card (Toolroll ChatCard)
    if card.data {
        rows.push(ChatRow::plain(Line::from(vec![
            Span::styled("│ ", line()),
            Span::styled(
                fit(&clean(&card.label), inner_w),
                ink().add_modifier(Modifier::BOLD),
            ),
        ])));
        if let Some(structured) = &card.card {
            push_chat_card_blocks(rows, structured, inner_w);
        } else {
            for l in &card.lines {
                for wl in wrap(&clean(l), inner_w) {
                    rows.push(ChatRow::plain(Line::from(vec![
                        Span::styled("│ ", line()),
                        Span::styled(wl, ink()),
                    ])));
                }
            }
        }
        push_links(rows, &card.links, inner_w, active_hit);
        return;
    }

    // Completed / dismissed / refused proposal collapses to a quiet slim status line + links
    if card.state != "pending" {
        let (sym, st, tail) = match card.state.as_str() {
            "confirmed" => (
                m.passed,
                passed(),
                card.said.as_deref().unwrap_or("Confirmed."),
            ),
            "refused" => (
                m.failed,
                failed(),
                card.said.as_deref().unwrap_or("Refused."),
            ),
            _ => (
                m.skipped,
                dim(),
                card.note.as_deref().unwrap_or(card.state.as_str()),
            ),
        };
        rows.push(ChatRow::plain(Line::from(vec![
            Span::styled(format!("{sym} "), st),
            Span::styled(
                fit(&format!("{} · {}", clean(&card.label), clean(tail)), w.saturating_sub(2)),
                dim(),
            ),
        ])));
        push_links(rows, &card.links, inner_w, active_hit);
        return;
    }

    // Pending actionable proposal card: wears the one solid-ink "Needs you" signal when confirmable
    let mut header = vec![Span::styled("│ ", line())];
    if matches!(card.primary, Some(LeadCardPrimary::Confirm { .. })) {
        header.push(sheet::chip(&format!("{} Needs you", m.needs)));
        header.push(Span::styled(" ", dim()));
    }
    header.push(Span::styled(
        fit(&clean(&card.label), inner_w.saturating_sub(14).max(8)),
        ink().add_modifier(Modifier::BOLD),
    ));
    rows.push(ChatRow::plain(Line::from(header)));

    for (idx, l) in card.lines.iter().enumerate() {
        let style = if idx == 0 {
            ink().add_modifier(Modifier::BOLD)
        } else if l.contains(": ") {
            dim()
        } else {
            ink()
        };
        for wl in wrap(&clean(l), inner_w) {
            rows.push(ChatRow::plain(Line::from(vec![
                Span::styled("│ ", line()),
                Span::styled(wl, style),
            ])));
        }
    }
    if let Some(note) = &card.note {
        for wl in wrap(&clean(note), inner_w) {
            rows.push(ChatRow::plain(Line::from(vec![
                Span::styled("│ ", line()),
                Span::styled(wl, dim()),
            ])));
        }
    }
    match &card.primary {
        Some(LeadCardPrimary::Confirm {
            label,
            irreversible,
            ..
        }) => {
            let hit = ChatHit::ConfirmProposal(card.id);
            let is_sel = active_hit == Some(&hit);
            let mut spans = vec![Span::styled("│ ", line())];
            let btn = format!("[Enter {}]", clean(label));
            spans.push(Span::styled(
                btn,
                if is_sel {
                    selected()
                } else {
                    ink().add_modifier(Modifier::BOLD)
                },
            ));
            if *irreversible {
                spans.push(Span::styled(" ", dim()));
                spans.push(sheet::badge("Irreversible", Role::Failed));
            }
            if card.dismissable {
                spans.push(Span::styled("  [x Dismiss]", dim()));
            }
            rows.push(ChatRow::clickable(Line::from(spans), hit));
        }
        Some(LeadCardPrimary::Link {
            label, task, tab, ..
        }) => {
            if let Some(task) = task {
                let hit = ChatHit::PeekTask {
                    task: task.clone(),
                    tab: tab.clone(),
                    label: label.clone(),
                };
                let is_sel = active_hit == Some(&hit);
                rows.push(ChatRow::clickable(
                    Line::from(vec![
                        Span::styled("│ ", line()),
                        Span::styled(
                            fit(&format!("[→ {}]", clean(label)), inner_w),
                            if is_sel { selected() } else { ink() },
                        ),
                    ]),
                    hit,
                ));
            }
        }
        None => {}
    }
    push_links(rows, &card.links, inner_w, active_hit);
}

fn push_links(
    rows: &mut Vec<ChatRow>,
    links: &[toolroll_api::LeadLink],
    inner_w: usize,
    active_hit: Option<&ChatHit>,
) {
    for link in links {
        let Some(task) = &link.task else {
            continue;
        };
        let hit = ChatHit::PeekTask {
            task: task.clone(),
            tab: link.tab.clone(),
            label: link.label.clone(),
        };
        let is_sel = active_hit == Some(&hit);
        let tab_hint = match link.tab.as_deref() {
            Some("diff") => " (Diff)",
            Some("steps") => " (Steps)",
            Some("live") => " (Live)",
            _ => "",
        };
        rows.push(ChatRow::clickable(
            Line::from(vec![
                Span::styled("│ ", line()),
                Span::styled(
                    fit(&format!("[→ {}{tab_hint}]", clean(&link.label)), inner_w),
                    if is_sel { selected() } else { running() },
                ),
            ]),
            hit,
        ));
    }
}

fn push_chat_card_blocks(rows: &mut Vec<ChatRow>, card: &ChatCard, w: usize) {
    for block in &card.blocks {
        match block {
            ChatCardBlock::Text { text } => {
                for (i, wl) in wrap(&clean(text), w.saturating_sub(11).max(10))
                    .into_iter()
                    .enumerate()
                {
                    let pref = if i == 0 { "Lead note: " } else { "           " };
                    rows.push(ChatRow::plain(Line::from(vec![
                        Span::styled("│ ", line()),
                        Span::styled(format!("{pref}{wl}"), dim()),
                    ])));
                }
            }
            ChatCardBlock::Divider {} => {
                rows.push(ChatRow::plain(Line::from(vec![
                    Span::styled("│ ", line()),
                    Span::styled("─".repeat(w.min(36)), line()),
                ])));
            }
            ChatCardBlock::Facts { heading, items } => {
                rows.push(ChatRow::plain(Line::from(vec![
                    Span::styled("│ ", line()),
                    Span::styled(fit(&clean(heading), w), dim()),
                ])));
                let label_w = items
                    .iter()
                    .map(|i| width(&clean(&i.label)))
                    .max()
                    .unwrap_or(8)
                    .min(18);
                for item in items {
                    let lbl = fit(&clean(&item.label), label_w);
                    let pad = label_w.saturating_sub(width(&lbl)) + 2;
                    let val = fit(&clean(&item.value), w.saturating_sub(label_w + 2).max(6));
                    rows.push(ChatRow::plain(Line::from(vec![
                        Span::styled("│ ", line()),
                        Span::styled(format!("{lbl}{}", " ".repeat(pad)), dim()),
                        Span::styled(val, ink()),
                    ])));
                }
            }
            ChatCardBlock::Table {
                heading,
                columns,
                rows: table_rows,
                more,
                ..
            } => {
                rows.push(ChatRow::plain(Line::from(vec![
                    Span::styled("│ ", line()),
                    Span::styled(fit(&clean(heading), w), dim()),
                ])));
                let col_count = columns.len().max(1);
                let col_w = (w.saturating_sub(col_count.saturating_sub(1) * 2) / col_count).max(6);
                let header: String = columns
                    .iter()
                    .map(|c| {
                        let s = fit(&clean(&c.label), col_w);
                        let p = col_w.saturating_sub(width(&s));
                        if c.numeric {
                            format!("{}{s}", " ".repeat(p))
                        } else {
                            format!("{s}{}", " ".repeat(p))
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("  ");
                rows.push(ChatRow::plain(Line::from(vec![
                    Span::styled("│ ", line()),
                    Span::styled(fit(&header, w), dim()),
                ])));
                for tr in table_rows {
                    let line_s: String = columns
                        .iter()
                        .enumerate()
                        .map(|(idx, c)| {
                            let raw = tr.get(idx).map(String::as_str).unwrap_or("");
                            let s = fit(&clean(raw), col_w);
                            let p = col_w.saturating_sub(width(&s));
                            if c.numeric {
                                format!("{}{s}", " ".repeat(p))
                            } else {
                                format!("{s}{}", " ".repeat(p))
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("  ");
                    rows.push(ChatRow::plain(Line::from(vec![
                        Span::styled("│ ", line()),
                        Span::styled(fit(&line_s, w), ink()),
                    ])));
                }
                if *more > 0 {
                    rows.push(ChatRow::plain(Line::from(vec![
                        Span::styled("│ ", line()),
                        Span::styled(format!("+{more} more"), dim()),
                    ])));
                }
            }
            ChatCardBlock::Notes {
                heading,
                items,
                more,
                ..
            } => {
                rows.push(ChatRow::plain(Line::from(vec![
                    Span::styled("│ ", line()),
                    Span::styled(fit(&clean(heading), w), dim()),
                ])));
                for item in items {
                    for (i, wl) in wrap(&clean(item), w.saturating_sub(2).max(10))
                        .into_iter()
                        .enumerate()
                    {
                        let bullet = if i == 0 { "• " } else { "  " };
                        rows.push(ChatRow::plain(Line::from(vec![
                            Span::styled("│ ", line()),
                            Span::styled(format!("{bullet}{wl}"), ink()),
                        ])));
                    }
                }
                if *more > 0 {
                    rows.push(ChatRow::plain(Line::from(vec![
                        Span::styled("│ ", line()),
                        Span::styled(format!("+{more} more"), dim()),
                    ])));
                }
            }
            ChatCardBlock::Chart {
                heading, points, ..
            } => {
                rows.push(ChatRow::plain(Line::from(vec![
                    Span::styled("│ ", line()),
                    Span::styled(fit(&clean(heading), w), dim()),
                ])));
                let max_val = points
                    .iter()
                    .filter_map(|p| p.value.as_f64())
                    .fold(0.0_f64, f64::max)
                    .max(1.0);
                let label_w = points
                    .iter()
                    .map(|p| width(&clean(&p.label)))
                    .max()
                    .unwrap_or(8)
                    .min(14);
                let bar_max = w.saturating_sub(label_w + 10).clamp(4, 20);
                for pt in points {
                    let lbl = fit(&clean(&pt.label), label_w);
                    let pad = label_w.saturating_sub(width(&lbl)) + 1;
                    let v = pt.value.as_f64().unwrap_or(0.0).max(0.0);
                    let filled = ((v / max_val) * bar_max as f64).round() as usize;
                    let bar = "█".repeat(filled.max(usize::from(v > 0.0)));
                    rows.push(ChatRow::plain(Line::from(vec![
                        Span::styled("│ ", line()),
                        Span::styled(format!("{lbl}{}", " ".repeat(pad)), dim()),
                        Span::styled(bar, running()),
                        Span::styled(format!(" {}", clean(&pt.shown)), ink()),
                    ])));
                }
            }
        }
    }
}
