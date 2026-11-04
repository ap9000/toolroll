/**
 * Terminals (docs/plans/live-terminal.md; on the kit since UI revamp wave B): this operator's terminals, one real
 * terminal at a time, streamed over a WebSocket. Its own small page and bundle, so the workspace never carries xterm;
 * it reaches back to Agents (/agents/terminals leads here). Starting one is step-up: the password unless Passwordless.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import "../design/tokens.css";
import "../design/kit.css";
import "./terminal.css";
import { termsOf } from "../design/kit.js";
import { installKitBehavior, KActs, KApprove, KButton, KChip, KEmpty, KField, KIcon, KLinkButton, KNote, KOverlay, KRadios, KSelect } from "./kit/index.js";
import { keyed, socketProtocols } from "./mutation-key.js";

type Program = "claude" | "codex" | "shell";
type Session = { id: string; repo: string; project: string; program: Program; branch: string; startedAt: string; endedAt: string | null; exit: { code: number | null; signal: number | null } | null };
type State = { available: boolean; problem: string | null; sessions: Session[]; projects: { path: string; name: string }[]; programs: Program[] };
type Link = "connecting" | "live" | "ended" | "behind" | "signed-out" | "gone" | "offline" | "busy";

const PROGRAM_WORDS: Record<Program, string> = { claude: "Claude Code", codex: "Codex", shell: "Shell" };
const PROGRAM_TEXT: Record<Program, string> = { claude: "An agent you drive by hand", codex: "An agent you drive by hand", shell: "A plain terminal" };
const LINK_WORDS: Record<Link, string> = {
  connecting: "Connecting…", live: "Live", ended: "Ended", behind: "Catching up…",
  "signed-out": "Signed out. Sign in again to keep typing", gone: "This terminal is gone", offline: "Reconnecting…",
  busy: "Not reading input. What you type waits",
};

const boot = document.getElementById("so-term-boot");
const CSRF = boot?.dataset["csrf"] ?? "";
// The page names a terminal to open (/term/<id>), or nothing (an empty attribute).
const INITIAL = boot?.dataset["session"] || null;
/** Passwordless (docs/plans/passwordless.md): starting a terminal takes no password; the server proves the session. */
const PASSWORDLESS = boot?.dataset["passwordless"] === "1";
const FACTS = { passwordless: PASSWORDLESS, remembered: false };
const isPhone = () => window.matchMedia("(max-width: 760px)").matches;

async function readState(): Promise<State | null> {
  const response = await fetch("/term/state", { headers: { accept: "application/json" }, credentials: "same-origin" });
  if (response.status === 401) { location.href = `/login?next=${encodeURIComponent(location.pathname)}`; return null; }
  return response.ok ? await response.json() as State : null;
}

async function post(path: string, fields: Record<string, string>): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const response = await fetch(path, { method: "POST", headers: keyed({ accept: "application/json" }), credentials: "same-origin", body: new URLSearchParams({ csrf: CSRF, ...fields }) });
    return await response.json() as { ok: boolean; id?: string; error?: string };
  } catch { return { ok: false, error: "The console didn't answer. Nothing changed; try again." }; }
}

/** The terminal's colours, from the design tokens of the theme in use (light or dark). */
function themeOf(): ITheme {
  const read = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const ink = read("--so-ink"), paper = read("--so-code-bg") || read("--so-paper"), muted = read("--so-muted");
  return {
    background: paper, foreground: ink, cursor: ink, cursorAccent: paper, selectionBackground: read("--so-selection") || read("--so-soft"),
    black: ink, brightBlack: muted, white: muted, brightWhite: ink,
    blue: read("--so-info"), brightBlue: read("--so-info"), green: read("--so-success"), brightGreen: read("--so-success"),
    red: read("--so-danger"), brightRed: read("--so-danger"), yellow: read("--so-warning"), brightYellow: read("--so-warning"),
    cyan: read("--so-info"), brightCyan: read("--so-info"), magenta: read("--so-accent-text"), brightMagenta: read("--so-accent-text"),
  };
}

