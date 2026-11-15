//! A run's live records as the Live tab's cards: the agent's words, each step with how it ended, and its subagents
//! nested under the step that started them. Display only: the records are the engine's sanitised copy, cleaned again
//! here before they reach the terminal.
use crate::app::Transcript;
use crate::text::{clean, wrap};
use crate::theme::{dim, failed, ink, marks, passed, running};
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use std::collections::HashMap;
use toolroll_api::LiveRecord;

pub fn verb(kind: &str) -> &'static str {
    match kind {
        "edit" => "Edited",
        "command" => "Ran",
        "read" => "Read",
        "search" => "Searched",
        "lookup" => "Looked up",
        "plan" => "Planned",
        "delegate" => "Asked a helper:",
        "tool" => "Used",
        _ => "Did",
    }
}

struct Done<'a> {
    ok: Option<bool>,
    out: Option<&'a Vec<String>>,
}

/// Push `text` wrapped to `width`, each line after `prefix` (the first line after `first`).
fn push_wrapped(
    out: &mut Vec<Line<'static>>,
    prefix: &str,
    first: Vec<Span<'static>>,
    text: &str,
    style: Style,
    width: usize,
    tail: Vec<Span<'static>>,
) {
    let lead: usize = first
        .iter()
        .map(|s| crate::text::width(&s.content))
        .sum::<usize>()
        + crate::text::width(prefix);
    let lines = wrap(&clean(text), width.saturating_sub(lead).max(8));
    let n = lines.len();
    for (i, line) in lines.into_iter().enumerate() {
        let mut spans = vec![Span::styled(prefix.to_string(), dim())];
        if i == 0 {
            spans.extend(first.clone());
        } else {
            spans.push(Span::raw(" ".repeat(lead - crate::text::width(prefix))));
        }
        spans.push(Span::styled(line, style));
        if i + 1 == n {
            spans.extend(tail.clone());
        }
        out.push(Line::from(spans));
    }
}

/// `ended`: the stream these records are of has ended, so a step with no answer isn't running (it shows no mark).
#[allow(clippy::too_many_arguments)]
fn record_lines(
    out: &mut Vec<Line<'static>>,
    records: &[&LiveRecord],
    done: &HashMap<(Option<i64>, String), Done>,
    prefix: &str,
    width: usize,
    children: &HashMap<String, Vec<i64>>,
    subs: &HashMap<i64, Vec<&LiveRecord>>,
    ended: bool,
) {
    for r in records {
        match r {
            LiveRecord::Say { t, .. } => {
                for text in t {
                    push_wrapped(
                        out,
                        prefix,
                        vec![Span::raw("  ")],
                        text,
                        Style::default(),
                        width,
                        vec![],
                    );
                }
            }
            LiveRecord::Step {
                id,
                kind,
                target,
                s,
                ..
            } => {
                // A helper's step with no answer of its own reads as its helpers' end.
                let helpers_ended = children.get(id).map(|streams| {
                    streams
                        .iter()
                        .map(|st| stream_end(subs, *st))
                        .collect::<Vec<_>>()
                });
                let answered = done.get(&(*s, id.clone()));
                let state = answered.map(|d| d.ok).or_else(|| match &helpers_ended {
                    Some(ends) if !ends.is_empty() && ends.iter().all(|e| e.is_some()) => {
                        Some(if ends.contains(&Some(Some(false))) {
                            Some(false)
                        } else {
                            Some(true)
                        })
                    }
                    _ => None,
                });
                let (mark, mark_style) = match state {
                    None if ended => (marks().ended, dim()),
                    None => (marks().running, running()),
                    Some(Some(false)) => (marks().failed, failed()),
                    Some(_) => (marks().passed, passed()),
                };
                let mut tail = vec![];
                if let Some(first) = answered.and_then(|d| d.out).and_then(|o| o.first()) {
                    tail.push(Span::styled(format!("  {}", clean(first)), dim()));
                }
                let what = format!("{} {}", verb(kind), target.as_deref().unwrap_or(""));
                push_wrapped(
                    out,
                    prefix,
                    vec![Span::styled(format!("{mark} "), mark_style)],
                    what.trim_end(),
                    Style::default(),
                    width,
                    tail,
                );
                // Its helpers, nested under it.
                for stream in children.get(id).into_iter().flatten() {
                    sub_lines(
                        out,
                        *stream,
                        subs,
                        done,
                        &format!("{prefix}  "),
                        width,
                        ended,
                    );
                }
            }
            LiveRecord::Cut { .. } => out.push(Line::from(Span::styled(
                format!("{prefix}  … earlier output was cut"),
                dim(),
            ))),
            LiveRecord::Cap { .. } => out.push(Line::from(Span::styled(
                format!("{prefix}  Output limit reached. The rest is in the browser (w)."),
                dim(),
            ))),
            LiveRecord::Over {} => out.push(Line::from(Span::styled(
                format!("{prefix}  The output ended."),
                dim(),
            ))),
            LiveRecord::Start { s: None, .. } => out.push(Line::from(Span::styled(
                format!("{prefix}  Started."),
                dim(),
            ))),
            _ => {}
        }
    }
}

