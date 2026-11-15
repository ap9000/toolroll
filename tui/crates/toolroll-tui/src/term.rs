//! The Terminal tab's pane (solo-workbench T4, take over): a real terminal the console hosts, drawn here through a VT
//! emulator.
//!
//! Security: the program's bytes go only into `vt100::Parser` and come out as cells, which `draw` copies into the
//! frame's buffer with each cell's text cleaned (text.rs: no control character, no bidi override or isolate, nothing
//! zero-width that hides text). Nothing the program writes ever reaches the real terminal as bytes: an OSC 52 clipboard
//! write, an OSC 8 link, a window title, a notification (OSC 9, OSC 777) or a bell are parsed and dropped by the
//! emulator (its callbacks are the no-op `()`), and a link's text is drawn as plain text. Keys go only to the pane the
//! person is looking at, and only while they are typing in it (app.rs `Mode::TakeOver`).
use crate::text::clean;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use vt100::{MouseProtocolEncoding, MouseProtocolMode};

/// Lines above the screen kept for scrolling back (the console keeps the same for a page that attaches later).
pub const SCROLLBACK_LINES: usize = 5000;
/// The largest screen-as-it-was a pane holds while attaching (the console sends at most 8 Mi characters of it).
pub const ATTACH_HOLD_MAX: usize = 32 << 20;
/// Said when output can't be kept whole: the pane closes, and t attaches again.
pub const TOO_MUCH: &str = "Too much output; reattach with t.";
/// Pasted text larger than this is refused (the console takes 256 KiB a second at most).
pub const PASTE_MAX_BYTES: usize = 200 * 1024;

/// Where the pane is with its terminal.
#[derive(Debug, Clone, PartialEq)]
pub enum Link {
    /// Asking the console for it (listed, or started) and opening the socket.
    Opening,
    /// Attached; the screen as it was is still arriving (until `hello`).
    Attaching,
    /// Live: typing reaches the program.
    Live,
    /// The program ended (its exit status, when known); the screen stays readable.
    Ended {
        code: Option<i64>,
        signal: Option<i64>,
    },
    /// The socket closed or couldn't open; the words say why. The program may still run in the console (t again).
    Closed(String),
}

/// One terminal shown in the Terminal tab: which task and build it was opened on, the console's id once known, and the
/// emulator holding its screen and scrollback.
pub struct Pane {
    pub task: String,
    pub run: i64,
    pub id: Option<String>,
    pub link: Link,
    pub parser: vt100::Parser,
    /// Output before `hello` (the screen as it was when attaching), parsed at the console's size once it says it. Held
    /// as the chunks it came in, so it still counts against the connection's output budget.
    held: Vec<toolroll_api::Chunk>,
    held_bytes: usize,
    /// The size last sent to the console (cols, rows), and the pane's size last frame.
    pub sent: Option<(u16, u16)>,
    pub area: Rect,
    /// The console's branch for it (its own copy's branch), for the pane's line.
    pub branch: String,
    /// The last frame drew this terminal on screen (view.rs sets it each frame). Nothing reaches the terminal while it
    /// isn't drawn — a window too small, another tab, a dialog over it.
    pub drawn: bool,
    /// Lines up into the scrollback (0: the live screen).
    pub scroll: usize,
    /// The program said it isn't reading input (typing waits until it does).
    pub input_full: bool,
}

impl std::fmt::Debug for Pane {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Pane {{ task: {:?}, run: {}, id: {:?}, link: {:?} }}",
            self.task, self.run, self.id, self.link
        )
    }
}

impl Pane {
    pub fn opening(task: String, run: i64) -> Pane {
        Pane {
            task,
            run,
            id: None,
            link: Link::Opening,
            parser: vt100::Parser::new(24, 80, SCROLLBACK_LINES),
            held: Vec::new(),
            held_bytes: 0,
            sent: None,
            area: Rect::default(),
            branch: String::new(),
            drawn: false,
            scroll: 0,
            input_full: false,
        }
    }

    pub fn live(&self) -> bool {
        self.link == Link::Live
    }

    /// The socket opened: output until `hello` is the screen as it is now.
    pub fn attached(&mut self, id: String) {
        self.id = Some(id);
        self.link = Link::Attaching;
        self.held.clear();
        self.held_bytes = 0;
    }

