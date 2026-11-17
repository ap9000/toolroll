//! Notifications and the terminal's title, in our own words only.
//!
//! They come from changes in the work list the screen already reads: a task that starts waiting on you ("asks"),
//! finishes, or fails — each at most once per change, and gathered so that at most one goes out every few seconds.
//! The words are ours ("Toolroll: Add CSV export needs you"); the only thing from outside is the task's title, cleaned
//! of every control character and of `;` (which would end the notification's text) and cut short. The escape sequences
//! are built here, from constants, and nowhere else: agent text never sets a title, a notification or anything else.
//!
//! Desktop notifications are OSC 9 (iTerm2, WezTerm, Ghostty, kitty and most others) or OSC 777 (foot, urxvt, VTE);
//! inside tmux they go out only when the person says tmux passes them through (`tmux-passthrough = true` in tui.toml,
//! for a tmux with `allow-passthrough` on), wrapped for it; nothing is run to find out. The bell (when
//! on) rings with each one, in or out of tmux (tmux shows a bell itself).
use crate::app::{Item, Section};
use crate::settings::{Env, Notify};
use crate::text::{clean, fit};
use std::collections::HashMap;

/// Seconds between notifications: what changes meanwhile goes out together in the next.
pub const GATHER_SECS: i64 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Asks,
    Finished,
    Failed,
}

/// What a task was last seen as.
#[derive(Debug, Clone, PartialEq)]
struct Seen {
    /// What it asks, while it waits on you.
    asks: Option<String>,
    tone: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Notifier {
    seen: HashMap<String, Seen>,
    started: bool,
    pending: Vec<(Kind, String)>,
    last_sent: Option<i64>,
}

/// A task's title as a notification may carry it: cleaned (no control character, no bidi trick), no `;`, short.
pub fn notice_title(title: &str) -> String {
    let t: String = clean(title)
        .chars()
        .filter(|c| *c != ';' && *c != '\u{fffd}')
        .collect();
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        "A task".into()
    } else {
        fit(&t, 48)
    }
}

/// The words for what was gathered.
pub fn words(notes: &[(Kind, String)]) -> Option<String> {
    match notes {
        [] => None,
        [(kind, title)] => Some(format!(
            "Toolroll: {title} {}",
            match kind {
                Kind::Asks => "needs you",
                Kind::Finished => "finished",
                Kind::Failed => "failed",
            }
        )),
        many => {
            let n = |k: Kind| many.iter().filter(|(kind, _)| *kind == k).count();
            let mut parts = vec![];
            match n(Kind::Asks) {
                0 => {}
                1 => parts.push("1 needs you".to_string()),
                c => parts.push(format!("{c} need you")),
            }
            if n(Kind::Failed) > 0 {
                parts.push(format!("{} failed", n(Kind::Failed)));
            }
            if n(Kind::Finished) > 0 {
                parts.push(format!("{} finished", n(Kind::Finished)));
            }
            Some(format!("Toolroll: {}", parts.join(", ")))
        }
    }
}

impl Notifier {
    /// One read of the work list: the changes it shows that notify (per `wanted`), gathered; the words to send now,
    /// if it's time. The first read only learns what is there (nothing that was already waiting notifies).
    pub fn observe(&mut self, items: &[Item], wanted: Notify, now: i64) -> Option<String> {
        let first = !self.started;
        self.started = true;
        for item in items {
            let asks = (item.section == Section::NeedsYou).then(|| item.word.clone());
            let was = self.seen.get(&item.id);
            let kind = if first {
                None
            } else if item.tone == "problem" && was.is_none_or(|w| w.tone != "problem") {
                Some(Kind::Failed)
            } else if asks.is_some() && was.is_none_or(|w| w.asks != asks) {
                Some(Kind::Asks)
            } else if matches!(item.tone.as_str(), "done" | "ready")
                && was.is_some_and(|w| !matches!(w.tone.as_str(), "done" | "ready"))
            {
                Some(Kind::Finished)
            } else {
                None
            };
            let want = match kind {
                Some(Kind::Asks) => wanted.asks,
                Some(Kind::Finished) => wanted.finished,
                Some(Kind::Failed) => wanted.failed,
                None => false,
            };
            if let (true, Some(kind)) = (want, kind) {
                // At most one per task per change: a later change of the same task replaces an unsent one.
                self.pending.retain(|(_, t)| t != &item.id);
                self.pending.push((kind, item.id.clone()));
            }
            // A change of a kind that is off isn't marked seen: turned back on, whatever is still waiting says so.
            if kind.is_some() && !want {
                continue;
            }
            self.seen.insert(
                item.id.clone(),
                Seen {
                    asks,
                    tone: item.tone.clone(),
                },
            );
        }
        if self.seen.len() > 4096 {
            let listed: std::collections::HashSet<&String> = items.iter().map(|i| &i.id).collect();
            self.seen.retain(|id, _| listed.contains(id));
        }
        self.flush(items, now)
    }

