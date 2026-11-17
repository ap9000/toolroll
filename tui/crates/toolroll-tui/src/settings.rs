//! The terminal workbench's own settings: `tui.toml` in the person's config folder (`$XDG_CONFIG_HOME/toolroll/` when
//! that is set, else `~/.config/toolroll/`). Read once at start. The Settings screen changes the common choices (theme,
//! density, glyphs, notifications) and writes them back (write_safely): only those lines change, every comment and
//! other key is kept, and the file is replaced whole (a temporary file renamed over it, mode 0600) under the same
//! ownership rules the reader keeps.
//!
//! `list-side` / `list_side` and `focus-follows-mouse` / `focus_follows_mouse` accept either spelling. When both
//! occur, kebab-case wins regardless of line order (an invalid value uses the default). Writes set kebab-case,
//! preserving snake-case lines and their comments untouched. Repeats of the same spelling still use the first.
//!
//! Strict: a key it doesn't know is named in a warning and ignored; a value it can't use falls back to the default,
//! saying so; a line it can't read is skipped, saying so. The file is read only when it is a plain file owned by this
//! user that nobody else can change, in a folder nobody else can change; otherwise it is ignored, saying why.
//!
//! ```toml
//! theme = "terminal"          # terminal | light | dark | high-contrast
//! density = "compact"         # compact | comfortable
//! key-bar = true
//! show-costs = true
//! columns = ["step"]          # any of agent, step, age, cost, project
//! glyphs = "unicode"          # unicode | ascii | nerd
//! bell = true
//! reduced-motion = false
//! tmux-passthrough = false    # true: desktop notifications inside tmux (needs tmux's allow-passthrough on)
//!
//! [notifications]
//! asks = true
//! finished = false
//! failed = true
//!
//! [colors]                    # any role: paper, ink, muted, line, selection, selection-ink,
//! running = "#5aa9ff"         # needs-you, running, passed, failed, ground, raised, fill,
//!                             # running-soft, passed-soft, failed-soft
//!
//! [keys]                      # keys.rs: a preset, then any action's keys
//! preset = "default"          # default | vim | emacs
//! accept = "a"                # one key, or a list: palette = [":", "ctrl-k"]
//! ```
use crate::notify::Reach;
use crate::text::{clean, fit};
use crate::theme::{Depth, Glyphs, Rgb, Role, Theme, ThemeName};
use ratatui::text::{Line, Span};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Bigger than this is not a settings file.
pub const MAX_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Density {
    Compact,
    Comfortable,
}

impl Density {
    pub fn key(self) -> &'static str {
        match self {
            Density::Compact => "compact",
            Density::Comfortable => "comfortable",
        }
    }
    pub fn next(self) -> Density {
        match self {
            Density::Compact => Density::Comfortable,
            Density::Comfortable => Density::Compact,
        }
    }
}

/// What the Settings screen changes (and writes to tui.toml).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Choice {
    Theme,
    Density,
    Glyphs,
    ListSide,
    Asks,
    Finished,
    Failed,
}

impl Choice {
    pub const ALL: [Choice; 7] = [
        Choice::Theme,
        Choice::Density,
        Choice::Glyphs,
        Choice::ListSide,
        Choice::Asks,
        Choice::Finished,
        Choice::Failed,
    ];
    pub fn label(self) -> &'static str {
        match self {
            Choice::Theme => "Theme",
            Choice::Density => "Density",
            Choice::Glyphs => "Glyphs",
            Choice::ListSide => "List side",
            Choice::Asks => "Notify: asks",
            Choice::Finished => "Notify: finished",
            Choice::Failed => "Notify: failed",
        }
    }
    /// Where it lives in tui.toml: its section ("" for the top) and key.
    pub fn place(self) -> (&'static str, &'static str) {
        match self {
            Choice::Theme => ("", "theme"),
            Choice::Density => ("", "density"),
            Choice::Glyphs => ("", "glyphs"),
            Choice::ListSide => ("", "list-side"),
            Choice::Asks => ("notifications", "asks"),
            Choice::Finished => ("notifications", "finished"),
            Choice::Failed => ("notifications", "failed"),
        }
    }
    /// The next value, applied to these settings; and that value as tui.toml writes it.
    pub fn step(self, s: &mut Settings) -> String {
        let flip = |b: &mut bool| {
            *b = !*b;
            b.to_string()
        };
        match self {
            Choice::Theme => {
                s.theme = s.theme.next();
                format!("\"{}\"", s.theme.key())
            }
            Choice::Density => {
                s.density = s.density.next();
                format!("\"{}\"", s.density.key())
            }
            Choice::Glyphs => {
                let at = Glyphs::ALL.iter().position(|g| *g == s.glyphs).unwrap_or(0);
                s.glyphs = Glyphs::ALL[(at + 1) % Glyphs::ALL.len()];
                format!("\"{}\"", s.glyphs.key())
            }
            Choice::ListSide => {
                s.list_side = s.list_side.other();
                format!("\"{}\"", s.list_side.key())
            }
            Choice::Asks => flip(&mut s.notify.asks),
            Choice::Finished => flip(&mut s.notify.finished),
            Choice::Failed => flip(&mut s.notify.failed),
        }
    }
    /// Its value in words now.
    pub fn words(self, s: &Settings) -> String {
        let on = |b: bool| if b { "on" } else { "off" }.to_string();
        match self {
            Choice::Theme => s.theme.key().to_string(),
            Choice::Density => s.density.key().to_string(),
            Choice::Glyphs => s.glyphs.key().to_string(),
            Choice::ListSide => s.list_side.key().to_string(),
            Choice::Asks => on(s.notify.asks),
            Choice::Finished => on(s.notify.finished),
            Choice::Failed => on(s.notify.failed),
        }
    }
}

/// The comment a tui.toml written fresh starts with.
pub const FRESH_HEAD: &str = "# Toolroll's terminal workbench settings. The Settings screen (? then s) writes the common ones;\n# every key is in docs, and a [keys] table changes any key: [keys] preset = \"vim\"\n";

/// tui.toml's text with one setting set to `value` (already written as TOML): the line that sets it is rewritten in
/// place (its indentation and comment kept), else the line is added to its section (the section made when missing).
/// Writes use kebab-case for accepted snake-case aliases; alias lines are left untouched.
/// Every other line, comment and key is kept as it was.
pub fn set_in_toml(text: &str, section: &str, key: &str, value: &str) -> String {
    let key = canonical_key(section, key);
    let dotted = format!("{section}.{key}");
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let mut current = String::new();
    let mut found = false;
    // Where to add it when no line sets it: after the section's last line that holds something.
    let mut header_at: Option<usize> = None;
    let mut last_in_section: Option<usize> = None;
    let mut first_header: Option<usize> = None;
    for (i, raw) in lines.iter_mut().enumerate() {
        let body = without_comment(raw);
        let trimmed = body.trim();
        if let Some(name) = trimmed.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            current = name.trim().to_string();
            first_header.get_or_insert(i);
            if current == section {
                header_at = Some(i);
            }
            continue;
        }
        if current == section && !trimmed.is_empty() {
            last_in_section = Some(i);
        }
        let Some((k, _)) = trimmed.split_once('=') else {
            continue;
        };
        let k = k.trim();
        let k = quoted(k)
            .filter(|(_, rest)| rest.is_empty())
            .map(|(q, _)| q)
            .unwrap_or_else(|| k.to_string());
        let hits = (current == section && k == key)
            || (current.is_empty() && !section.is_empty() && k == dotted);
        if hits {
            let indent: String = raw.chars().take_while(|c| c.is_whitespace()).collect();
            let comment = raw[body.len()..].to_string();
            let spacer = if comment.is_empty() { "" } else { "  " };
            *raw = format!("{indent}{k} = {value}{spacer}{}", comment.trim_start());
            found = true;
        }
    }
    if !found {
        let line = format!("{key} = {value}");
        if section.is_empty() {
            match first_header {
                Some(at) => {
                    let at = lines[..at]
                        .iter()
                        .rposition(|l| !l.trim().is_empty())
                        .map_or(0, |p| p + 1);
                    lines.insert(at, line);
                }
                None => lines.push(line),
            }
        } else if let Some(h) = header_at {
            lines.insert(last_in_section.unwrap_or(h).max(h) + 1, line);
        } else {
            if lines.last().is_some_and(|l| !l.trim().is_empty()) {
                lines.push(String::new());
            }
            lines.push(format!("[{section}]"));
            lines.push(line);
        }
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

/// `dir` opened by walking down from `/` one name at a time, each opened relative to the folder before it with
/// O_DIRECTORY|O_NOFOLLOW (never through a link) and judged by fstat on that open descriptor: owned by this user (or
/// root, above the last), changeable by nobody else, except a sticky shared folder (/tmp) strictly above the home
/// folder. So the chain judged IS the chain opened: no folder swapped in by name between a check and an open can
/// redirect anything. `dir` must be absolute and plain (no `..`, no link anywhere in it: callers give a real path).
/// A name missing on the way: made (mode 0700, relative to its open parent) when `create`, else Ok(None).
#[cfg(unix)]
pub(crate) fn walk_trusted(
    dir: &Path,
    home: Option<&Path>,
    me: u32,
    create: bool,
) -> Result<Option<std::os::fd::OwnedFd>, String> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Component;
    let names: Vec<&std::ffi::OsStr> = {
        let mut out = vec![];
        let mut parts = dir.components();
        if parts.next() != Some(Component::RootDir) {
            return Err("its folder isn't an absolute path".into());
        }
        for part in parts {
            match part {
                Component::Normal(n) => out.push(n),
                Component::CurDir => {}
                _ => return Err("its folder's path isn't plain".into()),
            }
        }
        out
    };
    let home = home.and_then(|h| std::fs::canonicalize(h).ok());
    const FLAGS: libc::c_int =
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // SAFETY: a valid C string; the descriptor is owned below.
    let raw = unsafe { libc::open(c"/".as_ptr(), FLAGS) };
    if raw < 0 {
        return Err("a folder above it can't be looked at".into());
    }
    // SAFETY: raw was just opened by this call.
    let mut fd = unsafe { OwnedFd::from_raw_fd(raw) };
    let mut at = PathBuf::from("/");
    let judge_open = |fd: &OwnedFd, at: &Path, own: bool| -> Result<(), String> {
        // SAFETY: a zeroed stat is valid storage for fstat to fill.
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        // SAFETY: fd is open; st is valid storage.
        if unsafe { libc::fstat(fd.as_raw_fd(), &mut st) } != 0 {
            return Err("a folder above it can't be looked at".into());
        }
        let mode = st.st_mode as u32;
        let owner_ok = st.st_uid == me || (!own && st.st_uid == 0);
        let shared = mode & 0o022 != 0;
        let above_home = home
            .as_deref()
            .is_some_and(|h| h != at && h.starts_with(at));
        let sticky_ok = !own && mode & 0o1000 != 0 && above_home;
        // Compared in the platform's own mode_t (u16 on macOS, u32 on Linux): no cast either way.
        let is_dir = st.st_mode & libc::S_IFMT == libc::S_IFDIR;
        if !is_dir || !owner_ok || (shared && !sticky_ok) {
            return Err(if own {
                "its folder can be changed by other people, or isn't yours".to_string()
            } else {
                format!(
                    "a folder above it ({}) can be changed by other people, or isn't yours or the system's",
                    clean(&at.display().to_string())
                )
            });
        }
        Ok(())
    };
    judge_open(&fd, &at, names.is_empty())?;
    for (i, name) in names.iter().enumerate() {
        let own = i + 1 == names.len();
        let c = CString::new(name.as_bytes()).map_err(|_| "its name can't be used".to_string())?;
        // SAFETY: fd is open; c is a valid C string.
        let mut next = unsafe { libc::openat(fd.as_raw_fd(), c.as_ptr(), FLAGS) };
        if next < 0 {
            let err = std::io::Error::last_os_error().raw_os_error();
            match err {
                Some(libc::ENOENT) if create => {
                    // SAFETY: fd is open; c is a valid C string.
                    let made = unsafe { libc::mkdirat(fd.as_raw_fd(), c.as_ptr(), 0o700) };
                    if made != 0
                        && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST)
                    {
                        return Err("its folder couldn't be made".into());
                    }
                    // SAFETY: as above.
                    next = unsafe { libc::openat(fd.as_raw_fd(), c.as_ptr(), FLAGS) };
                    if next < 0 {
                        return Err("its folder couldn't be opened".into());
                    }
                }
                Some(libc::ENOENT) => return Ok(None),
                Some(libc::ELOOP) | Some(libc::ENOTDIR) => {
                    return Err(format!(
                        "a folder on its way ({}) is a link or not a folder",
                        clean(&at.join(name).display().to_string())
                    ))
                }
                _ => return Err("a folder above it can't be looked at".into()),
            }
        }
        // SAFETY: next was just opened by this call.
        fd = unsafe { OwnedFd::from_raw_fd(next) };
        at.push(name);
        judge_open(&fd, &at, own)?;
    }
    Ok(Some(fd))
}

