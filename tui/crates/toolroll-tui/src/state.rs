//! Where you left off: the last task, tab and scroll position, the list's filter and the layout, kept in a small file
//! of our own so the workbench opens there next time.
//!
//! The file is `$XDG_STATE_HOME/toolroll/tui-state.toml` (when that is an absolute path), else
//! `~/.local/state/toolroll/tui-state.toml`. It holds ids and words of ours only — never a credential, never a title or
//! anything an agent wrote, never a note (unsent notes stay in memory, as always). It is written owner-only (0600, its
//! folder 0700), atomically (a new file renamed over the old), and read only when it is a plain file of this user's
//! that nobody else can read or change, in a folder nobody else can change. Strict: a line, key or value it doesn't
//! expect means the whole file is ignored and the workbench starts fresh.
use crate::app::{Filter, Tab};
use crate::panes::Layout;
use std::path::{Path, PathBuf};

/// Bigger than this is not our state file.
pub const MAX_BYTES: u64 = 4096;
const HEAD: &str =
    "# Where the terminal workbench left off. Written by Toolroll; safe to delete.\n";

#[derive(Debug, Clone, PartialEq)]
pub struct Resume {
    pub task: Option<String>,
    pub tab: Tab,
    /// Live: lines up from the newest (0 follows it); Diff: the line the cursor is on.
    pub scroll: usize,
    /// Diff: the file shown (its place in the list).
    pub diff_file: usize,
    pub filter: Filter,
    pub layout: Layout,
}

impl Default for Resume {
    fn default() -> Resume {
        Resume {
            task: None,
            tab: Tab::Live,
            scroll: 0,
            diff_file: 0,
            filter: Filter::All,
            layout: Layout::Focused,
        }
    }
}

/// An id as the state file may hold it: the engine's own id characters only, short (anything else is not kept).
pub fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}

fn tab_key(tab: Tab) -> &'static str {
    match tab {
        Tab::Live => "live",
        Tab::Steps => "steps",
        Tab::Diff => "diff",
        Tab::Terminal => "terminal",
    }
}

fn tab_of(key: &str) -> Option<Tab> {
    Tab::ALL.into_iter().find(|t| tab_key(*t) == key)
}

impl Resume {
    /// The file's text: our keys and values only.
    pub fn text(&self) -> String {
        let mut out = String::from(HEAD);
        out.push_str("version = 1\n");
        if let Some(task) = self.task.as_deref().filter(|t| safe_id(t)) {
            out.push_str(&format!("task = \"{task}\"\n"));
        }
        out.push_str(&format!("tab = \"{}\"\n", tab_key(self.tab)));
        out.push_str(&format!("scroll = {}\n", self.scroll.min(1_000_000)));
        out.push_str(&format!("diff-file = {}\n", self.diff_file.min(100_000)));
        out.push_str(&format!("filter = \"{}\"\n", self.filter.key()));
        out.push_str(&format!("layout = \"{}\"\n", self.layout.key()));
        out
    }

    /// The file's text read back: every line one of ours with a value we wrote, else None (start fresh).
    pub fn parse(text: &str) -> Option<Resume> {
        let mut r = Resume::default();
        let mut version = false;
        let mut seen: Vec<&str> = vec![];
        for raw in text.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let (key, value) = line.split_once(" = ")?;
            if seen.contains(&key) {
                return None;
            }
            seen.push(key);
            let quoted = || -> Option<&str> {
                let v = value.strip_prefix('"')?.strip_suffix('"')?;
                (!v.contains('"') && !v.contains('\\')).then_some(v)
            };
            let number = || -> Option<usize> {
                (!value.is_empty() && value.len() <= 7 && value.bytes().all(|b| b.is_ascii_digit()))
                    .then(|| value.parse().ok())
                    .flatten()
            };
            match key {
                "version" => {
                    if value != "1" {
                        return None;
                    }
                    version = true;
                }
                "task" => {
                    let id = quoted()?;
                    if !safe_id(id) {
                        return None;
                    }
                    r.task = Some(id.to_string());
                }
                "tab" => r.tab = tab_of(quoted()?)?,
                "scroll" => r.scroll = number()?,
                "diff-file" => r.diff_file = number()?,
                "filter" => r.filter = Filter::from_key(quoted()?)?,
                "layout" => r.layout = Layout::from_key(quoted()?)?,
                _ => return None,
            }
        }
        version.then_some(r)
    }
}

