//! `toolroll-tui view read | set | reset`: the workbench's look, read and changed without a screen, for the person's
//! own lead ("restyle my workbench") and the CLI's undo (`toolroll view theme set`, `toolroll view reset`).
//!
//! One safety story: every write goes through the Settings screen's own writer (settings.rs write_safely: every folder
//! up to the root trusted, the file opened and replaced relative to its folder, never through a link, 0600, comments and
//! unknown keys kept), and every result is read back with the same strict reader the screen uses. Data only: a theme
//! is a base and role colours; nothing here runs anything.
//!
//! Never through here: `[keys]`. A remapped key could make a consequential act (accept, cancel) a one-key accident, so
//! keys stay with the person (tui.toml, or the Settings screen).
use crate::settings::{self, Env, FileState, Settings};
use crate::theme::{Depth, Rgb, Role, Theme, ThemeName};
use serde_json::{json, Map, Value};

/// What `read` says about styling, for an agent that will change it.
pub const GUIDE: &str = "Change the look with toolroll_view_set: a built-in theme (terminal, light, dark, high-contrast), \
a saved theme (save_theme: a name, a built-in base and role colours; use: true switches to it), or role colours \
(colors). Every pair of colours the screen draws must keep its contrast, as a 256-colour terminal shows it too: text \
4.5:1, marks 3:1 — a change that breaks one is refused with the reason. Status colours (needs-you, running, passed, \
failed and their -soft badges) come from the themes only and can't be set here. At 16 colours (or with NO_COLOR) role \
colours aren't used and the base theme's terminal colours show, so pick a base that suits the person's terminal. \
Notifications, the key bar, costs and columns can be turned on or added, never off or removed: that is the person's \
to do. Keys can't be changed here: they stay with the person (tui.toml's [keys], or the Settings screen), so an \
accept or a cancel never becomes a one-key accident.";

/// The longest change accepted, and the most role colours in one.
const MAX_INPUT: usize = 16 * 1024;
const MAX_COLORS: usize = 16;

/// Run `view <verb>`: the JSON answer on standard output and the exit code (0 done, 1 refused, 2 misuse).
pub fn main(args: &[String], input: &str) -> (i32, String) {
    let env = Env::from_process();
    let answer = match args.first().map(String::as_str) {
        Some("read") => Ok(read(&env)),
        Some("set") => set(&env, input).map(|changed| json!({ "ok": true, "changed": changed })),
        Some("reset") => reset(&env).map(|said| json!({ "ok": true, "said": said })),
        _ => {
            return (
                2,
                json!({ "ok": false, "why": "view read | view set (a change on standard input) | view reset" })
                    .to_string(),
            )
        }
    };
    match answer {
        Ok(v) => (0, v.to_string()),
        Err(why) => (1, json!({ "ok": false, "why": why }).to_string()),
    }
}

fn file_words(state: &FileState) -> String {
    match state {
        FileState::Missing => "missing (the defaults)".into(),
        FileState::Read => "read".into(),
        FileState::Ignored(why) => format!("ignored: {why}"),
    }
}

