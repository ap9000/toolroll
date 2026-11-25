//! The typed client: one local-owner session, redeemed from a one-time link, held in memory only.
//!
//! - Loopback only: the link must name `http://127.0.0.1:<port>` (or `[::1]`), and every request goes to that origin.
//! - The cookie, the form token and the mutation key are never printed (Debug shows lengths) and never written anywhere;
//!   they are held in zeroizing memory (cleared when dropped), as are the sign-in answer and the link's code. Copies the
//!   HTTP stack makes of them on the way out (header values, request bodies) are its own and aren't cleared: the binary
//!   turns crash dumps off before any of this exists (toolroll-tui guard.rs).
//! - Reads are the engine API's JSON routes; every act is the browser's own form POST, with the form token in the body,
//!   the key in `x-toolroll-key`, the console's own Origin, and `x-toolroll-act: in-place` + `x-toolroll-client: terminal`
//!   so a refusal comes back as its words (`{ outcome, words }`) instead of a page.
//! - A session the console no longer holds (signed out, expired after 12 idle hours, a restart) is `SessionEnded`.
use crate::connection::{
    parse_connection_refusal, parse_remote_connection, ConnectionAccess, ConnectionBinding,
    ConnectionRefusal, ConnectionRole, RemoteCapabilities,
};
use crate::models::*;
use crate::sse::{SseEvent, SseParser};
use futures_util::StreamExt;
use serde::de::DeserializeOwned;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use zeroize::Zeroizing;

/// Why a call didn't give its answer.
#[derive(Debug, Clone, PartialEq)]
pub enum ApiError {
    /// The console no longer holds this session: start again with `toolroll`.
    SessionEnded,
    /// Refused, in the console's words (or its refusal word).
    Refused(String),
    /// The answer isn't the contract's shape (another build, or a bug): said plainly, never its values.
    Contract(String),
    /// The console didn't answer.
    Unreachable(String),
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApiError::SessionEnded => write!(f, "Session ended: run toolroll again."),
            ApiError::Refused(words) => write!(f, "{words}"),
            ApiError::Contract(words) => write!(f, "{words}"),
            ApiError::Unreachable(words) => write!(f, "Toolroll didn't answer: {words}"),
        }
    }
}

/// What an act came to: kept (with words to say), or refused (the console's words).
#[derive(Debug, Clone, PartialEq)]
pub enum ActOutcome {
    Done(String),
    /// A new task was filed (a `/tasks/…` act answered with its page, `/t/<id>`): the words, and the new task's id.
    Filed {
        words: String,
        task: String,
    },
    Refused(String),
    BuilderPassword {
        task: String,
        setup: bool,
    },
    /// New task's offer (POST /tasks/add for a small task): the exact terms Build would approve, and the preview and
    /// digest Build posts (POST /tasks/fast).
    Terms {
        preview: String,
        digest: String,
        terms: Vec<(String, String)>,
    },
    /// A new Flexible thread's terms card (POST /agents/live/thread without a key): every line of it, and the key the
    /// start posts. Nothing was started.
    ThreadTerms {
        key: String,
        lines: Vec<String>,
    },
    /// A thread's Ship terms (POST /agents/live/thread/<id>/ship without a key): every line, the key and digest the press
    /// posts, whether this session may press it here (the laptop road), and otherwise the command that ships with a
    /// password typed now. Nothing was shipped.
    ShipTerms {
        key: String,
        digest: String,
        lines: Vec<String>,
        laptop: bool,
        command: Option<String>,
    },
    /// A new thread started (POST /agents/live/thread with its card's key): the words, and the thread, so it is selected.
    ThreadStarted {
        words: String,
        thread: String,
    },
    /// A new thread refused with what the person still needs first, as the console names it (one of NEXT_STEPS): the
    /// console's words, and the step.
    NextStep {
        words: String,
        next: String,
    },
}

/// The steps a thread start may name as still missing (flexible-start.ts FlexibleNextStep). Anything else is an
/// ordinary refusal.
pub const NEXT_STEPS: [&str; 5] = [
    "turn-on",
    "ask-operator",
    "sign-in",
    "sign-in-refused",
    "project-terms",
];

struct Creds {
    cookie: Zeroizing<String>,
    csrf: Zeroizing<String>,
    key: Zeroizing<String>,
}

impl fmt::Debug for Creds {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Creds {{ cookie: <{} chars>, csrf: <held>, key: <held> }}",
            self.cookie.len()
        )
    }
}

struct RemoteCreds {
    bearer: Zeroizing<String>,
    workspace_id: String,
    recovery_generation: String,
    label: String,
    role: ConnectionRole,
    access: ConnectionAccess,
    capabilities: RemoteCapabilities,
}

impl fmt::Debug for RemoteCreds {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RemoteCreds { bearer: <held>, workspace: <held> }")
    }
}

#[derive(Debug)]
enum ClientAuth {
    Local(Creds),
    Remote(RemoteCreds),
}

/// Non-secret summary of an active remote connection for the TUI header and capability gating.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteInfo {
    pub origin: String,
    pub workspace_id: String,
    pub label: String,
    pub account: String,
    pub role: ConnectionRole,
    pub access: ConnectionAccess,
    pub capabilities: RemoteCapabilities,
}

#[derive(Debug, Clone)]
pub struct Client {
    origin: String,
    http: reqwest::Client,
    auth: Arc<ClientAuth>,
    pub account: String,
}

/// The console's origin and the link's code, from a local owner's one-time link; refused unless it is exactly
/// `http://127.0.0.1:<port>/login/once/<43 url-safe characters>` (or `[::1]`).
pub fn parse_link(link: &str) -> Result<(String, Zeroizing<String>), ApiError> {
    let bad = || ApiError::Refused("That isn't a local sign-in link.".into());
    let rest = link.trim().strip_prefix("http://").ok_or_else(bad)?;
    let (host, path) = rest.split_at(rest.find('/').ok_or_else(bad)?);
    let port = host
        .strip_prefix("127.0.0.1:")
        .or_else(|| host.strip_prefix("[::1]:"))
        .ok_or_else(bad)?;
    if port.is_empty()
        || port.len() > 5
        || !port.bytes().all(|b| b.is_ascii_digit())
        || port.parse::<u32>().map_or(true, |p| p == 0 || p > 65535)
    {
        return Err(bad());
    }
    let code = path.strip_prefix("/login/once/").ok_or_else(bad)?;
    if code.len() != 43
        || !code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(bad());
    }
    Ok((format!("http://{host}"), Zeroizing::new(code.to_string())))
}

fn http_client() -> Result<reqwest::Client, ApiError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| ApiError::Unreachable(e.to_string()))
}

fn json_escape(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// Percent-encode a path segment or form value (everything but unreserved characters).
pub fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn percent_decode_simple(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// Redeem the one-time link (`POST /login/once`, the code in the body): the session, in memory.
pub async fn redeem(link: &str) -> Result<Client, ApiError> {
    let (origin, code) = parse_link(link)?;
    let http = http_client()?;
    let res = http
        .post(format!("{origin}/login/once"))
        .header("content-type", "application/json")
        .header("x-toolroll-client", "terminal")
        .header("accept", "application/json")
        // (The body is the HTTP stack's once handed over; the code is spent on this first use anyway.)
        .body(format!("{{\"code\":{}}}", json_escape(&code)))
        .send()
        .await
        .map_err(|e| ApiError::Unreachable(e.to_string()))?;
    let status = res.status().as_u16();
    let text = Zeroizing::new(
        res.text()
            .await
            .map_err(|e| ApiError::Unreachable(e.to_string()))?,
    );
    if status != 200 {
        let word = serde_json::from_str::<Refusal>(&text)
            .map(|r| r.error)
            .unwrap_or_else(|_| format!("status {status}"));
        return Err(ApiError::Refused(match word.as_str() {
            "used" => "that sign-in link was already used or expired".into(),
            "elsewhere" | "host" => "it can only sign in on this computer".into(),
            "local-owner" => "it signs in only a password-free (local) install".into(),
            other => format!("the console refused it ({other})"),
        }));
    }
    let mut r: LinkRedemption = serde_json::from_str(&text).map_err(|_| {
        ApiError::Contract("The sign-in answer isn't what this version expects.".into())
    })?;
    // The secrets move into zeroizing memory at once (the answer's own strings are left empty).
    let value = Zeroizing::new(std::mem::take(&mut r.cookie.value));
    let csrf = Zeroizing::new(std::mem::take(&mut r.csrf));
    let key = Zeroizing::new(std::mem::take(&mut r.key));
    if r.version != API_VERSION {
        return Err(ApiError::Contract(
            "The sign-in answer is from another Toolroll version.".into(),
        ));
    }
    let hex64 = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit());
    if !hex64(&value)
        || !hex64(&csrf)
        || !hex64(&key)
        || r.cookie.name.is_empty()
        || !r
            .cookie
            .name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(ApiError::Contract(
            "The sign-in answer isn't what this version expects.".into(),
        ));
    }
    Ok(Client {
        origin,
        http,
        auth: Arc::new(ClientAuth::Local(Creds {
            cookie: Zeroizing::new(format!("{}={}", r.cookie.name, value.as_str())),
            csrf,
            key,
        })),
        account: r.account,
    })
}

