//! A live terminal (solo-workbench T4, take over): the console's own routes and its one WebSocket, exactly as its Live
//! page uses them.
//!
//! - `GET /term/state` lists this session's terminals (the console lists only those this session's kind of owner
//!   started); `POST /term/start` starts one. A take-over names the task and the build and nothing else: the console
//!   finds the project and the commit in its own records, and decides solo or team, the local sign-in and the project
//!   again right before the program starts. Nothing posted here chooses what is trusted.
//! - `GET /term/<id>/socket` is upgraded with the session's cookie, the console's own Origin, and the mutation key
//!   offered as a subprotocol (`toolroll.key.<key>`, never echoed back); no Authorization header, no query. The console
//!   re-proves the session before every frame it takes and closes the socket (4401) when it no longer stands.
//! - Frames: text JSON from here (`{"t":"in","d":…}` typed input, `{"t":"resize","cols":…,"rows":…}`), binary terminal
//!   output and text JSON control (`hello`, `exit`, `input-full`) from there. Output is handed on as bytes for the
//!   screen's VT emulator; nothing here writes to a terminal.
use crate::client::{encode, ApiError, Client};
use crate::models::{TermStarted, TermState};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

/// Output bytes received and not yet let go of by whoever consumes them (the screen, once parsed), across every hop
/// from the socket on: at this or past it, the socket isn't read until some are (backpressure; the console then drops a
/// viewer that falls 4 MiB behind, said plainly as "Too much output"). So at most this plus one message (8 MiB at most)
/// is ever held.
pub const OUTPUT_BUDGET: usize = 4 << 20;

/// What the budget holds now (shared by a connection's reader and every chunk it handed on).
#[derive(Debug, Default)]
pub struct Held {
    bytes: std::sync::atomic::AtomicUsize,
    freed: tokio::sync::Notify,
}

impl Held {
    pub fn bytes(&self) -> usize {
        self.bytes.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// Terminal output on its way to the emulator; its bytes count against the connection's budget until it is dropped.
#[derive(Debug, Clone)]
pub struct Chunk {
    bytes: std::sync::Arc<Vec<u8>>,
    _held: Option<std::sync::Arc<ChunkHold>>,
}

#[derive(Debug)]
struct ChunkHold {
    len: usize,
    held: std::sync::Arc<Held>,
}

impl Drop for ChunkHold {
    fn drop(&mut self) {
        self.held
            .bytes
            .fetch_sub(self.len, std::sync::atomic::Ordering::SeqCst);
        self.held.freed.notify_one();
    }
}

impl Chunk {
    fn held(bytes: Vec<u8>, held: &std::sync::Arc<Held>) -> Chunk {
        let len = bytes.len();
        held.bytes
            .fetch_add(len, std::sync::atomic::Ordering::SeqCst);
        Chunk {
            bytes: std::sync::Arc::new(bytes),
            _held: Some(std::sync::Arc::new(ChunkHold {
                len,
                held: held.clone(),
            })),
        }
    }
}

impl From<Vec<u8>> for Chunk {
    fn from(bytes: Vec<u8>) -> Chunk {
        Chunk {
            bytes: std::sync::Arc::new(bytes),
            _held: None,
        }
    }
}

impl std::ops::Deref for Chunk {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        &self.bytes
    }
}

impl PartialEq for Chunk {
    fn eq(&self, other: &Chunk) -> bool {
        self.bytes == other.bytes
    }
}

/// A frame the console's terminal sent.
#[derive(Debug, Clone, PartialEq)]
pub enum TermEvent {
    /// Terminal output: for the VT emulator only.
    Output(Chunk),
    /// Everything before this was the screen as it is now (sent on attach); live output follows.
    Hello { cols: u16, rows: u16, ended: bool },
    /// The program ended.
    Exit {
        code: Option<i64>,
        signal: Option<i64>,
    },
    /// The program isn't reading what's typed: that input was not queued.
    InputFull,
    /// The socket closed (the console's close code, when it sent one).
    Closed { code: Option<u16> },
}

/// What the screen sends a terminal.
#[derive(Debug, Clone, PartialEq)]
pub enum TermSend {
    Input(String),
    Resize { cols: u16, rows: u16 },
}

/// The console's largest client frame is 64 KiB; typed input is sent in pieces whose JSON stays well under it.
const INPUT_PIECE_CHARS: usize = 8 * 1024;

/// A terminal id as the console makes them (32 lowercase hex): anything else is never put in a path.
pub fn term_id_ok(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Typed input as frames: each piece cut on a character boundary.
pub fn input_frames(text: &str) -> Vec<String> {
    let mut out = vec![];
    let mut piece = String::new();
    for c in text.chars() {
        piece.push(c);
        if piece.chars().count() >= INPUT_PIECE_CHARS {
            out.push(serde_json::json!({ "t": "in", "d": std::mem::take(&mut piece) }).to_string());
        }
    }
    if !piece.is_empty() {
        out.push(serde_json::json!({ "t": "in", "d": piece }).to_string());
    }
    out
}

/// A control frame from the console, read strictly; None for anything else (ignored).
pub fn control_of(text: &str) -> Option<TermEvent> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let small = |x: &serde_json::Value| {
        x.as_u64()
            .filter(|n| (1..=500).contains(n))
            .map(|n| n as u16)
    };
    match v["t"].as_str()? {
        "hello" => Some(TermEvent::Hello {
            cols: small(&v["cols"])?,
            rows: small(&v["rows"])?,
            ended: v["ended"].as_bool().unwrap_or(false),
        }),
        "exit" => Some(TermEvent::Exit {
            code: v["code"].as_i64(),
            signal: v["signal"].as_i64(),
        }),
        "input-full" => Some(TermEvent::InputFull),
        _ => None,
    }
}

impl Client {
    /// This session's live terminals.
    pub async fn term_state(&self) -> Result<TermState, ApiError> {
        self.get_json::<TermState>("/term/state", "your terminals")
            .await
    }