/// An exclusive lock (flock) on an open folder, waited for up to two seconds; released when the descriptor closes.
#[cfg(unix)]
pub(crate) fn lock_dir(fd: &std::os::fd::OwnedFd) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    for _ in 0..200 {
        // SAFETY: fd is open.
        if unsafe { libc::flock(fd.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    Err("another change to it is being written; try again".into())
}

/// `dir` as a real path for walk_trusted: its longest existing part with links resolved (by name; the walk then
/// re-checks every step by descriptor and refuses a link it meets), and the rest as given.
#[cfg(unix)]
pub(crate) fn real_path_of(dir: &Path) -> PathBuf {
    let mut base = Some(dir);
    let mut rest: Vec<&std::ffi::OsStr> = vec![];
    while let Some(b) = base {
        if let Ok(real) = std::fs::canonicalize(b) {
            let mut out = real;
            for r in rest.iter().rev() {
                out.push(r);
            }
            return out;
        }
        match b.file_name() {
            Some(n) => rest.push(n),
            None => break,
        }
        base = b.parent();
    }
    dir.to_path_buf()
}

/// Write tui.toml with `change` made to its text, safely. Every folder from `/` down to the file's is opened and judged
/// by descriptor (walk_trusted; a missing one made, mode 0700, relative to its open parent), the folder is locked
/// against another writer (lock_dir), and everything else is done relative to that open folder, so no folder swapped in by name can
/// redirect it: the file there is read only when it is a plain file of this user's nobody else can change (a link is
/// never written through), and the new text goes to a fresh temporary file in it (mode 0600, never following a link),
/// synced, then renamed over the name in the same folder, so the file is never half-written. No file: a fresh one.
#[cfg(unix)]
pub fn write_safely(
    path: &Path,
    home: Option<&Path>,
    change: &dyn Fn(&str) -> String,
) -> Result<(), String> {
    write_within(path, home, FRESH_HEAD, MAX_BYTES, false, change)
}

/// write_safely's road for any file of ours: `fresh` is the text a missing file starts from, `max` its size cap, and
/// `private` (the view state, view.rs-adjacent viewstate.rs) also refuses a file there that others can read.
#[cfg(unix)]
pub(crate) fn write_within(
    path: &Path,
    home: Option<&Path>,
    fresh: &str,
    max: u64,
    private: bool,
    change: &dyn Fn(&str) -> String,
) -> Result<(), String> {
    write_with_backup(path, home, fresh, max, private, false, change).map(|_| ())
}

/// The same descriptor walk and lock as every settings write. A reset's backup is made from the locked read,
/// exclusively created (never replacing an earlier backup), before the settings file is replaced.
#[cfg(unix)]
pub(crate) fn write_with_backup(
    path: &Path,
    home: Option<&Path>,
    fresh: &str,
    max: u64,
    private: bool,
    backup: bool,
    change: &dyn Fn(&str) -> String,
) -> Result<Option<String>, String> {
    use std::ffi::CString;
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    // SAFETY: geteuid has no preconditions.
    let me = unsafe { libc::geteuid() };
    let dir = path.parent().ok_or("it has no folder")?;
    let name = path.file_name().ok_or("it has no name")?;
    // Every folder from `/` down, opened and judged by descriptor (walk_trusted), a missing one made (0700) relative
    // to its open parent: the folder written in is the one judged, never one swapped in by name.
    let dfd =
        walk_trusted(&real_path_of(dir), home, me, true)?.ok_or("its folder couldn't be made")?;
    // One writer at a time (the Settings screen, an agent's change, a reset): an exclusive lock on the open folder,
    // held until this write is done, so the text read below is the text replaced.
    lock_dir(&dfd)?;
    let c = |bytes: &[u8]| CString::new(bytes).map_err(|_| "its name can't be used".to_string());
    let name_c = c(name.as_bytes())?;
    // The file there now, opened through the folder, never following a link.
    // SAFETY: dfd is open; name_c is a valid C string.
    let fd = unsafe {
        libc::openat(
            dfd.as_raw_fd(),
            name_c.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    let text = if fd < 0 {
        match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::ENOENT) => fresh.to_string(),
            Some(libc::ELOOP) => {
                return Err(
                    "it is a link (a dotfile manager's?): change the file it points to".into(),
                )
            }
            _ => return Err("it couldn't be opened".into()),
        }
    } else {
        // SAFETY: fd was just opened by this call.
        let mut file = std::fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) });
        let m = file
            .metadata()
            .map_err(|_| "it couldn't be read".to_string())?;
        use std::os::unix::fs::MetadataExt;
        if private && m.mode() & 0o077 != 0 {
            return Err("other people can read it".into());
        }
        judge(
            m.file_type().is_file(),
            m.uid(),
            m.mode(),
            m.len().min(max),
            me,
        )
        .map_err(str::to_string)?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(max + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "it couldn't be read".to_string())?;
        if bytes.len() as u64 > max {
            return Err("it is too large".into());
        }
        String::from_utf8(bytes).map_err(|_| "it isn't UTF-8 text".to_string())?
    };
    let new = change(&text);
    if new.len() as u64 > max {
        return Err("it would be too large".into());
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let backup_name = if backup {
        let mut number = 0u32;
        let (backup_name, fd) = loop {
            let backup_name = format!("{}.bak.{nanos}.{number}", name.to_string_lossy());
            let backup_c = c(backup_name.as_bytes())?;
            // SAFETY: dfd is the judged, locked folder; the name is valid, and creation is exclusive, no links.
            let fd = unsafe {
                libc::openat(
                    dfd.as_raw_fd(),
                    backup_c.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600 as libc::c_uint,
                )
            };
            if fd >= 0 {
                break (backup_name, fd);
            }
            if std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
                return Err("the backup couldn't be created; nothing was reset".into());
            }
            number = number.checked_add(1).ok_or("no unused backup name")?;
        };
        // SAFETY: fd is owned by this call, successfully opened just above.
        let mut file = std::fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) });
        file.write_all(text.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| "the backup couldn't be written; nothing was reset".to_string())?;
        Some(backup_name)
    } else {
        None
    };
    let tmp_c = c(format!(
        ".{}.{}.{nanos}.tmp",
        name.to_string_lossy(),
        std::process::id()
    )
    .as_bytes())?;
    // SAFETY: dfd is open; tmp_c is a valid C string; 0o600 is the mode for a new file.
    let tfd = unsafe {
        libc::openat(
            dfd.as_raw_fd(),
            tmp_c.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600 as libc::c_uint,
        )
    };
    if tfd < 0 {
        return Err("it couldn't be written".into());
    }
    let written = (|| -> std::io::Result<()> {
        // SAFETY: tfd was just opened by this call.
        let mut f = std::fs::File::from(unsafe { OwnedFd::from_raw_fd(tfd) });
        f.write_all(new.as_bytes())?;
        f.sync_all()?;
        // SAFETY: dfd is open; both names are valid C strings, in the same open folder.
        if unsafe {
            libc::renameat(
                dfd.as_raw_fd(),
                tmp_c.as_ptr(),
                dfd.as_raw_fd(),
                name_c.as_ptr(),
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    })();
    if written.is_err() {
        // SAFETY: dfd is open; tmp_c is a valid C string.
        unsafe { libc::unlinkat(dfd.as_raw_fd(), tmp_c.as_ptr(), 0) };
        return Err("it couldn't be written".into());
    }
    Ok(backup_name)
}

#[cfg(not(unix))]
pub fn write_safely(
    _path: &Path,
    _home: Option<&Path>,
    _change: &dyn Fn(&str) -> String,
) -> Result<(), String> {
    Err("this system's files aren't written from here".into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Column {
    Agent,
    Step,
    Age,
    Cost,
    Project,
}

impl Column {
    pub const ALL: [Column; 5] = [
        Column::Agent,
        Column::Step,
        Column::Age,
        Column::Cost,
        Column::Project,
    ];
    pub fn key(self) -> &'static str {
        match self {
            Column::Agent => "agent",
            Column::Step => "step",
            Column::Age => "age",
            Column::Cost => "cost",
            Column::Project => "project",
        }
    }
}

/// Which changes notify (each also rings the bell when `bell` is on).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Notify {
    pub asks: bool,
    pub finished: bool,
    pub failed: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub theme: ThemeName,
    pub density: Density,
    pub key_bar: bool,
    pub show_costs: bool,
    pub columns: Vec<Column>,
    pub glyphs: Glyphs,
    pub notify: Notify,
    pub bell: bool,
    pub reduced_motion: bool,
    /// Inside tmux, send desktop notifications (wrapped for its passthrough); off: the bell only.
    pub tmux_passthrough: bool,
    /// Which side the list is on (the view file remembers a side changed in the workbench, per project).
    pub list_side: crate::viewstate::Side,
    /// The mouse resting over a panel focuses it (off: a click does).
    pub focus_follows_mouse: bool,
    /// Role colours, in the file's order: a saved theme's roles first, then `[colors]` (which win).
    pub colors: Vec<(Role, Rgb)>,
    /// The saved theme in use (`theme = "<name>"` naming a `[themes.<name>]` table), when one is.
    pub theme_label: Option<String>,
    /// The file's saved themes, `[themes.<name>]`: a built-in base and role colours (data only).
    pub saved_themes: Vec<SavedTheme>,
    /// The keymap: a preset and the file's own keys (keys.rs).
    pub keymap: crate::keys::Keymap,
}

impl Settings {
    /// The list's starting width: room for the columns asked for besides the step (dragging changes it).
    pub fn list_width(&self) -> u16 {
        let extra: u16 = self
            .columns
            .iter()
            .map(|c| match c {
                Column::Step => 0,
                Column::Age => 5,
                Column::Cost => 7,
                Column::Agent => 16,
                Column::Project => 14,
            })
            .sum();
        // The sheet, its padding and the card's badge besides the title.
        (46 + extra).min(90)
    }
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            theme: ThemeName::Terminal,
            density: Density::Compact,
            key_bar: true,
            show_costs: true,
            columns: vec![Column::Step],
            glyphs: Glyphs::Unicode,
            notify: Notify {
                asks: true,
                finished: false,
                failed: true,
            },
            bell: true,
            reduced_motion: false,
            tmux_passthrough: false,
            list_side: crate::viewstate::Side::Left,
            focus_follows_mouse: false,
            colors: vec![],
            theme_label: None,
            saved_themes: vec![],
            keymap: crate::keys::Keymap::default(),
        }
    }
}

