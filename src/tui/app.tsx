/**
 * The terminal UI (easy-start plan E): this computer's tasks, what each agent is doing now, and the everyday acts.
 *
 * Screens: Setup (the welcome's steps, until the first task), Main (tasks | live output | what needs you), New task,
 * Task, the plan before approving it, a revision's words, and Needs password. Keys: j/k move, Enter opens, n new task,
 * a approve (the full plan first) or accept, c accept, b send back, r retry, s stop, 1–9 answer a question, w browser, ? help,
 * q quit. Every write goes through the TuiSource, which runs it as the local owner; a refusal shows its own words.
 */
import { keyWords, SHORTCUTS, type TuiShortcut } from "../keymap.js";
import { Box, Text, useApp, useInput, type Key } from "ink";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { terminalText } from "../terminal-text.js";
import { HOME_GROUP_LABEL, HOME_GROUPS } from "../home-groups.js";
import type { TuiAct, TuiExit, TuiFastTerms, TuiRow, TuiSession, TuiSetup, TuiSnapshot, TuiSource, TuiTask } from "./data.js";

/** Text that came from outside this screen (an agent, a person, a project), as the terminal shows it: escapes and
 * controls never reach it (terminal-text.ts). The source cleans it first; this is the second layer. */
function SafeText({ children, ...props }: Omit<ComponentProps<typeof Text>, "children"> & { children: string }) {
  return <Text {...props}>{terminalText(children)}</Text>;
}

export interface AppProps {
  readonly source: TuiSource;
  readonly session: TuiSession;
  /** Called once with how the person left, after Ink is told to exit. */
  readonly onExit?: (exit: TuiExit) => void;
  /** How often the screen looks for changes (ms). */
  readonly pollMs?: number;
}

type Screen =
  | { kind: "main" }
  | { kind: "task"; task: TuiTask }
  | { kind: "approve"; task: TuiTask }
  | { kind: "compose"; purpose: "new" | "revise"; id: string | null; text: string; project: number }
  | { kind: "build"; terms: TuiFastTerms; text: string; repo: string | null }
  | { kind: "password"; message: string }
  | { kind: "help" }
  | { kind: "quit" }
  | { kind: "background" };

/** The keys (keymap.ts is the one table the console shares): its keys as this screen does them, then the terminal's own. */
const TUI_SAYS: Readonly<Record<TuiShortcut, string>> = {
  new: "new task", ink: "approve the plan (shows it in full first), or accept the result", "send-back": "send the result back",
  retry: "retry", list: "back to the task list", help: "these keys",
};
export const HELP_LINES = [
  "j / k or ↑ / ↓   move",
  "Enter            open the task",
  ...SHORTCUTS.filter(one => typeof one.tui === "string").map(one => `${keyWords(one.keys).padEnd(17)}${TUI_SAYS[one.tui as TuiShortcut]}`),
  "c                accept the result",
  "s                stop the running attempt",
  "1–9              answer the task's question",
  "w                open in the browser",
  "Esc              back",
  "q                quit",
];

/** The list in Home's order (home-groups.ts): Waiting on you, Working, Done, then anything in no group; each group keeps
 * the order the work index gave it. */
export function inHomeOrder(rows: readonly TuiRow[]): TuiRow[] {
  const rank = (row: TuiRow) => row.group === null ? HOME_GROUPS.length : HOME_GROUPS.indexOf(row.group);
  return rows.map((row, index) => ({ row, index })).sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index).map(one => one.row);
}
/** A group's heading in the list; work in no group (cancelled, replaced) is listed under Other. */
const groupHeading = (row: TuiRow): string => row.group === null ? "Other" : HOME_GROUP_LABEL[row.group];

/** Printable characters typed or pasted into a composer (control characters dropped). */
const typed = (input: string): string => [...input].filter(char => char >= " " && char !== "\u007f").join("");

