//! The workbench's one keymap: every act a key starts is an `Action`, looked up here and run by one function
//! (app.rs `run_action`), whether it came from its key or from the command palette (`:` / Ctrl-K).
//!
//! Three presets (`default`, `vim`, `emacs`) and per-action keys in tui.toml:
//!
//! ```toml
//! [keys]
//! preset = "vim"                # default | vim | emacs
//! accept = "A"                  # one key…
//! palette = ["ctrl-p", ":"]     # …or a list; it replaces the action's keys
//! ```
//!
//! Strict: an unknown action, a key this can't read, a key kept for something else, or two actions on one key gives a
//! plain warning, and the action keeps its default keys. Some keys are never an action's: Ctrl-C always quits, Ctrl-]
//! always leaves the terminal, Esc always cancels, and 1-9 answer a question. Keys of a dialog (y, Enter, t…) and of a
//! text box are the dialog's own and are not remapped: a remap never skips a pin or a confirm.
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

/// Where a key means an action: everywhere (Global), or in the Diff tab, whose keys come first there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Scope {
    Global,
    Diff,
}

/// What the palette files an action under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Group {
    Act,
    Move,
    Diff,
    Layout,
    Filter,
    Setting,
}

impl Group {
    pub fn word(self) -> &'static str {
        match self {
            Group::Act | Group::Move | Group::Diff => "Action",
            Group::Layout => "Layout",
            Group::Filter => "Filter",
            Group::Setting => "Setting",
        }
    }
}

macro_rules! actions {
    ($( $name:ident = $id:literal, $scope:ident, $group:ident, $label:literal, [$($key:literal),*]; )*) => {
        /// Every act a key (or the palette) can start.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum Action { $($name),* }

        /// Each action: its name in tui.toml, where its keys work, how the palette files and says it, its default keys.
        pub const SPECS: &[Spec] = &[
            $( Spec { action: Action::$name, id: $id, scope: Scope::$scope, group: Group::$group, label: $label, keys: &[$($key),*] } ),*
        ];
    };
}

