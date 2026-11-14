/**
 * The terminal UI (easy-start plan E): this computer's tasks, what each agent is doing now, and the everyday acts.
 *
 * Screens: Setup (the welcome's steps, until the first task), Main (tasks | live output | what needs you), New task,
 * Task, the plan before approving it, the result before accepting it, a revision's words, and Needs password. Keys:
 * j/k move, Enter opens, n new task, a approve (the full plan first) or accept (the result first), c accept, b send back,
 * r retry, p ask for a plan, s stop (on Setup with no project: the sample project), 1–9 answer a question, w browser,
 * ? help, q quit. Every write goes through the TuiSource, which runs
 * it as the local owner; a refusal shows its own words.
 */
import { keyWords, SHORTCUTS, type TuiShortcut } from "../keymap.js";
import { Box, Text, useApp, useInput, type Key } from "ink";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { terminalText } from "../terminal-text.js";
import { HOME_GROUP_LABEL, HOME_GROUPS } from "../home-groups.js";
import type { TuiAct, TuiExit, TuiFastTerms, TuiResult, TuiRow, TuiSession, TuiSetup, TuiSnapshot, TuiSource, TuiTask } from "./data.js";

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
  /** Retry this build? The build and approved plan as read when it opened (what the yes names). */
  | { kind: "retry"; task: TuiTask; retry: { runId: number; digest: string } }
  /** Accept this result? The result as read when it opened (its build and receipt are what the answer names); `reason`:
   * an exception's words being typed; `changed`: the result changed meanwhile, and this is the new one. */
  | { kind: "accept"; result: TuiResult; reason: string; changed: boolean }
  | { kind: "compose"; purpose: "new" | "revise"; id: string | null; text: string; project: number }
  | { kind: "build"; terms: TuiFastTerms; text: string; repo: string | null }
  | { kind: "password"; message: string }
  | { kind: "help" }
  | { kind: "quit" }
  | { kind: "background" };