    /// Terminal output as it arrived: held until `hello` while attaching, else parsed. False when the screen as it was
    /// is larger than any the console sends (ATTACH_HOLD_MAX): nothing is dropped silently, the pane closes and says so.
    pub fn take(&mut self, chunk: toolroll_api::Chunk) -> bool {
        if self.link == Link::Attaching {
            self.held_bytes += chunk.len();
            if self.held_bytes > ATTACH_HOLD_MAX {
                self.held.clear();
                self.held_bytes = 0;
                self.link = Link::Closed(TOO_MUCH.into());
                return false;
            }
            self.held.push(chunk);
            return true;
        }
        self.parser.process(&chunk);
        true
    }

    /// Terminal output (only ever into the emulator).
    pub fn output(&mut self, bytes: &[u8]) {
        if self.link == Link::Attaching {
            let _ = self.take(bytes.to_vec().into());
            return;
        }
        self.parser.process(bytes);
    }

    /// `hello`: the screen so far was drawn at the console's size; parse it at that size, then go live (the next frame
    /// sends this pane's own size, and the program redraws for it).
    pub fn hello(&mut self, cols: u16, rows: u16, ended: bool) {
        self.parser.screen_mut().set_size(rows.max(1), cols.max(1));
        for chunk in std::mem::take(&mut self.held) {
            self.parser.process(&chunk);
        }
        self.held_bytes = 0;
        self.sent = Some((cols, rows));
        self.link = if ended {
            Link::Ended {
                code: None,
                signal: None,
            }
        } else {
            Link::Live
        };
    }

    /// The size this pane wants the terminal to be, when it differs from the one last sent (only while live).
    pub fn wanted_size(&mut self) -> Option<(u16, u16)> {
        if !self.live() || !self.drawn || self.area.width < 2 || self.area.height < 1 {
            return None;
        }
        let want = (self.area.width.min(500), self.area.height.min(200));
        if self.sent == Some(want) {
            return None;
        }
        self.sent = Some(want);
        self.parser.screen_mut().set_size(want.1, want.0);
        Some(want)
    }

    /// Scroll back (positive) or forward; clamped to the scrollback there is.
    pub fn scroll_by(&mut self, lines: i64) {
        let screen = self.parser.screen_mut();
        screen.set_scrollback(usize::MAX);
        let most = screen.scrollback();
        self.scroll = (self.scroll as i64 + lines).clamp(0, most as i64) as usize;
        screen.set_scrollback(self.scroll);
    }

    /// The scrollback and the screen as plain lines, oldest first, cleaned (for the terminal's own scrollback: copy).
    pub fn text_lines(&mut self) -> Vec<String> {
        let (_, cols) = self.parser.screen().size();
        let screen = self.parser.screen_mut();
        screen.set_scrollback(usize::MAX);
        let most = screen.scrollback();
        let mut lines = Vec::with_capacity(most + 60);
        for back in (1..=most).rev() {
            screen.set_scrollback(back);
            if let Some(first) = screen.rows(0, cols).next() {
                lines.push(clean(first.trim_end()));
            }
        }
        screen.set_scrollback(0);
        lines.extend(screen.rows(0, cols).map(|l| clean(l.trim_end())));
        while lines.last().is_some_and(|l| l.is_empty()) {
            lines.pop();
        }
        screen.set_scrollback(self.scroll);
        lines
    }

    /// The bytes a key sends the program (None: a key a terminal sends nothing for).
    pub fn key_bytes(&self, key: KeyEvent) -> Option<Vec<u8>> {
        encode_key(key, self.parser.screen().application_cursor())
    }

