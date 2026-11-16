//! Colours as named roles, from DESIGN.md ("Signal"): paper, ink, muted, line, selection, and the four that carry
//! meaning — needs you (ink, never amber), running (blue only), passed (green only), failed (red only).
//!
//! A theme is a palette of roles drawn at the colour depth the terminal has: truecolor, 256 colours, the terminal's own
//! 16, or none at all (`NO_COLOR`), where weight, dimming and reversal carry what colour would. A person may set any
//! role's colour in tui.toml; an override that would make the meaning colours look alike, or too faint on the paper,
//! is refused in plain words and the theme's own colour kept.
//!
//! The view draws through the functions at the bottom (`ink()`, `dim()`, `running()`, …), which read the look set for
//! the frame being drawn (`set_look`, called once at the top of every frame). Agent text never chooses a style: every
//! style comes from a role here.
use ratatui::style::{Color, Modifier, Style};
use std::cell::Cell;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgb(pub u8, pub u8, pub u8);

impl Rgb {
    /// "#1a2b3c" or "#abc" (anything else is None).
    pub fn parse(s: &str) -> Option<Rgb> {
        let hex = s.strip_prefix('#')?;
        if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let n = |i: usize, len: usize| u8::from_str_radix(&hex[i..i + len], 16).ok();
        match hex.len() {
            6 => Some(Rgb(n(0, 2)?, n(2, 2)?, n(4, 2)?)),
            3 => Some(Rgb(n(0, 1)? * 17, n(1, 1)? * 17, n(2, 1)? * 17)),
            _ => None,
        }
    }

    pub fn hex(self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.0, self.1, self.2)
    }

    /// WCAG relative luminance.
    pub fn luminance(self) -> f64 {
        let ch = |c: u8| {
            let c = c as f64 / 255.0;
            if c <= 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * ch(self.0) + 0.7152 * ch(self.1) + 0.0722 * ch(self.2)
    }

    /// WCAG contrast ratio (1 to 21).
    pub fn contrast(self, other: Rgb) -> f64 {
        let (a, b) = (self.luminance(), other.luminance());
        let (hi, lo) = if a > b { (a, b) } else { (b, a) };
        (hi + 0.05) / (lo + 0.05)
    }

    fn lab(self) -> (f64, f64, f64) {
        let ch = |c: u8| {
            let c = c as f64 / 255.0;
            if c <= 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        let (r, g, b) = (ch(self.0), ch(self.1), ch(self.2));
        let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
        let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
        let f = |t: f64| {
            if t > 0.008856 {
                t.cbrt()
            } else {
                7.787 * t + 16.0 / 116.0
            }
        };
        let (fx, fy, fz) = (f(x), f(y), f(z));
        (116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz))
    }

    /// How different two colours look (CIE76 ΔE: about 2.3 is just noticeable).
    pub fn distance(self, other: Rgb) -> f64 {
        let (a, b) = (self.lab(), other.lab());
        ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2) + (a.2 - b.2).powi(2)).sqrt()
    }

    /// The nearest of xterm's 256 colours, from the 6×6×6 cube and the grey ramp (never 0–15, which people retheme).
    pub fn ansi256(self) -> u8 {
        const LEVELS: [u8; 6] = [0, 95, 135, 175, 215, 255];
        let near = |c: u8| {
            (0..6)
                .min_by_key(|&i| (LEVELS[i] as i32 - c as i32).abs())
                .unwrap_or(0)
        };
        let (r, g, b) = (near(self.0), near(self.1), near(self.2));
        let cube = Rgb(LEVELS[r], LEVELS[g], LEVELS[b]);
        let cube_index = 16 + 36 * r as u8 + 6 * g as u8 + b as u8;
        let avg = (self.0 as u32 + self.1 as u32 + self.2 as u32) / 3;
        let step = ((avg.saturating_sub(3)) / 10).min(23) as u8;
        let grey_v = 8 + 10 * step;
        let grey = Rgb(grey_v, grey_v, grey_v);
        let d = |c: Rgb| {
            (c.0 as i32 - self.0 as i32).pow(2)
                + (c.1 as i32 - self.1 as i32).pow(2)
                + (c.2 as i32 - self.2 as i32).pow(2)
        };
        if d(grey) < d(cube) {
            232 + step
        } else {
            cube_index
        }
    }
}

/// A role's colour: a fixed one, or the terminal's own foreground or background.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Paint {
    Rgb(Rgb),
    Terminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Role {
    Paper,
    Ink,
    Muted,
    Line,
    Selection,
    SelectionInk,
    NeedsYou,
    Running,
    Passed,
    Failed,
    /// Sheets (DESIGN.md): the frame the panels sit on, raised blocks inside them, and the neutral fill of badges, keys
    /// and tab tracks.
    Ground,
    Raised,
    Fill,
    /// The quiet washes behind a status badge (and a changed line in Diff): each status's own hue, faint.
    RunningSoft,
    PassedSoft,
    FailedSoft,
}

impl Role {
    pub const ALL: [Role; 16] = [
        Role::Paper,
        Role::Ink,
        Role::Muted,
        Role::Line,
        Role::Selection,
        Role::SelectionInk,
        Role::NeedsYou,
        Role::Running,
        Role::Passed,
        Role::Failed,
        Role::Ground,
        Role::Raised,
        Role::Fill,
        Role::RunningSoft,
        Role::PassedSoft,
        Role::FailedSoft,
    ];
    /// The four whose colour means something; they must never look alike.
    pub const MEANING: [Role; 4] = [Role::NeedsYou, Role::Running, Role::Passed, Role::Failed];

