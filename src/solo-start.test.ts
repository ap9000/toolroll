/**
 * Solo's "Just code" (fast-start.ts SOLO_START_RULE; docs/plans/solo-workbench.md: until Flexible ships, solo's default
 * chain is "Just code", no plan approval). On a solo install a person's own filing of any size, Plan first not chosen,
 * is their approval of exactly the terms the form showed: an ordinary person approval, the mode derived again inside
 * the filing's transaction, the digest and summary key recorded. Protected work, spend caps and every other rule still
 * apply; Plan first and a team install keep today's approval. Isolated stores and temp repositories only.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { sizingOn } from "../test/sizing-on.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLocalMode, openStore, type Store } from "./store.js";
import { addApprover, approvalOf, approve, freshFacts, hashPassword, type FreshFacts } from "./scope.js";
import { register } from "./runner.js";
import { scopeApprovedForDispatch } from "./dispatch.js";
import { installFilingSizer } from "./task-sizing.js";
import { fastStartBuild, prepareFastStart, SOLO_START_ACTION, type FastVia, type PasswordFacts } from "./fast-start.js";
import { fastTermsLines } from "./fast-terms.js";
import { approvalSummaryOf, summaryContextOf } from "./approval-summary.js";
import { asLocalOwner } from "./local-owner.js";
import { soloNow } from "./install-mode.js";

const NOW = new Date("2026-11-15T12:00:00.000Z");
/** Broad enough that the description itself says "plan first": never a small change, and no classifier is asked. */
const BIG = "Refactor the checkout flow across the payments and orders modules";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();

let dir: string, REPO: string, store: Store, dropSizer: () => void;
/** The form's facts on a solo install's own browser session: no password field. */
const FACTS: PasswordFacts = { passwordless: true, localOwner: false, freshAt: null, returnTo: "/" };
const liveSession = (name = "owner"): FreshFacts => ({ actor: name, local: true, allowlisted: false, live: () => true, passwordAt: () => null, ssoReauthAt: () => null, ssoNow: () => null,
  consumeSsoNow: () => () => {}, floor: () => 0, stamp: () => {} });

function world(kind: "solo" | "team" | "laptop"): Store {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-solo-start-")));
  REPO = join(dir, "shop");
  mkdirSync(REPO);
  git(REPO, "init", "-q", "-b", "main");
  writeFileSync(join(REPO, "footer.txt"), "hello\n");
  git(REPO, "add", ".");
  git(REPO, "commit", "-q", "-m", "first");
  const s = openStore(join(dir, "orders.db"));
  sizingOn(s);
  if (kind === "solo") expect(s.bootstrapApproverIfNone("owner", hashPassword("owner-password-1"), NOW)).toEqual({ ok: true });
  else if (kind === "team") expect(addApprover(s, "owner", NOW).ok).toBe(true);
  else expect(initLocalMode(s, { owner: "owner", fenceAvailable: true, now: NOW })).toMatchObject({ ok: true });
  for (const phase of ["build", "plan", "review"] as const) s.setPhaseConfig("installation", phase, "claude", "sonnet", "owner", NOW);
  s.upsertProject(REPO, "shop", NOW);
  register(s, { name: "worker", host: "fixture", capacity: 4, repos: [REPO], now: NOW, newToken: () => "tok" });
  return s;
}
beforeEach(() => { dropSizer = installFilingSizer(async () => ({ size: "small", risky: false, reason: "one word" })); });
afterEach(() => { dropSizer(); store.close(); rmSync(dir, { recursive: true, force: true }); });

const prepare = (title = BIG, extra: Partial<Parameters<typeof prepareFastStart>[1]> = {}, via: Exclude<FastVia, "chat"> = "console") =>
  freshFacts.run(liveSession(), () => prepareFastStart(store, { actor: "owner", repo: REPO, title, via, password: FACTS, ...extra }, NOW));
/** Build on the person's own live session with nothing typed: the solo road. */
const press = (preview: string, digest: string, via: FastVia = "console") => freshFacts.run(liveSession(), () => fastStartBuild(store, { preview, digest, actor: "owner", via, password: FACTS,
  approveNow: (taskId, saw, fast) => approve(store, taskId, "owner", NOW, saw, "", {}, fast) }, NOW));
const taskOfPreview = (preview: string) => String(store.handle.prepare("SELECT task_id FROM fast_preview WHERE id = ?").get(preview)!["task_id"]);

