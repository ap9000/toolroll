/** The product-copy vocabulary (docs/plans/plain-toolroll.md P1.1): one rule table of renderers × seeded fixture states.
 * Every person- or agent-authored field holds a sentinel full of banned words; the visible text of each surface (plus
 * aria-label, title and placeholder) with exactly the sentinel spans removed is product copy, and holds no word from
 * plain-words.ts. A second rule: each sentinel renders byte-identical where it is shown (preserved content is never
 * rewritten). Real HTTP against an ephemeral port over a seeded throwaway store; the CLI and the chat cards read the
 * same store. */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type Server } from "node:http";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { createDecisionServer } from "./serve.js";
import { checkAssignmentAsOperator, assignmentOf } from "./assignment.js";
import { verifyApproverStanding } from "./principal.js";
import { decideOffer, DECIDE_LABELS, type DecideTarget } from "./chat-decide.js";
import { buildPushPayload, PUSH_WORDS } from "./push.js";
import { runOperate } from "./operate.js";
import { HELP } from "./cli-help.js";
import { setChatApproval } from "./chat-approval.js";
import { PLAIN_WORDS, bannedWordsIn } from "./plain-words.js";
import { RUN_REASON_WORDS, NEEDS, WAITS } from "./needs-you.js";
import type { BrowserWorkspace } from "./browser-workspace.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const REPO = "/repos/storefront";

/** Sentinels: what a person or an agent wrote. Each holds banned words and must render unchanged. */
const S = {
  title: "Fix footer «scope digest sealed lease»",
  goal: "Make the footer link work «worker runner custody verdict»",
  requirement: "The footer link opens «receipt proof caveat binds»",
  handoff: "Changed the footer «incident regate carried attested»",
} as const;
const SENTINELS = Object.values(S);
const SENTINEL_CORES = SENTINELS.map(one => /«[^»]+»/.exec(one)![0]);

let dir: string, file: string, store: Store, server: Server, base: string, password: string, cookie: string;
const runs: Record<string, number> = {};

function filed(id: string, at: Date, approved = true): number {
  store.createTask({ id, title: `${S.title} ${id}` }, at);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO, {}, at);
  const proposed = propose(store, { taskId: id, goal: S.goal, touches: ["src/footer.ts"], acceptance: [{ id: "c1", statement: S.requirement, how: null, evidence: ["check"] }], now: at });
  if (approved) {
    const ok = approve(store, id, "sam", at, proposed.digest, password);
    if (!ok.ok) throw new Error(ok.reason);
  }
  return ref;
}

