//! The engine path: redeem a local owner's one-time link, read `/live` (SSE), open a `/term` WebSocket.
//!
//! The binary is a thin client of the local console. It holds the session cookie, the CSRF token and the mutation key
//! in memory only and never prints them (reports carry shapes and lengths). Every address is the console's own
//! loopback origin: a link naming any other origin is refused before anything is sent.
use crate::Args;
use anyhow::{anyhow, bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::fmt;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Message};

pub const SESSION_COOKIE: &str = "standing-orders_session";
pub const KEY_HEADER: &str = "x-toolroll-key";
pub const LIVE_FRAMES_HEADER: &str = "x-toolroll-live";

pub struct Session {
    pub origin: String,
    cookie: String,
    key: Option<String>,
    pub csrf: Option<String>,
    client: reqwest::Client,
}

impl fmt::Debug for Session {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Session {{ origin: {}, cookie: <{} chars>, key: {}, csrf: {} }}",
            self.origin,
            self.cookie.len(),
            if self.key.is_some() { "<held>" } else { "none" },
            if self.csrf.is_some() {
                "<held>"
            } else {
                "none"
            }
        )
    }
}

pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn origin_of(url: &str) -> Result<(String, String)> {
    // http://127.0.0.1:<port>/path → ("http://127.0.0.1:<port>", "/path"). Loopback http only.
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| anyhow!("not an http://127.0.0.1 address"))?;
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let port = host
        .strip_prefix("127.0.0.1:")
        .ok_or_else(|| anyhow!("only http://127.0.0.1:<port> is accepted"))?;
    if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
        bail!("bad port");
    }
    Ok((format!("http://{host}"), path.to_string()))
}