/// Connect to a remote central Toolroll server with a person API token (`so_...`) and enrolled binding.
/// Performs `GET /engine/connection`, verifies the workspace/recovery/account binding and engine contract digest,
/// and holds the bearer token in zeroizing memory only.
pub async fn connect_remote(
    origin: &str,
    token: &str,
    expected: &ConnectionBinding,
) -> Result<Client, ApiError> {
    let origin = origin.trim().trim_end_matches('/').to_string();
    let loopback_http =
        origin.starts_with("http://127.0.0.1:") || origin.starts_with("http://[::1]:");
    if !origin.starts_with("https://") && !loopback_http {
        return Err(ApiError::Refused(
            "Remote connections require an HTTPS origin.".into(),
        ));
    }
    let http = http_client()?;
    let bearer = Zeroizing::new(format!("Bearer {token}"));
    let res = http
        .get(format!("{origin}/engine/connection"))
        .header("authorization", bearer.as_str())
        .header("x-toolroll-client", "terminal-remote")
        .header("accept", "application/json")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| ApiError::Unreachable(e.to_string()))?;
    let status = res.status().as_u16();
    let text = res
        .text()
        .await
        .map_err(|e| ApiError::Unreachable(e.to_string()))?;
    if status != 200 {
        if let Ok(code) = parse_connection_refusal(&text) {
            return Err(match code {
                ConnectionRefusal::Unauthenticated | ConnectionRefusal::RecoveryChanged => {
                    ApiError::SessionEnded
                }
                ConnectionRefusal::CredentialPurpose => {
                    ApiError::Refused("Use an ordinary API token (not an MCP OAuth token).".into())
                }
                ConnectionRefusal::WorkspaceMismatch => {
                    ApiError::Refused("This server is not the enrolled workspace.".into())
                }
                ConnectionRefusal::WorkspaceUnavailable => {
                    ApiError::Refused("The remote workspace identity is unavailable.".into())
                }
                ConnectionRefusal::ContractUnavailable => {
                    ApiError::Contract("The remote server's contract is unavailable.".into())
                }
                ConnectionRefusal::Request => {
                    ApiError::Refused("The remote server refused the connection request.".into())
                }
            });
        }
        return Err(if status == 401 {
            ApiError::SessionEnded
        } else {
            ApiError::Refused(format!("The remote server answered status {status}."))
        });
    }
    let conn = parse_remote_connection(&text, expected).map_err(|e| match e {
        crate::connection::ConnectionError::InvalidEngine => ApiError::Contract(e.to_string()),
        crate::connection::ConnectionError::RecoveryChanged => ApiError::SessionEnded,
        other => ApiError::Refused(other.to_string()),
    })?;
    let account = conn.account().to_string();
    Ok(Client {
        origin,
        http,
        auth: Arc::new(ClientAuth::Remote(RemoteCreds {
            bearer,
            workspace_id: conn.workspace_id().to_string(),
            recovery_generation: conn.recovery_generation().to_string(),
            label: conn.label().to_string(),
            role: conn.role(),
            access: conn.access(),
            capabilities: conn.capabilities().clone(),
        })),
        account,
    })
}

/// Whether the console speaks this client's contract (the `hello` handshake); the words to say when it doesn't.
pub fn check_hello(hello: &Hello) -> Result<(), String> {
    if hello.version != API_VERSION || hello.contract != contract_digest() {
        return Err(format!(
            "This terminal workbench was built for another Toolroll version than the one running ({}).",
            hello.toolroll.chars().filter(|c| !c.is_control()).take(40).collect::<String>()
        ));
    }
    Ok(())
}

/// A `/live` signal: a room changed, a Lead turn streamed a snapshot, the stream asked to be reopened, or a room is gone.
#[derive(Debug, Clone, PartialEq)]
pub enum LiveSignal {
    Change(String),
    Turn { room: String, turn: LiveTurn },
    Gone(String),
    Reload,
    Ended,
}

/// What `POST /chat` answered in JSON (`accept: application/json`).
#[derive(Debug, Clone, PartialEq)]
pub enum ChatSendOutcome {
    Accepted { session: i64, queued: bool },
    Refused(String),
}

/// What `POST /chat/proposal/<id>/(confirm|dismiss)` answered in JSON.
#[derive(Debug, Clone, PartialEq)]
pub enum ProposalActOutcome {
    Done {
        said: String,
        task_id: Option<String>,
    },
    Refused(String),
}

impl Client {
    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn is_remote(&self) -> bool {
        matches!(&*self.auth, ClientAuth::Remote(_))
    }

    pub fn remote_info(&self) -> Option<RemoteInfo> {
        match &*self.auth {
            ClientAuth::Local(_) => None,
            ClientAuth::Remote(r) => Some(RemoteInfo {
                origin: self.origin.clone(),
                workspace_id: r.workspace_id.clone(),
                label: r.label.clone(),
                account: self.account.clone(),
                role: r.role,
                access: r.access,
                capabilities: r.capabilities.clone(),
            }),
        }
    }

    fn local_creds(&self) -> Result<&Creds, ApiError> {
        match &*self.auth {
            ClientAuth::Local(c) => Ok(c),
            ClientAuth::Remote(_) => Err(ApiError::Refused(
                "This action is only available in a local Toolroll session.".into(),
            )),
        }
    }

    pub(crate) async fn get_json<T: DeserializeOwned>(
        &self,
        path: &str,
        what: &str,
    ) -> Result<T, ApiError> {
        self.get(path, what).await
    }

    /// The cookie pair and the mutation key, for the terminal socket's handshake (term.rs) only.
    pub(crate) fn creds_for_socket(&self) -> Result<(&str, &str), ApiError> {
        match &*self.auth {
            ClientAuth::Local(c) => Ok((c.cookie.as_str(), c.key.as_str())),
            ClientAuth::Remote(_) => Err(ApiError::Refused(
                "Interactive build terminals are local-only for now.".into(),
            )),
        }
    }

    pub(crate) fn remote_creds_for_socket(&self) -> Option<(&str, &str, &str)> {
        match &*self.auth {
            ClientAuth::Remote(r) => Some((
                r.bearer.as_str(),
                r.workspace_id.as_str(),
                r.recovery_generation.as_str(),
            )),
            ClientAuth::Local(_) => None,
        }
    }