// ---- the file's words ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Value {
    Str(String),
    Bool(bool),
    List(Vec<String>),
    /// Something TOML may allow but these settings never take (a number, a date, a table).
    Other(String),
}

impl Value {
    fn shown(&self) -> String {
        let s = match self {
            Value::Str(s) => format!("\"{s}\""),
            Value::Bool(b) => b.to_string(),
            Value::List(l) => format!("[{}]", l.join(", ")),
            Value::Other(o) => o.clone(),
        };
        fit(&clean(&s), 40)
    }
}

/// A quoted string at the start of `s`: its value and what follows (None: not one, or not closed).
fn quoted(s: &str) -> Option<(String, &str)> {
    let mut chars = s.char_indices();
    let (_, q) = chars.next()?;
    if q != '"' && q != '\'' {
        return None;
    }
    let mut out = String::new();
    while let Some((i, c)) = chars.next() {
        match c {
            c if c == q => return Some((out, &s[i + 1..])),
            '\\' if q == '"' => {
                let (_, e) = chars.next()?;
                match e {
                    '"' => out.push('"'),
                    '\\' => out.push('\\'),
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    'u' => {
                        let hex: String = (0..4)
                            .filter_map(|_| chars.next().map(|(_, c)| c))
                            .collect();
                        out.push(char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?);
                    }
                    _ => return None,
                }
            }
            '\n' => return None,
            c => out.push(c),
        }
    }
    None
}

/// What's left of a line once a comment is taken off (a `#` outside a string).
pub(crate) fn without_comment(s: &str) -> &str {
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for (i, c) in s.char_indices() {
        match quote {
            Some(q) => {
                if escaped {
                    escaped = false;
                } else if c == '\\' && q == '"' {
                    escaped = true;
                } else if c == q {
                    quote = None;
                }
            }
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == '#' => return &s[..i],
            None => {}
        }
    }
    s
}

fn value(s: &str) -> Option<Value> {
    let s = s.trim();
    if s == "true" {
        return Some(Value::Bool(true));
    }
    if s == "false" {
        return Some(Value::Bool(false));
    }
    if let Some((v, rest)) = quoted(s) {
        return rest.trim().is_empty().then_some(Value::Str(v));
    }
    if let Some(inner) = s.strip_prefix('[') {
        let inner = inner.strip_suffix(']')?;
        let mut items = vec![];
        let mut rest = inner.trim();
        while !rest.is_empty() {
            let (v, after) = quoted(rest)?;
            items.push(v);
            rest = after.trim_start();
            match rest.strip_prefix(',') {
                Some(r) => rest = r.trim_start(),
                None if rest.is_empty() => {}
                None => return None,
            }
        }
        return Some(Value::List(items));
    }
    // A number, a date or an inline table: TOML, but nothing these settings take.
    let bare_ok = !s.is_empty()
        && (s.starts_with('{')
            || s.chars()
                .all(|c| c.is_ascii_alphanumeric() || "+-._:".contains(c)));
    bare_ok.then(|| Value::Other(s.to_string()))
}

fn bare_key(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The file as (line number, section, key, value), and the words for each line it couldn't read.
/// One setting as written: its line, section, key and value.
type Entry = (usize, String, String, Value);

fn entries(text: &str) -> (Vec<Entry>, Vec<String>) {
    let mut out = vec![];
    let mut warnings = vec![];
    let mut section = String::new();
    let mut lines = text.lines().enumerate();
    while let Some((i, raw)) = lines.next() {
        let n = i + 1;
        let mut line = without_comment(raw).trim().to_string();
        if line.is_empty() {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            let name = name.trim();
            // A saved theme's own table, `[themes.<name>]` (its name checked where it is read: theme_name_ok).
            let saved = name
                .strip_prefix("themes.")
                .is_some_and(|t| bare_key(t) && !t.contains('.'));
            if bare_key(name) || saved {
                section = name.to_string();
            } else {
                warnings.push(format!("Line {n} isn't understood, so it was ignored."));
                section = "\u{0}".into();
            }
            continue;
        }
        // An array may run over several lines: read on until its brackets close.
        if let Some(eq) = line.find('=') {
            if line[eq + 1..].trim_start().starts_with('[') && !line.trim_end().ends_with(']') {
                for (_, more) in lines.by_ref() {
                    line.push(' ');
                    line.push_str(without_comment(more).trim());
                    if line.trim_end().ends_with(']') {
                        break;
                    }
                }
            }
        }
        let parsed = line.split_once('=').and_then(|(k, v)| {
            let k = k.trim();
            let k = quoted(k)
                .filter(|(_, rest)| rest.is_empty())
                .map(|(q, _)| q)
                .unwrap_or_else(|| k.to_string());
            let parts: Vec<&str> = k.split('.').map(str::trim).collect();
            if !parts.iter().all(|p| bare_key(p)) || parts.len() > 2 {
                return None;
            }
            let (sec, key) = if parts.len() == 2 {
                if !section.is_empty() {
                    return None;
                }
                (parts[0].to_string(), parts[1].to_string())
            } else {
                (section.clone(), parts[0].to_string())
            };
            Some((sec, key, value(v)?))
        });
        match parsed {
            Some((sec, key, v)) => out.push((n, sec, key, v)),
            None => warnings.push(format!("Line {n} isn't understood, so it was ignored.")),
        }
    }
    (out, warnings)
}

/// Only these top-level settings accept snake-case aliases. Other tables and keys keep their own names.
fn canonical_key<'a>(section: &str, key: &'a str) -> &'a str {
    match (section, key) {
        ("", "list_side") => "list-side",
        ("", "focus_follows_mouse") => "focus-follows-mouse",
        _ => key,
    }
}