    /// Its name in tui.toml's `[colors]`.
    pub fn key(self) -> &'static str {
        match self {
            Role::Paper => "paper",
            Role::Ink => "ink",
            Role::Muted => "muted",
            Role::Line => "line",
            Role::Selection => "selection",
            Role::SelectionInk => "selection-ink",
            Role::NeedsYou => "needs-you",
            Role::Running => "running",
            Role::Passed => "passed",
            Role::Failed => "failed",
            Role::Ground => "ground",
            Role::Raised => "raised",
            Role::Fill => "fill",
            Role::RunningSoft => "running-soft",
            Role::PassedSoft => "passed-soft",
            Role::FailedSoft => "failed-soft",
        }
    }

    pub fn from_key(key: &str) -> Option<Role> {
        Role::ALL.into_iter().find(|r| r.key() == key)
    }

    /// Its name in a sentence.
    pub fn words(self) -> &'static str {
        match self {
            Role::Paper => "the background",
            Role::Ink => "text",
            Role::Muted => "quiet text",
            Role::Line => "lines",
            Role::Selection => "the selected row",
            Role::SelectionInk => "selected text",
            Role::NeedsYou => "needs you",
            Role::Running => "running",
            Role::Passed => "passed",
            Role::Failed => "failed",
            Role::Ground => "the frame around the panels",
            Role::Raised => "raised blocks",
            Role::Fill => "badges and keys",
            Role::RunningSoft => "running's badge",
            Role::PassedSoft => "passed's badge",
            Role::FailedSoft => "failed's badge",
        }
    }

    fn index(self) -> usize {
        Role::ALL.iter().position(|r| *r == self).unwrap_or(0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Palette([Paint; 16]);

impl Palette {
    pub fn get(&self, role: Role) -> Paint {
        self.0[role.index()]
    }
    pub fn set(&mut self, role: Role, paint: Paint) {
        self.0[role.index()] = paint;
    }
    fn of(hex: [&str; 16]) -> Palette {
        Palette(hex.map(|h| Paint::Rgb(Rgb::parse(h).expect("built-in colour"))))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeName {
    /// The terminal's own foreground and background (and needs you in its ink); the other roles from light or dark,
    /// whichever matches the background the terminal reports (OSC 11), dark when it doesn't say.
    Terminal,
    Light,
    Dark,
    HighContrast,
}

impl ThemeName {
    pub const ALL: [ThemeName; 4] = [
        ThemeName::Terminal,
        ThemeName::Light,
        ThemeName::Dark,
        ThemeName::HighContrast,
    ];
    pub fn key(self) -> &'static str {
        match self {
            ThemeName::Terminal => "terminal",
            ThemeName::Light => "light",
            ThemeName::Dark => "dark",
            ThemeName::HighContrast => "high-contrast",
        }
    }
    pub fn from_key(key: &str) -> Option<ThemeName> {
        ThemeName::ALL.into_iter().find(|t| t.key() == key)
    }
    /// The next one `t` switches to.
    pub fn next(self) -> ThemeName {
        let i = ThemeName::ALL.iter().position(|t| *t == self).unwrap_or(0);
        ThemeName::ALL[(i + 1) % ThemeName::ALL.len()]
    }
}

/// How many colours the terminal can show.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Depth {
    TrueColor,
    Ansi256,
    Ansi16,
    /// `NO_COLOR` (or a terminal without colour): weight, dimming and reversal only.
    Off,
}

impl Depth {
    /// From the environment: `NO_COLOR` (set and not empty) turns colour off; `COLORTERM` says truecolor; `TERM`
    /// says 256 colours; anything else gets the terminal's own 16.
    pub fn detect(no_color: bool, colorterm: Option<&str>, term: Option<&str>) -> Depth {
        if no_color || term == Some("dumb") {
            return Depth::Off;
        }
        if matches!(colorterm, Some("truecolor") | Some("24bit")) {
            return Depth::TrueColor;
        }
        if term.is_some_and(|t| t.contains("256color")) {
            return Depth::Ansi256;
        }
        Depth::Ansi16
    }

    pub fn words(self) -> &'static str {
        match self {
            Depth::TrueColor => "full colour",
            Depth::Ansi256 => "256 colours",
            Depth::Ansi16 => "the terminal's 16 colours",
            Depth::Off => "off (NO_COLOR)",
        }
    }
}

/// DESIGN.md's light tokens: paper, ink, muted, input-line, selection, ink on it, signal, info, success, danger; then
/// ground, raised, the neutral fill, and the info, success and danger washes.
pub fn light() -> Palette {
    Palette::of([
        "#ffffff", "#171717", "#666666", "#d4d4d4", "#d4d4d4", "#171717", "#171717", "#0d74ce",
        "#218358", "#c4320a", "#efefef", "#f5f5f5", "#e8e8e8", "#e6f4fe", "#e6f6eb", "#feebe7",
    ])
}

/// DESIGN.md's dark tokens (the washes are each hue at 14% over the paper).
pub fn dark() -> Palette {
    Palette::of([
        "#161616", "#ededed", "#a1a1a1", "#363636", "#3a3a3a", "#ededed", "#ededed", "#70b8ff",
        "#3dd68c", "#ff977d", "#0b0b0b", "#1c1c1c", "#2a2a2a", "#232d37", "#1b3127", "#372824",
    ])
}

/// Pure black and white, the status colours lifted: every pair well past the contrast floor. Its sheets are the ground
/// (black on black), so the panels are set apart by rules.
pub fn high_contrast() -> Palette {
    Palette::of([
        "#000000", "#ffffff", "#d4d4d4", "#a3a3a3", "#ffffff", "#000000", "#ffffff", "#8ec8ff",
        "#5ff0a8", "#ffa08a", "#000000", "#141414", "#2e2e2e", "#0d2742", "#0b3220", "#3d1a12",
    ])
}

/// `a` with `t` of `b` laid over it.
pub fn mix(a: Rgb, b: Rgb, t: f64) -> Rgb {
    let m = |x: u8, y: u8| ((x as f64) * (1.0 - t) + (y as f64) * t).round() as u8;
    Rgb(m(a.0, b.0), m(a.1, b.1), m(a.2, b.2))
}

/// The floors an override must keep (WCAG contrast against the paper, and ΔE between the meaning colours).
pub const TEXT_FLOOR: f64 = 4.5;
pub const MARK_FLOOR: f64 = 3.0;
pub const APART_FLOOR: f64 = 20.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Theme {
    pub name: ThemeName,
    pub depth: Depth,
    /// Light or dark roles (for Terminal: what the background said, dark when it said nothing).
    pub dark: bool,
    pub palette: Palette,
    /// The background contrast is measured against (the paper, or the terminal's reported background).
    pub reference: Rgb,
}

impl Default for Theme {
    /// Before the settings are read: the terminal's own colours at 16 (the classic look).
    fn default() -> Theme {
        Theme::build(ThemeName::Terminal, Depth::Ansi16, None, &[]).0
    }
}

impl Theme {
    /// A theme at a depth, with a person's overrides; the words for each override refused.
    pub fn build(
        name: ThemeName,
        depth: Depth,
        background: Option<Rgb>,
        overrides: &[(Role, Rgb)],
    ) -> (Theme, Vec<String>) {
        let is_dark = match name {
            ThemeName::Light => false,
            ThemeName::Dark | ThemeName::HighContrast => true,
            ThemeName::Terminal => background.is_none_or(|b| b.luminance() < 0.25),
        };
        let mut palette = match name {
            ThemeName::Light => light(),
            ThemeName::Dark => dark(),
            ThemeName::HighContrast => high_contrast(),
            ThemeName::Terminal if is_dark => dark(),
            ThemeName::Terminal => light(),
        };
        let mut reference = match palette.get(Role::Paper) {
            Paint::Rgb(c) => c,
            Paint::Terminal => Rgb(0, 0, 0),
        };
        if name == ThemeName::Terminal {
            // The terminal's own paper and ink, and needs you in that ink: readable even when its background was
            // guessed wrong.
            palette.set(Role::Paper, Paint::Terminal);
            palette.set(Role::Ink, Paint::Terminal);
            palette.set(Role::NeedsYou, Paint::Terminal);
            if let Some(b) = background {
                reference = b;
                // The sheets' frame and fills drawn from the terminal's own background, so they sit with its colours.
                let (dark_ground, ink) = (
                    Rgb(0, 0, 0),
                    if is_dark {
                        Rgb(255, 255, 255)
                    } else {
                        Rgb(0, 0, 0)
                    },
                );
                let hue = |r: Role| match palette.get(r) {
                    Paint::Rgb(c) => c,
                    Paint::Terminal => b,
                };
                let (run, pass, fail) = (hue(Role::Running), hue(Role::Passed), hue(Role::Failed));
                let set = |p: &mut Palette, r: Role, c: Rgb| p.set(r, Paint::Rgb(c));
                set(
                    &mut palette,
                    Role::Ground,
                    mix(b, dark_ground, if is_dark { 0.4 } else { 0.07 }),
                );
                set(
                    &mut palette,
                    Role::Raised,
                    mix(b, ink, if is_dark { 0.05 } else { 0.03 }),
                );
                set(
                    &mut palette,
                    Role::Fill,
                    mix(b, ink, if is_dark { 0.11 } else { 0.08 }),
                );
                set(&mut palette, Role::RunningSoft, mix(b, run, 0.14));
                set(&mut palette, Role::PassedSoft, mix(b, pass, 0.14));
                set(&mut palette, Role::FailedSoft, mix(b, fail, 0.14));
            }
        }
        let mut theme = Theme {
            name,
            depth,
            dark: is_dark,
            palette,
            reference,
        };
        let mut refused = vec![];
        if overrides.is_empty() {
            return (theme, refused);
        }
        if !matches!(depth, Depth::TrueColor | Depth::Ansi256) {
            refused.push(format!(
                "Your colours in tui.toml weren't used: this terminal shows {}.",
                depth.words()
            ));
            return (theme, refused);
        }
        // All together when they keep the rules; else one by one, in the file's order, each kept only if it does.
        let mut all = theme;
        for (role, c) in overrides {
            all.set_override(*role, *c);
        }
        if all.problem(None).is_none() {
            return (all, refused);
        }
        for (role, c) in overrides {
            let mut next = theme;
            next.set_override(*role, *c);
            match next.problem(Some(*role)) {
                None => theme = next,
                Some(why) => refused.push(format!(
                    "Your colour for {} ({}) wasn't used: {why}.",
                    role.words(),
                    c.hex()
                )),
            }
        }
        (theme, refused)
    }

    fn set_override(&mut self, role: Role, c: Rgb) {
        self.palette.set(role, Paint::Rgb(c));
        if role == Role::Paper {
            self.reference = c;
        }
    }

    fn rgb(&self, role: Role) -> Option<Rgb> {
        match self.palette.get(role) {
            Paint::Rgb(c) => Some(c),
            Paint::Terminal => None,
        }
    }

    /// The first rule this palette breaks, in words (`focus`: the role just changed is named first).
    pub fn problem(&self, focus: Option<Role>) -> Option<String> {
        let paper = self.reference;
        let floors = [
            (Role::Ink, TEXT_FLOOR),
            (Role::Muted, MARK_FLOOR),
            (Role::NeedsYou, MARK_FLOOR),
            (Role::Running, MARK_FLOOR),
            (Role::Passed, MARK_FLOOR),
            (Role::Failed, MARK_FLOOR),
        ];
        let mut problems: Vec<(Role, String)> = vec![];
        for (role, floor) in floors {
            if let Some(c) = self.rgb(role) {
                if c.contrast(paper) < floor {
                    let words = if role == Role::Paper || focus == Some(Role::Paper) {
                        format!("{} would be too faint on it", role.words())
                    } else {
                        "it would be too faint on the background".to_string()
                    };
                    problems.push((role, words));
                }
            }
        }
        // Words on the sheets' own fills, and each status on its wash.
        let ink_on = self.rgb(Role::Ink).unwrap_or(if self.dark {
            Rgb(255, 255, 255)
        } else {
            Rgb(0, 0, 0)
        });
        for (fg, bg, floor) in [
            (Role::Ink, Role::Raised, TEXT_FLOOR),
            (Role::Ink, Role::Fill, TEXT_FLOOR),
            (Role::Ink, Role::Ground, TEXT_FLOOR),
            (Role::Running, Role::RunningSoft, MARK_FLOOR),
            (Role::Passed, Role::PassedSoft, MARK_FLOOR),
            (Role::Failed, Role::FailedSoft, MARK_FLOOR),
        ] {
            let f = if fg == Role::Ink {
                Some(ink_on)
            } else {
                self.rgb(fg)
            };
            if let (Some(f), Some(b)) = (f, self.rgb(bg)) {
                if f.contrast(b) < floor {
                    let mine = if focus == Some(fg) { fg } else { bg };
                    problems.push((
                        mine,
                        format!("{} would be too faint on {}", fg.words(), bg.words()),
                    ));
                }
            }
        }
        if let (Some(sel), Some(ink)) = (self.rgb(Role::Selection), self.rgb(Role::SelectionInk)) {
            if sel.contrast(ink) < TEXT_FLOOR {
                problems.push((
                    Role::SelectionInk,
                    "selected text would be too faint on the selected row".into(),
                ));
            }
        }
        for (i, a) in Role::MEANING.iter().enumerate() {
            for b in &Role::MEANING[i + 1..] {
                if let (Some(ca), Some(cb)) = (self.rgb(*a), self.rgb(*b)) {
                    if ca.distance(cb) < APART_FLOOR {
                        let other = if focus == Some(*a) { *b } else { *a };
                        let mine = if focus == Some(*a) { *a } else { *b };
                        let words =
                            format!("{} and {} would look alike", mine.words(), other.words());
                        problems.push((mine, words));
                    }
                }
            }
        }
        problems
            .iter()
            .find(|(r, _)| Some(*r) == focus)
            .or(problems.first())
            .map(|(_, w)| w.clone())
    }

    fn color(&self, role: Role) -> Color {
        match self.palette.get(role) {
            Paint::Terminal => Color::Reset,
            Paint::Rgb(c) => match self.depth {
                Depth::TrueColor => Color::Rgb(c.0, c.1, c.2),
                _ => Color::Indexed(c.ansi256()),
            },
        }
    }

    fn painted(&self) -> bool {
        matches!(self.depth, Depth::TrueColor | Depth::Ansi256)
    }

    /// The paper with ink on it: what every area is filled with before anything is drawn.
    pub fn base(&self) -> Style {
        if self.painted() {
            Style::default()
                .fg(self.color(Role::Ink))
                .bg(self.color(Role::Paper))
        } else {
            Style::default()
        }
    }

    /// Ink, bold: headings, labels and keys.
    pub fn ink(&self) -> Style {
        let s = Style::default().add_modifier(Modifier::BOLD);
        if self.painted() {
            s.fg(self.color(Role::Ink))
        } else {
            s
        }
    }

    /// What waits on a person: ink, bold (never amber).
    pub fn needs_you(&self) -> Style {
        let s = Style::default().add_modifier(Modifier::BOLD);
        if self.painted() {
            s.fg(self.color(Role::NeedsYou))
        } else {
            s
        }
    }

    /// Quiet text.
    pub fn muted(&self) -> Style {
        if self.painted() {
            Style::default().fg(self.color(Role::Muted))
        } else {
            Style::default().add_modifier(Modifier::DIM)
        }
    }

    pub fn line(&self) -> Style {
        if self.painted() {
            Style::default().fg(self.color(Role::Line))
        } else {
            Style::default().add_modifier(Modifier::DIM)
        }
    }

    fn status(&self, role: Role, ansi: Color) -> Style {
        match self.depth {
            Depth::Off => Style::default(),
            Depth::Ansi16 => Style::default().fg(ansi),
            _ => Style::default().fg(self.color(role)),
        }
    }

    pub fn running(&self) -> Style {
        self.status(Role::Running, Color::Blue)
    }
    pub fn passed(&self) -> Style {
        self.status(Role::Passed, Color::Green)
    }
    pub fn failed(&self) -> Style {
        self.status(Role::Failed, Color::Red)
    }

    /// Code in the Diff tab (syntax.rs classes): never a meaning colour (no blue, green or red, no amber). Keywords
    /// and types are ink by weight, comments muted and italic, and strings and numbers one quiet violet (the
    /// terminal's magenta at 16 colours); with colour off only weight and slant remain.
    pub fn code(&self, token: crate::syntax::Token) -> Style {
        use crate::syntax::Token;
        let accent = || -> Style {
            match self.depth {
                Depth::Off => Style::default(),
                Depth::Ansi16 => Style::default().fg(if self.dark {
                    Color::LightMagenta
                } else {
                    Color::Magenta
                }),
                _ => {
                    let c = match (self.name, self.dark) {
                        (ThemeName::HighContrast, _) => Rgb(0xe2, 0xb6, 0xff),
                        (_, true) => Rgb(0xc8, 0x9b, 0xff),
                        (_, false) => Rgb(0x82, 0x50, 0xdf),
                    };
                    Style::default().fg(match self.depth {
                        Depth::TrueColor => Color::Rgb(c.0, c.1, c.2),
                        _ => Color::Indexed(c.ansi256()),
                    })
                }
            }
        };
        match token {
            Token::Plain => Style::default(),
            Token::Keyword => Style::default().add_modifier(Modifier::BOLD),
            Token::Type => self
                .ink()
                .remove_modifier(Modifier::BOLD)
                .add_modifier(Modifier::ITALIC),
            Token::Comment => self.muted().add_modifier(Modifier::ITALIC),
            Token::Text | Token::Number => accent(),
        }
    }

    /// Whether the sheets are drawn with fills (truecolor and 256 colours); else rules, weight and reversal carry them.
    pub fn fills(&self) -> bool {
        self.painted()
    }

    /// Whether panels need rules between them: no fills, or a ground the same as the sheets (high contrast).
    pub fn ruled(&self) -> bool {
        !self.painted() || self.palette.get(Role::Ground) == self.palette.get(Role::Paper)
    }

    fn on(&self, fg: Role, bg: Role) -> Style {
        Style::default().fg(self.color(fg)).bg(self.color(bg))
    }

    /// The frame the sheets sit on (the top bar, the gutters, the key bar).
    pub fn ground(&self) -> Style {
        if self.painted() {
            self.on(Role::Ink, Role::Ground)
        } else {
            Style::default()
        }
    }

    /// A raised block inside a sheet (its background only, so its words keep their own colour).
    pub fn raised(&self) -> Style {
        if self.painted() {
            Style::default().bg(self.color(Role::Raised))
        } else {
            Style::default()
        }
    }

    /// The neutral fill of a badge, a key and a tab track (background only).
    pub fn fill(&self) -> Style {
        if self.painted() {
            Style::default().bg(self.color(Role::Fill))
        } else {
            Style::default()
        }
    }

    /// A key's cap: ink, bold, on the fill.
    pub fn keycap(&self) -> Style {
        self.ink().patch(self.fill())
    }

    /// A status badge: the hue on its wash (at 16 colours the hue alone; with colour off, plain).
    pub fn badge(&self, role: Role) -> Style {
        let (wash, ansi) = match role {
            Role::Running => (Role::RunningSoft, Color::Blue),
            Role::Passed => (Role::PassedSoft, Color::Green),
            Role::Failed => (Role::FailedSoft, Color::Red),
            _ => return self.muted().patch(self.fill()),
        };
        if self.painted() {
            self.on(role, wash)
        } else {
            self.status(role, ansi)
        }
    }

    /// A status's wash behind a whole row (a changed line in Diff); nothing without fills.
    pub fn wash(&self, role: Role) -> Style {
        let wash = match role {
            Role::Running => Role::RunningSoft,
            Role::Passed => Role::PassedSoft,
            Role::Failed => Role::FailedSoft,
            _ => Role::Raised,
        };
        if self.painted() {
            Style::default().bg(self.color(wash))
        } else {
            Style::default()
        }
    }

    /// The solid "Needs you" chip: the needs-you ink, reversed onto the sheet (solid in every depth, NO_COLOR too).
    pub fn chip(&self) -> Style {
        let s = Style::default().add_modifier(Modifier::BOLD | Modifier::REVERSED);
        if self.painted() {
            s.fg(self.color(Role::NeedsYou)).bg(self.color(Role::Paper))
        } else {
            s
        }
    }

    /// The one ink verb on a screen (Accept, Send, Build): ink reversed onto the sheet.
    pub fn primary(&self) -> Style {
        let s = Style::default().add_modifier(Modifier::BOLD | Modifier::REVERSED);
        if self.painted() {
            s.fg(self.color(Role::Ink)).bg(self.color(Role::Paper))
        } else {
            s
        }
    }

    /// The tab on screen in the tab track; the others.
    pub fn tab_on(&self) -> Style {
        if self.painted() {
            self.on(Role::SelectionInk, Role::Selection)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
        }
    }
    pub fn tab_off(&self) -> Style {
        if self.painted() {
            self.on(Role::Muted, Role::Fill)
        } else {
            self.muted()
        }
    }

    /// The selected row.
    pub fn selected(&self) -> Style {
        if self.painted() {
            Style::default()
                .fg(self.color(Role::SelectionInk))
                .bg(self.color(Role::Selection))
        } else {
            Style::default().add_modifier(Modifier::REVERSED)
        }
    }
}

// ---- glyphs ---------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Glyphs {
    Unicode,
    Ascii,
    Nerd,
}

