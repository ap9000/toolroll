//! Properties (proptest) of the workbench's pure readers and writers: tui.toml (settings.rs), view.json (viewstate.rs)
//! and search (search.rs). 200 cases each; a failure prints its minimal case, and proptest saves the seed that found it
//! under proptest-regressions/ so the next run tries it first.
use proptest::prelude::*;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use toolroll_tui::app::Tab;
use toolroll_tui::panes::Layout;
use toolroll_tui::search::{highlight, matching};
use toolroll_tui::settings::{parse, set_in_toml, Choice};
use toolroll_tui::viewstate::{
    project_key, ListState, Side, View, ViewFile, MAX_PROJECTS, MAX_UNREAD,
};

fn config() -> ProptestConfig {
    // 200 cases; PROPTEST_CASES asks for more (a longer local hunt).
    let cases = std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(200);
    ProptestConfig::with_cases(cases)
}

// ---- tui.toml -----------------------------------------------------------------------------------------------------

/// One line of a tui.toml, and whether a write must leave it exactly as it was (every line but one setting a choice).
#[derive(Debug, Clone)]
struct Written {
    line: String,
    kept: bool,
}

fn kept(line: String) -> Written {
    Written { line, kept: true }
}

/// A trailing comment, or none.
fn trailing() -> impl Strategy<Value = String> {
    prop_oneof![
        Just(String::new()),
        "[a-z ]{0,12}".prop_map(|c| format!("  # note {c}"))
    ]
}

/// A value for a choice's key: one it takes, one it doesn't (a word, a number, a list).
fn choice_value() -> impl Strategy<Value = String> {
    prop_oneof![
        prop::sample::select(vec![
            "\"terminal\"",
            "\"dark\"",
            "\"light\"",
            "\"high-contrast\"",
            "\"compact\"",
            "\"comfortable\"",
            "\"ascii\"",
            "\"nerd\"",
            "\"unicode\"",
            "\"left\"",
            "\"right\"",
            "true",
            "false"
        ])
        .prop_map(str::to_string),
        prop::sample::select(vec!["\"sideways\"", "42", "[\"a\"]", "\"\"", "'dark'"])
            .prop_map(str::to_string),
    ]
}

/// The top of the file: comments, blank lines, keys it doesn't know, the other settings, and choices (maybe dotted).
fn top_line() -> impl Strategy<Value = Written> {
    prop_oneof![
        "[a-zA-Z0-9 =\"'#\\[\\]]{0,24}".prop_map(|c| kept(format!("# {c}"))),
        Just(kept(String::new())),
        ("[a-z]{2,8}", "[a-z0-9]{0,8}").prop_map(|(k, v)| kept(format!("zz-{k} = \"{v}\""))),
        Just(kept("key-bar = false".into())),
        Just(kept("columns = [\"step\", \"age\"]".into())),
        Just(kept("columns = [\n  \"agent\",\n  \"cost\",\n]".into())),
        Just(kept("show-costs = true  # money".into())),
        (
            prop::sample::select(vec![
                "theme",
                "density",
                "glyphs",
                "list-side",
                "list_side",
                "\"theme\"",
                "notifications.asks",
                "notifications.failed"
            ]),
            choice_value(),
            trailing(),
            "[ ]{0,3}"
        )
            .prop_map(|(k, v, c, indent)| Written {
                line: format!("{indent}{k} = {v}{c}"),
                kept: false
            }),
    ]
}

/// A section: its header (spaced or not) and its lines.
fn section() -> impl Strategy<Value = Vec<Written>> {
    let notifications = (
        prop::sample::select(vec![
            "[notifications]",
            "[ notifications ]",
            "[notifications]  # what notifies",
        ]),
        prop::collection::vec(
            prop_oneof![
                (
                    prop::sample::select(vec!["asks", "finished", "failed"]),
                    prop::sample::select(vec!["true", "false", "\"yes\"", "1"]),
                    trailing()
                )
                    .prop_map(|(k, v, c)| Written {
                        line: format!("{k} = {v}{c}"),
                        kept: false
                    }),
                "[a-z ]{0,16}".prop_map(|c| kept(format!("# {c}"))),
                ("[a-z]{2,8}").prop_map(|k| kept(format!("zz-{k} = true"))),
            ],
            0..5,
        ),
    )
        .prop_map(|(h, lines)| std::iter::once(kept(h.to_string())).chain(lines).collect());
    let other = (
        prop::sample::select(vec![
            "[colors]\nrunning = \"#5aa9ff\"",
            "[keys]\npreset = \"vim\"\naccept = \"a\"",
            "[keys]\npalette = [\n  \":\",\n  \"ctrl-k\",\n]",
            "[zz-unknown]\nfoo = 1\ntheme = \"dark\"",
            "[a b]\nasks = false",
        ]),
        prop::collection::vec("[a-z ]{0,12}".prop_map(|c| kept(format!("# {c}"))), 0..2),
    )
        .prop_map(|(block, comments)| {
            block
                .lines()
                .map(|l| kept(l.to_string()))
                .chain(comments)
                .collect()
        });
    prop_oneof![notifications, other]
}