/// Settings from the file's text, and a plain warning for everything not used.
pub fn parse(text: &str) -> (Settings, Vec<String>) {
    let mut s = Settings::default();
    let (entries, mut warnings) = entries(text);
    let mut seen: Vec<(String, String)> = vec![];
    let mut preset: Option<(usize, crate::keys::Written)> = None;
    let mut overrides: Vec<(usize, String, crate::keys::Written)> = vec![];
    let mut wanted_theme: Option<(usize, String)> = None;
    for (n, section, key, v) in entries.iter().cloned() {
        // Kebab-case wins regardless of line order, even when its value is invalid. Keep the alias in the file,
        // but do not validate or apply it: writes only change (or add) the canonical spelling.
        let canonical = canonical_key(&section, &key);
        if canonical != key
            && entries
                .iter()
                .any(|(_, sec, k, _)| sec == &section && k == canonical)
        {
            continue;
        }
        let section = if section == "colours" {
            "colors".to_string()
        } else {
            section
        };
        if section == "\u{0}" {
            continue;
        }
        if seen.contains(&(section.clone(), key.clone())) {
            warnings.push(format!(
                "Line {n}: {key} is set twice; the first one is used."
            ));
            continue;
        }
        seen.push((section.clone(), key.clone()));
        let name = if section.is_empty() {
            key.clone()
        } else {
            format!("{section}.{key}")
        };
        let bad = |warnings: &mut Vec<String>, can: &str, default: &str| {
            warnings.push(format!(
                "Line {n}: {key} can be {can}, not {}; using {default}.",
                v.shown()
            ));
        };
        let flag = |warnings: &mut Vec<String>, slot: &mut bool| match &v {
            Value::Bool(b) => *slot = *b,
            _ => bad(
                warnings,
                "true or false",
                if *slot { "true" } else { "false" },
            ),
        };
        match (section.as_str(), key.as_str()) {
            ("", "theme") => match &v {
                Value::Str(t) if ThemeName::from_key(t).is_some() => {
                    s.theme = ThemeName::from_key(t).unwrap_or(ThemeName::Terminal)
                }
                // A saved theme's name: resolved once every `[themes.*]` table is read (below).
                Value::Str(t) if theme_name_ok(t) => wanted_theme = Some((n, t.clone())),
                _ => bad(
                    &mut warnings,
                    "terminal, light, dark, high-contrast or a theme saved under [themes.<name>]",
                    "terminal",
                ),
            },
            (table, field) if table.starts_with("themes.") => {
                let theme = &table["themes.".len()..];
                if !theme_name_ok(theme) {
                    warnings.push(format!(
                        "Line {n}: \"{}\" can't be a theme's name (letters, digits and dashes, at most {THEME_NAME_MAX}, not a built-in theme's), so it was ignored.",
                        fit(&clean(theme), 24)
                    ));
                    continue;
                }
                let at = match s.saved_themes.iter().position(|t| t.name == theme) {
                    Some(i) => i,
                    None => {
                        s.saved_themes.push(SavedTheme {
                            name: theme.to_string(),
                            base: ThemeName::Dark,
                            roles: vec![],
                        });
                        s.saved_themes.len() - 1
                    }
                };
                match (field, Role::from_key(field), &v) {
                    ("base", _, Value::Str(b)) if ThemeName::from_key(b).is_some() => {
                        s.saved_themes[at].base = ThemeName::from_key(b).unwrap_or(ThemeName::Dark)
                    }
                    ("base", _, _) => warnings.push(format!(
                        "Line {n}: a theme's base can be terminal, light, dark or high-contrast, not {}; using dark.",
                        v.shown()
                    )),
                    (_, Some(r), Value::Str(c)) if Rgb::parse(c).is_some() => {
                        s.saved_themes[at].roles.push((r, Rgb::parse(c).unwrap_or(Rgb(0, 0, 0))))
                    }
                    (_, Some(_), _) => warnings.push(format!(
                        "Line {n}: {key} needs a colour like \"#1a2b3c\", not {}; the base's own is used.",
                        v.shown()
                    )),
                    (_, None, _) => warnings.push(format!(
                        "Line {n}: a theme holds base and colours only; {} was ignored.",
                        fit(&clean(field), 24)
                    )),
                }
            }
            ("", "density") => match &v {
                Value::Str(d) if d == "compact" => s.density = Density::Compact,
                Value::Str(d) if d == "comfortable" => s.density = Density::Comfortable,
                _ => bad(&mut warnings, "compact or comfortable", "compact"),
            },
            ("", "glyphs") => match &v {
                Value::Str(g) if Glyphs::from_key(g).is_some() => {
                    s.glyphs = Glyphs::from_key(g).unwrap_or(Glyphs::Unicode)
                }
                _ => bad(&mut warnings, "unicode, ascii or nerd", "unicode"),
            },
            ("", "key-bar") => flag(&mut warnings, &mut s.key_bar),
            ("", "show-costs") => flag(&mut warnings, &mut s.show_costs),
            ("", "bell") => flag(&mut warnings, &mut s.bell),
            ("", "reduced-motion") => flag(&mut warnings, &mut s.reduced_motion),
            ("", "tmux-passthrough") => flag(&mut warnings, &mut s.tmux_passthrough),
            ("", "focus-follows-mouse" | "focus_follows_mouse") => {
                flag(&mut warnings, &mut s.focus_follows_mouse)
            }
            ("", "list-side" | "list_side") => match &v {
                Value::Str(side) if crate::viewstate::Side::from_key(side).is_some() => {
                    s.list_side =
                        crate::viewstate::Side::from_key(side).unwrap_or(crate::viewstate::Side::Left)
                }
                _ => bad(&mut warnings, "left or right", "left"),
            },
            ("", "columns") => match &v {
                Value::List(names) => {
                    let mut cols = vec![];
                    for name in names {
                        match Column::ALL.into_iter().find(|c| c.key() == name) {
                            Some(c) if !cols.contains(&c) => cols.push(c),
                            Some(_) => {}
                            None => warnings.push(format!(
                                "Line {n}: \"{}\" isn't a column (agent, step, age, cost or project), so it was left out.",
                                fit(&clean(name), 24)
                            )),
                        }
                    }
                    s.columns = cols;
                }
                _ => bad(
                    &mut warnings,
                    "a list like [\"step\", \"age\"]",
                    "[\"step\"]",
                ),
            },
            ("keys", name) => {
                let written = match &v {
                    Value::Str(k) => crate::keys::Written::Keys(vec![k.clone()]),
                    Value::List(l) => crate::keys::Written::Keys(l.clone()),
                    other => crate::keys::Written::Bad(other.shown()),
                };
                if name == "preset" {
                    preset = Some((n, written));
                } else {
                    overrides.push((n, name.to_string(), written));
                }
            }
            ("notifications", "asks") => flag(&mut warnings, &mut s.notify.asks),
            ("notifications", "finished") => flag(&mut warnings, &mut s.notify.finished),
            ("notifications", "failed") => flag(&mut warnings, &mut s.notify.failed),
            ("colors", role) => match (Role::from_key(role), &v) {
                (Some(r), Value::Str(c)) if Rgb::parse(c).is_some() => {
                    s.colors.push((r, Rgb::parse(c).unwrap_or(Rgb(0, 0, 0))))
                }
                (Some(_), _) => warnings.push(format!(
                    "Line {n}: {key} needs a colour like \"#1a2b3c\", not {}; the theme's own is used.",
                    v.shown()
                )),
                (None, _) => warnings.push(format!(
                    "Line {n}: there's no colour called {}, so it was ignored (paper, ink, muted, line, selection, selection-ink, needs-you, running, passed, failed, ground, raised, fill, running-soft, passed-soft, failed-soft).",
                    fit(&clean(role), 24)
                )),
            },
            _ => {
                let dashed = name.replace('_', "-");
                let hint = if dashed != name && known(&dashed) {
                    format!(" Did you mean {dashed}?")
                } else {
                    String::new()
                };
                warnings.push(format!(
                    "Line {n}: {} isn't a setting, so it was ignored.{hint}",
                    fit(&clean(&name), 32)
                ));
            }
        }
    }
    // A saved theme named by `theme`: its base, and its roles under `[colors]` (which win, being later).
    if let Some((n, name)) = wanted_theme {
        match s.saved_themes.iter().find(|t| t.name == name) {
            Some(t) => {
                s.theme = t.base;
                s.theme_label = Some(t.name.clone());
                let mut colors = t.roles.clone();
                colors.append(&mut s.colors);
                s.colors = colors;
            }
            None => {
                // In the file's line order, with the others.
                let line_of = |w: &String| {
                    w.strip_prefix("Line ")
                        .and_then(|r| r.split(':').next())
                        .and_then(|d| d.parse::<usize>().ok())
                        .unwrap_or(usize::MAX)
                };
                let at = warnings
                    .iter()
                    .position(|w| line_of(w) > n)
                    .unwrap_or(warnings.len());
                warnings.insert(
                    at,
                    format!(
                        "Line {n}: theme \"{}\" isn't built in, and there's no [themes.{}] table; using terminal.",
                        fit(&clean(&name), 24),
                        fit(&clean(&name), 24)
                    ),
                );
            }
        }
    }
    let (keymap, key_warnings) = crate::keys::Keymap::build(preset, &overrides);
    s.keymap = keymap;
    warnings.extend(key_warnings);
    (s, warnings)
}

