//! The view, remembered per project: how wide the list is and whether it shows (full, a slim rail, or hidden), which
//! side it is on, the layout and its split ratios, the tab and the task last open, and which finished tasks you haven't
//! opened yet (unread). Machine-written state, never tui.toml (which stays the person's own).
//!
//! The file is `$XDG_STATE_HOME/toolroll/view.json` (when that is an absolute path), else
//! `~/.local/state/toolroll/view.json`. Each project is keyed by a hash of the project the console names (never its path
//! in the file). It holds ids and words of ours only: never a title, a credential, or anything an agent wrote.
//!
//! Written through the settings writer's road (settings.rs write_within: every folder up to the root trusted, the
//! folder opened and the file replaced through it, a fresh 0600 temporary file renamed over the name). Read strictly:
//! only a plain owner-only file of this user's, at most MAX_BYTES, in a folder chain nobody else can change; a key it
//! doesn't know is skipped, a value it can't use is the default, and anything that doesn't parse is a fresh start.
use crate::app::Tab;
use crate::panes::Layout;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Bigger than this is not our view file.
pub const MAX_BYTES: u64 = 64 * 1024;
/// At most this many projects are remembered (the least recently used goes).
pub const MAX_PROJECTS: usize = 32;
/// At most this many unread tasks per project.
pub const MAX_UNREAD: usize = 200;

/// Where the list is drawn: whole, as a slim rail of status marks, or not at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListState {
    Full,
    Rail,
    Hidden,
}

impl ListState {
    pub fn key(self) -> &'static str {
        match self {
            ListState::Full => "full",
            ListState::Rail => "rail",
            ListState::Hidden => "hidden",
        }
    }
    pub fn from_key(k: &str) -> Option<ListState> {
        [ListState::Full, ListState::Rail, ListState::Hidden]
            .into_iter()
            .find(|s| s.key() == k)
    }
    /// The next state `b` turns to: full, rail, hidden, full.
    pub fn next(self) -> ListState {
        match self {
            ListState::Full => ListState::Rail,
            ListState::Rail => ListState::Hidden,
            ListState::Hidden => ListState::Full,
        }
    }
}

/// Which side the list is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
}

impl Side {
    pub fn key(self) -> &'static str {
        match self {
            Side::Left => "left",
            Side::Right => "right",
        }
    }
    pub fn from_key(k: &str) -> Option<Side> {
        match k {
            "left" => Some(Side::Left),
            "right" => Some(Side::Right),
            _ => None,
        }
    }
    pub fn other(self) -> Side {
        match self {
            Side::Left => Side::Right,
            Side::Right => Side::Left,
        }
    }
}

/// One project's view.
#[derive(Debug, Clone, PartialEq)]
pub struct View {
    /// The list's width in columns (None: the tui.toml default).
    pub list_width: Option<u16>,
    pub list: ListState,
    /// None: the tui.toml default.
    pub side: Option<Side>,
    pub layout: Layout,
    /// The first column's share of the panels' width, and the first row's of their height (percent, 20..=80).
    pub ratio_x: u16,
    pub ratio_y: u16,
    pub tab: Tab,
    pub task: Option<String>,
    /// Finished, failed or answered tasks not opened since (ids).
    pub unread: Vec<String>,
    /// Each thread's news last looked at (thread id, its news key: thread.rs news_key).
    pub thread_seen: Vec<(String, String)>,
}

impl Default for View {
    fn default() -> View {
        View {
            list_width: None,
            list: ListState::Full,
            side: None,
            layout: Layout::Focused,
            ratio_x: 50,
            ratio_y: 50,
            tab: Tab::Live,
            task: None,
            unread: vec![],
            thread_seen: vec![],
        }
    }
}

/// Every project's view, by key, with when each was last used (seconds), for MAX_PROJECTS.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ViewFile {
    pub projects: BTreeMap<String, (View, i64)>,
}