impl Glyphs {
    pub const ALL: [Glyphs; 3] = [Glyphs::Unicode, Glyphs::Ascii, Glyphs::Nerd];
    pub fn key(self) -> &'static str {
        match self {
            Glyphs::Unicode => "unicode",
            Glyphs::Ascii => "ascii",
            Glyphs::Nerd => "nerd",
        }
    }
    pub fn from_key(key: &str) -> Option<Glyphs> {
        Glyphs::ALL.into_iter().find(|g| g.key() == key)
    }
}

/// The marks that say a thing's state, one cell each.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Marks {
    pub needs: &'static str,
    pub running: &'static str,
    pub passed: &'static str,
    pub failed: &'static str,
    pub paused: &'static str,
    pub todo: &'static str,
    pub skipped: &'static str,
    /// A step whose stream ended without an answer.
    pub ended: &'static str,
    /// The key bar's name for Enter.
    pub enter: &'static str,
}

pub const UNICODE: Marks = Marks {
    needs: "●",
    running: "◐",
    passed: "✓",
    failed: "✕",
    paused: "‖",
    todo: "○",
    skipped: "–",
    ended: "·",
    enter: "⏎",
};

pub const ASCII: Marks = Marks {
    needs: "*",
    running: "~",
    passed: "+",
    failed: "x",
    paused: "=",
    todo: "o",
    skipped: "-",
    ended: ".",
    enter: "Enter",
};

