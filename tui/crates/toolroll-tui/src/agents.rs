//! The Agents screen (A, or Agents in the palette; the first run's Agents button): every agent Toolroll supports, grouped
//! Ready / Needs sign-in / Needs a check / Not installed, as the console's last detection saw it (GET /engine/agents),
//! with how to add each; and which agent plans, builds and reviews, and the default agent for new tasks
//! (GET /engine/models).
//!
//! What it does, all through the console's own routes, never by itself:
//! - Sign in: the agent's OWN sign-in in a pane (POST /term/agent/sign-in; the console starts Toolroll's own command for
//!   that agent from a trusted install). The provider's browser sign-in opens as usual and the credential goes into the
//!   agent's own files; nothing of it passes through here but what the pane shows. When it ends, detection runs again.
//! - Install: the exact install command, shown whole in a confirm first; only Enter on that confirm runs it in a pane
//!   (POST /term/agent/install carries exactly that command). Downloading software is the person's act.
//! - Copy: every command for the agent, written to the terminal's own scrollback (the same road as Diff's `y`).
//! - Check again: POST /engine/agents/check (the console's bounded status checks; no model call).
//! - Models: a change shown before → after in a confirm, then Settings → Models' own write (POST /settings/models/agent
//!   with the digest the screen read), which proves the person and ledgers each row.
//!
//! Every word drawn from the console is cleaned (text.rs clean); the commands are the console's own constants.
use crate::app::{App, Effect, Mode, Tone};
use crate::sheet;
use crate::text::{clean, fit, width, wrap};
use crate::theme::{dim, ink, line, marks, needs_you, passed, running, selected, Role};
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;
use toolroll_api::{AgentRow, AgentsRead, ApiError, ModelsRead};

/// Said once a models change was sent.
pub const MODELS_SENT: &str = "Saving the models…";
/// Said when this session can't change models.
pub const MODELS_LOCKED: &str =
    "Only this Toolroll's operator, on a solo install, can change models here. Open Settings → Models in the browser (w).";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    Agents,
    Models,
}

/// The screen's own state (the agents and models themselves are the console's answers).
#[derive(Debug, Clone, PartialEq)]
pub struct Screen {
    /// The agent on screen, by id (its place in the groups can move when detection answers again).
    pub agent: Option<String>,
    pub focus: Focus,
    /// The models row: 0 the default agent, then each role.
    pub row: usize,
    pub models: Option<ModelsRead>,
    pub checking: bool,
    /// The pane open now: which agent, and what it runs (`sign-in` | `install`).
    pub pane: Option<(String, String)>,
    /// How the last sign-in or install ended, kept on screen (its output never is): the agent and the words.
    pub outcome: Option<(String, String)>,
}

/// A choice being made: a role's model, or the default agent.
#[derive(Debug, Clone, PartialEq)]
pub struct Pick {
    /// `plan` | `build` | `review`, or `default` (a preset: every role).
    pub role: String,
    pub title: String,
    /// The value the form posts ("provider|model", or a preset's agent) and its words.
    pub options: Vec<(String, String)>,
    pub selected: usize,
}

/// A models change shown whole before it is saved: what it moves, the exact fields posted, the digest read.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelsChange {
    pub title: String,
    pub lines: Vec<String>,
    pub fields: Vec<(String, String)>,
    /// The default agent chosen isn't signed in: its id, offered a sign-in (s) before or instead of saving.
    pub sign_in: Option<String>,
}

/// The groups, in order, and which agents are in each.
pub fn groups(read: &AgentsRead) -> Vec<(&'static str, Vec<&AgentRow>)> {
    let mut out: Vec<(&'static str, Vec<&AgentRow>)> = vec![
        ("Ready", vec![]),
        ("Needs sign-in", vec![]),
        ("Needs a check", vec![]),
        ("Not installed", vec![]),
    ];
    for a in &read.agents {
        let at = if a.ready {
            0
        } else if a.state == "not-installed" {
            3
        } else if a.state == "signed-in" {
            2
        } else {
            1
        };
        out[at].1.push(a);
    }
    out.into_iter().filter(|(_, v)| !v.is_empty()).collect()
}

fn ordered(read: &AgentsRead) -> Vec<&AgentRow> {
    groups(read).into_iter().flat_map(|(_, v)| v).collect()
}

/// The agent on screen.
pub fn current(app: &App) -> Option<&AgentRow> {
    let read = app.agents.as_ref()?;
    let all = ordered(read);
    let want = app.agents_screen.as_ref()?.agent.as_deref();
    all.iter()
        .find(|a| Some(a.id.as_str()) == want)
        .or(all.first())
        .copied()
}

/// A status in plain words, and its mark and role.
pub fn status_of(a: &AgentRow) -> (String, &'static str, Option<Role>) {
    let m = marks();
    let how = a.how.as_deref().map(clean);
    match (a.state.as_str(), a.ready) {
        (_, true) => (
            format!(
                "Ready{}",
                how.map(|h| format!(" · {h}")).unwrap_or_default()
            ),
            m.passed,
            Some(Role::Passed),
        ),
        ("signed-in", false) => (
            format!(
                "Signed in{}, not taking tasks yet",
                how.map(|h| format!(" ({h})")).unwrap_or_default()
            ),
            m.needs,
            None,
        ),
        ("signed-out", _) => ("Installed, not signed in".into(), m.needs, None),
        ("unknown", _) => (
            "Installed; its sign-in couldn't be checked".into(),
            m.todo,
            None,
        ),
        _ => ("Not installed".into(), m.todo, None),
    }
}

