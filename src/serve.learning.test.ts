/**
 * The learning loops on the console and the CLI (docs/plans/learning-loops.md): the flaky tests page, lesson notes and
 * clean-ups say no banned word, test names render unchanged, its one action is the ordinary task form, and a person's
 * accept works through the same writers as the CLI. Real HTTP on an ephemeral port over a throwaway store.
 */
import { request as httpRequest, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { memoryFixture, MEMORY_NOW, type MemoryFixture } from "../test/memory-fixture.js";
import { flakyList } from "./flaky.js";
import { runAsLocalOwner } from "./local-owner.js";
import { proposeTidy } from "./memory-tidy.js";
import { runOperate } from "./operate.js";
import { PLAIN_WORDS } from "./plain-words.js";
import { listDecisions, recordDecision, retireDecision } from "./project-memory.js";
import { register } from "./runner.js";
import { createDecisionServer } from "./serve.js";
import { initLocalMode, openStore } from "./store.js";

const NAME = "Fix footer «scope digest sealed lease»";
const IDENTITY = `unit:src/footer.test.ts::${NAME}`;
let f: MemoryFixture, server: Server, base: string, cookie: string;

function http(path: string, init: { method?: string; body?: string } = {}): Promise<{ status: number; body: string; setCookie: string; location: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method: init.method ?? "GET", headers: { ...(cookie ? { cookie } : {}), origin: base, ...(init.body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(init.body) }) } }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, setCookie: String(res.headers["set-cookie"]?.[0] ?? ""), location: String(res.headers.location ?? "") }));
    });
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
const visible = (html: string): string => {
  const bare = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ");
  const attributes = [...bare.matchAll(/\s(?:aria-label|title|placeholder)="([^"]*)"/g)].map(match => match[1]);
  return [bare.replace(/<[^>]+>/g, " "), ...attributes].join(" \n ").replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16))).replace(/&#([0-9]+);/g, (_, dec: string) => String.fromCodePoint(Number(dec))).replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
};
/** Banned words in product copy; what a person or a test wrote (the sentinel) is preserved content. */
const banned = (text: string): string[] => {
  // `memory status` prints the surface's own version, as it always has.
  const copy = text.split("«scope digest sealed lease»").join(" ").split("«receipt proof»").join(" ").replace(/^Surface \S+/m, "");
  return PLAIN_WORDS.flatMap(word => [...copy.matchAll(new RegExp(word.pattern.source, "gi"))].map(match => `${word.never}: …${copy.slice(Math.max(0, match.index - 40), match.index + match[0].length + 30)}…`));
};
const csrfOf = (html: string): string => /name="csrf" value="([0-9a-f]{64})"/.exec(html)![1]!;
const post = async (path: string, fields: Record<string, string>, from = `/settings/knowledge?repo=${encodeURIComponent(f.repo)}`) =>
  http(path, { method: "POST", body: new URLSearchParams({ csrf: csrfOf((await http(from)).body), ...fields }).toString() });