/// The longest name a saved theme may have.
pub const THEME_NAME_MAX: usize = 32;

/// Whether `name` can name a saved theme: a lowercase letter, then letters, digits and dashes, at most THEME_NAME_MAX,
/// and never a built-in theme's name.
pub fn theme_name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && name.len() <= THEME_NAME_MAX
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && ThemeName::from_key(name).is_none()
}

/// A theme saved in tui.toml (`[themes.<name>]`): its built-in base and its role colours. Data only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedTheme {
    pub name: String,
    pub base: ThemeName,
    pub roles: Vec<(Role, Rgb)>,
}

fn known(name: &str) -> bool {
    [
        "theme",
        "density",
        "key-bar",
        "show-costs",
        "columns",
        "glyphs",
        "bell",
        "reduced-motion",
        "tmux-passthrough",
        "focus-follows-mouse",
        "focus_follows_mouse",
        "list-side",
        "list_side",
        "notifications.asks",
        "notifications.finished",
        "notifications.failed",
    ]
    .contains(&name)
        || name
            .strip_prefix("colors.")
            .is_some_and(|r| Role::from_key(r).is_some())
}

// ---- where the file is, and whether it may be read --------------------------------------------------------------

/// What the settings depend on from the environment, read once (tests build their own).
#[derive(Debug, Clone, Default)]
pub struct Env {
    pub home: Option<PathBuf>,
    pub xdg_config_home: Option<PathBuf>,
    /// Where the workbench keeps where you left off (state.rs).
    pub xdg_state_home: Option<PathBuf>,
    pub no_color: bool,
    pub colorterm: Option<String>,
    pub term: Option<String>,
    pub tmux: bool,
    pub tmux_pane: Option<String>,
    pub vte: bool,
    pub ssh: bool,
}

impl Env {
    pub fn from_process() -> Env {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        Env {
            home: var("HOME").map(PathBuf::from),
            xdg_config_home: var("XDG_CONFIG_HOME").map(PathBuf::from),
            xdg_state_home: var("XDG_STATE_HOME").map(PathBuf::from),
            no_color: var("NO_COLOR").is_some(),
            colorterm: var("COLORTERM"),
            term: var("TERM"),
            tmux: var("TMUX").is_some(),
            tmux_pane: var("TMUX_PANE"),
            vte: var("VTE_VERSION").is_some(),
            ssh: var("SSH_CONNECTION").is_some() || var("SSH_TTY").is_some(),
        }
    }

    /// The settings file: under `XDG_CONFIG_HOME` when it is set (an absolute path), else `~/.config`.
    pub fn settings_path(&self) -> Option<PathBuf> {
        if let Some(x) = self.xdg_config_home.as_ref().filter(|p| p.is_absolute()) {
            return Some(x.join("toolroll").join("tui.toml"));
        }
        self.home
            .as_ref()
            .filter(|p| p.is_absolute())
            .map(|h| h.join(".config").join("toolroll").join("tui.toml"))
    }

    pub fn depth(&self) -> Depth {
        Depth::detect(
            self.no_color,
            self.colorterm.as_deref(),
            self.term.as_deref(),
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum FileState {
    /// No file: the defaults.
    Missing,
    Read,
    /// Not read, and why (in words).
    Ignored(String),
}

/// Whether a file with these facts may be read: a plain file, this user's, that nobody else can change.
pub fn judge(regular: bool, uid: u32, mode: u32, size: u64, me: u32) -> Result<(), &'static str> {
    if !regular {
        return Err("it isn't a plain file");
    }
    if uid != me {
        return Err("it belongs to another user");
    }
    if mode & 0o022 != 0 {
        return Err("other people can change it (chmod go-w fixes that)");
    }
    if size > MAX_BYTES {
        return Err("it is larger than 64 KB");
    }
    Ok(())
}

/// Read the settings file when it is safe to: never a file or folder others can change. A link (a dotfile manager's)
/// is followed only to a real path inside the home folder whose every folder, up to and including the home folder, is
/// this user's and can't be changed by anyone else; the file is then opened at that real path without following links,
/// and judged by what was opened.
#[cfg(unix)]
pub fn read_safely(path: &Path, home: Option<&Path>) -> Result<Option<String>, String> {
    use std::io::Read;
    use std::os::unix::fs::MetadataExt;
    // SAFETY: geteuid has no preconditions.
    let me = unsafe { libc::geteuid() };
    // Its folder, reached from `/` one name at a time by descriptor and judged on each open descriptor (walk_trusted,
    // the writer's own walk): the folder the file is opened in is the folder judged. A folder not there yet means no
    // file; one that can't be looked at is refused, never taken for missing.
    let Some(dir) = path.parent() else {
        return Err("it has no folder".into());
    };
    let name = path.file_name().ok_or("it has no name")?;
    let Some(held) = walk_trusted(&real_path_of(dir), home, me, false)? else {
        return Ok(None);
    };
    let file = match open_at(&held, name) {
        // A link (a dotfile manager's): followed only to a file strictly inside the home folder, whose own folder is
        // walked and judged the same way, then opened relative to it (and a link there is refused).
        Err(e) if e.raw_os_error() == Some(libc::ELOOP) => {
            let home_real = home
                .and_then(|h| std::fs::canonicalize(h).ok())
                .ok_or("it is a link, and there's no home folder to check it against")?;
            let target =
                std::fs::canonicalize(path).map_err(|_| "it is a link to nothing".to_string())?;
            // Real paths both, compared as bytes: strictly inside the home folder.
            use std::os::unix::ffi::OsStrExt;
            let (t, h) = (
                target.as_os_str().as_bytes(),
                home_real.as_os_str().as_bytes(),
            );
            if !(t.len() > h.len() && t.starts_with(h) && t[h.len()] == b'/') {
                return Err("it links outside your home folder".into());
            }
            let into = || {
                "it links into a folder other people can change, or that isn't yours".to_string()
            };
            let target_dir = target.parent().ok_or("it is a link to nothing")?;
            let held = walk_trusted(target_dir, home, me, false)
                .map_err(|_| into())?
                .ok_or("it is a link to nothing")?;
            open_at(&held, target.file_name().ok_or("it is a link to nothing")?)
        }
        other => other,
    };
    let mut file = match file {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) if e.raw_os_error() == Some(libc::ELOOP) => {
            return Err("it is a link, not the file itself".into())
        }
        Err(_) => return Err("it couldn't be opened".into()),
    };
    // The facts of the file opened (not of the name, which could change in between).
    let m = file
        .metadata()
        .map_err(|_| "it couldn't be read".to_string())?;
    judge(m.file_type().is_file(), m.uid(), m.mode(), m.len(), me).map_err(str::to_string)?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "it couldn't be read".to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("it is larger than 64 KB".into());
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "it isn't UTF-8 text".into())
}

/// `name` opened read-only relative to an open folder, never through a link (ELOOP when it is one).
#[cfg(unix)]
pub(crate) fn open_at(
    dir: &std::os::fd::OwnedFd,
    name: &std::ffi::OsStr,
) -> std::io::Result<std::fs::File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    let n = CString::new(name.as_bytes()).map_err(|_| std::io::Error::other("nul"))?;
    // SAFETY: a valid C string relative to an open folder; the descriptor returned is owned below.
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            n.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: fd is a fresh descriptor of ours.
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

#[cfg(not(unix))]
pub fn read_safely(_path: &Path, _home: Option<&Path>) -> Result<Option<String>, String> {
    Ok(None)
}

/// The settings for this environment: the file's when it may be read, else the defaults; and every warning.
pub fn load(env: &Env) -> (Settings, Option<PathBuf>, FileState, Vec<String>) {
    let Some(path) = env.settings_path() else {
        return (Settings::default(), None, FileState::Missing, vec![]);
    };
    match read_safely(&path, env.home.as_deref()) {
        Ok(None) => (Settings::default(), Some(path), FileState::Missing, vec![]),
        Ok(Some(text)) => {
            let (s, warnings) = parse(&text);
            let warnings = warnings
                .into_iter()
                .map(|w| format!("tui.toml: {w}"))
                .collect();
            (s, Some(path), FileState::Read, warnings)
        }
        Err(why) => (
            Settings::default(),
            Some(path),
            FileState::Ignored(why.clone()),
            vec![format!("tui.toml was ignored: {why}.")],
        ),
    }
}

/// Whether the terminal speaks the keyboard protocol, from the start ask: yes only when it said so; no when it answered
/// without it, or answered nothing in time (it won't answer the keyboard ask either); None when it wasn't asked (not a
/// terminal, or not asked here), and crossterm asks on its own.
pub fn keyboard_of(answers: Option<crate::theme::Answers>) -> Option<bool> {
    answers.map(|a| a.answered && a.keyboard)
}