/// The settings in use, what may be changed (and to what), the theme roles, the themes, and the guide.
pub fn read(env: &Env) -> Value {
    let (s, path, file, warnings) = settings::load(env);
    let colors: Map<String, Value> = s
        .colors
        .iter()
        .map(|(r, c)| (r.key().to_string(), json!(c.hex())))
        .collect();
    json!({
        "settings": settings_json(&s),
        "colors": colors,
        "file": { "state": file_words(&file), "exists": path.is_some_and(|p| p.exists()), "warnings": warnings },
        "allowed": {
            "theme": "terminal | light | dark | high-contrast | a saved theme's name",
            "save_theme": { "name": format!("lowercase letters, digits and dashes, at most {}", settings::THEME_NAME_MAX), "base": "terminal | light | dark | high-contrast", "colors": "role → #rrggbb", "use": "true to switch to it" },
            "colors": "role → #rrggbb (laid over the theme; never a status role)",
            "density": ["compact", "comfortable"],
            "glyphs": ["unicode", "ascii", "nerd"],
            "columns": { "of": settings::Column::ALL.iter().map(|c| c.key()).collect::<Vec<_>>(), "rule": "add only: every column shown now stays" },
            "list_side": ["left", "right"],
            "reduced_motion": "true | false",
            "key_bar": "true (turning it off is the person's)",
            "show_costs": "true (turning it off is the person's)",
            "notifications": { "asks": "true", "finished": "true", "failed": "true", "off": "the person's to do" },
            "keys": "never here: the person changes keys"
        },
        "roles": Role::ALL.iter().map(|r| json!({ "role": r.key(), "colours": r.words() })).collect::<Vec<_>>(),
        "themes": {
            "built_in": ThemeName::ALL.iter().map(|t| t.key()).collect::<Vec<_>>(),
            "saved": s.saved_themes.iter().map(|t| json!({
                "name": t.name, "base": t.base.key(),
                "colors": t.roles.iter().map(|(r, c)| (r.key().to_string(), json!(c.hex()))).collect::<Map<String, Value>>()
            })).collect::<Vec<_>>(),
        },
        "guide": GUIDE,
    })
}

fn settings_json(s: &Settings) -> Value {
    json!({
        "theme": s.theme_label.clone().unwrap_or_else(|| s.theme.key().to_string()),
        "density": match s.density { settings::Density::Compact => "compact", settings::Density::Comfortable => "comfortable" },
        "glyphs": s.glyphs.key(),
        "columns": s.columns.iter().map(|c| c.key()).collect::<Vec<_>>(),
        "list_side": s.list_side.key(),
        "reduced_motion": s.reduced_motion,
        "key_bar": s.key_bar,
        "show_costs": s.show_costs,
        "notifications": { "asks": s.notify.asks, "finished": s.notify.finished, "failed": s.notify.failed },
    })
}

/// A TOML string of a value already checked to hold only plain characters.
fn quoted(v: &str) -> String {
    format!("\"{v}\"")
}

/// One checked edit: where it goes (section, key), the TOML value, and its words.
struct Edit {
    section: String,
    key: String,
    value: String,
    words: String,
}

fn a_bool(v: &Value, what: &str) -> Result<bool, String> {
    v.as_bool()
        .ok_or_else(|| format!("{what} is true or false"))
}

fn a_choice<'a>(v: &'a Value, what: &str, allowed: &[&str]) -> Result<&'a str, String> {
    match v.as_str() {
        Some(s) if allowed.contains(&s) => Ok(s),
        _ => Err(format!("{what} is one of: {}", allowed.join(", "))),
    }
}