/** The keys (keymap.ts is the one table the console shares): its keys as this screen does them, then the terminal's own. */
const TUI_SAYS: Readonly<Record<TuiShortcut, string>> = {
  new: "new task", ink: "approve the plan (shows it in full first)", "send-back": "send the result back",
  retry: "retry", plan: "ask for a plan", list: "back to the task list", help: "these keys",
};
export const HELP_LINES = [
  "j / k or ↑ / ↓   move",
  "Enter            open the task",
  // Keys that do the same thing here share one line ("g then h, g then t": both are this list).
  ...[...SHORTCUTS.filter(one => typeof one.tui === "string").reduce((acts, one) => acts.set(one.tui as TuiShortcut, [...acts.get(one.tui as TuiShortcut) ?? [], keyWords(one.keys)]), new Map<TuiShortcut, string[]>())]
    .flatMap(([tui, keys]) => [`${keys.join(", ").padEnd(15)}  ${TUI_SAYS[tui]}`, ...tui === "ink" ? ["c                accept the result (shows it first)"] : []]),
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

/** With the Toolroll this terminal started stopped, a task never reads Planning or Building (nothing plans or builds it),
 * and nothing runs on it. */
export function honestRow<T extends { status: string; detail: string; liveRunId: number | null }>(row: T, stopped: boolean): T {
  if (!stopped || (row.status !== "Planning" && row.status !== "Building")) return row;
  return { ...row, status: "Waiting", detail: "Toolroll's background worker isn't running.", liveRunId: null };
}

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
  // The Toolroll this terminal started, stopped on its own: the session knows at once (easy-start.ts).
  const [stopped, setStopped] = useState<string | null>(() => session.stopped?.() ?? null);
  const seen = useRef<number | null>(null);
  const ticks = useRef(0);
  const ended = useRef(false);

  const rows: readonly TuiRow[] = inHomeOrder(snapshot?.rows ?? []).map(row => honestRow(row, stopped !== null));
  const current: TuiRow | undefined = rows[Math.min(selected, Math.max(rows.length - 1, 0))];

  const refresh = useCallback(async () => {
    const next = await source.snapshot();
    setSnapshot(next);
    if (next.rows.length === 0) setSetup(await source.setup());
  }, [source]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => {
      const said = session.stopped?.() ?? null;
      setStopped(before => (before === said ? before : said));
      ticks.current += 1;
      const now = source.changed();
      if (now !== seen.current || ticks.current % 5 === 0) {
        seen.current = now;
        void refresh();
      }
    }, pollMs);
    return () => clearInterval(timer);
  }, [source, session, refresh, pollMs]);
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
  const act = async (one: TuiAct, working = "Working…"): Promise<boolean> => {
    setBusy(working);
    try {
      const result = await source.act(one);
      if (!result.ok) {
        if (result.needsPassword) setScreen({ kind: "password", message: result.message });
        else setMessage(result.message);
        return false;
      }
      setMessage(result.message);
      await refresh();
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
  /** `c`, and `a` on a result: the result, read once and pinned, before anything is accepted. */
  const reviewResult = async (id: string, changed = false) => {
    const result = await source.result(id);
    if (result === null) { setMessage("This task has no finished result to accept."); return; }
    setScreen({ kind: "accept", result, reason: "", changed });
  };
  /** `a`: the task's own ink act — its plan (shown in full first), or else its finished result (shown first too). */
  const approveOrAccept = (id: string) => openTask(id, task => {
    if (task.plan !== null) setScreen({ kind: "approve", task });
    else if (task.hasResult) void reviewResult(id);
    else setMessage("No plan or result is waiting for you on this task.");
  });
  /** The answer on the Accept screen: exactly the result it shows. A result that changed meanwhile is shown again, new. */
  const accept = async (result: TuiResult, checked: boolean, reason: string | null) => {
    setBusy("Working…");
    let answer;
    try { answer = await source.act({ kind: "complete", id: result.id, runId: result.runId, digest: result.digest, checked, reason }); } finally { setBusy(null); }
    // l1: the login-item question waits for the first accepted result (or quitting): it never interrupts a first task.
    if (answer.ok) { setMessage(answer.message); setScreen(session.shouldAskBackground() ? { kind: "background" } : { kind: "main" }); await refresh(); return; }
    if (answer.changed === true) { setScreen({ kind: "main" }); setMessage("This result changed while you were reading it. Nothing was accepted."); await reviewResult(result.id, true); return; }
    if (answer.needsPassword) setScreen({ kind: "password", message: answer.message });
    else { setMessage(answer.message); setScreen({ kind: "main" }); }
  };
  /** `r`: the build to retry, read once and pinned, before anything is sent. */
  const askRetry = (id: string) => openTask(id, task => {
    if (task.retry == null) setMessage("Nothing to retry on this task.");
    else setScreen({ kind: "retry", task, retry: task.retry });
  });
  /** `p`: a plan for the task, bound to the planning source read now; the command refuses one that changed meanwhile. */
  const askPlan = (id: string) => openTask(id, task => {
    if (task.planAsk == null) setMessage("This task can't be planned now.");
    else void act({ kind: "plan", id, source: task.planAsk.source });
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
    if (input === "r") { void askRetry(id); return true; }
    if (input === "c") { void reviewResult(id); return true; }
    if (input === "p") { void askPlan(id); return true; }
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
        // Setup with no project yet: s adds the sample project (the same act as the browser's Try a sample project).
        if (input === "s" && rows.length === 0 && setup?.sample === true) { void act({ kind: "sample" }, "Adding the sample project…"); return; }
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
      case "retry": {
        if (key.escape || input === "n") { setScreen({ kind: "main" }); setMessage("Nothing retried."); return; }
        if (input === "y") { const { task, retry } = screen; void act({ kind: "retry", id: task.id, runId: retry.runId, digest: retry.digest }).then(() => setScreen(now => now.kind === "retry" ? { kind: "main" } : now)); }
        return;
      }
      case "accept": {
        const { result } = screen;
        const cancel = () => { setScreen({ kind: "main" }); setMessage("Nothing accepted."); };
        if (key.escape) { cancel(); return; }
        if (!result.ready || result.owed !== "exception") {
          if (input === "w") { browser(); return; }
          if (!result.ready) { if (input === "n" || input === "q") cancel(); return; }
          if (input === "n") { cancel(); return; }
          if (input === "y") void accept(result, result.owed === "person-check", null);
          return;
        }
        // An exception: its reason, typed on the screen; Enter accepts with it (never with nothing said).
        if (key.backspace || key.delete) { setScreen({ ...screen, reason: screen.reason.slice(0, -1) }); return; }
        if (key.return) { const reason = screen.reason.trim(); if (reason !== "") void accept(result, false, reason); return; }
        const more = typed(input);
        if (more !== "") setScreen({ ...screen, reason: screen.reason + more });
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
        // Eight W2: no is the default (Enter); only y adds the login item.
        const yes = input === "y" || input === "Y";
        if (!yes && input !== "n" && input !== "N" && !key.return) return;
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

  // A stopped worker is said in place of anything that would claim progress ("Filed. Planning…").
  const footer = busy ?? stopped ?? message;
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold>Toolroll</Text>
        {snapshot?.needsYou ? <SafeText bold>{snapshot.needsYou}</SafeText> : <Text dimColor>Nothing needs you</Text>}
        {snapshot?.learning ? <SafeText dimColor>{snapshot.learning}</SafeText> : null}
      </Box>
      {body()}
      {footer === null ? null : <SafeText {...(busy === null && stopped !== null ? { bold: true } : {})}>{footer}</SafeText>}
      <Text dimColor>{hints()}</Text>
    </Box>
  );

  function hints(): string {
    switch (screen.kind) {
      case "main": return rows.length === 0 ? `${setup?.sample === true ? "s sample project · " : ""}n new task · w browser · ? help · q quit` : "j/k move · Enter open · n new · a approve/accept · b send back · r retry · p plan · s stop · w browser · ? help · q quit";
      case "task": return `a approve/accept · b send back · r retry${screen.task.planAsk == null ? "" : " · p plan it"} · s stop · 1–9 answer · w browser · Esc back`;
      case "approve": return "y approve · Esc cancel";
      case "retry": return "y retry · Esc cancel";
      case "accept": return !screen.result.ready ? "w open in the browser · Esc back"
        : screen.result.owed === "person-check" ? "y yes, it looks right · n no · w open in the browser · Esc cancel"
        : screen.result.owed === "exception" ? "Enter accept · Esc cancel" : "y accept · w open in the browser · Esc cancel";
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
            <Text>b  Keep running, and start when you log in</Text>
          </Box>
        );
      case "background":
        return <Box borderStyle="single" paddingX={1}><Text bold>Start Toolroll when you log in, so tasks keep going? (y/N)</Text></Box>;
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
      case "accept": {
        const { result } = screen;
        return (
          <Box flexDirection="column" borderStyle="single" paddingX={1}>
            <SafeText bold>{`Accept this result? ${result.title}`}</SafeText>
            <SafeText dimColor>{`Build #${result.runId}`}</SafeText>
            {screen.changed ? <Text bold>This result changed while you were reading it. This is the new one.</Text> : null}
            {result.summary.length === 0 ? null : <Box flexDirection="column" marginTop={1}>{result.summary.map((line, index) => <SafeText key={index}>{line}</SafeText>)}</Box>}
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Changed files</Text>
              {result.files === null ? <Text>The changed files couldn't be read. Press w to see them in the browser.</Text>
                : result.files.names.length === 0 ? <Text>None.</Text>
                : <>{result.files.names.map(name => <SafeText key={name}>{`  ${name}`}</SafeText>)}{result.files.more > 0 ? <Text>{`  and ${result.files.more} more`}</Text> : null}</>}
            </Box>
            {result.requirements.length === 0 ? null : (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Requirements</Text>
                {result.requirements.map((one, index) => <SafeText key={index}>{`  ${one.word}: ${one.statement}`}</SafeText>)}
              </Box>
            )}
            {result.checks.length === 0 ? null : <Box flexDirection="column" marginTop={1}>{result.checks.map((line, index) => <SafeText key={index} {...(index === 0 ? { bold: true } : {})}>{line}</SafeText>)}</Box>}
            <Box flexDirection="column" marginTop={1}>
              {!result.ready ? <><Text bold>You can't accept it yet.</Text>{result.blockers.map((line, index) => <SafeText key={index}>{line}</SafeText>)}</>
                : result.owed === "person-check" ? <Text bold>Did you check it yourself? (y/n)</Text>
                : result.owed === "exception" ? <><Text bold>Say why you accept it anyway:</Text><Text><SafeText>{screen.reason}</SafeText><Text inverse> </Text></Text></>
                : <Text bold>Accept it and mark the task done? (y/n)</Text>}
            </Box>
          </Box>
        );
      }
      case "retry":
        return (
          <Box flexDirection="column" borderStyle="single" paddingX={1}>
            <SafeText bold>{`Retry build #${screen.retry.runId}? ${screen.task.title}`}</SafeText>
            <Text>Same plan, same agent. Its branch and workspace are kept.</Text>
          </Box>
        );
      case "approve":
        return (
          <Box flexDirection="column" borderStyle="single" paddingX={1}>
            <SafeText bold>{`Approve this plan? ${screen.task.title}`}</SafeText>
            {screen.task.plan!.lines.map((line, index) => <SafeText key={index}>{line}</SafeText>)}
          </Box>
        );
      case "task": {
        const task = honestRow(screen.task, stopped !== null);
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