    /// A form POST like `act`, whose JSON answer the caller reads itself (any status but an ended session).
    pub(crate) async fn post_form_json(
        &self,
        path: &str,
        fields: &[(&str, &str)],
    ) -> Result<String, ApiError> {
        let creds = self.local_creds()?;
        let mut body = Zeroizing::new(format!("csrf={}", encode(&creds.csrf)));
        for (k, v) in fields {
            body.push('&');
            body.push_str(&encode(k));
            body.push('=');
            body.push_str(&encode(v));
        }
        let res = self
            .http
            .post(format!("{}{}", self.origin, path))
            .header("cookie", creds.cookie.as_str())
            .header("origin", &self.origin)
            .header("content-type", "application/x-www-form-urlencoded")
            .header("accept", "application/json")
            .header("x-toolroll-key", creds.key.as_str())
            .header("x-toolroll-act", "in-place")
            .header("x-toolroll-client", "terminal")
            .timeout(Duration::from_secs(60))
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| ApiError::Unreachable(e.to_string()))?;
        let status = res.status().as_u16();
        if session_gone(
            status,
            res.headers().get("location").and_then(|v| v.to_str().ok()),
        ) {
            return Err(ApiError::SessionEnded);
        }
        let text = res.text().await.unwrap_or_default();
        // A refusal the console's admission made before the route ran (`{ ok: false, said, href }`): its words.
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(said) = v["said"].as_str() {
                return Err(ApiError::Refused(said.to_string()));
            }
        }
        Ok(text)
    }

    async fn get<T: DeserializeOwned>(&self, path: &str, what: &str) -> Result<T, ApiError> {
        self.read(path, what, false).await
    }

    /// A read that writes something on the console (the approval card mints its form's one-time nonce): it carries
    /// this session's key, as every act does, so a cookie alone (a browser, another port) never makes it.
    async fn get_keyed<T: DeserializeOwned>(&self, path: &str, what: &str) -> Result<T, ApiError> {
        self.read(path, what, true).await
    }

    async fn read<T: DeserializeOwned>(
        &self,
        path: &str,
        what: &str,
        keyed: bool,
    ) -> Result<T, ApiError> {
        let mut req = self
            .http
            .get(format!("{}{}", self.origin, path))
            .header("accept", "application/json");
        match &*self.auth {
            ClientAuth::Local(creds) => {
                req = req.header("cookie", creds.cookie.as_str());
                if keyed {
                    req = req.header("x-toolroll-key", creds.key.as_str());
                }
            }
            ClientAuth::Remote(remote) => {
                if keyed {
                    return Err(ApiError::Refused(
                        "Approvals open in your browser — press w.".into(),
                    ));
                }
                req = req
                    .header("authorization", remote.bearer.as_str())
                    .header("x-toolroll-client", "terminal-remote")
                    .header("x-toolroll-workspace", remote.workspace_id.as_str())
                    .header("x-toolroll-recovery", remote.recovery_generation.as_str());
            }
        }
        let res = req
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| ApiError::Unreachable(e.to_string()))?;
        let status = res.status().as_u16();
        if session_gone(
            status,
            res.headers().get("location").and_then(|v| v.to_str().ok()),
        ) {
            return Err(ApiError::SessionEnded);
        }
        let text = res
            .text()
            .await
            .map_err(|e| ApiError::Unreachable(e.to_string()))?;
        if status != 200 {
            if let Ok(code) = parse_connection_refusal(&text) {
                return Err(match code {
                    ConnectionRefusal::Unauthenticated
                    | ConnectionRefusal::RecoveryChanged
                    | ConnectionRefusal::WorkspaceMismatch => ApiError::SessionEnded,
                    other => ApiError::Refused(format!("Couldn't read {what} ({other:?}).")),
                });
            }
            let word = serde_json::from_str::<Refusal>(&text)
                .map(|r| r.error)
                .unwrap_or_else(|_| format!("status {status}"));
            if word == "session" {
                return Err(ApiError::SessionEnded);
            }
            return Err(ApiError::Refused(format!("Couldn't read {what} ({word}).")));
        }
        serde_json::from_str(&text).map_err(|_| {
            ApiError::Contract(format!(
                "The answer for {what} isn't what this version expects."
            ))
        })
    }

    pub async fn hello(&self) -> Result<Hello, ApiError> {
        self.get("/engine/hello", "the handshake").await
    }

    /// The coding agents on the console's computer and who the first task goes to (the console's last look).
    pub async fn agents(&self) -> Result<AgentsRead, ApiError> {
        versioned(
            self.get::<AgentsRead>("/engine/agents", "this computer's agents")
                .await?,
            |r| r.version,
        )
    }

    /// The installation's planner, builder and reviewer and what each may be (GET /engine/models).
    pub async fn models(&self) -> Result<ModelsRead, ApiError> {
        versioned(
            self.get::<ModelsRead>("/engine/models", "the models")
                .await?,
            |r| r.version,
        )
    }

    /// The person's central Lead conversation (GET /engine/chat[?project=]).
    pub async fn chat(&self, project: Option<&str>) -> Result<LeadChat, ApiError> {
        let path = match project {
            Some(p) if !p.is_empty() => format!("/engine/chat?project={}", encode(p)),
            _ => "/engine/chat".to_string(),
        };
        versioned(
            self.get::<LeadChat>(&path, "the Lead conversation").await?,
            |r| r.version,
        )
    }

    /// Send a message to the central Lead (`POST /chat`, `accept: application/json`).
    pub async fn chat_send(
        &self,
        message: &str,
        request: &str,
        session: Option<i64>,
        project: Option<&str>,
    ) -> Result<ChatSendOutcome, ApiError> {
        let mut fields: Vec<(&str, String)> = vec![
            ("message", message.to_string()),
            ("request", request.to_string()),
        ];
        if let Some(s) = session {
            fields.push(("request-session", s.to_string()));
        }
        if let Some(p) = project.filter(|p| !p.is_empty()) {
            fields.push(("project", p.to_string()));
        }
        let borrowed: Vec<(&str, &str)> = fields.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let text = match self.post_form_json("/chat", &borrowed).await {
            Ok(t) => t,
            Err(ApiError::Refused(words)) => return Ok(ChatSendOutcome::Refused(words)),
            Err(e) => return Err(e),
        };
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if v["ok"] == true {
                let session = v["session"].as_i64().unwrap_or(0);
                let queued = v["queued"].as_bool().unwrap_or(false);
                return Ok(ChatSendOutcome::Accepted { session, queued });
            }
            if let Some(said) = v["said"].as_str().or_else(|| v["error"].as_str()) {
                return Ok(ChatSendOutcome::Refused(said.to_string()));
            }
        }
        Ok(ChatSendOutcome::Refused(
            "Couldn't read the reply from Lead chat.".into(),
        ))
    }

    /// Confirm or dismiss a Lead proposal (`POST /chat/proposal/<id>/(confirm|dismiss)`).
    pub async fn proposal_act(
        &self,
        id: i64,
        op: &str,
        confirm_yes: bool,
    ) -> Result<ProposalActOutcome, ApiError> {
        let mut fields: Vec<(&str, &str)> = Vec::new();
        if confirm_yes {
            fields.push(("confirm", "yes"));
        }
        let creds = match self.local_creds() {
            Ok(c) => c,
            Err(ApiError::Refused(words)) => return Ok(ProposalActOutcome::Refused(words)),
            Err(e) => return Err(e),
        };
        let path = format!("/chat/proposal/{id}/{op}");
        let mut body = Zeroizing::new(format!("csrf={}", encode(&creds.csrf)));
        for (k, v) in &fields {
            body.push('&');
            body.push_str(&encode(k));
            body.push('=');
            body.push_str(&encode(v));
        }
        let res = self
            .http
            .post(format!("{}{}", self.origin, path))
            .header("cookie", creds.cookie.as_str())
            .header("origin", &self.origin)
            .header("content-type", "application/x-www-form-urlencoded")
            .header("accept", "application/json")
            .header("x-toolroll-key", creds.key.as_str())
            .header("x-toolroll-act", "in-place")
            .header("x-toolroll-client", "terminal")
            .timeout(Duration::from_secs(30))
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| ApiError::Unreachable(e.to_string()))?;
        let status = res.status().as_u16();
        if session_gone(
            status,
            res.headers().get("location").and_then(|v| v.to_str().ok()),
        ) {
            return Err(ApiError::SessionEnded);
        }
        let text = res.text().await.unwrap_or_default();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            let said = v["said"]
                .as_str()
                .or_else(|| v["words"].as_str())
                .or_else(|| v["error"].as_str())
                .unwrap_or("")
                .to_string();
            if v["ok"] == true {
                return Ok(ProposalActOutcome::Done {
                    said: if said.is_empty() {
                        if op == "dismiss" {
                            "Dismissed.".into()
                        } else {
                            "Confirmed.".into()
                        }
                    } else {
                        said
                    },
                    task_id: v["taskId"].as_str().map(str::to_owned),
                });
            }
            return Ok(ProposalActOutcome::Refused(non_empty(said, status)));
        }
        Ok(ProposalActOutcome::Refused(non_empty(
            String::new(),
            status,
        )))
    }

    /// Remove a queued follow-up message (`POST /chat/queued/<id>/remove`).
    pub async fn queued_remove(&self, id: i64) -> Result<ActOutcome, ApiError> {
        self.act(&format!("/chat/queued/{id}/remove"), &[], "Removed.")
            .await
    }

    /// Look for this computer's agents again (POST /engine/agents/check: the console's bounded status checks, no model
    /// call), and its answer: the agents read.
    pub async fn agents_check(&self) -> Result<AgentsRead, ApiError> {
        let text = self.post_form_json("/engine/agents/check", &[]).await?;
        let read = serde_json::from_str::<AgentsRead>(&text).map_err(|_| {
            ApiError::Contract("The agents' answer isn't what this version expects.".into())
        })?;
        versioned(read, |r| r.version)
    }

    pub async fn work_rows(&self) -> Result<WorkRows, ApiError> {
        versioned(
            self.get::<WorkRows>("/work/rows", "your tasks").await?,
            |r| r.version,
        )
    }

    /// Observational live presence, terminal controller, and human ownership snapshot (`GET /api/presence`).
    pub async fn presence(&self) -> Result<PresenceSnapshot, ApiError> {
        self.get::<PresenceSnapshot>("/api/presence", "workspace presence")
            .await
    }

    /// Hand a task off to a teammate (`POST /api/handoff/task/<task>/assign-person`), recording `task_act`
    /// and sending them a personal notification. Works in both local cookie and remote bearer sessions.
    pub async fn assign_task_person(
        &self,
        task: &str,
        person: &str,
        why: &str,
    ) -> Result<String, ApiError> {
        let path = format!("/api/handoff/task/{}/assign-person", encode(task));
        let body = serde_json::json!({ "person": person, "why": why }).to_string();
        let req = match &*self.auth {
            ClientAuth::Remote(r) => self
                .http
                .post(format!("{}{}", self.origin, path))
                .header("authorization", r.bearer.as_str())
                .header("x-toolroll-client", "terminal-remote")
                .header("x-toolroll-workspace", &r.workspace_id)
                .header("x-toolroll-recovery", &r.recovery_generation),
            ClientAuth::Local(c) => self
                .http
                .post(format!("{}{}", self.origin, path))
                .header("cookie", c.cookie.as_str())
                .header("origin", &self.origin)
                .header("x-csrf-token", c.csrf.as_str())
                .header("x-toolroll-key", c.key.as_str())
                .header("x-toolroll-client", "terminal"),
        };
        let res = req
            .header("content-type", "application/json")
            .header("accept", "application/json")
            .body(body)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| ApiError::Unreachable(e.to_string()))?;
        let status = res.status().as_u16();
        let text = res
            .text()
            .await
            .map_err(|e| ApiError::Unreachable(e.to_string()))?;
        if status == 401 {
            return Err(ApiError::SessionEnded);
        }
        if status != 200 {
            let msg = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v["message"].as_str().map(str::to_string))
                .unwrap_or_else(|| format!("Hand-off refused (status {status})."));
            return Err(ApiError::Refused(msg));
        }
        let warning = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v["warning"].as_str().map(str::to_string));
        Ok(match warning {
            Some(w) if !w.is_empty() => format!("{person} — {w}"),
            _ => person.to_string(),
        })
    }

    /// List uploaded Local Checkout Candidates for a task (`GET /api/handoff/task/<task>/candidates`).
    pub async fn list_candidates(&self, task: &str) -> Result<Vec<HandoffCandidate>, ApiError> {
        let path = format!("/api/handoff/task/{}/candidates", encode(task));
        let parsed = self
            .get::<HandoffCandidatesResponse>(&path, "task candidates")
            .await?;
        Ok(parsed.candidates)
    }

    /// Promote a Local Checkout Candidate into a central Run and queue central checks
    /// (`POST /api/handoff/task/<task>/candidate/<id>/promote`).
    pub async fn promote_candidate(
        &self,
        task: &str,
        candidate_id: &str,
    ) -> Result<PromoteCandidateOutcome, ApiError> {
        let path = format!(
            "/api/handoff/task/{}/candidate/{}/promote",
            encode(task),
            encode(candidate_id)
        );
        let req = match &*self.auth {
            ClientAuth::Remote(r) => self
                .http
                .post(format!("{}{}", self.origin, path))
                .header("authorization", r.bearer.as_str())
                .header("x-toolroll-client", "terminal-remote")
                .header("x-toolroll-workspace", &r.workspace_id)
                .header("x-toolroll-recovery", &r.recovery_generation),
            ClientAuth::Local(c) => self
                .http
                .post(format!("{}{}", self.origin, path))
                .header("cookie", c.cookie.as_str())
                .header("origin", &self.origin)
                .header("x-csrf-token", c.csrf.as_str())
                .header("x-toolroll-key", c.key.as_str())
                .header("x-toolroll-client", "terminal"),
        };
        let res = req
            .header("content-type", "application/json")
            .header("accept", "application/json")
            .body("{}")
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| ApiError::Unreachable(e.to_string()))?;
        let status = res.status().as_u16();
        let text = res
            .text()
            .await
            .map_err(|e| ApiError::Unreachable(e.to_string()))?;
        if status == 401 {
            return Err(ApiError::SessionEnded);
        }
        if status != 200 {
            let msg = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v["message"].as_str().map(str::to_string))
                .unwrap_or_else(|| format!("Candidate promotion refused (status {status})."));
            return Err(ApiError::Refused(msg));
        }
        serde_json::from_str::<PromoteCandidateOutcome>(&text).map_err(|_| {
            ApiError::Contract("The promotion answer isn't what this version expects.".into())
        })
    }

    /// Queue a Git push & GitHub Pull Request for a promoted Candidate's central Run
    /// (`POST /api/handoff/task/<task>/candidate/<id>/open-pr`).
    pub async fn open_candidate_pr(
        &self,
        task: &str,
        candidate_id: &str,
    ) -> Result<OpenCandidatePrOutcome, ApiError> {
        let path = format!(
            "/api/handoff/task/{}/candidate/{}/open-pr",
            encode(task),
            encode(candidate_id)
        );
        let req = match &*self.auth {
            ClientAuth::Remote(r) => self
                .http
                .post(format!("{}{}", self.origin, path))
                .header("authorization", r.bearer.as_str())
                .header("x-toolroll-client", "terminal-remote")
                .header("x-toolroll-workspace", &r.workspace_id)
                .header("x-toolroll-recovery", &r.recovery_generation),
            ClientAuth::Local(c) => self
                .http
                .post(format!("{}{}", self.origin, path))
                .header("cookie", c.cookie.as_str())
                .header("origin", &self.origin)
                .header("x-csrf-token", c.csrf.as_str())
                .header("x-toolroll-key", c.key.as_str())
                .header("x-toolroll-client", "terminal"),
        };
        let res = req
            .header("content-type", "application/json")
            .header("accept", "application/json")
            .body("{}")
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| ApiError::Unreachable(e.to_string()))?;
        let status = res.status().as_u16();
        let text = res
            .text()
            .await
            .map_err(|e| ApiError::Unreachable(e.to_string()))?;
        if status == 401 {
            return Err(ApiError::SessionEnded);
        }
        if status != 200 {
            let msg = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v["message"].as_str().map(str::to_string))
                .unwrap_or_else(|| format!("Opening pull request refused (status {status})."));
            return Err(ApiError::Refused(msg));
        }
        serde_json::from_str::<OpenCandidatePrOutcome>(&text).map_err(|_| {
            ApiError::Contract("The pull request answer isn't what this version expects.".into())
        })
    }

    /// Start or reuse a central Live Terminal on a task in remote mode (`POST /api/handoff/task/<task>/terminal`).
    pub(crate) async fn remote_term_start(
        &self,
        task: &str,
        program: &str,
    ) -> Result<String, ApiError> {
        let remote = match &*self.auth {
            ClientAuth::Remote(r) => r,
            ClientAuth::Local(_) => {
                return Err(ApiError::Refused(
                    "Remote terminal start requires a remote session.".into(),
                ));
            }
        };
        let path = format!("/api/handoff/task/{}/terminal", encode(task));
        let body = serde_json::json!({ "program": program }).to_string();
        let res = self
            .http
            .post(format!("{}{}", self.origin, path))
            .header("authorization", remote.bearer.as_str())
            .header("x-toolroll-client", "terminal-remote")
            .header("x-toolroll-workspace", &remote.workspace_id)
            .header("x-toolroll-recovery", &remote.recovery_generation)
            .header("content-type", "application/json")
            .header("accept", "application/json")
            .body(body)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| ApiError::Unreachable(e.to_string()))?;
        let status = res.status().as_u16();
        let text = res
            .text()
            .await
            .map_err(|e| ApiError::Unreachable(e.to_string()))?;
        if status == 401 {
            return Err(ApiError::SessionEnded);
        }
        if status != 200 {
            let msg = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v["message"].as_str().map(str::to_string))
                .unwrap_or_else(|| {
                    format!("Central Live Terminal refused to start (status {status}).")
                });
            return Err(ApiError::Refused(msg));
        }
        serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v["id"].as_str().map(str::to_string))
            .ok_or_else(|| {
                ApiError::Contract("The terminal start answer had no terminal id.".into())
            })
    }

    /// Trigger an out-of-band approval ping to the calling approver's paired phone/chat channels
    /// (`POST /api/handoff/task/<task>/approval-ping`). Remote API token only.
    pub async fn ping_approval(&self, task: &str) -> Result<ApprovalPingResult, ApiError> {
        let remote = match &*self.auth {
            ClientAuth::Remote(r) => r,
            ClientAuth::Local(_) => {
                return Err(ApiError::Refused(
                    "Approval pings are only used in remote TUI sessions.".into(),
                ));
            }
        };
        let path = format!("/api/handoff/task/{}/approval-ping", encode(task));
        let res = self
            .http
            .post(format!("{}{}", self.origin, path))
            .header("authorization", remote.bearer.as_str())
            .header("x-toolroll-client", "terminal-remote")
            .header("x-toolroll-workspace", &remote.workspace_id)
            .header("x-toolroll-recovery", &remote.recovery_generation)
            .header("accept", "application/json")
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| ApiError::Unreachable(e.to_string()))?;
        let status = res.status().as_u16();
        let text = res
            .text()
            .await
            .map_err(|e| ApiError::Unreachable(e.to_string()))?;
        if status == 401 {
            return Err(ApiError::SessionEnded);
        }
        if status != 200 {
            let msg = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v["message"].as_str().map(str::to_string))
                .unwrap_or_else(|| format!("Approval ping refused (status {status})."));
            return Err(ApiError::Refused(msg));
        }
        serde_json::from_str::<ApprovalPingResult>(&text).map_err(|_| {
            ApiError::Contract("The approval ping answer isn't what this version expects.".into())
        })
    }

    pub async fn steps(&self, task: &str) -> Result<StepCards, ApiError> {
        versioned(
            self.get::<StepCards>(&format!("/t/{}/steps", encode(task)), "the task's steps")
                .await?,
            |r| r.version,
        )
    }

    /// The approval waiting on a task (asked when the person presses Approve: it mints the form's one-time nonce).
    pub async fn approval(&self, task: &str) -> Result<ApprovalCard, ApiError> {
        versioned(
            self.get_keyed::<ApprovalCard>(
                &format!("/t/{}/approval", encode(task)),
                "the approval",
            )
            .await?,
            |r| r.version,
        )
    }

    pub async fn diff(&self, task: &str, run: Option<i64>) -> Result<ResultDiff, ApiError> {
        let q = run.map(|r| format!("?run={r}")).unwrap_or_default();
        versioned(
            self.get::<ResultDiff>(&format!("/t/{}/diff{q}", encode(task)), "the changes")
                .await?,
            |r| r.version,
        )
    }

    pub async fn diff_file(
        &self,
        task: &str,
        run: i64,
        file: i64,
    ) -> Result<ResultDiffFile, ApiError> {
        versioned(
            self.get::<ResultDiffFile>(
                &format!("/t/{}/diff?run={run}&file={file}", encode(task)),
                "the file's changes",
            )
            .await?,
            |r| r.version,
        )
    }

    /// Lines `from`..`from + count - 1` of a result's file at its head (context a hunk hides).
    pub async fn diff_context(
        &self,
        task: &str,
        run: i64,
        file: i64,
        from: i64,
        count: i64,
    ) -> Result<ResultDiffContext, ApiError> {
        versioned(
            self.get::<ResultDiffContext>(
                &format!(
                    "/t/{}/diff?run={run}&file={file}&from={from}&count={count}",
                    encode(task)
                ),
                "the hidden lines",
            )
            .await?,
            |r| r.version,
        )
    }

    /// One window of a run's live records (`file`: main or sub), from `cursor`.
    pub async fn live_window(
        &self,
        run: i64,
        file: &str,
        cursor: Option<&str>,
    ) -> Result<LiveSessionWindow, ApiError> {
        let q = cursor
            .map(|c| format!("&cursor={}", encode(c)))
            .unwrap_or_default();
        versioned(
            self.get::<LiveSessionWindow>(
                &format!("/agents/live/run/{run}?file={}{q}", encode(file)),
                "the live output",
            )
            .await?,
            |r| r.version,
        )
    }

    /// The person's own Flexible threads (`Refused` while Flexible isn't available on the console).
    pub async fn threads(&self) -> Result<LiveThreads, ApiError> {
        versioned(
            self.get::<LiveThreads>("/agents/live/threads", "your threads")
                .await?,
            |r| r.version,
        )
    }

    /// One window of a Flexible thread's live session from `cursor`, with its facts unless they are still `known`. With
    /// `wait` (a cursor and a known version held), the console holds the read until the thread changes (or about 20 s),
    /// so the screen wakes on a change instead of polling.
    pub async fn thread_window(
        &self,
        thread: &str,
        cursor: Option<&str>,
        known: Option<&str>,
        wait: bool,
    ) -> Result<LiveSessionWindow, ApiError> {
        let mut q = cursor
            .map(|c| format!("&cursor={}", encode(c)))
            .unwrap_or_default();
        if let Some(known) = known {
            q.push_str(&format!("&known={}", encode(known)));
        }
        if wait && cursor.is_some() && known.is_some() {
            q.push_str("&wait=1");
        }
        versioned(
            self.get::<LiveSessionWindow>(
                &format!("/agents/live/thread/{}?file=main{q}", encode(thread)),
                "the thread",
            )
            .await?,
            |r| r.version,
        )
    }

    /// Execute a supported remote TUI command via `POST /api/cli` using the remote API token.
    pub async fn remote_cli(
        &self,
        command_name: &str,
        argv: &[String],
        done: &str,
    ) -> Result<ActOutcome, ApiError> {
        let remote = match &*self.auth {
            ClientAuth::Remote(r) => r,
            ClientAuth::Local(_) => {
                return Err(ApiError::Refused(
                    "Remote CLI transport is only used in remote mode.".into(),
                ))
            }
        };
        if !remote.capabilities.can_act() {
            return Ok(ActOutcome::Refused(
                "This remote connection is read-only. Use an act token to make changes.".into(),
            ));
        }
        if !remote.capabilities.has_command(command_name) {
            return Ok(ActOutcome::Refused(
                "Open this task in the browser (press w) for this action.".into(),
            ));
        }
        let payload = serde_json::json!({ "argv": argv, "files": [] });
        let res = self
            .http
            .post(format!("{}/api/cli", self.origin))
            .header("authorization", remote.bearer.as_str())
            .header("content-type", "application/json")
            .header("accept", "application/json")
            .timeout(Duration::from_secs(30))
            .body(payload.to_string())
            .send()
            .await
            .map_err(|e| ApiError::Unreachable(e.to_string()))?;
        let status = res.status().as_u16();
        if status == 401 {
            return Err(ApiError::SessionEnded);
        }
        let text = res.text().await.unwrap_or_default();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            let exit = v["exit"]
                .as_i64()
                .unwrap_or(if status < 300 { 0 } else { 1 });
            let out = v["stdout"].as_str().unwrap_or("").trim();
            let err = v["stderr"].as_str().unwrap_or("").trim();
            let msg = v["message"]
                .as_str()
                .or_else(|| v["error"].as_str())
                .unwrap_or("")
                .trim();
            if status < 300 && exit == 0 {
                let words = if !out.is_empty() {
                    out.lines().next().unwrap_or(done).to_string()
                } else {
                    done.to_string()
                };
                return Ok(ActOutcome::Done(words));
            }
            let reason = if !err.is_empty() {
                err.lines().next().unwrap_or(err).to_string()
            } else if !msg.is_empty() {
                msg.to_string()
            } else if !out.is_empty() {
                out.lines().next().unwrap_or(out).to_string()
            } else {
                format!("Remote server refused the command (status {status}).")
            };
            return Ok(ActOutcome::Refused(reason));
        }
        Ok(if status < 300 {
            ActOutcome::Done(done.to_string())
        } else {
            ActOutcome::Refused(format!("Remote server answered status {status}."))
        })
    }

    /// One act: in local mode, the browser's form POST to `path`; in remote mode, translated to `POST /api/cli`.
    pub async fn act(
        &self,
        path: &str,
        fields: &[(&str, &str)],
        done: &str,
    ) -> Result<ActOutcome, ApiError> {
        if self.is_remote() {
            return self.act_remote(path, fields, done).await;
        }
        let creds = self.local_creds()?;
        let mut body = Zeroizing::new(format!("csrf={}", encode(&creds.csrf)));
        for (k, v) in fields {
            body.push('&');
            body.push_str(&encode(k));
            body.push('=');
            body.push_str(&encode(v));
        }
        let res = self
            .http
            .post(format!("{}{}", self.origin, path))
            .header("cookie", creds.cookie.as_str())
            .header("origin", &self.origin)
            .header("content-type", "application/x-www-form-urlencoded")
            .header("accept", "application/json")
            .header("x-toolroll-key", creds.key.as_str())
            .header("x-toolroll-act", "in-place")
            .header("x-toolroll-client", "terminal")
            .timeout(Duration::from_secs(30))
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| ApiError::Unreachable(e.to_string()))?;
        let status = res.status().as_u16();
        let location = res
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        if session_gone(status, location.as_deref()) {
            return Err(ApiError::SessionEnded);
        }
        if path == "/settings/lead/on" {
            return Ok(
                if (300..400).contains(&status) && location.as_deref() == Some("/chat") {
                    ActOutcome::Done(done.to_string())
                } else {
                    ActOutcome::Refused(location.as_deref().and_then(said_of).map(|(_, words)| words)
                    .unwrap_or_else(|| "The console could not switch Lead. Check the membership sign-in or open Lead settings.".into()))
                },
            );
        }
        let local_refusal = res
            .headers()
            .get("x-toolroll-refused")
            .is_some_and(|v| v == "local-owner");
        let json = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|t| t.starts_with("application/json"));
        let text = res.text().await.unwrap_or_default();
        if json {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if status == 403 && local_refusal {
                    if let Some(step) = builder_password_step(path, v["href"].as_str()) {
                        return Ok(step);
                    }
                }
                let words = v["words"]
                    .as_str()
                    .or_else(|| v["error"].as_str())
                    .or_else(|| v["said"].as_str())
                    .unwrap_or("")
                    .to_string();
                if v["outcome"] == "thread-terms" && status == 200 {
                    let key = v["key"].as_str().unwrap_or("").to_string();
                    let lines: Vec<String> = v["lines"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .map(|l| l.as_str().unwrap_or("").to_string())
                                .collect()
                        })
                        .unwrap_or_default();
                    if key.len() != 32
                        || !key.bytes().all(|b| b.is_ascii_hexdigit())
                        || lines.is_empty()
                    {
                        return Err(ApiError::Contract(
                            "The thread's terms aren't what this version expects.".into(),
                        ));
                    }
                    return Ok(ActOutcome::ThreadTerms { key, lines });
                }
                if v["outcome"] == "terms" && status == 200 {
                    let text = |x: &serde_json::Value| x.as_str().unwrap_or("").to_string();
                    let terms = v["terms"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .map(|t| (text(&t["label"]), text(&t["words"])))
                                .collect()
                        })
                        .unwrap_or_default();
                    let (preview, digest) = (text(&v["preview"]), text(&v["digest"]));
                    if preview.is_empty() || digest.is_empty() {
                        return Err(ApiError::Contract(
                            "Build's offer isn't what this version expects.".into(),
                        ));
                    }
                    return Ok(ActOutcome::Terms {
                        preview,
                        digest,
                        terms,
                    });
                }
                if v["outcome"] == "ship-terms" && status == 200 {
                    let text = |x: &serde_json::Value| x.as_str().unwrap_or("").to_string();
                    let (key, digest) = (text(&v["key"]), text(&v["digest"]));
                    let lines: Vec<String> = v["lines"]
                        .as_array()
                        .map(|a| a.iter().map(text).collect())
                        .unwrap_or_default();
                    let hex = |s: &str| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit());
                    if !hex(&key) || !hex(&digest) || lines.is_empty() {
                        return Err(ApiError::Contract(
                            "The Ship's terms aren't what this version expects.".into(),
                        ));
                    }
                    return Ok(ActOutcome::ShipTerms {
                        key,
                        digest,
                        lines,
                        laptop: v["laptop"] == true,
                        command: v["command"].as_str().map(str::to_string),
                    });
                }
                if v["outcome"] == "done" && path == "/agents/live/thread" {
                    if let Some(thread) = v["thread"]
                        .as_str()
                        .filter(|t| t.len() == 32 && t.bytes().all(|b| b.is_ascii_hexdigit()))
                    {
                        return Ok(ActOutcome::ThreadStarted {
                            words: non_empty(words, status),
                            thread: thread.to_string(),
                        });
                    }
                }
                if v["outcome"] == "refused" && path == "/agents/live/thread" {
                    if let Some(next) = v["next"].as_str().filter(|n| NEXT_STEPS.contains(n)) {
                        return Ok(ActOutcome::NextStep {
                            words: non_empty(words, status),
                            next: next.to_string(),
                        });
                    }
                }
                return Ok(match v["outcome"].as_str() {
                    Some("refused") => ActOutcome::Refused(non_empty(words, status)),
                    Some(_) if status < 300 => ActOutcome::Done(if words.is_empty() {
                        done.to_string()
                    } else {
                        words
                    }),
                    _ if status >= 400 => ActOutcome::Refused(non_empty(words, status)),
                    _ => ActOutcome::Done(done.to_string()),
                });
            }
        }
        // A page's form answers with a redirect that says what happened (`?said=` or `?problem=`, as Settings does):
        // its words, so a problem is never read as done.
        if (300..400).contains(&status) {
            if let Some((key, words)) = location.as_deref().and_then(said_of) {
                return Ok(if key == "problem" {
                    ActOutcome::Refused(words)
                } else {
                    ActOutcome::Done(words)
                });
            }
        }
        // Filing answers with the new task's page: its id, so the screen can open it.
        if (300..400).contains(&status) && path.starts_with("/tasks/") {
            if let Some(task) = location.as_deref().and_then(filed_task) {
                return Ok(ActOutcome::Filed {
                    words: done.to_string(),
                    task,
                });
            }
        }
        Ok(if (200..400).contains(&status) {
            ActOutcome::Done(done.to_string())
        } else {
            ActOutcome::Refused(non_empty(String::new(), status))
        })
    }

    async fn act_remote(
        &self,
        path: &str,
        fields: &[(&str, &str)],
        done: &str,
    ) -> Result<ActOutcome, ApiError> {
        let field = |name: &str| {
            fields
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v.trim())
                .filter(|v| !v.is_empty())
        };
        if path == "/tasks/add" {
            let Some(title) = field("title") else {
                return Ok(ActOutcome::Refused("Enter a task title.".into()));
            };
            let mut argv = vec!["task".into(), "add".into(), title.into()];
            if let Some(repo) = field("repo") {
                argv.push("--repo".into());
                argv.push(repo.into());
            }
            if let Some(body) = field("body") {
                argv.push("--body".into());
                argv.push(body.into());
            }
            return self.remote_cli("task add", &argv, done).await;
        }
        if let Some(rest) = path.strip_prefix("/t/") {
            if let Some((task, op)) = rest.split_once('/') {
                let task = percent_decode_simple(task);
                match op {
                    "steer" => {
                        let Some(msg) = field("message").or_else(|| field("text")) else {
                            return Ok(ActOutcome::Refused("Enter steering notes.".into()));
                        };
                        let argv = vec!["task".into(), "steer".into(), task, msg.into()];
                        return self.remote_cli("task steer", &argv, done).await;
                    }
                    "complete" => {
                        let argv = vec!["task".into(), "complete".into(), task];
                        return self.remote_cli("task complete", &argv, done).await;
                    }
                    "revise" => {
                        let Some(msg) = field("feedback").or_else(|| field("message")) else {
                            return Ok(ActOutcome::Refused("Enter revision notes.".into()));
                        };
                        let argv = vec!["task".into(), "revise".into(), task, msg.into()];
                        return self.remote_cli("task revise", &argv, done).await;
                    }
                    "stop" | "cancel" => {
                        let argv = vec!["task".into(), "stop".into(), task];
                        return self.remote_cli("task stop", &argv, done).await;
                    }
                    "resume" => {
                        let argv = vec!["task".into(), "resume".into(), task];
                        return self.remote_cli("task resume", &argv, done).await;
                    }
                    "hold" => {
                        let argv = vec!["task".into(), "hold".into(), task];
                        return self.remote_cli("task hold", &argv, done).await;
                    }
                    "unhold" => {
                        let argv = vec!["task".into(), "unhold".into(), task];
                        return self.remote_cli("task unhold", &argv, done).await;
                    }
                    "requeue" => {
                        let argv = vec!["task".into(), "requeue".into(), task];
                        return self.remote_cli("task requeue", &argv, done).await;
                    }
                    _ => {}
                }
            }
        }
        Ok(ActOutcome::Refused(
            "Open this task in the browser (press w) for approvals and local-only actions.".into(),
        ))
    }

    /// `GET /live` for these rooms: signals until the stream ends (then `Ended`).
    pub async fn live(
        &self,
        rooms: &[String],
        tx: mpsc::UnboundedSender<LiveSignal>,
    ) -> Result<(), ApiError> {
        let query: Vec<String> = rooms
            .iter()
            .map(|r| format!("room={}", encode(r)))
            .collect();
        let mut req = self
            .http
            .get(format!("{}/live?{}", self.origin, query.join("&")))
            .header("accept", "text/event-stream")
            .header("x-toolroll-live", "1");
        match &*self.auth {
            ClientAuth::Local(creds) => {
                req = req.header("cookie", creds.cookie.as_str());
            }
            ClientAuth::Remote(remote) => {
                req = req
                    .header("authorization", remote.bearer.as_str())
                    .header("x-toolroll-client", "terminal-remote")
                    .header("x-toolroll-workspace", remote.workspace_id.as_str())
                    .header("x-toolroll-recovery", remote.recovery_generation.as_str());
            }
        }
        let res = req
            .send()
            .await
            .map_err(|e| ApiError::Unreachable(e.to_string()))?;
        let status = res.status().as_u16();
        if session_gone(
            status,
            res.headers().get("location").and_then(|v| v.to_str().ok()),
        ) {
            return Err(ApiError::SessionEnded);
        }
        if status != 200 {
            return Err(ApiError::Refused(format!(
                "The live stream was refused (status {status})."
            )));
        }
        let mut stream = res.bytes_stream();
        let mut parser = SseParser::default();
        while let Some(chunk) = stream.next().await {
            let Ok(chunk) = chunk else { break };
            for ev in parser.push(&chunk) {
                if let Some(signal) = signal_of(&ev) {
                    if tx.send(signal).is_err() {
                        return Ok(());
                    }
                }
            }
        }
        let _ = tx.send(LiveSignal::Ended);
        Ok(())
    }
}