/// The screen opens (reading the agents and the models).
pub fn open(app: &mut App) -> Vec<Effect> {
    // What was said belonged to the screen left.
    app.status = None;
    app.agents_screen = Some(Screen {
        agent: None,
        focus: Focus::Agents,
        row: 0,
        models: None,
        checking: false,
        pane: None,
        outcome: None,
    });
    app.mode = Mode::Normal;
    let mut fx = vec![Effect::FetchModels];
    if !app.fetching_agents {
        app.fetching_agents = true;
        fx.push(Effect::FetchAgents);
    }
    fx
}

/// The screen closes; an agent's pane is let go of (its program keeps running in the console until it ends).
pub fn close(app: &mut App) -> Vec<Effect> {
    app.agents_screen = None;
    app.status = None;
    if app
        .term
        .as_ref()
        .is_some_and(|p| p.task.starts_with("agent:"))
    {
        if matches!(app.mode, Mode::TakeOver | Mode::ShellOpening) {
            app.mode = Mode::Normal;
            app.shell_typed.clear();
        }
        // The pane (its screen and all) goes; letting go of its one page ends it on the console too.
        if let Some(id) = app.term.take().and_then(|p| p.id) {
            return vec![Effect::TermDetach(id)];
        }
    }
    vec![]
}

/// Detection again (Check again, and after a sign-in or install ends).
pub fn check_again(app: &mut App) -> Vec<Effect> {
    if let Some(s) = app.agents_screen.as_mut() {
        s.checking = true;
    }
    app.say(Tone::Said, "Looking for this computer's agents again…");
    vec![Effect::CheckAgents]
}

pub fn on_models(app: &mut App, read: Result<ModelsRead, ApiError>) -> Vec<Effect> {
    match read {
        Ok(read) => {
            if let Some(s) = app.agents_screen.as_mut() {
                s.models = Some(read);
            }
            vec![]
        }
        Err(ApiError::SessionEnded) => app.failed_pub(ApiError::SessionEnded),
        Err(e) => {
            app.say(Tone::Refused, e.to_string());
            vec![]
        }
    }
}

/// The answer to a detection read while the screen is open: no longer checking.
pub fn on_agents(app: &mut App) {
    if let Some(s) = app.agents_screen.as_mut() {
        if s.checking {
            s.checking = false;
            // A sign-in or install that just failed keeps its words on the status line too.
            if s.outcome.is_none() {
                app.say(Tone::Said, "Agents checked.");
            }
        }
    }
}

fn move_by(app: &mut App, delta: i64) {
    let Some(read) = app.agents.as_ref() else {
        return;
    };
    let ids: Vec<String> = ordered(read).iter().map(|a| a.id.clone()).collect();
    let Some(s) = app.agents_screen.as_mut() else {
        return;
    };
    match s.focus {
        Focus::Agents => {
            if ids.is_empty() {
                return;
            }
            let at = s
                .agent
                .as_ref()
                .and_then(|id| ids.iter().position(|i| i == id))
                .unwrap_or(0) as i64;
            let next = (at + delta).clamp(0, ids.len() as i64 - 1) as usize;
            s.agent = Some(ids[next].clone());
        }
        Focus::Models => {
            let rows = 1 + s.models.as_ref().map(|m| m.roles.len()).unwrap_or(0);
            s.row = (s.row as i64 + delta).clamp(0, rows.saturating_sub(1) as i64) as usize;
        }
    }
}

/// Every command for this agent, as lines for the terminal's scrollback (the console's own constants, cleaned).
pub fn commands_of(a: &AgentRow) -> Vec<String> {
    let mut lines = vec![clean(&a.name)];
    if let Some(c) = &a.setup.install {
        lines.push(format!("Install:  {}", clean(c)));
    }
    if let Some(c) = &a.setup.sign_in {
        lines.push(format!("Sign in:  {}", clean(c)));
    }
    if let Some(c) = &a.setup.check {
        lines.push(format!("Check:    {}", clean(c)));
    }
    if let Some(c) = &a.setup.key {
        lines.push(format!("Key:      {}", clean(c)));
    }
    if let Some(c) = &a.setup.note {
        lines.push(format!("Note:     {}", clean(c)));
    }
    lines
}

/// Open the agent's own sign-in, or (confirmed) its install, in a pane here.
fn start_pane(app: &mut App, agent: &str, kind: &str, confirm: Option<String>) -> Vec<Effect> {
    let mut fx = vec![];
    if let Some(id) = app.term.take().and_then(|p| p.id) {
        fx.push(Effect::TermDetach(id));
    }
    app.mode = Mode::Normal;
    app.term = Some(crate::term::Pane::opening_sensitive(format!(
        "agent:{agent}"
    )));
    if let Some(s) = app.agents_screen.as_mut() {
        s.pane = Some((agent.to_string(), kind.to_string()));
        s.outcome = None;
    }
    app.say(
        Tone::Said,
        if kind == "install" {
            "Installing in the pane below…"
        } else {
            "Opening its sign-in in the pane below. Finish in your browser if it opens one."
        },
    );
    fx.push(Effect::AgentTerm {
        kind: kind.into(),
        agent: agent.into(),
        confirm,
    });
    fx
}

