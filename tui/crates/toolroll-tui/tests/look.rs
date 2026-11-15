//! Themes, density, glyphs, the settings screen, the settings file and notifications: each theme and depth drawn with
//! its styles (a letter per style, and what each letter is), and what notifies when the work list changes.
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::style::{Color, Modifier};
use ratatui::Terminal;
use serde_json::Value;
use std::path::{Path, PathBuf};
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, Effect, Mode, Msg};
use toolroll_tui::notify::{self, Reach};
use toolroll_tui::settings::{self, Column, Density, Env, FileState, Prefs, Settings};
use toolroll_tui::theme::{Depth, Glyphs, Rgb, Role, ThemeName};

const NOW: i64 = 1_794_657_852;

fn parse<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).expect("fixture shape")
}

fn prefs(settings: Settings, depth: Depth, background: Option<Rgb>) -> Prefs {
    Prefs::new(
        settings,
        Some(PathBuf::from("/home/me/.config/toolroll/tui.toml")),
        FileState::Missing,
        vec![],
        depth,
        background,
        Reach::default(),
    )
}

/// The scenario's work list read, `select` chosen and its steps and live window read.
fn app_with(work: Value, select: &str, p: Prefs) -> App {
    let state = fake::scenario();
    let mut app = App::new(false, Some("/home/me/shop".into()));
    app.prefs = p;
    app.now = NOW;
    app.update(Msg::Work(Ok(parse(work))));
    if let Some(i) = app.items.iter().position(|i| i.id == select) {
        for _ in 0..i {
            app.key(crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Char('j'),
                crossterm::event::KeyModifiers::NONE,
            ));
        }
    }
    if let Some(steps) = state.steps.get(select) {
        let fx = app.update(Msg::Steps(select.into(), Ok(parse(steps.clone()))));
        for e in fx {
            if let Effect::FetchLive { run, file, .. } = e {
                let records = if file == "main" {
                    state.live.get(&run).map(|(r, _)| r.clone())
                } else {
                    state.sub.get(&run).cloned()
                };
                if let Some(records) = records {
                    let window = serde_json::json!({ "version": 1, "session": { "kind": "run", "id": run, "task": select }, "room": format!("agent:{run}"), "live": true, "file": file,
                        "window": { "ok": true, "records": records, "cursor": "c1", "restarted": false, "earlier": false, "quarantined": 0, "skipped": 0, "more": false } });
                    app.update(Msg::Live(run, file, Ok(parse(window))));
                }
            }
        }
    }
    app
}

fn live_app(p: Prefs) -> App {
    app_with(fake::scenario_work(), "t-live", p)
}

fn draw(app: &mut App, w: u16, h: u16) -> Buffer {
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| toolroll_tui::view::draw(f, app)).unwrap();
    term.backend().buffer().clone()
}

fn text(buf: &Buffer) -> String {
    let mut out = String::new();
    for y in 0..buf.area.height {
        for x in 0..buf.area.width {
            out.push_str(buf[(x, y)].symbol());
        }
        out.push('\n');
    }
    out
}

fn color(c: Color) -> String {
    match c {
        Color::Reset => "terminal".into(),
        Color::Rgb(r, g, b) => format!("#{r:02x}{g:02x}{b:02x}"),
        Color::Indexed(n) => format!("256:{n}"),
        other => format!("{other:?}"),
    }
}

/// The screen, then each cell's style as a letter, then what each letter is.
fn styled(buf: &Buffer) -> String {
    let letters: Vec<char> = ('a'..='z').chain('A'..='Z').chain('0'..='9').collect();
    let mut legend: Vec<String> = vec![];
    let mut map = String::new();
    for y in 0..buf.area.height {
        for x in 0..buf.area.width {
            let c = &buf[(x, y)];
            let mut mods = vec![];
            for (m, name) in [
                (Modifier::BOLD, "bold"),
                (Modifier::DIM, "dim"),
                (Modifier::REVERSED, "reversed"),
                (Modifier::UNDERLINED, "underlined"),
            ] {
                if c.modifier.contains(m) {
                    mods.push(name);
                }
            }
            let key = format!("fg {} bg {} {}", color(c.fg), color(c.bg), mods.join(" "))
                .trim_end()
                .to_string();
            let i = legend.iter().position(|l| *l == key).unwrap_or_else(|| {
                legend.push(key.clone());
                legend.len() - 1
            });
            map.push(letters[i.min(letters.len() - 1)]);
        }
        map.push('\n');
    }
    let legend: Vec<String> = legend
        .iter()
        .enumerate()
        .map(|(i, l)| format!("{} = {l}", letters[i.min(letters.len() - 1)]))
        .collect();
    format!("{}\n{map}\n{}\n", text(buf), legend.join("\n"))
}

