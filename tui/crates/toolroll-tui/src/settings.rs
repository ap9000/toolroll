//! The terminal workbench's own settings: `tui.toml` in the person's config folder (`$XDG_CONFIG_HOME/toolroll/` when
//! that is set, else `~/.config/toolroll/`). Read once at start, never written by the app.
//!
//! Strict: a key it doesn't know is named in a warning and ignored; a value it can't use falls back to the default,
//! saying so; a line it can't read is skipped, saying so. The file is read only when it is a plain file owned by this
//! user that nobody else can change, in a folder nobody else can change; otherwise it is ignored, saying why.
//!
//! ```toml
//! theme = "terminal"          # terminal | light | dark | high-contrast
//! density = "compact"         # compact | comfortable
//! key-bar = true
//! show-costs = true
//! columns = ["step"]          # any of agent, step, age, cost, project
//! glyphs = "unicode"          # unicode | ascii | nerd
//! bell = true
//! reduced-motion = false
//! tmux-passthrough = false    # true: desktop notifications inside tmux (needs tmux's allow-passthrough on)
//!
//! [notifications]
//! asks = true
//! finished = false
//! failed = true
//!
//! [colors]                    # any role: paper, ink, muted, line, selection, selection-ink,
//! running = "#5aa9ff"         # needs-you, running, passed, failed, ground, raised, fill,
//!                             # running-soft, passed-soft, failed-soft
//!
//! [keys]                      # keys.rs: a preset, then any action's keys
//! preset = "default"          # default | vim | emacs
//! accept = "a"                # one key, or a list: palette = [":", "ctrl-k"]
//! ```
use crate::notify::Reach;
use crate::text::{clean, fit};
use crate::theme::{Depth, Glyphs, Rgb, Role, Theme, ThemeName};
use ratatui::text::{Line, Span};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Bigger than this is not a settings file.
pub const MAX_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Density {
    Compact,
    Comfortable,
}

impl Density {
    pub fn key(self) -> &'static str {
        match self {
            Density::Compact => "compact",
            Density::Comfortable => "comfortable",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Column {
    Agent,
    Step,
    Age,
    Cost,
    Project,
}

impl Column {
    pub const ALL: [Column; 5] = [
        Column::Agent,
        Column::Step,
        Column::Age,
        Column::Cost,
        Column::Project,
    ];
    pub fn key(self) -> &'static str {
        match self {
            Column::Agent => "agent",
            Column::Step => "step",
            Column::Age => "age",
            Column::Cost => "cost",
            Column::Project => "project",
        }
    }
}

/// Which changes notify (each also rings the bell when `bell` is on).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Notify {
    pub asks: bool,
    pub finished: bool,
    pub failed: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub theme: ThemeName,
    pub density: Density,
    pub key_bar: bool,
    pub show_costs: bool,
    pub columns: Vec<Column>,
    pub glyphs: Glyphs,
    pub notify: Notify,
    pub bell: bool,
    pub reduced_motion: bool,
    /// Inside tmux, send desktop notifications (wrapped for its passthrough); off: the bell only.
    pub tmux_passthrough: bool,
    /// Role colours, in the file's order.
    pub colors: Vec<(Role, Rgb)>,
    /// The keymap: a preset and the file's own keys (keys.rs).
    pub keymap: crate::keys::Keymap,
}

impl Settings {
    /// The list's starting width: room for the columns asked for besides the step (dragging changes it).
    pub fn list_width(&self) -> u16 {
        let extra: u16 = self
            .columns
            .iter()
            .map(|c| match c {
                Column::Step => 0,
                Column::Age => 5,
                Column::Cost => 7,
                Column::Agent => 16,
                Column::Project => 14,
            })
            .sum();
        // The sheet, its padding and the card's badge besides the title.
        (46 + extra).min(90)
    }
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            theme: ThemeName::Terminal,
            density: Density::Compact,
            key_bar: true,
            show_costs: true,
            columns: vec![Column::Step],
            glyphs: Glyphs::Unicode,
            notify: Notify {
                asks: true,
                finished: false,
                failed: true,
            },
            bell: true,
            reduced_motion: false,
            tmux_passthrough: false,
            colors: vec![],
            keymap: crate::keys::Keymap::default(),
        }
    }
}

// ---- the file's words ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Value {
    Str(String),
    Bool(bool),
    List(Vec<String>),
    /// Something TOML may allow but these settings never take (a number, a date, a table).
    Other(String),
}

impl Value {
    fn shown(&self) -> String {
        let s = match self {
            Value::Str(s) => format!("\"{s}\""),
            Value::Bool(b) => b.to_string(),
            Value::List(l) => format!("[{}]", l.join(", ")),
            Value::Other(o) => o.clone(),
        };
        fit(&clean(&s), 40)
    }
}

