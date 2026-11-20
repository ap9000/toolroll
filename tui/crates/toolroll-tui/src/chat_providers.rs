//! Recovery for a failed central Lead provider, using the console's existing sign-in and membership controls.
use crate::app::{App, Effect, Mode};
use crate::text::{clean, wrap};
use crate::theme::{dim, failed, ink, selected};
use ratatui::{
    layout::Rect,
    style::Modifier,
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};
use toolroll_api::LeadChat;
/// Only memberships backed by a local CLI can use the console's one-click switch.
/// API keys and metered spending limits are managed by the existing Lead settings form.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Membership {
    Codex,
    Claude,
}

impl Membership {
    pub fn id(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Claude => "Claude",
        }
    }

    fn state(self, app: &App) -> Option<&str> {
        app.chat
            .checked_providers
            .as_ref()?
            .agents
            .iter()
            .find(|row| row.id == self.id())
            .map(|row| row.state.as_str())
    }
}

fn provider_issue(data: &LeadChat) -> Option<&str> {
    // The deployed console exposes its own failure copy in this field. Never route
    // spend reconciliation, expired Toolroll sessions or an agent's reply into this picker.
    let words = data.problem.as_deref()?;
    if data.busy || words.contains("chat is paused") {
        return None;
    }
    [
        "The chat provider couldn't answer",
        "The chat provider turned the request down",
        "The chat app the lead uses isn't installed",
        "the lead is off",
        "no openrouter-api key",
        "no anthropic-api key",
        "no pinned price for ",
    ]
    .iter()
    .any(|prefix| words.starts_with(prefix))
    .then_some(words)
}

pub(crate) fn restore_submission(app: &mut App) {
    if app.chat.draft.is_empty() {
        if let Some(text) = &app.chat.last_submission {
            app.chat.draft = text.clone();
            if matches!(app.mode, Mode::ChatCompose(_)) {
                app.mode = Mode::ChatCompose(text.clone());
            }
        }
    }
}

pub(crate) fn offer_recovery(app: &mut App) -> Vec<Effect> {
    let Some(data) = &app.chat.data else {
        return vec![];
    };
    let Some(words) = provider_issue(data) else {
        app.chat.seen_provider_issue = None;
        return vec![];
    };
    if !app.chat_focused()
        || !matches!(app.mode, Mode::ChatCompose(_) | Mode::Normal)
        || app.agents_screen.is_some()
    {
        return vec![];
    }
    let last = data.messages.last();
    let issue = (
        data.room.clone(),
        data.session,
        last.map(|m| m.id),
        words.to_owned(),
    );
    if app.chat.seen_provider_issue.as_ref() == Some(&issue) {
        return vec![];
    }
    app.chat.seen_provider_issue = Some(issue);
    app.status = None;
    if let Some(operator) = last.filter(|m| m.role == "operator") {
        app.chat.last_submission = Some(operator.text.clone());
    }
    restore_submission(app);
    open_providers(app)
}

pub(crate) fn open_providers(app: &mut App) -> Vec<Effect> {
    if let Mode::ChatCompose(text) = &app.mode {
        app.chat.draft = text.clone();
    }
    app.mode = Mode::LeadProviders(None);
    check_providers(app)
}

fn check_providers(app: &mut App) -> Vec<Effect> {
    if app.chat.checking_providers {
        return vec![];
    }
    app.chat.checking_providers = true;
    app.chat.checked_providers = None;
    app.chat.provider_problem = None;
    vec![Effect::CheckLeadProviders]
}

pub(crate) fn provider_key(
    app: &mut App,
    chosen: Option<Membership>,
    key: crossterm::event::KeyCode,
) -> Vec<Effect> {
    use crossterm::event::KeyCode::*;
    if key == Esc {
        app.mode = if chosen.is_some() {
            Mode::LeadProviders(None)
        } else {
            Mode::ChatCompose(app.chat.draft.clone())
        };
        return vec![];
    }
    if app.chat.switching_provider {
        return vec![];
    }
    if let Some(plan) = chosen {
        if key == Enter {
            app.chat.switching_provider = true;
            app.mode = Mode::LeadProviders(None);
            return vec![Effect::SwitchLead(plan)];
        }
        return vec![];
    }
    match key {
        Char('1' | '2') => {
            let plan = if key == Char('1') {
                Membership::Codex
            } else {
                Membership::Claude
            };
            match plan.state(app) {
                Some("signed-in" | "unknown") => {
                    app.mode = Mode::LeadProviders(Some(plan));
                }
                Some(_) => {
                    let fx = crate::agents::open(app);
                    if let Some(screen) = &mut app.agents_screen {
                        screen.agent = Some(plan.id().into());
                    }
                    return fx;
                }
                None => {}
            }
            vec![]
        }
        Char('r') => check_providers(app),
        Char('a') => crate::agents::open(app),
        Char('w') => vec![Effect::OpenPage("lead-providers")],
        _ => vec![],
    }
}