    /// Start a take-over terminal on a task's saved build (`program`: shell, claude or codex): its id, or the console's
    /// words for why not. No password is sent: the console proves a local owner's start itself.
    pub async fn term_start(
        &self,
        task: &str,
        run: i64,
        program: &str,
    ) -> Result<String, ApiError> {
        let run = run.to_string();
        let text = self
            .post_form_json(
                "/term/start",
                &[("task", task), ("run", &run), ("program", program)],
            )
            .await?;
        match serde_json::from_str::<TermStarted>(&text) {
            Ok(TermStarted::Started { id, .. }) if term_id_ok(&id) => Ok(id),
            Ok(TermStarted::Refused { error, .. }) => Err(ApiError::Refused(error)),
            _ => Err(ApiError::Contract(
                "The terminal's answer isn't what this version expects.".into(),
            )),
        }
    }

    /// Start an agent's OWN sign-in or install in a pane (the Agents screen): `kind` is `sign-in` or `install`; an
    /// install carries the exact command the person confirmed (`confirm`). What runs is the console's own constant for
    /// that agent; nothing here names a program. Its id, or the console's words for why not.
    pub async fn term_agent(
        &self,
        kind: &str,
        agent: &str,
        confirm: Option<&str>,
    ) -> Result<String, ApiError> {
        if kind != "sign-in" && kind != "install" {
            return Err(ApiError::Refused("Sign in or install.".into()));
        }
        let mut fields = vec![("agent", agent)];
        if let Some(c) = confirm {
            fields.push(("confirm", c));
        }
        let text = self
            .post_form_json(&format!("/term/agent/{kind}"), &fields)
            .await?;
        match serde_json::from_str::<TermStarted>(&text) {
            Ok(TermStarted::Started { id, .. }) if term_id_ok(&id) => Ok(id),
            Ok(TermStarted::Refused { error, .. }) => Err(ApiError::Refused(error)),
            _ => Err(ApiError::Contract(
                "The terminal's answer isn't what this version expects.".into(),
            )),
        }
    }

