/**
 * Live mode (docs/plans/live-terminal.md): this person's terminals, one real terminal at a time, streamed over a
 * WebSocket. Its own small page and bundle, so the workspace never carries xterm.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

type Program = "claude" | "codex" | "shell";
type Session = { id: string; repo: string; project: string; program: Program; branch: string; startedAt: string; endedAt: string | null; exit: { code: number | null; signal: number | null } | null };
type State = { available: boolean; problem: string | null; sessions: Session[]; projects: { path: string; name: string }[]; programs: Program[] };
type Link = "connecting" | "live" | "ended" | "behind" | "signed-out" | "gone" | "offline" | "busy";

const PROGRAM_WORDS: Record<Program, string> = { claude: "Claude Code", codex: "Codex", shell: "Shell" };
const LINK_WORDS: Record<Link, string> = {
  connecting: "Connecting…", live: "Live", ended: "Ended", behind: "Catching up…",
  "signed-out": "Signed out — sign in again to keep typing", gone: "This terminal is gone", offline: "Reconnecting…",
  busy: "Not reading input — what you type waits",
};

const boot = document.getElementById("so-term-boot");
const CSRF = boot?.dataset["csrf"] ?? "";
const INITIAL = boot?.dataset["session"] ?? null;
/** Passwordless (docs/plans/passwordless.md): starting a terminal takes no password; the server proves the session. */
const PASSWORDLESS = boot?.dataset["passwordless"] === "1";

async function readState(): Promise<State | null> {
  const response = await fetch("/term/state", { headers: { accept: "application/json" }, credentials: "same-origin" });
  if (response.status === 401) { location.href = `/login?next=${encodeURIComponent(location.pathname)}`; return null; }
  return response.ok ? await response.json() as State : null;
}

async function post(path: string, fields: Record<string, string>): Promise<{ ok: boolean; id?: string; error?: string }> {
  const response = await fetch(path, { method: "POST", headers: { accept: "application/json" }, credentials: "same-origin", body: new URLSearchParams({ csrf: CSRF, ...fields }) });
  try { return await response.json() as { ok: boolean; id?: string; error?: string }; } catch { return { ok: false, error: "The console didn't answer. Try again." }; }
}

function Glyph({ program }: { program: Program }) {
  return <span className={`term-glyph term-glyph--${program}`} aria-hidden>{program === "claude" ? "C" : program === "codex" ? "X" : "$"}</span>;
}