/// The agent's pane, when one is open for it.
pub fn pane_of<'a>(app: &'a App, agent: &str) -> Option<&'a crate::term::Pane> {
    app.term
        .as_ref()
        .filter(|p| p.task.strip_prefix("agent:") == Some(agent))
}

/// A key on the screen (Normal mode).
pub fn key(app: &mut App, key: KeyEvent) -> Vec<Effect> {
    let focus = app.agents_screen.as_ref().map(|s| s.focus);
    match key.code {
        KeyCode::Esc | KeyCode::Char('A') => close(app),
        KeyCode::Char('j') | KeyCode::Down => {
            move_by(app, 1);
            vec![]
        }
        KeyCode::Char('k') | KeyCode::Up => {
            move_by(app, -1);
            vec![]
        }
        KeyCode::Tab | KeyCode::BackTab => {
            if let Some(s) = app.agents_screen.as_mut() {
                s.focus = if s.focus == Focus::Agents {
                    Focus::Models
                } else {
                    Focus::Agents
                };
            }
            vec![]
        }
        KeyCode::Char('r') => check_again(app),
        KeyCode::Char('w') => vec![Effect::OpenBrowser],
        KeyCode::Char('q') => app.run_action(crate::keys::Action::Quit),
        KeyCode::Char('?') => app.run_action(crate::keys::Action::Help),
        KeyCode::Char('y') => match current(app) {
            Some(a) => {
                let lines = commands_of(a);
                app.mode = Mode::Copied;
                vec![Effect::Scrollback(lines)]
            }
            None => vec![],
        },
        KeyCode::Char('t') => {
            // Type in the agent's pane (Ctrl-] comes back).
            let Some(a) = current(app).map(|a| a.id.clone()) else {
                return vec![];
            };
            if pane_of(app, &a).is_some_and(|p| p.live()) {
                app.mode = Mode::TakeOver;
                app.say(Tone::Said, crate::app::TYPING_AGENT);
            }
            vec![]
        }
        KeyCode::Char('s') if focus == Some(Focus::Agents) => {
            let Some(a) = current(app).cloned() else {
                return vec![];
            };
            if a.ready && a.setup.can_sign_in {
                // Already signed in: a new sign-in replaces it, so it is asked first.
                app.mode = Mode::ConfirmSignInAgain {
                    agent: a.id.clone(),
                    words: signed_in_as(&a),
                };
                return vec![];
            }
            if !a.setup.can_sign_in || a.state == "not-installed" {
                app.say(
                    Tone::Said,
                    if a.state == "not-installed" {
                        "Install it first (i)."
                    } else {
                        "This agent signs in another way: its screen says how."
                    },
                );
                return vec![];
            }
            start_pane(app, &a.id, "sign-in", None)
        }
        KeyCode::Char('i') if focus == Some(Focus::Agents) => {
            let Some(a) = current(app).cloned() else {
                return vec![];
            };
            if a.state != "not-installed" {
                app.say(
                    Tone::Said,
                    format!("{} is installed already.", clean(&a.name)),
                );
                return vec![];
            }
            match (&a.setup.install, a.setup.can_install) {
                (Some(command), true) => {
                    app.mode = Mode::ConfirmInstall {
                        agent: a.id.clone(),
                        name: clean(&a.name),
                        command: command.clone(),
                    };
                    vec![]
                }
                (Some(_), false) => {
                    app.say(Tone::Said, "Toolroll doesn't run this installer: copy it (y) and run it in your own terminal.");
                    vec![]
                }
                (None, _) => {
                    app.say(
                        Tone::Said,
                        "This agent has nothing to install: its screen says how to add it.",
                    );
                    vec![]
                }
            }
        }
        KeyCode::Enter if focus == Some(Focus::Models) => pick(app),
        _ => vec![],
    }
}

/// Enter on a models row: its choices.
fn pick(app: &mut App) -> Vec<Effect> {
    let Some(s) = app.agents_screen.as_ref() else {
        return vec![];
    };
    let Some(models) = s.models.as_ref() else {
        return vec![];
    };
    if !models.can_change {
        app.say(Tone::Refused, MODELS_LOCKED);
        return vec![];
    }
    let pick = if s.row == 0 {
        Pick {
            role: "default".into(),
            title: "Default agent for new tasks".into(),
            options: models
                .presets
                .iter()
                .map(|p| {
                    let state = match agent_of(app, &p.agent) {
                        Some(a) if a.ready => "ready".to_string(),
                        Some(a) => status_of(a).0.to_lowercase(),
                        None => "not on this computer".to_string(),
                    };
                    (
                        p.agent.clone(),
                        format!("{} ({state}) — {}", clean(&p.name), clean(&p.words)),
                    )
                })
                .collect(),
            selected: 0,
        }
    } else {
        let Some(role) = models.roles.get(s.row - 1) else {
            return vec![];
        };
        let options: Vec<(String, String)> = role
            .choices
            .iter()
            .flat_map(|c| {
                c.models.iter().map(move |m| {
                    let value = format!("{}|{}", c.provider, m.value);
                    let words = model_words(role, &value)
                        .unwrap_or_else(|| format!("{} · {}", clean(&c.label), clean(&m.label)));
                    (value, words)
                })
            })
            .collect();
        let selected = options
            .iter()
            .position(|(v, _)| *v == role.current)
            .unwrap_or(0);
        Pick {
            role: role.key.clone(),
            title: clean(&role.label),
            options,
            selected,
        }
    };
    if pick.options.is_empty() {
        app.say(
            Tone::Said,
            "Nothing to choose from yet: sign in to an agent first.",
        );
        return vec![];
    }
    app.mode = Mode::PickModel(pick);
    vec![]
}