/// Everything the screen needs from its surroundings, at start: the settings, the colours the terminal shows, its
/// background (asked only from a local terminal with colour on: raw mode, before anything reads the keyboard), and
/// where notifications go.
pub fn start(env: &Env) -> Prefs {
    let (settings, path, file, warnings) = load(env);
    let depth = env.depth();
    let ask = depth != Depth::Off && !env.ssh;
    let answers = if ask {
        crate::theme::ask_terminal(std::time::Duration::from_millis(150))
    } else {
        None
    };
    let background = answers.and_then(|a| a.background);
    let reach = Reach::of(env, settings.tmux_passthrough);
    let mut prefs = Prefs::new(settings, path, file, warnings, depth, background, reach);
    prefs.home = env.home.clone();
    // Asked and not answered in time: an answer may still come, and must not be read as keys (theme::LateReply).
    prefs.late_reply = ask && background.is_none();
    // The keyboard protocol, from the same ask: known once the terminal answered (a terminal that answered nothing
    // within the ask won't answer the keyboard ask either). Not asked: crossterm asks on its own (run.rs).
    prefs.keyboard = keyboard_of(answers);
    prefs
}

// ---- what the screen holds ------------------------------------------------------------------------------------------

/// Said when a reload of tui.toml changed `[keys]`: the running keys stay until the next start.
pub const KEYS_NEXT_START: &str = "Key changes take effect next start.";

/// The settings in use and where they came from, the theme drawn (which `t` changes for the session), and where
/// notifications go.
#[derive(Debug, Clone, PartialEq)]
pub struct Prefs {
    pub settings: Settings,
    pub path: Option<PathBuf>,
    /// The home folder the reader checks a link against (the writer reads through it too).
    pub home: Option<PathBuf>,
    pub file: FileState,
    /// The file's warnings (fixed at start).
    pub file_warnings: Vec<String>,
    /// The colours refused for the theme drawn now.
    pub color_warnings: Vec<String>,
    pub depth: Depth,
    /// What the terminal said its background is (OSC 11).
    pub background: Option<Rgb>,
    pub theme: Theme,
    pub reach: Reach,
    /// The background was asked for and not answered in time (the loop drops a late answer: theme::LateReply).
    pub late_reply: bool,
    /// Whether the terminal speaks the keyboard protocol, from the start ask (None: not asked here).
    pub keyboard: Option<bool>,
    /// A change on the Settings screen was written to the file this session.
    pub saved: bool,
}

impl Default for Prefs {
    fn default() -> Prefs {
        Prefs {
            settings: Settings::default(),
            path: None,
            home: None,
            file: FileState::Missing,
            file_warnings: vec![],
            color_warnings: vec![],
            depth: Depth::Ansi16,
            background: None,
            theme: Theme::default(),
            reach: Reach::default(),
            late_reply: false,
            keyboard: None,
            saved: false,
        }
    }
}

impl Prefs {
    pub fn new(
        settings: Settings,
        path: Option<PathBuf>,
        file: FileState,
        file_warnings: Vec<String>,
        depth: Depth,
        background: Option<Rgb>,
        reach: Reach,
    ) -> Prefs {
        let (theme, color_warnings) =
            Theme::build(settings.theme, depth, background, &settings.colors);
        Prefs {
            settings,
            path,
            home: None,
            file,
            file_warnings,
            color_warnings,
            depth,
            background,
            theme,
            reach,
            late_reply: false,
            keyboard: None,
            saved: false,
        }
    }

    /// Everything not used, in plain words.
    pub fn warnings(&self) -> Vec<String> {
        self.file_warnings
            .iter()
            .chain(self.color_warnings.iter())
            .cloned()
            .collect()
    }

    /// The next theme, for this session only (the file is never written).
    pub fn cycle_theme(&mut self) {
        let (theme, warnings) = Theme::build(
            self.theme.name.next(),
            self.depth,
            self.background,
            &self.settings.colors,
        );
        self.theme = theme;
        self.color_warnings = warnings;
    }

    /// Change one setting (the Settings screen's Enter): for this session at once, and written to tui.toml. The words
    /// say what happened; Err when the file wasn't written (the change still holds for this session).
    /// tui.toml changed on disk: read it again with the same safe, strict reader. Ok: the words for what changed (to
    /// show), now in use. Err: why it wasn't used; the last good settings stay. `[keys]` alone waits for the next start,
    /// and says so (KEYS_NEXT_START): keys never change under a person's hands.
    pub fn reload(&mut self) -> Result<String, String> {
        let Some(path) = self.path.clone() else {
            return Err("there's no home folder to read tui.toml from".into());
        };
        let next = match read_safely(&path, self.home.as_deref()) {
            Ok(None) => Settings::default(),
            Ok(Some(text)) => {
                let (s, warnings) = parse(&text);
                if let Some(first) = warnings.first() {
                    return Err(format!(
                        "tui.toml wasn't used, so your settings stay ({}).",
                        first.trim_end_matches('.').replacen("Line ", "line ", 1)
                    ));
                }
                s
            }
            Err(why) => {
                return Err(format!(
                    "tui.toml wasn't used, so your settings stay (it was ignored: {why})."
                ))
            }
        };
        let mut next = next;
        // Keys never change under the person's hands: a changed [keys] waits for the next start (and is said), so a key
        // change no one meant is at least seen, never instant.
        let keys_wait = next.keymap != self.settings.keymap;
        if keys_wait {
            next.keymap = self.settings.keymap.clone();
        }
        let changes = settings_changes(&self.settings, &next);
        self.settings = next;
        let (theme, warnings) = Theme::build(
            self.settings.theme,
            self.depth,
            self.background,
            &self.settings.colors,
        );
        self.theme = theme;
        self.color_warnings = warnings;
        self.file = if path.exists() {
            FileState::Read
        } else {
            FileState::Missing
        };
        let said = match (changes.is_empty(), keys_wait) {
            (true, true) => String::new(),
            (true, false) => "Your workbench settings changed.".to_string(),
            (false, _) => format!("Your workbench settings changed: {}", changes.join(", ")),
        };
        Ok(if keys_wait {
            format!("{said} {KEYS_NEXT_START}").trim_start().to_string()
        } else {
            said
        })
    }

    pub fn change(&mut self, choice: Choice) -> Result<String, String> {
        let value = choice.step(&mut self.settings);
        if choice == Choice::Theme {
            let (theme, warnings) = Theme::build(
                self.settings.theme,
                self.depth,
                self.background,
                &self.settings.colors,
            );
            self.theme = theme;
            self.color_warnings = warnings;
        }
        let now = format!("{}: {}", choice.label(), choice.words(&self.settings));
        let Some(path) = self.path.clone() else {
            return Err(format!(
                "{now}, for this session (there's no home folder to keep tui.toml in)."
            ));
        };
        if let FileState::Ignored(why) = &self.file {
            return Err(format!(
                "{now}, for this session: tui.toml isn't written while it is ignored ({why})."
            ));
        }
        let (section, key) = choice.place();
        match write_safely(&path, self.home.as_deref(), &|text| {
            set_in_toml(text, section, key, &value)
        }) {
            Ok(()) => {
                self.file = FileState::Read;
                self.saved = true;
                Ok(format!("{now}. Saved to tui.toml."))
            }
            Err(why) => Err(format!(
                "{now}, for this session: tui.toml wasn't written ({why})."
            )),
        }
    }

    /// The line the status bar shows at start when something wasn't used (None: all was).
    pub fn first_warning(&self) -> Option<String> {
        let all = self.warnings();
        let first = all.first()?;
        Some(if all.len() > 1 {
            format!(
                "{first} ({} more: press ? then s to see them.)",
                all.len() - 1
            )
        } else {
            first.clone()
        })
    }