/** One live terminal: xterm on a WebSocket, refitted to its box and to the phone's keyboard. */
function TerminalPane({ session, onLink, keys }: { session: Session; onLink: (link: Link) => void; keys: (send: (data: string) => void) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: window.matchMedia("(max-width: 720px)").matches ? 12 : 13,
      cursorBlink: true, allowProposedApi: false, scrollback: 5000, macOptionIsMeta: true,
      theme: { background: "#0C0E12", foreground: "#E6E8EC", cursor: "#E6E8EC", selectionBackground: "#2A3140",
        black: "#14171D", brightBlack: "#5B6372", blue: "#5B9DFF", brightBlue: "#8AB8FF", green: "#3FB97F", brightGreen: "#6BD9A2",
        red: "#F06464", brightRed: "#FF8F8F", yellow: "#F5A524", brightYellow: "#FFC266", cyan: "#4FC4CF", brightCyan: "#7FDDE5",
        magenta: "#B78CF2", brightMagenta: "#D0B3FF", white: "#C9CED6", brightWhite: "#FFFFFF" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current!);
    let socket: WebSocket | null = null;
    let stopped = false, ended = false, retry = 0, timer: number | undefined, busyTimer: number | undefined;
    const send = (frame: object) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame)); };
    const input = (data: string) => send({ t: "in", d: data });
    keys(input);
    const refit = () => {
      try { fit.fit(); } catch { return; }
      send({ t: "resize", cols: term.cols, rows: term.rows });
    };
    const connect = () => {
      onLink(retry === 0 ? "connecting" : "offline");
      const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/term/${session.id}/socket`;
      const ws = new WebSocket(url);
      socket = ws;
      ws.binaryType = "arraybuffer";
      let firstFrame = true;
      ws.onmessage = event => {
        if (firstFrame) { term.reset(); firstFrame = false; }
        if (typeof event.data !== "string") { term.write(new Uint8Array(event.data as ArrayBuffer)); return; }
        let control: { t?: string; ended?: boolean };
        try { control = JSON.parse(event.data) as typeof control; } catch { return; }
        if (control.t === "hello") { retry = 0; ended = control.ended === true; onLink(ended ? "ended" : "live"); if (!ended) refit(); }
        else if (control.t === "exit") { ended = true; onLink("ended"); }
        else if (control.t === "input-full") { onLink("busy"); window.clearTimeout(busyTimer); busyTimer = window.setTimeout(() => { if (!ended) onLink("live"); }, 2500); }
      };
      ws.onclose = event => {
        if (socket === ws) socket = null;
        if (stopped) return;
        if (event.code === 4401) return onLink("signed-out");
        if (event.code === 4404) return onLink("gone");
        if (ended) return onLink("ended");
        onLink(event.code === 4008 ? "behind" : "offline");
        retry += 1;
        timer = window.setTimeout(connect, Math.min(8000, 250 * 2 ** Math.min(retry, 5)));
      };
    };
    const typed = term.onData(input);
    const observer = new ResizeObserver(() => refit());
    observer.observe(box.current!);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", refit);
    connect();
    term.focus();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.clearTimeout(busyTimer);
      observer.disconnect();
      viewport?.removeEventListener("resize", refit);
      typed.dispose();
      socket?.close(1000);
      term.dispose();
    };
  }, [session.id]);
  return <div className="term-screen" ref={box} />;
}

/** The keys a phone keyboard lacks and these programs need. Ctrl is sticky for the next key typed here. */
function KeyBar({ sendRef }: { sendRef: { current: ((data: string) => void) | null } }) {
  const [ctrl, setCtrl] = useState(false);
  const key = (label: string, data: string) =>
    <button type="button" className="term-key" onPointerDown={event => { event.preventDefault(); sendRef.current?.(data); }}>{label}</button>;
  const control = (letter: string) => { sendRef.current?.(String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64)); setCtrl(false); };
  return <div className="term-keys" role="toolbar" aria-label="Terminal keys">
    {key("esc", "\x1b")}
    {key("tab", "\t")}
    <button type="button" className={`term-key${ctrl ? " term-key--on" : ""}`} aria-pressed={ctrl} onPointerDown={event => { event.preventDefault(); setCtrl(on => !on); }}>ctrl</button>
    {ctrl
      ? <>{["c", "d", "r", "l", "z"].map(letter => <button key={letter} type="button" className="term-key" onPointerDown={event => { event.preventDefault(); control(letter); }}>^{letter.toUpperCase()}</button>)}</>
      : <>{key("↑", "\x1b[A")}{key("↓", "\x1b[B")}{key("←", "\x1b[D")}{key("→", "\x1b[C")}{key("/", "/")}{key("⏎", "\r")}</>}
  </div>;
}

function NewSession({ state, onStarted, onCancel }: { state: State; onStarted: (id: string) => void; onCancel: (() => void) | null }) {
  const [repo, setRepo] = useState(state.projects[0]?.path ?? "");
  const [program, setProgram] = useState<Program>(state.programs[0] ?? "claude");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null);
    const answer = await post("/term/start", { repo, program, password });
    setBusy(false); setPassword("");
    if (answer.ok && answer.id !== undefined) onStarted(answer.id);
    else setError(answer.error ?? "The terminal didn't start.");
  };
  if (state.projects.length === 0) return <div className="term-new"><h2>No projects yet</h2><p>Add a project in the console first, then start a terminal in it.</p><a className="term-button" href="/projects">Projects</a></div>;
  return <form className="term-new" onSubmit={event => { void submit(event); }}>
    <h2>New terminal</h2>
    <p className="term-muted">Runs in a fresh worktree on its own branch. Your default branch is never touched.</p>
    <label className="term-field"><span>Project</span>
      <select value={repo} onChange={event => setRepo(event.target.value)}>{state.projects.map(one => <option key={one.path} value={one.path}>{one.name}</option>)}</select>
    </label>
    <fieldset className="term-programs"><legend>Program</legend>
      {state.programs.map(one => <label key={one} className={`term-program${program === one ? " term-program--on" : ""}`}>
        <input type="radio" name="program" value={one} checked={program === one} onChange={() => setProgram(one)} /><Glyph program={one} /> {PROGRAM_WORDS[one]}
      </label>)}
    </fieldset>
    {PASSWORDLESS
      ? <p className="term-muted">A terminal can do anything you can on this computer.</p>
      : <div className="term-ceremony">
        <p>A terminal can do anything you can on this computer. Confirm with your Toolroll password.</p>
        <label className="term-field"><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required /></label>
      </div>}
    {error !== null ? <p className="term-error" role="alert">{error}</p> : null}
    <div className="term-actions">
      {onCancel !== null ? <button type="button" className="term-button term-button--quiet" onClick={onCancel}>Cancel</button> : null}
      <button type="submit" className="term-button" disabled={busy || (!PASSWORDLESS && password === "") || repo === ""}>{busy ? "Starting…" : "Start"}</button>
    </div>
  </form>;
}

function App() {
  const [state, setState] = useState<State | null>(null);
  const [selected, setSelected] = useState<string | null>(INITIAL);
  const [creating, setCreating] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [link, setLink] = useState<Link>("connecting");
  const sendRef = useRef<((data: string) => void) | null>(null);
  const refresh = useCallback(async () => { const next = await readState(); if (next !== null) setState(next); }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => { void refresh(); }, 5000); return () => window.clearInterval(timer); }, [refresh]);
  useEffect(() => {
    if (state === null) return;
    if (selected !== null && !state.sessions.some(one => one.id === selected)) setSelected(state.sessions[0]?.id ?? null);
    if (selected === null && state.sessions.length > 0 && !creating) setSelected(state.sessions[0]!.id);
  }, [state, selected, creating]);
  useEffect(() => {
    const path = selected === null ? "/term" : `/term/${selected}`;
    if (location.pathname !== path) history.replaceState(null, "", path);
  }, [selected]);
  useEffect(() => { if (link === "ended") void refresh(); }, [link, refresh]);

  if (state === null) return <div className="term-app term-app--loading">Loading…</div>;
  const current = state.sessions.find(one => one.id === selected) ?? null;
  const choose = (id: string) => { setSelected(id); setCreating(false); setDrawer(false); };
  const act = async (verb: "close" | "remove") => {
    if (current === null) return;
    const answer = await post(`/term/${current.id}/${verb}`, {});
    if (!answer.ok && answer.error) window.alert(answer.error);
    await refresh();
  };

  const list: ReactNode = <nav className="term-list" aria-label="Terminals">
    <div className="term-list-head">
      <a href="/" className="term-back" aria-label="Back to the console">←</a>
      <h1>Live</h1>
      <button type="button" className="term-button term-button--small" onClick={() => { setCreating(true); setDrawer(false); }}>+ New</button>
    </div>
    {state.sessions.length === 0 ? <p className="term-muted term-list-empty">No terminals yet.</p> : null}
    {state.sessions.map(one => <button key={one.id} type="button" className={`term-item${one.id === selected && !creating ? " term-item--on" : ""}`} onClick={() => choose(one.id)}>
      <Glyph program={one.program} />
      <span className="term-item-text"><span className="term-item-title">{one.project}</span><span className="term-item-meta">{PROGRAM_WORDS[one.program]} · {one.branch}</span></span>
      <span className={`term-dot${one.endedAt === null ? " term-dot--live" : ""}`} aria-label={one.endedAt === null ? "running" : "ended"} />
    </button>)}
  </nav>;

  return <div className={`term-app${drawer ? " term-app--drawer" : ""}`}>
    <aside className="term-side">{list}</aside>
    <button type="button" className="term-scrim" aria-label="Close the list" onClick={() => setDrawer(false)} />
    <main className="term-main">
      <header className="term-bar">
        <button type="button" className="term-menu" aria-label="Terminals" onClick={() => setDrawer(true)}>☰</button>
        {current !== null && !creating
          ? <>
            <span className="term-bar-title"><Glyph program={current.program} /> {current.project}<span className="term-bar-branch">{current.branch}</span></span>
            <span className={`term-link term-link--${link}`}>{LINK_WORDS[link]}</span>
            {current.endedAt === null
              ? <button type="button" className="term-button term-button--quiet term-button--small" onClick={() => { if (window.confirm("Close this terminal? Everything running in it stops.")) void act("close"); }}>Close</button>
              : <button type="button" className="term-button term-button--quiet term-button--small" onClick={() => { if (window.confirm("Remove this terminal and its worktree? Its branch stays.")) void act("remove"); }}>Remove</button>}
          </>
          : <span className="term-bar-title">{state.available ? "New terminal" : "Live"}</span>}
      </header>
      {!state.available
        ? <div className="term-new"><h2>Terminals aren't available</h2><p>{state.problem ?? "This install can't run terminals."}</p></div>
        : creating || current === null
          ? <NewSession state={state} onCancel={current === null ? null : () => setCreating(false)} onStarted={id => { setCreating(false); setSelected(id); void refresh(); }} />
          : <>
            <TerminalPane key={current.id} session={current} onLink={setLink} keys={send => { sendRef.current = send; }} />
            <KeyBar sendRef={sendRef} />
          </>}
    </main>
  </div>;
}

createRoot(document.getElementById("so-term")!).render(<App />);
