//! Text for the screen: whatever wrote it (an agent, a person, a project's name), no escape or control character ever
//! reaches the terminal. Every string from the engine goes through `clean` before it is drawn or notified.
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

/// Control characters (C0, DEL, C1), bidi overrides and isolates, and zero-width joiners that can hide text become a
/// visible stand-in or nothing; tabs become spaces; line breaks become spaces (callers split lines first).
pub fn clean(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\t' | '\n' | '\r' => out.push(' '),
            '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' => out.push('\u{fffd}'),
            '\u{202a}'..='\u{202e}'
            | '\u{2066}'..='\u{2069}'
            | '\u{200e}'
            | '\u{200f}'
            | '\u{061c}' => {}
            '\u{200b}'..='\u{200d}' | '\u{2060}' | '\u{feff}' => {}
            c => out.push(c),
        }
    }
    out
}

/// Display width in terminal cells.
pub fn width(s: &str) -> usize {
    UnicodeWidthStr::width(s)
}

/// At most `max` cells, with an ellipsis when cut.
pub fn fit(s: &str, max: usize) -> String {
    if width(s) <= max {
        return s.to_string();
    }
    if max == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut w = 0;
    for c in s.chars() {
        let cw = c.width().unwrap_or(0);
        if w + cw + 1 > max {
            break;
        }
        out.push(c);
        w += cw;
    }
    out.push('…');
    out
}

/// Wrap at word boundaries into lines of at most `max` cells (a word longer than a line is cut).
pub fn wrap(s: &str, max: usize) -> Vec<String> {
    let max = max.max(1);
    let mut lines = Vec::new();
    let mut line = String::new();
    let mut w = 0;
    for word in s.split(' ') {
        let ww = width(word);
        if w > 0 && w + 1 + ww > max {
            lines.push(std::mem::take(&mut line));
            w = 0;
        }
        if ww > max {
            // A very long word: cut it across lines.
            for c in word.chars() {
                let cw = c.width().unwrap_or(0);
                if w + cw > max {
                    lines.push(std::mem::take(&mut line));
                    w = 0;
                }
                line.push(c);
                w += cw;
            }
            continue;
        }
        if w > 0 {
            line.push(' ');
            w += 1;
        }
        line.push_str(word);
        w += ww;
    }
    if !line.is_empty() || lines.is_empty() {
        lines.push(line);
    }
    lines
}

/// Cut into lines of at most `max` cells without dropping or changing a character: joined back, the lines are `s`
/// exactly (a command shown to copy wraps this way, never at its spaces).
pub fn chunks(s: &str, max: usize) -> Vec<String> {
    let max = max.max(1);
    let mut lines = vec![];
    let mut line = String::new();
    let mut w = 0;
    for c in s.chars() {
        let cw = c.width().unwrap_or(0);
        if w > 0 && w + cw > max {
            lines.push(std::mem::take(&mut line));
            w = 0;
        }
        line.push(c);
        w += cw;
    }
    if !line.is_empty() || lines.is_empty() {
        lines.push(line);
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_and_hidden_characters_never_reach_the_terminal() {
        let hostile = "ok\u{1b}]52;c;aGk=\u{7}\u{1b}[2Jgone\u{202e}txt.exe\u{9b}31m\u{200b}";
        let shown = clean(hostile);
        assert!(!shown.chars().any(|c| c.is_control()), "{shown:?}");
        assert!(!shown.contains('\u{202e}') && !shown.contains('\u{200b}'));
        assert!(shown.starts_with("ok\u{fffd}]52;c;aGk=\u{fffd}\u{fffd}[2Jgone"));
    }

    #[test]
    fn a_command_is_cut_by_cells_and_joins_back_exactly() {
        let command = "git -C '/private/tmp/a very long/project folder' merge --ff-only 3b51847";
        for max in [1, 7, 20, 80] {
            let lines = chunks(command, max);
            assert!(lines.iter().all(|l| width(l) <= max), "{lines:?}");
            assert_eq!(lines.concat(), command);
        }
        assert_eq!(chunks("", 10), vec![String::new()]);
    }

    #[test]
    fn fits_and_wraps_by_cells() {
        assert_eq!(fit("hello world", 8), "hello w…");
        assert_eq!(fit("短い文字列です", 7), "短い文…");
        assert_eq!(
            wrap("one two three four", 9),
            vec!["one two", "three", "four"]
        );
        assert_eq!(wrap("abcdefghij", 4), vec!["abcd", "efgh", "ij"]);
        assert_eq!(wrap("", 4), vec![""]);
    }
}