/// Nerd Font icons (Font Awesome's circle, spinner, check, times, pause, circle-o, minus).
pub const NERD: Marks = Marks {
    needs: "\u{f111}",
    running: "\u{f110}",
    passed: "\u{f00c}",
    failed: "\u{f00d}",
    paused: "\u{f04c}",
    todo: "\u{f10c}",
    skipped: "\u{f068}",
    ended: "·",
    enter: "⏎",
};

impl Glyphs {
    pub fn marks(self) -> &'static Marks {
        match self {
            Glyphs::Unicode => &UNICODE,
            Glyphs::Ascii => &ASCII,
            Glyphs::Nerd => &NERD,
        }
    }
}

/// With ASCII glyphs, the one-cell stand-in for each other symbol the screen draws (borders, separators, arrows, the
/// cursor, the ellipsis, dashes, and the Unicode marks themselves): applied to the whole frame after it is drawn, so
/// nothing is missed.
pub fn ascii_of(c: char) -> Option<char> {
    Some(match c {
        '─' | '━' | '═' => '-',
        '│' | '┃' | '║' | '▏' => '|',
        '┌' | '┐' | '└' | '┘' | '├' | '┤' | '┬' | '┴' | '┼' | '╭' | '╮' | '╰' | '╯' => {
            '+'
        }
        '·' => '|',
        '…' => '~',
        '↓' => 'v',
        '↑' => '^',
        '›' => '>',
        '—' | '–' | '−' => '-',
        '‖' => '=',
        '●' => '*',
        '◐' => '~',
        '✓' => '+',
        '✕' => 'x',
        '○' => 'o',
        '⏎' => '>',
        '⋯' => '~',
        '▸' => '>',
        _ => return None,
    })
}

