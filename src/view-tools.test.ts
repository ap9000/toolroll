/** "Ask the agent to restyle my workbench": the lead's toolroll_view_read and toolroll_view_set, who may call them, the
 * ledger and rate limit, the CLI's undo, and (with the workbench binary built) a stand-in lead turn that reads then
 * sets through the real writer, so tui.toml changes. No model is called. */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, existsSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { executeLeadTool, LEAD_TOOLS, findLeadTools, type LeadToolContext } from "./lead-tools.js";
import { GATEWAY_TOOL_INPUTS } from "./contracts/gateway-tools.js";
import { detailShown } from "./action-ledger.js";
import { VIEW_UNCERTAIN_WORDS } from "./lead-tools.js";
import { binaryViewRunner, runViewCommand, viewAllowedFor, viewAnswerOf, VIEW_CHANGES_PER_MINUTE, VIEW_LEDGER_ACTION, type ViewAnswer, type ViewRunner, type ViewVerb } from "./view-tools.js";

const T0 = new Date("2026-11-16T12:00:00.000Z");
const BIN = new URL("../tui/target/debug/toolroll-tui", import.meta.url).pathname;
const RELEASE = new URL("../tui/target/release/toolroll-tui", import.meta.url).pathname;

describe("the lead restyles the person's own workbench", () => {
  let store: Store, who: VerifiedApprover;
  let calls: { verb: ViewVerb; input?: string }[];
  const fake: ViewRunner = (verb, input) => {
    calls.push({ verb, ...(input === undefined ? {} : { input }) });
    if (verb === "read") return { ok: true, body: { settings: { theme: "dark" }, allowed: {}, roles: [{ role: "ink", colours: "text" }], themes: { built_in: ["dark"], saved: [] }, guide: "Keys can't be changed here." } };
    return { ok: true, body: { changed: ["theme: dark → sumi"] } };
  };
  const ctx = (extra: Partial<LeadToolContext> = {}, now = T0): LeadToolContext => ({ store, who, now, step: 1, readDecisions: new Map(), draft: () => null, ...extra });
  /** This person's workbench history, oldest first, each detail parsed. */
  const history = () => store.handle.prepare("SELECT id, actor, action, outcome, source, detail FROM action_ledger WHERE action = ? ORDER BY id").all(VIEW_LEDGER_ACTION)
    .map(row => ({ id: Number(row["id"]), actor: row["actor"], action: row["action"], outcome: row["outcome"], source: row["source"], detail: JSON.parse(String(row["detail"])) as Record<string, unknown> }));

  beforeEach(() => {
    store = openStore(":memory:");
    store.saveApprover("alex", "h".repeat(64), T0);
    const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, []);
    if (!verified.ok) throw new Error(verified.reason);
    who = verified.who;
    calls = [];
  });
  afterEach(() => store.close());

  test("without the person's own conversation on this computer, both tools refuse and nothing runs", () => {
    for (const name of ["toolroll_view_read", "toolroll_view_set"]) {
      const result = executeLeadTool(ctx(), name, name === "toolroll_view_set" ? { theme: "dark" } : {});
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.message).toMatch(/person's own conversation in the console on this computer/);
    }
    expect(calls).toEqual([]);
  });

  test("read then set: the change goes to the workbench's own writer, and the ledger keeps what changed", () => {
    const read = executeLeadTool(ctx({ view: fake }), "toolroll_view_read", {});
    expect(read.ok && (read.body as Record<string, unknown>)["guide"]).toBe("Keys can't be changed here.");
    const set = executeLeadTool(ctx({ view: fake }), "toolroll_view_set", { save_theme: { name: "sumi", base: "dark", colors: { ink: "#ece6d8" }, use: true } });
    expect(set.ok).toBe(true);
    expect(calls.map(one => one.verb)).toEqual(["read", "set"]);
    expect(JSON.parse(calls[1]!.input!)).toEqual({ save_theme: { name: "sumi", base: "dark", colors: { ink: "#ece6d8" }, use: true } });
    const rows = history();
    expect(rows.map(one => [one.actor, one.action, one.outcome, one.source])).toEqual([["alex", VIEW_LEDGER_ACTION, "pending", "request"], ["alex", VIEW_LEDGER_ACTION, "done", "request"]]);
    // Reserved first with the whole change, then finished naming it.
    expect(rows[0]!.detail).toEqual({ change: { save_theme: { name: "sumi", base: "dark", colors: { ink: "#ece6d8" }, use: true } } });
    expect(rows[1]!.detail).toEqual({ pending: rows[0]!.id, changed: ["theme: dark → sumi"] });
  });

  test("keys are refused, as are unknown settings and bad values, before anything runs", () => {
    const keys = executeLeadTool(ctx({ view: fake }), "toolroll_view_set", { keys: { accept: "x" } });
    expect(keys.ok ? "" : keys.message).toMatch(/Keys can't be changed by an agent/);
    const unknown = executeLeadTool(ctx({ view: fake }), "toolroll_view_set", { bell: false });
    expect(unknown.ok ? "" : unknown.message).toMatch(/toolroll_view_set takes/);
    for (const bad of [{ theme: "Dark Mode!" }, { theme: "\u001b]52;c;x" }, { colors: { ink: "red" } }, { colors: { sparkle: "#ffffff" } }, { density: "huge" }, { save_theme: { name: "x".repeat(40), base: "dark" } }]) {
      expect(executeLeadTool(ctx({ view: fake }), "toolroll_view_set", bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  test(`at most ${VIEW_CHANGES_PER_MINUTE} changes a minute, counted in the ledger`, () => {
    for (let i = 0; i < VIEW_CHANGES_PER_MINUTE; i++) expect(executeLeadTool(ctx({ view: fake }, new Date(T0.getTime() + i * 1000)), "toolroll_view_set", { density: "compact" }).ok).toBe(true);
    const over = executeLeadTool(ctx({ view: fake }, new Date(T0.getTime() + 20_000)), "toolroll_view_set", { density: "compact" });
    expect(over.ok ? "" : over.message).toMatch(/in a minute/);
    expect(executeLeadTool(ctx({ view: fake }, new Date(T0.getTime() + 61_000)), "toolroll_view_set", { density: "compact" }).ok).toBe(true);
  });

  test("a refusal from the workbench (contrast) is said in its words; the history holds it as failed, and it doesn't count", () => {
    const contrast: ViewRunner = verb => verb === "set" ? { ok: false, why: "The colour for text (#202020) can't be used: it would be too faint on the background." } : fake(verb);
    const result = executeLeadTool(ctx({ view: contrast }), "toolroll_view_set", { colors: { ink: "#202020" } });
    expect(result.ok ? "" : result.message).toMatch(/too faint/);
    const rows = history();
    expect(rows.map(one => one.outcome)).toEqual(["pending", "failed"]);
    expect(rows[1]!.detail).toMatchObject({ pending: rows[0]!.id, why: expect.stringMatching(/too faint/) });
    for (let i = 0; i < VIEW_CHANGES_PER_MINUTE; i++) expect(executeLeadTool(ctx({ view: fake }, new Date(T0.getTime() + 1000 + i)), "toolroll_view_set", { density: "compact" }).ok).toBe(true);
  });

  test("the whole change is kept (no 300-character cut), stored as JSON; a page shows its start", () => {
    const colors = Object.fromEntries(["paper", "ink", "muted", "line", "selection", "selection-ink", "ground", "raised", "fill"].map((role, i) => [role, `#${String(i).repeat(6)}`]));
    const change = { save_theme: { name: "a-rather-long-theme-name-kept", base: "dark", colors, use: true }, density: "comfortable", glyphs: "ascii", columns: ["agent", "step", "age", "cost", "project"] };
    expect(JSON.stringify(change).length).toBeGreaterThan(300);
    expect(executeLeadTool(ctx({ view: fake }), "toolroll_view_set", change).ok).toBe(true);
    const [pending] = history();
    expect(pending!.detail).toEqual({ change });
    const raw = String(store.handle.prepare("SELECT detail FROM action_ledger WHERE id = ?").get(pending!.id)?.["detail"]);
    expect(detailShown(raw).length).toBe(300);
    expect(detailShown(raw).endsWith("…")).toBe(true);
  });

  test("no answer (the response lost): the change is uncertain, never inferred from the file; a later write doesn't settle it, and it keeps counting", () => {
    let lose = true;
    const flaky: ViewRunner = (verb, input) => {
      calls.push({ verb, ...(input === undefined ? {} : { input }) });
      if (verb === "set" && lose) return { ok: false, why: "the terminal workbench didn't answer", unsure: true };
      if (verb === "set") return { ok: true, body: { changed: ["glyphs → ascii"] } };
      // The file now even shows the lost change: still not proof it was that write.
      return { ok: true, body: { settings: { theme: "dark", density: "compact" }, colors: {}, themes: { built_in: [], saved: [] } } };
    };
    const lost = executeLeadTool(ctx({ view: flaky }), "toolroll_view_set", { density: "compact" });
    expect(lost.ok ? "" : lost.message).toMatch(/may or may not have applied/);
    let rows = history();
    expect(rows.map(one => one.outcome)).toEqual(["pending", "uncertain"]);
    expect(rows[1]!.detail).toMatchObject({ pending: rows[0]!.id, said: VIEW_UNCERTAIN_WORDS });
    // A different write lands; reads come and go: the lost one stays uncertain.
    lose = false;
    expect(executeLeadTool(ctx({ view: flaky }, new Date(T0.getTime() + 1_000)), "toolroll_view_set", { glyphs: "ascii" }).ok).toBe(true);
    expect(executeLeadTool(ctx({ view: flaky }, new Date(T0.getTime() + 2_000)), "toolroll_view_read", {}).ok).toBe(true);
    rows = history();
    expect(rows.map(one => one.outcome)).toEqual(["pending", "uncertain", "pending", "done"]);
    // It still counts: with it, eight more fill the minute.
    for (let i = 0; i < VIEW_CHANGES_PER_MINUTE - 2; i++) expect(executeLeadTool(ctx({ view: flaky }, new Date(T0.getTime() + 3_000 + i)), "toolroll_view_set", { glyphs: "ascii" }).ok).toBe(true);
    const over = executeLeadTool(ctx({ view: flaky }, new Date(T0.getTime() + 30_000)), "toolroll_view_set", { glyphs: "ascii" });
    expect(over.ok ? "" : over.message).toMatch(/in a minute/);
  });

  test("a change left pending by a crash (no final word at all) is marked uncertain once the writer's time is long past", () => {
    const silent: ViewRunner = () => ({ ok: true, body: { settings: {}, colors: {}, themes: { built_in: [], saved: [] } } });
    // A crash between reserving and finishing: only the pending row exists.
    store.handle.prepare("INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source,detail) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(T0.toISOString(), "alex", null, null, null, VIEW_LEDGER_ACTION, "pending", "request", JSON.stringify({ change: { density: "compact" } }));
    executeLeadTool(ctx({ view: silent }, new Date(T0.getTime() + 5_000)), "toolroll_view_read", {});
    expect(history().map(one => one.outcome)).toEqual(["pending"]);
    executeLeadTool(ctx({ view: silent }, new Date(T0.getTime() + 120_000)), "toolroll_view_read", {});
    expect(history().map(one => one.outcome)).toEqual(["pending", "uncertain"]);
  });

  test("uncertain changes count toward the limit as done ones do", () => {
    const silent: ViewRunner = () => ({ ok: false, why: "the terminal workbench didn't answer", unsure: true });
    for (let i = 0; i < VIEW_CHANGES_PER_MINUTE; i++) executeLeadTool(ctx({ view: silent }, new Date(T0.getTime() + i * 1000)), "toolroll_view_set", { density: "compact" });
    expect(history().filter(one => one.outcome === "uncertain")).toHaveLength(VIEW_CHANGES_PER_MINUTE);
    const over = executeLeadTool(ctx({ view: silent }, new Date(T0.getTime() + 20_000)), "toolroll_view_set", { density: "compact" });
    expect(over.ok ? "" : over.message).toMatch(/in a minute/);
  });

  test("the lead finds them by what the person asks; a task's agents and tokens never see them", () => {
    expect(findLeadTools("restyle the workbench theme").map(one => one.name)).toEqual(expect.arrayContaining(["toolroll_view_read", "toolroll_view_set"]));
    expect(LEAD_TOOLS.map(one => one.name)).toEqual(expect.arrayContaining(["toolroll_view_read", "toolroll_view_set"]));
    // The MCP gateway (a person's agent with a token, and a task's agents) has neither.
    expect(Object.keys(GATEWAY_TOOL_INPUTS).filter(name => name.startsWith("toolroll_view"))).toEqual([]);
  });

  test("who may: a browser session from this computer, as its local owner or the one person of a single-person install", () => {
    const base = { via: "cookie", name: "alex", fromThisComputer: true, approvers: ["alex"] };
    expect(viewAllowedFor(base)).toBe(true);
    expect(viewAllowedFor({ ...base, approvers: ["alex", "sam"] })).toBe(false);
    expect(viewAllowedFor({ ...base, approvers: ["alex", "sam"], authority: "local-owner" })).toBe(true);
    expect(viewAllowedFor({ ...base, fromThisComputer: false })).toBe(false);
    expect(viewAllowedFor({ ...base, fromThisComputer: false, authority: "local-owner" })).toBe(false);
    expect(viewAllowedFor({ ...base, via: "bearer" })).toBe(false);
    expect(viewAllowedFor({ ...base, name: "sam" })).toBe(false);
  });

  test("the CLI's undo: theme set and reset, with the same runner", async () => {
    const lines: string[] = [];
    const ran: { verb: ViewVerb; input?: string }[] = [];
    const runner: ViewRunner = (verb, input) => { ran.push({ verb, ...(input === undefined ? {} : { input }) }); return verb === "reset" ? { ok: true, body: { said: "Back to the defaults; the previous file is tui.toml.bak." } } : { ok: true, body: { changed: ["theme: sumi → dark"] } }; };
    expect(await runViewCommand(["theme", "set", "dark"], line => lines.push(line), runner)).toBe(0);
    expect(await runViewCommand(["reset"], line => lines.push(line), runner)).toBe(0);
    expect(await runViewCommand(["theme", "set", "Bad Name"], line => lines.push(line), runner)).toBe(2);
    expect(ran).toEqual([{ verb: "set", input: JSON.stringify({ theme: "dark" }) }, { verb: "reset" }]);
    expect(lines.slice(0, 2)).toEqual(["theme: sumi → dark", "Back to the defaults; the previous file is tui.toml.bak."]);
  });

  test("the workbench's answer is read as JSON only", () => {
    expect(viewAnswerOf('{"ok":true,"changed":["a"]}')).toEqual({ ok: true, body: { ok: true, changed: ["a"] } } satisfies ViewAnswer);
    expect(viewAnswerOf('{"ok":false,"why":"no"}')).toEqual({ ok: false, why: "no" });
    expect(viewAnswerOf("garbage").ok).toBe(false);
  });

  // With the workbench binary built (cargo build): the same road production takes, against a home of its own.
  test.skipIf(!existsSync(BIN))("the binary directly: a stand-in lead turn reads then sets through the real writer; tui.toml changes, keys and faint colours don't", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "tr-view-")));
    try {
      chmodSync(home, 0o700);
      const real: ViewRunner = (verb, input) => {
        try {
          return viewAnswerOf(execFileSync(BIN, ["view", verb], { input: input ?? "", encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: home }, timeout: 10_000 }));
        } catch (error) {
          return viewAnswerOf(String((error as { stdout?: unknown }).stdout ?? ""));
        }
      };
      const read = executeLeadTool(ctx({ view: real }), "toolroll_view_read", {});
      expect(read.ok).toBe(true);
      expect(String((read.ok ? read.body : {} as Record<string, unknown>) && (read.body as Record<string, unknown>)["guide"])).toMatch(/Keys can't be changed here/);
      const set = executeLeadTool(ctx({ view: real }), "toolroll_view_set", { save_theme: { name: "sumi", base: "dark", colors: { paper: "#1b1a17", ink: "#ece6d8" }, use: true } });
      expect(set.ok, set.ok ? "" : set.message).toBe(true);
      const file = join(home, ".config", "toolroll", "tui.toml");
      const text = readFileSync(file, "utf8");
      expect(text).toContain('theme = "sumi"');
      expect(text).toContain("[themes.sumi]");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const faint = executeLeadTool(ctx({ view: real }), "toolroll_view_set", { colors: { ink: "#202020" } });
      expect(faint.ok ? "" : faint.message).toMatch(/too faint/);
      expect(readFileSync(file, "utf8")).toBe(text);
      // A hostile layout: a folder above the file others can change. The writer refuses; the file stays.
      chmodSync(join(home, ".config"), 0o777);
      expect(executeLeadTool(ctx({ view: real }), "toolroll_view_set", { theme: "light" }).ok).toBe(false);
      chmodSync(join(home, ".config"), 0o700);
      expect(readFileSync(file, "utf8")).toBe(text);
      // Undo from the CLI's road: the defaults, the old file kept.
      expect(real("reset").ok).toBe(true);
      // Kept beside it under a readable, timestamped name (tui.toml.bak-2026-11-17T00-37-37).
      const backups = readdirSync(join(home, ".config", "toolroll")).filter(name => /^tui\.toml\.bak-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(name));
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(home, ".config", "toolroll", backups[0]!), "utf8")).toBe(text);
      mkdirSync(join(home, "x"));
      writeFileSync(join(home, "x", "y"), "");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Production's own road: binaryViewRunner picks the binary as `toolroll` does (tui-launch's chooseTuiBinary: this
  // checkout's release build, its self-check and contract, its identity rechecked before it runs), with only HOME given.
  test.skipIf(!existsSync(RELEASE))("through the production chooser: binaryViewRunner finds this checkout's release build, checks it, and writes tui.toml", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "tr-view-prod-")));
    try {
      chmodSync(home, 0o700);
      const runner = binaryViewRunner({ HOME: home, PATH: "/usr/bin:/bin" });
      const read = runner("read");
      expect(read.ok, read.ok ? "" : read.why).toBe(true);
      const set = executeLeadTool(ctx({ view: runner }), "toolroll_view_set", { theme: "light", key_bar: true });
      expect(set.ok, set.ok ? "" : set.message).toBe(true);
      const file = join(home, ".config", "toolroll", "tui.toml");
      expect(readFileSync(file, "utf8")).toContain('theme = "light"');
      const off = executeLeadTool(ctx({ view: runner }), "toolroll_view_set", { notifications: { asks: false } });
      expect(off.ok ? "" : off.message).toMatch(/Turning that off is yours to do: Settings, or tui\.toml/);
      expect(history().map(one => one.outcome)).toEqual(["pending", "done", "pending", "failed"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