/// Deterministic 128-bit hex digest of a `(workspace_id, account)` tuple so raw identifiers never enter filenames.
pub fn remote_namespace_hash(workspace_id: &str, account: &str) -> String {
    let input = format!("toolroll-remote-state-v1\0{workspace_id}\0{account}");
    let mut h1: u64 = 0xcbf2_9ce4_8422_2325;
    let mut h2: u64 = 0x8422_2325_cbf2_9ce4;
    for (i, b) in input.bytes().enumerate() {
        h1 ^= u64::from(b);
        h1 = h1.wrapping_mul(0x0000_0100_0000_01b3);
        h2 ^= u64::from(b).wrapping_add(i as u64);
        h2 = h2.wrapping_mul(0x9e37_79b9_7f4a_7c15);
    }
    format!("{h1:016x}{h2:016x}")
}

/// The state file: under `XDG_STATE_HOME` when it is set (an absolute path), else `~/.local/state`.
pub fn path(env: &crate::settings::Env) -> Option<PathBuf> {
    if let Some(x) = env.xdg_state_home.as_ref().filter(|p| p.is_absolute()) {
        return Some(x.join("toolroll").join("tui-state.toml"));
    }
    env.home.as_ref().filter(|p| p.is_absolute()).map(|h| {
        h.join(".local")
            .join("state")
            .join("toolroll")
            .join("tui-state.toml")
    })
}

/// Central/remote state file, isolated per `(workspace_id, account)` so remote sessions never import or overwrite
/// legacy local task selection.
pub fn remote_path(
    env: &crate::settings::Env,
    workspace_id: &str,
    account: &str,
) -> Option<PathBuf> {
    let tag = remote_namespace_hash(workspace_id, account);
    path(env).map(|p| p.with_file_name(format!("tui-state-remote-{tag}.toml")))
}

/// Whether a file with these facts is ours to read: a plain file, this user's, that nobody else can read or change.
pub fn judge(regular: bool, uid: u32, mode: u32, size: u64, me: u32) -> Result<(), &'static str> {
    if !regular {
        return Err("it isn't a plain file");
    }
    if uid != me {
        return Err("it belongs to another user");
    }
    if mode & 0o077 != 0 {
        return Err("other people can read or change it");
    }
    if size > MAX_BYTES {
        return Err("it is too large");
    }
    Ok(())
}

/// Read where you left off, when the file is safe to read and reads cleanly; else None (never an error to say: the
/// workbench just starts fresh).
#[cfg(unix)]
pub fn load(path: &Path) -> Option<Resume> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    // SAFETY: geteuid has no preconditions.
    let me = unsafe { libc::geteuid() };
    let dir = std::fs::symlink_metadata(path.parent()?).ok()?;
    if !dir.is_dir() || dir.uid() != me || dir.mode() & 0o022 != 0 {
        return None;
    }
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .ok()?;
    let m = file.metadata().ok()?;
    judge(m.file_type().is_file(), m.uid(), m.mode(), m.len(), me).ok()?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_BYTES {
        return None;
    }
    Resume::parse(std::str::from_utf8(&bytes).ok()?)
}

#[cfg(not(unix))]
pub fn load(_path: &Path) -> Option<Resume> {
    None
}