pub(crate) fn draw_providers(f: &mut Frame, app: &mut App, area: Rect) {
    use crossterm::event::KeyCode::{Char, Enter, Esc};
    let Mode::LeadProviders(chosen) = app.mode else {
        return;
    };
    let w = area.width.saturating_sub(2).min(76);
    // The shared dialog uses one border cell and one padding cell on each side.
    let width = usize::from(w.saturating_sub(4)).max(1);
    let mut rows = Vec::new();
    let mut actions = Vec::new();
    let mut add = |words: String, style, key| {
        let start = rows.len();
        for s in wrap(&words, width) {
            rows.push(Line::from(Span::styled(s, style)));
        }
        if let Some(code) = key {
            actions.push((start as u16, (rows.len() - start) as u16, code));
        }
    };
    if let Some(plan) = chosen {
        add(
            format!("Use {} membership for Lead?", plan.name()),
            ink().add_modifier(Modifier::BOLD),
            None,
        );
        add("Lead will use this membership’s default model across projects. Older consoles set a limit of 50 turns per day and may fill empty task defaults.".into(),dim(),None);
        add(
            "Your message will wait for you to send it.".into(),
            dim(),
            None,
        );
        add(
            format!("Enter   Use {}", plan.name()),
            selected(),
            Some(Enter),
        );
    } else if app.chat.switching_provider {
        add("Switching Lead membership…".into(), ink(), None);
    } else {
        if app.chat.data.as_ref().and_then(provider_issue).is_some() {
            add(
                "Lead needs a working provider.".into(),
                ink().add_modifier(Modifier::BOLD),
                None,
            );
        }
        if let Some(problem) = &app.chat.provider_problem {
            add(crate::text::fit(&clean(problem), width * 2), failed(), None);
        }
        add(
            if app.chat.checking_providers {
                "Checking local sign-ins…"
            } else {
                "Local sign-in check · remaining plan usage is unknown"
            }
            .into(),
            dim(),
            None,
        );
        for (key, plan) in [('1', Membership::Codex), ('2', Membership::Claude)] {
            let state = plan.state(app);
            let words = match state {
                Some("signed-in") => "Signed in · select",
                Some("unknown") => "Sign-in unverified · check on switch",
                Some("signed-out") => "Sign in",
                Some("not-installed") => "Install",
                _ => "No check result",
            };
            add(
                format!("{key}   {} membership · {words}", plan.name()),
                if state.is_some() { ink() } else { dim() },
                state.map(|_| Char(key)),
            );
        }
        add(" ".into(), dim(), None);
        add("r   Check again".into(), ink(), Some(Char('r')));
        add("a   Connect an agent".into(), ink(), Some(Char('a')));
        add(
            "w   API keys and Lead settings ↗".into(),
            ink(),
            Some(Char('w')),
        );
    }
    add("Esc   Back".into(), dim(), Some(Esc));
    let h = area.height.saturating_sub(2).min(rows.len() as u16 + 2);
    let rect = Rect::new(
        area.x + (area.width - w) / 2,
        area.y + (area.height - h) / 2,
        w,
        h,
    );
    let block = crate::view::dialog(f, rect, " Lead providers ");
    let inner = block.inner(rect);
    if rows.len() > usize::from(inner.height) || width < 20 {
        app.drawn_dialog = None;
        f.render_widget(
            Paragraph::new("Enlarge the terminal to see the provider choices. Esc goes back.")
                .block(block),
            rect,
        );
        return;
    }
    app.areas.lead_provider_controls = actions
        .into_iter()
        .map(|(offset, height, code)| {
            (
                Rect::new(inner.x, inner.y + offset, inner.width, height),
                code,
            )
        })
        .collect();
    f.render_widget(Paragraph::new(rows).block(block), rect);
}
