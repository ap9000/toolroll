import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { runLeadCli } from "./lead-cli.js";
import type { SubscriptionLeadRequest, SubscriptionLeadRunner } from "./subscription-chat.js";
import { displayWidth, LIVE_TERMINAL_ROWS, startTerminalLive, wrapRows, type TerminalLiveOutput } from "./lead-cli-live.js";
import type { LeadProgress } from "./lead-progress.js";

const T0 = new Date("2026-11-08T12:00:00.000Z");

/** A terminal that records every write; resize and Ctrl-C on demand. */
function fakeTerminal(columns = 40, log: string[] = []) {
  let width = columns;
  const resized = new Set<() => void>();
  const interrupted = new Set<() => void>();
  const out: TerminalLiveOutput = {
    write: chunk => { log.push(chunk); },
    columns: () => width,
    onResize: listener => { resized.add(listener); return () => { resized.delete(listener); }; },
    onInterrupt: listener => { interrupted.add(listener); return () => { interrupted.delete(listener); }; },
    dim: true,
  };
  return {
    out, log,
    resize(to: number) { width = to; for (const listener of resized) listener(); },
    interrupt() { for (const listener of [...interrupted]) listener(); },
    listening: () => resized.size + interrupted.size,
  };
}

/** Only these cursor and style sequences are Toolroll's own: back to the line start, up N rows, clear below, dim on/off. */
const OWN = /\r|\x1b\[\d+A|\x1b\[J|\x1b\[2m|\x1b\[22m/g;
/** Anything else a terminal would act on: C0 (but newline) and C1 controls, bidi overrides, invisible format characters. */
const FOREIGN = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]|\p{Cf}/u;
/** A frame's rows as drawn: its erase and dim styling taken off. */
const rowsOf = (chunk: string): string[] => chunk.replace(/^\r(?:\x1b\[\d+A)?\x1b\[J/, "").replace(/\x1b\[2m|\x1b\[22m/g, "").split("\n");
const drained = () => new Promise<void>(resolve => setImmediate(resolve));

/** Model text that tries every trick: OSC 52 (clipboard), an OSC 8 hyperlink, screen clearing, a carriage return over
 * the line, a bidi override, an 8-bit CSI and a bell. */
const HOSTILE = "Here is the plan. \x1b]52;c;c2VjcmV0\x07 copied, then \x1b]8;;https://evil.example/\x1b\\click me\x1b]8;;\x1b\\ and \x1b[2J\x1b[H cleared\rOVERWRITE \u202Egnp.exe\u202C done \x9b31m red \x07bell. The guard holds now. ";

describe("toolroll chat in a terminal (responsive chat slice 4)", () => {
  let dir: string;
  let file: string;
  let repo: string;
  let store: Store;
  let token: string;
  let requests: SubscriptionLeadRequest[];

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-chat-term-")));
    file = join(dir, "orders.db");
    repo = join(dir, "repo");
    mkdirSync(repo);
    requests = [];
    store = openStore(file);
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    token = added.token;
    store.setChatConfig({ provider: "claude-subscription", model: "default", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, "alex", T0);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  const answering = (text: string): SubscriptionLeadRunner => async request => {
    requests.push(request);
    return { ok: true, answer: { text, calls: [], tokensIn: 10, tokensOut: 5, reportedCostMicrousd: null } };
  };
  const chat = async (json: boolean, runner: SubscriptionLeadRunner): Promise<string[]> => {
    const lines: string[] = [];
    await runLeadCli({ store, databaseFile: file, write: line => lines.push(line), json, credentials: { name: "alex", token }, repos: [repo], say: "How is the payout guard going?", end: false, ceilingUsd: undefined, seams: { subscriptionRunner: runner, clock: () => T0 } });
    return lines;
  };

  test("piped and --json output are byte-identical to before, and no live text is asked for", async () => {
    const plain = await chat(false, answering("The payout guard is built and waiting for your review."));
    expect(requests.at(-1)?.onText).toBeUndefined();
    const json = await chat(true, answering("Still building: the limit check is next."));
    expect(requests.at(-1)?.onText).toBeUndefined();
    const failedPlain = await chat(false, async () => ({ ok: false, problem: "the harness stopped" }));
    const failedJson = await chat(true, async () => ({ ok: false, problem: "the harness stopped" }));
    const markdown = await chat(false, answering("**Done.** See [the guide](https://example.com/guide) and `npm test`.\n\nNext: the limit check."));
    expect({ plain, json, failedPlain, failedJson, markdown }).toMatchInlineSnapshot(`
      {
        "failedJson": [
          "{"command":"chat","ok":false,"turn":4,"reason":"provider-error","unknownSpend":false,"message":"The chat provider couldn't answer; its sign-in may have expired. Nothing was kept. Sign in to it again on this computer, then send your message again."}",
        ],
        "failedPlain": [
          "lead conversation live: subscription usage (no dollar limit) — live until you end it",
          "The chat provider couldn't answer; its sign-in may have expired. Nothing was kept. Sign in to it again on this computer, then send your message again.",
        ],
        "json": [
          "{"command":"chat","ok":true,"turn":2,"reply":"Still building: the limit check is next.","activity":"read 0 · proposed 0 · 1 step","steps":1,"settledMicrousd":0,"proposals":[]}",
        ],
        "markdown": [
          "lead conversation live: subscription usage (no dollar limit) — live until you end it",
          "  read 0 · proposed 0 · 1 step",
          "Done. See example.com (https://example.com/guide) and \`npm test\`.

      Next: the limit check.",
        ],
        "plain": [
          "lead conversation started: subscription usage (no dollar limit) over repo — live until you end it",
          "  read 0 · proposed 0 · 1 step",
          "The payout guard is built and waiting for your review.",
        ],
      }
    `);
  });

  test("no escape, control or bidi character from model text ever reaches the terminal, wherever a chunk splits it", async () => {
    for (let at = 0; at <= HOSTILE.length; at += 1) {
      const term = fakeTerminal(60);
      const live = startTerminalLive(term.out, {}, { spacingMs: 0 });
      const events: LeadProgress[] = [
        { kind: "started", turn: 1 }, { kind: "step", turn: 1, step: 1 },
        { kind: "text", turn: 1, step: 1, text: HOSTILE.slice(0, at) },
        { kind: "text", turn: 1, step: 1, text: HOSTILE },
        { kind: "text", turn: 1, step: 1, text: HOSTILE, final: true },
      ];
      for (const event of events) { live.progress(event); await drained(); }
      await live.finish();
      const shown = term.log.join("").replace(OWN, "");
      expect(FOREIGN.test(shown), `split at ${at}: ${JSON.stringify(shown)}`).toBe(false);
      expect(shown.replace(/\n/g, " ")).toContain("click me");
      expect(shown.replace(/\n/g, " ")).toContain("The guard holds now.");
    }
  });

  test("rows wrap by display width (wide, emoji, combining, flags) and the block never passes the status line plus six rows", async () => {
    expect([displayWidth("日本"), displayWidth("👍🏽"), displayWidth("e\u0301"), displayWidth("🇯🇵"), displayWidth("abc")]).toEqual([4, 2, 1, 2, 3]);
    for (const row of wrapRows("日本語のテキストは二列を使います 👍🏽 café e\u0301 🇯🇵 and a verylongwordthatmustbreakmidway here", 12)) expect(displayWidth(row)).toBeLessThanOrEqual(12);
    expect(wrapRows("one two three", 7)).toEqual(["one two", "three"]);
    expect(wrapRows("  indented\n\nnext", 20)).toEqual(["  indented", "", "next"]);
    const term = fakeTerminal(21);
    const live = startTerminalLive(term.out, {}, { spacingMs: 0 });
    const long = Array.from({ length: 30 }, (_, index) => `第${index}行 the payout 👍🏽 guard`).join(" ") + " ";
    live.progress({ kind: "text", turn: 1, step: 1, text: long });
    await drained();
    await live.finish();
    const frames = term.log.filter(chunk => !/^\r(?:\x1b\[\d+A)?\x1b\[J$/.test(chunk));
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (const frame of frames) {
      const rows = rowsOf(frame);
      expect(rows.length).toBeLessThanOrEqual(1 + LIVE_TERMINAL_ROWS);
      for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(18);
    }
    // The newest words show: the block is the reply's tail.
    expect(rowsOf(frames.at(-1)!).join(" ")).toContain("第29行");
  });

  test("a resize redraws at the new width, erasing the old block as the terminal rewrapped it", async () => {
    const term = fakeTerminal(40);
    const live = startTerminalLive(term.out, {}, { spacingMs: 0 });
    live.progress({ kind: "text", turn: 1, step: 1, text: "The payout guard refuses an over-limit payout and records why it refused. " });
    await drained();
    const before = rowsOf(term.log.at(-1)!);
    term.resize(16);
    await drained();
    const after = term.log.at(-1)!;
    const height = before.reduce((sum, row) => sum + Math.max(1, Math.ceil(displayWidth(row) / 16)), 0);
    expect(after.startsWith(`\r\x1b[${height - 1}A\x1b[J`)).toBe(true);
    for (const row of rowsOf(after)) expect(displayWidth(row)).toBeLessThanOrEqual(13);
    await live.finish();
    expect(term.listening()).toBe(0);
  });

  test("Ctrl-C erases the block and says Stopped.; nothing draws after it", async () => {
    const term = fakeTerminal(40);
    const live = startTerminalLive(term.out, {}, { spacingMs: 0 });
    live.progress({ kind: "text", turn: 1, step: 1, text: "Reading the payout guard now and then " });
    await drained();
    const rows = rowsOf(term.log.at(-1)!).length;
    term.interrupt();
    expect(term.log.at(-1)).toBe(`\r\x1b[${rows - 1}A\x1b[JStopped.\n`);
    const count = term.log.length;
    live.progress({ kind: "text", turn: 1, step: 1, text: "Reading the payout guard now and then more words " });
    term.resize(30);
    await drained();
    await live.finish();
    expect(term.log.length).toBe(count);
    expect(term.listening()).toBe(0);
  });

  test("on a terminal: the status shows at once, the answer streams in place, then the block is erased before the filtered final", async () => {
    const log: string[] = [];
    const term = fakeTerminal(60, log);
    const streaming: SubscriptionLeadRunner = async request => {
      requests.push(request);
      request.onText?.("The payout guard ");
      await drained();
      request.onText?.(HOSTILE);
      await drained();
      return { ok: true, answer: { text: HOSTILE, calls: [], tokensIn: 10, tokensOut: 5, reportedCostMicrousd: null } };
    };
    await runLeadCli({ store, databaseFile: file, write: line => log.push(`LINE:${line}`), json: false, credentials: { name: "alex", token }, repos: [repo], say: "How is the payout guard going?", end: false, ceilingUsd: undefined, liveTerminal: term.out, seams: { subscriptionRunner: streaming, clock: () => T0 } });
    const start = log.findIndex(entry => !entry.startsWith("LINE:"));
    const final = log.findIndex(entry => entry.startsWith("LINE:") && entry.includes("The guard holds now."));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(rowsOf(log[start]!)).toEqual(["Thinking…"]);
    expect(log.slice(start, final).some(entry => !entry.startsWith("LINE:") && entry.includes("The payout"))).toBe(true);
    const firstAfter = log.findIndex((entry, index) => index > start && entry.startsWith("LINE:"));
    expect(firstAfter).toBeLessThan(final);
    expect(log[firstAfter - 1]).toMatch(/^\r(?:\x1b\[\d+A)?\x1b\[J$/);
    expect(log.slice(firstAfter).every(entry => entry.startsWith("LINE:"))).toBe(true);
    // The final answer passes the same filter as the partials.
    for (const entry of log.filter(one => one.startsWith("LINE:"))) expect(FOREIGN.test(entry), entry).toBe(false);
    expect(log[final]).toContain("click me");
    expect(term.listening()).toBe(0);
  });

  test("revoked mid-turn: no project text is drawn after the revocation, and the preview clears", async () => {
    expect(addApprover(store, "robin", T0, { name: "alex", token })).toMatchObject({ ok: true });
    const log: string[] = [];
    const term = fakeTerminal(60, log);
    let revokedAt = -1;
    const revoking: SubscriptionLeadRunner = async request => {
      request.onText?.("The payout guard ");
      await drained();
      request.onText?.("The payout guard is ");
      await drained();
      expect(store.revokeAccount("alex", "robin", T0)).toMatchObject({ ok: true });
      revokedAt = log.length;
      request.onText?.("The payout guard is waiting on the ledger check today ");
      // Longer than the redraw spacing: a draw would have happened by now.
      await new Promise(resolve => setTimeout(resolve, 120));
      return { ok: true, answer: { text: "The payout guard is waiting on the ledger check today.", calls: [], tokensIn: 10, tokensOut: 5, reportedCostMicrousd: null } };
    };
    await runLeadCli({ store, databaseFile: file, write: line => log.push(`LINE:${line}`), json: false, credentials: { name: "alex", token }, repos: [repo], say: "How is the payout guard going?", end: false, ceilingUsd: undefined, liveTerminal: term.out, seams: { subscriptionRunner: revoking, clock: () => T0 } });
    expect(revokedAt).toBeGreaterThan(0);
    expect(log.slice(0, revokedAt).some(entry => !entry.startsWith("LINE:") && entry.includes("The payout"))).toBe(true);
    const after = log.slice(revokedAt).filter(entry => !entry.startsWith("LINE:"));
    expect(after.some(entry => entry.includes("ledger") || entry.includes("payout"))).toBe(false);
    // The block was erased, and the answer never printed.
    expect(after.at(-1)).toMatch(/^\r(?:\x1b\[\d+A)?\x1b\[J$/);
    expect(log.some(entry => entry.startsWith("LINE:") && entry.includes("ledger"))).toBe(false);
    expect(term.listening()).toBe(0);
  });

  test("a failed turn replaces the partial with its saved failure words", async () => {
    const log: string[] = [];
    const term = fakeTerminal(60, log);
    const failing: SubscriptionLeadRunner = async request => {
      request.onText?.("The payout guard is almost ");
      await drained();
      return { ok: false, problem: "the harness stopped" };
    };
    await runLeadCli({ store, databaseFile: file, write: line => log.push(`LINE:${line}`), json: false, credentials: { name: "alex", token }, repos: [repo], say: "How is the payout guard going?", end: false, ceilingUsd: undefined, liveTerminal: term.out, seams: { subscriptionRunner: failing, clock: () => T0 } });
    const failure = log.findIndex(entry => entry.startsWith("LINE:The chat provider couldn't answer"));
    expect(failure).toBeGreaterThan(0);
    expect(log.slice(0, failure).some(entry => !entry.startsWith("LINE:") && entry.includes("The payout guard is"))).toBe(true);
    expect(log[failure - 1]).toMatch(/^\r(?:\x1b\[\d+A)?\x1b\[J$/);
    expect(log.slice(failure + 1)).toEqual([]);
  });
});
