//! Unreachable, read-only filesystem foundation. There is deliberately no production
//! constructor, account lookup, enrollment/admission result, writer or helper binary.
//! Initial publication experiments compile only in the private test module.
#![cfg(any(target_os = "macos", target_os = "linux"))]

use std::ffi::CString;
use std::fs::{File, Metadata};
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::MetadataExt;

const LIMIT: usize = 65_536;

/// Closed, credential-safe failures; never include paths, OS text or record bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    Denied,
    Unsafe,
    Changed,
    Unsupported,
    Io,
    Oversize,
    InvalidUtf8,
}

/// An observation is not authority, durable standing or a parsed enrollment record.
#[derive(PartialEq, Eq)]
pub enum Observation {
    Absent,
    Bytes(String),
}
impl std::fmt::Debug for Observation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Absent => f.write_str("Absent"),
            Self::Bytes(_) => f.write_str("Bytes([redacted])"),
        }
    }
}

struct NamedDir {
    parent: File,
    name: CString,
    file: File,
}

/// Descriptor-owning anchor. Only isolated unit tests can construct one in this slice.
/// Future discovery must separately prove OS identity, home and protected lineage.
pub struct ReadAnchor {
    root: NamedDir,
    uid: u32,
}

fn os_error() -> Failure {
    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::EACCES | libc::EPERM) => Failure::Denied,
        Some(libc::ELOOP | libc::ENOTDIR) => Failure::Unsafe,
        _ => Failure::Io,
    }
}
fn metadata(file: &File) -> Result<Metadata, Failure> {
    file.metadata().map_err(|_| Failure::Io)
}
fn same(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino() && a.mode() == b.mode() && a.uid() == b.uid()
}
fn stat_name(parent: &File, name: &CString) -> Result<libc::stat, Failure> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: valid live descriptor, NUL-terminated single component, valid output.
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(os_error());
    }
    // SAFETY: successful fstatat initialized stat.
    Ok(unsafe { stat.assume_init() })
}
fn prove_absent(parent: &File, name: &CString) -> Result<(), Failure> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: valid descriptor, generated component and valid output storage.
    let result = unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
        Ok(())
    } else {
        Err(Failure::Changed)
    }
}
fn matches_name(parent: &File, name: &CString, file: &File) -> Result<(), Failure> {
    let s = stat_name(parent, name).map_err(|_| Failure::Changed)?;
    let m = metadata(file)?;
    #[cfg(target_os = "macos")]
    let identity_matches = u64::try_from(s.st_dev).ok() == Some(m.dev())
        && s.st_mode == libc::mode_t::try_from(m.mode()).map_err(|_| Failure::Unsafe)?;
    #[cfg(target_os = "linux")]
    let identity_matches = s.st_dev == m.dev() && s.st_mode == m.mode();
    if !identity_matches || s.st_ino != m.ino() || s.st_uid != m.uid() {
        return Err(Failure::Changed);
    }
    Ok(())
}
fn directory(file: &File, uid: u32) -> Result<(), Failure> {
    let m = metadata(file)?;
    if !m.is_dir() || m.uid() != uid || m.mode() & 0o7777 != 0o700 {
        return Err(Failure::Unsafe);
    }
    acl(file)?;
    filesystem(file)
}
// Apply the same complete policy both before and after reading the held fd.
fn record_policy(file: &File, uid: u32) -> Result<Metadata, Failure> {
    let m = metadata(file)?;
    if !m.is_file() || m.uid() != uid || m.mode() & 0o7777 != 0o600 || m.nlink() != 1 {
        return Err(Failure::Unsafe);
    }
    if m.len() > LIMIT as u64 {
        return Err(Failure::Oversize);
    }
    acl(file)?;
    filesystem(file)?;
    Ok(m)
}
fn open_dir(parent: &File, name: &'static str, uid: u32) -> Result<Option<NamedDir>, Failure> {
    let name = CString::new(name).expect("fixed component");
    // SAFETY: valid live parent, fixed single component and flags, no output pointer.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY
                | libc::O_DIRECTORY
                | libc::O_NOFOLLOW
                | libc::O_NONBLOCK
                | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
            Ok(None)
        } else {
            Err(os_error())
        };
    }
    // SAFETY: successful openat returned a fresh owned descriptor.
    let file = unsafe { File::from_raw_fd(fd) };
    directory(&file, uid)?;
    let out = NamedDir {
        parent: parent.try_clone().map_err(|_| Failure::Io)?,
        name,
        file,
    };
    out.recheck(uid)?;
    Ok(Some(out))
}
impl NamedDir {
    fn recheck(&self, uid: u32) -> Result<(), Failure> {
        directory(&self.file, uid)?;
        matches_name(&self.parent, &self.name, &self.file)
    }
}

