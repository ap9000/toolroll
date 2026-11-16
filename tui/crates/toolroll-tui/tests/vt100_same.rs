//! The Terminal tab's emulator is upstream vt100 0.16.2 vendored with faster scrolling (tui/vendor/vt100): rows that
//! scroll are reused, and clearing one touches only the cells written. This checks the copy against upstream on the
//! same bytes, split at the same random places: every cell (text, colours, attributes, wide halves), the cursor, the
//! formatted screen and every scrollback line agree, through scroll regions, inserts and deletes, erases in colour,
//! wide characters, resizes, the alternate screen and resets.
use vt100_upstream as upstream;

/// A small deterministic generator (xorshift), so a failure repeats.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// Terminal output weighted towards what moves rows and cells around.
fn stream(rng: &mut Rng, len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len + 64);
    while out.len() < len {
        let n = rng.below(60) + 1;
        let piece: Vec<u8> = match rng.below(34) {
            0..=5 => b"y\r\n".to_vec(),
            6 => b"\r\n".to_vec(),
            7 => b"\n".to_vec(),
            8 => (0..rng.below(250)).map(|i| b'a' + (i % 26) as u8).collect(),
            9 => "日本語の文字".as_bytes().to_vec(),
            10 => "e\u{301}\u{302}x".as_bytes().to_vec(),
            11 => format!("\x1b[{n}A").into_bytes(),
            12 => format!("\x1b[{n}B").into_bytes(),
            13 => format!("\x1b[{n}C").into_bytes(),
            14 => format!("\x1b[{n}D").into_bytes(),
            15 => format!("\x1b[{};{}H", rng.below(70), rng.below(210)).into_bytes(),
            16 => format!("\x1b[{}J", rng.below(4)).into_bytes(),
            17 => format!("\x1b[{}K", rng.below(3)).into_bytes(),
            18 => format!("\x1b[{n}L").into_bytes(),
            19 => format!("\x1b[{n}M").into_bytes(),
            20 => format!("\x1b[{n}P").into_bytes(),
            21 => format!("\x1b[{n}@").into_bytes(),
            22 => format!("\x1b[{n}X").into_bytes(),
            23 => format!("\x1b[{n}S").into_bytes(),
            24 => format!("\x1b[{n}T").into_bytes(),
            25 => format!("\x1b[{};{}r", rng.below(30), rng.below(70)).into_bytes(),
            26 => b"\x1b[r".to_vec(),
            // Colours and attributes, background ones included (erases then fill with them).
            27 => format!(
                "\x1b[{};{};{}m",
                30 + rng.below(8),
                40 + rng.below(8),
                rng.below(10)
            )
            .into_bytes(),
            28 => format!("\x1b[48;2;{};{};{}m", n, n * 2, n * 3).into_bytes(),
            29 => b"\x1b[0m".to_vec(),
            30 => [b"\x1b7".as_slice(), b"\x1b8", b"\x1bM", b"\x1bD", b"\x1bE"]
                [rng.below(5) as usize]
                .to_vec(),
            31 => [
                b"\x1b[?1049h".as_slice(),
                b"\x1b[?1049l",
                b"\x1b[?6h",
                b"\x1b[?6l",
                b"\x1b[?7l",
                b"\x1b[?7h",
            ][rng.below(6) as usize]
                .to_vec(),
            32 => b"\t\x08\x07".to_vec(),
            _ => {
                if rng.below(40) == 0 {
                    b"\x1bc".to_vec()
                } else {
                    (0..rng.below(16)).map(|_| rng.below(256) as u8).collect()
                }
            }
        };
        out.extend_from_slice(&piece);
    }
    out
}

