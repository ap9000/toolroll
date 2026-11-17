//! The restyle road end to end with the real binary: a workbench runs in a real pseudo-terminal against the fake
//! console, with a home of its own; the same command the console runs for the lead's toolroll_view_set (`toolroll-tui
//! view set`, a change on standard input) writes tui.toml; the running workbench repaints with the new theme and says so
//! within about a second, without a key.
#![cfg(unix)]
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use toolroll_fake_engine as fake;

const BIN: &str = env!("CARGO_BIN_EXE_toolroll-tui");

#[test]
fn a_change_through_view_set_repaints_a_running_workbench_within_a_second() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let engine = rt.block_on(fake::FakeEngine::start(fake::scenario(), 0));
    let home = std::fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!("tr-view-pty-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    let config = home.join(".config/toolroll");
    std::fs::create_dir_all(&config).unwrap();
    for dir in [home.clone(), home.join(".config"), config.clone()] {
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    std::fs::write(config.join("tui.toml"), "theme = \"dark\"\n").unwrap();
    std::fs::set_permissions(
        config.join("tui.toml"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let link_file = home.join("link");
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&link_file)
            .unwrap();
        writeln!(f, "{}", engine.link()).unwrap();
    }
    let pty = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 140,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut c = CommandBuilder::new("/bin/sh");
    c.args(["-c", "exec \"$0\" \"$@\" 3<\"$TR_LINK_FILE\""]);
    c.arg(BIN);
    c.env_clear();
    c.env("PATH", "/usr/bin:/bin");
    c.env("TERM", "xterm-256color");
    c.env("HOME", &home);
    c.env("COLORTERM", "truecolor");
    c.env("TR_LINK_FILE", &link_file);
    let mut child = pty.slave.spawn_command(c).unwrap();
    drop(pty.slave);
    let mut reader = pty.master.try_clone_reader().unwrap();
    let mut writer = pty.master.take_writer().unwrap();
    let screen = Arc::new(Mutex::new(vt100::Parser::new(30, 140, 0)));
    let s2 = screen.clone();
    let _reading = std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            s2.lock().unwrap().process(&buf[..n]);
        }
    });
    let wait_for = |what: &str, secs: u64| -> Duration {
        let start = Instant::now();
        loop {
            let shown = screen.lock().unwrap().screen().contents();
            if shown.contains(what) {
                return start.elapsed();
            }
            assert!(
                start.elapsed() < Duration::from_secs(secs),
                "the screen never showed {what:?}:\n{shown}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    };
    wait_for("Add CSV export", 15);
    // The ground colour drawn now (the dark theme's), to see it change.
    let ground = |s: &vt100::Screen| s.cell(1, 0).map(|c| c.bgcolor());
    let before = ground(screen.lock().unwrap().screen());
    // The console's own road for the lead's toolroll_view_set: the binary's `view set`, a change on standard input.
    let mut set = std::process::Command::new(BIN)
        .args(["view", "set"])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    set.stdin
        .take()
        .unwrap()
        .write_all(br##"{"save_theme":{"name":"sumi","base":"light","colors":{"paper":"#f4efe4","ground":"#e9e2d3"},"use":true}}"##)
        .unwrap();
    let out = set.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    let took = wait_for("Your workbench settings changed: theme dark → sumi", 5);
    assert!(
        took < Duration::from_millis(1600),
        "repainted after {took:?}, not within about a second"
    );
    let after = ground(screen.lock().unwrap().screen());
    assert_ne!(before, after, "the colours on screen didn't change");
    writer.write_all(b"q").unwrap();
    writer.flush().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() > deadline {
            let _ = child.kill();
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = std::fs::remove_dir_all(&home);
}