    /// Pasted text as the program should get it: bracketed when it asked for that, line breaks as Enter. Every ESC
    /// and every other C0 or C1 control (and DEL) is taken out first, keeping only tab and line breaks, so a paste can
    /// never carry an escape sequence: it can't end the bracket early (however its markers are nested) and type the
    /// rest as keys. Nothing relies on finding the marker strings.
    pub fn paste_bytes(&self, text: &str) -> Result<Vec<u8>, &'static str> {
        if text.len() > PASTE_MAX_BYTES {
            return Err("That paste is too large for the terminal (over 200 KB).");
        }
        let plain: String = text
            .chars()
            .filter(|c| matches!(c, '\t' | '\r' | '\n') || !(c.is_control()))
            .collect();
        let body = plain.replace("\r\n", "\r").replace('\n', "\r");
        let mut out = Vec::with_capacity(body.len() + 12);
        let bracketed = self.parser.screen().bracketed_paste();
        if bracketed {
            out.extend_from_slice(b"\x1b[200~");
        }
        out.extend_from_slice(body.as_bytes());
        if bracketed {
            out.extend_from_slice(b"\x1b[201~");
        }
        Ok(out)
    }

    /// A mouse event inside the pane, as the program asked to hear it; None when it didn't ask (then the wheel scrolls
    /// the scrollback here instead).
    pub fn mouse_bytes(&self, ev: &MouseEvent) -> Option<Vec<u8>> {
        let a = self.area;
        if ev.column < a.x || ev.row < a.y || ev.column >= a.x + a.width || ev.row >= a.y + a.height
        {
            return None;
        }
        let screen = self.parser.screen();
        encode_mouse(
            ev,
            screen.mouse_protocol_mode(),
            screen.mouse_protocol_encoding(),
            ev.column - a.x,
            ev.row - a.y,
        )
    }

    /// Where the program's cursor is, on screen (None when hidden, scrolled back, or outside the pane).
    pub fn cursor(&self) -> Option<(u16, u16)> {
        let screen = self.parser.screen();
        if screen.hide_cursor() || self.scroll > 0 {
            return None;
        }
        let (row, col) = screen.cursor_position();
        (row < self.area.height && col < self.area.width)
            .then(|| (self.area.x + col, self.area.y + row))
    }
}

/// A key as a terminal sends it (xterm's encoding): characters with Ctrl and Alt, Enter, Tab, Backspace, Esc, the
/// arrows (application mode when the program asked), Home/End, Page Up/Down, Insert/Delete and F1–F12, with modifiers.
pub fn encode_key(key: KeyEvent, app_cursor: bool) -> Option<Vec<u8>> {
    let m = key.modifiers;
    let ctrl = m.contains(KeyModifiers::CONTROL);
    let alt = m.contains(KeyModifiers::ALT);
    let shift = m.contains(KeyModifiers::SHIFT);
    // xterm's modifier parameter: 1 + shift + 2·alt + 4·ctrl.
    let param = 1 + u8::from(shift) + 2 * u8::from(alt) + 4 * u8::from(ctrl);
    let csi = |end: char| -> Vec<u8> {
        if param > 1 {
            format!("\x1b[1;{param}{end}").into_bytes()
        } else if app_cursor && matches!(end, 'A' | 'B' | 'C' | 'D' | 'H' | 'F') {
            format!("\x1bO{end}").into_bytes()
        } else {
            format!("\x1b[{end}").into_bytes()
        }
    };
    let tilde = |n: u8| -> Vec<u8> {
        if param > 1 {
            format!("\x1b[{n};{param}~").into_bytes()
        } else {
            format!("\x1b[{n}~").into_bytes()
        }
    };
    let with_alt = |mut bytes: Vec<u8>| -> Vec<u8> {
        if alt {
            bytes.insert(0, 0x1b);
        }
        bytes
    };
    Some(match key.code {
        KeyCode::Char(c) if ctrl => {
            let byte = match c.to_ascii_lowercase() {
                c @ 'a'..='z' => c as u8 - b'a' + 1,
                '@' | ' ' | '2' => 0,
                '[' | '3' => 0x1b,
                '\\' | '4' => 0x1c,
                ']' | '5' => 0x1d,
                '^' | '6' => 0x1e,
                '_' | '-' | '7' => 0x1f,
                '?' | '8' => 0x7f,
                _ => return Some(with_alt(c.to_string().into_bytes())),
            };
            with_alt(vec![byte])
        }
        KeyCode::Char(c) => with_alt(c.to_string().into_bytes()),
        KeyCode::Enter => with_alt(vec![b'\r']),
        KeyCode::Tab => with_alt(vec![b'\t']),
        KeyCode::BackTab => b"\x1b[Z".to_vec(),
        KeyCode::Backspace => with_alt(vec![if ctrl { 0x08 } else { 0x7f }]),
        KeyCode::Esc => with_alt(vec![0x1b]),
        KeyCode::Up => csi('A'),
        KeyCode::Down => csi('B'),
        KeyCode::Right => csi('C'),
        KeyCode::Left => csi('D'),
        KeyCode::Home => csi('H'),
        KeyCode::End => csi('F'),
        KeyCode::Insert => tilde(2),
        KeyCode::Delete => tilde(3),
        KeyCode::PageUp => tilde(5),
        KeyCode::PageDown => tilde(6),
        KeyCode::F(n @ 1..=4) => {
            let end = b"PQRS"[usize::from(n - 1)] as char;
            if param > 1 {
                format!("\x1b[1;{param}{end}").into_bytes()
            } else {
                format!("\x1bO{end}").into_bytes()
            }
        }
        KeyCode::F(n @ 5..=12) => tilde([15, 17, 18, 19, 20, 21, 23, 24][usize::from(n - 5)]),
        _ => return None,
    })
}