actions! {
    MoveDown = "move-down", Global, Move, "Next item in the list", ["j", "down"];
    MoveUp = "move-up", Global, Move, "Previous item in the list", ["k", "up"];
    Open = "open", Global, Act, "Open: the changes for a result, else the live output", ["enter"];
    NextTab = "next-tab", Global, Move, "Next tab (Live, Steps, Diff, Terminal)", ["tab"];
    PreviousTab = "previous-tab", Global, Move, "Previous tab", ["backtab"];
    Steer = "steer", Global, Act, "Steer: send the running agent a note", ["s"];
    Pause = "pause", Global, Act, "Pause the build (again to resume)", ["p"];
    Stop = "stop", Global, Act, "Stop the build, or stop retrying a waiting task", ["x"];
    CancelTask = "cancel-task", Global, Act, "Cancel task (asks first)", ["X"];
    Resume = "resume", Global, Act, "Resume retrying a task you stopped (asks first)", [];
    Accept = "accept", Global, Act, "Accept the result, or approve a plan", ["a"];
    SendBack = "send-back", Global, Act, "Send the result back, with a note (on a failed task: retry it)", ["r"];
    Retry = "retry", Global, Act, "Retry a failed task (Review and retry)", [];
    TakeOver = "take-over", Global, Act, "Open build shell", ["t"];
    NewTask = "new-task", Global, Act, "New task", ["n"];
    NewThread = "new-thread", Global, Act, "New thread", ["T"];
    ThreadReply = "thread-reply", Global, Act, "Reply to the thread (s on a thread)", [];
    ThreadStop = "thread-stop", Global, Act, "Stop the thread's agent (x on a thread)", [];
    ThreadEnd = "thread-end", Global, Act, "End the thread, for good (X on a thread; asks first)", [];
    ThreadShip = "thread-ship", Global, Act, "Ship the thread's work (a on a thread; its terms first)", [];
    NextNeedsYou = "next-needs-you", Global, Move, "Next thing that needs you (oldest first)", ["!"];
    PreviousNeedsYou = "previous-needs-you", Global, Move, "Previous thing that needs you", ["@"];
    JumpBack = "jump-back", Global, Move, "Back to where each jump left from (again right away: forward)", ["'"];
    Search = "search", Global, Act, "Search this pane (Live, Steps, Diff, Terminal)", ["/"];
    OpenInEditor = "open-in-editor", Global, Act, "Open this pane's text in your $EDITOR", ["ctrl-e"];
    Palette = "palette", Global, Act, "Every action, task, project and setting", [":", "ctrl-k"];
    ScrollUp = "scroll-up", Global, Move, "Scroll up", ["pgup", "u"];
    ScrollDown = "scroll-down", Global, Move, "Scroll down", ["pgdn", "d"];
    Follow = "follow", Global, Move, "Follow the newest (the end)", ["end", "G"];
    Copy = "copy", Global, Act, "Copy to your terminal's scrollback (a hunk, or the terminal)", ["y"];
    Browser = "browser", Global, Act, "Open Toolroll in your browser", ["w"];
    Help = "help", Global, Act, "Keys", ["?"];
    Quit = "quit", Global, Act, "Quit", ["q"];
    Layout = "layout", Global, Layout, "Next layout (focused, side by side, grid of four)", ["L"];
    NextPane = "next-pane", Global, Layout, "Next pane", ["o"];
    PreviousPane = "previous-pane", Global, Layout, "Previous pane", ["O"];
    ListNarrower = "list-narrower", Global, Layout, "Narrower list (or the focused panel, when split)", ["<"];
    ListWider = "list-wider", Global, Layout, "Wider list (or the focused panel, when split)", [">"];
    Equalize = "equalize", Global, Layout, "Even splits, and the list at its usual width", ["="];
    ListCycle = "list-cycle", Global, Layout, "List: full, a slim rail, or hidden", ["b"];
    Zoom = "zoom", Global, Layout, "Zoom: the focused panel alone (again to come back)", ["z"];
    ListSide = "list-side", Global, Layout, "Move the list to the other side", [];
    LayoutFocused = "layout-focused", Global, Layout, "Focused: one panel", [];
    LayoutSideBySide = "layout-side-by-side", Global, Layout, "Side by side: two panels", [];
    WatchRunning = "watch-running", Global, Layout, "Watch running tasks", [];
    LayoutGrid = "layout-grid", Global, Layout, "Grid of four panels", [];
    FilterAll = "filter-all", Global, Filter, "Everything", [];
    FilterThisProject = "filter-this-project", Global, Filter, "This project", [];
    FilterNeedsMe = "filter-needs-me", Global, Filter, "Needs me", [];
    FilterToday = "filter-today", Global, Filter, "Today", [];
    FilterWorking = "filter-working", Global, Filter, "Needs: working", [];
    FilterFailed = "filter-failed", Global, Filter, "Needs: failed", [];
    FilterDone = "filter-done", Global, Filter, "Needs: done", [];
    NextTheme = "next-theme", Global, Setting, "Next theme, for this session", [];
    Costs = "costs", Global, Setting, "Show or hide costs, for this session", [];
    KeyBar = "key-bar", Global, Setting, "Show or hide the key bar, for this session", [];
    Settings = "settings", Global, Setting, "Settings in use", [];
    Agents = "agents", Global, Act, "Agents: add one, sign in, choose models", ["A"];
    LineDown = "line-down", Diff, Diff, "Next line", ["j", "down"];
    LineUp = "line-up", Diff, Diff, "Previous line", ["k", "up"];
    Top = "top", Diff, Diff, "First line of the file", ["home", "g"];
    NextHunk = "next-hunk", Diff, Diff, "Next hunk", ["]"];
    PreviousHunk = "previous-hunk", Diff, Diff, "Previous hunk", ["["];
    NextFile = "next-file", Diff, Diff, "Next file", ["}"];
    PreviousFile = "previous-file", Diff, Diff, "Previous file", ["{"];
    NextNote = "next-note", Diff, Diff, "Next note", ["n"];
    PreviousNote = "previous-note", Diff, Diff, "Previous note", ["N"];
    Note = "note", Diff, Diff, "A note on the line or hunk (kept here until you send)", ["c"];
    RemoveNote = "remove-note", Diff, Diff, "Remove the note under the cursor", ["backspace", "delete"];
    MoreAbove = "more-above", Diff, Diff, "More lines above the hunk", ["e"];
    MoreBelow = "more-below", Diff, Diff, "More lines below the hunk", ["E"];
    SideBySide = "side-by-side", Diff, Diff, "Side by side (on a wide window)", ["v"];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Spec {
    pub action: Action,
    pub id: &'static str,
    pub scope: Scope,
    pub group: Group,
    pub label: &'static str,
    pub keys: &'static [&'static str],
}