    /// The settings screen (`?` then `s`, or Settings in the palette): the choices it changes first (the one at
    /// `cursor` marked), then the rest in use, and the file they come from. Every line wraps; none is cut.
    /// `threads`: interactive agent threads as the console last said (None: not known yet), shown read-only: it is an
    /// installation setting, changed in the browser or the CLI.
    pub fn screen(&self, width: usize, cursor: usize, threads: Option<bool>) -> Vec<Line<'static>> {
        let ink = crate::theme::ink;
        let dim = crate::theme::dim;
        let on = |b: bool| if b { "on" } else { "off" };
        let s = &self.settings;
        let w = width.max(24);
        let path = self
            .path
            .as_ref()
            .map(|p| clean(&p.display().to_string()))
            .unwrap_or_else(|| "(no home folder, so no settings file)".into());
        let file = match &self.file {
            _ if self.path.is_none() => "changes here hold for this session only".to_string(),
            FileState::Missing => {
                "not there yet: the defaults are used, and a change here makes it".to_string()
            }
            FileState::Read if self.saved => "saved".to_string(),
            FileState::Read => "read".to_string(),
            FileState::Ignored(why) => format!("ignored: {why}"),
        };
        let theme_note = match self.theme.name {
            ThemeName::Terminal => Some(format!(
                "its own colours, with {} roles{}",
                if self.theme.dark { "dark" } else { "light" },
                if self.background.is_some() {
                    ""
                } else {
                    " (it didn't say its background)"
                }
            )),
            _ => None,
        };
        let columns = if s.columns.is_empty() {
            "none".to_string()
        } else {
            s.columns
                .iter()
                .map(|c| c.key())
                .collect::<Vec<_>>()
                .join(", ")
        };
        let label_w = 18;
        let row =
            |lines: &mut Vec<Line<'static>>, mark: &str, label: &str, words: &str, here: bool| {
                for (i, piece) in crate::text::wrap(words, w.saturating_sub(label_w + 2).max(8))
                    .into_iter()
                    .enumerate()
                {
                    let head = if i == 0 {
                        format!("{mark:<2}{label:<label_w$}")
                    } else {
                        " ".repeat(label_w + 2)
                    };
                    lines.push(Line::from(vec![
                        Span::styled(head, if here { ink() } else { dim() }),
                        Span::styled(
                            piece,
                            if here {
                                ink()
                            } else {
                                ratatui::style::Style::default()
                            },
                        ),
                    ]));
                }
            };
        let mut lines = vec![];
        for (i, piece) in crate::text::wrap(&path, w.saturating_sub(6))
            .into_iter()
            .enumerate()
        {
            lines.push(Line::from(vec![
                Span::styled(if i == 0 { "File  " } else { "      " }, ink()),
                Span::raw(piece),
            ]));
        }
        for piece in crate::text::wrap(&file, w.saturating_sub(6)) {
            lines.push(Line::from(Span::styled(format!("      {piece}"), dim())));
        }
        lines.push(Line::raw(""));
        for (i, choice) in Choice::ALL.into_iter().enumerate() {
            let mut words = choice.words(s);
            if choice == Choice::Theme {
                if self.theme.name != s.theme {
                    words = format!(
                        "{} for this session (saved: {words})",
                        self.theme.name.key()
                    );
                } else if let Some(note) = &theme_note {
                    words = format!("{words}: {note}");
                }
            }
            let here = i == cursor;
            row(
                &mut lines,
                if here { "›" } else { "" },
                choice.label(),
                &words,
                here,
            );
        }
        lines.push(Line::raw(""));
        let keys = {
            let changed = crate::keys::SPECS
                .iter()
                .filter(|sp| {
                    s.keymap.keys_of(sp.action)
                        != crate::keys::Keymap::preset(s.keymap.preset).keys_of(sp.action)
                })
                .count();
            match changed {
                0 => format!("{} preset", s.keymap.preset.key()),
                1 => format!("{} preset, 1 key changed", s.keymap.preset.key()),
                c => format!("{} preset, {c} keys changed", s.keymap.preset.key()),
            }
        };
        let rest: Vec<(&str, String)> = vec![
            ("Colour", self.depth.words().to_string()),
            ("Key bar", on(s.key_bar).to_string()),
            (
                "Costs",
                if s.show_costs { "shown" } else { "hidden" }.to_string(),
            ),
            ("Columns", columns),
            ("Keys", keys),
            ("Bell", on(s.bell).to_string()),
            ("Reduced motion", on(s.reduced_motion).to_string()),
            ("Delivered", self.reach.words().to_string()),
            ("Agent threads", threads_words(threads)),
        ];
        for (label, words) in rest {
            row(&mut lines, "", label, &words, false);
        }
        let warnings = self.warnings();
        if !warnings.is_empty() {
            lines.push(Line::raw(""));
            lines.push(Line::from(Span::styled("Not used", ink())));
            for warn in warnings.iter().take(12) {
                for l in crate::text::wrap(warn, w.saturating_sub(2)) {
                    lines.push(Line::raw(format!("  {l}")));
                }
            }
        }
        lines.push(Line::raw(""));
        lines.push(Line::from(vec![
            Span::styled("j/k ", ink()),
            Span::raw("choose  "),
            Span::styled("Enter ", ink()),
            Span::raw("change it (saved to tui.toml)  "),
            Span::styled("t ", ink()),
            Span::raw("next theme, this session only"),
        ]));
        lines.push(Line::from(Span::styled(
            "Other settings and keys: edit tui.toml ([keys] preset = \"vim\"). Esc closes.",
            dim(),
        )));
        lines
    }
}

/// Interactive agent threads (beta) on the settings screen: as the console last said, and where to change it.
pub fn threads_words(threads: Option<bool>) -> String {
    match threads {
        Some(true) => "on (beta). Change it in the browser or with `toolroll config set flexible off`".into(),
        Some(false) => "off (beta). Change it in the browser or with `toolroll config set flexible on`".into(),
        None => "not known yet (beta). Change it in the browser or with `toolroll config set flexible on`".into(),
    }
}

// ---- the agent and cost columns ---------------------------------------------------------------------------------

/// Each task's agent and cost as its steps last said (the work list doesn't carry them): learnt as tasks are opened.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RowFacts(HashMap<String, (Option<String>, Option<f64>)>);

impl RowFacts {
    pub fn learn(&mut self, steps: &toolroll_api::StepCards) {
        let Some(card) = steps
            .cards
            .iter()
            .flatten()
            .find(|c| c.key == "build" && (c.state == "current" || !c.runs.is_empty()))
        else {
            return;
        };
        // The task's cost: every step of its chain that recorded one (plan, build, review), together.
        let costs: Vec<f64> = steps
            .cards
            .iter()
            .flatten()
            .filter(|c| c.in_chain)
            .filter_map(|c| c.cost_usd)
            .collect();
        let cost = (!costs.is_empty()).then(|| costs.iter().sum::<f64>());
        let agent = card.agent.as_ref().map(|a| {
            clean(&format!(
                "{} {}",
                a.provider,
                a.model.as_deref().unwrap_or("")
            ))
            .trim()
            .to_string()
        });
        if self.0.len() > 4096 {
            self.0.clear();
        }
        self.0.insert(steps.task.id.clone(), (agent, cost));
    }

    pub fn agent(&self, task: &str) -> Option<&str> {
        self.0.get(task).and_then(|(a, _)| a.as_deref())
    }

    pub fn cost(&self, task: &str) -> Option<f64> {
        self.0.get(task).and_then(|(_, c)| *c)
    }
}