/// A quoted string at the start of `s`: its value and what follows (None: not one, or not closed).
fn quoted(s: &str) -> Option<(String, &str)> {
    let mut chars = s.char_indices();
    let (_, q) = chars.next()?;
    if q != '"' && q != '\'' {
        return None;
    }
    let mut out = String::new();
    while let Some((i, c)) = chars.next() {
        match c {
            c if c == q => return Some((out, &s[i + 1..])),
            '\\' if q == '"' => {
                let (_, e) = chars.next()?;
                match e {
                    '"' => out.push('"'),
                    '\\' => out.push('\\'),
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    'u' => {
                        let hex: String = (0..4)
                            .filter_map(|_| chars.next().map(|(_, c)| c))
                            .collect();
                        out.push(char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?);
                    }
                    _ => return None,
                }
            }
            '\n' => return None,
            c => out.push(c),
        }
    }
    None
}

/// What's left of a line once a comment is taken off (a `#` outside a string).
fn without_comment(s: &str) -> &str {
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for (i, c) in s.char_indices() {
        match quote {
            Some(q) => {
                if escaped {
                    escaped = false;
                } else if c == '\\' && q == '"' {
                    escaped = true;
                } else if c == q {
                    quote = None;
                }
            }
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == '#' => return &s[..i],
            None => {}
        }
    }
    s
}

fn value(s: &str) -> Option<Value> {
    let s = s.trim();
    if s == "true" {
        return Some(Value::Bool(true));
    }
    if s == "false" {
        return Some(Value::Bool(false));
    }
    if let Some((v, rest)) = quoted(s) {
        return rest.trim().is_empty().then_some(Value::Str(v));
    }
    if let Some(inner) = s.strip_prefix('[') {
        let inner = inner.strip_suffix(']')?;
        let mut items = vec![];
        let mut rest = inner.trim();
        while !rest.is_empty() {
            let (v, after) = quoted(rest)?;
            items.push(v);
            rest = after.trim_start();
            match rest.strip_prefix(',') {
                Some(r) => rest = r.trim_start(),
                None if rest.is_empty() => {}
                None => return None,
            }
        }
        return Some(Value::List(items));
    }
    // A number, a date or an inline table: TOML, but nothing these settings take.
    let bare_ok = !s.is_empty()
        && (s.starts_with('{')
            || s.chars()
                .all(|c| c.is_ascii_alphanumeric() || "+-._:".contains(c)));
    bare_ok.then(|| Value::Other(s.to_string()))
}

