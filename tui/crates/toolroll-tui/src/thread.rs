//! A Flexible thread as one more live session (F3): listed with the work, its panel shows the agent's transcript (the
//! same cards as a build's), its questions with where each answer stands, and the turn's level and cost.
//!
//! Answering: `1-9` picks an option of the question shown (the first one waiting on you that this console can answer),
//! pinning that question's request, its card digest and the option's exact words; Enter in the dialog posts exactly
//! those (POST /agents/live/thread/<id>/answer), only while the same question still waits with the same card, and only
//! once the question and the answer were drawn whole. The engine decides and sends it through F2d with this session's
//! person: the screen never decides anything, and a model never answers. Agent text is cleaned again before it is drawn.
use crate::app::{App, Item, Mode, Section, Tone, Transcript};
use crate::text::{clean, fit, wrap};
use crate::theme::{dim, failed, ink, marks, needs_you, passed, running, selected};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;
use toolroll_api::{LiveThreads, ThreadFacts, ThreadQuestion, ThreadRow};

/// Said when a thread's question changed (or was answered elsewhere) while its dialog was open.
pub const THREAD_QUESTION_CHANGED: &str = "This question changed — look again.";
/// Said when a question can't be answered here (more than one part, or no options to pick from).
pub const THREAD_ANSWER_ELSEWHERE: &str =
    "This question can't be answered with a number here — it has more than one part or no options.";

/// The threads the console listed, and the one being watched.
#[derive(Debug, Default)]
pub struct Threads {
    /// The console said threads aren't available (Flexible is off): they are never asked for again.
    pub off: bool,
    pub fetching: bool,
    pub rows: Vec<ThreadRow>,
    pub view: Option<ThreadView>,
}

/// The watched thread: its records, its facts (level, cost, questions) and the answer on its way.
#[derive(Debug, Default)]
pub struct ThreadView {
    pub id: String,
    pub transcript: Transcript,
    pub facts: Option<ThreadFacts>,
    pub fetching: bool,
    /// The request whose answer was posted and hasn't been answered yet (shown as sending).
    pub sending: Option<String>,
}

/// What a dialog showed, pinned when it opened: the request, the card digest, the option's place and exact words, and
/// what is posted for it.
#[derive(Debug, Clone, PartialEq)]
pub struct ThreadPin {
    pub thread: String,
    pub request: String,
    pub digest: String,
    pub index: usize,
    pub label: String,
    /// `decision` (accept or decline) for a permission; `question` and `answer` (the label) for a question.
    pub fields: Vec<(String, String)>,
}

impl Threads {
    /// The list's rows from the console's answer.
    pub fn listed(&mut self, list: LiveThreads) {
        self.fetching = false;
        self.rows = list.threads;
    }

    /// The thread items for the left column: waiting on you, or working.
    pub fn items(&self) -> Vec<Item> {
        self.rows
            .iter()
            .map(|t| {
                let level = level_words(t.level.as_deref());
                let cost = t
                    .cost_usd
                    .map(|c| format!(" · ${c:.2}"))
                    .unwrap_or_default();
                Item {
                    section: if t.waiting > 0 {
                        Section::NeedsYou
                    } else {
                        Section::Working
                    },
                    id: t.id.clone(),
                    title: clean(&t.title),
                    word: if t.waiting > 0 {
                        "Question".into()
                    } else if t.live {
                        "Thread".into()
                    } else {
                        "Idle".into()
                    },
                    detail: format!("Thread · {level}{cost}"),
                    tone: if t.waiting > 0 { "attention" } else { "live" }.into(),
                    paused: !t.live && t.waiting == 0,
                    age: String::new(),
                    project: t.project.as_deref().map(clean),
                    need: None,
                    is_task: false,
                    thread: true,
                }
            })
            .collect()
    }
}

pub fn level_words(level: Option<&str>) -> &'static str {
    match level {
        Some("supervised") => "Supervised",
        Some("auto") => "Auto",
        Some("full") => "Full access",
        _ => "level not set",
    }
}