    /// Every tick: what was gathered goes out once the quiet time has passed.
    pub fn tick(&mut self, items: &[Item], now: i64) -> Option<String> {
        self.flush(items, now)
    }

    fn flush(&mut self, items: &[Item], now: i64) -> Option<String> {
        if self.pending.is_empty()
            || self
                .last_sent
                .is_some_and(|t| now.saturating_sub(t) < GATHER_SECS)
        {
            return None;
        }
        let titled: Vec<(Kind, String)> = self
            .pending
            .drain(..)
            .map(|(kind, id)| {
                let title = items
                    .iter()
                    .find(|i| i.id == id)
                    .map(|i| notice_title(&i.title))
                    .unwrap_or_else(|| "A task".into());
                (kind, title)
            })
            .collect();
        self.last_sent = Some(now);
        words(&titled)
    }
}

// ---- where notifications go -----------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Desktop {
    Osc9,
    Osc777,
    /// Inside tmux without passthrough: no desktop notification (the bell only, when on).
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reach {
    pub desktop: Desktop,
    /// Wrapped for tmux's passthrough.
    pub tmux: bool,
}

impl Default for Reach {
    fn default() -> Reach {
        Reach {
            desktop: Desktop::Osc9,
            tmux: false,
        }
    }
}

impl Reach {
    /// Where notifications go in this terminal (`passthrough`: tui.toml says tmux passes them on).
    pub fn of(env: &Env, passthrough: bool) -> Reach {
        let osc777 = env.vte
            || env
                .term
                .as_deref()
                .is_some_and(|t| t.starts_with("foot") || t.contains("rxvt"));
        let desktop = if osc777 {
            Desktop::Osc777
        } else {
            Desktop::Osc9
        };
        match (env.tmux, passthrough) {
            (false, _) => Reach {
                desktop,
                tmux: false,
            },
            (true, true) => Reach {
                desktop,
                tmux: true,
            },
            (true, false) => Reach {
                desktop: Desktop::Off,
                tmux: true,
            },
        }
    }

    pub fn words(self) -> &'static str {
        match (self.desktop, self.tmux) {
            (Desktop::Off, _) => {
                "the bell only: in tmux, tmux-passthrough = true sends desktop ones"
            }
            (Desktop::Osc777, true) => "desktop notifications (OSC 777, through tmux)",
            (Desktop::Osc9, true) => "desktop notifications (OSC 9, through tmux)",
            (Desktop::Osc777, false) => "desktop notifications (OSC 777)",
            (Desktop::Osc9, false) => "desktop notifications (OSC 9)",
        }
    }
}

/// Only what may sit inside a notification: printable, no `;`, short. (Callers pass our own words; this holds anyway.)
fn safe(words: &str) -> String {
    clean(words)
        .chars()
        .filter(|c| !c.is_control() && *c != ';' && *c != '\u{fffd}')
        .take(200)
        .collect()
}

/// The bytes for one notification: the desktop one for this terminal, then the bell when it is on.
pub fn sequence(words: &str, reach: Reach, bell: bool) -> String {
    let text = safe(words);
    let inner = match reach.desktop {
        Desktop::Osc9 => format!("\x1b]9;{text}\x07"),
        Desktop::Osc777 => format!("\x1b]777;notify;Toolroll;{text}\x07"),
        Desktop::Off => String::new(),
    };
    let mut out = if reach.tmux && !inner.is_empty() {
        format!("\x1bPtmux;{}\x1b\\", inner.replace('\x1b', "\x1b\x1b"))
    } else {
        inner
    };
    if bell {
        out.push('\x07');
    }
    out
}