// ---- the look of the frame being drawn ----------------------------------------------------------------------------

thread_local! {
    static LOOK: Cell<(Theme, Glyphs)> = Cell::new((Theme::default(), Glyphs::Unicode));
}

/// Set the theme and glyphs the next frame is drawn with (view::draw calls it first).
pub fn set_look(theme: Theme, glyphs: Glyphs) {
    LOOK.with(|l| l.set((theme, glyphs)));
}

fn theme() -> Theme {
    LOOK.with(|l| l.get().0)
}

pub fn marks() -> &'static Marks {
    LOOK.with(|l| l.get().1.marks())
}

pub fn base() -> Style {
    theme().base()
}
pub fn ink() -> Style {
    theme().ink()
}
pub fn needs_you() -> Style {
    theme().needs_you()
}
pub fn dim() -> Style {
    theme().muted()
}
pub fn line() -> Style {
    theme().line()
}
pub fn running() -> Style {
    theme().running()
}
pub fn passed() -> Style {
    theme().passed()
}
pub fn failed() -> Style {
    theme().failed()
}
pub fn fills() -> bool {
    theme().fills()
}
pub fn ruled() -> bool {
    theme().ruled()
}
pub fn ground() -> Style {
    theme().ground()
}
pub fn raised() -> Style {
    theme().raised()
}
pub fn fill() -> Style {
    theme().fill()
}
pub fn keycap() -> Style {
    theme().keycap()
}
pub fn badge(role: Role) -> Style {
    theme().badge(role)
}
pub fn wash(role: Role) -> Style {
    theme().wash(role)
}
pub fn chip() -> Style {
    theme().chip()
}
pub fn primary() -> Style {
    theme().primary()
}
pub fn tab_on() -> Style {
    theme().tab_on()
}
pub fn tab_off() -> Style {
    theme().tab_off()
}
pub fn selected() -> Style {
    theme().selected()
}
/// A class of code (syntax.rs) in the Diff tab.
pub fn code(token: crate::syntax::Token) -> Style {
    theme().code(token)
}