/// Keys in the screen's dialogs.
pub fn mode_key(app: &mut App, key: KeyEvent) -> Vec<Effect> {
    match app.mode.clone() {
        Mode::ConfirmSignInAgain { agent, .. } => match key.code {
            KeyCode::Enter => start_pane(app, &agent, "sign-in", None),
            _ => {
                app.mode = Mode::Normal;
                app.say(Tone::Said, "Still signed in as before.");
                vec![]
            }
        },
        Mode::ConfirmInstall { agent, command, .. } => match key.code {
            KeyCode::Enter => start_pane(app, &agent, "install", Some(command)),
            _ => {
                app.mode = Mode::Normal;
                app.say(Tone::Said, "Nothing was installed.");
                vec![]
            }
        },
        Mode::PickModel(mut p) => match key.code {
            KeyCode::Char('j') | KeyCode::Down => {
                p.selected = (p.selected + 1).min(p.options.len().saturating_sub(1));
                app.mode = Mode::PickModel(p);
                vec![]
            }
            KeyCode::Char('k') | KeyCode::Up => {
                p.selected = p.selected.saturating_sub(1);
                app.mode = Mode::PickModel(p);
                vec![]
            }
            KeyCode::Enter => {
                app.mode = match change_of(app, &p) {
                    Some(c) => Mode::ConfirmModels(c),
                    None => Mode::Normal,
                };
                vec![]
            }
            _ => {
                app.mode = Mode::Normal;
                vec![]
            }
        },
        Mode::ConfirmModels(c) => match key.code {
            KeyCode::Char('s') if c.sign_in.is_some() => {
                let agent = c.sign_in.clone().unwrap_or_default();
                if let Some(s) = app.agents_screen.as_mut() {
                    s.agent = Some(agent.clone());
                    s.focus = Focus::Agents;
                }
                app.mode = Mode::Normal;
                app.say(
                    Tone::Said,
                    "Nothing changed yet: sign in first, then choose it again.",
                );
                start_pane(app, &agent, "sign-in", None)
            }
            KeyCode::Enter => {
                app.mode = Mode::Normal;
                app.say(Tone::Said, MODELS_SENT);
                vec![Effect::Act {
                    path: "/settings/models/agent".into(),
                    fields: c.fields,
                    done: "Models saved for tasks filed from now on.".into(),
                }]
            }
            _ => {
                app.mode = Mode::Normal;
                app.say(Tone::Said, "Nothing changed.");
                vec![]
            }
        },
        _ => vec![],
    }
}

/// The change a pick makes, shown before → after, with the exact fields Settings → Models' write takes.
fn change_of(app: &App, p: &Pick) -> Option<ModelsChange> {
    let models = app.agents_screen.as_ref()?.models.as_ref()?;
    let (value, label) = p.options.get(p.selected)?.clone();
    let mut fields = vec![
        ("scope".to_string(), "installation".to_string()),
        ("digest".to_string(), models.digest.clone()),
        ("password".to_string(), String::new()),
    ];
    let mut lines = vec![];
    let mut sign_in = None;
    if p.role == "default" {
        let preset = models.presets.iter().find(|x| x.agent == value)?;
        if let Some(a) = agent_of(app, &preset.agent).filter(|a| !a.ready) {
            lines.push(format!(
                "{} isn't signed in yet, so new tasks would wait for it.",
                clean(&preset.name)
            ));
            if a.setup.can_sign_in && a.state != "not-installed" {
                sign_in = Some(a.id.clone());
            }
        }
        lines.push(format!(
            "New tasks go to {}: every role moves to its preset.",
            clean(&preset.name)
        ));
        lines.push(clean(&preset.words));
        for (k, v) in &preset.fields {
            fields.push((k.clone(), v.clone()));
        }
    } else {
        let role = models.roles.iter().find(|r| r.key == p.role)?;
        lines.push(format!(
            "{}: {} → {}",
            clean(&role.label),
            role_words(role),
            label
        ));
        fields.push((p.role.clone(), value));
    }
    lines.push(
        "It applies to tasks filed from now on; approved and waiting tasks keep theirs.".into(),
    );
    Some(ModelsChange {
        title: p.title.clone(),
        lines,
        fields,
        sign_in,
    })
}

/// An agent of the agents read, by id.
fn agent_of<'a>(app: &'a App, id: &str) -> Option<&'a AgentRow> {
    app.agents.as_ref()?.agents.iter().find(|a| a.id == id)
}

