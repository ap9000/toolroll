//! Open a pane's text in the person's editor (ctrl-e). What leaves this screen, and how:
//!
//! - Only the pane's own already-cleaned text (search.rs pane_text: an agent's sign-in or install pane never), with any
//!   line an editor would read as settings (a vim modeline, an emacs `-*-` line or `Local Variables:` block) made inert
//!   first (`neutralise`): the text is partly an agent's, and an editor must never run what it says.
//! - Written under a trusted temporary folder only (`trusted_parent`: this user's and changeable by nobody else, or a
//!   sticky shared folder of root's or this user's, with every folder above it owned by root or this user and
//!   changeable by nobody else but through a sticky bit), in a private folder of ours there (`toolroll-exports-<uid>`,
//!   0700), in a fresh folder for this export (0700), as a new file (0600); every step relative to the folder opened
//!   just before it (openat, never following a link), so no name swapped in can redirect it.
//! - Right before the editor starts, the path given to it is checked to still be exactly the folders and file made
//!   (same device and inode, a plain file of this user's with one link), and every descriptor this process holds above
//!   the standard three is checked to be close-on-exec (`isolate`), or the editor doesn't start.
//! - The editor is a program and its arguments (`$VISUAL`, else `$EDITOR`, split on whitespace: never a shell line),
//!   with the switch that turns modelines or local variables off for vim and emacs.
//! - The export is removed when the editor ends, said truthfully when it can't be; on a panic too (the hook removes the
//!   live one). An abrupt kill (SIGKILL, power loss) can leave it until the next start, which reclaims every export of
//!   ours whose process is gone (`reclaim`).
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The editor command: `$VISUAL`, else `$EDITOR`, as a program and its arguments (split on whitespace: no shell, no
/// quoting, no expansion), plus the switch that keeps it from taking settings from the text. None: neither is set, or
/// it is blank, or its words can't be a command.
pub fn editor_command(visual: Option<&str>, editor: Option<&str>) -> Option<(String, Vec<String>)> {
    let raw = visual
        .filter(|v| !v.trim().is_empty())
        .or(editor.filter(|v| !v.trim().is_empty()))?;
    // Control characters in a command line are never what a person set.
    if raw.chars().any(|c| c.is_control() && c != '\t') {
        return None;
    }
    let mut words = raw.split_whitespace().map(str::to_string);
    let program = words.next()?;
    let mut args: Vec<String> = words.collect();
    args.extend(no_settings_from_text(&program));
    Some((program, args))
}

/// The switch that stops an editor taking settings from the text it opens, placed before the file: vim and its kin
/// read no modelines, emacs no local variables. (Others get none; the text is neutralised for every editor anyway.)
fn no_settings_from_text(program: &str) -> Vec<String> {
    let base = Path::new(program)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    match base {
        "vim" | "nvim" | "vi" | "view" | "gvim" | "mvim" | "vimdiff" | "nview" => {
            vec!["--cmd".into(), "set nomodeline".into()]
        }
        "emacs" => vec!["--eval".into(), "(setq enable-local-variables nil)".into()],
        _ => vec![],
    }
}

/// A colon an editor doesn't read as one (U+A789 MODIFIER LETTER COLON): it looks the same to a person.
const INERT_COLON: char = '\u{a789}';
/// The emacs file-variables marker made inert the same way (U+2217 ASTERISK OPERATOR in place of `*`).
const INERT_MARK: &str = "-\u{2217}-";
/// Lines vim reads modelines from at each end (its default `modelines`).
const MODELINE_LINES: usize = 5;

/// The text with every line an editor could take settings from made inert, by a lookalike character where the editor
/// looks for its own: a vim modeline (`vi:`, `vim:`, `vim600:`, `ex:` … after a space or at the line's start) in the
/// first or last 5 lines gets its colon replaced; an emacs `-*- … -*-` line gets its markers replaced, and every
/// `Local Variables:` gets its colon replaced (no block can start). A person reads the same words.
pub fn neutralise(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let n = lines.len();
    let mut out = Vec::with_capacity(n);
    for (i, line) in lines.iter().enumerate() {
        let mut l = line.to_string();
        if i < MODELINE_LINES || i + MODELINE_LINES + 1 >= n {
            l = inert_modeline(&l);
        }
        if l.matches("-*-").count() >= 2 {
            l = l.replace("-*-", INERT_MARK);
        }
        l = inert_local_variables(&l);
        out.push(l);
    }
    out.join("\n")
}

/// Every word starting `vi`, `vim` or `ex` (any case, at the start or after a space) whose colon ends it: that colon
/// made inert.
fn inert_modeline(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut word = String::new();
    // In a word that began at the line's start or after a space.
    let mut counted = true;
    for c in line.chars() {
        if c == ':' && counted && !word.is_empty() {
            let w = word.to_lowercase();
            if w.starts_with("vi") || w.starts_with("ex") {
                out.push(INERT_COLON);
                word.clear();
                counted = false;
                continue;
            }
        }
        out.push(c);
        if c.is_whitespace() {
            word.clear();
            counted = true;
        } else {
            word.push(c);
        }
    }
    out
}

fn inert_local_variables(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    let Some(at) = lower.find("local variables:") else {
        return line.to_string();
    };
    // ASCII lowercasing keeps byte offsets.
    let colon = at + "local variables".len();
    let rest = inert_local_variables(&line[colon + 1..]);
    format!("{}{INERT_COLON}{rest}", &line[..colon])
}

/// The export live now (its folder), removed by the panic hook if the screen dies while the editor has it.
static LIVE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Remove the live export, if any (the panic hook: release builds abort, so no destructor runs).
pub fn remove_live() {
    if let Ok(mut live) = LIVE.lock() {
        if let Some(dir) = live.take() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// The places an export may go, in order: `$TMPDIR` (else the system's), `$XDG_RUNTIME_DIR`, then the workbench's own
/// state folder. Each is trusted before use (`trusted_parent`).
pub fn places(env: &crate::settings::Env) -> Vec<PathBuf> {
    let mut out = vec![std::env::temp_dir()];
    if let Some(r) = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from) {
        out.push(r);
    }
    if let Some(dir) = crate::state::path(env).and_then(|p| p.parent().map(Path::to_path_buf)) {
        out.push(dir);
    }
    out.retain(|p| p.is_absolute());
    out
}

/// `dir` when an export may go under it: its real path a folder this user owns that nobody else can change, or a
/// sticky shared folder owned by root or this user (others can't rename or remove what is ours in it); every folder
/// above it owned by root or this user, and changeable by nobody else unless sticky. Anything else is named.
#[cfg(unix)]
pub fn trusted_parent(dir: &Path, me: u32) -> Result<PathBuf, String> {
    use std::os::unix::fs::MetadataExt;
    let real = std::fs::canonicalize(dir).map_err(|_| "it couldn't be read".to_string())?;
    let m = std::fs::symlink_metadata(&real).map_err(|_| "it couldn't be read".to_string())?;
    let sticky = m.mode() & 0o1000 != 0;
    let private = m.uid() == me && m.mode() & 0o022 == 0;
    let shared_ok = sticky && (m.uid() == 0 || m.uid() == me);
    if !m.is_dir() || !(private || shared_ok) {
        return Err(format!(
            "{} can be changed by other people",
            crate::text::clean(&real.display().to_string())
        ));
    }
    let mut at = real.parent();
    while let Some(d) = at {
        let m = std::fs::symlink_metadata(d)
            .map_err(|_| "a folder above it couldn't be read".to_string())?;
        let owner_ok = m.uid() == me || m.uid() == 0;
        let shared = m.mode() & 0o022 != 0;
        if !m.is_dir() || !owner_ok || (shared && m.mode() & 0o1000 == 0) {
            return Err(format!(
                "a folder above it ({}) can be changed by other people",
                crate::text::clean(&d.display().to_string())
            ));
        }
        at = d.parent();
    }
    Ok(real)
}

/// Every descriptor above the standard three, close-on-exec, checked: listed from /dev/fd, else every number up to the
/// open-files limit; any flag that can't be read or set (but a closed number) is an error, as is a limit too large to
/// walk. The editor starts only after this says Ok, so it never inherits the launcher's control descriptor or a socket.
#[cfg(unix)]
pub fn isolate() -> Result<(), String> {
    isolate_with(&listed_fds, &fd_limit, &cloexec)
}

#[cfg(not(unix))]
pub fn isolate() -> Result<(), String> {
    Err("Opening an editor isn't supported here.".into())
}

/// The most descriptor numbers walked when /dev/fd can't be listed.
const MAX_WALK: i64 = 1 << 16;

#[cfg(unix)]
fn listed_fds() -> Option<Vec<i32>> {
    let d = std::fs::read_dir("/dev/fd").ok()?;
    let mut out = vec![];
    for e in d {
        out.push(e.ok()?.file_name().to_str()?.parse::<i32>().ok()?);
    }
    Some(out)
}

#[cfg(unix)]
fn fd_limit() -> Option<i64> {
    let mut r = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: getrlimit writes into the struct given.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut r) } != 0
        || r.rlim_cur == libc::RLIM_INFINITY
    {
        return None;
    }
    i64::try_from(r.rlim_cur).ok()
}