fn assert_same(ours: &mut vt100::Parser, theirs: &mut upstream::Parser, at: &str) {
    let (a, b) = (ours.screen(), theirs.screen());
    assert_eq!(a.size(), b.size(), "{at}: size");
    assert_eq!(a.cursor_position(), b.cursor_position(), "{at}: cursor");
    assert_eq!(
        a.contents_formatted(),
        b.contents_formatted(),
        "{at}: formatted screen"
    );
    let (rows, cols) = a.size();
    for r in 0..rows {
        for c in 0..cols {
            let (x, y) = (a.cell(r, c).unwrap(), b.cell(r, c).unwrap());
            let mine = (
                x.contents(),
                format!("{:?}/{:?}", x.fgcolor(), x.bgcolor()),
                (x.bold(), x.dim(), x.italic(), x.underline(), x.inverse()),
                (x.is_wide(), x.is_wide_continuation()),
            );
            let upstream = (
                y.contents(),
                format!("{:?}/{:?}", y.fgcolor(), y.bgcolor()),
                (y.bold(), y.dim(), y.italic(), y.underline(), y.inverse()),
                (y.is_wide(), y.is_wide_continuation()),
            );
            assert_eq!(mine, upstream, "{at}: cell {r},{c}");
        }
    }
    // Every scrollback line, as the pane scrolls back through it.
    ours.screen_mut().set_scrollback(usize::MAX);
    theirs.screen_mut().set_scrollback(usize::MAX);
    let most = ours.screen().scrollback();
    assert_eq!(
        most,
        theirs.screen().scrollback(),
        "{at}: scrollback length"
    );
    for back in (1..=most).rev().step_by(7) {
        ours.screen_mut().set_scrollback(back);
        theirs.screen_mut().set_scrollback(back);
        let mine: Vec<Vec<u8>> = ours.screen().rows_formatted(0, cols).collect();
        let upstream: Vec<Vec<u8>> = theirs.screen().rows_formatted(0, cols).collect();
        assert_eq!(mine, upstream, "{at}: scrolled back {back}");
    }
    ours.screen_mut().set_scrollback(0);
    theirs.screen_mut().set_scrollback(0);
}

#[test]
fn the_vendored_emulator_draws_what_upstream_draws() {
    for (seed, rows, cols, scrollback) in [
        (1u64, 24u16, 80u16, 100usize),
        (2, 60, 200, 5000),
        (3, 5, 10, 0),
        (4, 30, 100, 3),
        // (Not one row or one column: upstream itself overflows there, on wrapping and on a wide character.)
        (5, 2, 3, 10),
    ] {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15 ^ seed);
        let mut ours = vt100::Parser::new(rows, cols, scrollback);
        let mut theirs = upstream::Parser::new(rows, cols, scrollback);
        for round in 0..60 {
            let bytes = stream(&mut rng, 6000);
            // The same bytes, split at the same random places (upstream first: a panic there is upstream's own).
            let mut at = 0;
            while at < bytes.len() {
                let end = (at + 1 + rng.below(700) as usize).min(bytes.len());
                theirs.process(&bytes[at..end]);
                ours.process(&bytes[at..end]);
                at = end;
            }
            if round % 9 == 4 {
                let (r, c) = (2 + rng.below(70) as u16, 2 + rng.below(220) as u16);
                ours.screen_mut().set_size(r, c);
                theirs.screen_mut().set_size(r, c);
            }
            assert_same(
                &mut ours,
                &mut theirs,
                &format!("seed {seed} round {round}"),
            );
        }
    }
}

/// Each way a row's cells change, on a fresh line, then that row scrolled away and reused (in a scroll region, and
/// through a full scrollback): a reused row must come back blank, never with a cell of what it held.
#[test]
fn a_reused_row_comes_back_blank_after_every_kind_of_write() {
    let writes: [&[u8]; 12] = [
        b"plain text",
        // Erases in colour, from the far end of a blank row (ECH, EL to the end, EL whole, ED below).
        b"\x1b[44m\x1b[1;70H\x1b[5X\x1b[0m",
        b"\x1b[45m\x1b[1;60H\x1b[0K\x1b[0m",
        b"\x1b[46m\x1b[2K\x1b[0m",
        b"\x1b[41m\x1b[1;75H\x1b[0J\x1b[0m",
        // A wide character at the last column, then the column before it overwritten (its other half cleared).
        "\x1b[1;79H日\x1b[1;79Hx".as_bytes(),
        "\x1b[1;78H日本\x1b[1;80Hz".as_bytes(),
        // Inserts and deletes shifting cells along the row.
        b"abc\x1b[1;1H\x1b[5@",
        b"\x1b[1;70Hxyz\x1b[1;1H\x1b[4P",
        // Erasing a wide character's second half.
        "\x1b[1;50H日\x1b[1;51H\x1b[X".as_bytes(),
        // Background colour filling a scrolled-in line, then text.
        b"\x1b[42m\n\x1b[0mtext",
        b"\x1b[1;80Hq\x1b[1;80H\x1b[43m\x1b[X\x1b[0m",
    ];
    for (i, write) in writes.iter().enumerate() {
        for (rows, scrollback, region) in [
            (6u16, 0usize, true),
            (6, 0, false),
            (6, 3, false),
            (6, 3, true),
        ] {
            let mut ours = vt100::Parser::new(rows, 80, scrollback);
            let mut theirs = upstream::Parser::new(rows, 80, scrollback);
            let mut bytes = Vec::new();
            if region {
                bytes.extend_from_slice(b"\x1b[2;5r");
            }
            // Fill the scrollback first, so the rows it gives back are reused too.
            for n in 0..12 {
                bytes.extend_from_slice(format!("\x1b[{rows};1Hfill {n}\r\n").as_bytes());
            }
            for round in 0..3 {
                bytes.extend_from_slice(format!("\x1b[{};1H", 2 + round).as_bytes());
                bytes.extend_from_slice(write);
                // Scroll it (and the rows around it) away, and back in as blank rows.
                bytes.extend_from_slice(format!("\x1b[{rows};1H").as_bytes());
                bytes.extend_from_slice(&b"\n".repeat(usize::from(rows) + 4));
            }
            ours.process(&bytes);
            theirs.process(&bytes);
            assert_same(
                &mut ours,
                &mut theirs,
                &format!("write {i} rows {rows} scrollback {scrollback} region {region}"),
            );
        }
    }
}