fn link_path_ok(path: &str) -> bool {
    path.strip_prefix("/login/once/")
        .map(|code| {
            (16..=128).contains(&code.len())
                && code
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        .unwrap_or(false)
}

/// Redeem a one-time local-owner link (today's HTML road: the no-store key-delivery page).
/// A0 should replace this with a JSON redemption; see results.md.
pub async fn redeem(base: &str, link: &str) -> Result<(Session, Value)> {
    let (origin, _) = origin_of(base)?;
    let link = link.trim();
    let (link_origin, path) = if link.starts_with("http://") {
        origin_of(link)?
    } else {
        (origin.clone(), link.to_string())
    };
    if link_origin != origin {
        bail!("the link names another origin; refused");
    }
    if !link_path_ok(&path) {
        bail!("not a one-time sign-in path");
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let t = Instant::now();
    let res = client
        .get(format!("{origin}{path}"))
        .header("accept", "text/html")
        .send()
        .await?;
    let status = res.status().as_u16();
    let mut cookie = None;
    for v in res.headers().get_all("set-cookie") {
        let s = v.to_str().unwrap_or("");
        if let Some(rest) = s.strip_prefix(&format!("{SESSION_COOKIE}=")) {
            cookie = Some(format!(
                "{SESSION_COOKIE}={}",
                rest.split(';').next().unwrap_or("")
            ));
        }
    }
    let cache = res
        .headers()
        .get("cache-control")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = res.text().await?;
    let ms = t.elapsed().as_secs_f64() * 1000.0;
    let cookie =
        cookie.ok_or_else(|| anyhow!("redemption answered {status} without a session cookie"))?;
    // The delivery page's one script: (function(){var d={"storage":..,"value":"{\"epoch\":..,\"key\":..}","to":..};try{...
    let (key, epoch_len) = parse_delivery(&body)?;
    let report = json!({
        "status": status, "ms": (ms * 10.0).round() / 10.0, "cache_control": cache,
        "cookie_chars": cookie.len(), "mutation_key": key.is_some(), "key_epoch_chars": epoch_len,
        "road": "html delivery page (parsed script)",
    });
    Ok((
        Session {
            origin,
            cookie,
            key,
            csrf: None,
            client,
        },
        report,
    ))
}

/// The key-delivery page's one script: `(function(){var d={"storage":..,"value":"{\"epoch\":..,\"key\":..}","to":..};try{…`.
/// Returns the 64-hex key (if the page carried one) and the epoch's length.
pub fn parse_delivery(body: &str) -> Result<(Option<String>, usize)> {
    let Some(start) = body.find("var d=") else {
        return Ok((None, 0));
    };
    let rest = &body[start + 6..];
    let Some(end) = rest.find(";try{") else {
        return Ok((None, 0));
    };
    let d: Value = serde_json::from_str(&rest[..end]).context("delivery data")?;
    let inner: Value = serde_json::from_str(d["value"].as_str().unwrap_or("null"))?;
    let k = inner["key"].as_str().unwrap_or("");
    let key = (k.len() == 64 && k.bytes().all(|b| b.is_ascii_hexdigit())).then(|| k.to_string());
    Ok((key, inner["epoch"].as_str().map(|e| e.len()).unwrap_or(0)))
}

impl Session {
    /// A second handle on the same session for a background stream (the same in-memory credentials).
    pub fn clone_for_stream(s: &Session) -> Session {
        Session {
            origin: s.origin.clone(),
            cookie: s.cookie.clone(),
            key: s.key.clone(),
            csrf: s.csrf.clone(),
            client: s.client.clone(),
        }
    }

    /// The workspace read the browser makes (`?format=workspace`): reports its keys, keeps its CSRF token.
    pub async fn workspace(&mut self, path: &str) -> Result<Value> {
        let t = Instant::now();
        let res = self
            .client
            .get(format!("{}{}", self.origin, path))
            .header("cookie", &self.cookie)
            .header("accept", "application/json")
            .send()
            .await?;
        let status = res.status().as_u16();
        let ctype = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let text = res.text().await?;
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        let parsed: Option<Value> = serde_json::from_str(&text).ok();
        let mut keys: Vec<String> = parsed
            .as_ref()
            .and_then(|v| v.as_object())
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        keys.sort();
        if let Some(c) = parsed
            .as_ref()
            .and_then(|v| v.get("csrf"))
            .and_then(|v| v.as_str())
        {
            self.csrf = Some(c.to_string());
        }
        Ok(
            json!({ "path": path, "status": status, "content_type": ctype, "bytes": text.len(), "ms": (ms * 10.0).round() / 10.0,
            "json": parsed.is_some(), "top_level_keys": keys, "csrf_found": self.csrf.is_some() }),
        )
    }

    /// A browser-form act, as the page posts it: CSRF in the body, the mutation key (when the console issued one) in
    /// the header, the console's own Origin. Answers (status, ms, location) — never the credentials.
    pub async fn post_form(&self, path: &str, fields: &[(&str, &str)]) -> Result<Value> {
        let csrf = self
            .csrf
            .as_deref()
            .ok_or_else(|| anyhow!("no CSRF token yet (read the workspace first)"))?;
        let mut body: Vec<String> = vec![format!("csrf={}", urlencode(csrf))];
        body.extend(
            fields
                .iter()
                .map(|(k, v)| format!("{}={}", urlencode(k), urlencode(v))),
        );
        let mut req = self
            .client
            .post(format!("{}{}", self.origin, path))
            .header("cookie", &self.cookie)
            .header("origin", &self.origin)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body.join("&"));
        if let Some(k) = &self.key {
            req = req.header(KEY_HEADER, k);
        }
        let t = Instant::now();
        let res = req.send().await?;
        let status = res.status().as_u16();
        let location = res
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let text = res.text().await.unwrap_or_default();
        Ok(
            json!({ "path": path, "status": status, "ms": (t.elapsed().as_secs_f64() * 10000.0).round() / 10.0, "location": location,
            "body_head": text.chars().take(120).collect::<String>() }),
        )
    }

    /// GET /live with named frames; every event goes to `tx` until the stream ends.
    pub async fn live(&self, rooms: &[&str], tx: mpsc::UnboundedSender<LiveEvent>) -> Result<()> {
        let query: Vec<String> = rooms
            .iter()
            .map(|r| format!("room={}", urlencode(r)))
            .collect();
        let res = self
            .client
            .get(format!("{}/live?{}", self.origin, query.join("&")))
            .header("cookie", &self.cookie)
            .header("accept", "text/event-stream")
            .header(LIVE_FRAMES_HEADER, "1")
            .send()
            .await?;
        let status = res.status().as_u16();
        if status != 200 {
            let body = res.text().await.unwrap_or_default();
            let _ = tx.send(LiveEvent {
                event: format!("http-{status}"),
                data: body.chars().take(200).collect(),
                id: None,
                at_ms: now_ms(),
            });
            return Ok(());
        }
        let mut stream = res.bytes_stream();
        let mut parser = SseParser::default();
        while let Some(chunk) = stream.next().await {
            for ev in parser.push(&chunk?) {
                if tx.send(ev).is_err() {
                    return Ok(());
                }
            }
        }
        Ok(())
    }

    /// The console's `/term/<id>/socket`, as the browser opens it: Origin = the console's own, cookie, and the key in the
    /// subprotocol list (`toolroll`, `toolroll.key.<key>`).
    pub async fn term(&self, id: &str) -> Result<TermSocket, Value> {
        let ws = self.origin.replacen("http://", "ws://", 1);
        connect_term(
            &format!("{ws}/term/{id}/socket"),
            &self.origin,
            Some(&self.cookie),
            self.key.as_deref(),
        )
        .await
    }
}

pub type TermSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub async fn connect_term(
    url: &str,
    origin: &str,
    cookie: Option<&str>,
    key: Option<&str>,
) -> Result<TermSocket, Value> {
    let mut req = url
        .into_client_request()
        .map_err(|e| json!({ "error": e.to_string() }))?;
    let h = req.headers_mut();
    h.insert(
        "origin",
        HeaderValue::from_str(origin).map_err(|e| json!({ "error": e.to_string() }))?,
    );
    if let Some(c) = cookie {
        h.insert(
            "cookie",
            HeaderValue::from_str(c).map_err(|e| json!({ "error": e.to_string() }))?,
        );
    }
    let protocols = match key {
        Some(k) => format!("toolroll, toolroll.key.{k}"),
        None => "toolroll".to_string(),
    };
    h.insert(
        "sec-websocket-protocol",
        HeaderValue::from_str(&protocols).map_err(|e| json!({ "error": e.to_string() }))?,
    );
    match tokio_tungstenite::connect_async(req).await {
        Ok((ws, _)) => Ok(ws),
        Err(tokio_tungstenite::tungstenite::Error::Http(res)) => {
            let body = res
                .body()
                .as_ref()
                .map(|b| String::from_utf8_lossy(b).trim().to_string())
                .unwrap_or_default();
            Err(json!({ "refused_status": res.status().as_u16(), "refused_body": body }))
        }
        Err(e) => Err(json!({ "error": e.to_string() })),
    }
}

#[derive(Debug, Clone)]
pub struct LiveEvent {
    pub event: String,
    pub data: String,
    pub id: Option<String>,
    pub at_ms: u128,
}

#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    event: String,
    data: String,
    id: Option<String>,
}

impl SseParser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<LiveEvent> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=nl).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line = String::from_utf8_lossy(&line).into_owned();
            if line.is_empty() {
                if !self.data.is_empty() || !self.event.is_empty() {
                    let ev = if self.event.is_empty() {
                        "message".to_string()
                    } else {
                        std::mem::take(&mut self.event)
                    };
                    out.push(LiveEvent {
                        event: ev,
                        data: std::mem::take(&mut self.data),
                        id: self.id.take(),
                        at_ms: now_ms(),
                    });
                }
                continue;
            }
            if line.starts_with(':') {
                out.push(LiveEvent {
                    event: "(comment)".into(),
                    data: line,
                    id: None,
                    at_ms: now_ms(),
                });
                continue;
            }
            let (field, value) = match line.find(':') {
                Some(i) => (
                    &line[..i],
                    line[i + 1..].strip_prefix(' ').unwrap_or(&line[i + 1..]),
                ),
                None => (line.as_str(), ""),
            };
            match field {
                "event" => self.event = value.to_string(),
                "data" => {
                    if !self.data.is_empty() {
                        self.data.push('\n');
                    }
                    self.data.push_str(value);
                }
                "id" => self.id = Some(value.to_string()),
                _ => {}
            }
        }
        out
    }
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn read_link_from_stdin() -> Result<String> {
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    let line = line.trim().to_string();
    if line.is_empty() {
        bail!("no link on stdin");
    }
    Ok(line)
}