    /// Attach to terminal `id`: what to send it, and what it says, until either side closes.
    pub async fn term_connect(
        &self,
        id: &str,
    ) -> Result<
        (
            mpsc::UnboundedSender<TermSend>,
            mpsc::UnboundedReceiver<TermEvent>,
            std::sync::Arc<Held>,
        ),
        ApiError,
    > {
        if !term_id_ok(id) {
            return Err(ApiError::Refused("No such terminal.".into()));
        }
        let host = self
            .origin()
            .strip_prefix("http://")
            .ok_or_else(|| ApiError::Refused("Terminals open only on this computer.".into()))?
            .to_string();
        let stream = tokio::net::TcpStream::connect(&host)
            .await
            .map_err(|e| ApiError::Unreachable(e.to_string()))?;
        let _ = stream.set_nodelay(true);
        let mut request = format!("ws://{host}/term/{}/socket", encode(id))
            .into_client_request()
            .map_err(|e| ApiError::Unreachable(e.to_string()))?;
        let header = |v: &str| {
            HeaderValue::from_str(v)
                .map_err(|_| ApiError::Contract("A sign-in value can't be sent.".into()))
        };
        {
            let creds = self.creds_for_socket();
            let headers = request.headers_mut();
            headers.insert("origin", header(self.origin())?);
            headers.insert("cookie", header(creds.0)?);
            let mut protocols = header(&format!("toolroll, toolroll.key.{}", creds.1))?;
            protocols.set_sensitive(true);
            headers.insert("sec-websocket-protocol", protocols);
        }
        // The console sends the screen as it is (with its scrollback) as one message of at most 8 Mi characters.
        let config = WebSocketConfig::default()
            .max_message_size(Some(32 << 20))
            .max_frame_size(Some(32 << 20));
        let (ws, _) = match tokio_tungstenite::client_async_with_config(
            request,
            stream,
            Some(config),
        )
        .await
        {
            Ok(done) => done,
            Err(WsError::Http(response)) => {
                let status = response.status().as_u16();
                let words = response
                    .body()
                    .as_deref()
                    .and_then(|b| std::str::from_utf8(b).ok())
                    .map(|t| {
                        t.trim()
                            .chars()
                            .filter(|c| !c.is_control())
                            .take(200)
                            .collect::<String>()
                    })
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| format!("The terminal refused to open (status {status})."));
                return Err(ApiError::Refused(words));
            }
            Err(e) => return Err(ApiError::Unreachable(e.to_string())),
        };
        let (mut sink, mut source) = ws.split();
        let (send_tx, mut send_rx) = mpsc::unbounded_channel::<TermSend>();
        let (event_tx, event_rx) = mpsc::unbounded_channel::<TermEvent>();
        let held = std::sync::Arc::new(Held::default());
        let budget = held.clone();
        tokio::spawn(async move {
            // Until `hello`, the console sends only the screen as it is (one message it bounds) and then `hello`: read
            // freely until then (the screen waits for `hello` before it parses, so blocking here would never end).
            let mut hello_seen = false;
            loop {
                // Over budget: typing still goes out, but nothing more is read until the screen lets go of some.
                let can_read = !hello_seen || budget.bytes() < OUTPUT_BUDGET;
                tokio::select! {
                    _ = budget.freed.notified(), if !can_read => {}
                    out = send_rx.recv() => {
                        let Some(out) = out else {
                            // The screen let go of it (detached, another task, quitting): close it; the program runs on.
                            let _ = sink.send(Message::Close(None)).await;
                            break;
                        };
                        let frames = match out {
                            TermSend::Input(text) => input_frames(&text),
                            TermSend::Resize { cols, rows } => vec![serde_json::json!({ "t": "resize", "cols": cols, "rows": rows }).to_string()],
                        };
                        for frame in frames {
                            if sink.send(Message::text(frame)).await.is_err() {
                                break;
                            }
                        }
                    }
                    frame = source.next(), if can_read => {
                        let event = match frame {
                            Some(Ok(Message::Binary(bytes))) => TermEvent::Output(Chunk::held(bytes.to_vec(), &budget)),
                            Some(Ok(Message::Text(text))) => match control_of(text.as_str()) {
                                Some(e) => {
                                    hello_seen |= matches!(e, TermEvent::Hello { .. });
                                    e
                                }
                                None => continue,
                            },
                            Some(Ok(Message::Close(frame))) => {
                                let _ = event_tx.send(TermEvent::Closed { code: frame.map(|f| u16::from(f.code)) });
                                break;
                            }
                            Some(Ok(_)) => continue,
                            Some(Err(_)) | None => {
                                let _ = event_tx.send(TermEvent::Closed { code: None });
                                break;
                            }
                        };
                        if event_tx.send(event).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        Ok((send_tx, event_rx, held))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_the_consoles_shape_only() {
        assert!(term_id_ok(&"a1".repeat(16)));
        for bad in [
            "",
            "../x",
            &"A".repeat(32),
            &"a".repeat(31),
            &"a".repeat(33),
            &"g".repeat(32),
        ] {
            assert!(!term_id_ok(bad), "{bad}");
        }
    }

    #[test]
    fn long_input_is_cut_into_frames_under_the_consoles_limit() {
        let text: String = "é\u{1}".repeat(20_000);
        let frames = input_frames(&text);
        assert!(frames.len() > 1);
        let mut joined = String::new();
        for f in &frames {
            assert!(f.len() < 64 * 1024, "{}", f.len());
            let v: serde_json::Value = serde_json::from_str(f).unwrap();
            assert_eq!(v.as_object().unwrap().len(), 2);
            joined.push_str(v["d"].as_str().unwrap());
        }
        assert_eq!(joined, text);
    }

    #[test]
    fn control_frames_are_read_strictly() {
        assert_eq!(
            control_of(r#"{"t":"hello","cols":120,"rows":30,"program":"shell","ended":false}"#),
            Some(TermEvent::Hello {
                cols: 120,
                rows: 30,
                ended: false
            })
        );
        assert_eq!(control_of(r#"{"t":"hello","cols":0,"rows":30}"#), None);
        assert_eq!(control_of(r#"{"t":"hello","cols":9999,"rows":30}"#), None);
        assert_eq!(
            control_of(r#"{"t":"exit","code":0,"signal":null}"#),
            Some(TermEvent::Exit {
                code: Some(0),
                signal: None
            })
        );
        assert_eq!(
            control_of(r#"{"t":"input-full"}"#),
            Some(TermEvent::InputFull)
        );
        assert_eq!(control_of("not json"), None);
        assert_eq!(control_of(r#"{"t":"title","d":"x"}"#), None);
    }
}