fn signal_of(ev: &SseEvent) -> Option<LiveSignal> {
    let parsed = || serde_json::from_str::<serde_json::Value>(&ev.data).ok();
    let room = || parsed().and_then(|v| v["room"].as_str().map(str::to_owned));
    match ev.event.as_str() {
        "change" => room().map(LiveSignal::Change),
        "turn" => {
            let v = parsed()?;
            let room = v["room"].as_str()?.to_owned();
            let turn = serde_json::from_value::<LiveTurn>(v).ok()?;
            Some(LiveSignal::Turn { room, turn })
        }
        "gone" => room().map(LiveSignal::Gone),
        "reload" => Some(LiveSignal::Reload),
        _ => None,
    }
}

/// The task a redirect names (`/t/<id>`, nothing after it but a fragment): an id of plain characters only.
pub fn filed_task(location: &str) -> Option<String> {
    let path = location.split('#').next()?;
    let id = path.strip_prefix("/t/")?;
    let ok = !id.is_empty()
        && !id.starts_with('.')
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.');
    ok.then(|| id.to_string())
}

/// A redirect's `said` or `problem` words (percent-decoded, `+` as a space), which ever it carries; None for neither.
pub fn said_of(location: &str) -> Option<(&'static str, String)> {
    let query = location.split_once('?')?.1.split('#').next()?;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=')?;
        let key = match k {
            "problem" => "problem",
            "said" => "said",
            _ => continue,
        };
        let bytes = v.replace('+', " ").into_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                if let Ok(b) =
                    u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?, 16)
                {
                    out.push(b);
                    i += 3;
                    continue;
                }
            }
            out.push(bytes[i]);
            i += 1;
        }
        return Some((key, String::from_utf8_lossy(&out).into_owned()));
    }
    None
}