/// Headless engine probe: redeem → workspace read → /live events for N seconds → /term upgrade (as this session).
pub fn main(args: &Args) -> Result<()> {
    let base = args
        .value("--base")
        .context("--base http://127.0.0.1:<port>")?;
    let secs: u64 = args.num("--secs", 10);
    let term_id = args
        .value("--term-id")
        .unwrap_or_else(|| "0123456789abcdef0123456789abcdef".into());
    let rooms_arg = args
        .value("--rooms")
        .unwrap_or_else(|| "workspace,summary".into());
    let link = read_link_from_stdin()?;
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    rt.block_on(async move {
        let started = now_ms();
        let (mut session, redeem_report) = redeem(&base, &link).await?;
        if args.flag("--check-one-time") {
            // The same link again: a one-time link must not make a second session.
            let again = match redeem(&base, &link).await { Ok((_, r)) => json!({ "second_session": true, "report": r }), Err(e) => json!({ "second_session": false, "error": e.to_string() }) };
            println!("{}", json!({ "step": "redeem-again", "result": again }));
        }
        drop(link);
        println!("{}", json!({ "step": "redeem", "at_ms": now_ms(), "report": redeem_report }));
        // A spent link must not redeem twice: check by asking for a second session with the same link is impossible
        // here (the link is dropped); results.md records the server's one-time behaviour from its code.
        for path in ["/?format=workspace", "/chat?format=workspace", "/?format=workspace", "/?format=workspace"] {
            let w = session.workspace(path).await?;
            println!("{}", json!({ "step": "workspace", "report": w }));
        }
        let (tx, mut rx) = mpsc::unbounded_channel();
        let rooms: Vec<&str> = rooms_arg.split(',').collect();
        let live_rooms: Vec<String> = rooms.iter().map(|s| s.to_string()).collect();
        let live = {
            let s = &session;
            async move {
                let r: Vec<&str> = live_rooms.iter().map(|s| s.as_str()).collect();
                s.live(&r, tx).await
            }
        };
        let deadline = tokio::time::sleep(std::time::Duration::from_secs(secs));
        tokio::pin!(live);
        tokio::pin!(deadline);
        let mut n = 0;
        let act = args.flag("--act-advanced");
        let act_at = tokio::time::sleep(std::time::Duration::from_millis(1500));
        tokio::pin!(act_at);
        let mut acted = !act;
        let mut posted_at: Option<u128> = None;
        loop {
            tokio::select! {
                _ = &mut deadline => break,
                _ = &mut act_at, if !acted => {
                    acted = true;
                    // A harmless local-owner act (Settings → Advanced, the person's own view switch), then time how long
                    // until /live says the workspace changed.
                    posted_at = Some(now_ms());
                    let r = session.post_form("/settings/advanced", &[("advanced", "on")]).await?;
                    println!("{}", json!({ "step": "act", "at_ms": posted_at, "report": r }));
                }
                r = &mut live => { println!("{}", json!({ "step": "live-ended", "result": format!("{r:?}") })); break }
                Some(ev) = rx.recv() => {
                    n += 1;
                    let data: String = ev.data.chars().take(160).collect();
                    if let Some(p) = posted_at {
                        if ev.event == "change" && ev.data.contains("\"room\":\"workspace\"") {
                            println!("{}", json!({ "step": "act-to-live", "ms": ev.at_ms - p }));
                            posted_at = None;
                        }
                    }
                    println!("{}", json!({ "step": "live", "at_ms": ev.at_ms, "since_start_ms": ev.at_ms - started, "event": ev.event, "id": ev.id, "data_bytes": ev.data.len(), "data_head": data }));
                }
            }
        }
        println!("{}", json!({ "step": "live-summary", "events": n }));
        match session.term(&term_id).await {
            Ok(_) => println!("{}", json!({ "step": "term", "upgraded": true })),
            Err(e) => println!("{}", json!({ "step": "term", "upgraded": false, "detail": e })),
        }
        println!("{}", json!({ "step": "session", "debug": format!("{session:?}") }));
        Ok::<_, anyhow::Error>(())
    })
}