/// Write where you left off: the folder made owner-only when it is made here (and never written into when someone
/// else could change it), a new owner-only file beside the old one, then renamed over it (a link there is replaced,
/// never followed).
#[cfg(unix)]
pub fn save(path: &Path, resume: &Resume) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
    let dir = path
        .parent()
        .ok_or_else(|| std::io::Error::other("no folder"))?;
    if std::fs::symlink_metadata(dir).is_err() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
    }
    // SAFETY: geteuid has no preconditions.
    let me = unsafe { libc::geteuid() };
    let m = std::fs::symlink_metadata(dir)?;
    if !m.is_dir() || m.uid() != me || m.mode() & 0o022 != 0 {
        return Err(std::io::Error::other("the folder isn't only yours"));
    }
    let tmp = dir.join(format!(".tui-state.{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&tmp)?;
    let wrote = file
        .write_all(resume.text().as_bytes())
        .and_then(|_| file.sync_all());
    drop(file);
    if let Err(e) = wrote.and_then(|_| std::fs::rename(&tmp, path)) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

#[cfg(not(unix))]
pub fn save(_path: &Path, _resume: &Resume) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tr-state-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        dir
    }

    fn sample() -> Resume {
        Resume {
            task: Some("t-done".into()),
            tab: Tab::Diff,
            scroll: 14,
            diff_file: 2,
            filter: Filter::NeedsMe,
            layout: Layout::SideBySide,
        }
    }

    #[test]
    fn written_and_read_back_owner_only() {
        let dir = temp("round");
        let path = dir.join("toolroll").join("tui-state.toml");
        save(&path, &sample()).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let folder = std::fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(folder & 0o777, 0o700);
        assert_eq!(load(&path), Some(sample()));
        // Written again over the old one.
        let again = Resume {
            scroll: 3,
            ..sample()
        };
        save(&path, &again).unwrap();
        assert_eq!(load(&path), Some(again));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unsafe_file_is_ignored() {
        let dir = temp("unsafe");
        let path = dir.join("tui-state.toml");
        std::fs::write(&path, sample().text()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(load(&path), None, "others can read it");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(load(&path), Some(sample()));
        // A link is never followed, even to a good file.
        let link = dir.join("link.toml");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert_eq!(load(&link), None);
        // A folder others can change.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert_eq!(load(&path), None);
        assert!(
            save(&path, &sample()).is_err(),
            "never written into a folder others can change"
        );
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        // Too large.
        std::fs::write(&path, "#".repeat(MAX_BYTES as usize + 1)).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(load(&path), None);
        assert_eq!(judge(true, 501, 0o100600, 10, 501), Ok(()));
        assert!(judge(true, 501, 0o100640, 10, 501).is_err());
        assert!(judge(true, 0, 0o100600, 10, 501).is_err());
        assert!(judge(false, 501, 0o100600, 10, 501).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn strict_parse() {
        assert_eq!(Resume::parse(&sample().text()), Some(sample()));
        let good = sample().text();
        for bad in [
            good.replace("version = 1", "version = 2"),
            good.replace("version = 1\n", ""),
            format!("{good}token = \"abc\"\n"),
            format!("{good}scroll = 3\n"),
            good.replace("tab = \"diff\"", "tab = \"mail\""),
            good.replace("scroll = 14", "scroll = -1"),
            good.replace("scroll = 14", "scroll = 99999999"),
            good.replace("t-done", "t done"),
            good.replace("t-done", "t-\u{1b}]8;;x"),
            good.replace("\"t-done\"", "\"t-done\\\"\""),
            good.replace("filter = \"needs-me\"", "filter = needs-me"),
            "not a state file".to_string(),
        ] {
            assert_eq!(Resume::parse(&bad), None, "{bad:?}");
        }
    }

    #[test]
    fn no_secret_or_agent_text_is_ever_written() {
        // Only our keys, and a task id only when it is an id.
        let r = Resume {
            task: Some("Bearer sk-ant-api03-secret and an agent's words".into()),
            ..sample()
        };
        let text = r.text();
        assert!(
            !text.contains("sk-ant") && !text.contains("agent"),
            "{text}"
        );
        for line in text.lines().filter(|l| !l.starts_with('#')) {
            let key = line.split(" = ").next().unwrap();
            assert!(
                [
                    "version",
                    "tab",
                    "scroll",
                    "diff-file",
                    "filter",
                    "layout",
                    "task"
                ]
                .contains(&key),
                "{line}"
            );
        }
    }

    #[test]
    fn the_path_follows_xdg_state_then_home() {
        let env = crate::settings::Env {
            home: Some("/home/me".into()),
            ..Default::default()
        };
        assert_eq!(
            path(&env),
            Some(PathBuf::from(
                "/home/me/.local/state/toolroll/tui-state.toml"
            ))
        );
        let env = crate::settings::Env {
            home: Some("/home/me".into()),
            xdg_state_home: Some("/home/me/st".into()),
            ..Default::default()
        };
        assert_eq!(
            path(&env),
            Some(PathBuf::from("/home/me/st/toolroll/tui-state.toml"))
        );
        let env = crate::settings::Env {
            home: Some("/home/me".into()),
            xdg_state_home: Some("st".into()),
            ..Default::default()
        };
        assert_eq!(
            path(&env),
            Some(PathBuf::from(
                "/home/me/.local/state/toolroll/tui-state.toml"
            ))
        );
    }

    #[test]
    fn remote_state_paths_are_isolated_per_workspace_and_account_without_raw_identifiers() {
        let env = crate::settings::Env {
            home: Some("/home/me".into()),
            ..Default::default()
        };
        let local = path(&env).unwrap();
        let a_alice = remote_path(&env, "11111111-1111-4111-8111-111111111111", "alice").unwrap();
        let a_bob = remote_path(&env, "11111111-1111-4111-8111-111111111111", "bob").unwrap();
        let b_alice = remote_path(&env, "22222222-2222-4222-8222-222222222222", "alice").unwrap();
        let hostile = remote_path(&env, "../../etc", "alice/evil").unwrap();

        assert_ne!(local, a_alice);
        assert_ne!(a_alice, a_bob);
        assert_ne!(a_alice, b_alice);
        assert_eq!(local.parent(), hostile.parent());
        let name = hostile.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("tui-state-remote-"));
        assert!(name.ends_with(".toml"));
        assert!(!name.contains("etc") && !name.contains("alice") && !name.contains(".."));
    }
}
