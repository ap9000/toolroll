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
    Refused(String),
    /// New task's offer (POST /tasks/add for a small task): the exact terms Build would approve, and the preview and
    /// digest Build posts (POST /tasks/fast).
    Terms {
        preview: String,
        digest: String,
        terms: Vec<(String, String)>,
    },
}

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

#[derive(Debug, Clone)]
pub struct Client {
    origin: String,
    http: reqwest::Client,
    creds: Arc<Creds>,
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
        creds: Arc::new(Creds {
            cookie: Zeroizing::new(format!("{}={}", r.cookie.name, value.as_str())),
            csrf,
            key,
        }),
        account: r.account,
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

/// A `/live` signal: a room changed, the stream asked to be reopened, or a room is gone from view.
#[derive(Debug, Clone, PartialEq)]
pub enum LiveSignal {
    Change(String),
    Gone(String),
    Reload,
    Ended,
}

impl Client {
    pub fn origin(&self) -> &str {
        &self.origin
    }

    async fn get<T: DeserializeOwned>(&self, path: &str, what: &str) -> Result<T, ApiError> {
        let res = self
            .http
            .get(format!("{}{}", self.origin, path))
            .header("cookie", self.creds.cookie.as_str())
            .header("accept", "application/json")
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

    pub async fn work_rows(&self) -> Result<WorkRows, ApiError> {
        versioned(
            self.get::<WorkRows>("/work/rows", "your tasks").await?,
            |r| r.version,
        )
    }

    pub async fn steps(&self, task: &str) -> Result<StepCards, ApiError> {
        versioned(
            self.get::<StepCards>(&format!("/t/{}/steps", encode(task)), "the task's steps")
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

    /// One act: the browser's form POST to `path` (the form token added), answered in place.
    pub async fn act(
        &self,
        path: &str,
        fields: &[(&str, &str)],
        done: &str,
    ) -> Result<ActOutcome, ApiError> {
        let mut body = Zeroizing::new(format!("csrf={}", encode(&self.creds.csrf)));
        for (k, v) in fields {
            body.push('&');
            body.push_str(&encode(k));
            body.push('=');
            body.push_str(&encode(v));
        }
        let res = self
            .http
            .post(format!("{}{}", self.origin, path))
            .header("cookie", self.creds.cookie.as_str())
            .header("origin", &self.origin)
            .header("content-type", "application/x-www-form-urlencoded")
            .header("accept", "application/json")
            .header("x-toolroll-key", self.creds.key.as_str())
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
        let json = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|t| t.starts_with("application/json"));
        let text = res.text().await.unwrap_or_default();
        if json {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                let words = v["words"]
                    .as_str()
                    .or_else(|| v["error"].as_str())
                    .unwrap_or("")
                    .to_string();
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
        Ok(if (200..400).contains(&status) {
            ActOutcome::Done(done.to_string())
        } else {
            ActOutcome::Refused(non_empty(String::new(), status))
        })
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
        let res = self
            .http
            .get(format!("{}/live?{}", self.origin, query.join("&")))
            .header("cookie", self.creds.cookie.as_str())
            .header("accept", "text/event-stream")
            .header("x-toolroll-live", "1")
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
    let room = || {
        serde_json::from_str::<serde_json::Value>(&ev.data)
            .ok()
            .and_then(|v| v["room"].as_str().map(str::to_owned))
    };
    match ev.event.as_str() {
        "change" => room().map(LiveSignal::Change),
        "gone" => room().map(LiveSignal::Gone),
        "reload" => Some(LiveSignal::Reload),
        _ => None,
    }
}

fn session_gone(status: u16, location: Option<&str>) -> bool {
    status == 401
        || ((300..400).contains(&status) && location.is_some_and(|l| l.starts_with("/login")))
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
