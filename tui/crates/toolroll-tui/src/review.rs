//! Reviewing a result in the Diff tab (solo-workbench plan T2): a file's hunks laid out as code lines with the context
//! revealed around them, word-level emphasis inside changed lines, unified or side-by-side rows, and the person's notes
//! (kept here, in memory, per task and build, until they send them as one batch).
//!
//! Pure functions over the engine's answers: no network, no terminal. Every text here was cleaned (text.rs) before it
//! is kept, so what is drawn and what a batch posts are the same inert characters.
use crate::text::clean;
use std::collections::BTreeMap;
use std::ops::Range;
use toolroll_api::{DiffLine, ResultDiffFile};

/// Lines one press of `e` or `E` reveals (the engine allows at most 100 a read).
pub const EXPAND_STEP: i64 = 20;
/// The longest batch of notes one send carries (the engine's note limit, decision.ts validateNote).
pub const BATCH_MAX_CHARS: usize = 4_000;
/// The right pane's width (cells) from which side by side can be shown; narrower, unified.
pub const SPLIT_MIN_WIDTH: u16 = 110;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Old,
    New,
}

/// What a note is about: one line (of the new file, or a removed line of the old one), or a whole hunk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoteAt {
    Line(Side, i64),
    Hunk(String),
}

/// One note, as typed (cleaned), on a file of the result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    pub file: i64,
    pub path: String,
    pub at: NoteAt,
    /// Where it sorts in its file (its line, or its hunk's first line).
    pub order: i64,
    pub text: String,
}

impl Note {
    /// "src/total.ts line 2": where the note is, in the batch's words.
    pub fn place(&self) -> String {
        match &self.at {
            NoteAt::Line(Side::New, n) => format!("{} line {n}", self.path),
            NoteAt::Line(Side::Old, n) => format!("{} removed line {n}", self.path),
            NoteAt::Hunk(header) => format!("{} {}", self.path, header),
        }
    }
}

/// Keep `notes` in file then line order, with `note` put in its place (replacing one at the same spot).
pub fn put(notes: &mut Vec<Note>, note: Note) {
    notes.retain(|n| !(n.file == note.file && n.at == note.at));
    let at = notes
        .iter()
        .position(|n| (n.file, n.order) > (note.file, note.order))
        .unwrap_or(notes.len());
    notes.insert(at, note);
}

/// The one text a batch posts (the revise act's note, or the saved note Accept carries), and the dialog shows it, the
/// same characters: each note with its place, then the words for the whole change.
pub fn batch_text(notes: &[Note], general: &str) -> String {
    let general = general.trim();
    if notes.is_empty() {
        return general.to_string();
    }
    let mut out = String::from("Notes on the changes:");
    for n in notes {
        out.push_str(&format!("\n- {} — {}", n.place(), n.text.trim()));
    }
    if !general.is_empty() {
        out.push_str("\n\n");
        out.push_str(general);
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Context,
    Addition,
    Deletion,
    Meta,
    /// Context the person revealed (not in the saved patch).
    Revealed,
}

/// One line of code as drawn: cleaned text, its numbers, and the byte ranges of words that changed.
#[derive(Debug, Clone, PartialEq)]
pub struct CodeLine {
    pub hunk: usize,
    pub kind: Kind,
    pub old: Option<i64>,
    pub new: Option<i64>,
    pub text: String,
    /// The colouring starts afresh here (a new hunk, or a revealed run).
    pub fresh: bool,
    pub changed: Vec<Range<usize>>,
}

/// The pieces of a file's view, in order: hunk headings, hidden-line markers and code.
#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    Hunk(usize),
    /// Hidden lines above hunk `hunk` (`hunk` == the number of hunks: below the last); `hidden` when known.
    Gap {
        hunk: usize,
        hidden: Option<i64>,
    },
    Code(usize),
}

/// A hunk's place in the new and old files, from its heading.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span2 {
    pub first_new: i64,
    pub last_new: i64,
    pub first_old: i64,
    pub last_old: i64,
}