/// isolate's work, with how descriptors are listed and the limit given (tests force each to fail).
#[cfg(unix)]
pub fn isolate_with(
    list: &dyn Fn() -> Option<Vec<i32>>,
    limit: &dyn Fn() -> Option<i64>,
    mark: &dyn Fn(i32) -> bool,
) -> Result<(), String> {
    const REFUSED: &str =
        "Couldn't make sure your editor gets nothing of Toolroll's open, so it wasn't started.";
    let fds: Vec<i32> = match list() {
        Some(fds) => fds,
        None => {
            let max = limit().filter(|m| *m <= MAX_WALK).ok_or(REFUSED)?;
            (3..max as i32).collect()
        }
    };
    for fd in fds.into_iter().filter(|fd| *fd > 2) {
        if !mark(fd) {
            return Err(REFUSED.into());
        }
    }
    Ok(())
}

/// Mark `fd` close-on-exec and check it: true when it is, or when the number isn't open.
#[cfg(unix)]
pub fn cloexec(fd: i32) -> bool {
    // SAFETY: fcntl on a descriptor number reads and sets only its flags.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        if flags == -1 {
            return std::io::Error::last_os_error().raw_os_error() == Some(libc::EBADF);
        }
        if libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) == -1 {
            return false;
        }
        let now = libc::fcntl(fd, libc::F_GETFD);
        now != -1 && now & libc::FD_CLOEXEC != 0
    }
}