/** One live terminal: xterm on a WebSocket, refitted to its box and to the phone's keyboard. */
function TerminalPane({ session, onLink, keys }: { session: Session; onLink: (link: Link) => void; keys: (send: (data: string) => void) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: isPhone() ? 12 : 13,
      cursorBlink: true, allowProposedApi: true, scrollback: 5000, macOptionIsMeta: true, theme: themeOf(),
    });
    // The theme follows the system's light or dark, as the rest of the page does.
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const retheme = () => { term.options.theme = themeOf(); };
    scheme.addEventListener("change", retheme);
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Emoji and wide characters measured as current terminals measure them (Unicode 11 widths).
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11";
    term.open(box.current!);
    // Drawn on the GPU where the browser allows it; a lost context (a backgrounded phone tab) falls back to the DOM.
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => { webgl?.dispose(); webgl = null; });
      term.loadAddon(webgl);
    } catch { webgl = null; }
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
      const ws = new WebSocket(url, socketProtocols());
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
      scheme.removeEventListener("change", retheme);
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
  // Pointer-down, not click: the terminal keeps the keyboard focus (and the phone keeps its keyboard up).
  const key = (label: string, data: string) =>
    <KButton key={label} sm className="term-key" label={label} onPointerDown={event => { event.preventDefault(); sendRef.current?.(data); }} />;
  const control = (letter: string) => { sendRef.current?.(String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64)); setCtrl(false); };
  return <div className="term-keys" role="toolbar" aria-label="Terminal keys">
    {key("Esc", "\x1b")}
    {key("Tab", "\t")}
    <KButton sm className="term-key" label="Ctrl" aria-pressed={ctrl} onPointerDown={event => { event.preventDefault(); setCtrl(on => !on); }} />
    {ctrl
      ? <>{["c", "d", "r", "l", "z"].map(letter => <KButton key={letter} sm className="term-key" label={`^${letter.toUpperCase()}`} onPointerDown={event => { event.preventDefault(); control(letter); }} />)}</>
      : <>{key("↑", "\x1b[A")}{key("↓", "\x1b[B")}{key("←", "\x1b[D")}{key("→", "\x1b[C")}{key("/", "/")}{key("⏎", "\r")}</>}
  </div>;
}

/** New terminal: a project and a program, then Start (step-up: the password unless Passwordless). */
function NewSession({ state, onStarted, onCancel }: { state: State; onStarted: (id: string) => void; onCancel: (() => void) | null }) {
  const [repo, setRepo] = useState(state.projects[0]?.path ?? "");
  const [program, setProgram] = useState<Program>(state.programs[0] ?? "claude");
  if (state.projects.length === 0) return <div className="term-form"><KEmpty title="No projects yet." text="Add a project in the console first, then start a terminal in it." action={<KLinkButton sm href="/projects" label="Open Projects" />} /></div>;
  const project = state.projects.find(one => one.path === repo)?.name ?? "";
  // The approval covers exactly what was shown: the project and program as they stand when Start is pressed.
  const start = async (password: string | null): Promise<string | null> => {
    const answer = await post("/term/start", { repo, program, password: password ?? "" });
    if (answer.ok && answer.id !== undefined) { onStarted(answer.id); return null; }
    return answer.error ?? "The terminal didn't start. Nothing changed.";
  };
  return <section className="term-form" aria-labelledby="term-new-title" data-term-new>
    <h2 id="term-new-title" className="k-sr">New terminal</h2>
    <KField label="Project">{ids => <KSelect id={ids.id} wide value={repo} onChange={event => setRepo(event.target.value)} items={state.projects.map(one => [one.path, one.name] as const)} />}</KField>
    <div className="k-field term-radios"><span className="k-label">Program</span>
      <KRadios name="program" legend="Program" current={program} onChange={value => setProgram(value as Program)} items={state.programs.map(one => ({ value: one, label: PROGRAM_WORDS[one], text: PROGRAM_TEXT[one] }))} />
    </div>
    <p className="term-terms">{PROGRAM_WORDS[program]} · {project} · a fresh worktree on its own branch</p>
    <KActs>
      <KApprove kind="step-up" facts={FACTS} label="Start terminal" terms={`${PROGRAM_WORDS[program]} in ${project}, a fresh worktree on its own branch.`} onApprove={start} />
      {onCancel !== null && <KButton variant="ghost" label="Cancel" onClick={onCancel} />}
    </KActs>
    <KNote>{`${termsOf("step-up", FACTS)} A terminal can do anything you can on this computer. Your default branch is never touched.`}</KNote>
  </section>;
}