impl Action {
    pub fn spec(self) -> &'static Spec {
        SPECS.iter().find(|s| s.action == self).unwrap_or(&SPECS[0])
    }
    pub fn id(self) -> &'static str {
        self.spec().id
    }
    pub fn label(self) -> &'static str {
        self.spec().label
    }
    pub fn scope(self) -> Scope {
        self.spec().scope
    }
    pub fn from_id(id: &str) -> Option<Action> {
        SPECS.iter().find(|s| s.id == id).map(|s| s.action)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Preset {
    Default,
    Vim,
    Emacs,
}

impl Preset {
    pub const ALL: [Preset; 3] = [Preset::Default, Preset::Vim, Preset::Emacs];
    pub fn key(self) -> &'static str {
        match self {
            Preset::Default => "default",
            Preset::Vim => "vim",
            Preset::Emacs => "emacs",
        }
    }
    pub fn from_key(key: &str) -> Option<Preset> {
        Preset::ALL.into_iter().find(|p| p.key() == key)
    }
    /// The keys a preset adds to the defaults (every default key keeps working).
    fn extra(self) -> &'static [(Action, &'static [&'static str])] {
        match self {
            Preset::Default => &[],
            Preset::Vim => &[
                (Action::NextTab, &["l"]),
                (Action::PreviousTab, &["h"]),
                (Action::ScrollDown, &["ctrl-d", "ctrl-f"]),
                (Action::ScrollUp, &["ctrl-u", "ctrl-b"]),
                (Action::NextPane, &["ctrl-w"]),
            ],
            Preset::Emacs => &[
                (Action::MoveDown, &["ctrl-n"]),
                (Action::MoveUp, &["ctrl-p"]),
                (Action::LineDown, &["ctrl-n"]),
                (Action::LineUp, &["ctrl-p"]),
                (Action::ScrollDown, &["ctrl-v"]),
                (Action::ScrollUp, &["alt-v"]),
                (Action::Follow, &["alt->"]),
                (Action::Top, &["alt-<"]),
                (Action::Palette, &["alt-x"]),
                (Action::NextPane, &["alt-o"]),
            ],
        }
    }
}

// ---- the help screen, from the keymap ---------------------------------------------------------------------------------

/// Actions help shows as one row ("j/k  Move through the list"): the pair, and the row's words.
const PAIRS: &[(Action, Action, &str)] = &[
    (Action::MoveDown, Action::MoveUp, "Move through the list"),
    (
        Action::NextNeedsYou,
        Action::PreviousNeedsYou,
        "Next / previous that needs you",
    ),
    (
        Action::ListNarrower,
        Action::ListWider,
        "Narrower / wider list (or split)",
    ),
    (Action::NextTab, Action::PreviousTab, "Next / previous tab"),
    (Action::ScrollUp, Action::ScrollDown, "Scroll up / down"),
    (
        Action::NextPane,
        Action::PreviousPane,
        "Next / previous pane",
    ),
    (Action::LineDown, Action::LineUp, "Next / previous line"),
    (
        Action::NextHunk,
        Action::PreviousHunk,
        "Next / previous hunk",
    ),
    (
        Action::NextFile,
        Action::PreviousFile,
        "Next / previous file",
    ),
    (
        Action::NextNote,
        Action::PreviousNote,
        "Next / previous note",
    ),
    (
        Action::MoreAbove,
        Action::MoreBelow,
        "More lines above / below the hunk",
    ),
];

/// One row of the help screen: the keys as words, what they do, and the actions they are.
#[derive(Debug, Clone, PartialEq)]
pub struct HelpRow {
    pub keys: String,
    pub words: String,
    pub scope: Scope,
    pub actions: Vec<Action>,
}

/// Every action that has a key in this keymap, in SPECS order (a pair as one row): the help screen is made from this,
/// so it says exactly the keys in use (tui.toml's own included) and can't drift from the keymap.
pub fn help_rows(map: &Keymap) -> Vec<HelpRow> {
    let mut rows = vec![];
    for spec in SPECS {
        let a = spec.action;
        if PAIRS.iter().any(|(_, second, _)| *second == a) {
            continue;
        }
        let (actions, words) = match PAIRS.iter().find(|(first, _, _)| *first == a) {
            Some((first, second, words)) => (vec![*first, *second], words.to_string()),
            None => (vec![a], help_words(a).unwrap_or(spec.label).to_string()),
        };
        let keys: Vec<String> = actions
            .iter()
            .map(|x| map.key_words(*x))
            .filter(|k| !k.is_empty())
            .collect();
        if keys.is_empty() {
            continue;
        }
        rows.push(HelpRow {
            keys: keys.join("/"),
            words,
            scope: spec.scope,
            actions,
        });
    }
    rows
}