/// No amber anywhere, and no colour outside the theme's roles.
fn roles_only(buf: &Buffer, app: &App) {
    let t = app.prefs.theme;
    let allowed: Vec<Color> = Role::ALL
        .iter()
        .flat_map(|r| match t.palette.get(*r) {
            toolroll_tui::theme::Paint::Rgb(c) => {
                vec![Color::Rgb(c.0, c.1, c.2), Color::Indexed(c.ansi256())]
            }
            toolroll_tui::theme::Paint::Terminal => vec![Color::Reset],
        })
        .chain([Color::Reset, Color::Blue, Color::Green, Color::Red])
        .collect();
    for cell in buf.content() {
        assert!(
            allowed.contains(&cell.fg) && allowed.contains(&cell.bg),
            "{:?} on {:?} at {:?}",
            cell.fg,
            cell.bg,
            cell.symbol()
        );
        assert!(!matches!(
            cell.fg,
            Color::Yellow | Color::LightYellow | Color::Rgb(245, 165, 36)
        ));
    }
}

fn themed(name: ThemeName, depth: Depth, bg: Option<Rgb>) -> String {
    let s = Settings {
        theme: name,
        ..Settings::default()
    };
    let mut app = live_app(prefs(s, depth, bg));
    let buf = draw(&mut app, 100, 24);
    roles_only(&buf, &app);
    styled(&buf)
}

#[test]
fn theme_light() {
    insta::assert_snapshot!(themed(ThemeName::Light, Depth::TrueColor, None));
}

#[test]
fn theme_dark() {
    insta::assert_snapshot!(themed(ThemeName::Dark, Depth::TrueColor, None));
}

#[test]
fn theme_high_contrast() {
    insta::assert_snapshot!(themed(ThemeName::HighContrast, Depth::TrueColor, None));
}

#[test]
fn theme_terminal_on_a_light_background() {
    insta::assert_snapshot!(themed(
        ThemeName::Terminal,
        Depth::TrueColor,
        Some(Rgb(255, 255, 255))
    ));
}

#[test]
fn theme_terminal_that_says_nothing_is_dark() {
    insta::assert_snapshot!(themed(ThemeName::Terminal, Depth::TrueColor, None));
}

#[test]
fn colours_256() {
    insta::assert_snapshot!(themed(ThemeName::Dark, Depth::Ansi256, None));
}

#[test]
fn colours_16() {
    insta::assert_snapshot!(themed(ThemeName::Dark, Depth::Ansi16, None));
}

#[test]
fn no_color() {
    let s = Settings {
        theme: ThemeName::Dark,
        ..Settings::default()
    };
    let mut app = live_app(prefs(s, Depth::Off, None));
    let buf = draw(&mut app, 100, 24);
    for cell in buf.content() {
        assert_eq!((cell.fg, cell.bg), (Color::Reset, Color::Reset));
    }
    insta::assert_snapshot!(styled(&buf));
}

#[test]
fn density_compact() {
    let mut app = live_app(prefs(Settings::default(), Depth::TrueColor, None));
    insta::assert_snapshot!(text(&draw(&mut app, 100, 24)));
}

#[test]
fn density_comfortable() {
    let s = Settings {
        density: Density::Comfortable,
        ..Settings::default()
    };
    let mut app = live_app(prefs(s, Depth::TrueColor, None));
    let shown = text(&draw(&mut app, 100, 24));
    insta::assert_snapshot!(shown);
    // Both lines of a row select it.
    let rows: Vec<_> = app
        .areas
        .rows
        .iter()
        .filter(|(_, i)| *i == Some(0))
        .collect();
    assert_eq!(rows.len(), 2);
}