fn session_gone(status: u16, location: Option<&str>) -> bool {
    status == 401
        || ((300..400).contains(&status) && location.is_some_and(|l| l.starts_with("/login")))
}

// The console names its password step. Build the destination ourselves from this request.
pub(crate) fn builder_password_step(path: &str, href: Option<&str>) -> Option<ActOutcome> {
    let page = path.strip_suffix("/route")?;
    let task = filed_task(page)?;
    if page != format!("/t/{task}") {
        return None;
    }
    let back = encode(page);
    let setup = if href == Some(&format!("/login?return={back}")) {
        false
    } else if href == Some(&format!("/password/set?next={back}")) {
        true
    } else {
        return None;
    };
    Some(ActOutcome::BuilderPassword { task, setup })
}

fn non_empty(words: String, status: u16) -> String {
    if words.trim().is_empty() {
        format!("Refused (status {status}).")
    } else {
        words
    }
}

fn versioned<T>(value: T, version: impl Fn(&T) -> u32) -> Result<T, ApiError> {
    if version(&value) != API_VERSION {
        return Err(ApiError::Contract(
            "The console speaks another engine API version.".into(),
        ));
    }
    Ok(value)
}

/// Live presence for a single task (viewers + live terminal controller).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPresence {
    #[serde(default)]
    pub viewers: Vec<String>,
    #[serde(default)]
    pub terminal_controller: Option<String>,
    #[serde(default)]
    pub terminal_program: Option<String>,
    #[serde(default)]
    pub terminal_viewers: usize,
}