fn bare_key(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The file as (line number, section, key, value), and the words for each line it couldn't read.
/// One setting as written: its line, section, key and value.
type Entry = (usize, String, String, Value);

fn entries(text: &str) -> (Vec<Entry>, Vec<String>) {
    let mut out = vec![];
    let mut warnings = vec![];
    let mut section = String::new();
    let mut lines = text.lines().enumerate();
    while let Some((i, raw)) = lines.next() {
        let n = i + 1;
        let mut line = without_comment(raw).trim().to_string();
        if line.is_empty() {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            let name = name.trim();
            if bare_key(name) {
                section = name.to_string();
            } else {
                warnings.push(format!("Line {n} isn't understood, so it was ignored."));
                section = "\u{0}".into();
            }
            continue;
        }
        // An array may run over several lines: read on until its brackets close.
        if let Some(eq) = line.find('=') {
            if line[eq + 1..].trim_start().starts_with('[') && !line.trim_end().ends_with(']') {
                for (_, more) in lines.by_ref() {
                    line.push(' ');
                    line.push_str(without_comment(more).trim());
                    if line.trim_end().ends_with(']') {
                        break;
                    }
                }
            }
        }
        let parsed = line.split_once('=').and_then(|(k, v)| {
            let k = k.trim();
            let k = quoted(k)
                .filter(|(_, rest)| rest.is_empty())
                .map(|(q, _)| q)
                .unwrap_or_else(|| k.to_string());
            let parts: Vec<&str> = k.split('.').map(str::trim).collect();
            if !parts.iter().all(|p| bare_key(p)) || parts.len() > 2 {
                return None;
            }
            let (sec, key) = if parts.len() == 2 {
                if !section.is_empty() {
                    return None;
                }
                (parts[0].to_string(), parts[1].to_string())
            } else {
                (section.clone(), parts[0].to_string())
            };
            Some((sec, key, value(v)?))
        });
        match parsed {
            Some((sec, key, v)) => out.push((n, sec, key, v)),
            None => warnings.push(format!("Line {n} isn't understood, so it was ignored.")),
        }
    }
    (out, warnings)
}

/// Settings from the file's text, and a plain warning for everything not used.
pub fn parse(text: &str) -> (Settings, Vec<String>) {
    let mut s = Settings::default();
    let (entries, mut warnings) = entries(text);
    let mut seen: Vec<(String, String)> = vec![];
    let mut preset: Option<(usize, crate::keys::Written)> = None;
    let mut overrides: Vec<(usize, String, crate::keys::Written)> = vec![];
    for (n, section, key, v) in entries {
        let section = if section == "colours" {
            "colors".to_string()
        } else {
            section
        };
        if section == "\u{0}" {
            continue;
        }
        if seen.contains(&(section.clone(), key.clone())) {
            warnings.push(format!(
                "Line {n}: {key} is set twice; the first one is used."
            ));
            continue;
        }
        seen.push((section.clone(), key.clone()));
        let name = if section.is_empty() {
            key.clone()
        } else {
            format!("{section}.{key}")
        };
        let bad = |warnings: &mut Vec<String>, can: &str, default: &str| {
            warnings.push(format!(
                "Line {n}: {key} can be {can}, not {}; using {default}.",
                v.shown()
            ));
        };
        let flag = |warnings: &mut Vec<String>, slot: &mut bool| match &v {
            Value::Bool(b) => *slot = *b,
            _ => bad(
                warnings,
                "true or false",
                if *slot { "true" } else { "false" },
            ),
        };
        match (section.as_str(), key.as_str()) {
            ("", "theme") => match &v {
                Value::Str(t) if ThemeName::from_key(t).is_some() => {
                    s.theme = ThemeName::from_key(t).unwrap_or(ThemeName::Terminal)
                }
                _ => bad(
                    &mut warnings,
                    "terminal, light, dark or high-contrast",
                    "terminal",
                ),
            },
            ("", "density") => match &v {
                Value::Str(d) if d == "compact" => s.density = Density::Compact,
                Value::Str(d) if d == "comfortable" => s.density = Density::Comfortable,
                _ => bad(&mut warnings, "compact or comfortable", "compact"),
            },
            ("", "glyphs") => match &v {
                Value::Str(g) if Glyphs::from_key(g).is_some() => {
                    s.glyphs = Glyphs::from_key(g).unwrap_or(Glyphs::Unicode)
                }
                _ => bad(&mut warnings, "unicode, ascii or nerd", "unicode"),
            },
            ("", "key-bar") => flag(&mut warnings, &mut s.key_bar),
            ("", "show-costs") => flag(&mut warnings, &mut s.show_costs),
            ("", "bell") => flag(&mut warnings, &mut s.bell),
            ("", "reduced-motion") => flag(&mut warnings, &mut s.reduced_motion),
            ("", "tmux-passthrough") => flag(&mut warnings, &mut s.tmux_passthrough),
            ("", "columns") => match &v {
                Value::List(names) => {
                    let mut cols = vec![];
                    for name in names {
                        match Column::ALL.into_iter().find(|c| c.key() == name) {
                            Some(c) if !cols.contains(&c) => cols.push(c),
                            Some(_) => {}
                            None => warnings.push(format!(
                                "Line {n}: \"{}\" isn't a column (agent, step, age, cost or project), so it was left out.",
                                fit(&clean(name), 24)
                            )),
                        }
                    }
                    s.columns = cols;
                }
                _ => bad(
                    &mut warnings,
                    "a list like [\"step\", \"age\"]",
                    "[\"step\"]",
                ),
            },
            ("keys", name) => {
                let written = match &v {
                    Value::Str(k) => crate::keys::Written::Keys(vec![k.clone()]),
                    Value::List(l) => crate::keys::Written::Keys(l.clone()),
                    other => crate::keys::Written::Bad(other.shown()),
                };
                if name == "preset" {
                    preset = Some((n, written));
                } else {
                    overrides.push((n, name.to_string(), written));
                }
            }
            ("notifications", "asks") => flag(&mut warnings, &mut s.notify.asks),
            ("notifications", "finished") => flag(&mut warnings, &mut s.notify.finished),
            ("notifications", "failed") => flag(&mut warnings, &mut s.notify.failed),
            ("colors", role) => match (Role::from_key(role), &v) {
                (Some(r), Value::Str(c)) if Rgb::parse(c).is_some() => {
                    s.colors.push((r, Rgb::parse(c).unwrap_or(Rgb(0, 0, 0))))
                }
                (Some(_), _) => warnings.push(format!(
                    "Line {n}: {key} needs a colour like \"#1a2b3c\", not {}; the theme's own is used.",
                    v.shown()
                )),
                (None, _) => warnings.push(format!(
                    "Line {n}: there's no colour called {}, so it was ignored (paper, ink, muted, line, selection, selection-ink, needs-you, running, passed, failed, ground, raised, fill, running-soft, passed-soft, failed-soft).",
                    fit(&clean(role), 24)
                )),
            },
            _ => {
                let dashed = name.replace('_', "-");
                let hint = if dashed != name && known(&dashed) {
                    format!(" Did you mean {dashed}?")
                } else {
                    String::new()
                };
                warnings.push(format!(
                    "Line {n}: {} isn't a setting, so it was ignored.{hint}",
                    fit(&clean(&name), 32)
                ));
            }
        }
    }
    let (keymap, key_warnings) = crate::keys::Keymap::build(preset, &overrides);
    s.keymap = keymap;
    warnings.extend(key_warnings);
    (s, warnings)
}

fn known(name: &str) -> bool {
    [
        "theme",
        "density",
        "key-bar",
        "show-costs",
        "columns",
        "glyphs",
        "bell",
        "reduced-motion",
        "tmux-passthrough",
        "notifications.asks",
        "notifications.finished",
        "notifications.failed",
    ]
    .contains(&name)
        || name
            .strip_prefix("colors.")
            .is_some_and(|r| Role::from_key(r).is_some())
}

// ---- where the file is, and whether it may be read --------------------------------------------------------------

/// What the settings depend on from the environment, read once (tests build their own).
#[derive(Debug, Clone, Default)]
pub struct Env {
    pub home: Option<PathBuf>,
    pub xdg_config_home: Option<PathBuf>,
    /// Where the workbench keeps where you left off (state.rs).
    pub xdg_state_home: Option<PathBuf>,
    pub no_color: bool,
    pub colorterm: Option<String>,
    pub term: Option<String>,
    pub tmux: bool,
    pub tmux_pane: Option<String>,
    pub vte: bool,
    pub ssh: bool,
}

impl Env {
    pub fn from_process() -> Env {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        Env {
            home: var("HOME").map(PathBuf::from),
            xdg_config_home: var("XDG_CONFIG_HOME").map(PathBuf::from),
            xdg_state_home: var("XDG_STATE_HOME").map(PathBuf::from),
            no_color: var("NO_COLOR").is_some(),
            colorterm: var("COLORTERM"),
            term: var("TERM"),
            tmux: var("TMUX").is_some(),
            tmux_pane: var("TMUX_PANE"),
            vte: var("VTE_VERSION").is_some(),
            ssh: var("SSH_CONNECTION").is_some() || var("SSH_TTY").is_some(),
        }
    }

    /// The settings file: under `XDG_CONFIG_HOME` when it is set (an absolute path), else `~/.config`.
    pub fn settings_path(&self) -> Option<PathBuf> {
        if let Some(x) = self.xdg_config_home.as_ref().filter(|p| p.is_absolute()) {
            return Some(x.join("toolroll").join("tui.toml"));
        }
        self.home
            .as_ref()
            .filter(|p| p.is_absolute())
            .map(|h| h.join(".config").join("toolroll").join("tui.toml"))
    }

    pub fn depth(&self) -> Depth {
        Depth::detect(
            self.no_color,
            self.colorterm.as_deref(),
            self.term.as_deref(),
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum FileState {
    /// No file: the defaults.
    Missing,
    Read,
    /// Not read, and why (in words).
    Ignored(String),
}

/// Whether a file with these facts may be read: a plain file, this user's, that nobody else can change.
pub fn judge(regular: bool, uid: u32, mode: u32, size: u64, me: u32) -> Result<(), &'static str> {
    if !regular {
        return Err("it isn't a plain file");
    }
    if uid != me {
        return Err("it belongs to another user");
    }
    if mode & 0o022 != 0 {
        return Err("other people can change it (chmod go-w fixes that)");
    }
    if size > MAX_BYTES {
        return Err("it is larger than 64 KB");
    }
    Ok(())
}

/// Read the settings file when it is safe to: never a file or folder others can change. A link (a dotfile manager's)
/// is followed only to a real path inside the home folder whose every folder, up to and including the home folder, is
/// this user's and can't be changed by anyone else; the file is then opened at that real path without following links,
/// and judged by what was opened.
#[cfg(unix)]
pub fn read_safely(path: &Path, home: Option<&Path>) -> Result<Option<String>, String> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    // SAFETY: geteuid has no preconditions.
    let me = unsafe { libc::geteuid() };
    if let Some(dir) = path.parent() {
        match std::fs::metadata(dir) {
            Err(_) => return Ok(None),
            Ok(m) => {
                if !m.is_dir() || m.uid() != me || m.mode() & 0o022 != 0 {
                    return Err("its folder can be changed by other people, or isn't yours".into());
                }
            }
        }
    }
    let real = match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("it couldn't be opened".into()),
        Ok(m) if m.file_type().is_symlink() => {
            let home = home
                .and_then(|h| std::fs::canonicalize(h).ok())
                .ok_or("it is a link, and there's no home folder to check it against")?;
            let target =
                std::fs::canonicalize(path).map_err(|_| "it is a link to nothing".to_string())?;
            // Real paths both, compared as bytes: strictly inside the home folder.
            use std::os::unix::ffi::OsStrExt;
            let (t, h) = (target.as_os_str().as_bytes(), home.as_os_str().as_bytes());
            if !(t.len() > h.len() && t.starts_with(h) && t[h.len()] == b'/') {
                return Err("it links outside your home folder".into());
            }
            let mut dir = target.parent();
            while let Some(d) = dir {
                let ok = std::fs::symlink_metadata(d)
                    .is_ok_and(|m| m.is_dir() && m.uid() == me && m.mode() & 0o022 == 0);
                if !ok {
                    return Err(
                        "it links into a folder other people can change, or that isn't yours"
                            .into(),
                    );
                }
                if d.as_os_str() == home.as_os_str() {
                    break;
                }
                dir = d.parent();
            }
            target
        }
        Ok(_) => path.to_path_buf(),
    };
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(&real);
    let mut file = match file {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) if e.raw_os_error() == Some(libc::ELOOP) => {
            return Err("it is a link, not the file itself".into())
        }
        Err(_) => return Err("it couldn't be opened".into()),
    };
    // The facts of the file opened (not of the name, which could change in between).
    let m = file
        .metadata()
        .map_err(|_| "it couldn't be read".to_string())?;
    judge(m.file_type().is_file(), m.uid(), m.mode(), m.len(), me).map_err(str::to_string)?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "it couldn't be read".to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("it is larger than 64 KB".into());
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "it isn't UTF-8 text".into())
}