// ---- the terminal's background (OSC 11) ----------------------------------------------------------------------------

/// The colour in an OSC 11 answer (`ESC ] 11 ; rgb:RRRR/GGGG/BBBB` then BEL or ST; 1 to 4 hex digits a channel).
pub fn parse_osc11(bytes: &[u8]) -> Option<Rgb> {
    let text = std::str::from_utf8(bytes).ok()?;
    let at = text.find("\x1b]11;rgb:")?;
    let rest = &text[at + 9..];
    let end = rest.find(['\x07', '\x1b'])?;
    let mut parts = rest[..end].split('/');
    let mut channel = || -> Option<u8> {
        let p = parts.next()?;
        if p.is_empty() || p.len() > 4 || !p.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let v = u32::from_str_radix(p, 16).ok()?;
        let max = (1u32 << (4 * p.len() as u32)) - 1;
        Some(((v * 255 + max / 2) / max) as u8)
    };
    let c = Rgb(channel()?, channel()?, channel()?);
    parts.next().is_none().then_some(c)
}

/// What the terminal said when asked at start (ask_terminal): its background, whether it answered at all (the
/// device-attributes ask every terminal answers), and whether it speaks the keyboard protocol that tells Esc and
/// Alt-keys apart (its `CSI ? u` answer).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Answers {
    pub background: Option<Rgb>,
    pub answered: bool,
    pub keyboard: bool,
}

/// The answers in what came back: OSC 11's colour, a `CSI ? <flags> u` keyboard answer, and the DA1 answer
/// (`CSI ? … c`) that ends them.
pub fn parse_answers(bytes: &[u8]) -> Answers {
    let csi_q = |end: u8| {
        bytes.windows(3).enumerate().any(|(i, w)| {
            w == b"\x1b[?" && {
                let rest = &bytes[i + 3..];
                let n = rest
                    .iter()
                    .take_while(|b| b.is_ascii_digit() || **b == b';')
                    .count();
                rest.get(n) == Some(&end)
            }
        })
    };
    Answers {
        background: parse_osc11(bytes),
        answered: csi_q(b'c'),
        keyboard: csi_q(b'u'),
    }
}

/// Ask the terminal for its background (OSC 11) and its keyboard protocol (`CSI ? u`), followed by a
/// device-attributes ask (DA1) that every terminal answers, so a terminal that ignores either is known at once; at
/// most `wait`. One ask for both: a terminal that answers nothing costs `wait` once, never a second, longer wait for the
/// keyboard ask (crossterm's own waits two seconds). Only from a terminal on both ends, in raw mode, before anything
/// else reads the keyboard. None: not a terminal.
#[cfg(unix)]
pub fn ask_terminal(wait: std::time::Duration) -> Option<Answers> {
    use std::io::Write;
    use std::time::Instant;
    // SAFETY: isatty only inspects the descriptors.
    if unsafe { libc::isatty(0) != 1 || libc::isatty(1) != 1 } {
        return None;
    }
    let mut out = std::io::stdout();
    out.write_all(b"\x1b]11;?\x07\x1b[?u\x1b[c").ok()?;
    out.flush().ok()?;
    let deadline = Instant::now() + wait;
    let mut got: Vec<u8> = Vec::with_capacity(128);
    let mut buf = [0u8; 128];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() || got.len() > 1024 {
            break;
        }
        let mut fds = libc::pollfd {
            fd: 0,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one pollfd for stdin, a bounded timeout.
        let ready = unsafe { libc::poll(&mut fds, 1, left.as_millis().max(1) as i32) };
        if ready <= 0 {
            break;
        }
        // SAFETY: reads at most buf.len() bytes into buf.
        let n = unsafe { libc::read(0, buf.as_mut_ptr().cast(), buf.len()) };
        if n <= 0 {
            break;
        }
        got.extend_from_slice(&buf[..n as usize]);
        // The DA1 answer (ESC [ ? … c) comes after the others, when there are any.
        if parse_answers(&got).answered {
            break;
        }
    }
    Some(parse_answers(&got))
}

#[cfg(not(unix))]
pub fn ask_terminal(_wait: std::time::Duration) -> Option<Answers> {
    None
}

/// A background answer that came after `ask_background` stopped waiting reaches the keyboard reader, which would read
/// it as keys: `ESC ]` as Alt+], then `1`, `1`, `;`, the colour, and BEL as Ctrl+G (or ST, `ESC \`, as Alt+\). Until
/// `until` (about a second after start), keys that spell its start are held; once `11;` follows, everything up to its
/// end is dropped. Keys that turn out to be a person's are given back, in order.
#[derive(Debug, Clone)]
pub struct LateReply {
    until: std::time::Instant,
    held: Vec<crossterm::event::KeyEvent>,
    /// Inside an answer: how many keys of it were dropped.
    inside: Option<usize>,
}

/// Longer than any colour answer: past this, keys are a person's again.
const LATE_REPLY_MAX: usize = 64;