/// Ctrl-] — back to the workbench (never sent to the program). Without the kitty keyboard protocol a terminal reports
/// it as Ctrl-5 (the byte 0x1d).
pub fn is_back_key(key: &KeyEvent) -> bool {
    key.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(key.code, KeyCode::Char(']') | KeyCode::Char('5'))
}

/// A mouse event in the program's mouse protocol (xterm: X10/normal, button and any motion; default, UTF-8 or SGR
/// coordinates). `col`/`row` are 0-based inside the pane.
pub fn encode_mouse(
    ev: &MouseEvent,
    mode: MouseProtocolMode,
    encoding: MouseProtocolEncoding,
    col: u16,
    row: u16,
) -> Option<Vec<u8>> {
    if mode == MouseProtocolMode::None {
        return None;
    }
    let button_code = |b: MouseButton| match b {
        MouseButton::Left => 0u16,
        MouseButton::Middle => 1,
        MouseButton::Right => 2,
    };
    let (mut code, release) = match ev.kind {
        MouseEventKind::Down(b) => (button_code(b), false),
        MouseEventKind::Up(b) => {
            if mode == MouseProtocolMode::Press {
                return None;
            }
            (
                if encoding == MouseProtocolEncoding::Sgr {
                    button_code(b)
                } else {
                    3
                },
                true,
            )
        }
        MouseEventKind::Drag(b) => {
            if !matches!(
                mode,
                MouseProtocolMode::ButtonMotion | MouseProtocolMode::AnyMotion
            ) {
                return None;
            }
            (button_code(b) + 32, false)
        }
        MouseEventKind::Moved => {
            if mode != MouseProtocolMode::AnyMotion {
                return None;
            }
            (3 + 32, false)
        }
        MouseEventKind::ScrollUp => (64, false),
        MouseEventKind::ScrollDown => (65, false),
        _ => return None,
    };
    if ev.modifiers.contains(KeyModifiers::SHIFT) {
        code += 4;
    }
    if ev.modifiers.contains(KeyModifiers::ALT) {
        code += 8;
    }
    if ev.modifiers.contains(KeyModifiers::CONTROL) {
        code += 16;
    }
    let (x, y) = (u32::from(col) + 1, u32::from(row) + 1);
    Some(match encoding {
        MouseProtocolEncoding::Sgr => {
            format!("\x1b[<{code};{x};{y}{}", if release { 'm' } else { 'M' }).into_bytes()
        }
        MouseProtocolEncoding::Default => {
            if x > 223 || y > 223 {
                return None;
            }
            vec![
                0x1b,
                b'[',
                b'M',
                (32 + code) as u8,
                (32 + x) as u8,
                (32 + y) as u8,
            ]
        }
        MouseProtocolEncoding::Utf8 => {
            let mut out = vec![0x1b, b'[', b'M'];
            for n in [32 + u32::from(code), 32 + x, 32 + y] {
                let c = char::from_u32(n.min(2047))?;
                let mut tmp = [0u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut tmp).as_bytes());
            }
            out
        }
    })
}

fn color(c: vt100::Color) -> Option<Color> {
    match c {
        vt100::Color::Default => None,
        vt100::Color::Idx(i) => Some(Color::Indexed(i)),
        vt100::Color::Rgb(r, g, b) => Some(Color::Rgb(r, g, b)),
    }
}

/// One cell's text, safe to draw: printable ASCII as is; anything else cleaned (text.rs), a space when nothing is left.
fn cell_text(s: &str) -> Option<String> {
    let b = s.as_bytes();
    if b.len() == 1 && (0x20..0x7f).contains(&b[0]) {
        return None;
    }
    let cleaned = clean(s);
    Some(if cleaned.is_empty() || crate::text::width(&cleaned) == 0 {
        " ".to_string()
    } else {
        cleaned
    })
}

