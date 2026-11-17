//! "Ask the agent to restyle my workbench": `toolroll-tui view read | set | reset` (view_cli.rs) through the Settings
//! screen's own writer, saved themes in tui.toml, and a running workbench reading the file again within a second.
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use toolroll_tui::app::{App, Msg, Tone, SETTINGS_EVERY};
use toolroll_tui::settings::{self, Env, Prefs};
use toolroll_tui::theme::{Role, ThemeName};
use toolroll_tui::view_cli;

/// A home of its own (0700, under the system's temp folder): tui.toml goes in its .config/toolroll.
fn home(tag: &str) -> PathBuf {
    let base = std::fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!("tr-view-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
    base
}
fn env_of(home: &Path) -> Env {
    Env {
        home: Some(home.to_path_buf()),
        xdg_config_home: None,
        xdg_state_home: None,
        no_color: false,
        colorterm: None,
        term: None,
        tmux: false,
        tmux_pane: None,
        vte: false,
        ssh: false,
    }
}
fn file(home: &Path) -> PathBuf {
    home.join(".config/toolroll/tui.toml")
}
fn write_file(home: &Path, text: &str) {
    let path = file(home);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    for dir in [home.join(".config"), home.join(".config/toolroll")] {
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    std::fs::write(&path, text).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
}

const SUMI: &str = r##"{"save_theme":{"name":"sumi","base":"dark","colors":{"paper":"#1b1a17","ink":"#ece6d8","muted":"#a39d8f"},"use":true}}"##;

#[test]
fn a_saved_theme_is_written_read_back_and_used() {
    let h = home("save");
    write_file(
        &h,
        "# my own notes\ncolumns = [\"step\", \"age\"]\nsomething-new = 3\n",
    );
    let env = env_of(&h);
    let changed = view_cli::set(&env, SUMI).unwrap();
    assert!(
        changed.contains(&"theme: terminal → sumi".to_string()),
        "{changed:?}"
    );
    let text = std::fs::read_to_string(file(&h)).unwrap();
    // The person's own lines and keys are kept; the theme is a table of data.
    assert!(
        text.contains("# my own notes") && text.contains("something-new = 3"),
        "{text}"
    );
    assert!(
        text.contains("theme = \"sumi\"") && text.contains("[themes.sumi]"),
        "{text}"
    );
    assert_eq!(
        std::fs::metadata(file(&h)).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let (s, _) = settings::parse(&text);
    assert_eq!(s.theme, ThemeName::Dark);
    assert_eq!(s.theme_label.as_deref(), Some("sumi"));
    assert!(s
        .colors
        .iter()
        .any(|(r, c)| *r == Role::Paper && c.hex() == "#1b1a17"));
    // read says it, with the roles and the guide.
    let read = view_cli::read(&env);
    assert_eq!(read["settings"]["theme"], "sumi");
    assert_eq!(read["themes"]["saved"][0]["name"], "sumi");
    assert!(read["guide"]
        .as_str()
        .unwrap()
        .contains("Keys can't be changed here"));
    assert_eq!(read["roles"].as_array().unwrap().len(), Role::ALL.len());
    // Switching back by name, and to it again.
    view_cli::set(&env, r#"{"theme":"light"}"#).unwrap();
    view_cli::set(&env, r#"{"theme":"sumi"}"#).unwrap();
    let (s, _) = settings::parse(&std::fs::read_to_string(file(&h)).unwrap());
    assert_eq!(s.theme_label.as_deref(), Some("sumi"));
    let _ = std::fs::remove_dir_all(&h);
}

#[test]
fn keys_contrast_and_unknown_settings_are_refused_and_nothing_is_written() {
    let h = home("refuse");
    write_file(&h, "theme = \"dark\"\n");
    let env = env_of(&h);
    let before = std::fs::read_to_string(file(&h)).unwrap();
    let keys = view_cli::set(&env, r#"{"keys":{"accept":"x"}}"#).unwrap_err();
    assert!(keys.contains("Keys can't be changed here"), "{keys}");
    let faint = view_cli::set(&env, r##"{"colors":{"ink":"#202020"}}"##).unwrap_err();
    assert!(faint.contains("too faint"), "{faint}");
    // Statuses are never the agent's to colour (a swap would make failed read as running).
    let swap = view_cli::set(
        &env,
        r##"{"colors":{"running":"#e5484d","failed":"#0090ff"}}"##,
    )
    .unwrap_err();
    assert!(swap.contains("is a status colour"), "{swap}");
    for role in [
        "needs-you",
        "running",
        "passed",
        "failed",
        "running-soft",
        "passed-soft",
        "failed-soft",
    ] {
        let change = format!(r##"{{"colors":{{"{role}":"#808080"}}}}"##);
        assert!(
            view_cli::set(&env, &change)
                .unwrap_err()
                .contains("status colour"),
            "{role}"
        );
        let saved = format!(
            r##"{{"save_theme":{{"name":"x","base":"dark","colors":{{"{role}":"#808080"}}}}}}"##
        );
        assert!(
            view_cli::set(&env, &saved)
                .unwrap_err()
                .contains("status colour"),
            "{role}"
        );
    }
    // The selection the same as the ink drawn on it: the selected row's title would vanish.
    let selection = view_cli::set(&env, r##"{"colors":{"selection":"#ededed"}}"##).unwrap_err();
    assert!(selection.contains("too faint"), "{selection}");

    let theme = view_cli::set(
        &env,
        r##"{"save_theme":{"name":"murk","base":"dark","colors":{"ink":"#111111"},"use":true}}"##,
    )
    .unwrap_err();
    assert!(theme.contains("too faint"), "{theme}");
    for bad in [
        r#"{"save_theme":{"name":"Dark Mode!","base":"dark"}}"#,
        r#"{"save_theme":{"name":"dark","base":"dark"}}"#,
        r#"{"theme":"\u001b]52;c;x"}"#,
        r#"{"bell":false}"#,
        r#"{"colors":{"ink":"red"}}"#,
        "not json",
    ] {
        assert!(view_cli::set(&env, bad).is_err(), "{bad}");
    }
    assert_eq!(std::fs::read_to_string(file(&h)).unwrap(), before);
    let _ = std::fs::remove_dir_all(&h);
}

/// What alerts or shows the person is theirs to turn off: the agent may only turn it on.
#[test]
fn turning_off_what_alerts_or_shows_the_person_is_refused() {
    let h = home("off");
    write_file(&h, "theme = \"dark\"\n[notifications]\nasks = false\n");
    let env = env_of(&h);
    let before = std::fs::read_to_string(file(&h)).unwrap();
    for off in [
        r#"{"notifications":{"asks":false,"failed":false},"key_bar":false}"#,
        r#"{"notifications":{"failed":false}}"#,
        r#"{"notifications":{"finished":false}}"#,
        r#"{"key_bar":false}"#,
        r#"{"show_costs":false}"#,
        r#"{"columns":["agent"]}"#,
        r#"{"theme":"light","key_bar":false}"#,
    ] {
        let why = view_cli::set(&env, off).unwrap_err();
        assert_eq!(
            why.split(" (").next().unwrap().trim_end_matches('.'),
            view_cli::OFF_IS_YOURS.trim_end_matches('.'),
            "{off}: {why}"
        );
    }
    assert_eq!(std::fs::read_to_string(file(&h)).unwrap(), before);
    // On is fine: asks back on, the key bar, costs, reduced motion either way, and a column added.
    view_cli::set(&env, r#"{"notifications":{"asks":true},"key_bar":true,"show_costs":true,"reduced_motion":false}"#).unwrap();
    let (s, w) = settings::parse(&std::fs::read_to_string(file(&h)).unwrap());
    assert!(w.is_empty(), "{w:?}");
    assert!(s.notify.asks && s.key_bar);
    let mut all: Vec<&str> = s.columns.iter().map(|c| c.key()).collect();
    all.push("project");
    all.dedup();
    let change = serde_json::json!({ "columns": all }).to_string();
    view_cli::set(&env, &change).unwrap();
    let _ = std::fs::remove_dir_all(&h);
}

/// At 16 colours a theme's own colours aren't drawn at all (the terminal's palette is), so statuses keep the
/// terminal's blue, green and red whatever the colours say; at 256 the colours are checked as the terminal rounds them.
#[test]
fn sixteen_and_256_colour_terminals_keep_status_meaning() {
    use ratatui::style::Color;
    use toolroll_tui::theme::{Depth, Rgb, Theme};
    let mine = [
        (Role::Paper, Rgb(0x1b, 0x1a, 0x17)),
        (Role::Selection, Rgb(0x30, 0x30, 0x30)),
    ];
    let (t, refused) = Theme::build(ThemeName::Dark, Depth::Ansi16, None, &mine);
    assert!(refused[0].contains("weren't used"), "{refused:?}");
    assert_eq!(t.running().fg, Some(Color::Blue));
    assert_eq!(t.passed().fg, Some(Color::Green));
    assert_eq!(t.failed().fg, Some(Color::Red));
    assert_eq!(t.badge(Role::Failed).bg, None);
    // A muted colour that reads in true colour (3.0 at least) but rounds to a 256-colour grey too close to the paper.
    let (dark, _) = Theme::build(ThemeName::Dark, Depth::TrueColor, None, &[]);
    let paper = match dark.palette.get(Role::Paper) {
        toolroll_tui::theme::Paint::Rgb(c) => c,
        _ => unreachable!(),
    };
    let faint = (0..52u8)
        .flat_map(|r| (0..52u8).flat_map(move |g| (0..52u8).map(move |b| Rgb(r * 5, g * 5, b * 5))))
        .find(|g| g.contrast(paper) >= 3.0 && g.quantized256().contrast(paper.quantized256()) < 3.0)
        .expect("a colour that only fails once quantized");
    let (_, refused) = Theme::build(
        ThemeName::Dark,
        Depth::Ansi256,
        None,
        &[(Role::Muted, faint)],
    );
    assert!(
        refused.iter().any(|r| r.contains("256-colour")),
        "{} {refused:?}",
        faint.hex()
    );
}

#[test]
fn hostile_layouts_are_refused() {
    // tui.toml a link to another file: never written through.
    let h = home("link");
    write_file(&h, "theme = \"dark\"\n");
    let target = h.join("elsewhere.toml");
    std::fs::write(&target, "kept = true\n").unwrap();
    std::fs::remove_file(file(&h)).unwrap();
    symlink(&target, file(&h)).unwrap();
    assert!(view_cli::set(&env_of(&h), r#"{"theme":"light"}"#).is_err());
    assert!(view_cli::reset(&env_of(&h)).is_err());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "kept = true\n");
    let _ = std::fs::remove_dir_all(&h);
    // A folder above it others can change: refused.
    let h = home("ancestor");
    write_file(&h, "theme = \"dark\"\n");
    std::fs::set_permissions(h.join(".config"), std::fs::Permissions::from_mode(0o777)).unwrap();
    assert!(view_cli::reset(&env_of(&h)).is_err());
    let refused = view_cli::set(&env_of(&h), r#"{"theme":"light"}"#).unwrap_err();
    assert!(
        refused.contains("wasn't written") || refused.contains("ignored"),
        "{refused}"
    );
    assert_eq!(
        std::fs::read_to_string(file(&h)).unwrap(),
        "theme = \"dark\"\n"
    );
    std::fs::set_permissions(h.join(".config"), std::fs::Permissions::from_mode(0o700)).unwrap();
    let _ = std::fs::remove_dir_all(&h);
}

#[test]
fn reset_restores_the_defaults_and_keeps_a_backup() {
    let h = home("reset");
    let keys = "# My keys, keep this comment.\n[keys] # personal\npreset = \"vim\" # keep vim\naccept = [\"f2\", \"f3\"]\n# keep the trailing comment\n";
    write_file(
        &h,
        &format!("# mine\ntheme = \"dark\"\n{keys}[colors]\ntext = \"#ffffff\"\n"),
    );
    let env = env_of(&h);
    let before = std::fs::read_to_string(file(&h)).unwrap();
    for _ in 0..2 {
        let said = view_cli::reset(&env).unwrap();
        assert!(said.contains("tui.toml.bak."), "{said}");
        let after = std::fs::read_to_string(file(&h)).unwrap();
        assert_eq!(after, format!("{}{keys}", settings::FRESH_HEAD));
        let (s, warnings) = settings::parse(&after);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(s.theme, ThemeName::Terminal);
        assert_eq!(s.keymap.preset, toolroll_tui::keys::Preset::Vim);
    }
    let backups: Vec<_> = std::fs::read_dir(file(&h).parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("tui.toml.bak.")
        })
        .collect();
    assert_eq!(backups.len(), 2);
    assert!(backups
        .iter()
        .any(|p| std::fs::read_to_string(p).unwrap() == before));
    for bak in backups {
        assert_eq!(
            std::fs::metadata(bak).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let _ = std::fs::remove_dir_all(&h);
}

/// The workbench as it runs: tui.toml read again within a second of a change, said in one line; a bad file keeps the
/// last good settings and says why.
#[test]
fn a_running_workbench_reads_the_file_again_and_says_what_changed() {
    let h = home("live");
    write_file(&h, "theme = \"dark\"\n");
    let env = env_of(&h);
    let mut app = App::new(false, Some("/home/me/proj".into()));
    app.prefs = settings::start(&env);
    let ticks = |app: &mut App| {
        for _ in 0..SETTINGS_EVERY {
            app.update(Msg::Tick);
        }
    };
    ticks(&mut app);
    assert!(app.status.is_none());
    view_cli::set(&env, SUMI).unwrap();
    ticks(&mut app);
    assert_eq!(
        app.status,
        Some((
            Tone::Said,
            "Your workbench settings changed: theme dark → sumi".into()
        ))
    );
    assert_eq!(app.prefs.settings.theme_label.as_deref(), Some("sumi"));
    // A bad file: the last good settings stay, and it says why.
    write_file(&h, "theme = \"dark\"\ndensity = \"huge\"\n");
    ticks(&mut app);
    let (tone, words) = app.status.clone().unwrap();
    assert_eq!(tone, Tone::Refused);
    assert!(
        words.contains("wasn't used, so your settings stay") && words.contains("density"),
        "{words}"
    );
    assert_eq!(app.prefs.settings.theme_label.as_deref(), Some("sumi"));
    let _ = Prefs::default();
    let _ = std::fs::remove_dir_all(&h);
}

/// Every read of tui.toml checks every folder above it, as the writer does: an XDG folder under a folder others can
/// change is refused at start, and on a reload while running (the last good settings stay).
#[test]
fn a_file_under_a_folder_others_can_change_is_refused_at_start_and_on_reload() {
    let h = home("xdg");
    let shared = h.join("shared");
    let xdg = shared.join("cfg");
    std::fs::create_dir_all(xdg.join("toolroll")).unwrap();
    for d in [&shared, &xdg, &xdg.join("toolroll")] {
        std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let path = xdg.join("toolroll/tui.toml");
    std::fs::write(&path, "theme = \"dark\"\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let env = Env {
        xdg_config_home: Some(xdg.clone()),
        ..env_of(&h)
    };
    // Safe: read, at start.
    let mut prefs = settings::start(&env);
    assert_eq!(prefs.settings.theme, ThemeName::Dark);
    // The folder two above made group-writable: someone else could plant a file there.
    std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o770)).unwrap();
    let (s, _, state, warnings) = settings::load(&env);
    assert_eq!(s.theme, ThemeName::Terminal);
    assert!(
        matches!(state, settings::FileState::Ignored(_)),
        "{state:?}"
    );
    assert!(
        warnings[0].contains("can be changed by other people"),
        "{warnings:?}"
    );
    // And while running: a planted change isn't used.
    std::fs::write(&path, "theme = \"light\"\n").unwrap();
    let why = prefs.reload().unwrap_err();
    assert!(
        why.contains("wasn't used") && why.contains("other people"),
        "{why}"
    );
    assert_eq!(prefs.settings.theme, ThemeName::Dark);
    // A folder above it that can't be looked at is refused too, never taken for "no file".
    std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o000)).unwrap();
    let (_, _, state, _) = settings::load(&env);
    assert!(
        matches!(state, settings::FileState::Ignored(_)),
        "{state:?}"
    );
    std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o700)).unwrap();
    let _ = std::fs::remove_dir_all(&h);
}

/// A reload that changes [keys] keeps the running keys and says they take effect next start; the rest is used now.
#[test]
fn a_reload_never_changes_keys_while_running() {
    let h = home("keys");
    write_file(&h, "theme = \"dark\"\n");
    let env = env_of(&h);
    let mut prefs = settings::start(&env);
    let keys = prefs.settings.keymap.clone();
    write_file(&h, "theme = \"light\"\n[keys]\npreset = \"emacs\"\n");
    let said = prefs.reload().unwrap();
    assert!(said.ends_with(settings::KEYS_NEXT_START), "{said}");
    assert!(said.contains("theme"), "{said}");
    assert_eq!(prefs.settings.keymap, keys);
    assert_eq!(prefs.settings.theme, ThemeName::Light);
    // The next start uses them.
    let next = settings::start(&env);
    assert_ne!(next.settings.keymap, keys);
    let _ = std::fs::remove_dir_all(&h);
}

/// A saved theme that colours statuses its own way (an older one with running and failed swapped, badges too): the
/// agent can't switch to it; the person still can (tui.toml), and from there the agent may change other things, or go
/// back to a built-in theme's own statuses.
#[test]
fn a_saved_theme_with_swapped_statuses_is_only_the_persons_to_pick() {
    use toolroll_tui::theme::{Depth, Paint, Theme};
    let (dark, _) = Theme::build(ThemeName::Dark, Depth::TrueColor, None, &[]);
    let hex = |r: Role| match dark.palette.get(r) {
        Paint::Rgb(c) => c.hex(),
        Paint::Terminal => unreachable!(),
    };
    let swapped = format!(
        "theme = \"dark\"\n[themes.swap]\nbase = \"dark\"\nrunning = \"{}\"\nfailed = \"{}\"\nrunning-soft = \"{}\"\nfailed-soft = \"{}\"\n",
        hex(Role::Failed), hex(Role::Running), hex(Role::FailedSoft), hex(Role::RunningSoft)
    );
    let h = home("swap");
    write_file(&h, &swapped);
    let env = env_of(&h);
    // Refused when the change is checked (before anything is written), and again on the text about to be written.
    let checked = view_cli::prepare(&env, r#"{"theme":"swap"}"#)
        .err()
        .unwrap();
    assert_eq!(checked, view_cli::THEME_STATUS);
    let why = view_cli::set(&env, r#"{"theme":"swap"}"#).unwrap_err();
    assert_eq!(why, view_cli::THEME_STATUS);
    assert_eq!(std::fs::read_to_string(file(&h)).unwrap(), swapped);
    // Nor by saving over it and switching (its status lines would stay under the new base): the text about to be
    // written is judged whole, and refused.
    let resaved = view_cli::set(
        &env,
        r#"{"save_theme":{"name":"swap","base":"dark","use":true}}"#,
    )
    .unwrap_err();
    assert_eq!(resaved, view_cli::THEME_STATUS);
    assert_eq!(std::fs::read_to_string(file(&h)).unwrap(), swapped);
    // The person picks it: the screen uses it.
    let theirs = swapped.replacen("theme = \"dark\"", "theme = \"swap\"", 1);
    write_file(&h, &theirs);
    let (s, w) = settings::parse(&theirs);
    assert!(
        w.is_empty() && s.theme_label.as_deref() == Some("swap"),
        "{w:?}"
    );
    // From there: other changes are fine (statuses as they were), and so is going back to dark's own.
    view_cli::set(&env, r#"{"density":"compact"}"#).unwrap();
    view_cli::set(&env, r#"{"theme":"dark"}"#).unwrap();
    let _ = std::fs::remove_dir_all(&h);
}

/// A change is checked against one exact snapshot of tui.toml and written only if the file is still that snapshot
/// (under the writer's lock): a column the person added in between is never removed by a list checked before it.
#[test]
fn a_change_checked_against_an_older_file_is_never_written() {
    let h = home("interleave");
    write_file(&h, "columns = [\"agent\", \"step\"]\n");
    let env = env_of(&h);
    let prepared = view_cli::prepare(&env, r#"{"columns":["agent","step","cost"]}"#).unwrap();
    // Meanwhile the person adds the project column.
    let theirs = "columns = [\"agent\", \"step\", \"project\"]\n";
    write_file(&h, theirs);
    let why = view_cli::apply(&env, prepared).unwrap_err();
    assert_eq!(why, view_cli::CHANGED_MEANWHILE);
    assert_eq!(std::fs::read_to_string(file(&h)).unwrap(), theirs);
    // Asked again, against the file as it is now, the same list would remove it: refused.
    let again = view_cli::set(&env, r#"{"columns":["agent","step","cost"]}"#).unwrap_err();
    assert!(again.contains("the project column"), "{again}");
    // While another writer holds the folder's lock, nothing is written.
    let dir = std::fs::File::open(h.join(".config/toolroll")).unwrap();
    use std::os::fd::AsRawFd;
    assert_eq!(unsafe { libc::flock(dir.as_raw_fd(), libc::LOCK_EX) }, 0);
    let locked = view_cli::set(&env, r#"{"density":"compact"}"#).unwrap_err();
    assert!(locked.contains("being written"), "{locked}");
    drop(dir);
    view_cli::set(&env, r#"{"density":"compact"}"#).unwrap();
    let _ = std::fs::remove_dir_all(&h);
}
