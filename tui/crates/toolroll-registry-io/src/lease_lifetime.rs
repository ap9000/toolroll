//! Native fixture observations only: not a production lease or SQLite-close proof.
#[cfg(not(target_os = "macos"))]
fn attempt_fixture_lock() -> Result<(), super::Failure> {
    Err(super::Failure::Unsupported)
}
#[cfg(not(target_os = "macos"))]
#[test]
fn unsupported_lock_experiment_has_no_mutating_body() {
    assert_eq!(attempt_fixture_lock(), Err(super::Failure::Unsupported));
}

#[cfg(target_os = "macos")]
mod mac {
    use super::super::*;
    const LOCK_NAME: &str = "stage.lock";
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct Identity {
        dev: u64,
        ino: u64,
    }
    fn identity(file: &File) -> Result<Identity, Failure> {
        let m = metadata(file)?;
        Ok(Identity {
            dev: m.dev(),
            ino: m.ino(),
        })
    }
    struct CapturedLockFixture {
        root: NamedDir,
        uid: u32,
        expected: Identity,
    }
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum LockObservation {
        Busy,
        AcquiredForFixture,
        Refused(Failure),
        CustodyUnknown,
    }
    impl CapturedLockFixture {
        fn validate(&self, file: &File) -> Result<(), Failure> {
            self.root.recheck(self.uid)?;
            if record_policy(file, self.uid)?.len() != 0 {
                return Err(Failure::Unsafe);
            }
            if identity(file)? != self.expected {
                return Err(Failure::Changed);
            }
            matches_name(&self.root.file, &CString::new(LOCK_NAME).unwrap(), file)
        }
        fn existing(&self) -> Result<File, Failure> {
            self.root.recheck(self.uid)?;
            let name = CString::new(LOCK_NAME).unwrap();
            // SAFETY: retained directory, fixed name, existing-only nonfollowing open.
            let fd = unsafe {
                libc::openat(
                    self.root.file.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDWR | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(os_error());
            }
            // SAFETY: own the fresh fd immediately before any fallible validation.
            let file = unsafe { File::from_raw_fd(fd) };
            self.validate(&file)?;
            Ok(file)
        }
        fn acquire(&self, file: &File) -> LockObservation {
            if let Err(error) = self.validate(file) {
                return LockObservation::Refused(error);
            }
            // SAFETY: live borrowed fd. No blocking wait, mutation or explicit unlock.
            let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if result != 0 {
                return if std::io::Error::last_os_error().raw_os_error() == Some(libc::EWOULDBLOCK)
                {
                    LockObservation::Busy
                } else {
                    LockObservation::Refused(Failure::Io)
                };
            }
            // A replaced name refuses, even if this fd locked an obsolete inode.
            if let Err(error) = self.validate(file) {
                return LockObservation::Refused(error);
            }
            LockObservation::AcquiredForFixture
        }
        fn independent_probe(&self) -> LockObservation {
            match self.existing() {
                Ok(file) => self.acquire(&file),
                Err(error) => LockObservation::Refused(error),
            }
            // File closes here. Never LOCK_UN: no lock custody escapes the fixture.
        }
    }
    // Synthetic close-policy case only. The retained File is not dropped when
    // observation becomes unknown; no forged kernel close error or retry exists.
    struct UnknownCustody {
        retained: File,
    }
    impl UnknownCustody {
        fn observe(&self) -> LockObservation {
            let _ = &self.retained;
            LockObservation::CustodyUnknown
        }
    }
    #[path = "lease_lifetime_tests.rs"]
    mod tests;
}