/// "You're signed in to Claude Code (Claude account)": what a new sign-in would replace.
fn signed_in_as(a: &AgentRow) -> String {
    match a.how.as_deref().map(clean) {
        Some(how) => format!(
            "You're signed in to {} ({how}). Start a new sign-in?",
            clean(&a.name)
        ),
        None => format!("{} is signed in. Start a new sign-in?", clean(&a.name)),
    }
}

/// A model in words, from the engine's own catalog (the role's choices): "Claude Opus 5.5", or "Codex · gpt-6-sol"
/// when the model's name doesn't say its agent.
fn model_words(role: &toolroll_api::ModelRole, value: &str) -> Option<String> {
    let (provider, model) = value.split_once('|')?;
    let choice = role.choices.iter().find(|c| c.provider == provider)?;
    let m = choice.models.iter().find(|m| m.value == model)?;
    let (agent, name) = (clean(&choice.label), clean(&m.label));
    Some(if name.starts_with(&agent) {
        name
    } else {
        format!("{agent} · {name}")
    })
}

/// A role's model as the screen says it: the catalog's name when it has one, else the engine's words.
pub fn role_words(role: &toolroll_api::ModelRole) -> String {
    model_words(role, &role.current).unwrap_or_else(|| clean(&role.words))
}

/// How a sign-in or install pane ended, said and kept on the screen (nothing of its output is kept).
pub fn ended(app: &mut App, code: Option<i64>, signal: Option<i64>) {
    let Some((agent, kind)) = app.agents_screen.as_mut().and_then(|s| s.pane.take()) else {
        return;
    };
    let command = agent_of(app, &agent)
        .and_then(|a| {
            if kind == "install" {
                a.setup.install.clone()
            } else {
                a.setup.sign_in.clone()
            }
        })
        .map(|c| clean(&c))
        .unwrap_or_else(|| {
            if kind == "install" {
                "The install".into()
            } else {
                "The sign-in".into()
            }
        });
    let key = if kind == "install" { "i" } else { "s" };
    let words = match (code, signal) {
        (Some(0), _) => None,
        (Some(c), _) => Some(format!(
            "{command} exited with an error (code {c}). Try again with {key}."
        )),
        (None, Some(sig)) => Some(format!(
            "{command} was stopped (signal {sig}). Try again with {key}."
        )),
        (None, None) => None,
    };
    match words {
        Some(w) => {
            if let Some(s) = app.agents_screen.as_mut() {
                s.outcome = Some((agent, w.clone()));
            }
            app.say(Tone::Said, w);
        }
        None => {
            if let Some(s) = app.agents_screen.as_mut() {
                s.outcome = None;
            }
        }
    }
}

/// The screen's dialogs, as the overlay draws them.
pub fn dialog_lines(app: &App, area: Rect) -> Option<(&'static str, Vec<Line<'static>>)> {
    let w = (area.width as usize).saturating_sub(10).clamp(24, 88);
    match &app.mode {
        Mode::ConfirmInstall {
            agent,
            name,
            command,
        } => {
            let mut lines = vec![Line::raw("")];
            lines.push(Line::from(Span::styled(
                format!("Install {name}? This runs:"),
                ink(),
            )));
            lines.push(Line::raw(""));
            for piece in wrap(&clean(command), w) {
                lines.push(Line::from(Span::styled(
                    format!("  {piece}"),
                    ink().add_modifier(Modifier::BOLD),
                )));
            }
            lines.push(Line::raw(""));
            if command.starts_with("npm ") {
                // npm reads the person's own settings, rightly theirs: said, with a registry that isn't the public one.
                for piece in wrap("It runs with your own npm settings (~/.npmrc: registry, proxy, sign-in). The package's install scripts run.", w) {
                    lines.push(Line::from(Span::styled(piece, ink())));
                }
                let setup = app
                    .agents
                    .as_ref()
                    .and_then(|a| a.agents.iter().find(|x| &x.id == agent))
                    .map(|a| &a.setup);
                if let Some(registry) = setup.and_then(|s| s.registry.as_deref()) {
                    for piece in wrap(
                        &format!("Registry: {} (from your ~/.npmrc)", clean(registry)),
                        w,
                    ) {
                        lines.push(Line::from(Span::styled(
                            piece,
                            ink().add_modifier(Modifier::BOLD),
                        )));
                    }
                }
                if setup.is_some_and(|s| s.registry_unsure) {
                    for piece in wrap("Your ~/.npmrc may set a different registry.", w) {
                        lines.push(Line::from(Span::styled(
                            piece,
                            ink().add_modifier(Modifier::BOLD),
                        )));
                    }
                }
                lines.push(Line::raw(""));
            }
            for piece in wrap("It downloads software from its publisher and runs it as you, in a pane here. Toolroll passes it none of its own credentials, and never runs it without this yes.", w) {
                lines.push(Line::from(Span::styled(piece, dim())));
            }
            lines.push(Line::raw(""));
            lines.push(Line::from(sheet::act("Enter", "Install it", true)));
            lines.push(Line::from(Span::styled("Any other key cancels.", dim())));
            Some((" Install ", lines))
        }
        Mode::ConfirmSignInAgain { words, .. } => {
            let mut lines = vec![Line::raw("")];
            for piece in wrap(words, w) {
                lines.push(Line::from(Span::styled(piece, ink())));
            }
            lines.push(Line::raw(""));
            for piece in wrap("It opens the agent's own sign-in in a pane here; finishing it replaces the sign-in in use.", w) {
                lines.push(Line::from(Span::styled(piece, dim())));
            }
            lines.push(Line::raw(""));
            lines.push(Line::from(sheet::act("Enter", "Sign in again", true)));
            lines.push(Line::from(Span::styled(
                "Any other key keeps it as it is.",
                dim(),
            )));
            Some((" Sign in again ", lines))
        }
        Mode::PickModel(p) => {
            let mut lines = vec![Line::raw("")];
            let rows = (area.height as usize).saturating_sub(8).clamp(3, 16);
            let top = p.selected.saturating_sub(rows.saturating_sub(1));
            // Each choice whole, wrapped under itself (never cut mid-word); the rows shown keep the picked one in view.
            let mut used = 0;
            for (i, (_, words)) in p.options.iter().enumerate().skip(top) {
                let here = i == p.selected;
                let pieces = wrap(words, w);
                if used + pieces.len() > rows && used > 0 {
                    break;
                }
                used += pieces.len();
                for (j, piece) in pieces.into_iter().enumerate() {
                    let mark = if here && j == 0 { "›" } else { " " };
                    let l = Line::from(Span::styled(
                        format!("{mark} {piece}"),
                        if here { ink() } else { Style::default() },
                    ));
                    lines.push(if here {
                        sheet::band(l, w + 2, selected())
                    } else {
                        l
                    });
                }
            }
            lines.push(Line::raw(""));
            let mut keys = sheet::act("Enter", "Choose", true);
            keys.push(Span::raw("   "));
            keys.extend(sheet::act("Esc", "Cancel", false));
            lines.push(Line::from(keys));
            let title: &'static str = match p.role.as_str() {
                "default" => " Default agent ",
                "plan" => " Planner ",
                "build" => " Builder ",
                _ => " Reviewer ",
            };
            Some((title, lines))
        }
        Mode::ConfirmModels(c) => {
            let mut lines = vec![Line::raw("")];
            for l in &c.lines {
                for piece in wrap(l, w) {
                    lines.push(Line::from(Span::styled(piece, ink())));
                }
            }
            lines.push(Line::raw(""));
            lines.push(Line::from(sheet::act("Enter", "Save these models", true)));
            if c.sign_in.is_some() {
                lines.push(Line::from(sheet::act("s", "Sign in to it first", false)));
            }
            lines.push(Line::from(Span::styled("Any other key cancels.", dim())));
            Some((" Change models ", lines))
        }
        _ => None,
    }
}