/// Shorter words for help's two columns, where the palette's label runs long.
fn help_words(a: Action) -> Option<&'static str> {
    Some(match a {
        Action::Open => "Open the changes, else the live output",
        Action::Stop => "Stop the build, or its retries",
        Action::SendBack => "Send back with a note; retry if failed",
        Action::TakeOver => "Open build shell",
        Action::JumpBack => "Jump back (again: forward)",
        Action::Search => "Search this pane",
        Action::OpenInEditor => "Open this pane in $EDITOR",
        Action::Equalize => "Even splits, usual list width",
        Action::ListCycle => "List: full, rail, hidden",
        Action::Zoom => "Zoom the focused panel",
        Action::Palette => "Every action, task and setting",
        Action::Copy => "Copy to your terminal's scrollback",
        Action::Help => "These keys",
        Action::Layout => "Next layout (one, two or four panels)",
        Action::Agents => "Agents: add, sign in, choose models",
        Action::Follow => "Follow the newest",
        Action::Note => "A note on the line or hunk",
        Action::RemoveNote => "Remove the note here",
        Action::SideBySide => "Side by side (a wide window)",
        _ => return None,
    })
}

/// Help's tui.toml example: an action and a key no preset binds (so the example never moves a key off another act).
pub const HELP_EXAMPLE: (&str, &str) = ("accept", "f2");

/// The keys no tui.toml can change, as help says them.
pub const FIXED_KEYS: &[(&str, &str)] = &[
    ("1-9", "Answer the agent's question"),
    ("Esc", "Cancel, close, or go back"),
    ("Ctrl-]", "Leave a terminal you are typing in"),
    ("Ctrl-C", "Quit"),
];

// ---- keys as written and as pressed ---------------------------------------------------------------------------------

/// A key as the keymap compares it: the key and only Ctrl and Alt (Shift is in the character itself).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Chord {
    pub code: KeyCode,
    pub mods: KeyModifiers,
}

impl Chord {
    pub fn of(key: &KeyEvent) -> Chord {
        let mut mods = key.modifiers & (KeyModifiers::CONTROL | KeyModifiers::ALT);
        let code = match key.code {
            // Ctrl with a letter is the same key whatever its case.
            KeyCode::Char(c) if mods.contains(KeyModifiers::CONTROL) => {
                KeyCode::Char(c.to_ascii_lowercase())
            }
            KeyCode::Tab if key.modifiers.contains(KeyModifiers::SHIFT) => KeyCode::BackTab,
            other => other,
        };
        if code == KeyCode::BackTab {
            mods.remove(KeyModifiers::SHIFT);
        }
        Chord { code, mods }
    }

    /// "j", "G", "Ctrl-K", "Alt-X", "Enter", "PgUp", "Shift-Tab".
    pub fn words(&self) -> String {
        let base = match self.code {
            KeyCode::Char(' ') => "Space".to_string(),
            KeyCode::Char(c) if self.mods.contains(KeyModifiers::CONTROL) => {
                c.to_ascii_uppercase().to_string()
            }
            KeyCode::Char(c) => c.to_string(),
            KeyCode::Enter => "Enter".into(),
            KeyCode::Tab => "Tab".into(),
            KeyCode::BackTab => "Shift-Tab".into(),
            KeyCode::Esc => "Esc".into(),
            KeyCode::Backspace => "Backspace".into(),
            KeyCode::Delete => "Delete".into(),
            KeyCode::Insert => "Insert".into(),
            KeyCode::Home => "Home".into(),
            KeyCode::End => "End".into(),
            KeyCode::PageUp => "PgUp".into(),
            KeyCode::PageDown => "PgDn".into(),
            KeyCode::Up => "Up".into(),
            KeyCode::Down => "Down".into(),
            KeyCode::Left => "Left".into(),
            KeyCode::Right => "Right".into(),
            KeyCode::F(n) => format!("F{n}"),
            _ => "?".into(),
        };
        let mut out = String::new();
        if self.mods.contains(KeyModifiers::CONTROL) {
            out.push_str("Ctrl-");
        }
        if self.mods.contains(KeyModifiers::ALT) {
            out.push_str("Alt-");
        }
        out.push_str(&base);
        out
    }
}