/// The question the panel offers to answer: the first one waiting on you that this console can answer.
pub fn shown_question(facts: &ThreadFacts) -> Option<&ThreadQuestion> {
    facts
        .questions
        .iter()
        .find(|q| q.state == "pending" && q.answerable)
}

/// The options a question offers, in order: Allow and Deny for a permission, the one part's options for a question.
pub fn options_of(q: &ThreadQuestion) -> Option<Vec<String>> {
    if q.kind == "permission" {
        return Some(vec!["Allow".into(), "Deny".into()]);
    }
    match q.parts.as_slice() {
        [one] if !one.options.is_empty() => Some(one.options.iter().take(9).cloned().collect()),
        _ => None,
    }
}

/// Pin option `n` (0-based) of the question shown, or say why there's nothing to pin.
pub fn pin(view: &ThreadView, n: usize) -> Result<ThreadPin, String> {
    let q = view
        .facts
        .as_ref()
        .and_then(shown_question)
        .ok_or_else(|| "No question is waiting on you in this thread.".to_string())?;
    let options = options_of(q).ok_or_else(|| THREAD_ANSWER_ELSEWHERE.to_string())?;
    let label = options
        .get(n)
        .ok_or_else(|| format!("There's no answer {}.", n + 1))?
        .clone();
    let fields = if q.kind == "permission" {
        vec![(
            "decision".to_string(),
            if n == 0 { "accept" } else { "decline" }.to_string(),
        )]
    } else {
        vec![
            ("question".to_string(), q.parts[0].id.clone()),
            ("answer".to_string(), label.clone()),
        ]
    };
    Ok(ThreadPin {
        thread: view.id.clone(),
        request: q.request.clone(),
        digest: q.digest.clone(),
        index: n,
        label,
        fields,
    })
}

/// Whether a pin still names what the panel shows: the same thread, the same question still waiting with the same
/// card, and the same option in the same place.
pub fn stands(view: Option<&ThreadView>, pin: &ThreadPin) -> bool {
    let Some(view) = view.filter(|v| v.id == pin.thread) else {
        return false;
    };
    let Some(q) = view.facts.as_ref().and_then(shown_question) else {
        return false;
    };
    q.request == pin.request
        && q.digest == pin.digest
        && options_of(q).is_some_and(|o| o.get(pin.index) == Some(&pin.label))
}

/// The form an answer posts: the request, the card digest shown, and the choice.
pub fn answer_fields(pin: &ThreadPin) -> Vec<(&str, String)> {
    let mut fields = vec![
        ("request", pin.request.clone()),
        ("card", pin.digest.clone()),
    ];
    fields.extend(pin.fields.iter().map(|(k, v)| (k.as_str(), v.clone())));
    fields
}

/// Where an answer stands, in plain words, with its mark and style.
pub fn state_words(q: &ThreadQuestion, sending: bool) -> (&'static str, &'static str, Style) {
    let m = marks();
    if sending {
        return (m.running, "Sending…", running());
    }
    match q.state.as_str() {
        "pending" if q.answerable => (m.needs, "Waiting for you", needs_you()),
        "pending" => (m.todo, "Can't be answered here", dim()),
        "decided" | "sending" => (m.running, "Sending…", running()),
        "sent" => (m.running, "Sent, not yet confirmed", running()),
        "delivered" => (m.passed, "Received by the agent", passed()),
        "uncertain" => (m.failed, "Not confirmed — check its activity", failed()),
        "not-sent" => (m.skipped, "Not sent", dim()),
        "withdrawn" => (m.ended, "Withdrawn — the turn ended", dim()),
        _ => (m.ended, "Unknown", dim()),
    }
}

