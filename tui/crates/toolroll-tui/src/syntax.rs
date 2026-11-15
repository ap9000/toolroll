//! Syntax colours for the Diff tab (solo-workbench plan T2), with syntect's grammars.
//!
//! - Lazy and off the screen's thread: the grammars load the first time a diff asks for them (never at start), and a
//!   file's lines are coloured by a thread of their own; a frame never waits for either (lines are drawn plain until
//!   they're done), so a long diff never holds a frame.
//! - Inert: syntect only says which class each piece of a line is. It reads the line as already cleaned (text.rs) and
//!   Toolroll draws the pieces with its own styles; nothing syntect makes is ever written to the terminal, so no escape
//!   sequence can come back out of agent-written code.
//! - DESIGN.md: blue, green and red mean running, passed and failed, and amber means nothing here, so code takes only
//!   the code roles theme.rs gives them (theme.rs `code`): the theme, its depth (16, 256, full colour) and NO_COLOR
//!   apply to code as to everything else.
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use syntect::highlighting::{
    Color as SColor, HighlightIterator, HighlightState, Highlighter, ScopeSelectors, StyleModifier,
    Theme as SynTheme, ThemeItem, ThemeSettings,
};
use syntect::parsing::{ParseState, ScopeStack, SyntaxSet};

/// The classes a piece of code can be drawn as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Token {
    Plain = 0,
    Keyword = 1,
    Text = 2,
    Comment = 3,
    Number = 4,
    Type = 5,
}

impl Token {
    fn of(r: u8) -> Token {
        match r {
            1 => Token::Keyword,
            2 => Token::Text,
            3 => Token::Comment,
            4 => Token::Number,
            5 => Token::Type,
            _ => Token::Plain,
        }
    }
}

static SET: OnceLock<SyntaxSet> = OnceLock::new();

/// Load the grammars now, on this thread (tests and the harness: a snapshot must not depend on a race).
pub fn load_now() -> &'static SyntaxSet {
    SET.get_or_init(SyntaxSet::load_defaults_newlines)
}

fn theme() -> &'static SynTheme {
    static THEME: OnceLock<SynTheme> = OnceLock::new();
    THEME.get_or_init(|| {
        let item = |selectors: &str, token: Token| ThemeItem {
            scope: ScopeSelectors::from_str(selectors).expect("selectors"),
            style: StyleModifier {
                foreground: Some(SColor {
                    r: token as u8,
                    g: 0,
                    b: 0,
                    a: 255,
                }),
                background: None,
                font_style: None,
            },
        };
        SynTheme {
            name: None,
            author: None,
            settings: ThemeSettings {
                foreground: Some(SColor {
                    r: 0,
                    g: 0,
                    b: 0,
                    a: 255,
                }),
                ..ThemeSettings::default()
            },
            scopes: vec![
                item("comment, punctuation.definition.comment", Token::Comment),
                item(
                    "string, constant.character, punctuation.definition.string",
                    Token::Text,
                ),
                item("constant.numeric, constant.language", Token::Number),
                item("keyword, storage", Token::Keyword),
                item(
                    "entity.name.type, entity.name.class, support.type, support.class",
                    Token::Type,
                ),
            ],
        }
    })
}

/// A line longer than this is drawn plain (and the colouring starts afresh after it).
const LONGEST: usize = 2_000;

/// One code line to colour: its text (cleaned) and whether a new block starts there (a hunk or a revealed run: the
/// colouring starts afresh, as the lines before it aren't shown).
pub struct Source {
    pub text: String,
    pub fresh: bool,
}

type Pieces = Vec<(Token, String)>;

struct Shared {
    lines: Mutex<Vec<Option<Pieces>>>,
    done: AtomicBool,
    cancel: AtomicBool,
}

/// A file's coloured lines, filled in order by a thread of their own (syntect compiles a grammar's patterns the first
/// time they're used, which can take tens of milliseconds: never on the screen's thread). The screen reads what is done
/// and draws the rest plain; a new file or layout drops this one, which stops its thread.
pub struct Highlights {
    /// What these lines are of (the view's code version): another key starts over.
    pub key: (String, i64, i64, u64),
    shared: Arc<Shared>,
}

impl Highlights {
    pub fn new(key: (String, i64, i64, u64), path: &str, code: Vec<Source>) -> Highlights {
        let shared = Arc::new(Shared {
            lines: Mutex::new(vec![None; code.len()]),
            done: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
        });
        let name = path.rsplit('/').next().unwrap_or(path).to_string();
        let worker = shared.clone();
        std::thread::spawn(move || colour(&worker, &name, &code));
        Highlights { key, shared }
    }

    /// Line `i`'s pieces, once coloured.
    pub fn line(&self, i: usize) -> Option<Pieces> {
        self.shared.lines.lock().ok()?.get(i).cloned().flatten()
    }

    /// Every line is coloured (or nothing is to be: no grammar knows this file).
    pub fn done(&self) -> bool {
        self.shared.done.load(Ordering::SeqCst)
    }

    /// Wait until done (tests and the harness), at most `limit`.
    pub fn wait(&self, limit: Duration) -> bool {
        let until = Instant::now() + limit;
        while !self.done() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(2));
        }
        self.done()
    }
}

impl Drop for Highlights {
    fn drop(&mut self) {
        self.shared.cancel.store(true, Ordering::SeqCst);
    }
}

