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
    let alike = view_cli::set(
        &env,
        r##"{"colors":{"running":"#d9534f","failed":"#d9534f"}}"##,
    )
    .unwrap_err();
    assert!(alike.contains("look alike"), "{alike}");
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
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "kept = true\n");
    let _ = std::fs::remove_dir_all(&h);
    // A folder above it others can change: refused.
    let h = home("ancestor");
    write_file(&h, "theme = \"dark\"\n");
    std::fs::set_permissions(h.join(".config"), std::fs::Permissions::from_mode(0o777)).unwrap();
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
    write_file(&h, "# mine\ntheme = \"dark\"\n");
    let env = env_of(&h);
    view_cli::set(&env, SUMI).unwrap();
    let before = std::fs::read_to_string(file(&h)).unwrap();
    let said = view_cli::reset(&env).unwrap();
    assert!(said.contains("tui.toml.bak"), "{said}");
    assert_eq!(
        std::fs::read_to_string(file(&h)).unwrap(),
        settings::FRESH_HEAD
    );
    let bak = h.join(".config/toolroll/tui.toml.bak");
    assert_eq!(std::fs::read_to_string(&bak).unwrap(), before);
    assert_eq!(
        std::fs::metadata(&bak).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let (s, w) = settings::parse(&std::fs::read_to_string(file(&h)).unwrap());
    assert!(w.is_empty() && s.theme == ThemeName::Terminal);
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