#[test]
fn columns_key_bar_and_costs() {
    let s = Settings {
        columns: vec![Column::Step, Column::Age, Column::Agent, Column::Cost],
        ..Settings::default()
    };
    let mut app = live_app(prefs(s.clone(), Depth::TrueColor, None));
    app.split = s.list_width();
    let shown = text(&draw(&mut app, 140, 24));
    insta::assert_snapshot!(shown);
    // The agent and cost learnt from the open task's steps, in its row.
    let row = shown
        .lines()
        .find(|l| l.contains("◐ Upgrade the test"))
        .unwrap();
    assert!(
        row.contains("claude sonnet") && row.contains("$0.31"),
        "{row}"
    );
    // Costs hidden: nowhere on screen, the column dropped. Key bar off: no keys line.
    let s = Settings {
        columns: vec![Column::Step, Column::Age, Column::Agent, Column::Cost],
        show_costs: false,
        key_bar: false,
        ..Settings::default()
    };
    let mut app = live_app(prefs(s.clone(), Depth::TrueColor, None));
    app.split = s.list_width();
    let shown = text(&draw(&mut app, 140, 24));
    assert!(!shown.contains('$'), "{shown}");
    assert!(!shown.contains("j/k move"));
}

#[test]
fn glyphs_ascii() {
    let s = Settings {
        glyphs: Glyphs::Ascii,
        ..Settings::default()
    };
    let mut app = live_app(prefs(s, Depth::TrueColor, None));
    let buf = draw(&mut app, 100, 24);
    let shown = text(&buf);
    assert!(shown.is_ascii(), "{shown}");
    insta::assert_snapshot!(shown);
    // Every dialog too.
    app.mode = Mode::Help;
    assert!(text(&draw(&mut app, 100, 30)).is_ascii());
    app.mode = Mode::Settings;
    assert!(text(&draw(&mut app, 100, 30)).is_ascii());
}

#[test]
fn glyphs_nerd() {
    let s = Settings {
        glyphs: Glyphs::Nerd,
        ..Settings::default()
    };
    let mut app = live_app(prefs(s, Depth::TrueColor, None));
    let shown = text(&draw(&mut app, 100, 24));
    assert!(shown.contains('\u{f111}') && shown.contains('\u{f110}') && shown.contains('\u{f00c}'));
}

#[test]
fn the_settings_screen_and_t() {
    let s = Settings {
        colors: vec![(Role::Running, Rgb::parse("#3dd68c").unwrap())],
        ..Settings::default()
    };
    let mut p = prefs(s, Depth::TrueColor, None);
    p.file = FileState::Read;
    p.file_warnings = vec!["tui.toml: Line 3: themes isn't a setting, so it was ignored.".into()];
    let mut app = live_app(p);
    let key = |c: char| {
        crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Char(c),
            crossterm::event::KeyModifiers::NONE,
        )
    };
    app.key(key('?'));
    app.key(key('s'));
    assert_eq!(app.mode, Mode::Settings);
    insta::assert_snapshot!("settings_screen", text(&draw(&mut app, 110, 36)));
    // t: the next theme, for the session; the file is never written.
    assert_eq!(app.prefs.theme.name, ThemeName::Terminal);
    assert_eq!(app.key(key('t')), vec![]);
    assert_eq!(app.prefs.theme.name, ThemeName::Light);
    assert_eq!(app.prefs.settings.theme, ThemeName::Terminal);
    assert!(
        text(&draw(&mut app, 110, 36)).contains("light, for this session (the file says terminal)")
    );
    app.key(key('x'));
    assert_eq!(app.mode, Mode::Normal);
}

// ---- the settings file ------------------------------------------------------------------------------------------

/// A throwaway home: HOME and XDG_CONFIG_HOME both point inside it (never the person's own).
struct Home(PathBuf);