#[cfg(not(unix))]
pub fn read_safely(_path: &Path, _home: Option<&Path>) -> Result<Option<String>, String> {
    Ok(None)
}

/// The settings for this environment: the file's when it may be read, else the defaults; and every warning.
pub fn load(env: &Env) -> (Settings, Option<PathBuf>, FileState, Vec<String>) {
    let Some(path) = env.settings_path() else {
        return (Settings::default(), None, FileState::Missing, vec![]);
    };
    match read_safely(&path, env.home.as_deref()) {
        Ok(None) => (Settings::default(), Some(path), FileState::Missing, vec![]),
        Ok(Some(text)) => {
            let (s, warnings) = parse(&text);
            let warnings = warnings
                .into_iter()
                .map(|w| format!("tui.toml: {w}"))
                .collect();
            (s, Some(path), FileState::Read, warnings)
        }
        Err(why) => (
            Settings::default(),
            Some(path),
            FileState::Ignored(why.clone()),
            vec![format!("tui.toml was ignored: {why}.")],
        ),
    }
}

/// Everything the screen needs from its surroundings, at start: the settings, the colours the terminal shows, its
/// background (asked only from a local terminal with colour on: raw mode, before anything reads the keyboard), and
/// where notifications go.
pub fn start(env: &Env) -> Prefs {
    let (settings, path, file, warnings) = load(env);
    let depth = env.depth();
    let ask = depth != Depth::Off && !env.ssh;
    let background = if ask {
        crate::theme::ask_background(std::time::Duration::from_millis(150))
    } else {
        None
    };
    let reach = Reach::of(env, settings.tmux_passthrough);
    let mut prefs = Prefs::new(settings, path, file, warnings, depth, background, reach);
    // Asked and not answered in time: an answer may still come, and must not be read as keys (theme::LateReply).
    prefs.late_reply = ask && background.is_none();
    prefs
}