fn toml_file() -> impl Strategy<Value = Vec<Written>> {
    (
        prop::collection::vec(top_line(), 0..10),
        prop::collection::vec(section(), 0..4),
    )
        .prop_map(|(top, sections)| {
            top.into_iter()
                .chain(sections.into_iter().flatten())
                .collect()
        })
}

/// The text of the file, as lines.
fn text_of(lines: &[Written]) -> String {
    let mut s = lines
        .iter()
        .map(|w| w.line.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    s.push('\n');
    s
}

/// Whether `want` appears in `have` in order (other lines between).
fn in_order(want: &[&str], have: &[&str]) -> bool {
    let mut at = 0;
    for line in have {
        if at < want.len() && *line == want[at] {
            at += 1;
        }
    }
    at == want.len()
}

/// Pieces of a broken tui.toml: brackets, quotes, half-written keys and arrays, and escapes that don't read.
fn soup_piece() -> impl Strategy<Value = &'static str> {
    prop::sample::select(vec![
        "[",
        "]",
        "[[x]]",
        "= =",
        "\"",
        "'",
        "theme = ",
        "theme = \"",
        "columns = [",
        "\"step\",",
        "\\u12",
        "theme = \"\\u12\"",
        "theme = \"\\uD800\"",
        "theme = \"\\uzzzz\"",
        "theme = \"\\q\"",
        "\"\\u00e9\"",
        "#",
        "a.b.c = 1",
        "x =",
        "\t",
        "\r",
        "日本",
        "notifications.asks = ",
        "[notifications",
    ])
}

proptest! {
    #![proptest_config(config())]

    /// The Settings screen's writes, any number of them on any file: the file read strictly afterwards has exactly the
    /// settings the screen holds, and every comment, other key and section is kept, in order.
    #[test]
    fn tui_toml_writes_read_back_and_keep_everything_else(file in toml_file(), steps in prop::collection::vec(0..Choice::ALL.len(), 0..9)) {
        let base = text_of(&file);
        let (mut want, _) = parse(&base);
        let mut text = base.clone();
        for at in steps {
            let choice = Choice::ALL[at];
            let value = choice.step(&mut want);
            let (section, key) = choice.place();
            text = set_in_toml(&text, section, key, &value);
        }
        let (got, _) = parse(&text);
        prop_assert_eq!(&got, &want, "file:\n{}", text);
        let kept: Vec<&str> = file.iter().filter(|w| w.kept).flat_map(|w| w.line.lines()).collect();
        let have: Vec<&str> = text.lines().collect();
        prop_assert!(in_order(&kept, &have), "lost a line:\n{}\n---\n{}", base, text);
        for comment in file.iter().filter_map(|w| w.line.find("  # note").map(|at| &w.line[at + 2..])) {
            prop_assert!(text.contains(comment), "lost the comment {:?}:\n{}", comment, text);
        }
    }

    /// Anything at all in the file: reading never panics, and neither does writing any choice into it.
    #[test]
    fn tui_toml_never_panics_on_anything(bytes in prop::collection::vec(any::<u8>(), 0..1500), soup in prop::collection::vec(soup_piece(), 0..30)) {
        for text in [String::from_utf8_lossy(&bytes).into_owned(), soup.join(""), soup.join("\n")] {
            let _ = parse(&text);
            for choice in Choice::ALL {
                let (section, key) = choice.place();
                let _ = parse(&set_in_toml(&text, section, key, "\"dark\""));
            }
        }
    }
}

// ---- view.json ----------------------------------------------------------------------------------------------------

fn safe_id() -> impl Strategy<Value = String> {
    "[A-Za-z0-9._:-]{1,40}"
}

fn view() -> impl Strategy<Value = View> {
    (
        prop::option::of(20u16..=200),
        prop::sample::select(vec![ListState::Full, ListState::Rail, ListState::Hidden]),
        prop::option::of(prop::sample::select(vec![Side::Left, Side::Right])),
        prop::sample::select(Layout::ALL.to_vec()),
        20u16..=80,
        20u16..=80,
        prop::sample::select(Tab::ALL.to_vec()),
        prop::option::of(safe_id()),
        prop::collection::vec(safe_id(), 0..12),
    )
        .prop_map(
            |(list_width, list, side, layout, ratio_x, ratio_y, tab, task, unread)| View {
                list_width,
                list,
                side,
                layout,
                ratio_x,
                ratio_y,
                tab,
                task,
                unread,
            },
        )
}

fn view_file() -> impl Strategy<Value = ViewFile> {
    prop::collection::vec(
        ("[a-z/]{1,20}", view(), 0i64..4_000_000_000),
        0..MAX_PROJECTS,
    )
    .prop_map(|projects| {
        let mut f = ViewFile::default();
        for (identity, v, at) in projects {
            f.projects.insert(project_key(&identity), (v, at));
        }
        f
    })
}