/// Our own folder under a trusted place.
#[cfg(unix)]
fn root_name() -> String {
    // SAFETY: geteuid has no preconditions.
    format!("toolroll-exports-{}", unsafe { libc::geteuid() })
}

/// One export: the folders and file made, by path and by identity (device, inode), until removed.
#[derive(Debug)]
pub struct Export {
    pub root: PathBuf,
    pub dir: PathBuf,
    pub file: PathBuf,
    ids: [(u64, u64); 3],
    removed: bool,
}

#[cfg(unix)]
mod fs_at {
    use std::ffi::CString;
    use std::os::fd::{FromRawFd, OwnedFd, RawFd};

    fn cstr(s: &str) -> std::io::Result<CString> {
        CString::new(s).map_err(|_| std::io::Error::other("a name with a NUL"))
    }

    /// Open a folder (never through a link).
    pub fn open_dir(at: Option<RawFd>, path: &str) -> std::io::Result<OwnedFd> {
        let c = cstr(path)?;
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        // SAFETY: a valid C string; the descriptor returned is owned here.
        let fd = unsafe {
            match at {
                Some(at) => libc::openat(at, c.as_ptr(), flags),
                None => libc::open(c.as_ptr(), flags),
            }
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: fd is a fresh descriptor of ours.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    pub fn mkdir(at: RawFd, name: &str) -> std::io::Result<()> {
        let c = cstr(name)?;
        // SAFETY: a valid C string.
        if unsafe { libc::mkdirat(at, c.as_ptr(), 0o700 as libc::mode_t) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    /// A new file (never an existing one, never through a link), 0600.
    pub fn create(at: RawFd, name: &str) -> std::io::Result<std::fs::File> {
        let c = cstr(name)?;
        let flags =
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        // SAFETY: a valid C string; the descriptor returned is owned here.
        let fd = unsafe { libc::openat(at, c.as_ptr(), flags, 0o600 as libc::c_uint) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: fd is a fresh descriptor of ours.
        Ok(unsafe { std::fs::File::from_raw_fd(fd) })
    }

    /// (device, inode, uid, mode) of an open descriptor.
    pub fn stat(fd: RawFd) -> std::io::Result<(u64, u64, u32, u32)> {
        // SAFETY: fstat writes into the zeroed struct given.
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(fd, &mut st) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        #[allow(clippy::unnecessary_cast)]
        Ok((
            st.st_dev as u64,
            st.st_ino as u64,
            st.st_uid,
            st.st_mode as u32,
        ))
    }
}

#[cfg(unix)]
impl Export {
    /// Write `text` as a new export under `parent` (trusted first: trusted_parent).
    pub fn create(parent: &Path, name: &str, text: &str) -> Result<Export, String> {
        use std::io::Write;
        use std::os::fd::AsRawFd;
        // SAFETY: geteuid has no preconditions.
        let me = unsafe { libc::geteuid() };
        let parent = trusted_parent(parent, me)?;
        let fail = |_| "its private copy couldn't be made".to_string();
        let parent_s = parent
            .to_str()
            .ok_or("its folder's name isn't plain text")?;
        let pfd = fs_at::open_dir(None, parent_s).map_err(fail)?;
        // Our folder there: made if missing; used only when it is a folder of ours nobody else can enter.
        let root = root_name();
        match fs_at::mkdir(pfd.as_raw_fd(), &root) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(fail(e)),
        }
        let rfd = fs_at::open_dir(Some(pfd.as_raw_fd()), &root).map_err(fail)?;
        let private = |fd: &std::os::fd::OwnedFd| -> Result<(u64, u64), String> {
            let (dev, ino, uid, mode) = fs_at::stat(fd.as_raw_fd()).map_err(fail)?;
            if uid != me || mode & 0o077 != 0 {
                return Err("its private folder isn't private".into());
            }
            Ok((dev, ino))
        };
        let root_id = private(&rfd)?;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let sub = format!("pane-{}-{nanos}", std::process::id());
        fs_at::mkdir(rfd.as_raw_fd(), &sub).map_err(fail)?;
        let dir = parent.join(&root).join(&sub);
        if let Ok(mut live) = LIVE.lock() {
            *live = Some(dir.clone());
        }
        // From here, dropping the export removes the folder (any refusal below leaves nothing behind).
        let mut export = Export {
            root: parent.join(&root),
            dir: dir.clone(),
            file: PathBuf::new(),
            ids: [root_id, (0, 0), (0, 0)],
            removed: false,
        };
        let dfd = fs_at::open_dir(Some(rfd.as_raw_fd()), &sub).map_err(fail)?;
        export.ids[1] = private(&dfd)?;
        let safe: String = name
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .take(32)
            .collect();
        let file_name = format!("{}.txt", if safe.is_empty() { "pane" } else { &safe });
        let mut f = fs_at::create(dfd.as_raw_fd(), &file_name).map_err(fail)?;
        f.write_all(text.as_bytes()).map_err(fail)?;
        f.sync_all().map_err(fail)?;
        let (dev, ino, ..) = fs_at::stat(f.as_raw_fd()).map_err(fail)?;
        export.ids[2] = (dev, ino);
        export.file = dir.join(file_name);
        Ok(export)
    }

    /// The path given to the editor is still exactly what was made: the folders and the file by device and inode, the
    /// file a plain one of this user's, owner-only, with one link.
    pub fn verify(&self) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no preconditions.
        let me = unsafe { libc::geteuid() };
        let changed = || {
            "Its private copy changed before your editor started, so it wasn't started.".to_string()
        };
        for (path, (dev, ino)) in [&self.root, &self.dir, &self.file]
            .into_iter()
            .zip(self.ids)
        {
            let m = std::fs::symlink_metadata(path).map_err(|_| changed())?;
            if m.dev() != dev || m.ino() != ino || m.uid() != me || m.file_type().is_symlink() {
                return Err(changed());
            }
        }
        let m = std::fs::symlink_metadata(&self.file).map_err(|_| changed())?;
        if !m.file_type().is_file() || m.nlink() != 1 || m.mode() & 0o077 != 0 {
            return Err(changed());
        }
        Ok(())
    }

    /// Remove the export (its folder, and whatever the editor left in it: a swap or backup file is ours too), and say
    /// truthfully whether it is gone.
    pub fn remove(&mut self) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        if self.removed {
            return Ok(());
        }
        self.removed = true;
        if let Ok(mut live) = LIVE.lock() {
            *live = None;
        }
        let (dev, ino) = self.ids[1];
        let left = || {
            format!(
                "its copy couldn't be removed: {}",
                crate::text::clean(&self.dir.display().to_string())
            )
        };
        // Only the folder made (by identity, when known): a different one there now is left alone, and said.
        match std::fs::symlink_metadata(&self.dir) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(left()),
            Ok(m) if !m.is_dir() || (ino != 0 && (m.dev() != dev || m.ino() != ino)) => {
                return Err(left())
            }
            Ok(_) => {}
        }
        let _ = std::fs::remove_dir_all(&self.dir);
        let gone = match std::fs::symlink_metadata(&self.dir) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            _ => Err(left()),
        };
        // Our own folder there, when nothing is left in it: removed too (by identity; never one that isn't ours).
        let (rdev, rino) = self.ids[0];
        remove_root_if_empty(&self.root, rdev, rino);
        gone
    }
}