/// The worker: the grammars (loaded once), the file's grammar, then each line in order, a few at a time into `shared`.
fn colour(shared: &Shared, name: &str, code: &[Source]) {
    let set = SET.get_or_init(SyntaxSet::load_defaults_newlines);
    let Some(syntax) = grammar_for(set, name).and_then(|n| set.find_syntax_by_name(&n)) else {
        shared.done.store(true, Ordering::SeqCst);
        return;
    };
    let highlighter = Highlighter::new(theme());
    let mut state: Option<(ParseState, HighlightState)> = None;
    let mut batch: Vec<(usize, Pieces)> = vec![];
    let flush = |batch: &mut Vec<(usize, Pieces)>| {
        if let Ok(mut lines) = shared.lines.lock() {
            for (i, p) in batch.drain(..) {
                if let Some(slot) = lines.get_mut(i) {
                    *slot = Some(p);
                }
            }
        }
    };
    for (i, src) in code.iter().enumerate() {
        if shared.cancel.load(Ordering::Relaxed) {
            return;
        }
        if src.fresh || state.is_none() {
            state = Some((
                ParseState::new(syntax),
                HighlightState::new(&highlighter, ScopeStack::new()),
            ));
        }
        let mut pieces: Option<Pieces> = None;
        if src.text.len() <= LONGEST {
            let (parse, hl) = state.as_mut().unwrap();
            let line = format!("{}\n", src.text);
            if let Ok(ops) = parse.parse_line(&line, set) {
                let mut out: Pieces = vec![];
                for (style, piece) in HighlightIterator::new(hl, &ops, &line, &highlighter) {
                    let piece = piece.strip_suffix('\n').unwrap_or(piece);
                    if piece.is_empty() {
                        continue;
                    }
                    let token = Token::of(style.foreground.r);
                    match out.last_mut() {
                        Some((t, s)) if *t == token => s.push_str(piece),
                        _ => out.push((token, piece.to_string())),
                    }
                }
                pieces = Some(out);
            }
        }
        if pieces.is_none() {
            // Too long, or the grammar gave up: plain, and the colouring starts afresh after it.
            state = None;
        }
        batch.push((
            i,
            pieces.unwrap_or_else(|| vec![(Token::Plain, src.text.clone())]),
        ));
        if batch.len() >= 64 {
            flush(&mut batch);
        }
    }
    flush(&mut batch);
    shared.done.store(true, Ordering::SeqCst);
}

/// The grammar for a file name: its extension, else its whole name (Makefile); None when unknown.
fn grammar_for(set: &SyntaxSet, name: &str) -> Option<String> {
    let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or(name);
    set.find_syntax_by_extension(ext)
        .or_else(|| set.find_syntax_by_extension(name))
        .filter(|s| s.name != "Plain Text")
        .map(|s| s.name.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::style::Color;

    #[test]
    fn code_never_takes_a_meaning_colour_in_any_theme_or_depth() {
        use crate::theme::{Depth, Role, Theme as Look, ThemeName};
        for name in ThemeName::ALL {
            for depth in [Depth::TrueColor, Depth::Ansi256, Depth::Ansi16, Depth::Off] {
                for bg in [None, Some(crate::theme::Rgb(250, 250, 250))] {
                    let (look, _) = Look::build(name, depth, bg, &[]);
                    let meaning: Vec<Option<Color>> = [Role::Running, Role::Passed, Role::Failed]
                        .iter()
                        .map(|r| match *r {
                            Role::Running => look.running().fg,
                            Role::Passed => look.passed().fg,
                            _ => look.failed().fg,
                        })
                        .collect();
                    for t in [
                        Token::Plain,
                        Token::Keyword,
                        Token::Text,
                        Token::Comment,
                        Token::Number,
                        Token::Type,
                    ] {
                        let fg = look.code(t).fg;
                        assert!(
                            !matches!(
                                fg,
                                Some(
                                    Color::Blue
                                        | Color::LightBlue
                                        | Color::Green
                                        | Color::LightGreen
                                        | Color::Red
                                        | Color::LightRed
                                        | Color::Yellow
                                        | Color::LightYellow
                                )
                            ),
                            "{name:?} {depth:?} {t:?} {fg:?}"
                        );
                        assert!(
                            fg.is_none() || fg == Some(Color::Reset) || !meaning.contains(&fg),
                            "{name:?} {depth:?} {t:?}"
                        );
                        if depth == Depth::Off {
                            assert!(fg.is_none(), "colour with NO_COLOR: {t:?}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn colours_only_what_it_was_given_and_never_an_escape() {
        load_now();
        // Already cleaned text (text.rs turns control characters into U+FFFD): the pieces are exactly that text again.
        let hostile = crate::text::clean("let x = \"\u{1b}]52;c;aGk=\u{7}\"; // \u{1b}[2J");
        let code = vec![Source {
            text: hostile.clone(),
            fresh: true,
        }];
        let h = Highlights::new(("t".into(), 1, 0, 0), "a.rs", code);
        assert!(h.wait(Duration::from_secs(10)));
        let pieces = h.line(0).unwrap();
        let joined: String = pieces.iter().map(|(_, s)| s.as_str()).collect();
        assert_eq!(joined, hostile);
        assert!(!joined.chars().any(|c| c.is_control()));
        assert!(pieces.iter().any(|(t, _)| *t == Token::Keyword));
        assert!(pieces.iter().any(|(t, _)| *t == Token::Comment));
    }
}
