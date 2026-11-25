//! Captured-fixture binary-copy prerequisite only: no SQLite, OS-home discovery,
//! exclusion proof, production constructor or admission/readiness result.
#[cfg(not(target_os = "macos"))]
fn prepare_fixture_stage() -> Result<(), super::Failure> {
    Err(super::Failure::Unsupported)
}
#[cfg(not(target_os = "macos"))]
#[test]
fn unsupported_platform_has_no_mutating_stage_body() {
    assert_eq!(prepare_fixture_stage(), Err(super::Failure::Unsupported));
}

#[cfg(target_os = "macos")]
mod mac {
    use super::super::*;
    use std::os::unix::fs::FileExt;
    const MAX_STAGE_BYTES: u64 = 128 * 1024 * 1024;
    const BUFFER: usize = 64 * 1024;
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Phase {
        Validate,
        SourceRead,
        DirectoryCreate,
        BeforeFirstByte,
        Copy,
        ValidateCopy,
        Sync,
        FinalReadback,
    }
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Artifacts {
        NoneObserved,
        NamespaceMayExist,
    }
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct Stopped {
        phase: Phase,
        reason: Failure,
        artifacts: Artifacts,
    }
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Point {
        SourceOpened,
        BeforeDirectory,
        DirectoryCreated,
        FileCreated,
        BeforeWrite,
        AfterWrite,
        BeforeCompare,
        FileFsync,
        FileFullsync,
        DirectoryFsync,
        DirectoryFullsync,
        ParentFsync,
        ParentFullsync,
        BeforeReturn,
    }
    #[derive(Default)]
    struct Options {
        suffix: Option<[u8; 16]>,
        write_limit: Option<usize>,
        interrupt_once: bool,
        zero_write: bool,
    }
    // This is not an authority handle. No path/FD/database-open method is exposed;
    // only this private test module can construct or inspect the captured session.
    struct FixtureAnchors {
        home: NamedDir,
        uid: u32,
    }
    struct CapturedCopySession {
        anchors: FixtureAnchors,
        source_dir: NamedDir,
        stage_root: NamedDir,
        directory: NamedDir,
        source: File,
        copy: File,
    }
    impl CapturedCopySession {
        fn close(self) {
            drop(self);
        } // Close descriptors only; never delete names.
        fn recheck(&self) -> Result<(), Failure> {
            home(&self.anchors.home.file, self.anchors.uid)?;
            matches_name(
                &self.anchors.home.parent,
                &self.anchors.home.name,
                &self.anchors.home.file,
            )?;
            for d in [&self.source_dir, &self.stage_root, &self.directory] {
                d.recheck(self.anchors.uid)?;
            }
            matches_name(
                &self.source_dir.file,
                &CString::new("cold.db").unwrap(),
                &self.source,
            )?;
            matches_name(
                &self.directory.file,
                &CString::new("stage.db").unwrap(),
                &self.copy,
            )?;
            let source = binary(&self.source, self.anchors.uid)?;
            let copy = binary(&self.copy, self.anchors.uid)?;
            if source.dev() == copy.dev() && source.ino() == copy.ino() {
                return Err(Failure::Changed);
            }
            no_sidecars(&self.source_dir.file, "cold.db")?;
            no_sidecars(&self.directory.file, "stage.db")
        }
    }
    fn home(file: &File, uid: u32) -> Result<(), Failure> {
        let m = metadata(file)?;
        if !m.is_dir() || m.uid() != uid || !matches!(m.mode() & 0o7777, 0o700 | 0o750 | 0o755) {
            return Err(Failure::Unsafe);
        }
        acl(file)?;
        filesystem(file)
    }
    fn anchors(a: &FixtureAnchors) -> Result<(), Failure> {
        home(&a.home.file, a.uid)?;
        matches_name(&a.home.parent, &a.home.name, &a.home.file)
    }
    fn binary(file: &File, uid: u32) -> Result<Metadata, Failure> {
        let m = metadata(file)?;
        if !m.is_file() || m.uid() != uid || m.mode() & 0o7777 != 0o600 || m.nlink() != 1 {
            return Err(Failure::Unsafe);
        }
        if m.len() > MAX_STAGE_BYTES {
            return Err(Failure::Oversize);
        }
        acl(file)?;
        filesystem(file)?;
        Ok(m)
    }
    fn stable(a: &Metadata, b: &Metadata) -> bool {
        same(a, b)
            && a.len() == b.len()
            && a.nlink() == b.nlink()
            && a.mtime() == b.mtime()
            && a.mtime_nsec() == b.mtime_nsec()
            && a.ctime() == b.ctime()
            && a.ctime_nsec() == b.ctime_nsec()
    }
    fn no_sidecars(parent: &File, leaf: &str) -> Result<(), Failure> {
        for suffix in ["-wal", "-shm", "-journal"] {
            prove_absent(parent, &CString::new(format!("{leaf}{suffix}")).unwrap())?;
        }
        Ok(())
    }
    fn open_binary(parent: &File, leaf: &'static str, uid: u32) -> Result<File, Failure> {
        let name = CString::new(leaf).unwrap();
        // SAFETY: retained parent, fixed component and nofollow/nonblocking flags.
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(os_error());
        }
        // SAFETY: fresh successful descriptor now solely owned by File.
        let file = unsafe { File::from_raw_fd(fd) };
        binary(&file, uid)?;
        matches_name(parent, &name, &file)?;
        Ok(file)
    }
    fn read_at(file: &File, buffer: &mut [u8], offset: u64) -> Result<usize, Failure> {
        loop {
            match file.read_at(buffer, offset) {
                Ok(n) => return Ok(n),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Err(Failure::Io),
            }
        }
    }
    fn cold_header(file: &File, mark: &Metadata) -> Result<(), Failure> {
        let mut header = [0; 100];
        let mut count = 0;
        while count < header.len() {
            let n = read_at(file, &mut header[count..], count as u64)?;
            if n == 0 {
                return Err(Failure::Changed);
            }
            count += n;
        }
        if mark.len() < 100
            || &header[..16] != b"SQLite format 3\0"
            || header[18] != 1
            || header[19] != 1
        {
            return Err(Failure::Unsafe);
        }
        Ok(())
    }
    fn sync(file: &File, full: bool) -> Result<(), Failure> {
        loop {
            // SAFETY: retained fd, no pointer argument to either sync primitive.
            let result = unsafe {
                if full {
                    libc::fcntl(file.as_raw_fd(), libc::F_FULLFSYNC)
                } else {
                    libc::fsync(file.as_raw_fd())
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
    fn generated(options: &Options) -> Result<CString, Failure> {
        let mut bytes = [0; 16];
        if let Some(fixed) = options.suffix {
            bytes = fixed;
        } else {
            // SAFETY: owned writable16-byte array below getentropy maximum.
            if unsafe { libc::getentropy(bytes.as_mut_ptr().cast(), bytes.len()) } != 0 {
                return Err(Failure::Io);
            }
        }
        Ok(CString::new(format!(
            "stage-{}",
            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
        ))
        .unwrap())
    }
    fn duplicate(a: &FixtureAnchors) -> Result<FixtureAnchors, Failure> {
        Ok(FixtureAnchors {
            home: NamedDir {
                parent: a.home.parent.try_clone().map_err(|_| Failure::Io)?,
                name: a.home.name.clone(),
                file: a.home.file.try_clone().map_err(|_| Failure::Io)?,
            },
            uid: a.uid,
        })
    }
    fn compare(session: &CapturedCopySession, source_mark: &Metadata) -> Result<(), Failure> {
        session.recheck()?;
        if !stable(source_mark, &binary(&session.source, session.anchors.uid)?) {
            return Err(Failure::Changed);
        }
        let before = binary(&session.copy, session.anchors.uid)?;
        if before.len() != source_mark.len() {
            return Err(Failure::Changed);
        }
        // One64KiB allocation total: split into two32KiB comparison windows.
        let mut buffer = vec![0; BUFFER];
        let (left, right) = buffer.split_at_mut(BUFFER / 2);
        let mut offset = 0;
        while offset < source_mark.len() {
            let max = (source_mark.len() - offset).min(left.len() as u64) as usize;
            let mut a = 0;
            let mut b = 0;
            while a < max {
                let n = read_at(&session.source, &mut left[a..max], offset + a as u64)?;
                if n == 0 {
                    return Err(Failure::Changed);
                }
                a += n;
            }
            while b < max {
                let n = read_at(&session.copy, &mut right[b..max], offset + b as u64)?;
                if n == 0 {
                    return Err(Failure::Changed);
                }
                b += n;
            }
            if left[..max] != right[..max] {
                return Err(Failure::Changed);
            }
            offset += max as u64;
        }
        let mut extra = [0; 1];
        if read_at(&session.source, &mut extra, offset)? != 0
            || read_at(&session.copy, &mut extra, offset)? != 0
        {
            return Err(Failure::Changed);
        }
        if !stable(source_mark, &binary(&session.source, session.anchors.uid)?)
            || !stable(&before, &binary(&session.copy, session.anchors.uid)?)
        {
            return Err(Failure::Changed);
        }
        session.recheck()
    }
    fn prepare(
        a: &FixtureAnchors,
        options: &Options,
        mut hook: impl FnMut(Point) -> Result<(), Failure>,
    ) -> Result<CapturedCopySession, Stopped> {
        let mut phase = Phase::Validate;
        let mut artifacts = Artifacts::NoneObserved;
        let result = (|| -> Result<CapturedCopySession, Failure> {
            anchors(a)?;
            let source_dir =
                open_dir(&a.home.file, "fixture-source", a.uid)?.ok_or(Failure::Changed)?;
            let stage_root =
                open_dir(&a.home.file, "fixture-stages", a.uid)?.ok_or(Failure::Changed)?;
            no_sidecars(&source_dir.file, "cold.db")?;
            let source = open_binary(&source_dir.file, "cold.db", a.uid)?;
            let source_mark = binary(&source, a.uid)?;
            phase = Phase::SourceRead;
            hook(Point::SourceOpened)?;
            cold_header(&source, &source_mark)?;
            if !stable(&source_mark, &binary(&source, a.uid)?) {
                return Err(Failure::Changed);
            }
            let name = generated(options)?;
            phase = Phase::DirectoryCreate;
            hook(Point::BeforeDirectory)?;
            anchors(a)?;
            source_dir.recheck(a.uid)?;
            stage_root.recheck(a.uid)?;
            // SAFETY: retained private parent, generated component and private mode.
            let made = unsafe { libc::mkdirat(stage_root.file.as_raw_fd(), name.as_ptr(), 0o700) };
            if made != 0 {
                return Err(os_error());
            }
            artifacts = Artifacts::NamespaceMayExist;
            hook(Point::DirectoryCreated)?;
            // open_dir accepts only compile-time leaves. This generated component
            // uses the same descriptor policy without exposing a path constructor.
            // SAFETY: retained parent, generated component and directory/no-follow flags.
            let fd = unsafe {
                libc::openat(
                    stage_root.file.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY
                        | libc::O_DIRECTORY
                        | libc::O_NOFOLLOW
                        | libc::O_NONBLOCK
                        | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(os_error());
            }
            // SAFETY: take ownership immediately, before any fallible clone.
            // If cloning the parent fails, this local File closes the fresh fd.
            let file = unsafe { File::from_raw_fd(fd) };
            let directory = NamedDir {
                parent: stage_root.file.try_clone().map_err(|_| Failure::Io)?,
                name,
                file,
            };
            directory.recheck(a.uid)?;
            anchors(a)?;
            stage_root.recheck(a.uid)?;
            let leaf = CString::new("stage.db").unwrap();
            no_sidecars(&directory.file, "stage.db")?;
            // SAFETY: retained private dir, fixed component and exclusive/no-follow flags.
            let fd = unsafe {
                libc::openat(
                    directory.file.as_raw_fd(),
                    leaf.as_ptr(),
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
                return Err(os_error());
            }
            // SAFETY: successful fresh descriptor transferred to sole File ownership.
            let copy = unsafe { File::from_raw_fd(fd) };
            let session = CapturedCopySession {
                anchors: duplicate(a)?,
                source_dir,
                stage_root,
                directory,
                source,
                copy,
            };
            phase = Phase::BeforeFirstByte;
            hook(Point::FileCreated)?;
            session.recheck()?;
            if binary(&session.copy, a.uid)?.len() != 0 {
                return Err(Failure::Changed);
            }
            let mut buffer = vec![0_u8; BUFFER];
            let mut offset = 0_u64;
            let mut interrupt = options.interrupt_once;
            phase = Phase::Copy;
            while offset < source_mark.len() {
                if !stable(&source_mark, &binary(&session.source, a.uid)?) {
                    return Err(Failure::Changed);
                }
                let max = (source_mark.len() - offset).min(BUFFER as u64) as usize;
                let n = read_at(&session.source, &mut buffer[..max], offset)?;
                if n == 0 {
                    return Err(Failure::Changed);
                }
                hook(Point::BeforeWrite)?;
                session.recheck()?;
                if !stable(&source_mark, &binary(&session.source, a.uid)?) {
                    return Err(Failure::Changed);
                }
                let mut written = 0;
                while written < n {
                    let max = options.write_limit.unwrap_or(n).min(n - written);
                    let result = if interrupt {
                        interrupt = false;
                        Err(libc::EINTR)
                    } else if options.zero_write || max == 0 {
                        Ok(0)
                    } else {
                        // SAFETY: held copy fd and bounded initialized binary slice.
                        let n = unsafe {
                            libc::write(
                                session.copy.as_raw_fd(),
                                buffer[written..].as_ptr().cast(),
                                max,
                            )
                        };
                        if n < 0 {
                            Err(std::io::Error::last_os_error()
                                .raw_os_error()
                                .unwrap_or(libc::EIO))
                        } else {
                            Ok(n as usize)
                        }
                    };
                    match result {
                        Err(libc::EINTR) => continue,
                        Err(_) | Ok(0) => return Err(Failure::Io),
                        Ok(n) => written += n,
                    }
                }
                offset += n as u64;
                hook(Point::AfterWrite)?;
            }
            let mut extra = [0; 1];
            if read_at(&session.source, &mut extra, offset)? != 0 {
                return Err(Failure::Changed);
            }
            // Keep only one64KiB working allocation alive: comparison reuses
            // its own split32KiB windows after this copy buffer is released.
            drop(buffer);
            phase = Phase::ValidateCopy;
            hook(Point::BeforeCompare)?;
            compare(&session, &source_mark)?;
            phase = Phase::Sync;
            for (point, file, full) in [
                (Point::FileFsync, &session.copy, false),
                (Point::FileFullsync, &session.copy, true),
                (Point::DirectoryFsync, &session.directory.file, false),
                (Point::DirectoryFullsync, &session.directory.file, true),
                (Point::ParentFsync, &session.stage_root.file, false),
                (Point::ParentFullsync, &session.stage_root.file, true),
            ] {
                hook(point)?;
                sync(file, full)?;
            }
            phase = Phase::FinalReadback;
            hook(Point::BeforeReturn)?;
            compare(&session, &source_mark)?;
            Ok(session)
        })();
        result.map_err(|reason| Stopped {
            phase,
            reason,
            artifacts,
        })
    }
    #[path = "stage_namespace_tests.rs"]
    mod tests;
}
