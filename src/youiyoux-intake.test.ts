/**
 * youiyoux change requests become tasks (youiyoux-intake.ts): each open change request is filed once and waits for a
 * person, whatever mode is live; outside files are read without following a link; the status beside a request is
 * written whole and never through a link. Fixture projects live in temp folders; nothing touches the network.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, propose } from "./scope.js";
import { shownTermsDigest } from "./chat-terms.js";
import { fileTaskProposal } from "./proposal.js";
import { applyModeToNewFiling } from "./plan-auto.js";
import { modeDigestOf, modeTermsJson, presetTerms } from "./modes.js";
import { admitProject } from "./project-admission.js";
import { readYouiyouxRequest, readYouiyouxRequestTask } from "./contracts/youiyoux-request.js";
import { fileYouiyouxRequest, requestPassOf, REQUEST_BYTES, runYouiyouxIntake, writeStatusFile, safeTouches, setYouiyouxIntake, youiyouxState } from "./youiyoux-intake.js";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const ID = "r-0123456789";
let base = "", repo = "", store: Store;
const io = () => ({ dir: base, env: {} as Record<string, string | undefined> });
const pass = (now = NOW) => runYouiyouxIntake(store, repo, now, io(), { force: true });
const requests = () => join(repo, ".youi", "requests");

type Request = Record<string, unknown> & { task?: Record<string, unknown> };
function request(id = ID, change: Partial<Request> = {}, task: Record<string, unknown> = {}): Request {
  return {
    schema: "youi.request/v1", id, project: "shop", kind: "change", status: "open", body: "Make the primary button calmer.",
    author: { kind: "person", name: "Rosa" }, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    target: { route: "/flows", scope: "element", name: "Button", file: "src/button.tsx", line: 12 },
    task: {
      title: "Calmer primary button on /flows", goal: "Use the secondary tone for the Save button on /flows. Run youiyoux check --diff.",
      touches: ["src/button.tsx"], touchesKnown: true, not: ["New dependencies, or changes to package manifests and lockfiles"],
      acceptance: [{ statement: "The Save button uses the secondary tone | not the primary", evidence: ["screenshot", "check"] }], ...task,
    },
    thread: [], ...change,
  };
}
const save = (name: string, body: unknown) => writeFileSync(join(requests(), name), typeof body === "string" ? body : JSON.stringify(body));
const filed = () => store.handle.prepare("SELECT request, task_id, note, status FROM youiyoux_request ORDER BY request").all().map(row => ({ ...row }));
const taskOf = (request = ID) => String(store.handle.prepare("SELECT task_id FROM youiyoux_request WHERE request = ?").get(request)?.["task_id"]);
const statusFile = (request = ID) => JSON.parse(readFileSync(join(requests(), `${request}.task.json`), "utf8")) as Record<string, unknown>;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "so-youiyoux-")));
  repo = join(base, "shop");
  mkdirSync(join(repo, ".youi", "requests"), { recursive: true });
  store = openStore(join(base, "orders.db"));
  store.upsertProject(repo, "shop", NOW);
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
});
afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("filing", () => {
  test("an open change request is filed once, with its scope, by the youiyoux automation, waiting for a person", () => {
    save(`${ID}.json`, request());
    expect(pass()).toMatchObject({ filed: 1, invalid: 0 });
    const id = taskOf();
    const scope = store.getScope(id)!;
    expect(scope.goal).toMatch(/^From youiyoux request r-0123456789 on \/flows\.\n\nUse the secondary tone/);
    expect(scope.outOfScope).toBe("- New dependencies, or changes to package manifests and lockfiles");
    expect(scope.touches).toEqual(["src/button.tsx"]);
    // The rubric's separator never survives into a statement; evidence kinds carry over as they are.
    expect(scope.acceptance).toEqual([{ id: "c1", statement: "The Save button uses the secondary tone / not the primary", how: null, evidence: ["screenshot", "check"] }]);
    expect(scope.approvedAt).toBeNull();
    expect(store.filedViaOf(id)).toBe("youiyoux");
    expect(store.lookupRef(id)!.plan).not.toBe("requested");
    // Never again: not on the next pass, not when the file changes, not when it is reopened.
    expect(pass(later(1))).toMatchObject({ filed: 0 });
    save(`${ID}.json`, request(ID, { updatedAt: later(2).toISOString() }, { title: "Something else entirely" }));
    expect(pass(later(2))).toMatchObject({ filed: 0 });
    expect(filed()).toEqual([{ request: ID, task_id: id, note: null, status: "needs-you" }]);
  });

  test("a pass says what it filed once: one card for all its tasks, and a later pass its own", () => {
    save(`${ID}.json`, request());
    save("r-1111111111.json", request("r-1111111111"));
    expect(pass().filed).toBe(2);
    const cards = () => store.handle.prepare("SELECT task_id, push_class, link, subject FROM notification WHERE kind = 'youiyoux-requests' ORDER BY id").all().map(row => ({ ...row }));
    expect(cards()).toEqual([{ task_id: taskOf(), push_class: "attention", link: "/work?view=needs-you", subject: "2 youiyoux change requests wait for your approval" }]);
    expect(requestPassOf(store, taskOf("r-1111111111"))).toEqual([taskOf(), taskOf("r-1111111111")]);
    expect(pass(later(1)).filed).toBe(0);
    expect(cards()).toHaveLength(1);
    save("r-2222222222.json", request("r-2222222222"));
    expect(pass(later(2)).filed).toBe(1);
    expect(cards().map(one => one["subject"])).toEqual(["2 youiyoux change requests wait for your approval", "A youiyoux change request waits for your approval"]);
    expect(requestPassOf(store, taskOf("r-2222222222"))).toEqual([taskOf("r-2222222222")]);
  });

  test("two passes that read the same request before either filed it make one task", () => {
    const read = readYouiyouxRequest(request());
    if (!read.ok) throw new Error("fixture");
    const second = openStore(join(base, "orders.db"));
    try {
      expect(fileYouiyouxRequest(store, repo, read.value, NOW)).toMatchObject({ made: "filed" });
      expect(fileYouiyouxRequest(second, repo, read.value, NOW)).toEqual({ made: "seen" });
    } finally { second.close(); }
    expect(store.handle.prepare("SELECT count(*) AS n FROM task_ref WHERE filed_via = 'youiyoux'").get()?.["n"]).toBe(1);
  });

  test.each([
    ["a comment", `${ID}.json`, request(ID, { kind: "comment" }), false],
    ["an addressed request", `${ID}.json`, request(ID, { status: "addressed" }), false],
    ["a closed request", `${ID}.json`, request(ID, { status: "closed" }), false],
    ["a change with no task", `${ID}.json`, (() => { const one = request(); delete one.task; return one; })(), false],
    ["an id that isn't the file's", `${ID}.json`, request("r-9999999999"), true],
    ["a file that isn't JSON", `${ID}.json`, "{ not json", true],
    ["a file that isn't a request", `${ID}.json`, { schema: "youi.request/v2", id: ID }, true],
    ["a task with no requirement", `${ID}.json`, request(ID, {}, { acceptance: [] }), true],
    ["a file over 64 KB", `${ID}.json`, JSON.stringify({ ...request(), padding: "x".repeat(REQUEST_BYTES) }), true],
    ["a name that isn't a request's", "r-ZZZZ.json", request(), false],
    ["a status file", `${ID}.task.json`, request(), false],
  ])("%s is never filed", (_what, name, body, counted) => {
    save(name, body);
    expect(pass()).toMatchObject({ filed: 0, invalid: counted ? 1 : 0 });
    expect(filed()).toEqual([]);
    expect(youiyouxState(store, repo).problem === null).toBe(!counted);
  });

  test.each([
    ["a link to a file outside the project", () => { writeFileSync(join(base, "outside.json"), JSON.stringify(request())); symlinkSync(join(base, "outside.json"), join(requests(), `${ID}.json`)); }],
    ["a second name for a file outside the project", () => { writeFileSync(join(base, "outside.json"), JSON.stringify(request())); linkSync(join(base, "outside.json"), join(requests(), `${ID}.json`)); }],
    ["a pipe", () => execFileSync("mkfifo", [join(requests(), `${ID}.json`)])],
  ])("%s is read as a file that can't be read, and nothing waits on it", (_what, make) => {
    make();
    expect(pass()).toMatchObject({ filed: 0, invalid: 1 });
    expect(filed()).toEqual([]);
  });

  test.each([
    [".youi", () => { renameSync(join(repo, ".youi"), join(base, "elsewhere")); symlinkSync(join(base, "elsewhere"), join(repo, ".youi")); }],
    [".youi/requests", () => { renameSync(requests(), join(base, "elsewhere")); symlinkSync(join(base, "elsewhere"), requests()); }],
  ])("a linked %s folder is never read", (_what, link) => {
    save(`${ID}.json`, request());
    link();
    expect(pass().filed).toBe(0);
    expect(filed()).toEqual([]);
    expect(youiyouxState(store, repo).problem).toMatch(/is a link/);
  });

  test("a folder that isn't one of Toolroll's projects is never read", () => {
    const stranger = join(base, "stranger");
    mkdirSync(join(stranger, ".youi", "requests"), { recursive: true });
    writeFileSync(join(stranger, ".youi", "requests", `${ID}.json`), JSON.stringify(request()));
    expect(runYouiyouxIntake(store, stranger, NOW, io(), { force: true }).filed).toBe(0);
    expect(filed()).toEqual([]);
  });

  test.each([
    ["the goal", {}, { goal: "Use this token: ghp_abcdefghijklmnopqrstuvwxyz0123456789 to deploy" }],
    ["a requirement", {}, { acceptance: [{ statement: "Signs in with AKIAIOSFODNN7EXAMPLE", evidence: ["check"] }] }],
    ["what it must not do", {}, { not: ["Never print sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD"] }],
    ["the route", { target: { route: "/x?key=AKIAIOSFODNN7EXAMPLE", scope: "here", name: "Page" } }, {}],
  ])("a key in %s is left out, once, and never filed later", (_where, change, task) => {
    save(`${ID}.json`, request(ID, change, task));
    expect(pass()).toMatchObject({ filed: 0, skipped: 1 });
    expect(filed()).toEqual([{ request: ID, task_id: null, note: "it looked like it held a key or password", status: null }]);
    save(`${ID}.json`, request());
    expect(pass(later(1)).filed).toBe(0);
    expect(store.handle.prepare("SELECT count(*) AS n FROM task_ref").get()?.["n"]).toBe(0);
  });
});

describe("touches", () => {
  test.each([
    [["src/a.ts", "src/b/c.tsx"], ["src/a.ts", "src/b/c.tsx"]],
    [["src/a.ts", "../outside.ts"], null],
    [["src/a.ts", "/etc/passwd"], null],
    [["src/a.ts", "C:\\\\x.ts"], null],
    [["src/a.ts", "a\u0000b"], null],
    [["src/a.ts", "src//b.ts"], null],
    [["src/a.ts", "~/x"], null],
    [["src/a.ts", "src/./../x"], null],
    [["x".repeat(201)], null],
  ])("%j → %j", (given, kept) => {
    expect(safeTouches(given)).toEqual(kept);
  });

  test.each([
    ["known and plain", { touchesKnown: true }, ["src/button.tsx"]],
    ["not known", { touchesKnown: false, why: "Every use of Button" }, []],
    ["one outside the project", { touches: ["src/button.tsx", "../../etc/hosts"] }, []],
  ])("a request whose paths are %s files with %j", (_what, task, touches) => {
    save(`${ID}.json`, request(ID, {}, task));
    expect(pass().filed).toBe(1);
    expect(store.getScope(taskOf())!.touches).toEqual(touches);
  });
});

describe("approval", () => {
  const signMode = () => {
    const terms = { ...presetTerms("hands-off", later(24 * 60).toISOString()), autoApproveFiling: true };
    const digest = modeDigestOf(terms);
    store.signMode({ repo, name: terms.name, termsJson: modeTermsJson(terms), digest, signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, NOW);
    return digest;
  };

  test("a live mode that approves its signer's filings approves the signer's own, never a request's; a person's chat tap may", () => {
    const digest = signMode();
    const own = fileTaskProposal(store, { title: "Alex's own", repo, goal: "Change one line", touches: ["src/a.ts"], acceptance: [{ id: "c1", statement: "it works", how: null, evidence: ["check"] }],
      filedVia: "console", filedBy: { name: "alex", kind: "person" }, planning: "skip" }, NOW);
    if (!own.ok) throw new Error(own.message);
    applyModeToNewFiling(store, own.id, "alex", NOW);
    expect(store.getScope(own.id)!.approvedAt).not.toBeNull();

    save(`${ID}.json`, request());
    expect(pass().filed).toBe(1);
    const id = taskOf();
    applyModeToNewFiling(store, id, "alex", NOW);
    // Approvals no person looked at never seal it.
    for (const kind of ["mode", "grant", "schedule", "auto-check", "auto-green"] as const) expect(store.sealScopeApproval(id, "alex", NOW, {}, { kind, modeDigest: digest }), kind).toBe(false);
    expect(store.getScope(id)!.approvedAt).toBeNull();
    // A person's own yes does: their ceremony, or their two taps in chat (chat-decide.ts decides when one is offered).
    expect(store.sealScopeApproval(id, "alex", NOW)).toBe(true);
  });

  test("a chat tap seals it only with the digest of every word the card showed, recomputed from the live terms", () => {
    save(`${ID}.json`, request());
    expect(pass().filed).toBe(1);
    const id = taskOf();
    const shown = shownTermsDigest(store.getScope(id)!);
    const tap = (card: { card?: "release" | "terms"; cardDigest?: string }) => store.sealScopeApproval(id, "alex", NOW, {}, { kind: "chat", modeDigest: "m".repeat(64), ...card });
    // No evidence, another card's kind, or words the card didn't show: nothing seals.
    expect(tap({})).toBe(false);
    expect(tap({ card: "release", cardDigest: shown })).toBe(false);
    expect(tap({ card: "terms", cardDigest: "0".repeat(64) })).toBe(false);
    // Terms changed after the card was drawn: the digest it carries is stale.
    const scope = store.getScope(id)!;
    propose(store, { taskId: id, goal: `${scope.goal}\nAlso delete the tests.`, outOfScope: scope.outOfScope, touches: scope.touches, acceptance: scope.acceptance, now: later(1) });
    expect(tap({ card: "terms", cardDigest: shown })).toBe(false);
    expect(store.getScope(id)!.approvedAt).toBeNull();
    // The card that showed these exact words seals, as the person's own chat yes.
    expect(tap({ card: "terms", cardDigest: shownTermsDigest(store.getScope(id)!) })).toBe(true);
    expect(store.getScope(id)).toMatchObject({ approvalBasis: "chat", approvedBy: "alex" });
  });
});

describe("the status beside the request", () => {
  test("written whole when filed, and again when the status changes; the request itself is never touched", () => {
    const text = JSON.stringify(request());
    save(`${ID}.json`, text);
    pass();
    const id = taskOf();
    expect(statusFile()).toEqual({ schema: "youi.request-task/v1", request: ID, runner: "Toolroll", task: { id, url: null }, status: "needs-you", detail: "Needs you", updatedAt: NOW.toISOString() });
    expect(readdirSync(requests()).sort()).toEqual([`${ID}.json`, `${ID}.task.json`]);
    // Unchanged: not written again.
    pass(later(1));
    expect(statusFile()["updatedAt"]).toBe(NOW.toISOString());
    expect(store.cancelTask(id, later(2))).toEqual({ ok: true });
    pass(later(3));
    expect(statusFile()).toMatchObject({ status: "stopped", detail: "Stopped", updatedAt: later(3).toISOString() });
    expect(youiyouxState(store, repo)).toMatchObject({ filed: 1, queued: 0 });
    expect(readFileSync(join(requests(), `${ID}.json`), "utf8")).toBe(text);
    expect(readdirSync(requests()).sort()).toEqual([`${ID}.json`, `${ID}.task.json`]);
  });

  test("its links are the console's own address when the installation names one", () => {
    writeFileSync(join(base, "console-url"), "https://toolroll.example/\n");
    writeFileSync(join(base, "up-console.json"), JSON.stringify({ url: "http://127.0.0.1:4180/" }));
    save(`${ID}.json`, request());
    pass();
    expect(statusFile()).toMatchObject({ task: { id: taskOf(), url: `https://toolroll.example/t/${taskOf()}` }, home: "https://toolroll.example/work?view=needs-you" });
  });

  test.each([
    ["this machine's console on loopback", "http://127.0.0.1:4180/", "http://127.0.0.1:4180"],
    ["localhost", "http://localhost:4312", "http://localhost:4312"],
    ["a tailnet address", "http://100.64.0.7:4180/", null],
    ["a public host", "http://toolroll.example:4180/", null],
    ["https on loopback", "https://127.0.0.1:4180/", null],
    ["an address with a password", "http://alex:pw@127.0.0.1:4180/", null],
  ])("with no address named, the links fall back to %s only where it is loopback http", (_what, served, origin) => {
    writeFileSync(join(base, "up-console.json"), JSON.stringify({ url: served, at: NOW.toISOString() }));
    save(`${ID}.json`, request());
    pass();
    const file = statusFile();
    expect(file["task"]).toEqual({ id: taskOf(), url: origin === null ? null : `${origin}/t/${taskOf()}` });
    if (origin === null) expect(file).not.toHaveProperty("home");
    else expect(file["home"]).toBe(`${origin}/work?view=needs-you`);
  });

  test("a status written before the console had an address is written again with its links, once", () => {
    save(`${ID}.json`, request());
    pass();
    expect(statusFile()).toMatchObject({ task: { url: null }, updatedAt: NOW.toISOString() });
    expect(statusFile()).not.toHaveProperty("home");
    writeFileSync(join(base, "up-console.json"), JSON.stringify({ url: "http://127.0.0.1:4180/" }));
    pass(later(1));
    expect(statusFile()).toMatchObject({ task: { url: `http://127.0.0.1:4180/t/${taskOf()}` }, home: "http://127.0.0.1:4180/work?view=needs-you", status: "needs-you", updatedAt: later(1).toISOString() });
    pass(later(2));
    expect(statusFile()["updatedAt"]).toBe(later(1).toISOString());
  });

  test("a status that breaks its own contract is never written", () => {
    save(`${ID}.json`, request());
    const body = { schema: "youi.request-task/v1" as const, request: ID, runner: "Toolroll" as const, task: { id: "t-1", url: null }, home: "javascript:alert(1)", status: "queued" as const, detail: "Queued", updatedAt: NOW.toISOString() };
    expect(writeStatusFile(repo, body)).toMatchObject({ ok: false, problem: expect.stringMatching(/contract/) });
    expect(existsSync(join(requests(), `${ID}.task.json`))).toBe(false);
  });

  test.each([
    ["no links at all", {}, true],
    ["its links", { task: { id: "t-1", url: "http://127.0.0.1:4180/t/t-1" }, home: "https://toolroll.example/work?view=needs-you" }, true],
    ["a home with a password", { home: "https://alex:pw@toolroll.example/work" }, false],
    ["a home that isn't http", { home: "javascript:alert(1)" }, false],
    ["a home over 2,000 characters", { home: `https://toolroll.example/${"a".repeat(2000)}` }, false],
    ["a task link with a user name", { task: { id: "t-1", url: "https://alex@toolroll.example/t/t-1" } }, false],
  ])("the status contract takes %s: %s", (_what, change, ok) => {
    const body = { schema: "youi.request-task/v1", request: ID, runner: "Toolroll", task: { id: "t-1", url: null }, status: "queued", detail: "Queued", updatedAt: NOW.toISOString(), ...change };
    expect(readYouiyouxRequestTask(body).ok).toBe(ok);
  });

  test("a link where the status goes is refused, and what it points at is left alone", () => {
    writeFileSync(join(base, "victim.txt"), "keep me");
    symlinkSync(join(base, "victim.txt"), join(requests(), `${ID}.task.json`));
    save(`${ID}.json`, request());
    expect(pass().filed).toBe(1);
    expect(readFileSync(join(base, "victim.txt"), "utf8")).toBe("keep me");
    expect(store.handle.prepare("SELECT written_at, write_problem FROM youiyoux_request").get()).toMatchObject({ written_at: null, write_problem: expect.stringMatching(/isn't a plain file/) });
    expect(readdirSync(requests()).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a requests folder swapped for a link after filing gets nothing written through it", () => {
    save(`${ID}.json`, request());
    pass();
    const id = taskOf();
    renameSync(requests(), join(base, "elsewhere"));
    symlinkSync(join(base, "elsewhere"), requests());
    rmSync(join(base, "elsewhere", `${ID}.task.json`));
    expect(store.cancelTask(id, later(1))).toEqual({ ok: true });
    pass(later(2));
    expect(existsSync(join(base, "elsewhere", `${ID}.task.json`))).toBe(false);
    expect(readdirSync(join(base, "elsewhere"))).toEqual([`${ID}.json`]);
    // Written directly, at the moment of use, the link is refused all the same.
    const body = { schema: "youi.request-task/v1" as const, request: ID, runner: "Toolroll" as const, task: { id, url: null }, status: "stopped" as const, detail: "Stopped", updatedAt: later(3).toISOString() };
    expect(writeStatusFile(repo, body)).toMatchObject({ ok: false, problem: expect.stringMatching(/is a link/) });
    expect(readdirSync(join(base, "elsewhere"))).toEqual([`${ID}.json`]);
  });
});

describe("setting itself up", () => {
  test("a project added that uses youiyoux takes requests with no step of its own; turned off, it reads and writes nothing", async () => {
    const shop = join(base, "admitted");
    const folder = join(shop, ".youi", "requests");
    mkdirSync(folder, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: shop });
    writeFileSync(join(shop, "youi.project.json"), "{}");
    writeFileSync(join(folder, `${ID}.json`), JSON.stringify(request()));
    const added = await admitProject(store, { registryFile: join(base, "repos.json"), path: shop, actor: { label: "alex", origin: "cli" }, now: NOW });
    expect(added).toMatchObject({ ok: true, repo: shop });
    expect(runYouiyouxIntake(store, shop, NOW, io()).filed).toBe(1);
    expect(youiyouxState(store, shop)).toMatchObject({ uses: true, on: true, off: false, queued: 1 });

    setYouiyouxIntake(store, shop, false, "alex", later(1));
    writeFileSync(join(folder, "r-1111111111.json"), JSON.stringify(request("r-1111111111")));
    expect(runYouiyouxIntake(store, shop, later(2), io(), { force: true }).filed).toBe(0);
    expect(youiyouxState(store, shop)).toMatchObject({ uses: true, on: false, off: true });
    expect(readdirSync(folder).sort()).toEqual([`${ID}.json`, `${ID}.task.json`, "r-1111111111.json"]);

    setYouiyouxIntake(store, shop, true, "alex", later(3));
    expect(runYouiyouxIntake(store, shop, later(4), io(), { force: true }).filed).toBe(1);
    expect(youiyouxState(store, shop)).toMatchObject({ on: true, queued: 2, filed: 2 });
    expect(store.actionLedger({ repos: null, instance: true }).filter(one => one.action.startsWith("youiyoux requests")).map(one => one.action).sort()).toEqual(["youiyoux requests off", "youiyoux requests on"]);
  });

  test("a project that doesn't use youiyoux is read for nothing", () => {
    rmSync(join(repo, ".youi"), { recursive: true });
    expect(youiyouxState(store, repo)).toMatchObject({ uses: false, on: false });
    expect(pass()).toMatchObject({ filed: 0, invalid: 0 });
  });
});