// ---- what the screen holds ------------------------------------------------------------------------------------------

/// The settings in use and where they came from, the theme drawn (which `t` changes for the session), and where
/// notifications go.
#[derive(Debug, Clone, PartialEq)]
pub struct Prefs {
    pub settings: Settings,
    pub path: Option<PathBuf>,
    pub file: FileState,
    /// The file's warnings (fixed at start).
    pub file_warnings: Vec<String>,
    /// The colours refused for the theme drawn now.
    pub color_warnings: Vec<String>,
    pub depth: Depth,
    /// What the terminal said its background is (OSC 11).
    pub background: Option<Rgb>,
    pub theme: Theme,
    pub reach: Reach,
    /// The background was asked for and not answered in time (the loop drops a late answer: theme::LateReply).
    pub late_reply: bool,
}

impl Default for Prefs {
    fn default() -> Prefs {
        Prefs {
            settings: Settings::default(),
            path: None,
            file: FileState::Missing,
            file_warnings: vec![],
            color_warnings: vec![],
            depth: Depth::Ansi16,
            background: None,
            theme: Theme::default(),
            reach: Reach::default(),
            late_reply: false,
        }
    }
}

impl Prefs {
    pub fn new(
        settings: Settings,
        path: Option<PathBuf>,
        file: FileState,
        file_warnings: Vec<String>,
        depth: Depth,
        background: Option<Rgb>,
        reach: Reach,
    ) -> Prefs {
        let (theme, color_warnings) =
            Theme::build(settings.theme, depth, background, &settings.colors);
        Prefs {
            settings,
            path,
            file,
            file_warnings,
            color_warnings,
            depth,
            background,
            theme,
            reach,
            late_reply: false,
        }
    }

