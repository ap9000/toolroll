use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};

struct Fixture {
    _temp: tempfile::TempDir,
    home: PathBuf,
    entries: PathBuf,
    anchor: ReadAnchor,
}
fn private(path: &Path) {
    std::fs::create_dir(path).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}
impl Fixture {
    fn new() -> Self {
        // TMPDIR is isolated by the invoking command; never discover an OS account/home.
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("captured-home");
        private(&home);
        let registry = home.join(".toolroll-central");
        private(&registry);
        let entries = registry.join("expectations");
        private(&entries);
        let parent = File::open(temp.path()).unwrap();
        let file = File::open(&home).unwrap();
        let uid = metadata(&file).unwrap().uid();
        let anchor = ReadAnchor {
            root: NamedDir {
                parent,
                name: CString::new("captured-home").unwrap(),
                file,
            },
            uid,
        };
        anchor.root.recheck(uid).unwrap();
        Self {
            _temp: temp,
            home,
            entries,
            anchor,
        }
    }
    fn record(&self) -> PathBuf {
        self.entries.join(format!("{}.json", "ab".repeat(32)))
    }
    fn write(&self, data: &[u8]) {
        std::fs::write(self.record(), data).unwrap();
        std::fs::set_permissions(self.record(), std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn read(&self) -> Result<Observation, Failure> {
        self.anchor.observe_expectation([0xab; 32])
    }
}
#[test]
fn bounded_bytes_and_redaction() {
    let f = Fixture::new();
    f.write(&vec![b'x'; LIMIT]);
    assert_eq!(f.read(), Ok(Observation::Bytes("x".repeat(LIMIT))));
    assert_eq!(format!("{:?}", f.read()), "Ok(Bytes([redacted]))");
    f.write(&vec![b'x'; LIMIT + 1]);
    assert_eq!(f.read(), Err(Failure::Oversize));
    f.write(&[0xff]);
    assert_eq!(f.read(), Err(Failure::InvalidUtf8));
}
#[test]
fn absence_and_parent_absence_do_not_create() {
    let f = Fixture::new();
    assert_eq!(f.read(), Ok(Observation::Absent));
    std::fs::remove_dir(&f.entries).unwrap();
    assert_eq!(f.read(), Ok(Observation::Absent));
    std::fs::remove_dir(f.home.join(".toolroll-central")).unwrap();
    assert_eq!(f.read(), Ok(Observation::Absent));
    assert!(!f.home.join(".toolroll-central").exists());
}
#[test]
fn unsafe_files_modes_and_hardlinks() {
    let f = Fixture::new();
    f.write(b"record");
    std::fs::set_permissions(f.record(), std::fs::Permissions::from_mode(0o640)).unwrap();
    assert_eq!(f.read(), Err(Failure::Unsafe));
    f.write(b"record");
    std::fs::hard_link(f.record(), f.entries.join("other")).unwrap();
    assert_eq!(f.read(), Err(Failure::Unsafe));
    std::fs::remove_file(f.record()).unwrap();
    symlink("missing", f.record()).unwrap();
    assert_eq!(f.read(), Err(Failure::Unsafe));
    std::fs::remove_file(f.record()).unwrap();
    let name = CString::new(f.record().as_os_str().as_encoded_bytes()).unwrap();
    // SAFETY: fixture-owned new path, mode_t constant, no real user paths.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert_eq!(f.read(), Err(Failure::Unsafe));
    std::fs::remove_file(f.record()).unwrap();
    // Run only this fixture creator in a child cwd: the generated 69-byte leaf
    // fits sockaddr_un; absolute isolated evidence paths exceed Darwin SUN_LEN.
    let status = std::process::Command::new("/usr/bin/python3")
        .env_clear()
        .env("HOME", &f.home)
        .env("XDG_CONFIG_HOME", f.home.join("config"))
        .env("XDG_STATE_HOME", f.home.join("state"))
        .env("TMPDIR", &f.home)
        .env("PATH", "/usr/bin:/bin")
        .current_dir(&f.entries)
        .args([
            "-I",
            "-c",
            "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])",
        ])
        .arg(f.record().file_name().unwrap())
        .status()
        .unwrap();
    assert!(status.success());
    assert!(f.read().is_err());
}
#[test]
fn symlink_and_nondirectory_parents_refuse() {
    let f = Fixture::new();
    std::fs::remove_dir(&f.entries).unwrap();
    symlink("missing", &f.entries).unwrap();
    assert!(f.read().is_err());
    std::fs::remove_file(&f.entries).unwrap();
    std::fs::write(&f.entries, b"not a directory").unwrap();
    assert_eq!(f.read(), Err(Failure::Unsafe));
}
#[test]
fn exact_parent_swap_and_detached_home_fail() {
    for stage in [Stage::ParentsOpened, Stage::FileOpened, Stage::BeforeReturn] {
        let f = Fixture::new();
        f.write(b"record");
        let mut changed = false;
        let out = f.anchor.observe([0xab; 32], |at| {
            if at == stage && !changed {
                changed = true;
                std::fs::rename(&f.entries, f.home.join("detached")).unwrap();
                private(&f.entries);
            }
        });
        assert_eq!(out, Err(Failure::Changed));
    }
    let f = Fixture::new();
    f.write(b"record");
    let out = f.anchor.observe([0xab; 32], |at| {
        if at == Stage::BeforeReturn {
            std::fs::rename(&f.home, f.home.with_extension("detached")).unwrap();
            private(&f.home);
        }
    });
    assert_eq!(out, Err(Failure::Changed));
}
#[test]
fn final_record_replacement_and_content_change_fail() {
    for replace in [true, false] {
        let f = Fixture::new();
        f.write(b"record");
        let out = f.anchor.observe([0xab; 32], |at| {
            if at == Stage::BeforeReturn {
                if replace {
                    std::fs::rename(f.record(), f.entries.join("old")).unwrap();
                }
                f.write(b"changed record");
            }
        });
        assert_eq!(out, Err(Failure::Changed));
    }
}
#[test]
fn appeared_after_missing_is_changed() {
    let f = Fixture::new();
    let out = f.anchor.observe([0xab; 32], |at| {
        if at == Stage::BeforeReturn {
            f.write(b"new");
        }
    });
    assert_eq!(out, Err(Failure::Changed));
    std::fs::remove_file(f.record()).unwrap();
    std::fs::remove_dir(&f.entries).unwrap();
    let out = f.anchor.observe([0xab; 32], |at| {
        if at == Stage::BeforeReturn {
            private(&f.entries);
        }
    });
    assert_eq!(out, Err(Failure::Changed));
}
#[test]
fn mode_change_and_wrong_captured_uid_refuse() {
    let mut f = Fixture::new();
    f.anchor.uid = f.anchor.uid.wrapping_add(1);
    assert_eq!(f.read(), Err(Failure::Unsafe));
    f.anchor.uid = metadata(&f.anchor.root.file).unwrap().uid();
    std::fs::set_permissions(&f.entries, std::fs::Permissions::from_mode(0o770)).unwrap();
    assert_eq!(f.read(), Err(Failure::Unsafe));
}
#[test]
fn descriptors_are_close_on_exec() {
    let f = Fixture::new();
    let d = open_dir(&f.anchor.root.file, ".toolroll-central", f.anchor.uid)
        .unwrap()
        .unwrap();
    // SAFETY: live descriptor, F_GETFD has no pointer parameter.
    assert_ne!(
        unsafe { libc::fcntl(d.file.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
        0
    );
}
#[cfg(target_os = "macos")]
#[test]
fn native_acl_allow_is_refused() {
    // Each case has a fresh file. Later cases mutate only after the initial
    // descriptor policy check, proving the complete policy runs again.
    for stage in [None, Some(Stage::FileOpened), Some(Stage::BeforeReturn)] {
        let f = Fixture::new();
        f.write(b"record");
        let add_allow = || {
            let status = std::process::Command::new("/bin/chmod")
                .env_clear()
                .env("HOME", &f.home)
                .env("XDG_CONFIG_HOME", f.home.join("config"))
                .env("XDG_STATE_HOME", f.home.join("state"))
                .env("TMPDIR", &f.home)
                .env("PATH", "/usr/bin:/bin")
                .args(["+a", "everyone allow read"])
                .arg(f.record())
                .status()
                .unwrap();
            assert!(status.success());
        };
        if stage.is_none() {
            add_allow();
        }
        let out = f.anchor.observe([0xab; 32], |at| {
            if stage == Some(at) {
                add_allow();
            }
        });
        assert_eq!(out, Err(Failure::Unsafe));
    }
}

#[test]
fn growth_after_open_and_permission_denial_are_not_absence() {
    let f = Fixture::new();
    f.write(b"record");
    let out = f.anchor.observe([0xab; 32], |at| {
        if at == Stage::FileOpened {
            f.write(&vec![b'x'; LIMIT + 1]);
        }
    });
    assert_eq!(out, Err(Failure::Oversize));
    f.write(b"record");
    std::fs::set_permissions(f.record(), std::fs::Permissions::from_mode(0o000)).unwrap();
    assert_eq!(f.read(), Err(Failure::Denied));
}