/// "@@ -a,b +c,d @@" → where the hunk sits (an empty side sits after line a or c).
pub fn span_of(header: &str) -> Option<Span2> {
    let rest = header.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(" +")?;
    let (new, _) = rest.split_once(" @@")?;
    let pair = |s: &str| -> Option<(i64, i64)> {
        let (a, b) = s.split_once(',').unwrap_or((s, "1"));
        Some((a.parse().ok()?, b.parse().ok()?))
    };
    let ((a, b), (c, d)) = (pair(old)?, pair(new)?);
    let side = |start: i64, len: i64| {
        if len == 0 {
            (start + 1, start)
        } else {
            (start, start + len - 1)
        }
    };
    let (first_old, last_old) = side(a, b);
    let (first_new, last_new) = side(c, d);
    Some(Span2 {
        first_new,
        last_new,
        first_old,
        last_old,
    })
}

/// A file laid out: its items and code lines, and each hunk's place.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Code {
    pub items: Vec<Item>,
    pub lines: Vec<CodeLine>,
    pub spans: Vec<Option<Span2>>,
    /// Each hunk's heading up to its second "@@" (what a hunk note names), cleaned.
    pub headers: Vec<String>,
}

/// The new-file lines between hunk `h - 1` and hunk `h` (h == hunks: after the last, up to `count` when known).
pub fn gap_of(spans: &[Option<Span2>], h: usize, count: Option<i64>) -> Option<(i64, Option<i64>)> {
    let below = if h == 0 {
        1
    } else {
        spans.get(h - 1).copied().flatten()?.last_new + 1
    };
    if h >= spans.len() {
        return Some((below, count));
    }
    let above = spans[h]?.first_new - 1;
    Some((below, Some(above)))
}

/// The old-file number of new-file line `n` in the gap above hunk `h` (unchanged lines keep their distance).
fn old_of(spans: &[Option<Span2>], h: usize, n: i64) -> Option<i64> {
    let offset = if h < spans.len() {
        let s = spans[h]?;
        s.first_old - s.first_new
    } else {
        let s = spans.last().copied().flatten()?;
        s.last_old - s.last_new
    };
    Some(n + offset)
}

/// Lay a file out: each hunk's lines, with the revealed lines (new-file number → text) shown around them and the rest
/// of each gap collapsed into one marker.
pub fn layout(file: &ResultDiffFile, revealed: &BTreeMap<i64, String>, count: Option<i64>) -> Code {
    let hunks = &file.file.hunks;
    let spans: Vec<Option<Span2>> = hunks.iter().map(|h| span_of(&h.header)).collect();
    let mut code = Code {
        spans: spans.clone(),
        headers: hunks.iter().map(|h| short_header(&h.header)).collect(),
        ..Code::default()
    };
    let gap = |code: &mut Code, h: usize| {
        let Some((below, above)) = gap_of(&spans, h, count) else {
            return;
        };
        if above.is_some_and(|a| a < below) {
            return;
        }
        let mut n = below;
        let mut fresh = true;
        loop {
            if above.is_some_and(|a| n > a) {
                break;
            }
            match revealed.get(&n) {
                Some(text) => {
                    code.lines.push(CodeLine {
                        hunk: h.min(hunks.len().saturating_sub(1)),
                        kind: Kind::Revealed,
                        old: old_of(&spans, h, n),
                        new: Some(n),
                        text: text.clone(),
                        fresh,
                        changed: vec![],
                    });
                    code.items.push(Item::Code(code.lines.len() - 1));
                    fresh = false;
                    n += 1;
                }
                None => {
                    // The hidden run: up to the next revealed line (or the gap's end).
                    let next = revealed
                        .range(n..)
                        .next()
                        .map(|(k, _)| *k)
                        .filter(|k| above.is_none_or(|a| *k <= a));
                    let hidden = match (next, above) {
                        (Some(k), _) => Some(k - n),
                        (None, Some(a)) => Some(a - n + 1),
                        (None, None) => None,
                    };
                    code.items.push(Item::Gap { hunk: h, hidden });
                    fresh = true;
                    match next {
                        Some(k) => n = k,
                        None => break,
                    }
                }
            }
        }
    };
    for (h, hunk) in hunks.iter().enumerate() {
        gap(&mut code, h);
        code.items.push(Item::Hunk(h));
        let start = code.lines.len();
        for (i, line) in hunk.lines.iter().enumerate() {
            code.lines.push(code_line(h, line, i == 0));
            code.items.push(Item::Code(code.lines.len() - 1));
        }
        emphasise(&mut code.lines[start..]);
    }
    // The lines after the last hunk: a marker only while the file may go on (everyday-9 E5), never "more lines below"
    // over the end of the file.
    if !hunks.is_empty()
        && spans.last().copied().flatten().is_some()
        && !(count.is_none() && hunks.last().is_some_and(ends_at_eof))
    {
        gap(&mut code, hunks.len());
    }
    code
}