#[cfg(target_os = "macos")]
fn acl(file: &File) -> Result<(), Failure> {
    use std::ffi::c_void;
    unsafe extern "C" {
        fn acl_get_fd_np(fd: i32, kind: i32) -> *mut c_void;
        fn acl_get_entry(acl: *mut c_void, entry_id: i32, entry: *mut *mut c_void) -> i32;
        fn acl_get_tag_type(entry: *mut c_void, tag: *mut i32) -> i32;
        fn acl_free(ptr: *mut c_void) -> i32;
        fn acl_valid(acl: *mut c_void) -> i32;
    }
    // Strict initial policy: only deny entries, rejecting every allow and unknown tag.
    // SAFETY: system ACL API receives a live descriptor; pointers used only while ACL lives.
    unsafe {
        let a = acl_get_fd_np(file.as_raw_fd(), 0x100);
        if a.is_null() {
            // Darwin reports ENOENT for an absent extended ACL on a live fd.
            // This is ACL absence only; never registry/name absence.
            return if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
                Ok(())
            } else {
                Err(Failure::Unsafe)
            };
        }
        let result = (|| {
            if acl_valid(a) != 0 {
                return Err(Failure::Unsafe);
            }
            let mut entry = std::ptr::null_mut();
            let mut which = 0;
            for _ in 0..=169 {
                let status = acl_get_entry(a, which, &mut entry);
                if status == -1
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL)
                {
                    return Ok(());
                }
                if status != 0 {
                    return Err(Failure::Unsafe);
                }
                let mut tag = 0;
                if acl_get_tag_type(entry, &mut tag) != 0 || tag != 2 {
                    return Err(Failure::Unsafe);
                }
                which = -1;
            }
            Err(Failure::Unsafe)
        })();
        acl_free(a);
        result
    }
}
#[cfg(not(target_os = "macos"))]
fn acl(_file: &File) -> Result<(), Failure> {
    // Linux POSIX access ACL effective grants are bounded by mode bits, checked above.
    // Other Unix ACL models are unsupported by filesystem(). No writes/default-ACL use.
    Ok(())
}
fn filesystem(file: &File) -> Result<(), Failure> {
    let mut out = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: live descriptor and valid output. No path discovery occurs.
    if unsafe { libc::fstatfs(file.as_raw_fd(), out.as_mut_ptr()) } != 0 {
        return Err(Failure::Io);
    }
    // SAFETY: successful syscall initialized output.
    let s = unsafe { out.assume_init() };
    #[cfg(target_os = "macos")]
    {
        let name: Vec<u8> = s
            .f_fstypename
            .iter()
            .take_while(|b| **b != 0)
            .map(|b| *b as u8)
            .collect();
        if name == b"apfs" && s.f_flags & libc::MNT_RDONLY as u32 == 0 {
            return Ok(());
        }
    }
    // Linux 0xef53 identifies ext-family, NOT ext4 specifically. This read-only
    // observation filter proves no mount durability or enrollment support.
    #[cfg(all(target_os = "linux", any(target_env = "gnu", target_env = "musl")))]
    {
        // statfs supplies the family, but its public GNU layout has no f_flags.
        // Query POSIX mount flags separately on the SAME held descriptor.
        let read_only = mount_is_read_only(file.as_raw_fd())?;
        if s.f_type == 0xef53 && !read_only {
            return Ok(());
        }
    }
    Err(Failure::Unsupported)
}