    /// Everything not used, in plain words.
    pub fn warnings(&self) -> Vec<String> {
        self.file_warnings
            .iter()
            .chain(self.color_warnings.iter())
            .cloned()
            .collect()
    }

    /// The next theme, for this session only (the file is never written).
    pub fn cycle_theme(&mut self) {
        let (theme, warnings) = Theme::build(
            self.theme.name.next(),
            self.depth,
            self.background,
            &self.settings.colors,
        );
        self.theme = theme;
        self.color_warnings = warnings;
    }

    /// The line the status bar shows at start when something wasn't used (None: all was).
    pub fn first_warning(&self) -> Option<String> {
        let all = self.warnings();
        let first = all.first()?;
        Some(if all.len() > 1 {
            format!(
                "{first} ({} more: press ? then s to see them.)",
                all.len() - 1
            )
        } else {
            first.clone()
        })
    }

    /// The settings screen (`?` then `s`): what is in use, from where. Read-only but for `t`.
    pub fn screen(&self, width: usize) -> Vec<Line<'static>> {
        let ink = crate::theme::ink;
        let dim = crate::theme::dim;
        let on = |b: bool| if b { "on" } else { "off" };
        let s = &self.settings;
        let path = self
            .path
            .as_ref()
            .map(|p| clean(&p.display().to_string()))
            .unwrap_or_else(|| "(no home folder, so no settings file)".into());
        let file = match &self.file {
            FileState::Missing => "not there, so the defaults are used".to_string(),
            FileState::Read => "read".to_string(),
            FileState::Ignored(why) => format!("ignored: {why}"),
        };
        let theme = match self.theme.name {
            ThemeName::Terminal => format!(
                "terminal: its own colours, with {} roles{}",
                if self.theme.dark { "dark" } else { "light" },
                if self.background.is_some() {
                    ""
                } else {
                    " (it didn't say its background)"
                }
            ),
            t => t.key().to_string(),
        };
        let theme = if self.theme.name != s.theme {
            format!(
                "{theme}, for this session (the file says {})",
                s.theme.key()
            )
        } else {
            theme
        };
        let columns = if s.columns.is_empty() {
            "none".to_string()
        } else {
            s.columns
                .iter()
                .map(|c| c.key())
                .collect::<Vec<_>>()
                .join(", ")
        };
        let rows: Vec<(&str, String)> = vec![
            ("Theme", theme),
            ("Colour", self.depth.words().to_string()),
            ("Density", s.density.key().to_string()),
            ("Key bar", on(s.key_bar).to_string()),
            (
                "Costs",
                if s.show_costs { "shown" } else { "hidden" }.to_string(),
            ),
            ("Columns", columns),
            ("Glyphs", s.glyphs.key().to_string()),
            ("Keys", {
                let changed = crate::keys::SPECS
                    .iter()
                    .filter(|sp| {
                        s.keymap.keys_of(sp.action)
                            != crate::keys::Keymap::preset(s.keymap.preset).keys_of(sp.action)
                    })
                    .count();
                match changed {
                    0 => format!("{} preset", s.keymap.preset.key()),
                    1 => format!("{} preset, 1 key changed", s.keymap.preset.key()),
                    c => format!("{} preset, {c} keys changed", s.keymap.preset.key()),
                }
            }),
            (
                "Notify",
                format!(
                    "asks {} · finished {} · failed {}",
                    on(s.notify.asks),
                    on(s.notify.finished),
                    on(s.notify.failed)
                ),
            ),
            ("Bell", on(s.bell).to_string()),
            ("Reduced motion", on(s.reduced_motion).to_string()),
            ("Delivered", self.reach.words().to_string()),
        ];
        let w = width.max(20);
        let mut lines = vec![
            Line::from(vec![
                Span::styled("File  ", ink()),
                Span::raw(fit(&path, w.saturating_sub(6))),
            ]),
            Line::from(Span::styled(fit(&format!("      {file}"), w), dim())),
            Line::raw(""),
        ];
        for (label, words) in rows {
            lines.push(Line::from(vec![
                Span::styled(format!("{label:<16}"), dim()),
                Span::raw(fit(&words, w.saturating_sub(16))),
            ]));
        }
        let warnings = self.warnings();
        if !warnings.is_empty() {
            lines.push(Line::raw(""));
            lines.push(Line::from(Span::styled("Not used", ink())));
            for warn in warnings.iter().take(12) {
                for l in crate::text::wrap(warn, w.saturating_sub(2)) {
                    lines.push(Line::raw(format!("  {l}")));
                }
            }
        }
        lines.push(Line::raw(""));
        lines.push(Line::from(vec![
            Span::styled("t  ", ink()),
            Span::raw("Next theme, for this session (the file is never changed)"),
        ]));
        lines.push(Line::from(Span::styled("Any other key closes.", dim())));
        lines
    }
}

