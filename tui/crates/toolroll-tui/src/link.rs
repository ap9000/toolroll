//! Clickable links (OSC 8), only for links Toolroll itself builds: the console's own task page for a task on screen.
//! Never for anything an agent wrote: agent text is cleaned (text.rs), so it can't carry an escape of its own, and no
//! link is ever made from it.
//!
//! A link is built here from the console's origin (the loopback address this session signed in to) and a task id,
//! percent-encoded, and checked again before it is written; the view only records where a link's words were drawn.
//! After a frame, `overlay` writes those words once more inside an OSC 8 pair, cell by cell with the frame's own
//! style, between a cursor save and restore. The bytes come from the constants below and nowhere else.
//!
//! Like the theme, links follow the terminal: none with NO_COLOR (a terminal asked to keep to plain text), and none
//! inside tmux unless tui.toml says tmux passes sequences on (`tmux-passthrough = true`).
use ratatui::buffer::Buffer;
use ratatui::style::{Color, Modifier};

const OPEN: &str = "\x1b]8;;";
const ST: &str = "\x1b\\";
const SAVE: &str = "\x1b7";
const RESTORE: &str = "\x1b8";
const RESET: &str = "\x1b[0m";

/// Where a link's words were drawn this frame: the row, the first column, how many cells, and the link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkArea {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub url: String,
}

/// Whether links may be written to this terminal (the theme's rules: NO_COLOR, tmux).
pub fn enabled(no_color: bool, tmux: bool, passthrough: bool) -> bool {
    !no_color && (!tmux || passthrough)
}

/// The console's origin, when it is one this client would sign in to: http on a loopback address with a port.
fn loopback_origin(origin: &str) -> bool {
    let Some(rest) = origin.strip_prefix("http://") else {
        return false;
    };
    let (host, port) = match rest.rsplit_once(':') {
        Some(hp) => hp,
        None => return false,
    };
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
        && !port.is_empty()
        && port.len() <= 5
        && port.bytes().all(|b| b.is_ascii_digit())
}

/// Only characters a URL needs, none that could end or bend a sequence.
pub fn safe_url(url: &str) -> bool {
    !url.is_empty()
        && url.len() <= 512
        && url
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b":/._~%?=&-[]".contains(&b))
}

/// The console's own page for a task: `<origin>/t/<id>` (None when the origin isn't the loopback console's, or the
/// result isn't a plain URL).
pub fn task_url(origin: &str, task: &str) -> Option<String> {
    if !loopback_origin(origin) || task.is_empty() {
        return None;
    }
    let url = format!("{origin}/t/{}", toolroll_api::client::encode(task));
    safe_url(&url).then_some(url)
}

fn colour(out: &mut String, c: Color, fg: bool) {
    let (base, bright) = if fg { (30, 90) } else { (40, 100) };
    let named = |n: u8, light: bool| format!(";{}", if light { bright } else { base } + n);
    out.push_str(&match c {
        Color::Reset => format!(";{}", if fg { 39 } else { 49 }),
        Color::Black => named(0, false),
        Color::Red => named(1, false),
        Color::Green => named(2, false),
        Color::Yellow => named(3, false),
        Color::Blue => named(4, false),
        Color::Magenta => named(5, false),
        Color::Cyan => named(6, false),
        Color::Gray => named(7, false),
        Color::DarkGray => named(0, true),
        Color::LightRed => named(1, true),
        Color::LightGreen => named(2, true),
        Color::LightYellow => named(3, true),
        Color::LightBlue => named(4, true),
        Color::LightMagenta => named(5, true),
        Color::LightCyan => named(6, true),
        Color::White => named(7, true),
        Color::Indexed(i) => format!(";{};5;{i}", if fg { 38 } else { 48 }),
        Color::Rgb(r, g, b) => format!(";{};2;{r};{g};{b}", if fg { 38 } else { 48 }),
    });
}

/// The SGR for a cell's style (reset first, so nothing of the last one carries over).
fn sgr(fg: Color, bg: Color, m: Modifier) -> String {
    let mut out = String::from("\x1b[0");
    for (flag, code) in [
        (Modifier::BOLD, 1),
        (Modifier::DIM, 2),
        (Modifier::ITALIC, 3),
        (Modifier::UNDERLINED, 4),
        (Modifier::REVERSED, 7),
        (Modifier::HIDDEN, 8),
        (Modifier::CROSSED_OUT, 9),
    ] {
        if m.contains(flag) {
            out.push_str(&format!(";{code}"));
        }
    }
    colour(&mut out, fg, true);
    colour(&mut out, bg, false);
    out.push('m');
    out
}

