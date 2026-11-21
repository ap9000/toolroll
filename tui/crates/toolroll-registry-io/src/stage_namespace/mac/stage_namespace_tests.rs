use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
struct Fixture {
    _root: tempfile::TempDir,
    home: PathBuf,
    source_dir: PathBuf,
    stage_root: PathBuf,
    anchors: FixtureAnchors,
}
fn private(path: &Path) {
    std::fs::create_dir(path).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}
impl Fixture {
    fn new(mode: u32) -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("captured-home");
        private(&home);
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(mode)).unwrap();
        let source_dir = home.join("fixture-source");
        private(&source_dir);
        let stage_root = home.join("fixture-stages");
        private(&stage_root);
        let file = File::open(&home).unwrap();
        let uid = metadata(&file).unwrap().uid();
        let anchors = FixtureAnchors {
            home: NamedDir {
                parent: File::open(root.path()).unwrap(),
                name: CString::new("captured-home").unwrap(),
                file,
            },
            uid,
        };
        let f = Self {
            _root: root,
            home,
            source_dir,
            stage_root,
            anchors,
        };
        f.write_source(&Self::bytes());
        f
    }
    fn bytes() -> Vec<u8> {
        let mut bytes = vec![0xa5; BUFFER + 23];
        bytes[..16].copy_from_slice(b"SQLite format 3\0");
        bytes[18] = 1;
        bytes[19] = 1;
        bytes
    }
    fn source(&self) -> PathBuf {
        self.source_dir.join("cold.db")
    }
    fn directory(&self) -> PathBuf {
        self.stage_root.join(format!("stage-{}", "11".repeat(16)))
    }
    fn copy(&self) -> PathBuf {
        self.directory().join("stage.db")
    }
    fn write_source(&self, bytes: &[u8]) {
        std::fs::write(self.source(), bytes).unwrap();
        std::fs::set_permissions(self.source(), std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn options(&self) -> Options {
        Options {
            suffix: Some([0x11; 16]),
            ..Options::default()
        }
    }
    fn run(&self) -> Result<CapturedCopySession, Stopped> {
        prepare(&self.anchors, &self.options(), |_| Ok(()))
    }
}
fn stopped(out: Result<CapturedCopySession, Stopped>, phase: Phase) -> Stopped {
    match out {
        Ok(session) => {
            session.close();
            panic!("unexpected completed fixture copy")
        }
        Err(s) => {
            assert_eq!(s.phase, phase);
            s
        }
    }
}
fn acl(f: &Fixture, path: &Path, text: &str) {
    let status = std::process::Command::new("/bin/chmod")
        .env_clear()
        .env("HOME", &f.home)
        .env("XDG_CONFIG_HOME", f.home.join("config"))
        .env("XDG_STATE_HOME", f.home.join("state"))
        .env("TMPDIR", &f.home)
        .env("PATH", "/usr/bin:/bin")
        .args(["+a", text])
        .arg(path)
        .status()
        .unwrap();
    assert!(status.success());
}
#[test]
fn safe_home_modes_copy_binary_and_close_only_descriptors() {
    for mode in [0o700, 0o750, 0o755] {
        let f = Fixture::new(mode);
        let original = std::fs::read(f.source()).unwrap();
        let session = f.run().unwrap();
        assert_eq!(std::fs::read(f.copy()).unwrap(), original);
        assert_ne!(
            metadata(&session.source).unwrap().ino(),
            metadata(&session.copy).unwrap().ino()
        );
        assert_eq!(
            metadata(&session.directory.file).unwrap().mode() & 0o7777,
            0o700
        );
        assert_eq!(metadata(&session.copy).unwrap().mode() & 0o7777, 0o600);
        session.recheck().unwrap();
        session.close();
        assert!(f.copy().exists());
        assert_eq!(std::fs::read(f.source()).unwrap(), original);
    }
    for mode in [0o775, 0o777] {
        let f = Fixture::new(mode);
        let s = stopped(f.run(), Phase::Validate);
        assert_eq!(s.artifacts, Artifacts::NoneObserved);
        assert!(!f.directory().exists());
    }
}
#[test]
fn privacy_refuses_ancestor_and_inherited_acl_before_source_bytes() {
    for target in 0..4 {
        let f = Fixture::new(0o755);
        let path = match target {
            0 => &f.home,
            1 => &f.stage_root,
            2 => &f.source_dir,
            _ => &f.source(),
        };
        acl(
            &f,
            path,
            "everyone allow read,file_inherit,directory_inherit",
        );
        let s = stopped(f.run(), Phase::Validate);
        assert_eq!(s.reason, Failure::Unsafe);
        assert!(!f.directory().exists());
    }
    for point in [
        Point::DirectoryCreated,
        Point::FileCreated,
        Point::BeforeWrite,
    ] {
        let f = Fixture::new(0o755);
        let out = prepare(&f.anchors, &f.options(), |at| {
            if at == point {
                if point == Point::DirectoryCreated {
                    acl(
                        &f,
                        &f.directory(),
                        "everyone allow read,file_inherit,directory_inherit",
                    );
                } else {
                    acl(&f, &f.copy(), "everyone allow read");
                }
            }
            Ok(())
        });
        let s = match out {
            Err(s) => s,
            Ok(s) => {
                s.close();
                panic!("ACL mutation admitted")
            }
        };
        assert_eq!(s.artifacts, Artifacts::NamespaceMayExist);
        if f.copy().exists() {
            assert_eq!(std::fs::metadata(f.copy()).unwrap().len(), 0);
        }
        assert_eq!(std::fs::read(f.source()).unwrap(), Fixture::bytes());
    }
}
#[test]
fn exact_private_modes_source_nodes_and_sidecars_refuse() {
    let f = Fixture::new(0o755);
    std::fs::set_permissions(&f.stage_root, std::fs::Permissions::from_mode(0o755)).unwrap();
    stopped(f.run(), Phase::Validate);
    assert!(!f.directory().exists());
    for kind in 0..5 {
        let f = Fixture::new(0o755);
        match kind {
            0 => std::fs::set_permissions(f.source(), std::fs::Permissions::from_mode(0o640))
                .unwrap(),
            1 => std::fs::hard_link(f.source(), f.source_dir.join("second-link")).unwrap(),
            2 => {
                std::fs::remove_file(f.source()).unwrap();
                symlink("missing", f.source()).unwrap();
            }
            3 => {
                std::fs::remove_file(f.source()).unwrap();
                let c = CString::new(f.source().as_os_str().as_encoded_bytes()).unwrap(); // SAFETY: owned fixture name and private mode.
                assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
            }
            _ => std::fs::write(f.source_dir.join("cold.db-journal"), b"existing sidecar").unwrap(),
        };
        stopped(f.run(), Phase::Validate);
        assert!(!f.directory().exists());
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        let f = Fixture::new(0o755);
        let sidecar = f.directory().join(format!("stage.db{suffix}"));
        let out = prepare(&f.anchors, &f.options(), |at| {
            if at == Point::FileCreated {
                std::fs::write(&sidecar, b"unrelated sidecar").unwrap();
            }
            Ok(())
        });
        stopped(out, Phase::BeforeFirstByte);
        assert_eq!(std::fs::metadata(f.copy()).unwrap().len(), 0);
        assert_eq!(std::fs::read(sidecar).unwrap(), b"unrelated sidecar");
    }
}
#[test]
fn binary_bounds_headers_and_source_mutation_are_bounded() {
    let f = Fixture::new(0o755);
    let source = std::fs::OpenOptions::new()
        .write(true)
        .open(f.source())
        .unwrap();
    source.set_len(MAX_STAGE_BYTES).unwrap();
    assert_eq!(
        binary(&File::open(f.source()).unwrap(), f.anchors.uid)
            .unwrap()
            .len(),
        MAX_STAGE_BYTES
    );
    source.set_len(MAX_STAGE_BYTES + 1).unwrap();
    let s = stopped(f.run(), Phase::Validate);
    assert_eq!(s.reason, Failure::Oversize);
    assert!(!f.directory().exists());
    for kind in 0..3 {
        let f = Fixture::new(0o755);
        let mut bytes = Fixture::bytes();
        if kind == 0 {
            bytes[18] = 2;
        } else if kind == 1 {
            bytes[0] = 0;
        } else {
            bytes.truncate(20);
        }
        f.write_source(&bytes);
        stopped(f.run(), Phase::SourceRead);
        assert!(!f.directory().exists());
    }
    for kind in 0..3 {
        let f = Fixture::new(0o755);
        let mut changed = false;
        let out = prepare(&f.anchors, &f.options(), |at| {
            if at == Point::BeforeWrite && !changed {
                changed = true;
                let file = std::fs::OpenOptions::new()
                    .write(true)
                    .open(f.source())
                    .unwrap();
                match kind {
                    0 => file.set_len(100).unwrap(),
                    1 => file.set_len((BUFFER + 200) as u64).unwrap(),
                    _ => {
                        file.write_at(b"changed", 200).unwrap();
                    }
                }
            }
            Ok(())
        });
        stopped(out, Phase::Copy);
        assert_eq!(std::fs::metadata(f.copy()).unwrap().len(), 0);
    }
}
#[test]
fn partial_writes_fault_phases_and_artifacts_preserve_unrelated_files() {
    let f = Fixture::new(0o755);
    let options = Options {
        write_limit: Some(7),
        interrupt_once: true,
        ..f.options()
    };
    let session = prepare(&f.anchors, &options, |_| Ok(())).unwrap();
    assert_eq!(std::fs::read(f.copy()).unwrap(), Fixture::bytes());
    session.close();
    for (point, phase) in [
        (Point::BeforeDirectory, Phase::DirectoryCreate),
        (Point::DirectoryCreated, Phase::DirectoryCreate),
        (Point::FileCreated, Phase::BeforeFirstByte),
        (Point::BeforeWrite, Phase::Copy),
        (Point::AfterWrite, Phase::Copy),
        (Point::BeforeCompare, Phase::ValidateCopy),
        (Point::FileFsync, Phase::Sync),
        (Point::FileFullsync, Phase::Sync),
        (Point::DirectoryFsync, Phase::Sync),
        (Point::DirectoryFullsync, Phase::Sync),
        (Point::ParentFsync, Phase::Sync),
        (Point::ParentFullsync, Phase::Sync),
        (Point::BeforeReturn, Phase::FinalReadback),
    ] {
        let f = Fixture::new(0o755);
        let keep = f.stage_root.join("unrelated");
        std::fs::write(&keep, b"keep exactly").unwrap();
        let out = prepare(&f.anchors, &f.options(), |at| {
            if at == point {
                Err(Failure::Io)
            } else {
                Ok(())
            }
        });
        let s = stopped(out, phase);
        assert_eq!(std::fs::read(keep).unwrap(), b"keep exactly");
        assert_eq!(std::fs::read(f.source()).unwrap(), Fixture::bytes());
        if point != Point::BeforeDirectory {
            assert_eq!(s.artifacts, Artifacts::NamespaceMayExist);
            assert!(f.directory().exists());
        }
    }
    let f = Fixture::new(0o755);
    let options = Options {
        zero_write: true,
        ..f.options()
    };
    stopped(prepare(&f.anchors, &options, |_| Ok(())), Phase::Copy);
    assert_eq!(std::fs::metadata(f.copy()).unwrap().len(), 0);
}
#[test]
fn namespace_inode_content_acl_and_stamp_changes_never_produce_session() {
    for kind in 0..5 {
        let f = Fixture::new(0o755);
        let out = prepare(&f.anchors, &f.options(), |at| {
            if at == Point::BeforeReturn {
                match kind {
                    0 => {
                        std::fs::rename(f.copy(), f.directory().join("original-copy")).unwrap();
                        std::fs::write(f.copy(), b"replacement").unwrap();
                    }
                    1 => {
                        std::fs::rename(f.directory(), f.stage_root.join("detached")).unwrap();
                        private(&f.directory());
                    }
                    2 => acl(&f, &f.copy(), "everyone allow read"),
                    3 => {
                        let file = std::fs::OpenOptions::new()
                            .write(true)
                            .open(f.copy())
                            .unwrap();
                        file.write_at(b"bad", 200).unwrap();
                    }
                    _ => {
                        std::fs::hard_link(f.copy(), f.directory().join("extra-link")).unwrap();
                    }
                }
            }
            Ok(())
        });
        stopped(out, Phase::FinalReadback);
        assert!(f.directory().exists());
        assert_eq!(std::fs::read(f.source()).unwrap(), Fixture::bytes());
    }
}

#[test]
fn actual_inherited_acl_and_existing_namespace_conserve_bytes() {
    let f = Fixture::new(0o755);
    acl(
        &f,
        &f.stage_root,
        "everyone allow read,file_inherit,directory_inherit",
    );
    let inherited_directory = f.stage_root.join("inherited-empty-directory");
    private(&inherited_directory);
    let inherited_file = inherited_directory.join("empty-file");
    std::fs::write(&inherited_file, []).unwrap();
    std::fs::set_permissions(&inherited_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    // Actual inherited allow ACL survives chmod's mode setting. Both native
    // policies refuse it; no source bytes are written into either object.
    assert_eq!(
        super::super::super::acl(&File::open(&inherited_directory).unwrap()),
        Err(Failure::Unsafe)
    );
    assert!(matches!(
        binary(&File::open(&inherited_file).unwrap(), f.anchors.uid),
        Err(Failure::Unsafe)
    ));
    stopped(f.run(), Phase::Validate);
    assert_eq!(std::fs::metadata(inherited_file).unwrap().len(), 0);
    assert!(!f.directory().exists());
    let f = Fixture::new(0o755);
    let session = f.run().unwrap();
    let inode = metadata(&session.copy).unwrap().ino();
    session.close();
    let s = stopped(f.run(), Phase::DirectoryCreate);
    assert_eq!(s.artifacts, Artifacts::NoneObserved);
    assert_eq!(std::fs::metadata(f.copy()).unwrap().ino(), inode);
    assert_eq!(std::fs::read(f.copy()).unwrap(), Fixture::bytes());
    assert!(matches!(
        binary(
            &File::open(f.source()).unwrap(),
            f.anchors.uid.wrapping_add(1)
        ),
        Err(Failure::Unsafe)
    ));
}