impl Home {
    fn new(name: &str) -> Home {
        let dir =
            std::env::temp_dir().join(format!("toolroll-tui-look-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("cfg").join("toolroll")).unwrap();
        Home(dir)
    }
    fn env(&self) -> Env {
        Env {
            home: Some(self.0.clone()),
            xdg_config_home: Some(self.0.join("cfg")),
            ..Env::default()
        }
    }
    fn file(&self) -> PathBuf {
        self.0.join("cfg").join("toolroll").join("tui.toml")
    }
    fn write(&self, text: &str, mode: u32) -> &Path {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(self.file(), text).unwrap();
        std::fs::set_permissions(self.file(), std::fs::Permissions::from_mode(mode)).unwrap();
        &self.0
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn a_private_file_is_read_with_its_warnings() {
    let home = Home::new("ok");
    home.write("theme = \"dark\"\nsparkle = true\n", 0o600);
    let (s, path, file, warnings) = settings::load(&home.env());
    assert_eq!(path, Some(home.file()));
    assert_eq!(file, FileState::Read);
    assert_eq!(s.theme, ThemeName::Dark);
    assert_eq!(
        warnings,
        vec!["tui.toml: Line 2: sparkle isn't a setting, so it was ignored.".to_string()]
    );
}

#[test]
fn no_file_means_the_defaults() {
    let home = Home::new("none");
    let (s, _, file, warnings) = settings::load(&home.env());
    assert_eq!(
        (s, file, warnings),
        (Settings::default(), FileState::Missing, vec![])
    );
}

#[test]
fn an_unsafe_file_is_ignored() {
    use std::os::unix::fs::PermissionsExt;
    // Others can write it.
    let home = Home::new("writable");
    home.write("theme = \"dark\"\n", 0o666);
    let (s, _, file, warnings) = settings::load(&home.env());
    assert_eq!(s, Settings::default());
    assert!(matches!(file, FileState::Ignored(_)));
    assert_eq!(
        warnings,
        vec![
            "tui.toml was ignored: other people can change it (chmod go-w fixes that).".to_string()
        ]
    );
    // A link to a file elsewhere.
    let home = Home::new("link");
    let elsewhere = home.0.join("elsewhere.toml");
    std::fs::write(&elsewhere, "theme = \"dark\"\n").unwrap();
    std::os::unix::fs::symlink(&elsewhere, home.file()).unwrap();
    let (s, _, _, warnings) = settings::load(&home.env());
    assert_eq!(s, Settings::default());
    assert_eq!(
        warnings,
        vec!["tui.toml was ignored: it is a link, not the file itself.".to_string()]
    );
    // A folder, not a file.
    let home = Home::new("dir");
    std::fs::create_dir(home.file()).unwrap();
    let (_, _, file, _) = settings::load(&home.env());
    assert_eq!(file, FileState::Ignored("it isn't a plain file".into()));
    // A folder others can change.
    let home = Home::new("folder");
    home.write("theme = \"dark\"\n", 0o600);
    let dir = home.file().parent().unwrap().to_path_buf();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
    let (s, _, file, _) = settings::load(&home.env());
    assert_eq!(s, Settings::default());
    assert!(matches!(file, FileState::Ignored(_)));
    // Too big.
    let home = Home::new("big");
    home.write(&"# x\n".repeat(20_000), 0o600);
    let (_, _, file, _) = settings::load(&home.env());
    assert_eq!(file, FileState::Ignored("it is larger than 64 KB".into()));
}

#[test]
fn a_refused_colour_is_said_at_start() {
    let home = Home::new("colour");
    home.write("theme = \"dark\"\n[colors]\nrunning = \"#3dd68c\"\n", 0o600);
    let (s, path, file, warnings) = settings::load(&home.env());
    let p = Prefs::new(
        s,
        path,
        file,
        warnings,
        Depth::TrueColor,
        None,
        Reach::default(),
    );
    assert_eq!(
        p.first_warning().unwrap(),
        "Your colour for running (#3dd68c) wasn't used: running and passed would look alike."
    );
}

// ---- notifications ----------------------------------------------------------------------------------------------

fn notes(fx: &[Effect]) -> Vec<String> {
    fx.iter()
        .filter_map(|e| match e {
            Effect::Notify(w) => Some(w.clone()),
            _ => None,
        })
        .collect()
}

/// t-live (row 2) waiting on you with a result.
fn live_asks(work: &mut Value) {
    work["rows"][2]["need"] = work["rows"][1]["need"].clone();
    work["rows"][2]["need"]["id"] = "t-live".into();
    work["rows"][2]["group"] = "review".into();
    work["rows"][2]["chip"] = "Result".into();
    work["rows"][2]["status"]["tone"] = "attention".into();
}

#[test]
fn notifications_fire_once_per_change() {
    let mut app = live_app(Prefs::default());
    let base = fake::scenario_work();
    let mut asks = base.clone();
    live_asks(&mut asks);
    // Asks: once.
    let fx = app.update(Msg::Work(Ok(parse(asks.clone()))));
    assert_eq!(
        notes(&fx),
        vec!["Toolroll: Upgrade the test runner needs you"]
    );
    assert!(notes(&app.update(Msg::Work(Ok(parse(asks.clone()))))).is_empty());
    assert!(notes(&app.update(Msg::Tick)).is_empty());
    // It goes back to work, and asks again a minute later: a new change, so once more.
    app.now += 60;
    assert!(notes(&app.update(Msg::Work(Ok(parse(base.clone()))))).is_empty());
    let fx = app.update(Msg::Work(Ok(parse(asks.clone()))));
    assert_eq!(
        notes(&fx),
        vec!["Toolroll: Upgrade the test runner needs you"]
    );
    // Within the quiet time, changes are gathered into the next one.
    app.now += 1;
    let mut failed = asks.clone();
    failed["rows"][3]["status"]["tone"] = "problem".into();
    assert!(notes(&app.update(Msg::Work(Ok(parse(failed.clone()))))).is_empty());
    app.now += notify::GATHER_SECS;
    let fx = app.update(Msg::Tick);
    assert_eq!(notes(&fx), vec!["Toolroll: Rate-limit middleware failed"]);
    assert!(notes(&app.update(Msg::Tick)).is_empty());
}

#[test]
fn finished_is_off_unless_asked_for() {
    let mut work = fake::scenario_work();
    let mut app = live_app(Prefs::default());
    work["rows"][2]["status"]["tone"] = "done".into();
    work["rows"][2]["group"] = "rest".into();
    work["rows"][2]["age"] = "0m ago".into();
    assert!(notes(&app.update(Msg::Work(Ok(parse(work.clone()))))).is_empty());
    // With finished on.
    let s = Settings {
        notify: settings::Notify {
            asks: true,
            finished: true,
            failed: true,
        },
        ..Settings::default()
    };
    let mut app = live_app(prefs(s, Depth::TrueColor, None));
    assert_eq!(
        notes(&app.update(Msg::Work(Ok(parse(work))))),
        vec!["Toolroll: Upgrade the test runner finished"]
    );
}

#[test]
fn nothing_notifies_when_switched_off_and_nothing_at_start() {
    let s = Settings {
        notify: settings::Notify {
            asks: false,
            finished: false,
            failed: false,
        },
        ..Settings::default()
    };
    let mut app = live_app(prefs(s, Depth::TrueColor, None));
    let mut asks = fake::scenario_work();
    live_asks(&mut asks);
    asks["rows"][3]["status"]["tone"] = "problem".into();
    assert!(notes(&app.update(Msg::Work(Ok(parse(asks.clone()))))).is_empty());
    // The first read only learns what's there: what already waited doesn't notify.
    let mut fresh = App::new(false, None);
    assert!(notes(&fresh.update(Msg::Work(Ok(parse(asks))))).is_empty());
}

#[test]
fn an_agent_authored_title_is_cleaned_and_only_our_bytes_go_out() {
    let mut app = live_app(Prefs::default());
    let mut asks = fake::scenario_work();
    live_asks(&mut asks);
    asks["rows"][2]["title"] =
        "pwn\u{1b}]0;owned\u{7}\u{1b}]52;c;aGk=\u{7}\u{9b}2J; title\u{202e}".into();
    let said = notes(&app.update(Msg::Work(Ok(parse(asks)))));
    assert_eq!(said, vec!["Toolroll: pwn]0owned]52caGk=2J title needs you"]);
    let bytes = notify::sequence(&said[0], Reach::default(), true);
    assert_eq!(
        bytes,
        "\u{1b}]9;Toolroll: pwn]0owned]52caGk=2J title needs you\u{7}\u{7}"
    );
    // Our sequences only: one ESC (OSC 9's), and BEL twice (its end and the bell).
    assert_eq!(bytes.matches('\u{1b}').count(), 1);
    assert_eq!(bytes.matches('\u{7}').count(), 2);
    // The title is our words and a number.
    assert_eq!(notify::title_sequence(2), "\u{1b}]2;(2) Toolroll\u{7}");
}