/** Close (a live terminal) or Remove (an ended one), each asked first in a popover; the outcome shows in place. */
function EndControl({ session, onDone }: { session: Session; onDone: () => Promise<void> }) {
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const live = session.endedAt === null;
  const verb = live ? "close" : "remove";
  const act = async () => {
    setBusy(true); setRefusal(null);
    const answer = await post(`/term/${session.id}/${verb}`, {});
    setBusy(false);
    if (!answer.ok) { setRefusal(answer.error ?? "That didn't work. Nothing changed."); return; }
    setTrigger(null);
    await onDone();
  };
  return <>
    <KButton variant="ghost" sm label={live ? "Close" : "Remove"} aria-haspopup="dialog" onClick={event => setTrigger(event.currentTarget)} data-term-end={verb} />
    {trigger !== null && <KOverlay kind="popover" title={live ? "Close this terminal?" : "Remove this terminal?"} trigger={trigger} onClose={() => { setTrigger(null); setRefusal(null); }}>
      <p className="k-pop-terms">{live ? "Everything running in it stops. Its branch stays." : "Its worktree is removed. Its branch stays."}</p>
      {refusal !== null && <p className="k-notice" role="alert"><KIcon name="alert" small /><span>{refusal}</span></p>}
      <KActs><KButton variant="danger" label={live ? "Close terminal" : "Remove terminal"} busy={busy ? (live ? "Closing…" : "Removing…") : false} onClick={() => { void act(); }} /><KButton variant="ghost" label="Cancel" data-k-close="" /></KActs>
    </KOverlay>}
  </>;
}

function App() {
  const [state, setState] = useState<State | null>(null);
  const [selected, setSelected] = useState<string | null>(INITIAL);
  const [creating, setCreating] = useState(false);
  const [listing, setListing] = useState(INITIAL === null);
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

  if (state === null) return <div className="term-app term-app--loading"><p className="k-note">Loading…</p></div>;
  const current = state.sessions.find(one => one.id === selected) ?? null;
  const running = state.sessions.filter(one => one.endedAt === null).length;
  const choose = (id: string) => { setSelected(id); setCreating(false); setListing(false); };
  const newOne = () => { setCreating(true); setListing(false); };
  // On a phone, one thing at a time: the list, a terminal, or the new-terminal form.
  const phonePane = creating || (!listing && current !== null);

  const list = <nav className="term-list" aria-label="Terminals">
    {state.sessions.length === 0 ? <p className="term-none">No terminals yet.</p> : null}
    {state.sessions.map(one => <a key={one.id} href={`/term/${one.id}`} className="term-item" aria-current={one.id === selected && !creating ? "true" : undefined}
      onClick={event => { event.preventDefault(); choose(one.id); }}>
      <span className="term-item-t">{PROGRAM_WORDS[one.program]} · {one.project}</span>
      <span className="term-item-m">{one.endedAt === null ? <KChip word="Live" tone="live" /> : <KChip word="Ended" />}<span className="k-mono">{one.branch}</span></span>
    </a>)}
  </nav>;

  const header = <header className="term-tb">
    {phonePane
      ? <KButton className="k-phone-only" variant="ghost" iconOnly="back" label="All terminals" onClick={() => { setCreating(false); setListing(true); }} />
      : <a className="k-btn k-btn-ghost k-btn-icon k-phone-only" href="/agents" aria-label="Agents" title="Agents"><KIcon name="back" /></a>}
    <a className="term-back k-desk-only" href="/agents"><KIcon name="back" small />Agents</a>
    <h1>Terminals</h1>
    <span className="term-ctx">{running} running · up to 8</span>
    <span className="k-grow" />
    {state.available && !creating && <KButton variant="primary" sm lead="plus" label="New terminal" onClick={newOne} />}
  </header>;

  let pane;
  if (!state.available) pane = <div className="term-form"><KEmpty title="Terminals aren't available." text={state.problem ?? "This install can't run terminals."} /></div>;
  else if (creating || current === null) pane = <NewSession state={state} onCancel={current === null && state.sessions.length === 0 ? null : () => setCreating(false)} onStarted={id => { setCreating(false); setSelected(id); setListing(false); void refresh(); }} />;
  else pane = <section className="term-pane" aria-label={`${PROGRAM_WORDS[current.program]} terminal`}>
    <header className="term-ph">
      <div><b>{PROGRAM_WORDS[current.program]} · {current.project}</b>
        <span className="term-ph-m"><span className="k-mono">{current.branch}</span> · started {new Date(current.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>
      <span className={`term-link term-link--${link}`} role="status">{LINK_WORDS[link]}</span>
      <EndControl key={current.id} session={current} onDone={refresh} />
    </header>
    <TerminalPane key={current.id} session={current} onLink={setLink} keys={send => { sendRef.current = send; }} />
    {current.endedAt === null ? <KeyBar sendRef={sendRef} /> : <KNote>Ended. Its branch stays; Remove takes it off this list.</KNote>}
  </section>;

  return <div className={`term-app${phonePane ? " term-app--pane" : ""}`} data-kit-page>
    {header}
    <div className="term-grid">
      <aside className="term-side">{list}</aside>
      <main className="term-main">{pane}</main>
    </div>
  </div>;
}

// The kit's delegated behaviour (Close buttons, Escape, the keyboard on a phone), as the workspace installs it.
installKitBehavior();
createRoot(document.getElementById("so-term")!).render(<App />);