// ---- the agent and cost columns ---------------------------------------------------------------------------------

/// Each task's agent and cost as its steps last said (the work list doesn't carry them): learnt as tasks are opened.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RowFacts(HashMap<String, (Option<String>, Option<f64>)>);

impl RowFacts {
    pub fn learn(&mut self, steps: &toolroll_api::StepCards) {
        let Some(card) = steps
            .cards
            .iter()
            .flatten()
            .find(|c| c.key == "build" && (c.state == "current" || !c.runs.is_empty()))
        else {
            return;
        };
        // The task's cost: every step of its chain that recorded one (plan, build, review), together.
        let costs: Vec<f64> = steps
            .cards
            .iter()
            .flatten()
            .filter(|c| c.in_chain)
            .filter_map(|c| c.cost_usd)
            .collect();
        let cost = (!costs.is_empty()).then(|| costs.iter().sum::<f64>());
        let agent = card.agent.as_ref().map(|a| {
            clean(&format!(
                "{} {}",
                a.provider,
                a.model.as_deref().unwrap_or("")
            ))
            .trim()
            .to_string()
        });
        if self.0.len() > 4096 {
            self.0.clear();
        }
        self.0.insert(steps.task.id.clone(), (agent, cost));
    }

    pub fn agent(&self, task: &str) -> Option<&str> {
        self.0.get(task).and_then(|(a, _)| a.as_deref())
    }