const cli = async (...argv: string[]): Promise<string> => {
  const lines: string[] = [];
  await runOperate(argv[0]!, [...argv.slice(1), "--as", "alex", "--token", f.password, "--db", f.db, "--repo", f.repo], line => { lines.push(line); }, { now: MEMORY_NOW });
  return lines.join("\n");
};
const at = MEMORY_NOW.toISOString();
function seed(): void {
  const { store, repo } = f;
  const one = f.start(), other = f.start();
  for (const run of [one, other]) {
    store.handle.prepare("INSERT INTO check_fact (run, repo, task_ref, head, tree, command_digest, access, conditions_digest, conditions_class, purpose, learn_state, recorded_at) SELECT id, ?, task_ref, ?, 't', 'c', 'sandboxed', 'd', 'darwin-arm64-node24', 'ordinary', 'not-asked', ? FROM run WHERE id = ?").run(repo, f.head, at, run);
  }
  const addResult = store.handle.prepare("INSERT INTO check_result (run, identity, state, source, recorded_at) VALUES (?, ?, ?, 'report', ?)");
  addResult.run(one, IDENTITY, "failed", at); addResult.run(other, IDENTITY, "passed", at);
  store.handle.prepare("INSERT INTO local_observation (repo, identity, failed_run, passed_run, tree, conditions_digest, kind, observed_at) VALUES (?, ?, ?, ?, 't', 'd', 'regate', ?)").run(repo, IDENTITY, one, other, at);
  store.handle.prepare(`INSERT INTO ci_flaky_observation (repo, provider, repository, workflow, lane_id, lane_name, workflow_run_id, head_sha, failed_attempt, failed_job_id, failed_conclusion, passed_attempt, passed_job_id, passed_conclusion, observed_at)
    VALUES (?, 'github', 'acme/shop', 'ci.yml', 'ci.yml:unit', 'unit', 7, ?, 1, 1, 'failure', 2, 2, 'success', ?)`).run(repo, f.head, at);
  const proposal = Number(store.handle.prepare("INSERT INTO memory_proposal(repo,kind,fingerprint,title,rationale,before_text,after_text,evidence,sessions,status,created_at,surface) VALUES (?,'decision-add','note:x','Lesson note: footer',?,NULL,'The footer test failed and passed.',?,1,'pending',?,'lesson-note')")
    .run(repo, `\`${NAME}\` failed in build #${one}. It passed in revision abc1234 (build #${other}). That revision changed: src/footer.ts.`, JSON.stringify([{ session: `build:${one}`, quote: "AssertionError: expected 1" }]), at).lastInsertRowid);
  store.handle.prepare("INSERT INTO lesson_note (proposal, repo, failed_run, passing_run, identities_json, changed_paths_json, test_files_changed_json, facts_digest, created_at) VALUES (?, ?, ?, ?, ?, '[]', '[]', 'x', ?)").run(proposal, repo, one, other, JSON.stringify([IDENTITY]), at);
  const claim = (text: string) => recordDecision(store, { repo, actor: "alex", draft: { claim: text, why: "Recorded for this page." } }, MEMORY_NOW).id;
  claim("Use short «receipt proof» labels"); claim("use short «receipt proof» labels");
  const gone = claim("An old choice");
  retireDecision(store, { repo, actor: "alex", id: gone, reason: "Not needed." }, MEMORY_NOW);
}

beforeAll(async () => {
  f = memoryFixture();
  server = createDecisionServer({ store: f.store, evidenceRoot: join(f.root, "evidence"), repo: f.repo, clock: () => MEMORY_NOW });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
  cookie = "";
  const login = await http("/login", { method: "POST", body: new URLSearchParams({ name: "alex", token: f.password }).toString() });
  cookie = login.setCookie.split(";")[0]!;
  if (!cookie) throw new Error(`login ${login.status}`);
});
afterAll(async () => { await new Promise<void>(done => server.close(() => done())); f.close(); });

describe("the pages", () => {
  test("empty: the list says so", async () => {
    const page = await http("/projects/repo/flaky");
    expect(page.status).toBe(200);
    expect(visible(page.body)).toContain("No mixed outcomes recorded");
    expect((await http("/projects/repo")).body).toContain("/projects/repo/flaky");
    expect((await http("/projects/nowhere/flaky")).status).toBe(404);
  });

  test("seeded: test names render unchanged, and product copy says no banned word", async () => {
    seed();
    await proposeTidy(f.store, { repo: f.repo, actor: "alex" }, MEMORY_NOW);
    const encoded = encodeURIComponent(IDENTITY);
    const paths = ["/projects/repo/flaky", `/projects/repo/flaky?row=${encoded}`, "/projects/repo/flaky?days=365", `/settings/knowledge?repo=${encodeURIComponent(f.repo)}`, `/settings/learning?repo=${encodeURIComponent(f.repo)}`];
    for (const path of paths) {
      const page = await http(path);
      expect(page.status, path).toBe(200);
      expect(banned(visible(page.body)).join("\n"), path).toBe("");
    }
    const list = visible((await http("/projects/repo/flaky")).body);
    expect(list).toContain(NAME);
    expect(list).toContain("Mixed outcomes under recorded conditions");
    expect(list).toContain("unit (GitHub CI)");
    for (const argv of [["flaky", "list"], ["memory", "review"], ["memory", "status"]]) expect(banned(await cli(...argv)).join("\n"), argv.join(" ")).toBe("");
    expect(await cli("flaky", "show", IDENTITY)).toContain("Never skip, delete or loosen");
  });

  test("the list's one action is the ordinary task form, with no rerun and no skip", async () => {
    const html = (await http("/projects/repo/flaky")).body;
    const forms = [...html.matchAll(/<form[^>]*action="([^"]*)"/g)].map(match => match[1]);
    // Beside the app's own project switcher, the only form is the task form.
    expect([...new Set(forms.filter(action => action !== undefined && !/^\/(?:search|projects\/(?:select|open))/.test(action)))]).toEqual(["/tasks/add"]);
    expect(visible(html)).toContain("Make a task to fix it");
    expect(html).toContain("Never skip, delete or loosen");
  });

  test("reading the pages writes nothing", async () => {
    const counts = () => ["local_observation", "memory_tidy_proposal", "memory_proposal", "memory_use"].map(table => Number(f.store.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!["n"]));
    const before = counts();
    await http("/projects/repo/flaky");
    await http(`/settings/knowledge?repo=${encodeURIComponent(f.repo)}`);
    expect(counts()).toEqual(before);
    expect(flakyList(f.store, f.repo, MEMORY_NOW).rows).toHaveLength(2);
  });
});