impl LateReply {
    /// Watching until `until` (a moment already past: never).
    pub fn new(until: std::time::Instant) -> LateReply {
        LateReply {
            until,
            held: vec![],
            inside: None,
        }
    }

    /// The keys to act on, for this one.
    pub fn feed(
        &mut self,
        key: crossterm::event::KeyEvent,
        now: std::time::Instant,
    ) -> Vec<crossterm::event::KeyEvent> {
        use crossterm::event::{KeyCode, KeyModifiers};
        let is = |c: char, m: KeyModifiers| key.code == KeyCode::Char(c) && key.modifiers == m;
        if let Some(n) = self.inside {
            let end = is('g', KeyModifiers::CONTROL) || is('\\', KeyModifiers::ALT);
            if end || n + 1 >= LATE_REPLY_MAX {
                // One answer only: done watching.
                self.inside = None;
                self.until = now;
            } else {
                self.inside = Some(n + 1);
            }
            return vec![];
        }
        if !self.held.is_empty() {
            const NEXT: [char; 3] = ['1', '1', ';'];
            if is(NEXT[self.held.len() - 1], KeyModifiers::NONE) {
                self.held.push(key);
                if self.held.len() == 4 {
                    self.held.clear();
                    self.inside = Some(0);
                }
                return vec![];
            }
            let mut out = std::mem::take(&mut self.held);
            out.extend(self.feed(key, now));
            return out;
        }
        if now < self.until && is(']', KeyModifiers::ALT) {
            self.held.push(key);
            return vec![];
        }
        vec![key]
    }