export function App({ source, session, onExit, pollMs = 1_000 }: AppProps) {
  const { exit } = useApp();
  const [snapshot, setSnapshot] = useState<TuiSnapshot | null>(null);
  const [setup, setSetup] = useState<TuiSetup | null>(null);
  const [selected, setSelected] = useState(0);
  const [screen, setScreen] = useState<Screen>({ kind: "main" });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [live, setLive] = useState<readonly string[]>([]);
  const seen = useRef<number | null>(null);
  const ticks = useRef(0);
  const ended = useRef(false);

  const rows: readonly TuiRow[] = inHomeOrder(snapshot?.rows ?? []);
  const current: TuiRow | undefined = rows[Math.min(selected, Math.max(rows.length - 1, 0))];

  const refresh = useCallback(async () => {
    const next = await source.snapshot();
    setSnapshot(next);
    if (next.rows.length === 0) setSetup(await source.setup());
  }, [source]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => {
      ticks.current += 1;
      const now = source.changed();
      if (now !== seen.current || ticks.current % 5 === 0) {
        seen.current = now;
        void refresh();
      }
    }, pollMs);
    return () => clearInterval(timer);
  }, [source, refresh, pollMs]);
  // The selected task's live output, read again each tick.
  const currentId = current?.id ?? null;
  useEffect(() => {
    if (currentId === null) { setLive([]); return; }
    setLive(source.live(currentId));
    const timer = setInterval(() => setLive(source.live(currentId)), pollMs);
    return () => clearInterval(timer);
  }, [source, currentId, pollMs]);

  const leave = (how: TuiExit) => {
    if (ended.current) return;
    ended.current = true;
    exit();
    onExit?.(how);
  };

  const pendingG = useRef(false);
  /** One write, as the local owner: its words, or the way to a password when the local owner may not. */
  const act = async (one: TuiAct): Promise<boolean> => {
    setBusy("Working…");
    try {
      const result = await source.act(one);
      if (!result.ok) {
        if (result.needsPassword) setScreen({ kind: "password", message: result.message });
        else setMessage(result.message);
        return false;
      }
      setMessage(result.message);
      await refresh();
      if (one.kind === "new" && session.shouldAskBackground()) setScreen({ kind: "background" });
      return true;
    } finally { setBusy(null); }
  };

  const openTask = async (id: string, then: (task: TuiTask) => void) => {
    const task = await source.task(id);
    if (task === null) setMessage("That task can't be read now.");
    else then(task);
  };
  const approve = (id: string) => openTask(id, task => {
    if (task.plan === null) setMessage("No plan is waiting for your approval on this task.");
    else setScreen({ kind: "approve", task });
  });
  /** `a`: the task's own ink act — its plan (shown in full first), or else its finished result. */
  const approveOrAccept = (id: string) => openTask(id, task => {
    if (task.plan !== null) setScreen({ kind: "approve", task });
    else if (task.hasResult) void act({ kind: "complete", id });
    else setMessage("No plan or result is waiting for you on this task.");
  });
  const stop = (id: string, runId: number | null) => {
    if (runId === null) { setMessage("Nothing is running on this task."); return; }
    void act({ kind: "stop", id, runId });
  };
  const answer = (task: TuiTask, index: number) => {
    const decision = task.decisions[0];
    const option = decision?.options[index];
    if (decision === undefined || option === undefined) return;
    void act({ kind: "answer", decision: decision.id, option: option.id }).then(ok => { if (ok) setScreen({ kind: "main" }); });
  };
  const browser = () => { setBusy("Opening the browser…"); void session.openBrowser().then(words => { setMessage(words); setBusy(null); }); };
  const quit = () => { if (session.owned()) setScreen({ kind: "quit" }); else leave("leave"); };
  /** The acts every list and task screen shares. True when the key was one of them. */
  const shared = (input: string, id: string | null, runId: number | null): boolean => {
    // g then h or t (keymap.ts): Home and Tasks are this list here.
    if (pendingG.current) { pendingG.current = false; if (input === "h" || input === "t") { setScreen({ kind: "main" }); return true; } }
    if (input === "g") { pendingG.current = true; return true; }
    if (input === "/") { const gap = SHORTCUTS.find(one => one.keys === "/")!.tui; setMessage(typeof gap === "string" ? null : gap.none); return true; }
    if (input === "n") { setScreen({ kind: "compose", purpose: "new", id: null, text: "", project: 0 }); return true; }
    if (input === "w") { browser(); return true; }
    if (input === "?") { setScreen({ kind: "help" }); return true; }
    if (input === "q") { quit(); return true; }
    if (id === null) return false;
    // One keymap (docs/plans/plain-toolroll.md P1.3): a the page's ink act (Approve, or Accept), c Accept, b Send back, r Retry.
    if (input === "a") { void approveOrAccept(id); return true; }
    if (input === "s") { stop(id, runId); return true; }
    if (input === "b") { setScreen({ kind: "compose", purpose: "revise", id, text: "", project: 0 }); return true; }
    if (input === "r") { void act({ kind: "retry", id }); return true; }
    if (input === "c") { void act({ kind: "complete", id }); return true; }
    return false;
  };

  // The latest handler, read through a ref the render updates: a key typed right after a screen changes reaches that
  // screen, never the one before it (Ink re-subscribes a changed handler only after the frame is drawn).
  const onKey = (input: string, key: Key) => {
    if (busy !== null) return;
    if (key.ctrl && input === "c") { quit(); return; }
    switch (screen.kind) {
      case "main": {
        if (input === "j" || key.downArrow) { setSelected(index => Math.min(index + 1, Math.max(rows.length - 1, 0))); return; }
        if (input === "k" || key.upArrow) { setSelected(index => Math.max(index - 1, 0)); return; }
        if (key.return && current !== undefined) { void openTask(current.id, task => setScreen({ kind: "task", task })); return; }
        if (key.escape) { setMessage(null); return; }
        shared(input, current?.id ?? null, current?.liveRunId ?? null);
        return;
      }
      case "task": {
        if (key.escape || key.leftArrow) { setScreen({ kind: "main" }); return; }
        if (/^[1-9]$/.test(input)) { answer(screen.task, Number(input) - 1); return; }
        shared(input, screen.task.id, screen.task.liveRunId);
        return;
      }
      case "approve": {
        if (key.escape || input === "n") { setScreen({ kind: "main" }); setMessage("Nothing approved."); return; }
        if (input === "y") { const { task } = screen; void act({ kind: "approve", id: task.id, digest: task.plan!.digest }).then(ok => { if (ok) setScreen({ kind: "main" }); }); }
        return;
      }
      case "build": {
        if (key.escape) { setScreen({ kind: "main" }); setMessage("Nothing started."); return; }
        if (input === "p") { const { text, repo } = screen; setScreen({ kind: "main" }); void act({ kind: "new", text, repo }); return; }
        if (key.return) { const { preview, digest } = screen.terms; void act({ kind: "build", preview, digest }).then(ok => { if (ok) setScreen({ kind: "main" }); }); }
        return;
      }
      case "compose": {
        if (key.escape) { setScreen({ kind: "main" }); return; }
        const projects = snapshot?.projects ?? [];
        if (key.tab && screen.purpose === "new" && projects.length > 1) { setScreen({ ...screen, project: (screen.project + 1) % projects.length }); return; }
        if (key.backspace || key.delete) { setScreen({ ...screen, text: screen.text.slice(0, -1) }); return; }
        if (key.return) {
          const text = screen.text.trim();
          if (text === "") return;
          const sent: TuiAct = screen.purpose === "new" ? { kind: "new", text, repo: projects[screen.project] ?? null } : { kind: "revise", id: screen.id!, text };
          setScreen({ kind: "main" });
          // A small task shows its exact terms and Enter is Build; anything else files as it always has.
          if (sent.kind === "new") { setBusy("Reading it…"); void source.fastTerms(text, sent.repo).catch(() => null).then(terms => { setBusy(null); if (terms === null) void act(sent); else setScreen({ kind: "build", terms, text, repo: sent.repo }); }); return; }
          void act(sent);
          return;
        }
        const more = typed(input);
        if (more !== "") setScreen({ ...screen, text: screen.text + more });
        return;
      }
      case "quit": {
        if (input === "s") leave("stop");
        else if (input === "b") leave("keep");
        else if (key.escape) setScreen({ kind: "main" });
        return;
      }
      case "background": {
        const yes = input === "y" || input === "Y" || key.return;
        if (!yes && input !== "n" && input !== "N") return;
        setScreen({ kind: "main" });
        setBusy(yes ? "Moving Toolroll to the background…" : "Saving…");
        void session.answerBackground(yes).then(words => { setMessage(words); setBusy(null); });
        return;
      }
      default:
        if (key.escape || key.return || input === "q") setScreen({ kind: "main" });
    }
  };
  const keyHandler = useRef(onKey);
  keyHandler.current = onKey;
  useInput(useCallback((input: string, key: Key) => keyHandler.current(input, key), []));

  const footer = busy ?? message;
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold>Toolroll</Text>
        {snapshot?.needsYou ? <SafeText bold>{snapshot.needsYou}</SafeText> : <Text dimColor>Nothing needs you</Text>}
        {snapshot?.learning ? <SafeText dimColor>{snapshot.learning}</SafeText> : null}
      </Box>
      {body()}
      {footer === null ? null : <SafeText>{footer}</SafeText>}
      <Text dimColor>{hints()}</Text>
    </Box>
  );

  function hints(): string {
    switch (screen.kind) {
      case "main": return rows.length === 0 ? "n new task · w browser · ? help · q quit" : "j/k move · Enter open · n new · a approve/accept · b send back · r retry · s stop · w browser · ? help · q quit";
      case "task": return "a approve/accept · b send back · r retry · s stop · 1–9 answer · w browser · Esc back";
      case "approve": return "y approve · Esc cancel";
      case "build": return "Enter Build · p plan it first · Esc cancel";
      case "compose": return screen.purpose === "new" && (snapshot?.projects.length ?? 0) > 1 ? "Enter send · Tab project · Esc cancel" : "Enter send · Esc cancel";
      case "quit": return "s stop · b background · Esc cancel";
      case "background": return "y yes · n no";
      default: return "Esc back";
    }
  }

  function body() {
    switch (screen.kind) {
      case "help":
        return <Box flexDirection="column" borderStyle="single" paddingX={1}><Text bold>Keys</Text>{HELP_LINES.map(line => <Text key={line}>{line}</Text>)}</Box>;
      case "password":
        return (
          <Box flexDirection="column" borderStyle="single" paddingX={1}>
            <Text bold>This needs your password</Text>
            <SafeText>{screen.message}</SafeText>
            {snapshot?.passwordSet ? <Text>Sign in in the browser, then do it there.</Text> : <Text>Set a password: run `toolroll password set`</Text>}
          </Box>
        );
      case "quit":
        return (
          <Box flexDirection="column" borderStyle="single" paddingX={1}>
            <Text bold>Quit Toolroll?</Text>
            <Text>s  Stop agents and quit (running work is saved)</Text>
            <Text>b  Keep running in the background</Text>
          </Box>
        );
      case "background":
        return <Box borderStyle="single" paddingX={1}><Text bold>Keep Toolroll running in the background? (Y/n)</Text></Box>;
      case "build":
        return (
          <Box flexDirection="column" borderStyle="single" paddingX={1}>
            <Text bold>Build approves exactly this:</Text>
            {screen.terms.terms.map((line, index) => <SafeText key={index}>{`${line.label}: ${line.words}`}</SafeText>)}
          </Box>
        );
      case "compose": {
        const project = snapshot?.projects[screen.project] ?? null;
        return (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>{screen.purpose === "new" ? "New task" : "What should change?"}</Text>
            {screen.purpose === "new" && project !== null ? <SafeText dimColor>{`In ${project}`}</SafeText> : null}
            <Text><SafeText>{screen.text}</SafeText><Text inverse> </Text></Text>
          </Box>
        );
      }
      case "approve":
        return (
          <Box flexDirection="column" borderStyle="single" paddingX={1}>
            <SafeText bold>{`Approve this plan? ${screen.task.title}`}</SafeText>
            {screen.task.plan!.lines.map((line, index) => <SafeText key={index}>{line}</SafeText>)}
          </Box>
        );
      case "task": {
        const { task } = screen;
        const question = task.decisions[0];
        return (
          <Box flexDirection="column" borderStyle="single" paddingX={1}>
            <SafeText bold>{task.title}</SafeText>
            <SafeText>{`${task.status}${task.detail === "" ? "" : ` · ${task.detail}`}`}</SafeText>
            {task.plan === null ? null : <Text>A plan waits for your approval (a).</Text>}
            {(task.ready?.length ?? 0) === 0 ? null : <Box flexDirection="column" marginTop={1}>{task.ready!.map((line, index) => <SafeText key={index} {...(index === 0 ? { bold: true } : {})}>{line}</SafeText>)}</Box>}
            {question === undefined ? null : (
              <Box flexDirection="column" marginTop={1}>
                <SafeText bold>{question.question}</SafeText>
                {question.options.map((option, index) => <SafeText key={option.id}>{`${index + 1}  ${option.label}`}</SafeText>)}
              </Box>
            )}
            {live.length === 0 ? null : <Box flexDirection="column" marginTop={1}>{live.slice(-12).map((line, index) => <SafeText key={index} dimColor>{line}</SafeText>)}</Box>}
          </Box>
        );
      }
      default:
        if (snapshot === null) return <Text dimColor>Loading…</Text>;
        if (rows.length === 0) {
          return (
            <Box flexDirection="column" borderStyle="single" paddingX={1}>
              <Text bold>Get to your first result</Text>
              {(setup?.lines ?? ["No tasks yet. Press n to write one."]).map((line, index) => <SafeText key={index}>{line}</SafeText>)}
            </Box>
          );
        }
        return (
          <Box>
            <Box flexDirection="column" width="45%" borderStyle="single" paddingX={1}>
              {rows.map((row, index) => (
                <Fragment key={row.id}>
                  {index === 0 || rows[index - 1]!.group !== row.group ? <Text bold>{groupHeading(row)}</Text> : null}
                  <Text inverse={row === current} wrap="truncate-end">
                    {row === current ? "> " : "  "}<SafeText>{row.title}</SafeText> <SafeText {...(row.needsYou ? { bold: true } : { dimColor: true })}>{row.status}</SafeText>
                  </Text>
                </Fragment>
              ))}
            </Box>
            <Box flexDirection="column" flexGrow={1} borderStyle="single" paddingX={1}>
              {current === undefined ? <Text dimColor>Nothing selected</Text> : (
                <>
                  <SafeText bold wrap="truncate-end">{current.title}</SafeText>
                  <SafeText>{`${current.status}${current.detail === "" ? "" : ` · ${current.detail}`}`}</SafeText>
                  {live.length === 0 ? <Text dimColor>{current.liveRunId === null ? "No agent is working on it now." : "Waiting for output…"}</Text>
                    : live.slice(-12).map((line, index) => <SafeText key={index} dimColor wrap="truncate-end">{line}</SafeText>)}
                </>
              )}
            </Box>
          </Box>
        );
    }
  }
}