/// The window title: how many tasks wait on you, and our name. Nothing else ever sets it.
pub fn title_sequence(needs: i64) -> String {
    if needs > 0 {
        format!("\x1b]2;({}) Toolroll\x07", needs.min(9999))
    } else {
        "\x1b]2;Toolroll\x07".to_string()
    }
}

/// Keep the title the terminal had (xterm's title stack), to give it back on the way out.
pub const TITLE_PUSH: &str = "\x1b[22;2t";
pub const TITLE_POP: &str = "\x1b[23;2t";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sequences_are_exactly_ours() {
        let r9 = Reach::default();
        assert_eq!(
            sequence("Toolroll: x needs you", r9, false),
            "\x1b]9;Toolroll: x needs you\x07"
        );
        assert_eq!(
            sequence("Toolroll: x needs you", r9, true),
            "\x1b]9;Toolroll: x needs you\x07\x07"
        );
        let r777 = Reach {
            desktop: Desktop::Osc777,
            tmux: false,
        };
        assert_eq!(
            sequence("Toolroll: x failed", r777, false),
            "\x1b]777;notify;Toolroll;Toolroll: x failed\x07"
        );
        let wrapped = Reach {
            desktop: Desktop::Osc9,
            tmux: true,
        };
        assert_eq!(
            sequence("Toolroll: x failed", wrapped, true),
            "\x1bPtmux;\x1b\x1b]9;Toolroll: x failed\x07\x1b\\\x07"
        );
        let off = Reach {
            desktop: Desktop::Off,
            tmux: true,
        };
        assert_eq!(sequence("Toolroll: x failed", off, true), "\x07");
        assert_eq!(sequence("Toolroll: x failed", off, false), "");
        // Whatever reaches it, only our bytes are control bytes.
        let hostile = "a\x1b]52;c;aGk=\x07b\x1b[2J\u{9b}c;d\u{202e}e";
        let out = sequence(hostile, r9, false);
        assert_eq!(out.matches('\x1b').count(), 1);
        assert_eq!(out.matches('\x07').count(), 1);
        assert!(out.starts_with("\x1b]9;") && out.ends_with('\x07'));
        assert!(!out[4..out.len() - 1]
            .chars()
            .any(|c| c.is_control() || c == ';' || c == '\u{202e}'));
    }

    #[test]
    fn the_title_is_ours() {
        assert_eq!(title_sequence(0), "\x1b]2;Toolroll\x07");
        assert_eq!(title_sequence(2), "\x1b]2;(2) Toolroll\x07");
    }

    #[test]
    fn titles_are_cleaned_and_cut() {
        assert_eq!(
            notice_title("evil\x1b]0;pwned\x07 title"),
            "evil]0pwned title"
        );
        assert_eq!(notice_title("\x1b\x07;"), "A task");
        assert_eq!(notice_title(&"a".repeat(80)).chars().count(), 48);
    }

    #[test]
    fn gathered_words() {
        assert_eq!(
            words(&[(Kind::Asks, "Add CSV export".into())]).unwrap(),
            "Toolroll: Add CSV export needs you"
        );
        assert_eq!(
            words(&[
                (Kind::Asks, "a".into()),
                (Kind::Asks, "b".into()),
                (Kind::Failed, "c".into())
            ])
            .unwrap(),
            "Toolroll: 2 need you, 1 failed"
        );
    }

    #[test]
    fn reach_by_terminal_and_tmux() {
        let env = Env::default();
        assert_eq!(Reach::of(&env, false), Reach::default());
        let foot = Env {
            term: Some("foot".into()),
            ..Env::default()
        };
        assert_eq!(Reach::of(&foot, false).desktop, Desktop::Osc777);
        let tmux = Env {
            tmux: true,
            term: Some("tmux-256color".into()),
            ..Env::default()
        };
        assert_eq!(Reach::of(&tmux, false).desktop, Desktop::Off);
        assert_eq!(
            Reach::of(&tmux, true),
            Reach {
                desktop: Desktop::Osc9,
                tmux: true
            }
        );
    }
}