/// The head's second line: agent, level, turn and its cost.
fn facts_line(facts: &ThreadFacts) -> String {
    let mut parts = vec![];
    if let Some(agent) = &facts.agent {
        parts.push(format!(
            "{} · {}",
            clean(&agent.provider),
            clean(&agent.model)
        ));
    }
    parts.push(level_words(facts.level.as_deref()).to_string());
    if let Some(turn) = &facts.turn {
        let cost = match (turn.cost_usd, turn.cost_basis.as_deref()) {
            (Some(c), Some("estimated")) => format!(" · about ${c:.2}"),
            (Some(c), Some("unknown")) => format!(" · ${c:.2} so far, total unknown"),
            (Some(c), _) => format!(" · ${c:.2}"),
            (None, _) => " · no cost yet".into(),
        };
        parts.push(format!("turn {} {}{cost}", turn.seq, clean(&turn.status)));
    }
    parts.join(" · ")
}

/// The thread's panel (everything under the tabs): head, transcript, questions and the answer flow.
pub fn draw_panel(f: &mut Frame, app: &mut App, item: &Item, area: Rect) {
    let w = area.width as usize;
    let facts = app
        .threads
        .view
        .as_ref()
        .filter(|v| v.id == item.id)
        .and_then(|v| v.facts.clone());
    let sending = app.threads.view.as_ref().and_then(|v| v.sending.clone());
    let shown = facts.as_ref().and_then(shown_question).cloned();
    let options = shown.as_ref().and_then(options_of);
    // The question shown takes its words, its options and a blank line; every other question of the turn one line each.
    let others: Vec<ThreadQuestion> = facts
        .as_ref()
        .map(|f| {
            f.questions
                .iter()
                .filter(|q| Some(&q.request) != shown.as_ref().map(|s| &s.request))
                .rev()
                .take(3)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let q_lines = shown
        .as_ref()
        .map(|q| {
            3 + u16::from(q.detail.is_some())
                + options.as_ref().map(|o| o.len() as u16).unwrap_or(1)
        })
        .unwrap_or(0)
        + others.len() as u16;
    let input = matches!(app.mode, Mode::NewThread(_));
    let [head, content, qa, input_row] = Layout::vertical([
        Constraint::Length(2),
        Constraint::Min(1),
        Constraint::Length(q_lines),
        Constraint::Length(u16::from(input)),
    ])
    .areas(area);
    let title = facts
        .as_ref()
        .map(|f| clean(&f.title))
        .unwrap_or_else(|| item.title.clone());
    let second = facts
        .as_ref()
        .map(facts_line)
        .unwrap_or_else(|| item.detail.clone());
    f.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled(fit(&title, w), ink())),
            Line::from(Span::styled(fit(&second, w), dim())),
        ]),
        head,
    );
    // The transcript: the same cards as a build's live output.
    let lines: Vec<Line<'static>> = match app.threads.view.as_ref().filter(|v| v.id == item.id) {
        Some(v) if !v.transcript.main.is_empty() => {
            let all = crate::transcript::lines(&v.transcript, w, 0);
            let h = content.height as usize;
            all[all.len().saturating_sub(h)..].to_vec()
        }
        Some(v) if v.facts.is_none() => vec![Line::raw("Reading…")],
        _ => wrap("No output from the agent yet.", w)
            .into_iter()
            .map(Line::raw)
            .collect(),
    };
    f.render_widget(Paragraph::new(lines), content);
    // Questions.
    let mut lines = vec![];
    if let Some(q) = &shown {
        let (mark, words, style) = state_words(q, sending.as_deref() == Some(q.request.as_str()));
        lines.push(Line::from(vec![
            Span::styled(format!("{mark} "), style),
            Span::styled(
                fit(&clean(&q.title), w.saturating_sub(4 + words.len())),
                ink(),
            ),
            Span::styled(format!("  {words}"), dim()),
        ]));
        if let Some(detail) = &q.detail {
            lines.push(Line::from(Span::styled(
                format!("  {}", fit(&clean(detail), w.saturating_sub(2))),
                dim(),
            )));
        }
        if let Some(part) = q.parts.first().filter(|_| q.kind == "question") {
            lines.push(Line::from(Span::styled(
                format!("  {}", fit(&clean(&part.question), w.saturating_sub(2))),
                ink(),
            )));
        }
        match &options {
            Some(options) => {
                for (i, o) in options.iter().enumerate() {
                    let chosen = matches!(&app.mode, Mode::ConfirmThread(pin) if pin.index == i && pin.request == q.request);
                    lines.push(Line::from(Span::styled(
                        format!(
                            "  {}",
                            fit(&format!("{} {}", i + 1, clean(o)), w.saturating_sub(2))
                        ),
                        if chosen {
                            selected().add_modifier(Modifier::BOLD)
                        } else {
                            Style::default()
                        },
                    )));
                }
            }
            None => lines.push(Line::from(Span::styled(
                format!("  {}", fit(THREAD_ANSWER_ELSEWHERE, w.saturating_sub(2))),
                dim(),
            ))),
        }
        lines.push(Line::raw(""));
    }
    for q in &others {
        let (mark, words, style) = state_words(q, sending.as_deref() == Some(q.request.as_str()));
        // A question by its own words; a permission by what it asks. Then where its answer stands.
        let what = match q.parts.first() {
            Some(part) if q.kind == "question" => &part.question,
            _ => &q.title,
        };
        let room = w.saturating_sub(4 + crate::text::width(words)).max(10);
        lines.push(Line::from(vec![
            Span::styled(format!("{mark} "), style),
            Span::raw(fit(&clean(what), room)),
            Span::styled(format!("  {words}"), dim()),
        ]));
    }
    f.render_widget(Paragraph::new(lines), qa);
    if let Mode::NewThread(text) = &app.mode {
        f.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled("New thread: ", ink()),
                Span::raw(fit(text, w.saturating_sub(13))),
                Span::styled("▏", ink()),
            ])),
            input_row,
        );
    }
}