    /// On a tick: keys held past the watch were a person's, given back.
    pub fn flush(&mut self, now: std::time::Instant) -> Vec<crossterm::event::KeyEvent> {
        if now >= self.until && self.inside.is_none() {
            std::mem::take(&mut self.held)
        } else {
            vec![]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_themes_keep_every_rule() {
        for name in ThemeName::ALL {
            for bg in [None, Some(Rgb(255, 255, 255)), Some(Rgb(0, 0, 0))] {
                let (t, refused) = Theme::build(name, Depth::TrueColor, bg, &[]);
                assert!(refused.is_empty());
                assert_eq!(t.problem(None), None, "{name:?} on {bg:?}");
            }
        }
    }

    #[test]
    fn follow_terminal_reads_the_background() {
        let light_bg = Theme::build(
            ThemeName::Terminal,
            Depth::TrueColor,
            Some(Rgb(250, 250, 250)),
            &[],
        )
        .0;
        assert!(!light_bg.dark);
        let dark_bg = Theme::build(
            ThemeName::Terminal,
            Depth::TrueColor,
            Some(Rgb(20, 20, 30)),
            &[],
        )
        .0;
        assert!(dark_bg.dark);
        // No answer: dark.
        assert!(
            Theme::build(ThemeName::Terminal, Depth::TrueColor, None, &[])
                .0
                .dark
        );
        // The terminal's own ink and paper.
        assert_eq!(
            light_bg.base(),
            Style::default().fg(Color::Reset).bg(Color::Reset)
        );
    }

    #[test]
    fn osc11_answers_parse() {
        assert_eq!(
            parse_osc11(b"\x1b]11;rgb:ffff/ffff/ffff\x07"),
            Some(Rgb(255, 255, 255))
        );
        assert_eq!(
            parse_osc11(b"\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\\x1b[?62;c"),
            Some(Rgb(30, 30, 46))
        );
        assert_eq!(
            parse_osc11(b"\x1b]11;rgb:f/0/8\x07"),
            Some(Rgb(255, 0, 136))
        );
        assert_eq!(parse_osc11(b"\x1b[?62;22c"), None);
        assert_eq!(parse_osc11(b"\x1b]11;rgb:zz/00/00\x07"), None);
        // One ask, three answers: the colour, the keyboard protocol, and DA1 that ends them.
        let all = parse_answers(b"\x1b]11;rgb:1e1e/1e1e/2e2e\x07\x1b[?1u\x1b[?62;22c");
        assert_eq!(
            all,
            Answers {
                background: Some(Rgb(0x1e, 0x1e, 0x2e)),
                answered: true,
                keyboard: true
            }
        );
        // A terminal that only answers DA1: answered, no keyboard protocol, no colour.
        assert_eq!(
            parse_answers(b"\x1b[?62;c"),
            Answers {
                background: None,
                answered: true,
                keyboard: false
            }
        );
        // What the screen does with them: the keyboard protocol only when the terminal said so, and no second ask
        // (crossterm's two-second one) once the start ask was made; not asked: crossterm asks.
        use crate::settings::keyboard_of;
        assert_eq!(keyboard_of(Some(all)), Some(true));
        assert_eq!(keyboard_of(Some(parse_answers(b"\x1b[?62;c"))), Some(false));
        assert_eq!(keyboard_of(Some(Answers::default())), Some(false));
        assert_eq!(keyboard_of(None), None);
        // Nothing (or half an answer): not answered.
        assert_eq!(parse_answers(b""), Answers::default());
        assert!(!parse_answers(b"\x1b[?62;").answered);
        assert!(!parse_answers(b"\x1b[?1x u").keyboard);
        assert_eq!(parse_osc11(b"\x1b]11;rgb:00/00/00/00\x07"), None);
    }

    /// The keys crossterm reads from these bytes (its parser: ESC then a byte is Alt+that byte, 0x01–0x1A Ctrl+letter).
    fn keys_of(bytes: &[u8]) -> Vec<crossterm::event::KeyEvent> {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut out = vec![];
        let mut i = 0;
        while i < bytes.len() {
            let (b, m) = if bytes[i] == 0x1b && i + 1 < bytes.len() {
                i += 1;
                (bytes[i], KeyModifiers::ALT)
            } else {
                (bytes[i], KeyModifiers::NONE)
            };
            out.push(match b {
                0x01..=0x1a => KeyEvent::new(
                    KeyCode::Char((b - 1 + b'a') as char),
                    m | KeyModifiers::CONTROL,
                ),
                b => KeyEvent::new(KeyCode::Char(b as char), m),
            });
            i += 1;
        }
        out
    }

    #[test]
    fn a_late_background_answer_never_becomes_keys() {
        use std::time::{Duration, Instant};
        let start = Instant::now();
        let soon = start + Duration::from_millis(400);
        let mut late = LateReply::new(start + Duration::from_secs(1));
        let mut acted = vec![];
        let feed = |late: &mut LateReply, bytes: &[u8], at: Instant| {
            keys_of(bytes)
                .into_iter()
                .flat_map(|k| late.feed(k, at))
                .collect::<Vec<_>>()
        };
        // Typed before, the answer (BEL-ended), typed after: only the typing is acted on.
        acted.extend(feed(&mut late, b"j", soon));
        acted.extend(feed(&mut late, b"\x1b]11;rgb:1e1e/1e1e/2e2e\x07", soon));
        acted.extend(feed(&mut late, b"k", soon));
        assert_eq!(acted, keys_of(b"jk"));
        // ST-ended too.
        let mut late = LateReply::new(start + Duration::from_secs(1));
        assert!(feed(&mut late, b"\x1b]11;rgb:ffff/ffff/ffff\x1b\\", soon).is_empty());
        // One answer only: a second one later is a person's keys again.
        assert_eq!(feed(&mut late, b"\x1b]1", soon), keys_of(b"\x1b]1"));
        // After the watch: passed straight through.
        let mut late = LateReply::new(start + Duration::from_secs(1));
        let after = start + Duration::from_secs(2);
        assert_eq!(feed(&mut late, b"\x1b]11;x", after), keys_of(b"\x1b]11;x"));
        // A person's Alt+] then another key: both given back, in order.
        let mut late = LateReply::new(start + Duration::from_secs(1));
        assert_eq!(feed(&mut late, b"\x1b]1j", soon), keys_of(b"\x1b]1j"));
        // Alt+] alone: given back once the watch ends.
        assert!(feed(&mut late, b"\x1b]", soon).is_empty());
        assert!(late.flush(soon).is_empty());
        assert_eq!(late.flush(after), keys_of(b"\x1b]"));
        // Never watching: nothing held.
        let mut never = LateReply::new(start);
        assert_eq!(feed(&mut never, b"\x1b]11;", soon), keys_of(b"\x1b]11;"));
    }

    #[test]
    fn depth_from_the_environment() {
        assert_eq!(
            Depth::detect(true, Some("truecolor"), Some("xterm-256color")),
            Depth::Off
        );
        assert_eq!(
            Depth::detect(false, Some("truecolor"), Some("xterm")),
            Depth::TrueColor
        );
        assert_eq!(Depth::detect(false, Some("24bit"), None), Depth::TrueColor);
        assert_eq!(
            Depth::detect(false, None, Some("xterm-256color")),
            Depth::Ansi256
        );
        assert_eq!(Depth::detect(false, None, Some("xterm")), Depth::Ansi16);
        assert_eq!(Depth::detect(false, None, Some("dumb")), Depth::Off);
    }

    #[test]
    fn colours_step_down_to_256() {
        assert_eq!(Rgb(0, 0, 0).ansi256(), 16);
        assert_eq!(Rgb(255, 255, 255).ansi256(), 231);
        assert_eq!(Rgb(0x16, 0x16, 0x16).ansi256(), 233);
        assert_eq!(Rgb(0x70, 0xb8, 0xff).ansi256(), 75);
        let t = Theme::build(ThemeName::Dark, Depth::Ansi256, None, &[]).0;
        assert_eq!(t.running(), Style::default().fg(Color::Indexed(75)));
    }

    #[test]
    fn overrides_that_blur_meaning_or_fade_are_refused() {
        // Running made the same green as passed: refused, the theme's blue kept.
        let green = Rgb::parse("#3dd68c").unwrap();
        let (t, refused) = Theme::build(
            ThemeName::Dark,
            Depth::TrueColor,
            None,
            &[(Role::Running, green)],
        );
        assert_eq!(t.palette.get(Role::Running), dark().get(Role::Running));
        assert_eq!(
            refused,
            vec!["Your colour for running (#3dd68c) wasn't used: running and passed would look alike.".to_string()]
        );
        // Failed too faint on the dark paper: refused.
        let faint = Rgb::parse("#2a2a2a").unwrap();
        let (_, refused) = Theme::build(
            ThemeName::Dark,
            Depth::TrueColor,
            None,
            &[(Role::Failed, faint)],
        );
        assert_eq!(
            refused,
            vec!["Your colour for failed (#2a2a2a) wasn't used: it would be too faint on the background.".to_string()]
        );
        // A good one is used, alongside a refused one.
        let blue = Rgb::parse("#5aa9ff").unwrap();
        let (t, refused) = Theme::build(
            ThemeName::Dark,
            Depth::TrueColor,
            None,
            &[(Role::Running, blue), (Role::Passed, blue)],
        );
        assert_eq!(t.palette.get(Role::Running), Paint::Rgb(blue));
        assert_eq!(t.palette.get(Role::Passed), dark().get(Role::Passed));
        assert_eq!(refused.len(), 1);
        assert!(
            refused[0].contains("passed and running would look alike"),
            "{refused:?}"
        );
        // No amber can stand in for needs you when it fades on light paper.
        let amber = Rgb::parse("#f5a524").unwrap();
        let (t, refused) = Theme::build(
            ThemeName::Light,
            Depth::TrueColor,
            None,
            &[(Role::NeedsYou, amber)],
        );
        assert_eq!(t.palette.get(Role::NeedsYou), light().get(Role::NeedsYou));
        assert_eq!(refused.len(), 1);
        // Overrides at 16 colours: not used, said once.
        let (_, refused) = Theme::build(
            ThemeName::Dark,
            Depth::Ansi16,
            None,
            &[(Role::Running, blue)],
        );
        assert_eq!(refused.len(), 1);
    }

    #[test]
    fn no_color_draws_with_weight_and_reversal_only() {
        let t = Theme::build(ThemeName::Dark, Depth::Off, None, &[]).0;
        for s in [
            t.base(),
            t.ink(),
            t.needs_you(),
            t.muted(),
            t.line(),
            t.running(),
            t.passed(),
            t.failed(),
            t.selected(),
        ] {
            assert_eq!(s.fg, None);
            assert_eq!(s.bg, None);
        }
        assert_eq!(
            t.selected(),
            Style::default().add_modifier(Modifier::REVERSED)
        );
    }
}