/// The key bar's keys while the screen is open.
pub fn bar_keys(app: &App) -> Vec<(String, &'static str)> {
    let focus = app.agents_screen.as_ref().map(|s| s.focus);
    let mut keys: Vec<(String, &'static str)> = vec![("j/k".into(), "move")];
    if focus == Some(Focus::Models) {
        keys.push((marks().enter.into(), "change"));
    } else {
        // Only what applies to the agent on screen.
        if let Some(a) = current(app) {
            if a.state == "not-installed" {
                if a.setup.can_install {
                    keys.push(("i".into(), "install"));
                }
            } else if a.setup.can_sign_in {
                keys.push((
                    "s".into(),
                    if a.ready { "sign in again" } else { "sign in" },
                ));
            }
        }
        keys.push(("y".into(), "copy commands"));
    }
    keys.push((
        "Tab".into(),
        if focus == Some(Focus::Models) {
            "agents"
        } else {
            "models"
        },
    ));
    keys.push(("r".into(), "check again"));
    keys.push(("Esc".into(), "back"));
    keys
}

/// The screen, in the panel's place.
pub fn draw(f: &mut Frame, app: &mut App, area: Rect) {
    let Some(screen) = app.agents_screen.clone() else {
        return;
    };
    let w = area.width as usize;
    // The head: the title, the last look, Check again.
    let checked = app
        .agents
        .as_ref()
        .and_then(|a| a.checked_at.as_deref())
        .map(|at| format!("checked {}", local_hhmm(at, app.utc_offset_secs)))
        .unwrap_or_else(|| "not checked yet".into());
    let mut head = vec![
        Span::styled("Agents", ink()),
        Span::styled(
            if screen.checking {
                "  checking…".to_string()
            } else {
                format!("  {checked}")
            },
            dim(),
        ),
    ];
    let again = sheet::button("Check again", "r", false);
    let pad = w.saturating_sub(sheet::spans_width(&head) + width(&again.content));
    head.push(Span::raw(" ".repeat(pad)));
    head.push(again);
    f.render_widget(Paragraph::new(Line::from(head)), Rect { height: 1, ..area });
    let Some(read) = app.agents.clone() else {
        f.render_widget(
            Paragraph::new(Span::styled("Reading this computer's agents…", dim())),
            Rect {
                y: area.y + 2,
                height: 1,
                ..area
            },
        );
        return;
    };
    // The models at the foot, the agents above.
    let models_h: u16 = if area.height >= 24 { 7 } else { 0 };
    let body = Rect {
        y: area.y + 2,
        height: area.height.saturating_sub(2 + models_h),
        ..area
    };
    // With one column, give an active setup attempt or its failure the space the list usually owns.
    let agent = current(app).cloned();
    let setup_visible = agent.as_ref().is_some_and(|a| {
        screen.pane.iter().chain(&screen.outcome).any(|(id, _)| id == &a.id)
    });
    let detail_only = body.width < 90 && screen.focus == Focus::Agents && setup_visible;
    let list_w: u16 = if body.width >= 90 { 34 } else { body.width };
    let list = Rect {
        width: list_w,
        ..body
    };
    let mut lines: Vec<Line<'static>> = vec![];
    let here = agent.as_ref().map(|a| &a.id);
    for (gi, (label, rows)) in groups(&read).into_iter().enumerate() {
        if gi > 0 {
            lines.push(Line::raw(""));
        }
        lines.push(Line::from(vec![
            Span::styled(label.to_string(), ink()),
            sheet::count(rows.len(), false),
        ]));
        for a in rows {
            let (_, mark, role) = status_of(a);
            let mark_style = match role {
                Some(Role::Passed) => passed(),
                _ if a.state == "not-installed" || a.state == "unknown" => dim(),
                _ => needs_you(),
            };
            let on = Some(&a.id) == here;
            let name = fit(&clean(&a.name), (list_w as usize).saturating_sub(4));
            let l = Line::from(vec![
                Span::styled(format!("{mark} "), mark_style),
                Span::styled(name, if on { ink() } else { Style::default() }),
            ]);
            lines.push(if on && screen.focus == Focus::Agents {
                sheet::band(l, list_w as usize, selected())
            } else {
                l
            });
        }
    }
    if !detail_only {
        f.render_widget(Paragraph::new(lines), list);
    }
    // The agent on screen: its status, how to add it, and its pane.
    let detail = if detail_only {
        body
    } else if list_w < body.width {
        Rect {
            x: body.x + list_w + 3,
            width: body.width.saturating_sub(list_w + 3),
            ..body
        }
    } else {
        Rect { height: 0, ..body }
    };
    if let Some(a) = agent {
        draw_agent(f, app, &a, detail);
    }
    if models_h > 0 {
        draw_models(
            f,
            &screen,
            Rect {
                y: area.bottom().saturating_sub(models_h),
                height: models_h,
                ..area
            },
        );
    }
}

fn draw_agent(f: &mut Frame, app: &mut App, a: &AgentRow, area: Rect) {
    if area.height == 0 || area.width < 20 {
        return;
    }
    let w = area.width as usize;
    let (words, _, role) = status_of(a);
    let badge = match role {
        Some(r) => sheet::badge(&words, r),
        None if a.state == "not-installed" => sheet::badge(&words, Role::Fill),
        None => sheet::chip(&words),
    };
    let mut lines = vec![Line::from(vec![
        Span::styled(clean(&a.name), ink()),
        Span::raw("  "),
        badge,
    ])];
    if let Some(next) = &a.next {
        for piece in wrap(&clean(next), w) {
            lines.push(Line::from(Span::styled(piece, dim())));
        }
    }
    lines.push(Line::raw(""));
    let command =
        |lines: &mut Vec<Line<'static>>, label: &str, cmd: &str, act: Option<Span<'static>>| {
            let mut l = vec![
                Span::styled(format!("{label:<9}"), dim()),
                Span::styled(clean(cmd), ink()),
            ];
            if let Some(b) = act {
                l.push(Span::raw("  "));
                l.push(b);
            }
            lines.push(sheet::band(Line::from(l), w, crate::theme::raised()));
        };
    // Installed already: no install line (its command is still in what y copies).
    if let Some(c) = a
        .setup
        .install
        .as_ref()
        .filter(|_| a.state == "not-installed")
    {
        let act = a
            .setup
            .can_install
            .then(|| sheet::button("Install", "i", true));
        command(&mut lines, "Install", c, act);
    }
    if let Some(c) = &a.setup.sign_in {
        let wants = a.state == "signed-out" || a.state == "unknown";
        let label = if a.ready { "Sign in again" } else { "Sign in" };
        let act = (a.setup.can_sign_in && a.state != "not-installed")
            .then(|| sheet::button(label, "s", wants));
        command(&mut lines, "Sign in", c, act);
    }
    let outcome = app
        .agents_screen
        .as_ref()
        .and_then(|s| s.outcome.clone())
        .filter(|(id, _)| *id == a.id);
    if let Some((_, words)) = outcome {
        lines.push(Line::raw(""));
        for piece in wrap(&words, w) {
            lines.push(Line::from(Span::styled(piece, crate::theme::failed())));
        }
    }
    if let Some(c) = &a.setup.check {
        command(&mut lines, "Check", c, None);
    }
    for (label, text) in [("Key", &a.setup.key), ("Note", &a.setup.note)] {
        if let Some(t) = text {
            for (i, piece) in wrap(&clean(t), w.saturating_sub(9)).into_iter().enumerate() {
                lines.push(Line::from(vec![
                    Span::styled(format!("{:<9}", if i == 0 { label } else { "" }), dim()),
                    Span::raw(piece),
                ]));
            }
        }
    }
    lines.push(Line::raw(""));
    for piece in wrap(
        "y copies every command to your terminal's scrollback. Toolroll never reads an agent's own sign-in.",
        w,
    ) {
        lines.push(Line::from(Span::styled(piece, dim())));
    }
    let used = lines.len() as u16;
    f.render_widget(
        Paragraph::new(lines),
        Rect {
            height: used.min(area.height),
            ..area
        },
    );
    // Its pane, under the commands.
    let id = a.id.clone();
    let typing = app.mode == Mode::TakeOver;
    let Some(pane) = app
        .term
        .as_mut()
        .filter(|p| p.task.strip_prefix("agent:") == Some(id.as_str()))
    else {
        return;
    };
    let top = area.y + used + 1;
    if top + 4 >= area.bottom() {
        return;
    }
    let state = match &pane.link {
        crate::term::Link::Opening => ("Opening…".to_string(), dim()),
        crate::term::Link::Attaching => ("Attaching…".to_string(), dim()),
        crate::term::Link::Live if typing => ("Typing · Ctrl-] goes back".to_string(), ink()),
        crate::term::Link::Live => ("Running · t to type".to_string(), running()),
        crate::term::Link::Ended { code, .. } => (
            format!(
                "Ended{} · looking for agents again",
                code.map(|c| format!(" (exit {c})")).unwrap_or_default()
            ),
            dim(),
        ),
        crate::term::Link::Closed(words) => (clean(words), dim()),
    };
    f.render_widget(
        Paragraph::new(Line::from(Span::styled(fit(&state.0, w), state.1))),
        Rect {
            y: top,
            height: 1,
            ..area
        },
    );
    let frame = Rect {
        y: top + 1,
        height: area.bottom().saturating_sub(top + 1),
        ..area
    };
    let inset = if crate::theme::fills() {
        crate::theme::ground()
    } else {
        crate::theme::base()
    };
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

fn draw_models(f: &mut Frame, screen: &Screen, area: Rect) {
    let w = area.width as usize;
    let mut lines = vec![
        Line::from(Span::styled("─".repeat(w), line())),
        Line::from(vec![
            Span::styled("Models", ink()),
            Span::styled("  which agent plans, builds and reviews", dim()),
        ]),
    ];
    let Some(models) = screen.models.as_ref() else {
        lines.push(Line::from(Span::styled("Reading…", dim())));
        f.render_widget(Paragraph::new(lines), area);
        return;
    };
    let default = models
        .default_agent
        .as_deref()
        .map(|d| match d {
            "claude" => "Claude Code".to_string(),
            "codex" => "Codex".to_string(),
            other => clean(other),
        })
        .unwrap_or_else(|| "not chosen yet".into());
    let mut rows: Vec<(String, String)> = vec![("Default for new tasks".into(), default)];
    for r in &models.roles {
        rows.push((clean(&r.label), role_words(r)));
    }
    let label_w = rows
        .iter()
        .map(|(l, _)| width(l))
        .max()
        .unwrap_or(10)
        .min(28)
        + 2;
    for (i, (label, words)) in rows.into_iter().enumerate() {
        let on = screen.focus == Focus::Models && i == screen.row;
        let l = Line::from(vec![
            Span::styled(format!("{:<label_w$}", fit(&label, label_w - 2)), dim()),
            Span::styled(
                fit(&words, w.saturating_sub(label_w)),
                if on { ink() } else { Style::default() },
            ),
        ]);
        lines.push(if on { sheet::band(l, w, selected()) } else { l });
    }
    let said = if !models.can_change {
        Some(MODELS_LOCKED.to_string())
    } else {
        models.problem.as_deref().map(clean)
    };
    if let Some(said) = said {
        for piece in wrap(&said, w) {
            lines.push(Line::from(Span::styled(piece, dim())));
        }
    }
    f.render_widget(Paragraph::new(lines), area);
}

/// An ISO time ("2026-11-16T06:49:12.000Z") as the person's own clock says it ("22:49"), `offset` seconds from UTC
/// (run.rs reads it from the system at start; tests use 0). Anything else is shown as it came, cut to its time.
pub fn local_hhmm(iso: &str, offset: i64) -> String {
    let parsed = (|| {
        let y: i64 = iso.get(0..4)?.parse().ok()?;
        let mo: i64 = iso.get(5..7)?.parse().ok()?;
        let d: i64 = iso.get(8..10)?.parse().ok()?;
        let h: i64 = iso.get(11..13)?.parse().ok()?;
        let mi: i64 = iso.get(14..16)?.parse().ok()?;
        if !iso.ends_with('Z')
            || !(1..=12).contains(&mo)
            || !(1..=31).contains(&d)
            || h > 23
            || mi > 59
        {
            return None;
        }
        // Days from the civil date (Howard Hinnant's algorithm), only for the time of day.
        let (y, m) = if mo <= 2 {
            (y - 1, mo + 9)
        } else {
            (y, mo - 3)
        };
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let doy = (153 * m + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era * 146_097 + doe - 719_468;
        Some(days * 86_400 + h * 3600 + mi * 60)
    })();
    match parsed {
        Some(secs) => {
            let t = (secs + offset).rem_euclid(86_400);
            format!("{:02}:{:02}", t / 3600, (t % 3600) / 60)
        }
        None => clean(iso.get(11..16).unwrap_or(iso)),
    }
}
