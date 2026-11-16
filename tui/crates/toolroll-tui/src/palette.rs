//! The command palette (`:` or Ctrl-K): fuzzy search over every action (with its key), task, project and setting.
//! Enter runs what is picked through exactly the code its key runs (app.rs `run_pick` → `run_action`), so a palette
//! act keeps every pin and confirm its key has: it is just another way to press the key.
use crate::app::{App, Section, Tab};
use crate::keys::{Action, Group, Scope, SPECS};
use crate::text::clean;

/// What a palette line does when picked.
#[derive(Debug, Clone, PartialEq)]
pub enum Pick {
    Action(Action),
    /// An answer to the question on screen: the same as pressing its number.
    Answer(usize),
    Task(String),
    Project(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    /// "Action", "Task", "Project", "Layout", "Filter", "Setting".
    pub kind: &'static str,
    pub label: String,
    /// The key that does the same, in words ("" when none).
    pub key: String,
    pub pick: Pick,
}

/// The palette while open: what is typed, and the line picked among the matches.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Palette {
    pub query: String,
    pub selected: usize,
}

/// Whether an action can be run from where the person is: Diff actions in the Diff tab of a task's result only.
fn applies(app: &App, action: Action) -> bool {
    let thread = app.selected_item().is_some_and(|i| i.thread);
    match action.scope() {
        Scope::Diff => app.tab == Tab::Diff && !thread,
        Scope::Global => match action {
            Action::Palette => false,
            Action::FilterThisProject => app.project.is_some(),
            _ => true,
        },
    }
}

/// Every line the palette offers now, in order: actions, answers to the question on screen, tasks, projects.
pub fn entries(app: &App) -> Vec<Entry> {
    let keymap = &app.prefs.settings.keymap;
    let mut out = vec![];
    for spec in SPECS {
        if !applies(app, spec.action) {
            continue;
        }
        let label = match spec.action {
            Action::Costs if app.prefs.settings.show_costs => "Hide costs, for this session".into(),
            Action::Costs => "Show costs, for this session".into(),
            Action::KeyBar if app.prefs.settings.key_bar => {
                "Hide the key bar, for this session".into()
            }
            Action::KeyBar => "Show the key bar, for this session".into(),
            Action::FilterAll
            | Action::FilterThisProject
            | Action::FilterNeedsMe
            | Action::FilterToday => {
                let on = app.filter.action() == Some(spec.action);
                format!("{}{}", spec.label, if on { " (on)" } else { "" })
            }
            _ => spec.label.to_string(),
        };
        let kind = match spec.group {
            Group::Diff => "Diff",
            g => g.word(),
        };
        out.push(Entry {
            kind,
            label,
            key: keymap.key_words(spec.action),
            pick: Pick::Action(spec.action),
        });
    }
    if let Some(q) = app.selected_item().and_then(|i| i.question()) {
        for (n, o) in q.options.iter().take(9).enumerate() {
            out.push(Entry {
                kind: "Answer",
                label: clean(&o.label),
                key: (n + 1).to_string(),
                pick: Pick::Answer(n),
            });
        }
    }
    for item in &app.all_items {
        let kind = match item.section {
            Section::NeedsYou => "Needs you",
            _ => "Task",
        };
        out.push(Entry {
            kind,
            label: item.title.clone(),
            key: String::new(),
            pick: Pick::Task(item.id.clone()),
        });
    }
    let mut projects: Vec<String> = app
        .all_items
        .iter()
        .filter_map(|i| i.project.clone())
        .filter(|p| !p.is_empty())
        .collect();
    projects.sort();
    projects.dedup();
    for p in projects {
        out.push(Entry {
            kind: "Project",
            label: p.clone(),
            key: String::new(),
            pick: Pick::Project(p),
        });
    }
    out
}

/// How well `query` matches `text` (None: not at all): every query character in order, case-insensitively; runs of
/// consecutive characters and starts of words score higher, an earlier first match a little higher.
pub fn score(query: &str, text: &str) -> Option<i64> {
    let q: Vec<char> = query
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect();
    if q.is_empty() {
        return Some(0);
    }
    let t: Vec<char> = text.chars().flat_map(char::to_lowercase).collect();
    let mut score = 0i64;
    let mut at = 0usize;
    let mut last: Option<usize> = None;
    let mut first: Option<usize> = None;
    for qc in q {
        let found = (at..t.len()).find(|&i| t[i] == qc)?;
        first.get_or_insert(found);
        score += 1;
        if last.is_some_and(|l| l + 1 == found) {
            score += 5;
        }
        if found == 0 || !t[found - 1].is_alphanumeric() {
            score += 3;
        }
        last = Some(found);
        at = found + 1;
    }
    Some(score * 100 - first.unwrap_or(0) as i64)
}

/// The lines matching what is typed, best first (ties keep the palette's order).
pub fn matches(app: &App, query: &str) -> Vec<Entry> {
    let mut scored: Vec<(i64, usize, Entry)> = entries(app)
        .into_iter()
        .enumerate()
        .filter_map(|(i, e)| {
            let hay = format!("{} {}", e.label, e.kind);
            score(query, &hay).map(|s| (s, i, e))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    scored.into_iter().map(|(_, _, e)| e).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fuzzy_matching() {
        assert!(score("acc", "Accept the result").is_some());
        assert!(score("atr", "Accept the result").is_some());
        assert!(score("xyz", "Accept the result").is_none());
        assert!(score("", "anything").is_some());
        // A run and a word start beat scattered letters.
        assert!(score("acc", "Accept") > score("acc", "a cat climbs"));
        assert!(score("new", "New task") > score("new", "Next window"));
        // Case doesn't matter.
        assert_eq!(score("ACC", "accept"), score("acc", "accept"));
    }
}