/// How a helper's stream ended: None while it runs, Some(ok) once its end record arrived.
fn stream_end(subs: &HashMap<i64, Vec<&LiveRecord>>, stream: i64) -> Option<Option<bool>> {
    subs.get(&stream)?.iter().find_map(|r| match r {
        LiveRecord::End { ok, .. } => Some(*ok),
        _ => None,
    })
}

fn sub_lines(
    out: &mut Vec<Line<'static>>,
    stream: i64,
    subs: &HashMap<i64, Vec<&LiveRecord>>,
    done: &HashMap<(Option<i64>, String), Done>,
    prefix: &str,
    width: usize,
    run_ended: bool,
) {
    let records = subs.get(&stream).cloned().unwrap_or_default();
    let desc = records.iter().find_map(|r| match r {
        LiveRecord::Child { desc, .. } => desc.clone(),
        _ => None,
    });
    out.push(Line::from(vec![
        Span::styled(format!("{prefix}┌ "), dim()),
        Span::styled(
            format!("Helper: {}", clean(desc.as_deref().unwrap_or("working"))),
            ink(),
        ),
    ]));
    let body: Vec<&LiveRecord> = records
        .iter()
        .copied()
        .filter(|r| !matches!(r, LiveRecord::Child { .. } | LiveRecord::End { .. }))
        .collect();
    let end = stream_end(subs, stream);
    record_lines(
        out,
        &body,
        done,
        &format!("{prefix}│"),
        width,
        &HashMap::new(),
        &HashMap::new(),
        run_ended || end.is_some(),
    );
    match end {
        Some(Some(false)) => out.push(Line::from(vec![
            Span::styled(format!("{prefix}└ "), dim()),
            Span::styled(format!("{} Helper failed", marks().failed), failed()),
        ])),
        Some(_) => out.push(Line::from(Span::styled(
            format!("{prefix}└ Helper finished"),
            dim(),
        ))),
        None => out.push(Line::from(vec![
            Span::styled(format!("{prefix}└ "), dim()),
            Span::styled(format!("{} Helper working", marks().running), running()),
        ])),
    }
}

/// The transcript's lines at this width.
/// The transcript's lines at this width, from main record `from` on (the Live tab lays out only the tail it shows
/// while it follows the newest; a step's answer always comes after it, so the tail holds every answer it needs).
pub fn lines(t: &Transcript, width: usize, from: usize) -> Vec<Line<'static>> {
    let tail = &t.main[from.min(t.main.len())..];
    let mut done: HashMap<(Option<i64>, String), Done> = HashMap::new();
    for r in tail.iter().chain(t.sub.iter()) {
        if let LiveRecord::Done { id, ok, out, s, .. } = r {
            done.insert(
                (*s, id.clone()),
                Done {
                    ok: *ok,
                    out: out.as_ref(),
                },
            );
        }
    }
    let mut subs: HashMap<i64, Vec<&LiveRecord>> = HashMap::new();
    let mut children: HashMap<String, Vec<i64>> = HashMap::new();
    let mut orphans: Vec<i64> = vec![];
    for r in &t.sub {
        if let Some(s) = r.stream() {
            subs.entry(s).or_default().push(r);
        }
        if let LiveRecord::Child { s, parent, .. } = r {
            let step_in = |records: &[LiveRecord]| {
                parent.as_ref().is_some_and(|p| {
                    records
                        .iter()
                        .any(|m| matches!(m, LiveRecord::Step { id, .. } if id == p))
                })
            };
            // Nested under its step when the step is shown; above the tail when its step is; else after the rest.
            if step_in(tail) {
                children
                    .entry(parent.clone().unwrap())
                    .or_default()
                    .push(*s);
            } else if !step_in(&t.main) {
                orphans.push(*s);
            }
        }
    }
    let main: Vec<&LiveRecord> = tail.iter().filter(|r| r.stream().is_none()).collect();
    let mut out = vec![];
    record_lines(&mut out, &main, &done, "", width, &children, &subs, !t.live);
    for s in orphans {
        sub_lines(&mut out, s, &subs, &done, "", width, !t.live);
    }
    out
}
