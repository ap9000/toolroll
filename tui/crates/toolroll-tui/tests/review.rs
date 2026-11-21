//! Diff review in the terminal (solo-workbench plan T2), drawn on ratatui's TestBackend from the fake console's
//! scenario: unified and side by side, word-level emphasis, syntax colours, revealed context, notes and the batch that
//! carries them, what accepting means, and the narrow fallback. Each state is an insta snapshot; the styled ones are
//! dumped with their colours so a colour change is a snapshot change.
#[path = "common/pairs.rs"]
mod pairs;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseEvent, MouseEventKind};
use ratatui::backend::TestBackend;
use ratatui::style::{Color, Modifier};
use ratatui::Terminal;
use serde_json::{json, Value};
use toolroll_api::*;
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, ContextAsk, Effect, Mode, Msg, SendAct, Tab, RESULT_CHANGED};
use toolroll_tui::review::Row;

const NOW: i64 = 1_794_657_852;

fn parse<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).expect("fixture shape")
}
fn key(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)
}
fn code(c: KeyCode) -> KeyEvent {
    KeyEvent::new(c, KeyModifiers::NONE)
}

/// A Rust file with two hunks: a renamed function (word-level), an added line, and a changed body.
pub fn cart_file(run: i64) -> Value {
    let l = |kind: &str, text: &str, old: Option<i64>, new: Option<i64>| json!({ "kind": kind, "text": text, "oldLine": old, "newLine": new });
    json!({ "version": 1, "task": "t-done", "run": run, "linesTruncated": false,
        "file": { "file": 0, "path": "src/cart.rs", "oldPath": "src/cart.rs", "meta": ["diff --git a/src/cart.rs b/src/cart.rs"],
        "hunks": [
            { "header": "@@ -1,6 +1,7 @@", "lines": [
                l("context", "use std::fmt;", Some(1), Some(1)),
                l("context", "", Some(2), Some(2)),
                l("deletion", "fn total(items: &[i64]) -> i64 {", Some(3), None),
                l("addition", "fn subtotal(items: &[i64]) -> i64 {", None, Some(3)),
                l("context", "    items.iter().sum()", Some(4), Some(4)),
                l("context", "}", Some(5), Some(5)),
                l("addition", "// Tax is added at checkout.", None, Some(6)),
                l("context", "", Some(6), Some(7)) ] },
            { "header": "@@ -20,3 +21,3 @@ impl Cart {", "lines": [
                l("context", "    pub fn count(&self) -> usize {", Some(20), Some(21)),
                l("deletion", "        self.items.len()", Some(21), None),
                l("addition", "        self.items.iter().filter(|i| **i > 0).count()", None, Some(22)),
                l("context", "    }", Some(22), Some(23)) ] } ] } })
}

fn cart_diff(run: i64) -> Value {
    json!({ "version": 1, "task": "t-done", "run": run, "patchTruncated": false, "problem": null,
        "totals": { "files": 2, "additions": 3, "deletions": 2, "binary": 0, "filesTruncated": false },
        "files": [
            { "file": 0, "path": "src/cart.rs", "oldPath": "src/cart.rs", "additions": 3, "deletions": 2, "binary": false, "hunks": 2 },
            { "file": 1, "path": "README.md", "oldPath": "README.md", "additions": 1, "deletions": 0, "binary": false, "hunks": 1 } ] })
}

fn readme_file(run: i64) -> Value {
    let mut f = fake::scenario().diff_files["t-done:1"].clone();
    f["run"] = run.into();
    f
}

/// t-done's steps with its checks passed, a cost, and the accept facts given.
fn steps(accept: Value) -> StepCards {
    let mut s = fake::scenario().steps["t-done"].clone();
    for card in s["cards"].as_array_mut().unwrap() {
        match card["key"].as_str().unwrap() {
            "checks" => {
                card["mark"] = json!("done");
                card["state"] = json!("done");
                card["sentence"] = json!("1 check passed");
            }
            "build" => card["costUsd"] = json!(0.42),
            _ => {}
        }
    }
    s["review"]["accept"] = accept;
    parse(s)
}

fn no_accept_facts() -> Value {
    json!({ "owed": null, "blockers": [], "needs": null })
}

/// The app on t-done's Diff tab with the cart file's hunks on screen.
fn review_app(accept: Value) -> App {
    let mut app = App::new(false, Some("/home/me/shop".into()));
    app.now = NOW;
    app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    app.key(key('j'));
    app.update(Msg::Steps("t-done".into(), Ok(steps(accept))));
    let fx = app.key(code(KeyCode::Enter));
    assert_eq!(app.tab, Tab::Diff);
    let ask = fx
        .iter()
        .find_map(|e| match e {
            Effect::FetchDiff(a) => Some(a.clone()),
            _ => None,
        })
        .expect("diff read");
    let fx = app.update(Msg::Diff(ask, Ok(parse(cart_diff(2)))));
    let ask = file_ask(&fx);
    app.update(Msg::DiffFile(ask, Ok(parse(cart_file(2)))));
    app
}