/// Our exports folder (`toolroll-exports-<uid>`), removed when it is empty: only that exact folder (device and inode
/// when known), this user's, never a link. `remove_dir` itself refuses a folder with anything in it.
#[cfg(unix)]
fn remove_root_if_empty(root: &Path, dev: u64, ino: u64) {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: geteuid has no preconditions.
    let me = unsafe { libc::geteuid() };
    let Ok(m) = std::fs::symlink_metadata(root) else {
        return;
    };
    let same = ino == 0 || (m.dev() == dev && m.ino() == ino);
    if !m.is_dir() || m.uid() != me || !same {
        return;
    }
    let empty = std::fs::read_dir(root).is_ok_and(|mut d| d.next().is_none());
    if empty {
        let _ = std::fs::remove_dir(root);
    }
}

impl Drop for Export {
    /// Removed on any way out of scope (a refusal while it is made, or unwinding in a debug build).
    fn drop(&mut self) {
        #[cfg(unix)]
        let _ = self.remove();
    }
}

/// Exports left by a screen that ended abruptly: in our own folder under each trusted place, every `pane-<pid>-…`
/// folder of this user's (never a link) whose process is gone, removed. Anything else there is left alone. Returns how
/// many were removed.
#[cfg(unix)]
pub fn reclaim(places: &[PathBuf]) -> usize {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: geteuid has no preconditions.
    let me = unsafe { libc::geteuid() };
    let mut removed = 0;
    for place in places {
        let Ok(parent) = trusted_parent(place, me) else {
            continue;
        };
        let root = parent.join(root_name());
        let Ok(m) = std::fs::symlink_metadata(&root) else {
            continue;
        };
        if !m.is_dir() || m.uid() != me || m.mode() & 0o077 != 0 {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for e in entries.flatten() {
            let name = e.file_name();
            let Some(pid) = name
                .to_str()
                .and_then(|n| n.strip_prefix("pane-"))
                .and_then(|n| n.split('-').next())
                .and_then(|p| p.parse::<i32>().ok())
            else {
                continue;
            };
            if alive(pid) {
                continue;
            }
            let path = e.path();
            let Ok(m) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if m.is_dir() && m.uid() == me && std::fs::remove_dir_all(&path).is_ok() {
                removed += 1;
            }
        }
        // Nothing left in it: our folder goes too.
        if let Ok(m) = std::fs::symlink_metadata(&root) {
            remove_root_if_empty(&root, m.dev(), m.ino());
        }
    }
    removed
}

#[cfg(not(unix))]
pub fn reclaim(_places: &[PathBuf]) -> usize {
    0
}

/// Whether process `pid` still runs (signal 0; EPERM means it runs as someone else).
#[cfg(unix)]
fn alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 only checks the process exists.
    unsafe {
        libc::kill(pid, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

/// How descriptors are checked before the editor starts (isolate, or a test's).
pub type Isolate = Box<dyn Fn() -> Result<(), String>>;

/// What the editor is given: its program and arguments, and the export (removed when finished, or dropped).
pub struct Launch {
    pub program: String,
    pub args: Vec<String>,
    pub export: Export,
    isolate: Isolate,
}

/// Everything before the screen is given up: the editor named, descriptors isolated, the text neutralised and written
/// privately under the first trusted place. Any refusal is said, and nothing is left behind.
#[cfg(unix)]
pub fn prepare(
    name: &str,
    text: &str,
    editor: Option<(String, Vec<String>)>,
    places: &[PathBuf],
    isolate: Isolate,
) -> Result<Launch, String> {
    let (program, args) =
        editor.ok_or_else(|| "Set $EDITOR (or $VISUAL) to open it in your editor.".to_string())?;
    isolate()?;
    let text = neutralise(text);
    let mut why = String::from("none was given");
    for place in places {
        match Export::create(place, name, &text) {
            Ok(export) => {
                return Ok(Launch {
                    program,
                    args,
                    export,
                    isolate,
                })
            }
            Err(e) => why = e,
        }
    }
    Err(format!(
        "No private place to put it for your editor ({why})."
    ))
}

#[cfg(unix)]
impl Launch {
    /// The editor's command, built only after the descriptors are checked again and the path still is the export made.
    pub fn command(&self) -> Result<std::process::Command, String> {
        (self.isolate)()?;
        self.export.verify()?;
        let mut c = std::process::Command::new(&self.program);
        c.args(&self.args).arg(&self.export.file);
        Ok(c)
    }

    /// The export removed: Ok, or the words saying it is still there.
    pub fn finish(mut self) -> Result<(), String> {
        self.export.remove()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_editor_is_a_program_and_words_never_a_shell_line() {
        assert_eq!(
            editor_command(None, Some("nano -R")),
            Some(("nano".into(), vec!["-R".into()]))
        );
        assert_eq!(
            editor_command(Some("code --wait"), Some("vi")),
            Some(("code".into(), vec!["--wait".into()]))
        );
        assert_eq!(editor_command(None, None), None);
        // Shell syntax is just words: `;` is an argument, never a second command.
        assert_eq!(
            editor_command(None, Some("nano; rm -rf ~")),
            Some(("nano;".into(), vec!["rm".into(), "-rf".into(), "~".into()]))
        );
        assert_eq!(editor_command(None, Some("vi\u{1b}]52")), None);
    }

    #[test]
    fn vim_and_emacs_are_told_to_read_no_settings_from_the_text() {
        assert_eq!(
            editor_command(None, Some("/usr/bin/vim -R")),
            Some((
                "/usr/bin/vim".into(),
                vec!["-R".into(), "--cmd".into(), "set nomodeline".into()]
            ))
        );
        for vi in ["nvim", "vi", "view"] {
            let (_, args) = editor_command(Some(vi), None).unwrap();
            assert_eq!(args, vec!["--cmd", "set nomodeline"], "{vi}");
        }
        let (_, args) = editor_command(None, Some("emacs -nw")).unwrap();
        assert_eq!(
            args,
            vec!["-nw", "--eval", "(setq enable-local-variables nil)"]
        );
        // emacsclient's --eval would read the file's name as code: it gets nothing (the text is neutralised anyway).
        assert!(editor_command(None, Some("emacsclient"))
            .unwrap()
            .1
            .is_empty());
    }

    #[test]
    fn modelines_and_local_variables_are_made_inert() {
        let text = "# vim: set foldexpr=system('x'):\nplain words: kept\n/* -*- eval: (shell-command \"x\") -*- */\nmid\nmid\nmid\nmid\nfine vim: in the middle\nmid\nmid\n;; Local Variables:\n;; eval: (x)\n;; End:\n ex:set ts=1\nlast vi:x\n";
        let out = neutralise(text);
        assert!(
            !out.contains("vim:") || out.contains("fine vim: in the middle"),
            "{out}"
        );
        assert!(
            !out.contains("# vim:") && !out.contains(" ex:") && !out.contains(" vi:"),
            "{out}"
        );
        assert!(!out.contains("-*-"), "{out}");
        assert!(!out.to_lowercase().contains("local variables:"), "{out}");
        // Out of vim's reach (the middle lines): kept as it was; other colons kept.
        assert!(out.contains("fine vim: in the middle"), "{out}");
        assert!(out.contains("plain words: kept"));
        // A person reads the same words.
        assert!(out.contains("# vim\u{a789} set"));
        assert_eq!(out.lines().count(), text.lines().count());
        // Case and versions too; a word not at a space's edge is no modeline.
        assert!(!neutralise("Vim600:set x").contains(':'));
        assert!(!neutralise("x LOCAL VARIABLES:").contains(':'));
        assert_eq!(neutralise("devim: x"), "devim: x");
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_enumeration_refuses_the_editor() {
        // Neither /dev/fd nor a limit: refused.
        assert!(isolate_with(&|| None, &|| None, &cloexec).is_err());
        // A limit too large to walk: refused.
        assert!(isolate_with(&|| None, &|| Some(i64::MAX), &cloexec).is_err());
        // A walkable limit: Ok.
        assert!(isolate_with(&|| None, &|| Some(64), &cloexec).is_ok());
        // A descriptor whose flag can't be set: refused.
        assert!(isolate_with(&|| Some(vec![0, 1, 2, 7]), &|| None, &|fd| fd != 7).is_err());
        assert!(isolate_with(&|| Some(vec![0, 1, 2, 7]), &|| None, &|_| true).is_ok());
        // The spawn is refused, and nothing is written.
        let base = std::env::temp_dir().join(format!("tr-iso-{}", std::process::id()));
        let r = prepare(
            "live",
            "text",
            Some(("true".into(), vec![])),
            std::slice::from_ref(&base),
            Box::new(|| isolate_with(&|| None, &|| None, &cloexec)),
        );
        assert!(r.is_err());
        assert!(!base.exists());
    }

    #[cfg(unix)]
    #[test]
    fn descriptors_are_checked_again_right_before_the_editor_starts() {
        let base = private_base("again", 0o700);
        let calls = std::rc::Rc::new(std::cell::Cell::new(0));
        let c = calls.clone();
        let launch = prepare(
            "live",
            "text",
            Some(("true".into(), vec![])),
            std::slice::from_ref(&base),
            Box::new(move || {
                c.set(c.get() + 1);
                if c.get() == 1 {
                    Ok(())
                } else {
                    isolate_with(&|| None, &|| None, &cloexec)
                }
            }),
        )
        .unwrap();
        assert!(launch.command().is_err());
        assert_eq!(calls.get(), 2);
        launch.finish().unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn no_descriptor_reaches_the_editor() {
        use std::os::fd::AsRawFd;
        let f = std::fs::File::open("/dev/null").unwrap();
        let fd = f.as_raw_fd();
        // SAFETY: clearing the flag on our own open descriptor.
        unsafe { libc::fcntl(fd, libc::F_SETFD, 0) };
        isolate().unwrap();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        assert_ne!(flags & libc::FD_CLOEXEC, 0);
    }

    #[cfg(unix)]
    fn private_base(tag: &str, mode: u32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let base = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("tr-editor-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(mode)).unwrap();
        base
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_private_new_verified_and_gone_after() {
        use std::os::unix::fs::MetadataExt;
        let base = private_base("ok", 0o700);
        let launch = prepare(
            "live/../x",
            "line one\nline two\n",
            Some(("true".into(), vec![])),
            std::slice::from_ref(&base),
            Box::new(isolate),
        )
        .unwrap();
        let e = &launch.export;
        assert_eq!(std::fs::metadata(&e.root).unwrap().mode() & 0o777, 0o700);
        assert_eq!(std::fs::metadata(&e.dir).unwrap().mode() & 0o777, 0o700);
        assert_eq!(std::fs::metadata(&e.file).unwrap().mode() & 0o777, 0o600);
        assert_eq!(e.file.file_name().unwrap(), "livex.txt");
        assert_eq!(
            std::fs::read_to_string(&e.file).unwrap(),
            "line one\nline two\n"
        );
        assert!(launch.command().unwrap().status().unwrap().success());
        let dir = launch.export.dir.clone();
        let root = launch.export.root.clone();
        launch.finish().unwrap();
        assert!(!dir.exists());
        // Our folder, empty now, went too; the place it was in stays.
        assert!(!root.exists(), "an empty exports folder was left");
        assert!(base.exists());
        // Not empty (another export of ours in it): it stays.
        let one = prepare(
            "a",
            "x",
            Some(("true".into(), vec![])),
            std::slice::from_ref(&base),
            Box::new(isolate),
        )
        .unwrap();
        let two = prepare(
            "b",
            "x",
            Some(("true".into(), vec![])),
            std::slice::from_ref(&base),
            Box::new(isolate),
        )
        .unwrap();
        let root = one.export.root.clone();
        one.finish().unwrap();
        assert!(root.exists(), "removed while another export was in it");
        two.finish().unwrap();
        assert!(!root.exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn our_folder_there_must_be_private() {
        use std::os::unix::fs::DirBuilderExt;
        let base = private_base("open", 0o700);
        std::fs::DirBuilder::new()
            .mode(0o755)
            .create(base.join(root_name()))
            .unwrap();
        let r = prepare(
            "live",
            "text",
            Some(("true".into(), vec![])),
            std::slice::from_ref(&base),
            Box::new(isolate),
        );
        assert!(
            matches!(&r, Err(w) if w.contains("isn't private")),
            "{:?}",
            r.as_ref().err()
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn a_swapped_file_never_reaches_the_editor() {
        let base = private_base("swap", 0o700);
        let launch = prepare(
            "live",
            "text",
            Some(("true".into(), vec![])),
            std::slice::from_ref(&base),
            Box::new(isolate),
        )
        .unwrap();
        let f = launch.export.file.clone();
        std::fs::remove_file(&f).unwrap();
        std::os::unix::fs::symlink("/etc/hosts", &f).unwrap();
        assert!(launch.command().is_err());
        launch.finish().unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn a_removal_that_fails_is_said() {
        use std::os::unix::fs::PermissionsExt;
        let base = private_base("stuck", 0o700);
        let mut launch = prepare(
            "live",
            "text",
            Some(("true".into(), vec![])),
            std::slice::from_ref(&base),
            Box::new(isolate),
        )
        .unwrap();
        // Our folder made unwritable: the export can't be removed, and that is said (not claimed gone).
        let root = launch.export.root.clone();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o500)).unwrap();
        let said = launch.export.remove();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(
            matches!(&said, Err(w) if w.contains("couldn't be removed")),
            "{said:?}"
        );
        launch.export.removed = false;
        launch.finish().unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn a_shared_temp_folder_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        // Group-writable, not sticky: refused, nothing written.
        let base = private_base("shared", 0o770);
        let r = prepare(
            "live",
            "text",
            Some(("true".into(), vec![])),
            std::slice::from_ref(&base),
            Box::new(isolate),
        );
        let Err(why) = r else {
            panic!("accepted a shared folder")
        };
        assert!(why.contains("changed by other people"), "{why}");
        assert_eq!(std::fs::read_dir(&base).unwrap().count(), 0);
        // Sticky and this user's: accepted.
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o1777)).unwrap();
        // SAFETY: geteuid has no preconditions.
        assert!(trusted_parent(&base, unsafe { libc::geteuid() }).is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn stale_exports_are_reclaimed_and_live_ones_kept() {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        let base = private_base("reclaim", 0o700);
        let root = base.join(root_name());
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&root)
            .unwrap();
        // A process that has ended: its pid.
        let mut gone = std::process::Command::new("true").spawn().unwrap();
        let gone_pid = gone.id();
        gone.wait().unwrap();
        let stale = root.join(format!("pane-{gone_pid}-1"));
        let live = root.join(format!("pane-{}-1", std::process::id()));
        let other = root.join("notes");
        for d in [&stale, &live, &other] {
            std::fs::create_dir(d).unwrap();
            std::fs::write(d.join("x.txt"), "x").unwrap();
        }
        assert_eq!(reclaim(std::slice::from_ref(&base)), 1);
        assert!(!stale.exists() && live.exists() && other.exists());
        // Its folder had more in it: it stays.
        assert!(root.exists());
        // Our folder there not private: nothing is touched.
        std::fs::create_dir(&stale).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(reclaim(std::slice::from_ref(&base)), 0);
        assert!(stale.exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
