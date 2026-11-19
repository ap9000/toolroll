//! Read the builder select from the signed-in task page. This also works with consoles
//! predating the terminal picker. Only the current version's configured build choices
//! and scope digest cross this boundary. The submit path is always built by the client.
use crate::{client::encode, ApiError, Client};
use scraper::{Html, Selector};
use serde::Deserialize;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskBuilder {
    pub digest: String,
    pub choices: Vec<String>,
    pub current: Option<String>,
}

#[derive(Deserialize)]
struct Workspace {
    version: u32,
    view: TaskPage,
}
#[derive(Deserialize)]
struct TaskPage {
    kind: String,
    sections: Vec<Section>,
}
#[derive(Deserialize)]
struct Section {
    id: String,
    html: String,
}

fn select(css: &str) -> Selector {
    Selector::parse(css).expect("constant CSS selector")
}

impl Client {
    pub async fn task_builder(&self, root: &str, task: &str) -> Result<TaskBuilder, ApiError> {
        let page: Workspace = self
            .get_json(
                &format!(
                    "/t/{}?format=workspace&version={}",
                    encode(root),
                    encode(task)
                ),
                "this task's builder choices",
            )
            .await?;
        let scope = page
            .view
            .sections
            .iter()
            .find(|s| s.id == "scope" && page.view.kind == "task" && page.version == 1)
            .ok_or_else(|| ApiError::Refused("The task has no editable plan.".into()))?;
        builder_form(task, &scope.html)
    }
}

fn builder_form(task: &str, html: &str) -> Result<TaskBuilder, ApiError> {
    let page = Html::parse_fragment(html);
    let expected = format!("/t/{}/route", encode(task));
    for form in page.select(&select(
        "#agents details.agents-change form.agents-form[method=post]",
    )) {
        if form.value().attr("action") != Some(expected.as_str())
            || form
                .select(&select("input[type=hidden][name=phase][value=build]"))
                .next()
                .is_none()
        {
            continue;
        }
        let digest = form
            .select(&select("input[type=hidden][name=sawDigest]"))
            .next()
            .and_then(|input| input.value().attr("value"))
            .filter(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(|| {
                ApiError::Contract("Reload the task to read its current plan version.".into())
            })?;
        let mut choices = Vec::new();
        let mut current = None;
        for option in form.select(&select(
            "select[name=agent]:not([disabled]) option:not([disabled])",
        )) {
            let Some(value) = option.value().attr("value") else {
                continue;
            };
            if !value
                .split_once('|')
                .is_some_and(|(p, m)| !p.is_empty() && !m.is_empty() && !m.contains('|'))
                || value.len() > 256
                || value.chars().any(char::is_control)
            {
                continue;
            }
            if option.value().attr("selected").is_some() {
                current = Some(value.to_string());
            }
            choices.push(value.to_string());
        }
        if !choices.is_empty() {
            return Ok(TaskBuilder {
                digest: digest.to_string(),
                choices,
                current,
            });
        }
    }
    Err(ApiError::Refused("The console offers no builder change for this task. Check its Agents section for permissions, a running attempt, or configured choices.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_offered_build_choices_on_the_exact_task_can_be_submitted() {
        let html = r#"<section id="agents"><details class="agents-change"><form method="post" action="/t/homepage/route" class="agents-form"><input type="hidden" name="phase" value="build"><input type="hidden" name="sawDigest" value="0123456789abcdef0123456789abcdef"><select name="agent"><option selected value="claude|opus">Current</option><option value="codex|sol">Codex</option><option disabled value="codex|other">Disabled</option></select></form></details></section>"#;
        let form = builder_form("homepage", html).unwrap();
        assert_eq!(form.choices, ["claude|opus", "codex|sol"]);
        assert_eq!(form.current.as_deref(), Some("claude|opus"));
        assert!(builder_form("different", html).is_err());
        assert!(builder_form(
            "homepage",
            &html.replace("value=\"build\"", "value=\"plan\"")
        )
        .is_err());
    }
}