describe("a person's accept", () => {
  test("a lesson note needs the person's own words; a clean-up is decided through its one writer", async () => {
    const id = String(f.store.handle.prepare("SELECT id FROM memory_proposal WHERE surface = 'lesson-note'").get()!["id"]);
    const refused = await post("/settings/knowledge/note", { repo: f.repo, proposal: id, decision: "accept", claim: "The footer test failed and passed." });
    expect(refused.status).toBe(409);
    expect(visible(refused.body)).toContain("own words");
    const accepted = await post("/settings/knowledge/note", { repo: f.repo, proposal: id, decision: "accept", claim: "The footer waits for fonts." });
    expect(accepted.status).toBe(303);
    expect(listDecisions(f.store, f.repo, "alex").map(one => one.claim)).toContain("The footer waits for fonts.");
    const cleanup = String(f.store.handle.prepare("SELECT id FROM memory_tidy_proposal WHERE kind = 'merge'").get()!["id"]);
    expect((await post("/settings/knowledge/tidy", { repo: f.repo, action: "accept", proposal: cleanup })).status).toBe(303);
    expect(f.store.handle.prepare("SELECT status, decided_by, decided_proof FROM memory_tidy_proposal WHERE id = ?").get(Number(cleanup))).toMatchObject({ status: "accepted", decided_by: "alex", decided_proof: "session" });
    expect(f.store.handle.prepare("SELECT COUNT(*) AS n FROM decision_merge").get()).toMatchObject({ n: 2 });
  });

  test("Clean up on request, and a retired decision's Restore, both work from the page", async () => {
    expect((await post("/settings/knowledge/tidy", { repo: f.repo, action: "propose" })).status).toBe(303);
    const gone = listDecisions(f.store, f.repo, "alex", { status: "all", limit: 100 }).find(one => one.claim === "An old choice")!;
    expect((await post("/settings/knowledge/tidy", { repo: f.repo, action: "restore", target: String(gone.id) })).status).toBe(303);
    expect(listDecisions(f.store, f.repo, "alex").map(one => one.id)).toContain(gone.id);
    expect((await post("/settings/knowledge/tidy", { repo: f.repo, action: "nothing" })).status).toBe(400);
  });
});

describe("the laptop's local owner, through the terminal UI's door", () => {
  test("reads the list and decides a clean-up; a decision of its own stays with a password", async () => {
    const dir = mkdtempSync(join(tmpdir(), "learning-local-")), db = join(dir, "state.db"), repo = "/repos/shop";
    const store = openStore(db, { createdBy: "laptop" });
    expect(initLocalMode(store, { owner: "alex", fenceAvailable: true, now: MEMORY_NOW }).ok).toBe(true);
    register(store, { name: "runner", host: "test", capacity: 1, repos: [repo], now: MEMORY_NOW, newToken: () => "runner-token" });
    store.createTask({ id: "local-1", title: "A task here" }, MEMORY_NOW);
    store.placeTask(store.refFor("built-in", "local-1").id, repo);
    store.close();
    const asOwner = async (...argv: string[]) => {
      const lines: string[] = [];
      const code = await runAsLocalOwner(() => runOperate(argv[0]!, [...argv.slice(1), "--repo", repo, "--json", "--db", db], line => { lines.push(line); }, { now: MEMORY_NOW }));
      return { code, answer: JSON.parse(lines.join("\n")) as { ok: boolean; message?: string } };
    };
    try {
      expect(await asOwner("flaky", "list")).toMatchObject({ code: 0, answer: { ok: true } });
      expect(await asOwner("memory", "review")).toMatchObject({ code: 0, answer: { ok: true } });
      expect((await asOwner("memory", "decide", "A choice", "--why", "A reason")).answer.ok).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