function started(id: string, at: Date): number {
  const ref = filed(id, at);
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `toolroll/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: at });
  runs[id] = run;
  store.stampRun(run, { scopeDigest: store.getScope(id)!.digest, baseRevision: "1".repeat(40) });
  return run;
}

function built(id: string, at: Date, kind: "verified" | "refuted" | "short" | "failed" = "verified"): number {
  const run = started(id, at);
  if (kind === "failed") {
    store.finishRun(run, { outcome: "failed", reason: "agent", now: at });
    store.setTaskState(id, "failed", at);
    return run;
  }
  const head = (run + 10).toString(16).padStart(2, "0").repeat(20);
  store.recordOutcomeFacts(run, { headRevision: head, handoff: S.handoff });
  store.finishRun(run, { outcome: "built", committed: true, now: at });
  store.setTaskState(id, "done", at);
  const reasons = kind === "refuted" ? ["claimed changed path not in the sealed diff: src/other.ts", `criterion "c1" requires check evidence, which the proof does not reference`]
    : kind === "short" ? [`criterion "c1" requires manual-review evidence — an operator must accept it before this can verify`] : [];
  store.saveProofVerdict(run, kind, reasons, at, [{ id: "c1", statement: S.requirement, requiredEvidence: ["check"], state: kind === "verified" ? "pass" : kind === "short" ? "manual-review" : "failed", detail: kind === "refuted" ? ["no check reference"] : [], answered: [], review: null }] as never, kind);
  storeEvidence(store, dir, run, "terminal-diff", "diff.patch", Buffer.from(`diff --git a/src/footer.ts b/src/footer.ts\n--- a/src/footer.ts\n+++ b/src/footer.ts\n@@ -1 +1 @@\n-a\n+b\n`), "git diff (exit 0)", at, { captureStatus: "ok" });
  storeEvidence(store, dir, run, "check-log", "checks.txt", Buffer.from("12 passed\n"), "npm test", at, { captureStatus: "ok" });
  sealVerificationReceipt(store, dir, run, head, store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: 0 }, at);
  return run;
}

/** The visible words of a page: text plus aria-label, title and placeholder, without scripts, styles or tags. */
function visibleText(html: string): string {
  const attributes = [...html.matchAll(/\s(?:aria-label|title|placeholder)="([^"]*)"/g)].map(match => match[1]);
  const text = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ");
  return decode([text, ...attributes].join(" \n ")).replace(/\s+/g, " ");
}
function decode(text: string): string {
  return text.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16))).replace(/&#([0-9]+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
/** Product copy: the text with exactly the sentinel spans removed. */
const productCopy = (text: string): string => SENTINEL_CORES.reduce((all, core) => all.split(core).join(" "), text);
/** The banned words left in a surface's product copy, each with a little context. */
function offences(text: string): string[] {
  const copy = productCopy(text);
  const found: string[] = [];
  for (const word of PLAIN_WORDS) {
    const global = new RegExp(word.pattern.source, "gi");
    for (const match of copy.matchAll(global)) found.push(`${word.never}: …${copy.slice(Math.max(0, match.index! - 50), match.index! + match[0].length + 30).replace(/\s+/g, " ")}…`);
  }
  if (found.length > 0 && process.env["PLAIN_WORDS_OUT"]) appendFileSync(process.env["PLAIN_WORDS_OUT"], `${found.join("\n")}\n----\n`);
  return found;
}

/** Node's own HTTP (the page environment's fetch is a browser's). */
function http(path: string, init: { method?: string; body?: string; cookie?: string } = {}): Promise<{ status: number; body: string; setCookie: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method: init.method ?? "GET", headers: { ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(init.body) }) } }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, setCookie: String(res.headers["set-cookie"]?.[0] ?? "") }));
    });
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

function workspaceOf(html: string): BrowserWorkspace {
  const json = /<script type="application\/json" id="standing-orders-workspace-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (json === undefined) throw new Error(`no workspace: ${(html.match(/<script[^>]*>/g) ?? []).join(" ")}`);
  return JSON.parse(json) as BrowserWorkspace;
}
/** The browser views, which render the page from its workspace. */
let app: typeof import("./browser/views/index.js") | null = null;
async function browserApp(): Promise<typeof import("./browser/views/index.js")> {
  app ??= await import("./browser/views/index.js");
  return app;
}
/** A console page as a person sees it: the server's own markup, and the app rendered from its workspace. */
async function consolePage(path: string): Promise<string> {
  const response = await http(path, { cookie });
  expect(response.status, path).toBe(200);
  const html = response.body;
  const workspace = workspaceOf(html);
  // A view reads the page's address while it renders.
  (globalThis as Record<string, unknown>)["window"] ??= { location: new URL(base) };
  const app = workspace.view === null ? "" : renderToStaticMarkup(createElement((await browserApp()).ViewHost, { view: workspace.view, csrf: "c", workspace }));
  if (process.env["PLAIN_WORDS_DUMP"]) appendFileSync(process.env["PLAIN_WORDS_DUMP"], `==== ${path}\n${html}\n==== app\n${app}\n`);
  return visibleText(`${html.replace(/<script type="application\/json"[\s\S]*?<\/script>/, "")} ${app}`);
}

async function cli(argv: string[]): Promise<string> {
  const lines: string[] = [];
  await runOperate(argv[0]!, [...argv.slice(1), "--db", file], line => { lines.push(line); }, { now: NOW });
  if (process.env["PLAIN_WORDS_DUMP"]) appendFileSync(process.env["PLAIN_WORDS_DUMP"], `==== ${argv.join(" ")}\n${lines.join("\n")}\n`);
  return lines.join("\n");
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "plain-words-"));
  file = join(dir, "state.db");
  store = openStore(file);
  register(store, { name: "builder-1", host: "test", capacity: 4, repos: [REPO], now: NOW, newToken: () => "tok-builder-1" });
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", ago(900));
  const sam = addApprover(store, "sam", ago(900));
  if (!sam.ok) throw new Error("approver");
  password = sam.token;
  store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 300_000, approvedBy: "sam" }, ago(900));
  if (!setChatApproval(store, { approver: "sam", scope: REPO, enabled: true, limits: { fullAccess: true, capMicrousd: null }, via: "test" }, ago(900)).ok) throw new Error("chat approval");
  filed("plan-draft", ago(70), false);
  filed("approved", ago(65));
  filed("edited", ago(64));
  propose(store, { taskId: "edited", goal: `${S.goal} again`, touches: ["src/footer.ts"], acceptance: [{ id: "c1", statement: S.requirement, how: null, evidence: ["check"] }], now: ago(63) });
  started("building", ago(60));
  built("failed", ago(50), "failed");
  built("ready", ago(40));
  built("accepted", ago(30));
  built("refuted", ago(28), "refuted");
  built("short", ago(27), "short");
  const who = verifyApproverStanding(store, "sam", store.accountOf("sam")!.generation, [REPO]);
  if (!who.ok) throw new Error("who");
  const receipt = assignmentOf(store, "accepted", NOW, { principal: "operator", repos: [REPO] }, dir)!.receipt!;
  const done = checkAssignmentAsOperator(store, "accepted", receipt.digest, who.who, ago(20), dir);
  if (!done.ok) throw new Error(JSON.stringify(done));

  server = createDecisionServer({ store, evidenceRoot: dir, repo: REPO, clock: () => NOW });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
  const login = await http("/login", { method: "POST", body: new URLSearchParams({ name: "sam", token: password }).toString() });
  cookie = login.setCookie.split(";")[0]!;
  if (!cookie) throw new Error(`login ${login.status} ${login.body.slice(0, 300)}`);
});

afterAll(async () => {
  if (server !== undefined) await new Promise<void>(done => server.close(() => done()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Renderer × state: where it is read, and which sentinels it shows (each must appear byte-identical). */
type Row = { surface: string; read: () => Promise<string>; shows?: readonly string[] };
const page = (path: string, shows: readonly string[] = []): Row => ({ surface: path, read: () => consolePage(path), shows });
const ROWS: Row[] = [
  page("/t/plan-draft", [`${S.title} plan-draft`, S.goal, S.requirement]),
  page("/t/approved", [`${S.title} approved`, S.goal]),
  page("/t/edited", [`${S.title} edited`]),
  page("/t/building", [`${S.title} building`]),
  page("/t/failed", [`${S.title} failed`]),
  page("/t/ready", [`${S.title} ready`]),
  page("/t/accepted", [`${S.title} accepted`]),
  page("/t/refuted", [`${S.title} refuted`]),
  page("/t/short", [`${S.title} short`]),
  page("/", []),
  page("/tasks"),
  page("/tasks?view=needs-you"),
  page("/tasks?view=board"),
  page("/settings"),
];

describe("product copy says no banned word; preserved content renders unchanged", () => {
  for (const row of ROWS) {
    test(row.surface, async () => {
      const text = await row.read();
      expect(offences(text).join("\n"), row.surface).toBe("");
      for (const shown of row.shows ?? []) expect(text, `${row.surface} shows ${shown}`).toContain(shown);
    });
  }

  test("result pages", async () => {
    for (const id of ["ready", "accepted", "refuted", "short"]) {
      const text = await consolePage(`/review?result=${id}&run=${runs[id]}`);
      expect(offences(text).join("\n"), id).toBe("");
      expect(text, id).toContain(S.handoff);
    }
  });

  test("chat cards (one builder for the four chat apps)", () => {
    const who = verifyApproverStanding(store, "sam", store.accountOf("sam")!.generation, [REPO]);
    if (!who.ok) throw new Error("who");
    const targets: DecideTarget[] = [{ kind: "plan", taskId: "plan-draft" }, { kind: "result", taskId: "ready", run: runs["ready"]! }, { kind: "failed", taskId: "failed" }];
    for (const channel of ["telegram", "slack", "discord", "teams"] as const) for (const target of targets) {
      const offer = decideOffer(store, target, who.who, NOW, channel, dir);
      expect(offer, `${channel} ${target.kind}`).not.toBeNull();
      const labels = offer!.rows.flat().map(one => "act" in one ? one.label ?? DECIDE_LABELS[one.act as keyof typeof DECIDE_LABELS] ?? "" : one.label);
      expect(offences([offer!.text ?? "", ...labels].join("\n")).join("\n"), `${channel} ${target.kind}`).toBe("");
    }
  });

  test("push payloads", () => {
    for (const pushClass of Object.keys(PUSH_WORDS) as (keyof typeof PUSH_WORDS)[]) {
      const payload = JSON.parse(buildPushPayload({ id: 1, pushClass, link: null, body: "", run: null } as never)) as { title: string; body: string };
      expect(offences(`${payload.title} ${payload.body}`).join("\n"), pushClass).toBe("");
    }
  });

  test("Needs you, Waiting and stop reasons", () => {
    const words = [...Object.values(NEEDS).flatMap(need => [need.sentence({ build: 4, provider: "Claude" }), need.action.label]),
      ...Object.values(WAITS).map(wait => wait({ build: 4 })), ...Object.values(RUN_REASON_WORDS)];
    expect(offences(words.join("\n")).join("\n")).toBe("");
  });

  test("CLI people output", async () => {
    expect(offences(HELP).join("\n"), "toolroll --help").toBe("");
    for (const argv of [["task", "list"], ["task", "show", "plan-draft"], ["task", "show", "ready"], ["task", "show", "accepted"], ["task", "show", "failed"], ["task", "show", "refuted"], ["task", "show", "short"], ["status"], ["pulls"]]) {
      const text = await cli(argv);
      expect(offences(text).join("\n"), argv.join(" ")).toBe("");
    }
  });
});

describe("the table", () => {
  test("whole words only: ordinary words that contain a banned one pass", () => {
    expect(bannedWordsIn("Please release the lease")).toEqual(["lease"]);
    expect(bannedWordsIn("Please release it, then sign in again; you signed in at noon")).toEqual([]);
    expect(bannedWordsIn("Checks passed on 3f2a9c1")).toEqual([]);
    expect(bannedWordsIn("Approving signs plan version 3f2a9c1b04de")).toEqual(["signs", "version hex"]);
  });
});

describe("the terminal UI's frames", () => {
  test("the list, a task, its plan and the key list say no banned word; the title and goal show unchanged", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdirSync, realpathSync } = await import("node:fs");
    const { cleanup, render } = await import("ink-testing-library");
    const { vi } = await import("vitest");
    const { App } = await import("./tui/app.js");
    const { createTuiSource } = await import("./tui-source.js");
    const { saveRepos } = await import("./repos.js");
    const { initLocalMode } = await import("./store.js");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plain-words-tui-")));
    const laptop = join(root, "state.db"), repo = join(root, "shop");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    await saveRepos(join(root, "repos.json"), [repo]);
    const seeded = openStore(laptop, { createdBy: "laptop" });
    try {
      if (!initLocalMode(seeded, { owner: "alex", fenceAvailable: true, now: NOW }).ok) throw Error("local mode");
      for (const phase of ["plan", "build", "review"] as const) seeded.setPhaseConfig("installation", phase, "claude", "sonnet", "fixture", NOW);
      const made = seeded.createConsoleTask({ id: "one", title: S.title, repo, goal: S.goal, acceptance: [{ id: "c1", statement: S.requirement, evidence: ["manual-review"] }], filedVia: "cli" }, NOW);
      if (!made.ok) throw Error(made.reason);
      propose(seeded, { now: NOW, taskId: "one", goal: S.goal });
    } finally { seeded.close(); }
    const source = createTuiSource({ databaseFile: laptop, operate: { now: NOW }, check: async () => ({ state: "connected" as const, mode: "subscription" as const, checkedAt: NOW.toISOString() }) });
    const session = { owned: () => false, openBrowser: async () => "", shouldAskBackground: () => false, answerBackground: async () => "" };
    const app = render(createElement(App, { source, session, pollMs: 50 }));
    const frames: string[] = [];
    const shows = async (text: string) => { await vi.waitFor(() => expect(app.lastFrame()).toContain(text), { timeout: 15_000 }); frames.push(app.lastFrame() ?? ""); };
    const settle = () => new Promise(resolve => setTimeout(resolve, 30));
    try {
      await shows(`> ${S.title}`);
      await settle();
      app.stdin.write("\r");
      await shows(S.title);
      app.stdin.write("\u001b");
      await settle();
      app.stdin.write("a");
      await shows(S.goal);
      app.stdin.write("\u001b");
      await settle();
      app.stdin.write("?");
      await shows("quit");
    } finally { cleanup(); source.close(); rmSync(root, { recursive: true, force: true }); }
    for (const frame of frames) expect(offences(frame).join("\n"), frame).toBe("");
  }, 60_000);
});
