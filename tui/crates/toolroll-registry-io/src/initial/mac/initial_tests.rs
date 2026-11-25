use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
const DIGEST: [u8; 32] = [0xab; 32];
struct Fixture {
    _root: tempfile::TempDir,
    home: PathBuf,
    entries: PathBuf,
    anchor: ReadAnchor,
}
fn private(path: &Path) {
    std::fs::create_dir(path).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}
impl Fixture {
    fn new(existing: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("captured-home");
        private(&home);
        let entries = home.join(".toolroll-central/expectations");
        if existing {
            private(entries.parent().unwrap());
            private(&entries);
        }
        let file = File::open(&home).unwrap();
        let uid = metadata(&file).unwrap().uid();
        let anchor = ReadAnchor {
            root: NamedDir {
                parent: File::open(root.path()).unwrap(),
                name: CString::new("captured-home").unwrap(),
                file,
            },
            uid,
        };
        Self {
            _root: root,
            home,
            entries,
            anchor,
        }
    }
    fn destination(&self) -> PathBuf {
        self.entries.join(format!("{}.json", "ab".repeat(32)))
    }
    fn temporary(&self) -> PathBuf {
        self.entries
            .join(format!(".initial-{}.tmp", "11".repeat(16)))
    }
    fn options(&self) -> Options {
        Options {
            suffix: Some([0x11; 16]),
            ..Options::default()
        }
    }
    fn publish(&self, bytes: &[u8]) -> PublicationObservation {
        publish_initial_expectation(&self.anchor, DIGEST, bytes, &self.options(), |_| Ok(()))
    }
    fn payload(&self) -> Vec<u8> {
        // Complete canonical-shape enrolling fixture. Byte IO does not prove the
        // upstream path digest/authority bindings; it must never claim that.
        format!("{{\"version\":1,\"installationId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"workspaceId\":\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\",\"ownerUid\":{},\"databasePath\":\"/fixture/state/orders.db\",\"statePath\":\"/fixture/state\",\"stateIdentity\":{{\"dev\":1,\"ino\":2}},\"protocolVersion\":1,\"manifestVersion\":1,\"transactionId\":\"{}\",\"pathDigest\":\"{}\",\"phase\":\"enrolling\",\"services\":[\"fixture-console\"]}}",self.anchor.uid,"11".repeat(16),"ab".repeat(32)).into_bytes()
    }
}
fn refused(out: PublicationObservation, phase: Phase) {
    assert!(
        matches!(out,PublicationObservation::Refused{phase:p,..} if p==phase),
        "{out:?}"
    );
}
fn indeterminate(out: PublicationObservation, phase: Phase) {
    assert!(
        matches!(out,PublicationObservation::Indeterminate{phase:p,..} if p==phase),
        "{out:?}"
    );
}
fn add_acl(f: &Fixture, path: &Path) {
    let status = std::process::Command::new("/bin/chmod")
        .env_clear()
        .env("HOME", &f.home)
        .env("XDG_CONFIG_HOME", f.home.join("config"))
        .env("XDG_STATE_HOME", f.home.join("state"))
        .env("TMPDIR", &f.home)
        .env("PATH", "/usr/bin:/bin")
        .args(["+a", "everyone allow read"])
        .arg(path)
        .status()
        .unwrap();
    assert!(status.success());
}
#[test]
fn creates_private_directories_and_publishes_exact_bytes_once() {
    let f = Fixture::new(false);
    let bytes = f.payload();
    assert_eq!(
        f.publish(&bytes),
        PublicationObservation::PublishedAndReadBack {
            phase: Phase::FinalReadback
        }
    );
    assert_eq!(std::fs::read(f.destination()).unwrap(), bytes);
    assert!(!f.temporary().exists());
    let m = std::fs::metadata(f.destination()).unwrap();
    assert_eq!(m.nlink(), 1);
    assert_eq!(m.mode() & 0o7777, 0o600);
    for p in [&f.entries, f.entries.parent().unwrap()] {
        assert_eq!(std::fs::metadata(p).unwrap().mode() & 0o7777, 0o700);
    }
    assert_eq!(
        f.anchor.observe_expectation(DIGEST),
        Ok(Observation::Bytes(
            String::from_utf8(bytes.clone()).unwrap()
        ))
    );
    let ino = m.ino();
    assert_eq!(
        f.publish(&bytes),
        PublicationObservation::Conflict {
            phase: Phase::Rename
        }
    );
    assert_eq!(std::fs::metadata(f.destination()).unwrap().ino(), ino);
    assert_eq!(std::fs::read(f.destination()).unwrap(), bytes);
    assert!(f.temporary().exists());
    assert!(
        !format!("{:?}", f.publish(b"private record contents")).contains("private record contents")
    );
}
#[test]
fn byte_limits_entropy_and_partial_writes() {
    for bytes in [Vec::new(), vec![b'a'; LIMIT + 1], vec![0xff]] {
        let f = Fixture::new(false);
        refused(f.publish(&bytes), Phase::Validate);
        assert!(!f.entries.exists());
    }
    let f = Fixture::new(true);
    let options = Options {
        write_limit: Some(3),
        interrupt_write_once: true,
        ..f.options()
    };
    assert_eq!(
        publish_initial_expectation(&f.anchor, DIGEST, &vec![b'x'; LIMIT], &options, |_| Ok(())),
        PublicationObservation::PublishedAndReadBack {
            phase: Phase::FinalReadback
        }
    );
    let f = Fixture::new(true);
    assert_eq!(
        publish_initial_expectation(
            &f.anchor,
            DIGEST,
            b"entropy fixture",
            &Options::default(),
            |_| Ok(())
        ),
        PublicationObservation::PublishedAndReadBack {
            phase: Phase::FinalReadback
        }
    );
    let f = Fixture::new(true);
    let options = Options {
        zero_write: true,
        ..f.options()
    };
    refused(
        publish_initial_expectation(&f.anchor, DIGEST, b"record", &options, |_| Ok(())),
        Phase::TempWrite,
    );
    assert!(f.temporary().exists());
    assert!(!f.destination().exists());
}
#[test]
fn temp_collisions_and_unsafe_nodes_are_never_changed() {
    for kind in 0..4 {
        let f = Fixture::new(true);
        match kind {
            0 => std::fs::write(f.temporary(), b"do not touch").unwrap(),
            1 => symlink("missing", f.temporary()).unwrap(),
            2 => std::fs::create_dir(f.temporary()).unwrap(),
            _ => {
                let c = CString::new(f.temporary().as_os_str().as_encoded_bytes()).unwrap();
                // SAFETY: fixture-owned new component and native private mode.
                assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
            }
        }
        let before = std::fs::symlink_metadata(f.temporary()).unwrap();
        refused(f.publish(b"record"), Phase::TempCreate);
        let after = std::fs::symlink_metadata(f.temporary()).unwrap();
        assert_eq!(before.ino(), after.ino());
        assert_eq!(before.mode(), after.mode());
        assert!(!f.destination().exists());
    }
}
#[test]
fn destination_conflicts_preserve_every_existing_object() {
    for kind in 0..4 {
        let f = Fixture::new(true);
        match kind {
            0 => std::fs::write(f.destination(), b"existing record").unwrap(),
            1 => symlink("missing", f.destination()).unwrap(),
            2 => std::fs::create_dir(f.destination()).unwrap(),
            _ => {
                let c = CString::new(f.destination().as_os_str().as_encoded_bytes()).unwrap();
                // SAFETY: fixture-owned new component and native private mode.
                assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
            }
        }
        let before = std::fs::symlink_metadata(f.destination()).unwrap();
        assert_eq!(
            f.publish(b"existing record"),
            PublicationObservation::Conflict {
                phase: Phase::Rename
            }
        );
        let after = std::fs::symlink_metadata(f.destination()).unwrap();
        assert_eq!(before.ino(), after.ino());
        assert_eq!(before.mode(), after.mode());
        if kind == 0 {
            assert_eq!(std::fs::read(f.destination()).unwrap(), b"existing record");
        }
        assert!(f.temporary().exists());
    }
}
#[test]
fn fault_matrix_preserves_phase_and_artifacts() {
    let before = [
        (Point::Validate, Phase::Validate),
        (Point::BeforeTemp, Phase::TempCreate),
        (Point::AfterTemp, Phase::TempCreate),
        (Point::BeforeWrite, Phase::TempWrite),
        (Point::AfterWrite, Phase::TempWrite),
        (Point::FileFsync, Phase::TempSync),
        (Point::FileFullsync, Phase::TempSync),
        (Point::BeforeRename, Phase::Rename),
    ];
    for (fault, phase) in before {
        let f = Fixture::new(true);
        let out = publish_initial_expectation(&f.anchor, DIGEST, b"record", &f.options(), |at| {
            if at == fault {
                Err(Failure::Io)
            } else {
                Ok(())
            }
        });
        refused(out, phase);
        assert!(!f.destination().exists());
        if !matches!(fault, Point::Validate | Point::BeforeTemp) {
            assert!(f.temporary().exists());
        }
    }
    for (fault, phase) in [
        (Point::AfterRename, Phase::Rename),
        (
            Point::DirectoryFsync(Phase::DirectorySync),
            Phase::DirectorySync,
        ),
        (
            Point::DirectoryFullsync(Phase::DirectorySync),
            Phase::DirectorySync,
        ),
        (Point::BeforeFinalOpen, Phase::FinalReadback),
        (Point::DuringFinalRead, Phase::FinalReadback),
        (Point::BeforeReturn, Phase::FinalReadback),
    ] {
        let f = Fixture::new(true);
        let out = publish_initial_expectation(&f.anchor, DIGEST, b"record", &f.options(), |at| {
            if at == fault {
                Err(Failure::Io)
            } else {
                Ok(())
            }
        });
        indeterminate(out, phase);
        assert_eq!(std::fs::read(f.destination()).unwrap(), b"record");
        assert!(!f.temporary().exists());
    }
}
#[test]
fn mkdir_mutation_uncertainty_is_indeterminate_not_clean_refusal() {
    for phase in [Phase::RegistryDirectory, Phase::ExpectationsDirectory] {
        for fault in [
            Point::AfterMkdir(phase),
            Point::DirectoryFsync(phase),
            Point::DirectoryFullsync(phase),
        ] {
            let f = Fixture::new(false);
            let out =
                publish_initial_expectation(&f.anchor, DIGEST, b"record", &f.options(), |at| {
                    if at == fault {
                        Err(Failure::Io)
                    } else {
                        Ok(())
                    }
                });
            indeterminate(out, phase);
            assert!(f.home.join(".toolroll-central").exists());
            assert!(!f.destination().exists());
        }
    }
    let f = Fixture::new(false);
    refused(
        publish_initial_expectation(&f.anchor, DIGEST, b"record", &f.options(), |at| {
            if at == Point::BeforeMkdir(Phase::RegistryDirectory) {
                Err(Failure::Denied)
            } else {
                Ok(())
            }
        }),
        Phase::RegistryDirectory,
    );
    assert!(!f.home.join(".toolroll-central").exists());
}
#[test]
fn uncertain_rename_errors_never_retry_or_fallback() {
    for errno in [libc::EINTR, libc::EINVAL, libc::EIO, 12345] {
        let f = Fixture::new(true);
        let mut attempts = 0;
        let options = Options {
            rename_error: Some(errno),
            ..f.options()
        };
        let out = publish_initial_expectation(&f.anchor, DIGEST, b"record", &options, |at| {
            if at == Point::BeforeRename {
                attempts += 1;
            }
            Ok(())
        });
        indeterminate(out, Phase::Rename);
        assert_eq!(attempts, 1);
        assert!(!f.destination().exists());
        assert!(f.temporary().exists());
    }
}
#[test]
fn source_replacement_and_parent_detachment_refuse_without_cleanup() {
    let f = Fixture::new(true);
    let out = publish_initial_expectation(&f.anchor, DIGEST, b"record", &f.options(), |at| {
        if at == Point::BeforeRename {
            std::fs::rename(f.temporary(), f.entries.join("original")).unwrap();
            std::fs::write(f.temporary(), b"replacement").unwrap();
        }
        Ok(())
    });
    refused(out, Phase::Rename);
    assert_eq!(std::fs::read(f.temporary()).unwrap(), b"replacement");
    assert!(f.entries.join("original").exists());
    assert!(!f.destination().exists());
    for after in [false, true] {
        let f = Fixture::new(true);
        let out = publish_initial_expectation(&f.anchor, DIGEST, b"record", &f.options(), |at| {
            if at
                == if after {
                    Point::AfterRename
                } else {
                    Point::BeforeRename
                }
            {
                std::fs::rename(&f.entries, f.home.join("detached")).unwrap();
                private(&f.entries);
            }
            Ok(())
        });
        if after {
            indeterminate(out, Phase::Rename);
        } else {
            refused(out, Phase::Rename);
        }
        assert!(!f.destination().exists());
    }
}
#[test]
fn final_name_temp_reappearance_and_policy_mutation_are_indeterminate() {
    for kind in 0..5 {
        let f = Fixture::new(true);
        let out = publish_initial_expectation(&f.anchor, DIGEST, b"record", &f.options(), |at| {
            if at == Point::AfterRename {
                match kind {
                    0 => std::fs::write(f.temporary(), b"new unrelated temp").unwrap(),
                    1 => std::fs::set_permissions(
                        f.destination(),
                        std::fs::Permissions::from_mode(0o640),
                    )
                    .unwrap(),
                    2 => add_acl(&f, &f.destination()),
                    3 => std::fs::hard_link(f.destination(), f.entries.join("extra-link")).unwrap(),
                    _ => {
                        std::fs::rename(f.destination(), f.entries.join("saved-original")).unwrap();
                        std::fs::write(f.destination(), b"other inode").unwrap();
                    }
                }
            }
            Ok(())
        });
        indeterminate(out, Phase::Rename);
        assert!(f.destination().exists());
        if kind == 0 {
            assert_eq!(std::fs::read(f.temporary()).unwrap(), b"new unrelated temp");
        }
    }
    for stage in [Point::DuringFinalRead, Point::BeforeReturn] {
        let f = Fixture::new(true);
        let out = publish_initial_expectation(&f.anchor, DIGEST, b"record", &f.options(), |at| {
            if at == stage {
                add_acl(&f, &f.destination());
            }
            Ok(())
        });
        indeterminate(out, Phase::FinalReadback);
    }
}
#[test]
fn concurrent_publishers_have_at_most_one_winner() {
    let f = Fixture::new(true);
    let barrier = std::sync::Barrier::new(2);
    let outputs = std::thread::scope(|scope| {
        let jobs: Vec<_> = (1..=2)
            .map(|id| {
                let f = &f;
                let barrier = &barrier;
                scope.spawn(move || {
                    let options = Options {
                        suffix: Some([id; 16]),
                        ..Options::default()
                    };
                    publish_initial_expectation(&f.anchor, DIGEST, b"record", &options, |at| {
                        if at == Point::BeforeRename {
                            barrier.wait();
                        }
                        Ok(())
                    })
                })
            })
            .collect();
        jobs.into_iter()
            .map(|job| job.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(
        outputs
            .iter()
            .filter(|o| **o
                == PublicationObservation::PublishedAndReadBack {
                    phase: Phase::FinalReadback
                })
            .count(),
        1
    );
    assert_eq!(
        outputs
            .iter()
            .filter(|o| matches!(o, PublicationObservation::Conflict { .. }))
            .count(),
        1
    );
    assert_eq!(std::fs::read(f.destination()).unwrap(), b"record");
    assert_eq!(std::fs::read_dir(&f.entries).unwrap().count(), 2);
}

#[test]
fn native_process_interruption_leaves_observable_records_without_cleanup() {
    let points = [
        Point::AfterMkdir(Phase::RegistryDirectory),
        Point::AfterMkdir(Phase::ExpectationsDirectory),
        Point::AfterTemp,
        Point::FileFullsync,
        Point::BeforeRename,
        Point::AfterRename,
        Point::DirectoryFsync(Phase::DirectorySync),
        Point::BeforeReturn,
    ];
    if let Ok(case) = std::env::var("TOOLROLL_REGISTRY_TEST_CRASH_CASE") {
        let case: usize = case.parse().unwrap();
        assert!(case < points.len());
        let home = PathBuf::from(std::env::var("TOOLROLL_REGISTRY_TEST_HOME").unwrap());
        // Test-only captured path must be strictly within the supplied owned temp
        // root. No production constructor or ambient OS-account/home discovery.
        let home = std::fs::canonicalize(home).unwrap();
        let isolated = std::fs::canonicalize(std::env::var("TMPDIR").unwrap()).unwrap();
        assert!(home.starts_with(&isolated) && home != isolated);
        let parent = File::open(home.parent().unwrap()).unwrap();
        let file = File::open(&home).unwrap();
        let uid = metadata(&file).unwrap().uid();
        let anchor = ReadAnchor {
            root: NamedDir {
                parent,
                name: CString::new(home.file_name().unwrap().as_encoded_bytes()).unwrap(),
                file,
            },
            uid,
        };
        let options = Options {
            suffix: Some([0x11; 16]),
            ..Options::default()
        };
        let _ =
            publish_initial_expectation(&anchor, DIGEST, b"interrupted record", &options, |at| {
                if at == points[case] {
                    std::process::exit(73);
                }
                Ok(())
            });
        panic!("interruption point was not reached");
    }
    for case in 0..points.len() {
        let f = Fixture::new(false);
        let output=std::process::Command::new(std::env::current_exe().unwrap()).env_clear()
            .env("HOME",&f.home).env("XDG_CONFIG_HOME",f.home.join("config")).env("XDG_STATE_HOME",f.home.join("state"))
            .env("TMPDIR",f._root.path()).env("PATH","/usr/bin:/bin")
            .env("TOOLROLL_REGISTRY_TEST_HOME",&f.home).env("TOOLROLL_REGISTRY_TEST_CRASH_CASE",case.to_string())
            .args(["--exact","initial::mac::tests::native_process_interruption_leaves_observable_records_without_cleanup","--nocapture"])
            .output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(73),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        if case >= 5 {
            assert_eq!(
                std::fs::read(f.destination()).unwrap(),
                b"interrupted record"
            );
            assert!(!f.temporary().exists());
            assert_eq!(
                f.anchor.observe_expectation(DIGEST),
                Ok(Observation::Bytes("interrupted record".into()))
            );
        } else {
            assert!(!f.destination().exists());
            assert_eq!(
                f.anchor.observe_expectation(DIGEST),
                Ok(Observation::Absent)
            );
            if case >= 2 {
                assert!(f.temporary().exists());
            }
        }
    }
}

#[test]
fn parent_sync_fault_and_unsafe_temp_policy_remain_explicit() {
    for phase in [Phase::RegistryDirectory, Phase::ExpectationsDirectory] {
        for full in [false, true] {
            let f = Fixture::new(false);
            let mut ordinal = 0;
            let point = if full {
                Point::DirectoryFullsync(phase)
            } else {
                Point::DirectoryFsync(phase)
            };
            let out =
                publish_initial_expectation(&f.anchor, DIGEST, b"record", &f.options(), |at| {
                    if at == point {
                        ordinal += 1;
                        if ordinal == 2 {
                            return Err(Failure::Io);
                        }
                    }
                    Ok(())
                });
            indeterminate(out, phase);
            assert_eq!(ordinal, 2);
            assert!(!f.destination().exists());
        }
    }
    for kind in 0..4 {
        let f = Fixture::new(true);
        let out = publish_initial_expectation(&f.anchor, DIGEST, b"record", &f.options(), |at| {
            if at == Point::AfterTemp {
                match kind {
                    0 => std::fs::set_permissions(
                        f.temporary(),
                        std::fs::Permissions::from_mode(0o640),
                    )
                    .unwrap(),
                    1 => add_acl(&f, &f.temporary()),
                    2 => std::fs::hard_link(f.temporary(), f.entries.join("another-temp-link"))
                        .unwrap(),
                    _ => std::fs::write(f.temporary(), b"unexpected preexisting bytes").unwrap(),
                }
            }
            Ok(())
        });
        refused(out, Phase::TempCreate);
        assert!(f.temporary().exists());
        assert!(!f.destination().exists());
    }
}