    pub fn cost(&self, task: &str) -> Option<f64> {
        self.0.get(task).and_then(|(_, c)| *c)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults() {
        let s = Settings::default();
        assert_eq!(s.theme, ThemeName::Terminal);
        assert_eq!(s.density, Density::Compact);
        assert!(s.key_bar && s.show_costs && s.bell && !s.reduced_motion && !s.tmux_passthrough);
        assert_eq!(s.columns, vec![Column::Step]);
        assert_eq!(s.glyphs, Glyphs::Unicode);
        assert_eq!(
            s.notify,
            Notify {
                asks: true,
                finished: false,
                failed: true
            }
        );
        assert_eq!(parse(""), (Settings::default(), vec![]));
    }

    #[test]
    fn every_setting_is_read() {
        let text = r##"
# mine
theme = "high-contrast"
density = 'comfortable'   # roomier
key-bar = false
show-costs = false
columns = [
  "agent", "age",  # two
  "cost",
]
glyphs = "ascii"
bell = false
reduced-motion = true
tmux-passthrough = true

[notifications]
asks = false
finished = true
failed = false

[colors]
running = "#5aa9ff"
"##;
        let (s, warnings) = parse(text);
        assert_eq!(warnings, Vec::<String>::new());
        assert_eq!(s.theme, ThemeName::HighContrast);
        assert_eq!(s.density, Density::Comfortable);
        assert!(!s.key_bar && !s.show_costs && !s.bell && s.reduced_motion && s.tmux_passthrough);
        assert_eq!(s.columns, vec![Column::Agent, Column::Age, Column::Cost]);
        assert_eq!(s.glyphs, Glyphs::Ascii);
        assert_eq!(
            s.notify,
            Notify {
                asks: false,
                finished: true,
                failed: false
            }
        );
        assert_eq!(s.colors, vec![(Role::Running, Rgb(0x5a, 0xa9, 0xff))]);
        // The keymap: a preset and an action's own keys (keys.rs holds its rules).
        let (s, w) = parse("[keys]\npreset = \"emacs\"\naccept = [\"A\", \"a\"]\nkeys.stop = 3");
        assert_eq!(s.keymap.preset, crate::keys::Preset::Emacs);
        assert_eq!(s.keymap.all_words(crate::keys::Action::Accept), "A, a");
        assert_eq!(w.len(), 1, "{w:?}");
        // Dotted keys work too.
        let (s, w) = parse("notifications.finished = true\ncolors.failed = \"#f00\"");
        assert!(w.is_empty() && s.notify.finished);
        assert_eq!(s.colors, vec![(Role::Failed, Rgb(255, 0, 0))]);
    }

    #[test]
    fn an_unknown_key_is_named_and_ignored() {
        let (s, warnings) = parse("themes = \"dark\"\nkey_bar = false\n[sound]\nvolume = true");
        assert_eq!(s, Settings::default());
        assert_eq!(
            warnings,
            vec![
                "Line 1: themes isn't a setting, so it was ignored.".to_string(),
                "Line 2: key_bar isn't a setting, so it was ignored. Did you mean key-bar?".into(),
                "Line 4: sound.volume isn't a setting, so it was ignored.".into(),
            ]
        );
    }

    #[test]
    fn a_bad_value_falls_back_to_the_default() {
        let (s, warnings) = parse(
            "theme = \"solarized\"\ndensity = 3\nbell = \"yes\"\ncolumns = [\"step\", \"mood\"]\n[colors]\nrunning = \"blue\"\nteal = \"#008080\"",
        );
        assert_eq!(s.theme, ThemeName::Terminal);
        assert_eq!(s.density, Density::Compact);
        assert!(s.bell);
        assert_eq!(s.columns, vec![Column::Step]);
        assert!(s.colors.is_empty());
        assert_eq!(warnings, vec![
            "Line 1: theme can be terminal, light, dark or high-contrast, not \"solarized\"; using terminal.".to_string(),
            "Line 2: density can be compact or comfortable, not 3; using compact.".into(),
            "Line 3: bell can be true or false, not \"yes\"; using true.".into(),
            "Line 4: \"mood\" isn't a column (agent, step, age, cost or project), so it was left out.".into(),
            "Line 6: running needs a colour like \"#1a2b3c\", not \"blue\"; the theme's own is used.".into(),
            "Line 7: there's no colour called teal, so it was ignored (paper, ink, muted, line, selection, selection-ink, needs-you, running, passed, failed, ground, raised, fill, running-soft, passed-soft, failed-soft).".into(),
        ]);
    }

    #[test]
    fn unreadable_lines_and_repeats_are_said() {
        let (s, warnings) =
            parse("theme = \"dark\"\ntheme = \"light\"\nnot toml at all\ndensity = \"compact");
        assert_eq!(s.theme, ThemeName::Dark);
        assert_eq!(
            warnings,
            vec![
                "Line 3 isn't understood, so it was ignored.".to_string(),
                "Line 4 isn't understood, so it was ignored.".into(),
                "Line 2: theme is set twice; the first one is used.".into(),
            ]
        );
    }

    #[test]
    fn hostile_text_in_the_file_is_cleaned_in_warnings() {
        let (_, warnings) = parse("theme = \"\\u001b]52;c;aGk=\\u0007\"");
        assert_eq!(warnings.len(), 1);
        assert!(!warnings[0].chars().any(|c| c.is_control()), "{warnings:?}");
    }

    #[test]
    fn the_path_follows_xdg_then_home() {
        let env = Env {
            home: Some("/home/me".into()),
            ..Env::default()
        };
        assert_eq!(
            env.settings_path(),
            Some(PathBuf::from("/home/me/.config/toolroll/tui.toml"))
        );
        let env = Env {
            home: Some("/home/me".into()),
            xdg_config_home: Some("/home/me/cfg".into()),
            ..Env::default()
        };
        assert_eq!(
            env.settings_path(),
            Some(PathBuf::from("/home/me/cfg/toolroll/tui.toml"))
        );
        // A relative XDG_CONFIG_HOME is not one (the XDG rule).
        let env = Env {
            home: Some("/home/me".into()),
            xdg_config_home: Some("cfg".into()),
            ..Env::default()
        };
        assert_eq!(
            env.settings_path(),
            Some(PathBuf::from("/home/me/.config/toolroll/tui.toml"))
        );
        assert_eq!(Env::default().settings_path(), None);
    }

    #[test]
    fn only_a_private_plain_file_is_read() {
        assert_eq!(judge(true, 501, 0o100644, 10, 501), Ok(()));
        assert_eq!(judge(true, 501, 0o100600, 10, 501), Ok(()));
        assert!(judge(false, 501, 0o100644, 10, 501).is_err());
        assert_eq!(
            judge(true, 0, 0o100644, 10, 501),
            Err("it belongs to another user")
        );
        assert!(judge(true, 501, 0o100664, 10, 501).is_err());
        assert!(judge(true, 501, 0o100646, 10, 501).is_err());
        assert!(judge(true, 501, 0o100644, MAX_BYTES + 1, 501).is_err());
    }
}