impl TaskPresence {
    /// Short single-line summary for task headers/rows (`None` when nobody else is active).
    pub fn summary(&self) -> Option<String> {
        let mut parts: Vec<String> = Vec::new();
        if let Some(ctrl) = &self.terminal_controller {
            let prog = match self.terminal_program.as_deref() {
                Some("claude") => "Claude",
                Some("codex") => "Codex",
                Some("antigravity") => "Antigravity",
                Some("shell") | None => "terminal",
                Some(other) => other,
            };
            parts.push(format!("{ctrl} typing in {prog}"));
        }
        if self.viewers.len() == 1 {
            parts.push(format!("{} viewing", self.viewers[0]));
        } else if self.viewers.len() > 1 {
            parts.push(format!(
                "{} + {} viewing",
                self.viewers[0],
                self.viewers.len() - 1
            ));
        }
        if parts.is_empty() {
            None
        } else {
            Some(parts.join(" · "))
        }
    }
}

/// Workspace-wide observational presence & task ownership snapshot (`GET /api/presence`).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceSnapshot {
    #[serde(default)]
    pub me: String,
    #[serde(default)]
    pub tasks: std::collections::HashMap<String, TaskPresence>,
    #[serde(default)]
    pub owners: std::collections::HashMap<String, Option<String>>,
    #[serde(default)]
    pub accounts: Vec<String>,
}

