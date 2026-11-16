//! Open a pane's text in the person's editor (ctrl-e): the pane's already-cleaned text only, written to a private
//! temporary file (a fresh folder of its own, mode 0700, and the file in it, mode 0600, never through a link), the
//! editor run on it as a program and its arguments (`$VISUAL`, else `$EDITOR`, split on whitespace, never through a
//! shell), and both removed once the editor ends. An agent's sign-in or install pane is never exported (search.rs
//! pane_text refuses it).
use std::path::{Path, PathBuf};

/// The editor command: `$VISUAL`, else `$EDITOR`, as a program and its arguments (split on whitespace: no shell, no
/// quoting, no expansion). None: neither is set, or it is blank, or its words can't be a command.
pub fn editor_command(visual: Option<&str>, editor: Option<&str>) -> Option<(String, Vec<String>)> {
    let raw = visual
        .filter(|v| !v.trim().is_empty())
        .or(editor.filter(|v| !v.trim().is_empty()))?;
    let mut words = raw.split_whitespace().map(str::to_string);
    let program = words.next()?;
    // Control characters in a command line are never what a person set.
    if raw.chars().any(|c| c.is_control() && c != '\t') {
        return None;
    }
    Some((program, words.collect()))
}

/// A private file holding `text`: a fresh folder (0700) under `base`, and `name` (0600) in it, both new (never an
/// existing path, never through a link). Returns (folder, file).
#[cfg(unix)]
pub fn private_file(base: &Path, name: &str, text: &str) -> std::io::Result<(PathBuf, PathBuf)> {
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = base.join(format!("toolroll-pane-{}-{nanos}", std::process::id()));
    // A new folder (create, never reuse: an existing one is an error), owner-only.
    std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
    let safe: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(32)
        .collect();
    let file = dir.join(format!(
        "{}.txt",
        if safe.is_empty() { "pane" } else { &safe }
    ));
    let written = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&file)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()
    })();
    if let Err(e) = written {
        remove(&dir, &file);
        return Err(e);
    }
    Ok((dir, file))
}

#[cfg(not(unix))]
pub fn private_file(_base: &Path, _name: &str, _text: &str) -> std::io::Result<(PathBuf, PathBuf)> {
    Err(std::io::Error::other("not on this system"))
}

/// Every descriptor this process holds above the standard three marked close-on-exec, so the editor inherits none of
/// them (the launcher's control descriptor above all: a child must never speak to the launcher as this screen).
#[cfg(unix)]
pub fn close_on_exec_all() {
    let fds: Vec<i32> = std::fs::read_dir("/dev/fd")
        .map(|d| {
            d.flatten()
                .filter_map(|e| e.file_name().to_str()?.parse::<i32>().ok())
                .filter(|fd| *fd > 2)
                .collect()
        })
        .unwrap_or_default();
    for fd in fds {
        // SAFETY: fcntl on a descriptor number only reads and sets its flags; a closed one fails harmlessly.
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFD);
            if flags != -1 {
                libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
            }
        }
    }
}

#[cfg(not(unix))]
pub fn close_on_exec_all() {}

/// Remove the file and its folder (whatever the editor left in that folder goes too: it was ours).
pub fn remove(dir: &Path, file: &Path) {
    let _ = std::fs::remove_file(file);
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_editor_is_a_program_and_words_never_a_shell_line() {
        assert_eq!(
            editor_command(None, Some("nvim -R")),
            Some(("nvim".into(), vec!["-R".into()]))
        );
        assert_eq!(
            editor_command(Some("code --wait"), Some("vi")),
            Some(("code".into(), vec!["--wait".into()]))
        );
        assert_eq!(
            editor_command(Some("  "), Some("vi")),
            Some(("vi".into(), vec![]))
        );
        assert_eq!(editor_command(None, None), None);
        // Shell syntax is just words: `;` is an argument, never a second command.
        assert_eq!(
            editor_command(None, Some("vi; rm -rf ~")),
            Some(("vi;".into(), vec!["rm".into(), "-rf".into(), "~".into()]))
        );
        assert_eq!(editor_command(None, Some("vi\u{1b}]52")), None);
    }

    #[cfg(unix)]
    #[test]
    fn no_descriptor_reaches_the_editor() {
        use std::os::fd::AsRawFd;
        let f = std::fs::File::open("/dev/null").unwrap();
        let fd = f.as_raw_fd();
        // SAFETY: clearing the flag on our own open descriptor.
        unsafe { libc::fcntl(fd, libc::F_SETFD, 0) };
        close_on_exec_all();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        assert_ne!(flags & libc::FD_CLOEXEC, 0);
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_private_new_and_gone_after() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let base = std::env::temp_dir().join(format!("tr-editor-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
        let (dir, file) = private_file(&base, "live/../x", "line one\nline two\n").unwrap();
        assert_eq!(std::fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        assert_eq!(std::fs::metadata(&file).unwrap().mode() & 0o777, 0o600);
        assert_eq!(file.parent().unwrap(), dir);
        assert_eq!(file.file_name().unwrap(), "livex.txt");
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "line one\nline two\n"
        );
        remove(&dir, &file);
        assert!(!dir.exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