/// Headless /term client against any socket speaking the console's frames: resize, type, read, render with vt100.
pub fn term_probe_main(args: &Args) -> Result<()> {
    // Either a bare socket (--url, --origin) or, with --base and a one-time link on stdin, the console road: redeem,
    // then open /term/<--term-id>/socket with the session's cookie and key.
    let base = args.value("--base");
    let link = if base.is_some() {
        Some(read_link_from_stdin()?)
    } else {
        None
    };
    let term_id = args.value("--term-id").unwrap_or_default();
    let url = args.value("--url").unwrap_or_default();
    let origin = args.value("--origin").unwrap_or_default();
    let input = args
        .value("--input")
        .unwrap_or_else(|| "echo hello-from-rust; ls -la | head -5\r".into());
    let cols: u16 = args.num("--cols", 100);
    let rows: u16 = args.num("--rows", 30);
    let secs: f64 = args.num("--secs", 2.0);
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    rt.block_on(async move {
        let mut redeem_report = Value::Null;
        let t = Instant::now();
        let mut ws = match (&base, link) {
            (Some(b), Some(l)) => {
                let (session, r) = redeem(b, &l).await?;
                redeem_report = r;
                session.term(&term_id).await.map_err(|e| anyhow!("{e}"))?
            }
            _ => connect_term(&url, &origin, None, None).await.map_err(|e| anyhow!("{e}"))?,
        };
        let connect_ms = t.elapsed().as_secs_f64() * 1000.0;
        ws.send(Message::text(json!({ "t": "resize", "cols": cols, "rows": rows }).to_string())).await?;
        let mut parser = vt100::Parser::new(rows, cols, 0);
        let mut controls = Vec::new();
        let mut bytes = 0usize;
        let mut first_output_ms = None;
        let mut typed_at = None;
        let mut echo_ms = None;
        let deadline = tokio::time::sleep(std::time::Duration::from_secs_f64(secs));
        tokio::pin!(deadline);
        let send_at = tokio::time::sleep(std::time::Duration::from_millis(400));
        tokio::pin!(send_at);
        let mut sent = false;
        loop {
            tokio::select! {
                _ = &mut deadline => break,
                _ = &mut send_at, if !sent => {
                    sent = true;
                    typed_at = Some(Instant::now());
                    ws.send(Message::text(json!({ "t": "in", "d": input }).to_string())).await?;
                }
                m = ws.next() => match m {
                    Some(Ok(Message::Binary(b))) => {
                        bytes += b.len();
                        first_output_ms.get_or_insert(t.elapsed().as_secs_f64() * 1000.0);
                        parser.process(&b);
                        if echo_ms.is_none() {
                            if let Some(at) = typed_at {
                                if parser.screen().contents().contains("hello-from-rust") {
                                    echo_ms = Some(at.elapsed().as_secs_f64() * 1000.0);
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Text(s))) => controls.push(s.to_string()),
                    Some(Ok(Message::Close(c))) => { controls.push(format!("close {c:?}")); break }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => { controls.push(format!("error {e}")); break }
                    None => break,
                }
            }
        }
        let screen = parser.screen().contents();
        println!("{}", serde_json::to_string_pretty(&json!({
            "redeem": redeem_report, "connect_ms": (connect_ms * 10.0).round() / 10.0, "first_output_ms": first_output_ms, "type_to_echo_ms": echo_ms,
            "output_bytes": bytes, "controls": controls,
            "screen_rows": screen.lines().filter(|l| !l.trim().is_empty()).take(12).collect::<Vec<_>>(),
        }))?);
        Ok::<_, anyhow::Error>(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_frames_split_across_chunks() {
        let mut p = SseParser::default();
        assert!(p.push(b"event: hello\ndata: {\"tick\":15000}").is_empty());
        let evs = p.push(b"\n\n: keep-alive\nevent: change\ndata: {\"room\":\"workspace\"}\n\n");
        let names: Vec<&str> = evs.iter().map(|e| e.event.as_str()).collect();
        assert_eq!(names, vec!["hello", "(comment)", "change"]);
        assert_eq!(evs[0].data, "{\"tick\":15000}");
        assert_eq!(evs[2].data, "{\"room\":\"workspace\"}");
    }

    #[test]
    fn delivery_page_key_is_read_and_shape_checked() {
        // The shape mutation-key.ts deliver() writes (`<` escaped as \u003c).
        let key = "ab".repeat(32);
        let value =
            serde_json::to_string(&json!({ "epoch": "0123456789abcdef", "key": key })).unwrap();
        let data = serde_json::to_string(
            &json!({ "storage": "toolroll.key", "value": value, "to": "/chat" }),
        )
        .unwrap();
        let body = format!("<p>Opening Toolroll…</p><script nonce=\"n\">(function(){{var d={data};try{{localStorage.setItem(d.storage,d.value)}}catch(e){{}}location.replace(d.to)}})();</script>");
        assert_eq!(parse_delivery(&body).unwrap(), (Some(key), 16));
        let bad = body.replace(&"ab".repeat(32), "not-a-key");
        assert_eq!(parse_delivery(&bad).unwrap(), (None, 16));
        assert_eq!(parse_delivery("<p>no script</p>").unwrap(), (None, 0));
    }

    #[test]
    fn only_loopback_origins_and_one_time_paths() {
        assert!(origin_of("http://127.0.0.1:4760/login/once/x").is_ok());
        assert!(origin_of("http://localhost:4760/").is_err());
        assert!(origin_of("https://127.0.0.1:4760/").is_err());
        assert!(origin_of("http://127.0.0.1:4760@evil.example/").is_err());
        assert!(link_path_ok(&format!("/login/once/{}", "A".repeat(43))));
        assert!(!link_path_ok("/login/once/short"));
        assert!(!link_path_ok(&format!(
            "/login/once/{}/../x",
            "A".repeat(43)
        )));
    }
}