/// Role colours from a JSON object: known roles, `#rrggbb` only, and never a status's.
fn role_colors(v: &Value, what: &str) -> Result<Vec<(Role, Rgb)>, String> {
    let Some(map) = v.as_object() else {
        return Err(format!("{what} is a table of role → \"#rrggbb\""));
    };
    if map.len() > MAX_COLORS {
        return Err(format!("{what} holds at most {MAX_COLORS} roles"));
    }
    let mut out = vec![];
    for (role, c) in map {
        let Some(r) = Role::from_key(role) else {
            return Err(format!(
                "{} isn't a role (they are: {})",
                crate::text::fit(&crate::text::clean(role), 24),
                Role::ALL
                    .iter()
                    .map(|r| r.key())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        };
        // A status's colour is its meaning: it comes from the themes, never from here.
        if STATUS_ROLES.contains(&r) {
            return Err(format!(
                "{} is a status colour: statuses keep their theme's colours (needs you, running, passed and failed, and their badges), so they always mean what they say",
                r.key()
            ));
        }
        let hex = c.as_str().unwrap_or("");
        let ok = hex.len() == 7
            && hex.starts_with('#')
            && hex[1..].chars().all(|c| c.is_ascii_hexdigit());
        let Some(rgb) = Rgb::parse(hex).filter(|_| ok) else {
            return Err(format!("{role} needs a colour like \"#1a2b3c\""));
        };
        out.push((r, rgb));
    }
    Ok(out)
}

/// The roles whose colour is a status's meaning (and its badge's wash): set by themes only.
pub const STATUS_ROLES: [Role; 7] = [
    Role::NeedsYou,
    Role::Running,
    Role::Passed,
    Role::Failed,
    Role::RunningSoft,
    Role::PassedSoft,
    Role::FailedSoft,
];

/// Said when a change would turn off something that alerts or shows the person.
pub const OFF_IS_YOURS: &str = "Turning that off is yours to do: Settings, or tui.toml.";

/// Whether these colours over this base keep every contrast floor; the reason when they don't.
fn keeps_contrast(base: ThemeName, colors: &[(Role, Rgb)]) -> Result<(), String> {
    // The terminal theme sits on whatever the terminal's background is: checked on a dark one and a light one.
    let backgrounds: &[Option<Rgb>] = if base == ThemeName::Terminal {
        &[None, Some(Rgb(255, 255, 255)), Some(Rgb(0, 0, 0))]
    } else {
        &[None]
    };
    let refused: Vec<String> = backgrounds
        .iter()
        .flat_map(|b| Theme::build(base, Depth::TrueColor, *b, colors).1)
        .collect();
    match refused.first() {
        None => Ok(()),
        Some(why) => Err(why
            .replace("Your colour for", "The colour for")
            .replace(" wasn't used: ", " can't be used: ")),
    }
}

/// The edits a change asks for, each checked; the whole change is refused at its first problem.
fn edits_of(change: &Map<String, Value>, now: &Settings) -> Result<Vec<Edit>, String> {
    let mut edits = vec![];
    let mut theme_after: (ThemeName, Vec<(Role, Rgb)>) = (now.theme, vec![]);
    if let Some(saved) = now
        .theme_label
        .as_ref()
        .and_then(|l| now.saved_themes.iter().find(|t| &t.name == l))
    {
        theme_after = (saved.base, saved.roles.clone());
    }
    let mut colors_after: Vec<(Role, Rgb)> = vec![];
    let mut saved_names: Vec<String> = now.saved_themes.iter().map(|t| t.name.clone()).collect();
    for (key, v) in change {
        match key.as_str() {
            "keys" => {
                return Err("Keys can't be changed here: they stay with you (tui.toml's [keys], or the Settings screen), so an accept or a cancel never becomes a one-key accident.".into())
            }
            "save_theme" => {
                let Some(t) = v.as_object() else {
                    return Err("save_theme is { name, base, colors, use }".into());
                };
                for k in t.keys() {
                    if !["name", "base", "colors", "use"].contains(&k.as_str()) {
                        return Err(format!("save_theme holds name, base, colors and use only, not {}", crate::text::fit(&crate::text::clean(k), 24)));
                    }
                }
                let name = t.get("name").and_then(Value::as_str).unwrap_or("");
                if !settings::theme_name_ok(name) {
                    return Err(format!(
                        "A theme's name is a lowercase letter, then letters, digits and dashes, at most {}, and not a built-in theme's",
                        settings::THEME_NAME_MAX
                    ));
                }
                let base = t.get("base").and_then(Value::as_str).and_then(ThemeName::from_key).ok_or("save_theme's base is terminal, light, dark or high-contrast")?;
                let roles = role_colors(t.get("colors").unwrap_or(&Value::Object(Map::new())), "save_theme's colors")?;
                keeps_contrast(base, &roles)?;
                let section = format!("themes.{name}");
                edits.push(Edit { section: section.clone(), key: "base".into(), value: quoted(base.key()), words: format!("theme {name}: base {}", base.key()) });
                for (r, c) in &roles {
                    edits.push(Edit { section: section.clone(), key: r.key().into(), value: quoted(&c.hex()), words: format!("theme {name}: {} {}", r.key(), c.hex()) });
                }
                saved_names.push(name.to_string());
                if t.get("use").and_then(Value::as_bool) == Some(true) {
                    edits.push(Edit { section: String::new(), key: "theme".into(), value: quoted(name), words: format!("theme: {} → {name}", now.theme_label.clone().unwrap_or_else(|| now.theme.key().into())) });
                    theme_after = (base, roles);
                }
            }
            "theme" => {
                let name = v.as_str().unwrap_or("");
                if let Some(t) = ThemeName::from_key(name) {
                    theme_after = (t, vec![]);
                } else if saved_names.iter().any(|n| n == name) {
                    if let Some(t) = now.saved_themes.iter().find(|t| t.name == name) {
                        theme_after = (t.base, t.roles.clone());
                    }
                } else {
                    return Err(format!(
                        "theme is terminal, light, dark, high-contrast or a saved theme ({})",
                        if saved_names.is_empty() { "none saved yet".to_string() } else { saved_names.join(", ") }
                    ));
                }
                edits.push(Edit { section: String::new(), key: "theme".into(), value: quoted(name), words: format!("theme: {} → {name}", now.theme_label.clone().unwrap_or_else(|| now.theme.key().into())) });
            }
            "colors" => {
                colors_after = role_colors(v, "colors")?;
                for (r, c) in &colors_after {
                    edits.push(Edit { section: "colors".into(), key: r.key().into(), value: quoted(&c.hex()), words: format!("{}: {}", r.key(), c.hex()) });
                }
            }
            "density" => {
                let d = a_choice(v, "density", &["compact", "comfortable"])?;
                edits.push(Edit { section: String::new(), key: "density".into(), value: quoted(d), words: format!("density → {d}") });
            }
            "glyphs" => {
                let g = a_choice(v, "glyphs", &["unicode", "ascii", "nerd"])?;
                edits.push(Edit { section: String::new(), key: "glyphs".into(), value: quoted(g), words: format!("glyphs → {g}") });
            }
            "list_side" => {
                let side = a_choice(v, "list_side", &["left", "right"])?;
                edits.push(Edit { section: String::new(), key: "list-side".into(), value: quoted(side), words: format!("list side → {side}") });
            }
            "columns" => {
                let Some(list) = v.as_array().filter(|l| l.len() <= settings::Column::ALL.len()) else {
                    return Err("columns is a list of agent, step, age, cost, project".into());
                };
                let mut keys = vec![];
                for c in list {
                    let k = a_choice(c, "a column", &["agent", "step", "age", "cost", "project"])?;
                    if !keys.contains(&k) {
                        keys.push(k);
                    }
                }
                // Columns may be added, never taken away: a column the person sees stays (yours to change).
                if let Some(gone) = now.columns.iter().find(|c| !keys.contains(&c.key())) {
                    return Err(format!("{} (the {} column).", OFF_IS_YOURS.trim_end_matches('.'), gone.key()));
                }
                let value = format!("[{}]", keys.iter().map(|k| quoted(k)).collect::<Vec<_>>().join(", "));
                edits.push(Edit { section: String::new(), key: "columns".into(), value: value.clone(), words: format!("columns → {value}") });
            }
            "reduced_motion" | "key_bar" | "show_costs" => {
                let b = a_bool(v, key)?;
                // The key bar and costs show the person something: on only, never off.
                if !b && key != "reduced_motion" {
                    return Err(OFF_IS_YOURS.into());
                }
                let toml_key = key.replace('_', "-");
                edits.push(Edit { section: String::new(), key: toml_key.clone(), value: b.to_string(), words: format!("{toml_key} → {b}") });
            }
            "notifications" => {
                let Some(n) = v.as_object() else {
                    return Err("notifications is { asks, finished, failed }".into());
                };
                for (k, b) in n {
                    if !["asks", "finished", "failed"].contains(&k.as_str()) {
                        return Err("notifications holds asks, finished and failed".into());
                    }
                    let b = a_bool(b, k)?;
                    // What alerts the person: on only, never off.
                    if !b {
                        return Err(OFF_IS_YOURS.into());
                    }
                    edits.push(Edit { section: "notifications".into(), key: k.clone(), value: b.to_string(), words: format!("notifications.{k} → {b}") });
                }
            }
            other => {
                return Err(format!(
                    "{} can't be changed here (theme, save_theme, colors, density, glyphs, columns, list_side, reduced_motion, key_bar, show_costs, notifications)",
                    crate::text::fit(&crate::text::clean(other), 24)
                ))
            }
        }
    }
    if edits.is_empty() {
        return Err("Nothing to change.".into());
    }
    // The look as it will be: its colours (the theme's, then [colors] as they will stand) keep every floor.
    let mut standing: Vec<(Role, Rgb)> = now
        .colors
        .iter()
        .filter(|(r, _)| !theme_after.1.iter().any(|(t, _)| t == r))
        .copied()
        .collect();
    if now.theme_label.is_some() {
        // The old saved theme's roles are no longer laid under [colors].
        if let Some(old) = now
            .theme_label
            .as_ref()
            .and_then(|l| now.saved_themes.iter().find(|t| &t.name == l))
        {
            standing.retain(|c| !old.roles.contains(c));
        }
    }
    standing.retain(|(r, _)| !colors_after.iter().any(|(c, _)| c == r));
    let mut all = theme_after.1.clone();
    all.extend(standing);
    all.extend(colors_after);
    keeps_contrast(theme_after.0, &all)?;
    Ok(edits)
}

/// Apply a change (JSON on standard input) to tui.toml through the safe writer; its words, one per edit.
pub fn set(env: &Env, input: &str) -> Result<Vec<String>, String> {
    if input.len() > MAX_INPUT {
        return Err("That change is too long.".into());
    }
    let change: Value =
        serde_json::from_str(input).map_err(|_| "A change is a JSON object.".to_string())?;
    let Some(change) = change.as_object() else {
        return Err("A change is a JSON object.".into());
    };
    let (now, path, file, _) = settings::load(env);
    let Some(path) = path else {
        return Err("There's no home folder to keep tui.toml in.".into());
    };
    if let FileState::Ignored(why) = &file {
        return Err(format!(
            "tui.toml isn't changed while it is ignored ({why})."
        ));
    }
    let edits = edits_of(change, &now)?;
    // Read back what will be written, with the screen's own reader: a change that it wouldn't use is never written.
    let before_warnings = std::cell::RefCell::new(None::<usize>);
    let refused = std::cell::RefCell::new(None::<String>);
    let apply = |text: &str| -> String {
        let mut out = if text.is_empty() {
            settings::FRESH_HEAD.to_string()
        } else {
            text.to_string()
        };
        for e in &edits {
            out = settings::set_in_toml(&out, &e.section, &e.key, &e.value);
        }
        let (_, before) = settings::parse(text);
        let (_, after) = settings::parse(&out);
        *before_warnings.borrow_mut() = Some(before.len());
        if after.len() > before.len() {
            *refused.borrow_mut() = after.into_iter().find(|w| !before.contains(w));
            return text.to_string();
        }
        out
    };
    settings::write_safely(&path, env.home.as_deref(), &apply)
        .map_err(|why| format!("tui.toml wasn't written ({why})."))?;
    if let Some(why) = refused.into_inner() {
        return Err(format!("That change wasn't written: {why}"));
    }
    Ok(edits.into_iter().map(|e| e.words).collect())
}

/// tui.toml back to the defaults; the file it held kept beside it as tui.toml.bak, written the same safe way.
pub fn reset(env: &Env) -> Result<String, String> {
    let Some(path) = env.settings_path() else {
        return Err("There's no home folder to keep tui.toml in.".into());
    };
    let previous = match settings::read_safely(&path, env.home.as_deref()) {
        Ok(None) => return Ok("Already the defaults: there's no tui.toml.".into()),
        Ok(Some(text)) => text,
        Err(why) => {
            return Err(format!(
                "tui.toml can't be read safely ({why}), so nothing was reset."
            ))
        }
    };
    let bak = path.with_file_name("tui.toml.bak");
    settings::write_within(
        &bak,
        env.home.as_deref(),
        "",
        settings::MAX_BYTES,
        false,
        &|_| previous.clone(),
    )
    .map_err(|why| format!("The backup wasn't written ({why}), so nothing was reset."))?;
    settings::write_safely(&path, env.home.as_deref(), &|_| {
        settings::FRESH_HEAD.to_string()
    })
    .map_err(|why| format!("tui.toml wasn't reset ({why}); your backup is tui.toml.bak."))?;
    Ok(
        "Your workbench settings are back to the defaults; the previous file is tui.toml.bak."
            .into(),
    )
}