/// Lines of context git keeps after a change (its default; Toolroll's diffs never ask for fewer).
const CONTEXT: usize = 3;

/// Whether a hunk proves its file ends with it: git's "No newline at end of file" note, or a change followed by fewer
/// lines of context than git keeps (it would have shown them had the file gone on).
fn ends_at_eof(hunk: &toolroll_api::Hunk) -> bool {
    if hunk
        .lines
        .iter()
        .any(|l| l.kind == "meta" && l.text.contains("No newline at end of file"))
    {
        return true;
    }
    let changed = hunk
        .lines
        .iter()
        .any(|l| l.kind == "addition" || l.kind == "deletion");
    let trailing = hunk
        .lines
        .iter()
        .rev()
        .take_while(|l| l.kind == "context")
        .count();
    changed && trailing < CONTEXT
}

fn code_line(hunk: usize, line: &DiffLine, fresh: bool) -> CodeLine {
    CodeLine {
        hunk,
        kind: match line.kind.as_str() {
            "addition" => Kind::Addition,
            "deletion" => Kind::Deletion,
            "meta" => Kind::Meta,
            _ => Kind::Context,
        },
        old: line.old_line,
        new: line.new_line,
        text: clean(&line.text),
        fresh,
        changed: vec![],
    }
}

/// Word-level emphasis: each run of removed lines followed by added lines is paired line by line, and the words that
/// differ in each pair are marked.
fn emphasise(lines: &mut [CodeLine]) {
    let mut i = 0;
    while i < lines.len() {
        if lines[i].kind != Kind::Deletion {
            i += 1;
            continue;
        }
        let dels = i;
        while i < lines.len() && lines[i].kind == Kind::Deletion {
            i += 1;
        }
        let adds = i;
        while i < lines.len() && lines[i].kind == Kind::Addition {
            i += 1;
        }
        let pairs = (adds - dels).min(i - adds);
        for p in 0..pairs {
            let (old, new) = word_changes(&lines[dels + p].text, &lines[adds + p].text);
            lines[dels + p].changed = old;
            lines[adds + p].changed = new;
        }
    }
}

/// Words, runs of spaces, and single other characters, as byte ranges.
fn tokens(s: &str) -> Vec<Range<usize>> {
    let mut out = vec![];
    let mut start: Option<(usize, u8)> = None;
    let class = |c: char| {
        if c.is_alphanumeric() || c == '_' {
            1
        } else if c == ' ' {
            2
        } else {
            0
        }
    };
    for (i, c) in s.char_indices() {
        let k = class(c);
        match start {
            Some((from, kind)) if kind == k && k != 0 => {
                let _ = from;
            }
            Some((from, _)) => {
                out.push(from..i);
                start = Some((i, k));
            }
            None => start = Some((i, k)),
        }
    }
    if let Some((from, _)) = start {
        out.push(from..s.len());
    }
    out
}