/// A key as tui.toml writes it: one printable character ("j", "G", ":"), or a name ("enter", "pgdn", "f5"), after
/// any of "ctrl-", "alt-" or "shift-" (Shift only before tab). Names and modifiers are any case; a single character's
/// case matters ("g" is not "G").
pub fn parse_chord(s: &str) -> Option<Chord> {
    let mut rest = s.trim();
    let mut mods = KeyModifiers::NONE;
    let mut shift = false;
    loop {
        let lower = rest.to_ascii_lowercase();
        let take = |p: &str| lower.starts_with(p) && rest.chars().count() > p.len();
        if take("ctrl-") {
            mods |= KeyModifiers::CONTROL;
            rest = &rest[5..];
        } else if take("alt-") {
            mods |= KeyModifiers::ALT;
            rest = &rest[4..];
        } else if take("shift-") {
            shift = true;
            rest = &rest[6..];
        } else {
            break;
        }
    }
    let mut chars = rest.chars();
    let code = match (chars.next(), chars.next()) {
        (Some(c), None) if !c.is_control() && !c.is_whitespace() => {
            if mods.contains(KeyModifiers::CONTROL) {
                if !c.is_ascii_graphic() {
                    return None;
                }
                KeyCode::Char(c.to_ascii_lowercase())
            } else {
                KeyCode::Char(c)
            }
        }
        (Some(_), Some(_)) => match rest.to_ascii_lowercase().as_str() {
            "enter" | "return" => KeyCode::Enter,
            "tab" if shift => KeyCode::BackTab,
            "tab" => KeyCode::Tab,
            "backtab" => KeyCode::BackTab,
            "esc" | "escape" => KeyCode::Esc,
            "space" => KeyCode::Char(' '),
            "backspace" => KeyCode::Backspace,
            "delete" | "del" => KeyCode::Delete,
            "insert" => KeyCode::Insert,
            "home" => KeyCode::Home,
            "end" => KeyCode::End,
            "pgup" | "pageup" => KeyCode::PageUp,
            "pgdn" | "pagedown" => KeyCode::PageDown,
            "up" => KeyCode::Up,
            "down" => KeyCode::Down,
            "left" => KeyCode::Left,
            "right" => KeyCode::Right,
            f if f.starts_with('f') => match f[1..].parse::<u8>() {
                Ok(n) if (1..=12).contains(&n) => KeyCode::F(n),
                _ => return None,
            },
            _ => return None,
        },
        _ => return None,
    };
    // Shift is only a key's own with Tab (a character carries its case).
    if shift && code != KeyCode::BackTab {
        return None;
    }
    Some(Chord { code, mods })
}

/// What a key is kept for, when it is never an action's.
pub fn reserved(chord: &Chord) -> Option<&'static str> {
    let ctrl = chord.mods.contains(KeyModifiers::CONTROL);
    match chord.code {
        KeyCode::Char('c') if ctrl => Some("Ctrl-C always quits"),
        KeyCode::Char(']') | KeyCode::Char('5') if ctrl => {
            Some("Ctrl-] always leaves the terminal")
        }
        KeyCode::Esc => Some("Esc always cancels"),
        KeyCode::Char('1'..='9') if chord.mods.is_empty() => Some("1-9 answer a question"),
        _ => None,
    }
}

// ---- the keymap ---------------------------------------------------------------------------------------------------