describe("on a solo install, filing with Just code is the approval", () => {
  test("task sizing off (the default): Just code still builds any size as the person chose, with no model call and no word of planning", async () => {
    store = world("solo");
    store.handle.prepare("DELETE FROM task_sizing_setting").run();
    dropSizer();
    let asked = 0;
    dropSizer = installFilingSizer(async () => { asked += 1; return { size: "small", risky: false, reason: "one word" }; });
    for (const title of [BIG, "Fix the typo in footer.txt"]) {
      const shown = await prepare(title);
      if (!shown.eligible) throw new Error(shown.reason);
      const words = fastTermsLines(store, shown.scope, REPO).map(one => `${one.label} ${one.words}`).join("\n");
      expect(words, title).not.toContain("Planned first");
      expect(words, title).not.toContain("Sized by");
      expect(press(shown.preview, shown.digest).ok, title).toBe(true);
    }
    expect(asked).toBe(0);
  });

  test("any size: shows the terms and their cost first, then files and approves exactly them, recorded with the digest and summary key", async () => {
    store = world("solo");
    const shown = await prepare();
    if (!shown.eligible) throw new Error(shown.reason);
    // What the person reads before Build: the approval summary's lines, cost included.
    const terms = fastTermsLines(store, shown.scope, REPO);
    expect(terms.map(one => one.label).join(" ")).toMatch(/cost|budget|spend/i);
    const built = press(shown.preview, shown.digest);
    if (!built.ok) throw new Error(built.message);
    const scope = store.getScope(built.taskId)!;
    expect(approvalOf(scope).approved).toBe(true);
    expect(scope.approvedBy).toBe("owner");
    expect(scope.approvedDigest).toBe(shown.digest);
    // An ordinary person approval: none of the small change's backstops (no fast marker, no start window).
    const ref = store.lookupRef(built.taskId)!;
    expect(store.handle.prepare("SELECT fast_start_at FROM task_ref WHERE id = ?").get(ref.id)!["fast_start_at"]).toBeNull();
    expect(scopeApprovedForDispatch(store, ref.id, NOW)).toBe(true);
    const recorded = store.handle.prepare("SELECT actor, outcome, detail FROM action_ledger WHERE action = ? AND task_id = ?").get(SOLO_START_ACTION, built.taskId)!;
    expect(recorded).toMatchObject({ actor: "owner", outcome: "approved" });
    expect(JSON.parse(String(recorded["detail"]))).toEqual({ v: 1, rule: "solo-v1", digest: shown.digest, terms: approvalSummaryOf(scope, summaryContextOf(store, built.taskId, scope, NOW)).key, via: "console" });
  });

  test("a small change keeps the small start and its backstops", async () => {
    store = world("solo");
    const shown = await prepare("Fix the typo in the footer");
    if (!shown.eligible) throw new Error(shown.reason);
    const built = press(shown.preview, shown.digest);
    if (!built.ok) throw new Error(built.message);
    expect(store.handle.prepare("SELECT fast_start_at FROM task_ref WHERE external_id = ?").get(built.taskId)!["fast_start_at"]).not.toBeNull();
    expect(store.handle.prepare("SELECT count(*) AS n FROM action_ledger WHERE action = ?").get(SOLO_START_ACTION)!["n"]).toBe(0);
  });

  test("a laptop's local owner: Build on the terms is its approve-plan act", async () => {
    store = world("laptop");
    expect(soloNow(store)).toBe(true);
    const owner = { account: "owner", localGeneration: 1, accountGeneration: store.accountOf("owner")!.generation, transport: "browser" as const, act: "build-now" as const, sessionHash: null, request: null };
    const facts: PasswordFacts = { passwordless: false, localOwner: true, freshAt: null, returnTo: "/" };
    const shown = await asLocalOwner(owner, () => prepareFastStart(store, { actor: "owner", repo: REPO, title: BIG, via: "console", password: facts }, NOW));
    if (!shown.eligible) throw new Error(shown.reason);
    const built = asLocalOwner(owner, () => fastStartBuild(store, { preview: shown.preview, digest: shown.digest, actor: "owner", via: "console", password: facts,
      approveNow: (taskId, saw, fast) => approve(store, taskId, "owner", NOW, saw, "", {}, fast) }, NOW));
    expect(built).toMatchObject({ ok: true });
  });
});

describe("what keeps today's approval", () => {
  test("Plan first chosen: no Just code", async () => {
    store = world("solo");
    expect(await prepare(BIG, { planFirst: true })).toEqual({ eligible: false, reason: "size" });
  });

  test("a team install: no Just code", async () => {
    store = world("team");
    expect(await prepare()).toEqual({ eligible: false, reason: "size" });
  });

  test("the install turned team between the form and Build: refused, nothing filed", async () => {
    store = world("solo");
    const shown = await prepare();
    if (!shown.eligible) throw new Error(shown.reason);
    store.saveApprover("robin", hashPassword("robin-password-1"), NOW);
    expect(press(shown.preview, shown.digest)).toMatchObject({ ok: false, reason: "team" });
    expect(store.getTask(taskOfPreview(shown.preview))).toBeNull();
  });

  test("protected work still needs Approve plan and its people rules", async () => {
    store = world("solo");
    store.setApprovalRules(REPO, { notRequester: false, protectProject: true, protectedPaths: [] }, "owner", NOW);
    expect(await prepare()).toEqual({ eligible: false, reason: "protected" });
  });

  test("a spend cap reached refuses it", async () => {
    store = world("solo");
    const held = vi.spyOn(store, "budgetGate").mockReturnValue((() => ({ over: { scope: "installation" } })) as never);
    expect(await prepare()).toEqual({ eligible: false, reason: "monthly" });
    held.mockRestore();
  });

  test("a chat start never takes the Just code road", async () => {
    store = world("solo");
    expect(await freshFacts.run(liveSession(), () => prepareFastStart(store, { actor: "owner", repo: REPO, title: BIG, via: "chat" as never, password: FACTS }, NOW))).toEqual({ eligible: false, reason: "rules" });
  });

  test("a preview row whose rule isn't one Toolroll writes is refused", async () => {
    store = world("solo");
    const shown = await prepare();
    if (!shown.eligible) throw new Error(shown.reason);
    store.handle.prepare("UPDATE fast_preview SET digest = digest || ' solo-v9' WHERE id = ?").run(shown.preview);
    expect(press(shown.preview, shown.digest)).toMatchObject({ ok: false, reason: "gone" });
  });
});