/// The key for a project: FNV-1a over the identity the console names (its project path), never the path itself.
pub fn project_key(identity: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in identity.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("p{h:016x}")
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

fn key_ok(k: &str) -> bool {
    k.len() == 17 && k.starts_with('p') && k[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

impl View {
    fn to_json(&self) -> Value {
        let mut m = Map::new();
        if let Some(w) = self.list_width {
            m.insert("listWidth".into(), json!(w));
        }
        m.insert("list".into(), json!(self.list.key()));
        if let Some(s) = self.side {
            m.insert("side".into(), json!(s.key()));
        }
        m.insert("layout".into(), json!(self.layout.key()));
        m.insert("ratioX".into(), json!(self.ratio_x));
        m.insert("ratioY".into(), json!(self.ratio_y));
        m.insert("tab".into(), json!(tab_key(self.tab)));
        if let Some(t) = self.task.as_deref().filter(|t| crate::state::safe_id(t)) {
            m.insert("task".into(), json!(t));
        }
        let unread: Vec<&String> = self
            .unread
            .iter()
            .filter(|t| crate::state::safe_id(t))
            .take(MAX_UNREAD)
            .collect();
        m.insert("unread".into(), json!(unread));
        let seen: Map<String, Value> = self
            .thread_seen
            .iter()
            .filter(|(id, k)| crate::state::safe_id(id) && news_key_ok(k))
            .take(MAX_UNREAD)
            .map(|(id, k)| (id.clone(), json!(k)))
            .collect();
        if !seen.is_empty() {
            m.insert("threadSeen".into(), Value::Object(seen));
        }
        Value::Object(m)
    }

    /// One project's view, each key read on its own: a value it can't use is that key's default.
    fn from_json(v: &Value) -> View {
        let mut out = View::default();
        let Some(m) = v.as_object() else {
            return out;
        };
        let small = |k: &str, lo: u64, hi: u64| {
            m.get(k)
                .and_then(Value::as_u64)
                .filter(|n| (lo..=hi).contains(n))
                .map(|n| n as u16)
        };
        let word = |k: &str| m.get(k).and_then(Value::as_str);
        out.list_width = small("listWidth", 20, 200);
        if let Some(l) = word("list").and_then(ListState::from_key) {
            out.list = l;
        }
        out.side = word("side").and_then(Side::from_key);
        if let Some(l) = word("layout").and_then(Layout::from_key) {
            out.layout = l;
        }
        out.ratio_x = small("ratioX", 20, 80).unwrap_or(50);
        out.ratio_y = small("ratioY", 20, 80).unwrap_or(50);
        if let Some(t) = word("tab").and_then(tab_of) {
            out.tab = t;
        }
        out.task = word("task")
            .filter(|t| crate::state::safe_id(t))
            .map(str::to_string);
        if let Some(seen) = m.get("threadSeen").and_then(Value::as_object) {
            out.thread_seen = seen
                .iter()
                .filter_map(|(id, k)| k.as_str().map(|k| (id.clone(), k.to_string())))
                .filter(|(id, k)| crate::state::safe_id(id) && news_key_ok(k))
                .take(MAX_UNREAD)
                .collect();
        }
        if let Some(list) = m.get("unread").and_then(Value::as_array) {
            out.unread = list
                .iter()
                .filter_map(Value::as_str)
                .filter(|t| crate::state::safe_id(t))
                .take(MAX_UNREAD)
                .map(str::to_string)
                .collect();
        }
        out
    }
}

impl ViewFile {
    /// The file's text.
    pub fn text(&self) -> String {
        let mut projects = Map::new();
        for (k, (v, at)) in &self.projects {
            if key_ok(k) {
                let mut j = v.to_json();
                j["at"] = json!(at.max(&0));
                projects.insert(k.clone(), j);
            }
        }
        let mut s = serde_json::to_string_pretty(&json!({ "version": 1, "projects": projects }))
            .unwrap_or_default();
        s.push('\n');
        s
    }

    /// The file's text read back: version 1, and each project whose key is ours (anything else: a fresh start).
    pub fn parse(text: &str) -> ViewFile {
        let mut out = ViewFile::default();
        let Ok(v) = serde_json::from_str::<Value>(text) else {
            return out;
        };
        if v.get("version").and_then(Value::as_u64) != Some(1) {
            return out;
        }
        let Some(projects) = v.get("projects").and_then(Value::as_object) else {
            return out;
        };
        for (k, p) in projects
            .iter()
            .filter(|(k, _)| key_ok(k))
            .take(MAX_PROJECTS)
        {
            // As the writer keeps it: never before 1970 (a negative time would read back as 0, another view).
            let at = p.get("at").and_then(Value::as_i64).unwrap_or(0).max(0);
            out.projects.insert(k.clone(), (View::from_json(p), at));
        }
        out
    }

    /// Keep this project's view (used `now`), dropping the least recently used beyond MAX_PROJECTS.
    pub fn put(&mut self, key: &str, view: View, now: i64) {
        self.projects.insert(key.to_string(), (view, now));
        while self.projects.len() > MAX_PROJECTS {
            let oldest = self
                .projects
                .iter()
                .min_by_key(|(_, (_, at))| *at)
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => {
                    self.projects.remove(&k);
                }
                None => break,
            }
        }
    }
}

/// The view file: under `XDG_STATE_HOME` when it is set (an absolute path), else `~/.local/state`.
pub fn path(env: &crate::settings::Env) -> Option<PathBuf> {
    crate::state::path(env).map(|p| p.with_file_name("view.json"))
}

/// Central/remote view file, isolated per `(workspace_id, account)`.
pub fn remote_path(
    env: &crate::settings::Env,
    workspace_id: &str,
    account: &str,
) -> Option<PathBuf> {
    let tag = crate::state::remote_namespace_hash(workspace_id, account);
    crate::state::path(env).map(|p| p.with_file_name(format!("view-remote-{tag}.json")))
}

/// Scoped view key for a central workspace + account + project (never collides with local folder paths).
pub fn remote_project_key(workspace_id: &str, account: &str, project: &str) -> String {
    project_key(&format!("central-v1\0{workspace_id}\0{account}\0{project}"))
}

/// Read the view file when it is safe to: every folder up to the root trusted, the file a plain owner-only file of
/// this user's (never through a link), at most MAX_BYTES. Anything else: a fresh start.
#[cfg(unix)]
pub fn load(path: &Path, home: Option<&Path>) -> ViewFile {
    use std::io::Read;
    use std::os::unix::fs::MetadataExt;
    let read = || -> Option<String> {
        // SAFETY: geteuid has no preconditions.
        let me = unsafe { libc::geteuid() };
        // Every folder from `/` down opened and judged by descriptor; the file opened relative to the last, never
        // through a link.
        let dir = crate::settings::walk_trusted(
            &crate::settings::real_path_of(path.parent()?),
            home,
            me,
            false,
        )
        .ok()??;
        let mut file = crate::settings::open_at(&dir, path.file_name()?).ok()?;
        let m = file.metadata().ok()?;
        if !m.file_type().is_file() || m.uid() != me || m.mode() & 0o077 != 0 || m.len() > MAX_BYTES
        {
            return None;
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() as u64 > MAX_BYTES {
            return None;
        }
        String::from_utf8(bytes).ok()
    };
    read().map(|t| ViewFile::parse(&t)).unwrap_or_default()
}

#[cfg(not(unix))]
pub fn load(_path: &Path, _home: Option<&Path>) -> ViewFile {
    ViewFile::default()
}

/// Write the view file (settings.rs write_within: the folder chain trusted, owner-only, atomic).
#[cfg(unix)]
pub fn save(path: &Path, home: Option<&Path>, file: &ViewFile) -> Result<(), String> {
    let text = file.text();
    crate::settings::write_within(path, home, "", MAX_BYTES, true, &|_| text.clone())
}

#[cfg(not(unix))]
pub fn save(_path: &Path, _home: Option<&Path>, _file: &ViewFile) -> Result<(), String> {
    Ok(())
}

/// A thread's news key as thread.rs news_key writes it: a turn number and state, a Ship number and state, short and plain.
fn news_key_ok(key: &str) -> bool {
    key.len() <= 64
        && key.split(':').count() == 4
        && key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b':' || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_project_key_is_a_hash_never_the_path() {
        let k = project_key("/Users/me/secret-project");
        assert!(key_ok(&k) && !k.contains("secret"), "{k}");
        assert_eq!(k, project_key("/Users/me/secret-project"));
        assert_ne!(k, project_key("/Users/me/other"));
    }

    #[test]
    fn it_reads_back_what_it_wrote_and_defaults_whatever_it_cant_use() {
        let mut f = ViewFile::default();
        let v = View {
            list_width: Some(52),
            list: ListState::Rail,
            side: Some(Side::Right),
            layout: Layout::SideBySide,
            ratio_x: 60,
            ratio_y: 40,
            tab: Tab::Diff,
            task: Some("t-1".into()),
            unread: vec!["t-2".into(), "bad id!".into()],
            // A thread's news seen is kept; a key that isn't one (a mark it didn't write) is dropped.
            thread_seen: vec![
                ("th-1".into(), "3:finished:0:-".into()),
                ("th-2".into(), "x\u{1b}]0;y".into()),
            ],
        };
        f.put(&project_key("/p"), v.clone(), 10);
        let back = ViewFile::parse(&f.text());
        let (got, at) = &back.projects[&project_key("/p")];
        assert_eq!(*at, 10);
        assert_eq!(
            got,
            &View {
                unread: vec!["t-2".into()],
                thread_seen: vec![("th-1".into(), "3:finished:0:-".into())],
                ..v
            }
        );
        // Bad values are each that key's default; unknown keys are skipped; a bad key isn't a project.
        let odd = r#"{"version":1,"projects":{"p0123456789abcdef":{"listWidth":9999,"list":"sideways","side":3,
            "layout":"grid","ratioX":5,"tab":"diff","task":"has space","unread":"no","surprise":true},"../etc":{}}}"#;
        let back = ViewFile::parse(odd);
        assert_eq!(back.projects.len(), 1);
        let (got, _) = &back.projects["p0123456789abcdef"];
        assert_eq!(
            got,
            &View {
                layout: Layout::Grid,
                tab: Tab::Diff,
                ..View::default()
            }
        );
        // Another version, or not JSON: a fresh start.
        assert_eq!(
            ViewFile::parse(r#"{"version":2,"projects":{}}"#),
            ViewFile::default()
        );
        assert_eq!(ViewFile::parse("not json"), ViewFile::default());
    }

    #[test]
    fn the_least_recently_used_project_goes_beyond_the_cap() {
        let mut f = ViewFile::default();
        for i in 0..(MAX_PROJECTS as i64 + 3) {
            f.put(&project_key(&format!("/p{i}")), View::default(), i);
        }
        assert_eq!(f.projects.len(), MAX_PROJECTS);
        assert!(!f.projects.contains_key(&project_key("/p0")));
        assert!(f
            .projects
            .contains_key(&project_key(&format!("/p{}", MAX_PROJECTS + 2))));
    }

    #[cfg(unix)]
    #[test]
    fn it_is_written_owner_only_and_never_read_when_others_can() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let home = std::env::temp_dir().join(format!("tr-view-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        let home = home.canonicalize().unwrap();
        let path = home.join(".local/state/toolroll/view.json");
        let mut f = ViewFile::default();
        f.put(&project_key("/p"), View::default(), 1);
        save(&path, Some(&home), &f).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        assert_eq!(load(&path, Some(&home)), f);
        // Readable by others: not read.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(load(&path, Some(&home)), ViewFile::default());
        // A link: not read, not written through.
        std::fs::remove_file(&path).unwrap();
        let elsewhere = home.join("elsewhere.json");
        std::fs::write(&elsewhere, f.text()).unwrap();
        std::fs::set_permissions(&elsewhere, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &path).unwrap();
        assert_eq!(load(&path, Some(&home)), ViewFile::default());
        assert!(save(&path, Some(&home), &f).is_err());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn remote_view_paths_and_project_keys_are_isolated_from_local_and_other_workspaces() {
        let env = crate::settings::Env {
            home: Some("/home/me".into()),
            ..Default::default()
        };
        let local = path(&env).unwrap();
        let a_alice = remote_path(&env, "11111111-1111-4111-8111-111111111111", "alice").unwrap();
        let b_alice = remote_path(&env, "22222222-2222-4222-8222-222222222222", "alice").unwrap();
        assert_ne!(local, a_alice);
        assert_ne!(a_alice, b_alice);
        assert_eq!(local.parent(), a_alice.parent());
        let key_local = project_key("/srv/app");
        let key_remote_a =
            remote_project_key("11111111-1111-4111-8111-111111111111", "alice", "/srv/app");
        let key_remote_b =
            remote_project_key("22222222-2222-4222-8222-222222222222", "alice", "/srv/app");
        assert_ne!(key_local, key_remote_a);
        assert_ne!(key_remote_a, key_remote_b);
    }
}