/// How an action's keys were written in tui.toml: keys, or something that isn't (its words, for the warning).
#[derive(Debug, Clone, PartialEq)]
pub enum Written {
    Keys(Vec<String>),
    Bad(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Keymap {
    pub preset: Preset,
    /// Every action's keys, in SPECS order.
    keys: Vec<(Action, Vec<Chord>)>,
}

impl Default for Keymap {
    fn default() -> Keymap {
        Keymap::preset(Preset::Default)
    }
}

impl Keymap {
    /// A preset's keys: the defaults and what the preset adds.
    pub fn preset(preset: Preset) -> Keymap {
        let mut keys: Vec<(Action, Vec<Chord>)> = SPECS
            .iter()
            .map(|s| {
                (
                    s.action,
                    s.keys.iter().filter_map(|k| parse_chord(k)).collect(),
                )
            })
            .collect();
        for (action, extra) in preset.extra() {
            if let Some((_, list)) = keys.iter_mut().find(|(a, _)| a == action) {
                list.extend(extra.iter().filter_map(|k| parse_chord(k)));
            }
        }
        Keymap { preset, keys }
    }

    pub fn keys_of(&self, action: Action) -> &[Chord] {
        self.keys
            .iter()
            .find(|(a, _)| *a == action)
            .map(|(_, k)| k.as_slice())
            .unwrap_or(&[])
    }

    /// An action's first key in words ("" when it has none).
    pub fn key_words(&self, action: Action) -> String {
        self.keys_of(action)
            .first()
            .map(Chord::words)
            .unwrap_or_default()
    }

    /// Every key of an action in words, "a, A".
    pub fn all_words(&self, action: Action) -> String {
        let all: Vec<String> = self.keys_of(action).iter().map(Chord::words).collect();
        if all.is_empty() {
            "no key".into()
        } else {
            all.join(", ")
        }
    }

    /// The action a key means in a scope (only that scope's actions).
    pub fn lookup(&self, scope: Scope, key: &KeyEvent) -> Option<Action> {
        let chord = Chord::of(key);
        self.keys
            .iter()
            .find(|(a, k)| a.scope() == scope && k.contains(&chord))
            .map(|(a, _)| *a)
    }

    /// The keymap tui.toml asks for: the preset (`preset`, its line) and each action's keys, with a plain warning for
    /// everything not used. An override that can't be used leaves that action on its default keys.
    pub fn build(
        preset: Option<(usize, Written)>,
        overrides: &[(usize, String, Written)],
    ) -> (Keymap, Vec<String>) {
        let mut warnings = vec![];
        let preset = match preset {
            None => Preset::Default,
            Some((_, Written::Keys(k))) if k.len() == 1 && Preset::from_key(&k[0]).is_some() => {
                Preset::from_key(&k[0]).unwrap_or(Preset::Default)
            }
            Some((n, written)) => {
                let shown = match written {
                    Written::Keys(k) => format!("\"{}\"", k.join(", ")),
                    Written::Bad(b) => b,
                };
                warnings.push(format!(
                    "Line {n}: preset can be default, vim or emacs, not {}; using default.",
                    crate::text::fit(&crate::text::clean(&shown), 32)
                ));
                Preset::Default
            }
        };
        let base = Keymap::preset(preset);
        // The overrides that read cleanly: line, action, keys.
        let mut wanted: Vec<(usize, Action, Vec<Chord>)> = vec![];
        for (n, name, written) in overrides {
            let shown_name = crate::text::fit(&crate::text::clean(name), 32);
            let Some(action) = Action::from_id(name) else {
                warnings.push(format!(
                    "Line {n}: {shown_name} isn't an action, so it was ignored."
                ));
                continue;
            };
            let keeps = format!("{} keeps {}", action.id(), base.all_words(action));
            let list = match written {
                Written::Keys(k) if !k.is_empty() => k,
                _ => {
                    warnings.push(format!(
                        "Line {n}: {} needs a key like \"a\" or a list like [\"a\", \"A\"]; {keeps}.",
                        action.id()
                    ));
                    continue;
                }
            };
            let mut chords: Vec<Chord> = vec![];
            let mut problem = None;
            for k in list {
                match parse_chord(k) {
                    None => {
                        problem = Some(format!(
                            "\"{}\" isn't a key Toolroll knows",
                            crate::text::fit(&crate::text::clean(k), 24)
                        ));
                        break;
                    }
                    Some(c) => {
                        if let Some(why) = reserved(&c) {
                            problem = Some(format!("{} is kept ({why})", c.words()));
                            break;
                        }
                        if !chords.contains(&c) {
                            chords.push(c);
                        }
                    }
                }
            }
            match problem {
                Some(p) => warnings.push(format!("Line {n}: {p}, so {keeps}.")),
                None => wanted.push((*n, action, chords)),
            }
        }
        // Clashes: two actions on one key in one scope, or an override shadowing another scope's action. Each override
        // in a clash goes back to its default keys, until none is left (the defaults themselves never clash).
        loop {
            let map = base.with(&wanted);
            let overridden = |a: Action| wanted.iter().any(|(_, w, _)| *w == a);
            let mut clash: Option<(Action, Action, Chord)> = None;
            'find: for (i, (a, ka)) in map.keys.iter().enumerate() {
                for (b, kb) in map.keys.iter().skip(i + 1) {
                    let same_scope = a.scope() == b.scope();
                    if !(same_scope || overridden(*a) || overridden(*b)) {
                        continue;
                    }
                    if let Some(c) = ka.iter().find(|c| kb.contains(c)) {
                        if overridden(*a) || overridden(*b) {
                            clash = Some((*a, *b, *c));
                            break 'find;
                        }
                    }
                }
            }
            let Some((a, b, chord)) = clash else {
                return (map, warnings);
            };
            for (this, other) in [(a, b), (b, a)] {
                if let Some(at) = wanted.iter().position(|(_, w, _)| *w == this) {
                    let (n, _, _) = wanted.remove(at);
                    warnings.push(format!(
                        "Line {n}: {} on {} clashes with {}, so {} keeps {}.",
                        this.id(),
                        chord.words(),
                        other.id(),
                        this.id(),
                        base.all_words(this)
                    ));
                }
            }
        }
    }

    fn with(&self, overrides: &[(usize, Action, Vec<Chord>)]) -> Keymap {
        let mut map = self.clone();
        for (_, action, chords) in overrides {
            if let Some((_, list)) = map.keys.iter_mut().find(|(a, _)| a == action) {
                *list = chords.clone();
            }
        }
        map
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(code: KeyCode, mods: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, mods)
    }
    fn keys(list: &[&str]) -> Written {
        Written::Keys(list.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn every_default_key_reads_and_no_preset_clashes_in_a_scope() {
        for spec in SPECS {
            for key in spec.keys {
                assert!(parse_chord(key).is_some(), "{} {key}", spec.id);
            }
        }
        for preset in Preset::ALL {
            for (_, extra) in preset.extra() {
                for key in *extra {
                    assert!(parse_chord(key).is_some(), "{key}");
                }
            }
            let map = Keymap::preset(preset);
            for (i, (a, ka)) in map.keys.iter().enumerate() {
                for c in ka {
                    assert!(reserved(c).is_none(), "{} takes a kept key", a.id());
                }
                for (b, kb) in map.keys.iter().skip(i + 1) {
                    if a.scope() == b.scope() {
                        assert!(
                            !ka.iter().any(|c| kb.contains(c)),
                            "{:?}: {} and {} share a key",
                            preset,
                            a.id(),
                            b.id()
                        );
                    }
                }
            }
            // Building a preset with nothing else warns about nothing.
            let (built, w) = Keymap::build(Some((1, keys(&[preset.key()]))), &[]);
            assert_eq!(built, map);
            assert!(w.is_empty(), "{w:?}");
        }
    }

    #[test]
    fn keys_as_written() {
        let c = |s| parse_chord(s).map(|c| c.words());
        assert_eq!(c("j"), Some("j".into()));
        assert_eq!(c("G"), Some("G".into()));
        assert_eq!(c("Ctrl-K"), Some("Ctrl-K".into()));
        assert_eq!(c("ctrl-K"), c("ctrl-k"));
        assert_eq!(c("alt-x"), Some("Alt-x".into()));
        assert_eq!(c("enter"), Some("Enter".into()));
        assert_eq!(c("shift-tab"), Some("Shift-Tab".into()));
        assert_eq!(c("PgDn"), Some("PgDn".into()));
        assert_eq!(c("f5"), Some("F5".into()));
        assert_eq!(c("space"), Some("Space".into()));
        assert_eq!(c(":"), Some(":".into()));
        assert_eq!(c("alt->"), Some("Alt->".into()));
        for bad in [
            "", "jj", "ctrl-", "f13", "shift-a", "hyper-x", "ctrl-é", " ", "\u{1b}",
        ] {
            assert_eq!(parse_chord(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_pressed_key_finds_its_action() {
        let map = Keymap::default();
        let none = KeyModifiers::NONE;
        assert_eq!(
            map.lookup(Scope::Global, &k(KeyCode::Char('j'), none)),
            Some(Action::MoveDown)
        );
        assert_eq!(
            map.lookup(Scope::Diff, &k(KeyCode::Char('j'), none)),
            Some(Action::LineDown)
        );
        // Shift is in the character: 'G' with or without the Shift flag.
        assert_eq!(
            map.lookup(Scope::Global, &k(KeyCode::Char('G'), KeyModifiers::SHIFT)),
            Some(Action::Follow)
        );
        assert_eq!(
            map.lookup(Scope::Global, &k(KeyCode::Char('K'), KeyModifiers::CONTROL)),
            Some(Action::Palette)
        );
        assert_eq!(
            map.lookup(Scope::Global, &k(KeyCode::BackTab, KeyModifiers::SHIFT)),
            Some(Action::PreviousTab)
        );
        assert_eq!(
            map.lookup(Scope::Global, &k(KeyCode::Char('1'), none)),
            None
        );
        let vim = Keymap::preset(Preset::Vim);
        assert_eq!(
            vim.lookup(Scope::Global, &k(KeyCode::Char('d'), KeyModifiers::CONTROL)),
            Some(Action::ScrollDown)
        );
        assert_eq!(
            vim.lookup(Scope::Global, &k(KeyCode::Char('j'), none)),
            Some(Action::MoveDown)
        );
        let emacs = Keymap::preset(Preset::Emacs);
        assert_eq!(
            emacs.lookup(Scope::Global, &k(KeyCode::Char('x'), KeyModifiers::ALT)),
            Some(Action::Palette)
        );
        assert_eq!(
            emacs.lookup(Scope::Diff, &k(KeyCode::Char('n'), KeyModifiers::CONTROL)),
            Some(Action::LineDown)
        );
    }

    #[test]
    fn an_override_replaces_the_actions_keys_and_swaps_work() {
        let (map, w) = Keymap::build(
            None,
            &[
                (3, "accept".into(), keys(&["r"])),
                (4, "send-back".into(), keys(&["a", "R"])),
                (5, "palette".into(), keys(&["ctrl-p"])),
            ],
        );
        assert!(w.is_empty(), "{w:?}");
        let none = KeyModifiers::NONE;
        assert_eq!(
            map.lookup(Scope::Global, &k(KeyCode::Char('r'), none)),
            Some(Action::Accept)
        );
        assert_eq!(
            map.lookup(Scope::Global, &k(KeyCode::Char('a'), none)),
            Some(Action::SendBack)
        );
        assert_eq!(
            map.lookup(Scope::Global, &k(KeyCode::Char(':'), none)),
            None
        );
        assert_eq!(map.key_words(Action::Palette), "Ctrl-P");
    }

    #[test]
    fn unknown_actions_bad_keys_and_kept_keys_warn_and_fall_back() {
        let (map, w) = Keymap::build(
            Some((1, keys(&["nano"]))),
            &[
                (2, "acept".into(), keys(&["A"])),
                (3, "accept".into(), keys(&["hyper-a"])),
                (4, "quit".into(), keys(&["ctrl-c"])),
                (5, "help".into(), keys(&["ctrl-]"])),
                (6, "stop".into(), keys(&["esc"])),
                (7, "pause".into(), keys(&["1"])),
                (8, "steer".into(), Written::Bad("3".into())),
                (9, "browser".into(), keys(&[])),
            ],
        );
        assert_eq!(map, Keymap::default());
        assert_eq!(
            w,
            vec![
                "Line 1: preset can be default, vim or emacs, not \"nano\"; using default.".to_string(),
                "Line 2: acept isn't an action, so it was ignored.".into(),
                "Line 3: \"hyper-a\" isn't a key Toolroll knows, so accept keeps a.".into(),
                "Line 4: Ctrl-C is kept (Ctrl-C always quits), so quit keeps q.".into(),
                "Line 5: Ctrl-] is kept (Ctrl-] always leaves the terminal), so help keeps ?.".into(),
                "Line 6: Esc is kept (Esc always cancels), so stop keeps x.".into(),
                "Line 7: 1 is kept (1-9 answer a question), so pause keeps p.".into(),
                "Line 8: steer needs a key like \"a\" or a list like [\"a\", \"A\"]; steer keeps s.".into(),
                "Line 9: browser needs a key like \"a\" or a list like [\"a\", \"A\"]; browser keeps w.".into(),
            ]
        );
    }

    #[test]
    fn a_clash_warns_and_both_sides_keep_their_defaults() {
        // accept on j clashes with move-down (a default): accept keeps a.
        let (map, w) = Keymap::build(None, &[(2, "accept".into(), keys(&["j"]))]);
        assert_eq!(map, Keymap::default());
        assert_eq!(
            w,
            vec!["Line 2: accept on j clashes with move-down, so accept keeps a.".to_string()]
        );
        // Two overrides on one key: both go back.
        let (map, w) = Keymap::build(
            None,
            &[
                (2, "accept".into(), keys(&["z"])),
                (3, "stop".into(), keys(&["z"])),
            ],
        );
        assert_eq!(map, Keymap::default());
        assert_eq!(w.len(), 2, "{w:?}");
        // An override never shadows another scope's action: a Diff note on `a` would hide Accept in the Diff tab.
        let (map, w) = Keymap::build(None, &[(4, "note".into(), keys(&["a"]))]);
        assert_eq!(map, Keymap::default());
        assert_eq!(
            w,
            vec!["Line 4: note on a clashes with accept, so note keeps c.".to_string()]
        );
        // Accept on j would be hidden in the Diff tab (j is its next line): that is a clash too.
        let (map, w) = Keymap::build(
            None,
            &[
                (2, "accept".into(), keys(&["j"])),
                (3, "move-down".into(), keys(&["a"])),
            ],
        );
        assert_eq!(map.key_words(Action::Accept), "a");
        assert!(
            w.iter().any(|l| l.contains("accept on j clashes with")),
            "{w:?}"
        );
    }
}