/// Outcome of `POST /api/handoff/task/<task>/approval-ping`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalPingResult {
    pub task_id: String,
    #[serde(default)]
    pub enqueued: bool,
    #[serde(default)]
    pub channels: Vec<String>,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub url: Option<String>,
}

/// Pull request publication state attached to a promoted Candidate's Run.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidatePublication {
    pub id: i64,
    pub state: String,
    #[serde(default)]
    pub pr_number: Option<i64>,
    #[serde(default)]
    pub pr_url: Option<String>,
}

/// One Local Checkout Candidate listed by `GET /api/handoff/task/<task>/candidates`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffCandidate {
    pub id: String,
    pub author: String,
    pub created_at: String,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub stale: bool,
    #[serde(default)]
    pub promoted_at: Option<String>,
    #[serde(default)]
    pub promoted_by: Option<String>,
    #[serde(default)]
    pub run_id: Option<i64>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub head_commit: Option<String>,
    #[serde(default)]
    pub check_status: Option<String>,
    #[serde(default)]
    pub live_check_state: Option<String>,
    #[serde(default)]
    pub publication: Option<CandidatePublication>,
    #[serde(default)]
    pub can_open_pr: bool,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandoffCandidatesResponse {
    #[serde(default)]
    candidates: Vec<HandoffCandidate>,
}