/// What differs between two settings, in a few words each ("theme dark → sumi"), at most four.
pub fn settings_changes(a: &Settings, b: &Settings) -> Vec<String> {
    let theme = |s: &Settings| {
        s.theme_label
            .clone()
            .unwrap_or_else(|| s.theme.key().to_string())
    };
    let density = |s: &Settings| match s.density {
        Density::Compact => "compact",
        Density::Comfortable => "comfortable",
    };
    let columns = |s: &Settings| {
        s.columns
            .iter()
            .map(|c| c.key())
            .collect::<Vec<_>>()
            .join(" ")
    };
    let on = |b: bool| if b { "on" } else { "off" };
    let mut out = vec![];
    let mut differ = |what: &str, x: String, y: String| {
        if x != y {
            out.push(format!("{what} {x} → {y}"));
        }
    };
    differ("theme", theme(a), theme(b));
    differ("density", density(a).into(), density(b).into());
    differ("glyphs", a.glyphs.key().into(), b.glyphs.key().into());
    differ("columns", columns(a), columns(b));
    differ(
        "list side",
        a.list_side.key().into(),
        b.list_side.key().into(),
    );
    differ(
        "reduced motion",
        on(a.reduced_motion).into(),
        on(b.reduced_motion).into(),
    );
    differ("key bar", on(a.key_bar).into(), on(b.key_bar).into());
    differ("costs", on(a.show_costs).into(), on(b.show_costs).into());
    if a.colors != b.colors && theme(a) == theme(b) {
        out.push("colours".into());
    }
    if a.notify != b.notify {
        out.push("notifications".into());
    }
    if a.keymap != b.keymap {
        out.push("keys".into());
    }
    out.truncate(4);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A private folder chain under the system's temp folder (its real path): base/a/b/c, each 0700.
    #[cfg(unix)]
    fn chain(tag: &str) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let base = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("tr-walk-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let c = base.join("a/b/c");
        std::fs::create_dir_all(&c).unwrap();
        for d in [&base, &base.join("a"), &base.join("a/b"), &c] {
            std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        (base, c)
    }

    /// The walker refuses a link at any depth of the path: each folder is opened with O_NOFOLLOW from its parent.
    /// The test's own base stands in for the home folder, so a shared sticky temp folder above it (Linux's /tmp) is
    /// allowed the way a real home's ancestors are.
    #[cfg(unix)]
    #[test]
    fn the_walk_refuses_a_linked_folder_at_every_depth() {
        let me = unsafe { libc::geteuid() };
        let (base, c) = chain("links");
        assert!(walk_trusted(&c, Some(&base), me, false).unwrap().is_some());
        for (i, part) in ["a", "a/b", "a/b/c"].iter().enumerate() {
            let real = base.join(part);
            let moved = base.join(format!("moved-{i}"));
            std::fs::rename(&real, &moved).unwrap();
            std::os::unix::fs::symlink(&moved, &real).unwrap();
            let why = walk_trusted(&c, Some(&base), me, false).unwrap_err();
            assert!(why.contains("is a link or not a folder"), "{part}: {why}");
            std::fs::remove_file(&real).unwrap();
            std::fs::rename(&moved, &real).unwrap();
        }
        // A folder others can change, at any depth below the temp folder: refused by the descriptor's own facts.
        use std::os::unix::fs::PermissionsExt;
        for part in ["a", "a/b", "a/b/c"] {
            std::fs::set_permissions(base.join(part), std::fs::Permissions::from_mode(0o770))
                .unwrap();
            assert!(walk_trusted(&c, Some(&base), me, false).is_err(), "{part}");
            std::fs::set_permissions(base.join(part), std::fs::Permissions::from_mode(0o700))
                .unwrap();
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The folder judged is the folder opened: once the walk holds it, a folder swapped in by name on the way (here
    /// `b` renamed away and a planted one put in its place) changes nothing read through the held descriptor.
    #[cfg(unix)]
    #[test]
    fn a_folder_swapped_in_after_the_walk_is_never_what_is_read() {
        use std::io::Read;
        let me = unsafe { libc::geteuid() };
        let (base, c) = chain("swap");
        std::fs::write(c.join("tui.toml"), "theme = \"dark\"\n").unwrap();
        let held = walk_trusted(&c, Some(&base), me, false).unwrap().unwrap();
        std::fs::rename(base.join("a/b"), base.join("a/b-old")).unwrap();
        std::fs::create_dir_all(base.join("a/b/c")).unwrap();
        std::fs::write(base.join("a/b/c/tui.toml"), "theme = \"light\"\n").unwrap();
        let mut text = String::new();
        open_at(&held, std::ffi::OsStr::new("tui.toml"))
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "theme = \"dark\"\n");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn defaults() {
        let s = Settings::default();
        assert_eq!(s.theme, ThemeName::Terminal);
        assert_eq!(s.density, Density::Compact);
        assert!(s.key_bar && s.show_costs && s.bell && !s.reduced_motion && !s.tmux_passthrough);
        assert_eq!(s.columns, vec![Column::Step]);
        assert_eq!(s.glyphs, Glyphs::Unicode);
        assert_eq!(
            s.notify,
            Notify {
                asks: true,
                finished: false,
                failed: true
            }
        );
        assert_eq!(parse(""), (Settings::default(), vec![]));
    }

    #[test]
    fn every_setting_is_read() {
        let text = r##"
# mine
theme = "high-contrast"
density = 'comfortable'   # roomier
key-bar = false
show-costs = false
columns = [
  "agent", "age",  # two
  "cost",
]
glyphs = "ascii"
bell = false
reduced-motion = true
tmux-passthrough = true

[notifications]
asks = false
finished = true
failed = false

[colors]
running = "#5aa9ff"
"##;
        let (s, warnings) = parse(text);
        assert_eq!(warnings, Vec::<String>::new());
        assert_eq!(s.theme, ThemeName::HighContrast);
        assert_eq!(s.density, Density::Comfortable);
        assert!(!s.key_bar && !s.show_costs && !s.bell && s.reduced_motion && s.tmux_passthrough);
        assert_eq!(s.columns, vec![Column::Agent, Column::Age, Column::Cost]);
        assert_eq!(s.glyphs, Glyphs::Ascii);
        assert_eq!(
            s.notify,
            Notify {
                asks: false,
                finished: true,
                failed: false
            }
        );
        assert_eq!(s.colors, vec![(Role::Running, Rgb(0x5a, 0xa9, 0xff))]);
        // The keymap: a preset and an action's own keys (keys.rs holds its rules).
        // (Z: A opens the Agents screen.)
        let (s, w) = parse("[keys]\npreset = \"emacs\"\naccept = [\"Z\", \"a\"]\nkeys.stop = 3");
        assert_eq!(s.keymap.preset, crate::keys::Preset::Emacs);
        assert_eq!(s.keymap.all_words(crate::keys::Action::Accept), "Z, a");
        assert_eq!(w.len(), 1, "{w:?}");
        // Dotted keys work too.
        let (s, w) = parse("notifications.finished = true\ncolors.failed = \"#f00\"");
        assert!(w.is_empty() && s.notify.finished);
        assert_eq!(s.colors, vec![(Role::Failed, Rgb(255, 0, 0))]);
    }

    #[test]
    fn kebab_case_settings_win_over_snake_case_in_either_order() {
        for (key, alias, preferred, ignored) in [
            ("list-side", "list_side", "\"right\"", "\"left\""),
            (
                "focus-follows-mouse",
                "focus_follows_mouse",
                "true",
                "false",
            ),
        ] {
            let (want, _) = parse(&format!("{key} = {preferred}\n"));
            assert_eq!(
                parse(&format!("{alias} = {preferred}\n")),
                (want.clone(), vec![])
            );
            for text in [
                format!("{key} = {preferred}\n{alias} = {ignored}\n"),
                format!("{alias} = {ignored}\n{key} = {preferred}\n"),
            ] {
                assert_eq!(parse(&text), (want.clone(), vec![]), "{text}");
                // An invalid canonical value still wins and uses the default.
                let (got, warnings) =
                    parse(&text.replace(preferred, "42").replace(ignored, preferred));
                assert_eq!(got, Settings::default());
                assert_eq!(warnings.len(), 1, "{warnings:?}");
            }
        }
    }

    #[test]
    fn writes_read_back_with_both_spellings_and_keep_the_alias_untouched() {
        for (key, alias, old, new) in [
            ("list-side", "list_side", "\"left\"", "\"right\""),
            (
                "focus-follows-mouse",
                "focus_follows_mouse",
                "false",
                "true",
            ),
        ] {
            let (want, _) = parse(&format!("{key} = {new}\n"));
            let alias_line = format!("  {alias} = {old}   # keep this exactly\n");
            for text in [
                format!("{key} = {old}  # canonical\n{alias_line}"),
                format!("{alias_line}{key} = {old}  # canonical\n"),
                alias_line.clone(),
            ] {
                // Either API spelling writes the canonical key, even in alias-only files.
                for written_key in [key, alias] {
                    let text =
                        format!("# settings\n{text}bell = true\n[notifications]\nasks = true\n");
                    let out = set_in_toml(&text, "", written_key, new);
                    assert!(out.starts_with("# settings\n"), "{out}");
                    assert!(out.contains("bell = true\n"), "{out}");
                    assert!(out.contains("[notifications]\nasks = true\n"), "{out}");
                    assert_eq!(parse(&out), (want.clone(), vec![]), "{out}");
                    assert!(out.contains(&alias_line), "{out}");
                    assert_eq!(set_in_toml(&out, "", written_key, new), out);
                }
            }
        }
    }

    #[test]
    fn an_unknown_key_is_named_and_ignored() {
        let (s, warnings) = parse("themes = \"dark\"\nkey_bar = false\n[sound]\nvolume = true");
        assert_eq!(s, Settings::default());
        assert_eq!(
            warnings,
            vec![
                "Line 1: themes isn't a setting, so it was ignored.".to_string(),
                "Line 2: key_bar isn't a setting, so it was ignored. Did you mean key-bar?".into(),
                "Line 4: sound.volume isn't a setting, so it was ignored.".into(),
            ]
        );
    }

    #[test]
    fn a_bad_value_falls_back_to_the_default() {
        let (s, warnings) = parse(
            "theme = \"solarized\"\ndensity = 3\nbell = \"yes\"\ncolumns = [\"step\", \"mood\"]\n[colors]\nrunning = \"blue\"\nteal = \"#008080\"",
        );
        assert_eq!(s.theme, ThemeName::Terminal);
        assert_eq!(s.density, Density::Compact);
        assert!(s.bell);
        assert_eq!(s.columns, vec![Column::Step]);
        assert!(s.colors.is_empty());
        assert_eq!(warnings, vec![
            "Line 1: theme \"solarized\" isn't built in, and there's no [themes.solarized] table; using terminal.".to_string(),
            "Line 2: density can be compact or comfortable, not 3; using compact.".into(),
            "Line 3: bell can be true or false, not \"yes\"; using true.".into(),
            "Line 4: \"mood\" isn't a column (agent, step, age, cost or project), so it was left out.".into(),
            "Line 6: running needs a colour like \"#1a2b3c\", not \"blue\"; the theme's own is used.".into(),
            "Line 7: there's no colour called teal, so it was ignored (paper, ink, muted, line, selection, selection-ink, needs-you, running, passed, failed, ground, raised, fill, running-soft, passed-soft, failed-soft).".into(),
        ]);
    }

    #[test]
    fn unreadable_lines_and_repeats_are_said() {
        let (s, warnings) =
            parse("theme = \"dark\"\ntheme = \"light\"\nnot toml at all\ndensity = \"compact");
        assert_eq!(s.theme, ThemeName::Dark);
        assert_eq!(
            warnings,
            vec![
                "Line 3 isn't understood, so it was ignored.".to_string(),
                "Line 4 isn't understood, so it was ignored.".into(),
                "Line 2: theme is set twice; the first one is used.".into(),
            ]
        );
    }

    #[test]
    fn hostile_text_in_the_file_is_cleaned_in_warnings() {
        let (_, warnings) = parse("theme = \"\\u001b]52;c;aGk=\\u0007\"");
        assert_eq!(warnings.len(), 1);
        assert!(!warnings[0].chars().any(|c| c.is_control()), "{warnings:?}");
    }

    #[test]
    fn the_path_follows_xdg_then_home() {
        let env = Env {
            home: Some("/home/me".into()),
            ..Env::default()
        };
        assert_eq!(
            env.settings_path(),
            Some(PathBuf::from("/home/me/.config/toolroll/tui.toml"))
        );
        let env = Env {
            home: Some("/home/me".into()),
            xdg_config_home: Some("/home/me/cfg".into()),
            ..Env::default()
        };
        assert_eq!(
            env.settings_path(),
            Some(PathBuf::from("/home/me/cfg/toolroll/tui.toml"))
        );
        // A relative XDG_CONFIG_HOME is not one (the XDG rule).
        let env = Env {
            home: Some("/home/me".into()),
            xdg_config_home: Some("cfg".into()),
            ..Env::default()
        };
        assert_eq!(
            env.settings_path(),
            Some(PathBuf::from("/home/me/.config/toolroll/tui.toml"))
        );
        assert_eq!(Env::default().settings_path(), None);
    }

    #[test]
    fn only_a_private_plain_file_is_read() {
        assert_eq!(judge(true, 501, 0o100644, 10, 501), Ok(()));
        assert_eq!(judge(true, 501, 0o100600, 10, 501), Ok(()));
        assert!(judge(false, 501, 0o100644, 10, 501).is_err());
        assert_eq!(
            judge(true, 0, 0o100644, 10, 501),
            Err("it belongs to another user")
        );
        assert!(judge(true, 501, 0o100664, 10, 501).is_err());
        assert!(judge(true, 501, 0o100646, 10, 501).is_err());
        assert!(judge(true, 501, 0o100644, MAX_BYTES + 1, 501).is_err());
    }
}
