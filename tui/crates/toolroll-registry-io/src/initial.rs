//! Initial byte publication is test-only and never supplies enrollment authority.
use super::*;

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Validate,
    RegistryDirectory,
    ExpectationsDirectory,
    TempCreate,
    TempWrite,
    TempSync,
    Rename,
    DirectorySync,
    FinalReadback,
}
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Artifacts {
    NoneObserved,
    OwnedTempPreserved,
    CreatedDirectoriesPreserved,
    CreatedDirectoriesAndTempPreserved,
    PreservedStateRequiresInspection,
}
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PublicationObservation {
    PublishedAndReadBack {
        phase: Phase,
    },
    Conflict {
        phase: Phase,
    },
    Refused {
        phase: Phase,
        reason: Failure,
        artifacts: Artifacts,
    },
    Indeterminate {
        phase: Phase,
        reason: Failure,
        artifacts: Artifacts,
    },
}

// No writer body, entropy, mkdir, temp open or sync exists on Linux.
#[cfg(not(target_os = "macos"))]
fn publish_initial_expectation(
    _anchor: &ReadAnchor,
    _leaf: [u8; 32],
    _bytes: &[u8],
) -> Result<(), Failure> {
    Err(Failure::Unsupported)
}
#[cfg(not(target_os = "macos"))]
#[test]
fn linux_writer_refuses_before_accessing_anchor() {
    let root = tempfile::tempdir().unwrap();
    let file = File::open(root.path()).unwrap();
    let uid = metadata(&file).unwrap().uid();
    let anchor = ReadAnchor {
        root: NamedDir {
            parent: file.try_clone().unwrap(),
            name: CString::new("absent").unwrap(),
            file,
        },
        uid,
    };
    assert_eq!(
        publish_initial_expectation(&anchor, [0; 32], b"record"),
        Err(Failure::Unsupported)
    );
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use std::os::unix::fs::FileExt;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Point {
        Validate,
        BeforeMkdir(Phase),
        AfterMkdir(Phase),
        DirectoryFsync(Phase),
        DirectoryFullsync(Phase),
        BeforeTemp,
        AfterTemp,
        BeforeWrite,
        AfterWrite,
        FileFsync,
        FileFullsync,
        BeforeRename,
        AfterRename,
        BeforeFinalOpen,
        DuringFinalRead,
        BeforeReturn,
    }
    #[derive(Default)]
    struct Options {
        suffix: Option<[u8; 16]>,
        write_limit: Option<usize>,
        interrupt_write_once: bool,
        zero_write: bool,
        rename_error: Option<i32>,
    }
    struct State {
        phase: Phase,
        last_directory: Phase,
        directories_created: bool,
        directory_pending: bool,
        temp_created: bool,
        rename_attempted: bool,
    }
    struct Stop {
        reason: Failure,
        lineage: bool,
    }
    impl From<Failure> for Stop {
        fn from(reason: Failure) -> Self {
            Self {
                reason,
                lineage: false,
            }
        }
    }
    impl State {
        fn new() -> Self {
            Self {
                phase: Phase::Validate,
                last_directory: Phase::RegistryDirectory,
                directories_created: false,
                directory_pending: false,
                temp_created: false,
                rename_attempted: false,
            }
        }
        fn fail(&self, stop: Stop) -> PublicationObservation {
            if self.rename_attempted
                || self.directory_pending
                || (self.directories_created && stop.lineage)
            {
                PublicationObservation::Indeterminate {
                    phase: if self.directory_pending || (self.directories_created && stop.lineage) {
                        self.last_directory
                    } else {
                        self.phase
                    },
                    reason: stop.reason,
                    artifacts: Artifacts::PreservedStateRequiresInspection,
                }
            } else {
                PublicationObservation::Refused {
                    phase: self.phase,
                    reason: stop.reason,
                    artifacts: match (self.directories_created, self.temp_created) {
                        (false, false) => Artifacts::NoneObserved,
                        (false, true) => Artifacts::OwnedTempPreserved,
                        (true, false) => Artifacts::CreatedDirectoriesPreserved,
                        (true, true) => Artifacts::CreatedDirectoriesAndTempPreserved,
                    },
                }
            }
        }
    }
    fn point(hook: &mut impl FnMut(Point) -> Result<(), Failure>, p: Point) -> Result<(), Stop> {
        hook(p).map_err(Into::into)
    }
    fn lineage(
        anchor: &ReadAnchor,
        registry: Option<&NamedDir>,
        entries: Option<&NamedDir>,
    ) -> Result<(), Stop> {
        for dir in entries
            .into_iter()
            .chain(registry)
            .chain(std::iter::once(&anchor.root))
        {
            dir.recheck(anchor.uid).map_err(|reason| Stop {
                reason,
                lineage: true,
            })?;
        }
        Ok(())
    }
    fn sync_call(fd: i32, full: bool) -> Result<(), Failure> {
        loop {
            // SAFETY: fd is retained by the caller; these syscalls take no pointer.
            let result = unsafe {
                if full {
                    libc::fcntl(fd, libc::F_FULLFSYNC)
                } else {
                    libc::fsync(fd)
                }
            };
            if result == 0 {
                return Ok(());
            }
            if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                return Err(Failure::Io);
            }
        }
    }
    fn directory_sync(
        file: &File,
        phase: Phase,
        hook: &mut impl FnMut(Point) -> Result<(), Failure>,
    ) -> Result<(), Stop> {
        point(hook, Point::DirectoryFsync(phase))?;
        sync_call(file.as_raw_fd(), false)?;
        point(hook, Point::DirectoryFullsync(phase))?;
        sync_call(file.as_raw_fd(), true)?;
        Ok(())
    }
    fn ensure_dir(
        parent: &File,
        name: &'static str,
        phase: Phase,
        anchor: &ReadAnchor,
        registry: Option<&NamedDir>,
        state: &mut State,
        hook: &mut impl FnMut(Point) -> Result<(), Failure>,
    ) -> Result<NamedDir, Stop> {
        state.phase = phase;
        if let Some(dir) = open_dir(parent, name, anchor.uid)? {
            return Ok(dir);
        }
        lineage(anchor, registry, None)?;
        point(hook, Point::BeforeMkdir(phase))?;
        lineage(anchor, registry, None)?;
        let c = CString::new(name).expect("fixed component");
        // SAFETY: retained descriptor, fixed single component, native private mode.
        let result = unsafe { libc::mkdirat(parent.as_raw_fd(), c.as_ptr(), 0o700) };
        if result != 0 {
            let errno = std::io::Error::last_os_error().raw_os_error();
            if errno != Some(libc::EEXIST) {
                // Known denial leaves this operation pre-mutation; other errors
                // may hide a namespace change and must not imply clean refusal.
                if !matches!(errno, Some(libc::EACCES | libc::EPERM | libc::EROFS)) {
                    state.directory_pending = true;
                    state.last_directory = phase;
                }
                return Err(os_error().into());
            }
        } else {
            state.directories_created = true;
            state.directory_pending = true;
            state.last_directory = phase;
            point(hook, Point::AfterMkdir(phase))?;
        }
        let dir = open_dir(parent, name, anchor.uid)?.ok_or(Failure::Changed)?;
        if state.directory_pending {
            directory_sync(&dir.file, phase, hook)?;
            directory_sync(parent, phase, hook)?;
            dir.recheck(anchor.uid).map_err(|reason| Stop {
                reason,
                lineage: true,
            })?;
            lineage(anchor, registry, None)?;
            state.directory_pending = false;
        }
        Ok(dir)
    }
    fn same_inode(a: &File, b: &File) -> Result<(), Failure> {
        let a = metadata(a)?;
        let b = metadata(b)?;
        if a.dev() != b.dev() || a.ino() != b.ino() {
            return Err(Failure::Changed);
        }
        Ok(())
    }
    fn exact_bytes(file: &File, uid: u32, expected: &[u8]) -> Result<(), Failure> {
        let before = record_policy(file, uid)?;
        if before.len() != expected.len() as u64 {
            return Err(Failure::Changed);
        }
        let mut bytes = vec![0_u8; LIMIT + 1];
        let mut count = 0;
        while count < bytes.len() {
            match file.read_at(&mut bytes[count..], count as u64) {
                Ok(0) => break,
                Ok(n) => count += n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Err(Failure::Io),
            }
        }
        if count > LIMIT {
            return Err(Failure::Oversize);
        }
        let after = record_policy(file, uid)?;
        if !same(&before, &after)
            || before.len() != after.len()
            || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
            || before.ctime() != after.ctime()
            || before.ctime_nsec() != after.ctime_nsec()
            || &bytes[..count] != expected
        {
            return Err(Failure::Changed);
        }
        Ok(())
    }
    fn temp_name(options: &Options) -> Result<CString, Failure> {
        let mut suffix = [0_u8; 16];
        if let Some(fixed) = options.suffix {
            suffix = fixed;
        } else {
            // SAFETY: writable 16-byte owned buffer, below getentropy's maximum.
            if unsafe { libc::getentropy(suffix.as_mut_ptr().cast(), suffix.len()) } != 0 {
                return Err(Failure::Io);
            }
        }
        Ok(CString::new(format!(
            ".initial-{}.tmp",
            suffix
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        ))
        .expect("hex only"))
    }
    fn write_bytes(file: &File, bytes: &[u8], options: &Options) -> Result<(), Failure> {
        let mut offset = 0;
        let mut interrupt = options.interrupt_write_once;
        while offset < bytes.len() {
            let max = options
                .write_limit
                .unwrap_or(bytes.len())
                .min(bytes.len() - offset);
            let result = if interrupt {
                interrupt = false;
                Err(libc::EINTR)
            } else if options.zero_write || max == 0 {
                Ok(0)
            } else {
                // SAFETY: live owned fd and bounded owned slice pointer/length.
                let count =
                    unsafe { libc::write(file.as_raw_fd(), bytes[offset..].as_ptr().cast(), max) };
                if count < 0 {
                    Err(std::io::Error::last_os_error()
                        .raw_os_error()
                        .unwrap_or(libc::EIO))
                } else {
                    Ok(count as usize)
                }
            };
            match result {
                Err(libc::EINTR) => continue,
                Err(_) | Ok(0) => return Err(Failure::Io),
                Ok(count) => offset += count,
            }
        }
        Ok(())
    }

    fn run(
        anchor: &ReadAnchor,
        digest: [u8; 32],
        bytes: &[u8],
        options: &Options,
        state: &mut State,
        hook: &mut impl FnMut(Point) -> Result<(), Failure>,
    ) -> Result<PublicationObservation, Stop> {
        point(hook, Point::Validate)?;
        if bytes.is_empty() || bytes.len() > LIMIT {
            return Err(Failure::Oversize.into());
        }
        std::str::from_utf8(bytes).map_err(|_| Failure::InvalidUtf8)?;
        lineage(anchor, None, None)?;
        let registry = ensure_dir(
            &anchor.root.file,
            ".toolroll-central",
            Phase::RegistryDirectory,
            anchor,
            None,
            state,
            hook,
        )?;
        let entries = ensure_dir(
            &registry.file,
            "expectations",
            Phase::ExpectationsDirectory,
            anchor,
            Some(&registry),
            state,
            hook,
        )?;
        lineage(anchor, Some(&registry), Some(&entries))?;
        state.phase = Phase::TempCreate;
        let temporary = temp_name(options)?;
        let destination = CString::new(format!(
            "{}.json",
            digest
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        ))
        .expect("hex only");
        state.phase = Phase::TempCreate;
        point(hook, Point::BeforeTemp)?;
        lineage(anchor, Some(&registry), Some(&entries))?;
        // SAFETY: retained descriptor, generated component, exclusive nonfollowing open.
        let fd = unsafe {
            libc::openat(
                entries.file.as_raw_fd(),
                temporary.as_ptr(),
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_EXCL
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK
                    | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(os_error().into());
        }
        // SAFETY: successful openat returned a fresh descriptor transferred to File.
        let file = unsafe { File::from_raw_fd(fd) };
        state.temp_created = true;
        point(hook, Point::AfterTemp)?;
        if record_policy(&file, anchor.uid)?.len() != 0 {
            return Err(Failure::Changed.into());
        }
        matches_name(&entries.file, &temporary, &file)?;
        state.phase = Phase::TempWrite;
        point(hook, Point::BeforeWrite)?;
        write_bytes(&file, bytes, options)?;
        point(hook, Point::AfterWrite)?;
        exact_bytes(&file, anchor.uid, bytes)?;
        matches_name(&entries.file, &temporary, &file)?;
        state.phase = Phase::TempSync;
        point(hook, Point::FileFsync)?;
        sync_call(file.as_raw_fd(), false)?;
        point(hook, Point::FileFullsync)?;
        sync_call(file.as_raw_fd(), true)?;
        state.phase = Phase::Rename;
        point(hook, Point::BeforeRename)?;
        lineage(anchor, Some(&registry), Some(&entries))?;
        exact_bytes(&file, anchor.uid, bytes)?;
        matches_name(&entries.file, &temporary, &file)?;
        state.rename_attempted = true;
        // SAFETY: same retained parent fd, two generated single components and
        // only RENAME_EXCL; never replace-existing, link/unlink or fallback.
        let (result, errno) = if let Some(errno) = options.rename_error {
            (-1, Some(errno))
        } else {
            let result = unsafe {
                libc::renameatx_np(
                    entries.file.as_raw_fd(),
                    temporary.as_ptr(),
                    entries.file.as_raw_fd(),
                    destination.as_ptr(),
                    libc::RENAME_EXCL,
                )
            };
            (
                result,
                if result < 0 {
                    std::io::Error::last_os_error().raw_os_error()
                } else {
                    None
                },
            )
        };
        if result != 0 {
            if errno == Some(libc::EEXIST) {
                return Ok(PublicationObservation::Conflict {
                    phase: Phase::Rename,
                });
            }
            return Err(Failure::Io.into());
        }
        point(hook, Point::AfterRename)?;
        exact_bytes(&file, anchor.uid, bytes)?;
        matches_name(&entries.file, &destination, &file)?;
        prove_absent(&entries.file, &temporary)?;
        lineage(anchor, Some(&registry), Some(&entries))?;
        state.phase = Phase::DirectorySync;
        directory_sync(&entries.file, Phase::DirectorySync, hook)?;
        state.phase = Phase::FinalReadback;
        point(hook, Point::BeforeFinalOpen)?;
        // SAFETY: retained parent and generated component; nofollow/nonblocking.
        let fd = unsafe {
            libc::openat(
                entries.file.as_raw_fd(),
                destination.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(os_error().into());
        }
        // SAFETY: successful fresh descriptor now solely owned by File.
        let reopened = unsafe { File::from_raw_fd(fd) };
        same_inode(&file, &reopened)?;
        point(hook, Point::DuringFinalRead)?;
        exact_bytes(&reopened, anchor.uid, bytes)?;
        exact_bytes(&file, anchor.uid, bytes)?;
        point(hook, Point::BeforeReturn)?;
        exact_bytes(&reopened, anchor.uid, bytes)?;
        exact_bytes(&file, anchor.uid, bytes)?;
        same_inode(&file, &reopened)?;
        matches_name(&entries.file, &destination, &file)?;
        prove_absent(&entries.file, &temporary)?;
        lineage(anchor, Some(&registry), Some(&entries))?;
        Ok(PublicationObservation::PublishedAndReadBack {
            phase: Phase::FinalReadback,
        })
    }
    fn publish_initial_expectation(
        anchor: &ReadAnchor,
        digest: [u8; 32],
        bytes: &[u8],
        options: &Options,
        mut hook: impl FnMut(Point) -> Result<(), Failure>,
    ) -> PublicationObservation {
        let mut state = State::new();
        match run(anchor, digest, bytes, options, &mut state, &mut hook) {
            Ok(result) => result,
            Err(stop) => state.fail(stop),
        }
    }
    #[cfg(test)]
    #[path = "initial_tests.rs"]
    mod tests;
}