/// A JSON value shaped somewhat like the file, with anything in each place.
fn loose_json() -> impl Strategy<Value = serde_json::Value> {
    let leaf = prop_oneof![
        Just(serde_json::Value::Null),
        any::<bool>().prop_map(serde_json::Value::from),
        any::<i64>().prop_map(serde_json::Value::from),
        any::<f64>()
            .prop_filter("finite", |n| n.is_finite())
            .prop_map(serde_json::Value::from),
        prop::sample::select(vec![
            "full",
            "rail",
            "left",
            "right",
            "grid",
            "diff",
            "t-1",
            "has space",
            "p0123456789abcdef",
            ""
        ])
        .prop_map(serde_json::Value::from),
        ".{0,12}".prop_map(serde_json::Value::from),
    ];
    let keys = prop::sample::select(vec![
        "listWidth",
        "list",
        "side",
        "layout",
        "ratioX",
        "ratioY",
        "tab",
        "task",
        "unread",
        "at",
        "version",
        "projects",
        "p0123456789abcdef",
        "pzzzzzzzzzzzzzzzz",
        "x",
    ]);
    leaf.prop_recursive(4, 64, 8, move |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..8).prop_map(serde_json::Value::from),
            prop::collection::btree_map(keys.clone(), inner, 0..8).prop_map(|m| {
                serde_json::Value::Object(m.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
            }),
        ]
    })
}

/// Everything a read view file holds is in range: a read never hands the workbench a value it can't use.
fn in_range(f: &ViewFile) -> Result<(), TestCaseError> {
    prop_assert!(f.projects.len() <= MAX_PROJECTS);
    let id_ok = |t: &str| {
        !t.is_empty()
            && t.len() <= 128
            && t.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
    };
    for (k, (v, at)) in &f.projects {
        prop_assert!(
            k.len() == 17 && k.starts_with('p') && k[1..].bytes().all(|b| b.is_ascii_hexdigit()),
            "key {}",
            k
        );
        prop_assert!(*at >= 0, "at {}", at);
        prop_assert!(v.list_width.is_none_or(|w| (20..=200).contains(&w)));
        prop_assert!((20..=80).contains(&v.ratio_x) && (20..=80).contains(&v.ratio_y));
        prop_assert!(v.task.as_deref().is_none_or(id_ok));
        prop_assert!(v.unread.len() <= MAX_UNREAD && v.unread.iter().all(|t| id_ok(t)));
    }
    Ok(())
}

proptest! {
    #![proptest_config(config())]

    /// What the workbench writes, it reads back exactly.
    #[test]
    fn view_json_round_trips(f in view_file()) {
        prop_assert_eq!(ViewFile::parse(&f.text()), f);
    }

    /// Any bytes, or any JSON of roughly its shape: never a panic, every value in range (else that key's default), and
    /// reading what it would write back gives the same.
    #[test]
    fn view_json_reads_anything_into_range(bytes in prop::collection::vec(any::<u8>(), 0..2000), shaped in loose_json(), version in prop::sample::select(vec![serde_json::json!(1), serde_json::json!(2), serde_json::json!("1")]), view in loose_json(), at in any::<i64>()) {
        let as_file = serde_json::json!({ "version": version, "projects": shaped.clone() });
        // One project of ours with anything in its view, and any number as when it was last used.
        let mut one = match view { serde_json::Value::Object(m) => m, _ => serde_json::Map::new() };
        one.insert("at".into(), serde_json::json!(at));
        let ours = serde_json::json!({ "version": 1, "projects": { project_key("/home/me/shop"): one } });
        for text in [String::from_utf8_lossy(&bytes).into_owned(), shaped.to_string(), as_file.to_string(), ours.to_string()] {
            let read = ViewFile::parse(&text);
            in_range(&read)?;
            prop_assert_eq!(ViewFile::parse(&read.text()), read);
        }
    }
}

// ---- search -------------------------------------------------------------------------------------------------------

proptest! {
    #![proptest_config(config())]

    /// A line search counts as matching is lit where it is drawn: wide characters (日本), letters whose lower case is
    /// longer (İ) and accents included.
    #[test]
    fn a_matching_line_is_lit_where_it_is_drawn(chars in prop::collection::vec(prop::sample::select(vec!['a', 'B', 'z', '0', ' ', '-', 'é', 'ß', 'İ', '日', '本', 'ｱ', 'Ω']), 1..50), from in any::<prop::sample::Index>(), len in 1usize..8) {
        let line: String = chars.iter().collect();
        let start = from.index(chars.len());
        let query: String = chars[start..(start + len).min(chars.len())].iter().collect();
        prop_assume!(!query.trim().is_empty());
        prop_assert_eq!(matching(std::slice::from_ref(&line), &query), vec![0]);
        let area = Rect::new(0, 0, 120, 1);
        let mut buf = Buffer::empty(area);
        buf.set_string(0, 0, &line, Style::default());
        highlight(&mut buf, area, &query);
        let lit = (0..area.width).filter(|x| buf[(*x, 0)].modifier.contains(Modifier::REVERSED)).count();
        prop_assert!(lit > 0, "{:?} matches {:?}, but nothing is lit", query, line);
    }
}