fn file_ask(fx: &[Effect]) -> toolroll_tui::app::FileAsk {
    fx.iter()
        .find_map(|e| match e {
            Effect::FetchDiffFile(a) => Some(a.clone()),
            _ => None,
        })
        .expect("file read")
}

fn context_ask(fx: &[Effect]) -> ContextAsk {
    fx.iter()
        .find_map(|e| match e {
            Effect::FetchContext(a) => Some(a.clone()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no context read in {fx:?}"))
}

fn draw(app: &mut App, w: u16, h: u16) -> Terminal<TestBackend> {
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| toolroll_tui::view::draw(f, app)).unwrap();
    pairs::check(app, w, h);
    for cell in term.backend().buffer().content() {
        assert!(
            !matches!(
                cell.fg,
                Color::Yellow | Color::LightYellow | Color::Rgb(245, 165, 36)
            ),
            "amber at {:?}",
            cell.symbol()
        );
    }
    term
}

fn screen(app: &mut App, w: u16, h: u16) -> String {
    draw(app, w, h).backend().to_string()
}

/// Rows `from..to` with each run of styled cells marked ⟦colour+modifiers:text⟧ (unstyled text as it is).
fn styled(app: &mut App, w: u16, h: u16, from: u16, to: u16) -> String {
    let term = draw(app, w, h);
    let buf = term.backend().buffer();
    let mut out = String::new();
    for y in from..to {
        let mut run: Option<(Color, Modifier, String)> = None;
        let flush = |out: &mut String, run: &mut Option<(Color, Modifier, String)>| {
            if let Some((fg, m, text)) = run.take() {
                if fg == Color::Reset && m.is_empty() {
                    out.push_str(&text);
                } else {
                    out.push_str(&format!(
                        "⟦{fg:?}{}:{text}⟧",
                        if m.is_empty() {
                            String::new()
                        } else {
                            format!("+{m:?}")
                        }
                    ));
                }
            }
        };
        for x in 37..w - 1 {
            let cell = &buf[(x, y)];
            let style = (cell.fg, cell.modifier);
            match &mut run {
                Some((fg, m, text)) if (*fg, *m) == style => text.push_str(cell.symbol()),
                _ => {
                    flush(&mut out, &mut run);
                    run = Some((style.0, style.1, cell.symbol().to_string()));
                }
            }
        }
        flush(&mut out, &mut run);
        out.push('\n');
    }
    out.lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
}

fn type_words(app: &mut App, words: &str) {
    for c in words.chars() {
        app.key(key(c));
    }
}

fn sends(fx: &[Effect]) -> bool {
    fx.iter()
        .any(|e| matches!(e, Effect::Act { .. } | Effect::Send { .. }))
}

/// Move to the row showing new-file line `n` (unified).
fn to_line(app: &mut App, n: i64) {
    let code = app.code.clone().unwrap();
    let at = app
        .rows
        .iter()
        .position(|r| match r {
            Row::Code(c) | Row::Pair(_, Some(c)) => {
                code.lines[*c].new == Some(n)
                    && code.lines[*c].kind != toolroll_tui::review::Kind::Deletion
            }
            _ => false,
        })
        .expect("line shown");
    app.diff_cursor = at;
}

#[test]
fn unified() {
    let mut app = review_app(no_accept_facts());
    insta::assert_snapshot!(screen(&mut app, 120, 34));
}

#[test]
fn split_follows_the_width() {
    let mut app = review_app(no_accept_facts());
    // (No syntax colours here: keep narrow truncation deterministic whatever another test loaded.)
    app.syntax_on = false;
    assert_eq!(app.key(key('v')), vec![]);
    insta::assert_snapshot!("split", screen(&mut app, 200, 34));
    assert!(app.split_on());
    // Narrower than side by side needs: unified, with the person's choice kept for when it widens again.
    let narrow = screen(&mut app, 100, 34);
    assert!(!app.split_on() && app.diff_split);
    insta::assert_snapshot!("narrow_fallback", narrow);
    assert!(screen(&mut app, 200, 34).contains("│"));
    assert!(app.split_on());
}

#[test]
fn word_level_emphasis() {
    let mut app = review_app(no_accept_facts());
    // (No syntax colours here: the emphasis alone, whatever another test loaded.)
    app.syntax_on = false;
    // Rows 14..23: the first hunk's renamed function (only the changed word is reversed on each side).
    let shown = styled(&mut app, 120, 34, 14, 23);
    assert!(shown.contains("+REVERSED:total⟧"), "{shown}");
    assert!(shown.contains("+REVERSED:subtotal⟧"), "{shown}");
    insta::assert_snapshot!(shown);
}

#[test]
fn syntax_highlighted_rust() {
    toolroll_tui::syntax::load_now();
    let mut app = review_app(no_accept_facts());
    // Coloured off the screen's thread: plain until done, then drawn coloured.
    screen(&mut app, 120, 34);
    assert!(app
        .highlights
        .as_ref()
        .unwrap()
        .wait(std::time::Duration::from_secs(10)));
    screen(&mut app, 120, 34);
    assert!(!app.highlight_pending);
    let shown = styled(&mut app, 120, 34, 9, 24);
    // (The default look: the terminal's 16 colours, dark. Keywords by weight, strings in the code accent.)
    assert!(shown.contains("BOLD:use⟧"), "{shown}");
    insta::assert_snapshot!(shown);
    // NO_COLOR (the theme at depth Off): the same screen, no colour anywhere, code included.
    use toolroll_tui::theme::{Depth, Theme, ThemeName};
    app.prefs.theme = Theme::build(ThemeName::Terminal, Depth::Off, None, &[]).0;
    let term = draw(&mut app, 120, 34);
    assert!(term
        .backend()
        .buffer()
        .content()
        .iter()
        .all(|c| c.fg == Color::Reset && c.bg == Color::Reset));
}

#[test]
fn expanded_context() {
    let mut app = review_app(no_accept_facts());
    // Below the first hunk: lines 8.. up to the second hunk (line 21), at most 20 at a time.
    to_line(&mut app, 7);
    let ask = context_ask(&app.key(key('E')));
    assert_eq!(
        (ask.task.as_str(), ask.run, ask.file, ask.from, ask.count),
        ("t-done", 2, 0, 8, 13)
    );
    let lines: Vec<Value> = (8..=20)
        .map(|n| json!({ "newLine": n, "text": format!("// line {n}") }))
        .collect();
    app.update(Msg::Context(
        ask.clone(),
        Ok(parse(json!({ "version": 1, "task": "t-done", "run": 2, "file": 0, "from": 8, "lines": lines, "lineCount": 40, "problem": null }))),
    ));
    assert_eq!(app.revealed.len(), 13);
    // The gap is closed now: the second hunk follows line 20 directly, and the file's end is counted.
    insta::assert_snapshot!(screen(&mut app, 120, 40));
    // Nothing more above the second hunk.
    let at = app.rows.iter().position(|r| *r == Row::Hunk(1)).unwrap();
    app.diff_cursor = at;
    assert_eq!(app.key(key('e')), vec![]);
    assert_eq!(
        app.status.as_ref().unwrap().1,
        "Nothing more is hidden above this hunk."
    );
}

#[test]
fn stale_context_answers_are_dropped() {
    let mut app = review_app(no_accept_facts());
    to_line(&mut app, 7);
    let first = context_ask(&app.key(key('E')));
    let answer = |ask: &ContextAsk, file: i64| -> ResultDiffContext {
        parse(
            json!({ "version": 1, "task": ask.task, "run": ask.run, "file": file, "from": ask.from,
            "lines": [{ "newLine": ask.from, "text": "// hidden" }], "lineCount": 40, "problem": null }),
        )
    };
    // Asked again before the first answer came: only the newest ask is taken.
    let second = context_ask(&app.key(key('E')));
    assert_ne!(first, second);
    app.update(Msg::Context(first.clone(), Ok(answer(&first, 0))));
    assert!(app.revealed.is_empty(), "an older ask's answer was taken");
    // An answer that claims another file than its ask is dropped.
    app.update(Msg::Context(second.clone(), Ok(answer(&second, 1))));
    assert!(app.revealed.is_empty());
    // The file on screen changed before the answer came: dropped, never drawn under the other file.
    let next = file_ask(&app.key(key('}')));
    app.update(Msg::Context(second.clone(), Ok(answer(&second, 0))));
    assert!(app.revealed.is_empty());
    app.update(Msg::DiffFile(next, Ok(parse(readme_file(2)))));
    assert!(app.revealed.is_empty());
    // And the task changed: dropped too.
    let mut app = review_app(no_accept_facts());
    to_line(&mut app, 7);
    let ask = context_ask(&app.key(key('E')));
    app.key(code(KeyCode::Esc));
    app.tab = Tab::Live;
    app.key(key('k'));
    app.update(Msg::Context(ask.clone(), Ok(answer(&ask, 0))));
    assert!(app.revealed.is_empty());
}

/// Notes stay on this computer: writing them and moving anywhere (lines, hunks, files, tabs, tasks, the mouse) sends
/// nothing, and they are still there afterwards.
#[test]
fn notes_are_kept_and_never_sent_on_navigation() {
    let mut app = review_app(no_accept_facts());
    let mut fx = vec![];
    to_line(&mut app, 3);
    fx.extend(app.key(key('c')));
    type_words(&mut app, "subtotal reads better, keep it");
    fx.extend(app.key(code(KeyCode::Enter)));
    // A note on the second hunk's heading.
    fx.extend(app.key(key(']')));
    fx.extend(app.key(key(']')));
    assert!(matches!(app.rows[app.diff_cursor], Row::Hunk(1)));
    fx.extend(app.key(key('c')));
    type_words(&mut app, "count only real items");
    fx.extend(app.key(code(KeyCode::Enter)));
    // Every way of moving.
    for k in [
        key('j'),
        key('k'),
        key('['),
        key(']'),
        key('n'),
        key('N'),
        key('g'),
        key('G'),
        key('v'),
        key('v'),
        code(KeyCode::PageDown),
        code(KeyCode::PageUp),
        code(KeyCode::Up),
        code(KeyCode::Down),
    ] {
        fx.extend(app.key(k));
    }
    fx.extend(app.mouse(MouseEvent {
        kind: MouseEventKind::ScrollDown,
        column: 60,
        row: 12,
        modifiers: KeyModifiers::NONE,
    }));
    // Another file and back, another tab and back, another task and back.
    let next = file_ask(&app.key(key('}')));
    app.update(Msg::DiffFile(next, Ok(parse(readme_file(2)))));
    fx.extend(app.key(key('c')));
    type_words(&mut app, "mention VAT");
    fx.extend(app.key(code(KeyCode::Enter)));
    fx.extend(app.key(code(KeyCode::Tab)));
    fx.extend(app.key(code(KeyCode::BackTab)));
    app.tab = Tab::Live;
    fx.extend(app.key(key('k')));
    fx.extend(app.key(key('j')));
    assert!(!sends(&fx), "navigation sent something: {fx:?}");
    let notes = app.notes_of("t-done", 2);
    assert_eq!(
        notes.iter().map(|n| n.place()).collect::<Vec<_>>(),
        vec![
            "src/cart.rs line 3",
            "src/cart.rs @@ -20,3 +21,3 @@",
            "README.md @@ -1 +1,2 @@"
        ]
    );
}

/// Send back with notes posts exactly the notes the dialog showed, through the revise act, pinned to the result.
#[test]
fn send_back_posts_exactly_the_notes_shown() {
    let mut app = review_app(no_accept_facts());
    to_line(&mut app, 3);
    app.key(key('c'));
    type_words(&mut app, "subtotal reads better");
    app.key(code(KeyCode::Enter));
    to_line(&mut app, 22);
    app.key(key('c'));
    type_words(&mut app, "count only real items");
    app.key(code(KeyCode::Enter));
    insta::assert_snapshot!("notes_inline", screen(&mut app, 120, 34));
    app.key(key('r'));
    assert!(matches!(app.mode, Mode::SendBack(..)));
    type_words(&mut app, "Otherwise good.");
    insta::assert_snapshot!("notes_panel", screen(&mut app, 120, 34));
    // Enter shows the whole text to be sent; Enter there sends exactly it.
    assert_eq!(app.key(code(KeyCode::Enter)), vec![]);
    assert!(matches!(app.mode, Mode::SendReview { .. }));
    let shown = screen(&mut app, 120, 34);
    insta::assert_snapshot!("send_review", shown);
    let fx = app.key(code(KeyCode::Enter));
    let [Effect::Send {
        acts, task, run, ..
    }] = fx.as_slice()
    else {
        panic!("{fx:?}")
    };
    assert_eq!((task.as_str(), *run), ("t-done", 2));
    let [SendAct { path, fields, .. }] = acts.as_slice() else {
        panic!()
    };
    assert_eq!(path, "/r/2/comment");
    let field = |k: &str| {
        fields
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.clone())
            .unwrap()
    };
    let note = field("note");
    assert_eq!(
        note,
        "Notes on the changes:\n- src/cart.rs line 3 — subtotal reads better\n- src/cart.rs line 22 — count only real items\n\nOtherwise good."
    );
    assert_eq!(
        (field("intent"), field("source")),
        ("revise".into(), "b".repeat(64))
    );
    // Every line posted is on the review drawn, the words for the whole change included.
    for line in note.lines().filter(|l| !l.is_empty()) {
        assert!(shown.contains(line), "posted but not shown: {line}");
    }
    // While it is on its way, nothing else starts (a second Enter, a or r).
    assert!(matches!(app.mode, Mode::Sending(_)));
    for k in [code(KeyCode::Enter), key('a'), key('r')] {
        assert_eq!(app.key(k), vec![]);
    }
    // Kept: the draft is cleared.
    app.update(Msg::Sent {
        task: "t-done".into(),
        run: 2,
        text: note.clone(),
        kept: 0,
        result: Ok(ActOutcome::Done("Sent back.".into())),
    });
    assert!(app.notes_of("t-done", 2).is_empty());
}

/// The batch is pinned like Accept: a result that changes while the dialog is open closes it; a refused send keeps the
/// notes; a diff on screen that isn't the result's sends nothing.
#[test]
fn notes_are_pinned_to_the_result_shown() {
    let with_note = || {
        let mut app = review_app(no_accept_facts());
        to_line(&mut app, 3);
        app.key(key('c'));
        type_words(&mut app, "rename back");
        app.key(code(KeyCode::Enter));
        app
    };
    // Another result arrives while Send back is open.
    let mut app = with_note();
    app.key(key('r'));
    screen(&mut app, 120, 34);
    let mut moved = fake::scenario().steps["t-done"].clone();
    moved["review"] = json!({ "run": 3, "receipt": "c".repeat(64), "source": "b".repeat(64), "accept": no_accept_facts() });
    app.update(Msg::Steps("t-done".into(), Ok(parse(moved))));
    assert_eq!(app.mode, Mode::Normal);
    assert_eq!(app.status.as_ref().unwrap().1, RESULT_CHANGED);
    assert!(!sends(&app.key(code(KeyCode::Enter))));
    // The notes stay with build 2 (they are never sent with build 3).
    assert_eq!(app.notes_of("t-done", 2).len(), 1);
    assert!(app.notes_of("t-done", 3).is_empty());
    // A refused send keeps them.
    let mut app = with_note();
    app.update(Msg::Sent {
        task: "t-done".into(),
        run: 2,
        text: String::new(),
        kept: 0,
        result: Ok(ActOutcome::Refused("No.".into())),
    });
    assert_eq!(app.notes_of("t-done", 2).len(), 1);
    // The diff on screen isn't the pinned build's: nothing is sent.
    let mut app = with_note();
    app.key(key('r'));
    app.key(code(KeyCode::Enter));
    screen(&mut app, 120, 34);
    app.diff.as_mut().unwrap().run = Some(3);
    let fx = app.key(code(KeyCode::Enter));
    assert!(!sends(&fx), "{fx:?}");
    // Too small to show it at all: Enter sends nothing.
    let mut app = with_note();
    app.key(key('r'));
    app.key(code(KeyCode::Enter));
    screen(&mut app, 120, 8);
    assert!(!sends(&app.key(code(KeyCode::Enter))));
    // The review pinned to another receipt than the one waiting never posts (rechecked at Enter).
    let mut app = with_note();
    app.key(key('r'));
    app.key(code(KeyCode::Enter));
    screen(&mut app, 120, 34);
    let Mode::SendReview {
        mut pin,
        typed,
        text,
        scroll,
        seen_end,
    } = app.mode.clone()
    else {
        panic!()
    };
    pin.receipt = "c".repeat(64);
    app.mode = Mode::SendReview {
        pin,
        typed,
        text,
        scroll,
        seen_end,
    };
    // Not the dialog drawn: refused before anything else is looked at.
    assert!(!sends(&app.key(code(KeyCode::Enter))));
    assert_eq!(app.status.as_ref().unwrap().1, toolroll_tui::app::UNDRAWN);
    // Drawn as it is now: the receipt is rechecked at Enter.
    screen(&mut app, 120, 34);
    assert!(!sends(&app.key(code(KeyCode::Enter))));
    assert_eq!(app.status.as_ref().unwrap().1, RESULT_CHANGED);
    // A dialog pinned to another receipt than the one waiting never posts (rechecked at Enter, not only on refresh).
    let mut app = with_note();
    app.key(key('r'));
    screen(&mut app, 120, 34);
    let Mode::SendBack(mut pin, typed) = app.mode.clone() else {
        panic!()
    };
    pin.receipt = "c".repeat(64);
    app.mode = Mode::SendBack(pin, typed);
    assert!(!sends(&app.key(code(KeyCode::Enter))));
    assert_eq!(app.status.as_ref().unwrap().1, RESULT_CHANGED);
    // Plain Accept pinned to another receipt (rechecked at Enter too): nothing is completed.
    let mut app = with_note();
    app.key(key('a'));
    let Mode::ConfirmAccept(mut pin) = app.mode.clone() else {
        panic!()
    };
    pin.receipt = "c".repeat(64);
    app.mode = Mode::ConfirmAccept(pin);
    screen(&mut app, 120, 34);
    assert!(!sends(&app.key(code(KeyCode::Enter))));
    assert_eq!(app.status.as_ref().unwrap().1, RESULT_CHANGED);
    // The notes behind the review changed after it was made: what was shown is no longer what would go, so nothing goes.
    let mut app = with_note();
    app.key(key('r'));
    app.key(code(KeyCode::Enter));
    screen(&mut app, 120, 34);
    app.drafts.get_mut(&("t-done".to_string(), 2)).unwrap()[0].text = "something else".into();
    assert!(!sends(&app.key(code(KeyCode::Enter))));
    assert!(app
        .status
        .as_ref()
        .unwrap()
        .1
        .starts_with("Your notes changed"));
    // Accept with the notes attached while the diff on screen is another build's: nothing is saved or completed.
    let mut app = with_note();
    app.key(key('a'));
    app.key(key('t'));
    screen(&mut app, 120, 34);
    app.diff.as_mut().unwrap().run = Some(3);
    let fx = app.key(code(KeyCode::Enter));
    assert!(!sends(&fx), "{fx:?}");
    assert_eq!(app.notes_of("t-done", 2).len(), 1);
}

/// What accepting means, before the dialog and whole in it: files and lines, checks, cost, who else, and the notes.
#[test]
fn owed_facts_before_accept() {
    let needs =
        "Someone else must complete this: it changes protected files and you approved its plan.";
    let mut app = review_app(json!({ "owed": "person-check", "blockers": [], "needs": needs }));
    let shown = screen(&mut app, 120, 34);
    assert!(
        shown.contains("2 files  +3 −2 · Checks passed · $0.42")
            && shown.contains("Someone else must complete")
    );
    to_line(&mut app, 3);
    app.key(key('c'));
    type_words(&mut app, "subtotal reads better");
    app.key(code(KeyCode::Enter));
    assert_eq!(app.key(key('a')), vec![]);
    assert!(matches!(app.mode, Mode::ConfirmAccept(_)));
    insta::assert_snapshot!("owed_facts", screen(&mut app, 120, 34));
    // Enter alone: the plain completion, notes left in the draft.
    let fx = app.key(code(KeyCode::Enter));
    assert!(matches!(fx.as_slice(), [Effect::Act { path, .. }] if path == "/t/t-done/complete"));
    assert_eq!(app.notes_of("t-done", 2).len(), 1);
    // t attaches them: shown whole, then saved on the result before the same completion.
    app.key(key('a'));
    app.key(key('t'));
    let shown = screen(&mut app, 120, 34);
    insta::assert_snapshot!("accept_with_notes", shown);
    let fx = app.key(code(KeyCode::Enter));
    let [Effect::Send { acts, .. }] = fx.as_slice() else {
        panic!("{fx:?}")
    };
    assert_eq!(
        acts.iter().map(|a| a.path.as_str()).collect::<Vec<_>>(),
        vec!["/r/2/comment", "/t/t-done/complete"]
    );
    let note = &acts[0].fields.iter().find(|(k, _)| k == "note").unwrap().1;
    assert_eq!(
        note,
        "Notes on the changes:\n- src/cart.rs line 3 — subtotal reads better"
    );
    assert!(
        acts[0].fields.iter().all(|(k, _)| k != "intent"),
        "a saved note, not a revision"
    );
    assert_eq!(
        acts[1].fields,
        vec![
            ("receipt".into(), "a".repeat(64)),
            ("run".into(), "2".into())
        ]
    );
    for line in note.lines() {
        assert!(shown.contains(line));
    }
}

#[test]
fn copy_hunk_goes_to_the_scrollback() {
    let mut app = review_app(no_accept_facts());
    to_line(&mut app, 22);
    let fx = app.key(key('y'));
    assert_eq!(
        fx,
        vec![Effect::Scrollback(vec![
            "src/cart.rs @@ -20,3 +21,3 @@ impl Cart {".into(),
            "     pub fn count(&self) -> usize {".into(),
            "-        self.items.len()".into(),
            "+        self.items.iter().filter(|i| **i > 0).count()".into(),
            "     }".into(),
        ])]
    );
    assert_eq!(app.mode, Mode::Copied);
    assert_eq!(app.key(key('x')), vec![Effect::ResumeScreen]);
    assert_eq!(app.mode, Mode::Normal);
}

/// A long "whole change" note and many notes: the review wraps every line and scrolls; Enter sends nothing until the
/// end has been drawn, then posts exactly the text drawn.
#[test]
fn send_back_review_is_read_to_the_end_and_posts_what_was_drawn() {
    let mut app = review_app(no_accept_facts());
    for n in [1, 2, 3, 4, 5, 6, 7] {
        to_line(&mut app, n);
        app.key(key('c'));
        type_words(
            &mut app,
            &format!("note {n}: {}", "please look again at this part ".repeat(4)),
        );
        app.key(code(KeyCode::Enter));
    }
    app.key(key('r'));
    let general = format!(
        "{} THE END",
        "This whole change needs another pass. ".repeat(20)
    );
    type_words(&mut app, &general);
    app.key(code(KeyCode::Enter));
    let Mode::SendReview { text, .. } = app.mode.clone() else {
        panic!("{:?}", app.mode)
    };
    // Drawn a screen at a time: Enter is refused before the end, and every wrapped line is drawn on the way.
    let mut drawn = String::new();
    drawn.push_str(&screen(&mut app, 100, 24));
    assert!(
        !sends(&app.key(code(KeyCode::Enter))),
        "sent before the end was shown"
    );
    assert!(app
        .status
        .as_ref()
        .unwrap()
        .1
        .starts_with("Read it to the end first"));
    for _ in 0..40 {
        if matches!(app.mode, Mode::SendReview { seen_end: true, .. }) {
            break;
        }
        app.key(key(' '));
        drawn.push_str(&screen(&mut app, 100, 24));
    }
    assert!(matches!(app.mode, Mode::SendReview { seen_end: true, .. }));
    assert!(drawn.contains("THE END"));
    for part in text.split('\n') {
        for piece in toolroll_tui::text::wrap(part, 92) {
            assert!(drawn.contains(piece.trim_end()), "never drawn: {piece}");
        }
    }
    let fx = app.key(code(KeyCode::Enter));
    let [Effect::Send { acts, .. }] = fx.as_slice() else {
        panic!("{fx:?}")
    };
    let posted = &acts[0].fields.iter().find(|(k, _)| k == "note").unwrap().1;
    assert_eq!(posted, &text);
    assert!(posted.ends_with(&general));
}

/// One request identity per payload: a lost answer is retried under the same identity (the console saves it once); a
/// note saved before a refused completion is never posted again; a second press while saving does nothing.
#[test]
fn accept_with_notes_keeps_one_identity_and_never_saves_twice() {
    let mut app = review_app(no_accept_facts());
    to_line(&mut app, 3);
    app.key(key('c'));
    type_words(&mut app, "subtotal reads better");
    app.key(code(KeyCode::Enter));
    let first = submit_accept(&mut app);
    assert_eq!(first.0.len(), 2);
    // Pressed twice: nothing more.
    assert!(matches!(app.mode, Mode::Sending(_)));
    assert_eq!(app.key(code(KeyCode::Enter)), vec![]);
    assert_eq!(app.key(key('a')), vec![]);
    // The note's answer was lost: the notes stay, and the retry carries the same identity.
    answer(
        &mut app,
        &first.1,
        0,
        Err(ApiError::Unreachable("reset".into())),
    );
    assert_eq!(app.mode, Mode::Normal);
    assert_eq!(app.notes_of("t-done", 2).len(), 1);
    let second = submit_accept(&mut app);
    assert_eq!(second.0.len(), 2);
    assert_eq!(request_of(&second.0), request_of(&first.0));
    // The note saved, the completion refused: a retry only completes.
    answer(
        &mut app,
        &second.1,
        1,
        Ok(ActOutcome::Refused("Not yet.".into())),
    );
    assert!(app
        .status
        .as_ref()
        .unwrap()
        .1
        .starts_with("Your notes are saved on the result"));
    let third = submit_accept(&mut app);
    assert_eq!(paths(&third.0), vec!["/t/t-done/complete"]);
    answer(
        &mut app,
        &third.1,
        0,
        Ok(ActOutcome::Done("Accepted.".into())),
    );
    assert!(app.notes_of("t-done", 2).is_empty() && app.pending.is_empty());
}

/// Identities are kept per payload for the life of the draft: A's note saves and its completion is refused; the notes
/// are edited to B and B is submitted; edited back to A, A's retry only completes (its note is never saved again),
/// and B, submitted again, reuses B's identity.
#[test]
fn identities_are_kept_per_payload() {
    let mut app = review_app(no_accept_facts());
    to_line(&mut app, 3);
    app.key(key('c'));
    type_words(&mut app, "A");
    app.key(code(KeyCode::Enter));
    let a = submit_accept(&mut app);
    answer(
        &mut app,
        &a.1,
        1,
        Ok(ActOutcome::Refused("Not yet.".into())),
    );
    // Edit the note to B and submit B: a new identity, its own note.
    to_line(&mut app, 3);
    app.key(key('c'));
    app.key(code(KeyCode::Backspace));
    type_words(&mut app, "B");
    app.key(code(KeyCode::Enter));
    let b = submit_accept(&mut app);
    assert_eq!(paths(&b.0), vec!["/r/2/comment", "/t/t-done/complete"]);
    assert_ne!(request_of(&b.0), request_of(&a.0));
    answer(
        &mut app,
        &b.1,
        0,
        Err(ApiError::Unreachable("reset".into())),
    );
    // Back to A: A's note was saved, so only the completion goes.
    to_line(&mut app, 3);
    app.key(key('c'));
    app.key(code(KeyCode::Backspace));
    type_words(&mut app, "A");
    app.key(code(KeyCode::Enter));
    let again = submit_accept(&mut app);
    assert_eq!(again.1, a.1);
    assert_eq!(
        paths(&again.0),
        vec!["/t/t-done/complete"],
        "A's note would be saved twice"
    );
    answer(
        &mut app,
        &again.1,
        0,
        Ok(ActOutcome::Refused("Not yet.".into())),
    );
    // And to B again: B's identity, reused (its note may have saved before its answer was lost).
    to_line(&mut app, 3);
    app.key(key('c'));
    app.key(code(KeyCode::Backspace));
    type_words(&mut app, "B");
    app.key(code(KeyCode::Enter));
    let b2 = submit_accept(&mut app);
    assert_eq!(request_of(&b2.0), request_of(&b.0));
}

/// Words alone, no notes on lines: the same review, read to its end, then exactly that text, under a kept identity.
#[test]
fn send_back_with_words_only_is_reviewed_to_the_end() {
    let mut app = review_app(no_accept_facts());
    app.key(key('r'));
    let words = format!(
        "{} THE END",
        "Keep the old column order and say why in the summary. ".repeat(30)
    );
    type_words(&mut app, &words);
    app.key(code(KeyCode::Enter));
    let Mode::SendReview { text, .. } = app.mode.clone() else {
        panic!("{:?}", app.mode)
    };
    assert_eq!(text, words.trim());
    screen(&mut app, 100, 24);
    assert!(
        !sends(&app.key(code(KeyCode::Enter))),
        "sent before the end was shown"
    );
    let mut drawn = String::new();
    for _ in 0..40 {
        if matches!(app.mode, Mode::SendReview { seen_end: true, .. }) {
            break;
        }
        app.key(key(' '));
        drawn.push_str(&screen(&mut app, 100, 24));
    }
    assert!(drawn.contains("THE END"));
    let fx = app.key(code(KeyCode::Enter));
    let [Effect::Send {
        acts,
        text: payload,
        ..
    }] = fx.as_slice()
    else {
        panic!("{fx:?}")
    };
    assert_eq!(payload, &text);
    assert_eq!(
        &acts[0].fields.iter().find(|(k, _)| k == "note").unwrap().1,
        &text
    );
    let first = request_of(acts);
    // Its answer lost: sent again, the same identity (the console replays the revision it already filed).
    answer(
        &mut app,
        &text,
        0,
        Err(ApiError::Unreachable("reset".into())),
    );
    app.key(key('r'));
    type_words(&mut app, &words);
    app.key(code(KeyCode::Enter));
    for _ in 0..40 {
        if matches!(app.mode, Mode::SendReview { seen_end: true, .. }) {
            break;
        }
        app.key(key(' '));
        screen(&mut app, 100, 24);
    }
    let fx = app.key(code(KeyCode::Enter));
    let [Effect::Send { acts, .. }] = fx.as_slice() else {
        panic!("{fx:?}")
    };
    assert_eq!(request_of(acts), first);
}

fn submit_accept(app: &mut App) -> (Vec<SendAct>, String) {
    app.key(key('a'));
    screen(app, 120, 34);
    app.key(key('t'));
    screen(app, 120, 34);
    let fx = app.key(code(KeyCode::Enter));
    let [Effect::Send { acts, text, .. }] = fx.as_slice() else {
        panic!("{fx:?} {:?}", app.status)
    };
    (acts.clone(), text.clone())
}

fn answer(app: &mut App, text: &str, kept: usize, result: Result<ActOutcome, ApiError>) {
    app.update(Msg::Sent {
        task: "t-done".into(),
        run: 2,
        text: text.into(),
        kept,
        result,
    });
}

fn request_of(acts: &[SendAct]) -> Option<String> {
    acts[0]
        .fields
        .iter()
        .find(|(k, _)| k == "request")
        .map(|(_, v)| v.clone())
}

fn paths(acts: &[SendAct]) -> Vec<&str> {
    acts.iter().map(|a| a.path.as_str()).collect()
}

/// The Diff tab follows the look like every other screen: at 256 colours, light or dark or high contrast, code takes
/// its theme role (never a meaning colour); with ASCII glyphs every mark it draws is ASCII.
#[test]
fn diff_view_follows_the_theme_and_glyphs() {
    use toolroll_tui::theme::{Depth, Glyphs, Theme, ThemeName};
    toolroll_tui::syntax::load_now();
    for name in [ThemeName::Light, ThemeName::Dark, ThemeName::HighContrast] {
        let mut app = review_app(no_accept_facts());
        app.prefs.theme = Theme::build(name, Depth::Ansi256, None, &[]).0;
        let meaning = [
            app.prefs.theme.running().fg,
            app.prefs.theme.passed().fg,
            app.prefs.theme.failed().fg,
        ];
        // Tall enough for the whole file above the decision row.
        screen(&mut app, 120, 40);
        assert!(app
            .highlights
            .as_ref()
            .unwrap()
            .wait(std::time::Duration::from_secs(10)));
        let term = draw(&mut app, 120, 40);
        let code_rows: Vec<_> = (9..36u16)
            .flat_map(|y| (50..119u16).map(move |x| (x, y)))
            .map(|p| term.backend().buffer()[p].fg)
            .collect();
        // Strings in the code accent (an indexed colour at 256), and never a meaning colour.
        let accent = app.prefs.theme.code(toolroll_tui::syntax::Token::Text).fg;
        assert!(
            matches!(accent, Some(Color::Indexed(_))),
            "{name:?} {accent:?}"
        );
        assert!(!meaning.contains(&accent), "{name:?}");
        assert!(
            code_rows.contains(&accent.unwrap()),
            "{name:?}: no string drawn in the accent"
        );
    }
    let mut app = review_app(no_accept_facts());
    app.prefs.settings.glyphs = Glyphs::Ascii;
    to_line(&mut app, 3);
    app.key(key('c'));
    type_words(&mut app, "subtotal reads better");
    app.key(code(KeyCode::Enter));
    let shown = screen(&mut app, 120, 34);
    assert!(shown.is_ascii(), "{shown}");
    assert!(
        shown.contains("> src/cart.rs") && shown.contains("~ 13 hidden lines"),
        "{shown}"
    );
}