/// The bytes that make the frame's link words clickable: each link's cells written again, with their own style,
/// inside one OSC 8 pair; the cursor and style given back after. Empty when there is nothing (or nothing safe) to link.
pub fn overlay(buffer: &Buffer, links: &[LinkArea]) -> String {
    let area = buffer.area;
    let mut out = String::new();
    for link in links {
        if !safe_url(&link.url) || link.width == 0 || link.y >= area.y + area.height {
            continue;
        }
        let end = (link.x + link.width).min(area.x + area.width);
        if link.x >= end {
            continue;
        }
        out.push_str(&format!("\x1b[{};{}H", link.y + 1, link.x + 1));
        out.push_str(OPEN);
        out.push_str(&link.url);
        out.push_str(ST);
        let mut x = link.x;
        let mut last = String::new();
        while x < end {
            let cell = &buffer[(x, link.y)];
            let style = sgr(cell.fg, cell.bg, cell.modifier);
            if style != last {
                out.push_str(&style);
                last = style;
            }
            // Our own frame's symbols, still: anything that isn't plain printable text is a space.
            let sym: String = cell
                .symbol()
                .chars()
                .map(|c| if c.is_control() { ' ' } else { c })
                .collect();
            out.push_str(if sym.is_empty() { " " } else { &sym });
            x += (crate::text::width(&sym) as u16).max(1);
        }
        out.push_str(OPEN);
        out.push_str(ST);
    }
    if out.is_empty() {
        return out;
    }
    format!("{SAVE}{out}{RESET}{RESTORE}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::layout::Rect;

    #[test]
    fn only_the_consoles_own_task_links() {
        assert_eq!(
            task_url("http://127.0.0.1:4180", "t-done").as_deref(),
            Some("http://127.0.0.1:4180/t/t-done")
        );
        // Encoded, never raw.
        let odd = task_url("http://127.0.0.1:4180", "a b\u{1b}]8;;x\u{7}").unwrap();
        assert!(
            safe_url(&odd) && !odd.contains('\u{1b}') && !odd.contains(' '),
            "{odd}"
        );
        for origin in [
            "https://127.0.0.1:4180",
            "http://evil.example:80",
            "http://127.0.0.1",
            "http://127.0.0.1:41a0",
            "javascript:alert(1)",
            "",
        ] {
            assert_eq!(task_url(origin, "t-done"), None, "{origin}");
        }
        assert!(!safe_url("http://x/\u{1b}\\"));
        assert!(!safe_url("http://x/ y"));
    }

    #[test]
    fn the_overlay_is_ours_and_keeps_the_frames_look() {
        let mut buf = Buffer::empty(Rect::new(0, 0, 20, 2));
        buf.set_string(
            2,
            1,
            "Add CSV",
            ratatui::style::Style::default().fg(Color::Blue),
        );
        let url = "http://127.0.0.1:4180/t/t-done".to_string();
        let out = overlay(
            &buf,
            &[LinkArea {
                x: 2,
                y: 1,
                width: 7,
                url: url.clone(),
            }],
        );
        assert!(
            out.starts_with("\x1b7\x1b[2;3H\x1b]8;;http://127.0.0.1:4180/t/t-done\x1b\\"),
            "{out:?}"
        );
        assert!(out.ends_with("\x1b]8;;\x1b\\\x1b[0m\x1b8"), "{out:?}");
        assert!(out.contains("\x1b[0;34;49mAdd CSV\x1b]8;;"), "{out:?}");
        // Exactly one link opened and closed.
        assert_eq!(out.matches("\x1b]8;;").count(), 2);
        // An unsafe link is never written, and nothing at all is written for it.
        assert_eq!(
            overlay(
                &buf,
                &[LinkArea {
                    x: 2,
                    y: 1,
                    width: 7,
                    url: "http://x/\u{7}".into()
                }]
            ),
            ""
        );
        assert_eq!(overlay(&buf, &[]), "");
    }

    #[test]
    fn links_follow_no_color_and_tmux() {
        assert!(enabled(false, false, false));
        assert!(!enabled(true, false, false));
        assert!(!enabled(false, true, false));
        assert!(enabled(false, true, true));
        assert!(!enabled(true, true, true));
    }
}