/// The byte ranges that differ between two lines, word by word (a longest common subsequence of their words). Lines
/// too long to compare quickly, or with nothing in common, mark nothing: the whole line is the change.
pub fn word_changes(old: &str, new: &str) -> (Vec<Range<usize>>, Vec<Range<usize>>) {
    let (a, b) = (tokens(old), tokens(new));
    if a.is_empty() || b.is_empty() || a.len() * b.len() > 40_000 {
        return (vec![], vec![]);
    }
    let (n, m) = (a.len(), b.len());
    let mut dp = vec![0u16; (n + 1) * (m + 1)];
    let at = |i: usize, j: usize| i * (m + 1) + j;
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[at(i, j)] = if old[a[i].clone()] == new[b[j].clone()] {
                dp[at(i + 1, j + 1)] + 1
            } else {
                dp[at(i + 1, j)].max(dp[at(i, j + 1)])
            };
        }
    }
    let common = dp[at(0, 0)] as usize;
    // Only spaces in common: nothing worth marking.
    if common == 0 {
        return (vec![], vec![]);
    }
    let (mut i, mut j) = (0, 0);
    let (mut ka, mut kb) = (vec![false; n], vec![false; m]);
    while i < n && j < m {
        if old[a[i].clone()] == new[b[j].clone()] {
            ka[i] = true;
            kb[j] = true;
            i += 1;
            j += 1;
        } else if dp[at(i + 1, j)] >= dp[at(i, j + 1)] {
            i += 1;
        } else {
            j += 1;
        }
    }
    let ranges = |toks: &[Range<usize>], kept: &[bool]| {
        let mut out: Vec<Range<usize>> = vec![];
        for (t, k) in toks.iter().zip(kept) {
            if *k {
                continue;
            }
            match out.last_mut() {
                Some(last) if last.end == t.start => last.end = t.end,
                _ => out.push(t.clone()),
            }
        }
        out
    };
    (ranges(&a, &ka), ranges(&b, &kb))
}

/// One row of the Diff tab's file view.
#[derive(Debug, Clone, PartialEq)]
pub enum Row {
    Hunk(usize),
    Gap {
        hunk: usize,
        hidden: Option<i64>,
    },
    /// Unified: one code line.
    Code(usize),
    /// Side by side: the old line on the left, the new on the right.
    Pair(Option<usize>, Option<usize>),
    /// A note (its index in the notes of this file view).
    Note(usize),
}

/// The rows for a laid-out file: unified or side by side, each note under the line or hunk it is about.
pub fn rows(code: &Code, notes: &[Note], split: bool) -> Vec<Row> {
    let mut out: Vec<Row> = vec![];
    let mut placed = vec![false; notes.len()];
    let notes_for =
        |out: &mut Vec<Row>, placed: &mut Vec<bool>, matches: &dyn Fn(&NoteAt) -> bool| {
            for (k, n) in notes.iter().enumerate() {
                if !placed[k] && matches(&n.at) {
                    placed[k] = true;
                    out.push(Row::Note(k));
                }
            }
        };
    let line_matches = |l: &CodeLine| {
        let (old, new, kind) = (l.old, l.new, l.kind);
        move |at: &NoteAt| match at {
            NoteAt::Line(Side::New, n) => new == Some(*n) && kind != Kind::Deletion,
            NoteAt::Line(Side::Old, n) => old == Some(*n) && kind == Kind::Deletion,
            NoteAt::Hunk(_) => false,
        }
    };
    let mut i = 0;
    while i < code.items.len() {
        match &code.items[i] {
            Item::Hunk(h) => {
                out.push(Row::Hunk(*h));
                let header = code.headers.get(*h).cloned().unwrap_or_default();
                notes_for(
                    &mut out,
                    &mut placed,
                    &|at| matches!(at, NoteAt::Hunk(text) if *text == header),
                );
                i += 1;
            }
            Item::Gap { hunk, hidden } => {
                out.push(Row::Gap {
                    hunk: *hunk,
                    hidden: *hidden,
                });
                i += 1;
            }
            Item::Code(c) if !split => {
                out.push(Row::Code(*c));
                notes_for(&mut out, &mut placed, &line_matches(&code.lines[*c]));
                i += 1;
            }
            Item::Code(c) => {
                let line = &code.lines[*c];
                if line.kind == Kind::Deletion {
                    // A run of removals, then a run of additions: paired side by side.
                    let mut dels = vec![];
                    while let Some(Item::Code(d)) = code.items.get(i) {
                        if code.lines[*d].kind != Kind::Deletion {
                            break;
                        }
                        dels.push(*d);
                        i += 1;
                    }
                    let mut adds = vec![];
                    while let Some(Item::Code(a)) = code.items.get(i) {
                        if code.lines[*a].kind != Kind::Addition {
                            break;
                        }
                        adds.push(*a);
                        i += 1;
                    }
                    for k in 0..dels.len().max(adds.len()) {
                        let (l, r) = (dels.get(k).copied(), adds.get(k).copied());
                        out.push(Row::Pair(l, r));
                        for side in [l, r].into_iter().flatten() {
                            notes_for(&mut out, &mut placed, &line_matches(&code.lines[side]));
                        }
                    }
                } else if line.kind == Kind::Addition {
                    out.push(Row::Pair(None, Some(*c)));
                    notes_for(&mut out, &mut placed, &line_matches(line));
                    i += 1;
                } else {
                    out.push(Row::Pair(Some(*c), Some(*c)));
                    notes_for(&mut out, &mut placed, &line_matches(line));
                    i += 1;
                }
            }
        }
    }
    // Notes whose line isn't shown (the file changed under them): at the end, never dropped.
    for (k, p) in placed.iter().enumerate() {
        if !p {
            out.push(Row::Note(k));
        }
    }
    out
}