#[cfg(any(
    all(target_os = "linux", any(target_env = "gnu", target_env = "musl")),
    test
))]
fn mount_is_read_only(fd: libc::c_int) -> Result<bool, Failure> {
    let mut out = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: valid output storage. fstatvfs handles invalid fds with an error;
    // production callers retain the File owning fd throughout the syscall.
    if unsafe { libc::fstatvfs(fd, out.as_mut_ptr()) } != 0 {
        return Err(Failure::Io);
    }
    // SAFETY: successful syscall initialized the public POSIX statvfs fields.
    let v = unsafe { out.assume_init() };
    Ok(v.f_flag & libc::ST_RDONLY != 0)
}

#[cfg(test)]
#[test]
fn descriptor_mount_flags_and_syscall_errors() {
    // Invoking command supplies an owned isolated TMPDIR; no OS-home lookup.
    let root = tempfile::tempdir().unwrap();
    let file = File::open(root.path()).unwrap();
    assert_eq!(mount_is_read_only(file.as_raw_fd()), Ok(false));
    assert_eq!(mount_is_read_only(-1), Err(Failure::Io));
}

impl ReadAnchor {
    /// Lookup by fixed 32-byte digest only. This never authenticates the selected DB.
    pub fn observe_expectation(&self, digest: [u8; 32]) -> Result<Observation, Failure> {
        self.observe(digest, |_| {})
    }
    fn observe(
        &self,
        digest: [u8; 32],
        mut barrier: impl FnMut(Stage),
    ) -> Result<Observation, Failure> {
        self.root.recheck(self.uid)?;
        let Some(registry) = open_dir(&self.root.file, ".toolroll-central", self.uid)? else {
            barrier(Stage::BeforeReturn);
            prove_absent(&self.root.file, &CString::new(".toolroll-central").unwrap())?;
            self.root.recheck(self.uid)?;
            return Ok(Observation::Absent);
        };
        let Some(entries) = open_dir(&registry.file, "expectations", self.uid)? else {
            barrier(Stage::BeforeReturn);
            prove_absent(&registry.file, &CString::new("expectations").unwrap())?;
            registry.recheck(self.uid)?;
            self.root.recheck(self.uid)?;
            return Ok(Observation::Absent);
        };
        barrier(Stage::ParentsOpened);
        let name = CString::new(format!(
            "{}.json",
            digest
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        ))
        .expect("hex only");
        // SAFETY: owned directory, generated single component, nofollow/nonblocking/cloexec.
        let fd = unsafe {
            libc::openat(
                entries.file.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        let result = if fd < 0 {
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
                barrier(Stage::BeforeReturn);
                prove_absent(&entries.file, &name)?;
                Observation::Absent
            } else {
                return Err(os_error());
            }
        } else {
            // SAFETY: fresh successful openat descriptor; File assumes sole ownership.
            let file = unsafe { File::from_raw_fd(fd) };
            let before = record_policy(&file, self.uid)?;
            let mut bytes = Vec::with_capacity(LIMIT + 1);
            barrier(Stage::FileOpened);
            (&file)
                .take((LIMIT + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|_| Failure::Io)?;
            if bytes.len() > LIMIT {
                return Err(Failure::Oversize);
            }
            barrier(Stage::BeforeReturn);
            let after = record_policy(&file, self.uid)?;
            if !same(&before, &after)
                || before.len() != after.len()
                || bytes.len() as u64 != before.len()
                || before.nlink() != after.nlink()
                || before.mtime() != after.mtime()
                || before.mtime_nsec() != after.mtime_nsec()
                || before.ctime() != after.ctime()
                || before.ctime_nsec() != after.ctime_nsec()
            {
                return Err(Failure::Changed);
            }
            matches_name(&entries.file, &name, &file)?;
            Observation::Bytes(String::from_utf8(bytes).map_err(|_| Failure::InvalidUtf8)?)
        };
        entries.recheck(self.uid)?;
        registry.recheck(self.uid)?;
        self.root.recheck(self.uid)?;
        Ok(result)
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    ParentsOpened,
    FileOpened,
    BeforeReturn,
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod initial;