/// The answer dialog: the question, the chosen answer, every word (wrapped, never cut). When the window can't hold it
/// all, Enter sends nothing (`thread_shown` stays false).
pub fn confirm_lines(app: &mut App, area: Rect) -> Option<(&'static str, Vec<Line<'static>>)> {
    let Mode::ConfirmThread(pin) = &app.mode else {
        return None;
    };
    let view = app.threads.view.as_ref()?;
    let q = view
        .facts
        .as_ref()
        .and_then(shown_question)
        .filter(|q| q.request == pin.request)?
        .clone();
    let w = (area.width as usize).saturating_sub(8).min(72);
    let mut lines = vec![Line::raw("")];
    let said = |text: &str, style: Style, lines: &mut Vec<Line<'static>>| {
        lines.extend(
            wrap(&clean(text), w)
                .into_iter()
                .map(|l| Line::from(Span::styled(l, style))),
        );
    };
    said(&q.title, ink(), &mut lines);
    if let Some(detail) = &q.detail {
        said(detail, Style::default(), &mut lines);
    }
    if let Some(part) = q.parts.first().filter(|_| q.kind == "question") {
        said(&part.question, Style::default(), &mut lines);
    }
    lines.push(Line::raw(""));
    said(&format!("Your answer: {}", pin.label), ink(), &mut lines);
    lines.push(Line::raw(""));
    lines.push(Line::from(vec![
        Span::styled("Enter  ", ink()),
        Span::raw("Send it to the agent"),
    ]));
    lines.push(Line::from(Span::styled("Any other key cancels.", dim())));
    let fits = w >= 20 && lines.len() + 2 <= area.height as usize;
    app.thread_shown = fits;
    Some(if fits {
        (" Answer ", lines)
    } else {
        (
            " Answer ",
            wrap(crate::app::ANSWER_TOO_LONG, w.max(16))
                .into_iter()
                .map(|l| Line::from(Span::styled(l, ink())))
                .collect(),
        )
    })
}

/// After a refresh: a dialog whose question no longer stands closes, saying so (nothing is sent).
pub fn check_pin(app: &mut App) {
    if let Mode::ConfirmThread(pin) = &app.mode {
        if !stands(app.threads.view.as_ref(), pin) {
            app.mode = Mode::Normal;
            app.status = Some((Tone::Refused, THREAD_QUESTION_CHANGED.into()));
        }
    }
}