/// A hunk's heading as notes name it: up to its second "@@" (the rest is git's guess at the enclosing line), cleaned.
pub fn short_header(header: &str) -> String {
    let cleaned = clean(header);
    match cleaned.get(2..).and_then(|rest| rest.find("@@")) {
        Some(i) => cleaned[..i + 4].to_string(),
        None => cleaned,
    }
}

/// Where the Accept facts' checks stand, from the step cards.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Checks {
    Passed,
    Failed,
    Running,
    Skipped,
    NotRun,
    /// The check command was approved again since they ran: out of date, never a failure.
    Stale,
}

impl Checks {
    /// From the Checks card's mark and the steps' own check fact (StepCards.check): an out-of-date check is never read
    /// as failed, whatever its mark.
    pub fn of(mark: Option<&str>, check: Option<&str>) -> Checks {
        if check == Some("stale") {
            return Checks::Stale;
        }
        match mark {
            Some("done") => Checks::Passed,
            Some("stuck") => Checks::Failed,
            Some("live") => Checks::Running,
            Some("skipped") => Checks::Skipped,
            _ => Checks::NotRun,
        }
    }
    pub fn short(self) -> &'static str {
        match self {
            Checks::Passed => "passed",
            Checks::Failed => "failed",
            Checks::Running => "running",
            Checks::Skipped => "skipped",
            Checks::NotRun => "none ran",
            Checks::Stale => "out of date",
        }
    }
    pub fn word(self) -> &'static str {
        match self {
            Checks::Passed => "Checks passed",
            Checks::Failed => "Checks failed",
            Checks::Running => "Checks running",
            Checks::Skipped => "Checks skipped",
            Checks::NotRun => "No checks ran",
            Checks::Stale => "Checks out of date",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One file whose only hunk ends with `trailing` lines of context after its change.
    fn file_ending_with(trailing: usize) -> toolroll_api::ResultDiffFile {
        let mut lines = vec![
            serde_json::json!({ "kind": "addition", "text": "export const subtract = (a, b) => a - b;", "oldLine": null, "newLine": 1 }),
        ];
        for i in 0..trailing as i64 {
            lines.push(serde_json::json!({ "kind": "context", "text": "x", "oldLine": i + 1, "newLine": i + 2 }));
        }
        let n = trailing as i64;
        serde_json::from_value(
            serde_json::json!({ "version": 1, "task": "t", "run": 1, "linesTruncated": false,
            "file": { "file": 0, "path": "math.js", "oldPath": "math.js", "meta": [],
                "hunks": [{ "header": format!("@@ -1,{n} +1,{} @@", n + 1), "lines": lines }] } }),
        )
        .unwrap()
    }
    fn ends_with_gap(code: &Code) -> bool {
        matches!(code.items.last(), Some(Item::Gap { .. }))
    }

    #[test]
    fn more_lines_below_only_while_the_file_may_go_on() {
        // Fewer lines of context after the change than git keeps: the file ends there, nothing below.
        assert!(!ends_with_gap(&layout(
            &file_ending_with(1),
            &BTreeMap::new(),
            None
        )));
        assert!(!ends_with_gap(&layout(
            &file_ending_with(0),
            &BTreeMap::new(),
            None
        )));
        // A full three: the file may go on, so the marker stays.
        assert!(ends_with_gap(&layout(
            &file_ending_with(3),
            &BTreeMap::new(),
            None
        )));
        // A known line count decides by itself.
        assert!(ends_with_gap(&layout(
            &file_ending_with(1),
            &BTreeMap::new(),
            Some(9)
        )));
    }

    #[test]
    fn spans_from_headings() {
        assert_eq!(
            span_of("@@ -1,3 +1,4 @@ fn x"),
            Some(Span2 {
                first_new: 1,
                last_new: 4,
                first_old: 1,
                last_old: 3
            })
        );
        assert_eq!(
            span_of("@@ -5,2 +4,0 @@"),
            Some(Span2 {
                first_new: 5,
                last_new: 4,
                first_old: 5,
                last_old: 6
            })
        );
        assert_eq!(span_of("@@ -1 +1,2 @@").unwrap().last_old, 1);
        assert_eq!(span_of("not a hunk"), None);
        assert_eq!(
            short_header("@@ -1,3 +1,3 @@ fn total() {"),
            "@@ -1,3 +1,3 @@"
        );
    }

    #[test]
    fn word_level_changes() {
        let (old, new) = word_changes("  return sum(items);", "  return sum(items) + tax(items);");
        assert!(old.is_empty());
        assert_eq!(
            &"  return sum(items) + tax(items);"[new[0].clone()],
            " + tax(items)"
        );
        let (old, new) = word_changes("let total = a;", "let subtotal = a;");
        assert_eq!(&"let total = a;"[old[0].clone()], "total");
        assert_eq!(&"let subtotal = a;"[new[0].clone()], "subtotal");
        // Nothing in common: nothing marked (the whole line is the change).
        assert_eq!(word_changes("abc", "xyz"), (vec![], vec![]));
    }

    #[test]
    fn a_batch_is_its_notes_in_order_then_the_general_words() {
        let mut notes = vec![];
        let note = |file: i64, path: &str, at: NoteAt, order: i64, text: &str| Note {
            file,
            path: path.into(),
            at,
            order,
            text: text.into(),
        };
        put(
            &mut notes,
            note(1, "README.md", NoteAt::Line(Side::New, 2), 2, "say VAT"),
        );
        put(
            &mut notes,
            note(0, "src/total.ts", NoteAt::Line(Side::New, 2), 2, "round it"),
        );
        put(
            &mut notes,
            note(
                0,
                "src/total.ts",
                NoteAt::Hunk("@@ -1,3 +1,3 @@".into()),
                1,
                "keep it small",
            ),
        );
        // The same spot again replaces the note there.
        put(
            &mut notes,
            note(
                0,
                "src/total.ts",
                NoteAt::Line(Side::New, 2),
                2,
                "round to cents",
            ),
        );
        assert_eq!(
            batch_text(&notes, " thanks "),
            "Notes on the changes:\n- src/total.ts @@ -1,3 +1,3 @@ — keep it small\n- src/total.ts line 2 — round to cents\n- README.md line 2 — say VAT\n\nthanks"
        );
        assert_eq!(batch_text(&[], " only words "), "only words");
    }
}