/// One row, one column, or both: upstream 0.16.2 overflows there (a wrap on a one-row screen, a wide character on a
/// one-column one) and, built for release, unwraps a row or cell that doesn't exist. The vendored copy takes the same
/// streams there without a panic, keeps the cursor on the screen, and still draws what fits.
#[test]
fn one_row_or_one_column_screens_take_any_output() {
    for (seed, rows, cols, scrollback) in [
        (11u64, 1u16, 1u16, 0usize),
        (12, 1, 1, 50),
        (13, 1, 80, 0),
        (14, 1, 200, 100),
        (15, 40, 1, 0),
        (16, 60, 1, 100),
    ] {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15 ^ seed);
        let mut ours = vt100::Parser::new(rows, cols, scrollback);
        // The cases upstream fell over on, first, then the random mix.
        ours.process("日本\r\n日\x1b[1;1H日y\r\nwrapping text past the edge 日本".as_bytes());
        for _ in 0..40 {
            let bytes = stream(&mut rng, 4000);
            let mut at = 0;
            while at < bytes.len() {
                let end = (at + 1 + rng.below(300) as usize).min(bytes.len());
                ours.process(&bytes[at..end]);
                at = end;
            }
            let screen = ours.screen();
            let (r, c) = screen.size();
            let (cr, cc) = screen.cursor_position();
            assert!(
                cr < r && cc <= c,
                "seed {seed}: cursor {cr},{cc} on {r}x{c}"
            );
            let _ = screen.contents_formatted();
        }
        // Still draws what fits after all that.
        ours.process(b"\x1b[0m\x1b[r\x1bc\x1b[1;1Hx");
        assert_eq!(
            ours.screen().cell(0, 0).unwrap().contents(),
            "x",
            "seed {seed}"
        );
    }
}

/// The pane never gives the emulator a screen under two rows or two columns, whatever the console or the window says.
#[test]
fn the_pane_keeps_its_emulator_at_least_two_by_two() {
    let mut pane = toolroll_tui::term::Pane::opening("t".into(), 1);
    pane.hello(1, 1, false);
    assert_eq!(pane.parser.screen().size(), (2, 2));
    pane.forget();
    assert_eq!(pane.parser.screen().size(), (2, 2));
    // A one-row or one-column pane on screen asks for no size (the emulator keeps the last).
    let mut pane = toolroll_tui::term::Pane::opening("t".into(), 1);
    pane.hello(100, 30, false);
    pane.drawn = true;
    for (w, h) in [(1, 30), (100, 1), (1, 1)] {
        pane.area = ratatui::layout::Rect::new(0, 0, w, h);
        assert_eq!(pane.wanted_size(), None, "{w}x{h}");
        assert_eq!(pane.parser.screen().size(), (30, 100));
    }
    pane.area = ratatui::layout::Rect::new(0, 0, 2, 2);
    assert_eq!(pane.wanted_size(), Some((2, 2)));
}
