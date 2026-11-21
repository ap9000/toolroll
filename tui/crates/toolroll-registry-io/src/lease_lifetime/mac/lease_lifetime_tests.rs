use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::{symlink, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::Duration;
const CHILD_TEST: &str = "lease_lifetime::mac::tests::owned_fixture_child";
const READY: &str = "LOCK_FIXTURE_READY";
const REFUSED: &str = "LOCK_FIXTURE_REFUSED";
struct Fixture {
    _temp: tempfile::TempDir,
    path: PathBuf,
    capture: CapturedLockFixture,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("captured-root");
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        // Provisioning belongs to fixture setup, never an acquisition/DB caller.
        let lock = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path.join(LOCK_NAME))
            .unwrap();
        let expected = identity(&lock).unwrap();
        let root = File::open(&path).unwrap();
        let uid = metadata(&root).unwrap().uid();
        let capture = CapturedLockFixture {
            root: NamedDir {
                parent: File::open(temp.path()).unwrap(),
                name: CString::new("captured-root").unwrap(),
                file: root,
            },
            uid,
            expected,
        };
        capture.validate(&lock).unwrap();
        drop(lock);
        Self {
            _temp: temp,
            path,
            capture,
        }
    }
    fn lock(&self) -> PathBuf {
        self.path.join(LOCK_NAME)
    }
    fn open(&self) -> File {
        self.capture.existing().unwrap()
    }
}
struct OwnedChild {
    child: Child,
    reader: Option<std::thread::JoinHandle<()>>,
}
impl OwnedChild {
    fn spawn(f: &Fixture, file: &File, role: &str) -> Result<Self, Failure> {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .env_clear()
            .env("HOME", &f.path)
            .env("XDG_CONFIG_HOME", f.path.join("config"))
            .env("XDG_STATE_HOME", f.path.join("state"))
            .env("TMPDIR", f._temp.path())
            .env("PATH", "/usr/bin:/bin")
            .env("TOOLROLL_LOCK_FIXTURE_ROLE", role)
            .env("TOOLROLL_LOCK_FIXTURE_ROOT", &f.path)
            .args(["--exact", CHILD_TEST, "--nocapture"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let transferred = file.try_clone().map_err(|_| Failure::Io)?;
        // The coordinator owns the ORIGINAL provisioner identity. Validate the
        // exact transferred reference immediately before moving it to stdin.
        // Matching a replacement fd to a replacement name is not sufficient.
        f.capture.validate(&transferred)?;
        command.stdin(Stdio::from(transferred));
        let child = command.spawn().map_err(|_| Failure::Io)?;
        // Command retains the configured Stdio File. Drop it explicitly or its
        // hidden parent reference could make death/lifetime assertions vacuous.
        drop(command);
        Ok(Self {
            child,
            reader: None,
        })
    }
    fn marker(&mut self) -> Result<(), String> {
        self.marker_mode(false)
    }
    fn marker_mode(&mut self, drain_to_exit: bool) -> Result<(), String> {
        let stdout = self.child.stdout.take().ok_or("missing stdout")?;
        let (tx, rx) = mpsc::channel();
        self.reader = Some(std::thread::spawn(move || {
            let mut sent = false;
            // Bounded one-way fixture facts only. Coordinator output is drained
            // through exit so its test harness never writes into a closed pipe.
            for line in BufReader::new(stdout.take(4097)).lines() {
                match line {
                    Ok(line) if line == READY => {
                        if !sent {
                            let _ = tx.send(Ok(()));
                            sent = true;
                        }
                        if !drain_to_exit {
                            return;
                        }
                    }
                    Ok(line) if line == REFUSED => {
                        if !sent {
                            let _ = tx.send(Err("native fixture refused".to_string()));
                        }
                        return;
                    }
                    Ok(_) => {}
                    Err(_) => {
                        if !sent {
                            let _ = tx.send(Err("marker pipe error".to_string()));
                        }
                        return;
                    }
                }
            }
            if !sent {
                let _ = tx.send(Err("EOF before fixture marker".to_string()));
            }
        }));
        // Same10s fact-wait ceiling as existing startup tests. A watchdog error
        // triggers owned cleanup; it never proves child death or lock release.
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|_| "fixture marker watchdog".to_string())?
    }
    fn wait_exit(&mut self) -> ExitStatus {
        let status = self.child.wait().unwrap();
        if let Some(reader) = self.reader.take() {
            reader.join().unwrap();
        }
        status
    }
    fn terminate(&mut self) -> ExitStatus {
        if self.child.try_wait().unwrap().is_none() {
            self.child.kill().unwrap();
        }
        self.wait_exit()
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        match self.child.try_wait() {
            Ok(Some(_)) => {}
            _ => {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

fn isolated_case(name: &str, body: impl FnOnce()) {
    if let Ok(selected) = std::env::var("TOOLROLL_LOCK_CASE") {
        assert_eq!(selected, name);
        // This entrypoint runs only after exec closed inherited CLOEXEC refs.
        // The outer parent never constructs/opens this case's lock fixture.
        println!("\n{READY}");
        std::io::stdout().flush().unwrap();
        body();
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .env_clear()
        .env("HOME", root.path())
        .env("XDG_CONFIG_HOME", root.path().join("config"))
        .env("XDG_STATE_HOME", root.path().join("state"))
        .env("TMPDIR", root.path())
        .env("PATH", "/usr/bin:/bin")
        .env("TOOLROLL_LOCK_CASE", name)
        .args([
            "--exact",
            &format!("lease_lifetime::mac::tests::{name}"),
            "--test-threads=1",
            "--nocapture",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let child = command.spawn().unwrap();
    drop(command);
    let mut owned = OwnedChild {
        child,
        reader: None,
    };
    owned.marker_mode(true).unwrap();
    let status = owned.wait_exit();
    assert!(status.success(), "isolated fixture case failed: {status}");
}

fn add_acl(f: &Fixture, path: &Path) {
    let status = Command::new("/bin/chmod")
        .env_clear()
        .env("HOME", &f.path)
        .env("XDG_CONFIG_HOME", f.path.join("config"))
        .env("XDG_STATE_HOME", f.path.join("state"))
        .env("TMPDIR", &f.path)
        .env("PATH", "/usr/bin:/bin")
        .args(["+a", "everyone allow read"])
        .arg(path)
        .status()
        .unwrap();
    assert!(status.success());
}
#[test]
fn owned_fixture_child() {
    let Ok(role) = std::env::var("TOOLROLL_LOCK_FIXTURE_ROLE") else {
        return;
    };
    assert!(matches!(
        role.as_str(),
        "acquire" | "retain" | "exit-before-ready"
    ));
    let path = std::fs::canonicalize(std::env::var("TOOLROLL_LOCK_FIXTURE_ROOT").unwrap()).unwrap();
    let isolated = std::fs::canonicalize(std::env::var("TMPDIR").unwrap()).unwrap();
    assert!(path.starts_with(&isolated) && path != isolated);
    // The test launcher mapped its known fixture File duplicate to stdin.
    // SAFETY: this exact selected child takes sole Rust ownership of inherited fd0.
    let file = unsafe { File::from_raw_fd(libc::STDIN_FILENO) };
    let root = File::open(&path).unwrap();
    let uid = metadata(&root).unwrap().uid();
    // Narrow child claim: this supplied fd matches the current fixed name.
    // Original-provisioner identity is verified only by the coordinator at
    // the actual transfer boundary; this is not independent child attestation.
    let capture = CapturedLockFixture {
        root: NamedDir {
            parent: File::open(path.parent().unwrap()).unwrap(),
            name: CString::new(path.file_name().unwrap().as_encoded_bytes()).unwrap(),
            file: root,
        },
        uid,
        expected: identity(&file).unwrap(),
    };
    if role == "exit-before-ready" {
        std::process::exit(69);
    }
    let valid = capture.validate(&file).is_ok()
        && (role == "retain" || capture.acquire(&file) == LockObservation::AcquiredForFixture);
    if !valid {
        println!("\n{REFUSED}");
        std::io::stdout().flush().unwrap();
        std::process::exit(68);
    }
    println!("\n{READY}");
    std::io::stdout().flush().unwrap();
    // No timer/TTL/heartbeat and no explicit unlock. Only exact owned test-child
    // termination closes this retained reference; all globals stay untouched.
    loop {
        std::thread::park();
    }
}
#[test]
fn helper_death_does_not_release_surviving_owner_duplicate() {
    isolated_case(
        "helper_death_does_not_release_surviving_owner_duplicate",
        || {
            let f = Fixture::new();
            let owner = f.open();
            let mut helper = OwnedChild::spawn(&f, &owner, "acquire").unwrap();
            helper.marker().unwrap();
            assert_eq!(f.capture.independent_probe(), LockObservation::Busy);
            let status = helper.terminate();
            assert_eq!(status.signal(), Some(libc::SIGKILL));
            assert_eq!(f.capture.independent_probe(), LockObservation::Busy);
            drop(owner);
            assert_eq!(
                f.capture.independent_probe(),
                LockObservation::AcquiredForFixture
            );
        },
    );
}
#[test]
fn owner_death_does_not_release_retaining_helper_after_all_parent_duplicates_close() {
    isolated_case(
        "owner_death_does_not_release_retaining_helper_after_all_parent_duplicates_close",
        || {
            let f = Fixture::new();
            let parent = f.open();
            let mut owner = OwnedChild::spawn(&f, &parent, "acquire").unwrap();
            owner.marker().unwrap();
            let mut helper = OwnedChild::spawn(&f, &parent, "retain").unwrap();
            helper.marker().unwrap();
            drop(parent); // Fixture and OwnedChild retain no parent lock/Stdio descriptors.
            assert_eq!(f.capture.independent_probe(), LockObservation::Busy);
            assert_eq!(owner.terminate().signal(), Some(libc::SIGKILL));
            assert_eq!(f.capture.independent_probe(), LockObservation::Busy);
            assert_eq!(helper.terminate().signal(), Some(libc::SIGKILL));
            assert_eq!(
                f.capture.independent_probe(),
                LockObservation::AcquiredForFixture
            );
        },
    );
}
#[test]
fn duplicate_close_order_and_unrelated_open_close_preserve_lock_until_last_reference() {
    isolated_case(
        "duplicate_close_order_and_unrelated_open_close_preserve_lock_until_last_reference",
        || {
            for order in [
                [0, 1, 2],
                [0, 2, 1],
                [1, 0, 2],
                [1, 2, 0],
                [2, 0, 1],
                [2, 1, 0],
            ] {
                let f = Fixture::new();
                let original = f.open();
                assert_eq!(
                    f.capture.acquire(&original),
                    LockObservation::AcquiredForFixture
                );
                let duplicate = original.try_clone().unwrap();
                let third = original.try_clone().unwrap();
                let mut references = [Some(original), Some(duplicate), Some(third)];
                let unrelated = f.open();
                drop(unrelated);
                assert_eq!(f.capture.independent_probe(), LockObservation::Busy);
                for (step, index) in order.into_iter().enumerate() {
                    drop(references[index].take());
                    assert_eq!(
                        f.capture.independent_probe(),
                        if step == 2 {
                            LockObservation::AcquiredForFixture
                        } else {
                            LockObservation::Busy
                        }
                    );
                }
            }
        },
    );
}
#[test]
fn explicit_unlock_through_duplicate_is_a_negative_control_not_custody_release_api() {
    isolated_case(
        "explicit_unlock_through_duplicate_is_a_negative_control_not_custody_release_api",
        || {
            let f = Fixture::new();
            let original = f.open();
            assert_eq!(
                f.capture.acquire(&original),
                LockObservation::AcquiredForFixture
            );
            let duplicate = original.try_clone().unwrap();
            // SAFETY: deliberate fixture-only negative control on a live duplicate.
            assert_eq!(
                unsafe { libc::flock(duplicate.as_raw_fd(), libc::LOCK_UN) },
                0
            );
            assert_eq!(
                f.capture.independent_probe(),
                LockObservation::AcquiredForFixture
            );
            assert_eq!(identity(&original).unwrap(), f.capture.expected);
            drop(duplicate);
            drop(original);
        },
    );
}
#[test]
fn before_ready_exit_and_unknown_close_never_become_release_proof() {
    isolated_case(
        "before_ready_exit_and_unknown_close_never_become_release_proof",
        || {
            let f = Fixture::new();
            let original = f.open();
            let mut child = OwnedChild::spawn(&f, &original, "exit-before-ready").unwrap();
            assert!(child.marker().is_err());
            assert_eq!(child.terminate().code(), Some(69));
            assert_eq!(
                f.capture.independent_probe(),
                LockObservation::AcquiredForFixture
            );
            assert_eq!(
                f.capture.acquire(&original),
                LockObservation::AcquiredForFixture
            );
            let unknown = UnknownCustody { retained: original };
            assert_eq!(unknown.observe(), LockObservation::CustodyUnknown);
            assert_eq!(f.capture.independent_probe(), LockObservation::Busy);
            // Explicit end of this no-DB fixture only; not a response to unknown close.
            drop(unknown);
            assert_eq!(
                f.capture.independent_probe(),
                LockObservation::AcquiredForFixture
            );
        },
    );
}
#[test]
fn wrong_missing_unsafe_or_replaced_names_are_not_created_adopted_or_repaired() {
    isolated_case(
        "wrong_missing_unsafe_or_replaced_names_are_not_created_adopted_or_repaired",
        || {
            for kind in 0..6 {
                let f = Fixture::new();
                match kind {
                    0 => std::fs::remove_file(f.lock()).unwrap(),
                    1 => std::fs::set_permissions(f.lock(), std::fs::Permissions::from_mode(0o640))
                        .unwrap(),
                    2 => add_acl(&f, &f.lock()),
                    3 => {
                        std::fs::remove_file(f.lock()).unwrap();
                        symlink("missing", f.lock()).unwrap();
                    }
                    4 => {
                        std::fs::rename(f.lock(), f.path.join("original")).unwrap();
                        std::fs::write(f.lock(), []).unwrap();
                        std::fs::set_permissions(f.lock(), std::fs::Permissions::from_mode(0o600))
                            .unwrap();
                    }
                    _ => {
                        std::fs::remove_file(f.lock()).unwrap();
                        let c = CString::new(f.lock().as_os_str().as_encoded_bytes()).unwrap(); // SAFETY: owned new fixture name and private mode.
                        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
                    }
                }
                assert!(matches!(
                    f.capture.independent_probe(),
                    LockObservation::Refused(_)
                ));
                if kind == 0 {
                    assert!(!f.lock().exists());
                }
            }
            let f = Fixture::new();
            let foreign_path = f.path.join("foreign");
            let foreign = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&foreign_path)
                .unwrap();
            assert!(matches!(
                OwnedChild::spawn(&f, &foreign, "acquire"),
                Err(Failure::Changed)
            ));
            assert_eq!(std::fs::metadata(foreign_path).unwrap().len(), 0);
            let paired = Fixture::new();
            std::fs::rename(
                paired.lock(),
                paired.path.join("original-provisioned-inode"),
            )
            .unwrap();
            let replacement = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(paired.lock())
                .unwrap();
            // This new fd/name pair agrees, so the child's limited comparison
            // alone would pass. Original coordinator binding must refuse it.
            assert!(matches_name(
                &paired.capture.root.file,
                &CString::new(LOCK_NAME).unwrap(),
                &replacement
            )
            .is_ok());
            assert_ne!(identity(&replacement).unwrap(), paired.capture.expected);
            assert!(matches!(
                OwnedChild::spawn(&paired, &replacement, "acquire"),
                Err(Failure::Changed)
            ));
            assert!(paired.path.join("original-provisioned-inode").exists());
            assert_eq!(std::fs::metadata(paired.lock()).unwrap().len(), 0);
            assert_eq!(
                f.capture.independent_probe(),
                LockObservation::AcquiredForFixture
            );
        },
    );
}
#[test]
fn replacement_split_inode_and_detachment_are_negative_controls_not_global_exclusion() {
    isolated_case(
        "replacement_split_inode_and_detachment_are_negative_controls_not_global_exclusion",
        || {
            let f = Fixture::new();
            let original = f.open();
            assert_eq!(
                f.capture.acquire(&original),
                LockObservation::AcquiredForFixture
            );
            std::fs::rename(f.lock(), f.path.join("old-locked-inode")).unwrap();
            let replacement = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(f.lock())
                .unwrap();
            assert_ne!(identity(&replacement).unwrap(), f.capture.expected);
            // SAFETY: raw acquisition deliberately demonstrates that replacing a name
            // splits kernel locks. The validated participant below must refuse it.
            assert_eq!(
                unsafe { libc::flock(replacement.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
                0
            );
            assert!(matches!(
                f.capture.independent_probe(),
                LockObservation::Refused(Failure::Changed)
            ));
            assert_eq!(
                f.capture.acquire(&original),
                LockObservation::Refused(Failure::Changed)
            );
            assert!(f.path.join("old-locked-inode").exists());
            let f = Fixture::new();
            let original = f.open();
            std::fs::rename(&f.path, f._temp.path().join("detached")).unwrap();
            std::fs::create_dir(&f.path).unwrap();
            std::fs::set_permissions(&f.path, std::fs::Permissions::from_mode(0o700)).unwrap();
            assert_eq!(
                f.capture.acquire(&original),
                LockObservation::Refused(Failure::Changed)
            );
            assert!(!f.lock().exists());
        },
    );
}