/// Draw the terminal's visible screen (or the scrolled-back view) into `area` of `buf`, cell by cell, over `base`.
pub fn draw(buf: &mut Buffer, area: Rect, screen: &vt100::Screen, base: Style) {
    let (rows, cols) = screen.size();
    for y in 0..area.height {
        for x in 0..area.width {
            let pos = (area.x + x, area.y + y);
            let target = &mut buf[pos];
            target.reset();
            target.set_style(base);
            let Some(cell) = (y < rows && x < cols).then(|| screen.cell(y, x)).flatten() else {
                target.set_char(' ');
                continue;
            };
            if cell.is_wide_continuation() {
                // The wide character before it covers this cell.
                target.set_symbol("");
                continue;
            }
            let contents = cell.contents();
            if contents.is_empty() {
                target.set_char(' ');
            } else {
                match cell_text(contents) {
                    None => target.set_symbol(contents),
                    Some(text) => target.set_symbol(&text),
                };
            }
            let (mut fg, mut bg) = (color(cell.fgcolor()), color(cell.bgcolor()));
            if cell.inverse() {
                std::mem::swap(&mut fg, &mut bg);
                fg = fg.or(base.bg).or(Some(Color::Black));
                bg = bg.or(base.fg).or(Some(Color::White));
            }
            let mut style = base;
            if let Some(fg) = fg {
                style = style.fg(fg);
            }
            if let Some(bg) = bg {
                style = style.bg(bg);
            }
            let mut m = Modifier::empty();
            if cell.bold() {
                m |= Modifier::BOLD;
            }
            if cell.dim() {
                m |= Modifier::DIM;
            }
            if cell.italic() {
                m |= Modifier::ITALIC;
            }
            if cell.underline() {
                m |= Modifier::UNDERLINED;
            }
            target.set_style(style.add_modifier(m));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyEventState;

    fn k(code: KeyCode, m: KeyModifiers) -> KeyEvent {
        KeyEvent {
            code,
            modifiers: m,
            kind: crossterm::event::KeyEventKind::Press,
            state: KeyEventState::NONE,
        }
    }

    #[test]
    fn keys_encode_as_xterm_sends_them() {
        let none = KeyModifiers::NONE;
        assert_eq!(
            encode_key(k(KeyCode::Char('a'), none), false),
            Some(b"a".to_vec())
        );
        assert_eq!(
            encode_key(k(KeyCode::Char('c'), KeyModifiers::CONTROL), false),
            Some(vec![3])
        );
        assert_eq!(
            encode_key(k(KeyCode::Char('x'), KeyModifiers::ALT), false),
            Some(b"\x1bx".to_vec())
        );
        assert_eq!(
            encode_key(k(KeyCode::Enter, none), false),
            Some(b"\r".to_vec())
        );
        assert_eq!(
            encode_key(k(KeyCode::Backspace, none), false),
            Some(vec![0x7f])
        );
        assert_eq!(
            encode_key(k(KeyCode::Up, none), false),
            Some(b"\x1b[A".to_vec())
        );
        assert_eq!(
            encode_key(k(KeyCode::Up, none), true),
            Some(b"\x1bOA".to_vec())
        );
        assert_eq!(
            encode_key(k(KeyCode::Right, KeyModifiers::CONTROL), true),
            Some(b"\x1b[1;5C".to_vec())
        );
        assert_eq!(
            encode_key(k(KeyCode::Delete, none), false),
            Some(b"\x1b[3~".to_vec())
        );
        assert_eq!(
            encode_key(k(KeyCode::PageUp, KeyModifiers::SHIFT), false),
            Some(b"\x1b[5;2~".to_vec())
        );
        assert_eq!(
            encode_key(k(KeyCode::F(1), none), false),
            Some(b"\x1bOP".to_vec())
        );
        assert_eq!(
            encode_key(k(KeyCode::F(5), none), false),
            Some(b"\x1b[15~".to_vec())
        );
        assert_eq!(
            encode_key(k(KeyCode::Char('é'), none), false),
            Some("é".as_bytes().to_vec())
        );
        assert!(is_back_key(&k(KeyCode::Char(']'), KeyModifiers::CONTROL)));
        assert!(is_back_key(&k(KeyCode::Char('5'), KeyModifiers::CONTROL)));
        assert!(!is_back_key(&k(KeyCode::Char(']'), none)));
    }

    #[test]
    fn mouse_reports_only_what_the_program_asked_for() {
        let ev = |kind| MouseEvent {
            kind,
            column: 4,
            row: 2,
            modifiers: KeyModifiers::NONE,
        };
        let down = ev(MouseEventKind::Down(MouseButton::Left));
        assert_eq!(
            encode_mouse(
                &down,
                MouseProtocolMode::None,
                MouseProtocolEncoding::Sgr,
                4,
                2
            ),
            None
        );
        assert_eq!(
            encode_mouse(
                &down,
                MouseProtocolMode::PressRelease,
                MouseProtocolEncoding::Sgr,
                4,
                2
            ),
            Some(b"\x1b[<0;5;3M".to_vec())
        );
        assert_eq!(
            encode_mouse(
                &ev(MouseEventKind::Up(MouseButton::Left)),
                MouseProtocolMode::PressRelease,
                MouseProtocolEncoding::Sgr,
                4,
                2
            ),
            Some(b"\x1b[<0;5;3m".to_vec())
        );
        assert_eq!(
            encode_mouse(
                &down,
                MouseProtocolMode::PressRelease,
                MouseProtocolEncoding::Default,
                4,
                2
            ),
            Some(vec![0x1b, b'[', b'M', 32, 37, 35])
        );
        assert_eq!(
            encode_mouse(
                &ev(MouseEventKind::Moved),
                MouseProtocolMode::PressRelease,
                MouseProtocolEncoding::Sgr,
                4,
                2
            ),
            None
        );
        assert_eq!(
            encode_mouse(
                &ev(MouseEventKind::ScrollUp),
                MouseProtocolMode::Press,
                MouseProtocolEncoding::Sgr,
                4,
                2
            ),
            Some(b"\x1b[<64;5;3M".to_vec())
        );
    }

    /// The paste's body between the brackets: never an ESC, never a C0/C1 control but tab and CR.
    fn pasted(pane: &Pane, text: &str) -> Vec<u8> {
        let bytes = pane.paste_bytes(text).unwrap();
        assert!(
            bytes.starts_with(b"\x1b[200~") && bytes.ends_with(b"\x1b[201~"),
            "{bytes:?}"
        );
        let body = bytes[6..bytes.len() - 6].to_vec();
        let shown = String::from_utf8(body.clone()).unwrap();
        assert!(
            shown
                .chars()
                .all(|c| matches!(c, '\t' | '\r') || !c.is_control()),
            "{shown:?}"
        );
        body
    }

    #[test]
    fn a_paste_cannot_end_its_own_bracket() {
        let mut pane = Pane::opening("t".into(), 1);
        pane.parser.process(b"\x1b[?2004h");
        // An end marker, and nested ones that a one-pass removal would put back together.
        assert_eq!(
            pasted(&pane, "echo hi\x1b[201~rm -rf ~\n"),
            b"echo hi[201~rm -rf ~\r".to_vec()
        );
        assert_eq!(
            pasted(&pane, "a\x1b[20\x1b[201~1~b"),
            b"a[20[201~1~b".to_vec()
        );
        assert_eq!(
            pasted(&pane, "\x1b[2\x1b[200~01~x"),
            b"[2[200~01~x".to_vec()
        );
        // A bare ESC, other C0 controls, DEL and C1 controls (as UTF-8, CSI U+009B among them).
        assert_eq!(pasted(&pane, "x\x1by\x07\x00\x08\x7fz"), b"xyz".to_vec());
        assert_eq!(
            pasted(&pane, "p\u{9b}201~q\u{85}r\u{80}\u{9f}s"),
            b"p201~qrs".to_vec()
        );
        // A normal multi-line paste arrives intact (tabs kept, line breaks as Enter).
        assert_eq!(
            pasted(&pane, "fn main() {\n\tprintln!(\"日本\");\r\n}\n"),
            "fn main() {\r\tprintln!(\"日本\");\r}\r"
                .as_bytes()
                .to_vec()
        );
        // Unbracketed when the program didn't ask, cleaned the same way.
        pane.parser.process(b"\x1b[?2004l");
        assert_eq!(
            pane.paste_bytes("a\r\nb\x1b[201~").unwrap(),
            b"a\rb[201~".to_vec()
        );
        assert!(pane.paste_bytes(&"x".repeat(PASTE_MAX_BYTES + 1)).is_err());
    }
}