/// Outcome of `POST /api/handoff/task/<task>/candidate/<id>/promote`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoteCandidateOutcome {
    pub task_id: String,
    pub candidate_id: String,
    #[serde(default)]
    pub run_id: Option<i64>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub head_commit: Option<String>,
}

/// Outcome of `POST /api/handoff/task/<task>/candidate/<id>/open-pr`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCandidatePrOutcome {
    pub task_id: String,
    pub candidate_id: String,
    pub run_id: i64,
    pub publication: CandidatePublication,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_password_handoff_matches_only_this_tasks_password_door() {
        let path = "/t/homepage-nameplate/route";
        for (href, setup) in [
            ("/login?return=%2Ft%2Fhomepage-nameplate", false),
            ("/password/set?next=%2Ft%2Fhomepage-nameplate", true),
        ] {
            assert_eq!(
                builder_password_step(path, Some(href)),
                Some(ActOutcome::BuilderPassword {
                    task: "homepage-nameplate".into(),
                    setup
                })
            );
        }
        assert_eq!(
            builder_password_step(path, Some("/login?return=%2Ft%2Fother")),
            None
        );
        assert_eq!(
            builder_password_step("/t/homepage-nameplate/requeue", None),
            None
        );
    }

    #[test]
    fn only_local_one_time_links() {
        let code = "A".repeat(43);
        assert_eq!(
            parse_link(&format!("http://127.0.0.1:4801/login/once/{code}")).unwrap(),
            ("http://127.0.0.1:4801".into(), Zeroizing::new(code.clone()))
        );
        assert!(parse_link(&format!("http://[::1]:4801/login/once/{code}")).is_ok());
        for bad in [
            format!("https://127.0.0.1:4801/login/once/{code}"),
            format!("http://localhost:4801/login/once/{code}"),
            format!("http://127.0.0.1.evil:4801/login/once/{code}"),
            format!("http://127.0.0.1:0/login/once/{code}"),
            format!("http://127.0.0.1:99999/login/once/{code}"),
            format!("http://127.0.0.1:4801/login/once/{}", &code[..42]),
            format!("http://127.0.0.1:4801/login/once/{code}?x=1"),
            format!("http://127.0.0.1:4801/elsewhere/{code}"),
            format!("http://user@127.0.0.1:4801/login/once/{code}"),
        ] {
            assert!(parse_link(&bad).is_err(), "{bad}");
        }
    }

    /// Debug formatting only: what a log line or a panic message could show. (Memory and crash dumps are covered by
    /// the zeroizing types here and the binary's dump protection, toolroll-tui guard.rs and its tests.)
    #[test]
    fn credentials_never_print() {
        let creds = Creds {
            cookie: Zeroizing::new("standing-orders_session=".to_string() + &"a".repeat(64)),
            csrf: Zeroizing::new("b".repeat(64)),
            key: Zeroizing::new("c".repeat(64)),
        };
        let shown = format!("{creds:?}");
        assert!(
            !shown.contains(&"a".repeat(64))
                && !shown.contains(&"b".repeat(64))
                && !shown.contains(&"c".repeat(64))
        );
    }

    #[test]
    fn credentials_are_held_in_zeroizing_memory() {
        // A type check: each secret is a Zeroizing<String> (cleared when dropped), not a plain String.
        fn zeroizing(_: &Zeroizing<String>) {}
        let creds = Creds {
            cookie: Zeroizing::new("n=".to_string() + &"a".repeat(64)),
            csrf: Zeroizing::new("b".repeat(64)),
            key: Zeroizing::new("c".repeat(64)),
        };
        zeroizing(&creds.cookie);
        zeroizing(&creds.csrf);
        zeroizing(&creds.key);
        let (_, code) = parse_link(&format!(
            "http://127.0.0.1:4801/login/once/{}",
            "A".repeat(43)
        ))
        .unwrap();
        zeroizing(&code);
    }

    #[test]
    fn encodes_reserved_characters() {
        assert_eq!(encode("a b&c=d/é"), "a%20b%26c%3Dd%2F%C3%A9");
        assert_eq!(encode("t-1_x.y~"), "t-1_x.y~");
    }

    #[test]
    fn parses_live_turn_sse_frame() {
        let ev = SseEvent {
            event: "turn".into(),
            data: r#"{"room":"chat","phase":"writing","status":"Writing…","text":"Checking t-done","done":false,"ok":false,"steps":[{"tools":["read tasks"],"toolCalls":[{"id":"tc1","label":"read tasks","state":"ok","summary":"5 tasks"}]}]}"#.into(),
        };
        let Some(LiveSignal::Turn { room, turn }) = signal_of(&ev) else {
            panic!("expected LiveSignal::Turn");
        };
        assert_eq!(room, "chat");
        assert_eq!(turn.phase, "writing");
        assert_eq!(turn.status, "Writing…");
        assert_eq!(turn.text, "Checking t-done");
        assert_eq!(turn.steps.len(), 1);
        assert_eq!(turn.steps[0].tool_calls[0].label, "read tasks");
        assert!(!turn.is_idle());

        let idle = SseEvent {
            event: "turn".into(),
            data: r#"{"room":"chat","state":"idle"}"#.into(),
        };
        let Some(LiveSignal::Turn {
            turn: idle_turn, ..
        }) = signal_of(&idle)
        else {
            panic!("expected idle LiveSignal::Turn");
        };
        assert!(idle_turn.is_idle());
    }
}
