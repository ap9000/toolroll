/**
 * Remote activity (remote-audit.ts, audit-cli.ts, people-audit-ui.ts): who did what on this server with which token,
 * read from the remote lines the action history already holds — old words mapped as read, nothing rewritten — and
 * shown to each reader only as far as they may see.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import type { Server } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, hashPassword } from "./scope.js";
import { mintApiToken } from "./api-tokens.js";
import { runOperate, runOperateAs, type Principal } from "./operate.js";
import { callPersonTool } from "./mcp-person.js";
import { auditOutcome, OWNER_READER, readDetail, remoteAudit, sinceOf, type AuditFilters } from "./remote-audit.js";
import { auditLine } from "./audit-cli.js";
import { personAuditHtml } from "./people-audit-ui.js";
import { createDecisionServer } from "./serve.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const NONE: AuditFilters = { person: null, token: null, source: null, since: null };
let dir: string, file: string, store: Store, A: string, B: string, out: string[];
const passwords: Record<string, string> = {};
const write = (line: string) => { out.push(line); };
const last = () => JSON.parse(out.at(-1)!) as Record<string, unknown>;

function token(account: string, name: string, access: "read" | "act", expiresAt = "2027-01-01T00:00:00.000Z"): string {
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account, name, secretHash: minted.hash, access, expiresAt, by: account }, NOW);
  return minted.id;
}
const principal = (account: string, tokenId: string, scope: "read" | "act", projects: string[] | null): Principal =>
  ({ kind: "person", account, generation: store.accountOf(account)!.generation, scope, tokenId, projects });
const as = async (who: Principal, argv: string[], source: "api" | "mcp" = "api") => {
  out = [];
  const code = await runOperateAs(argv, { principal: who, store, write, source, options: { now: NOW } });
  return { code, text: out.join("\n") };
};
const local = async (argv: string[]) => {
  out = [];
  const code = await runOperate(argv[0]!, [...argv.slice(1), "--db", file], write, { now: NOW, openDatabase: () => openStore(file) });
  return { code, text: out.join("\n") };
};
/** A remote line exactly as runOperateAs writes it (or wrote it before this change). */
const line = (actor: string, command: string, outcome: string, detail: string, extra: { repo?: string | null; at?: string; source?: "api" | "mcp" } = {}) =>
  store.recordAction({ at: extra.at ?? NOW.toISOString(), actor, repo: extra.repo ?? null, taskId: null, runId: null, action: `remote command: ${command}`, outcome, source: extra.source ?? "api", detail });
const audit = (filters: Partial<AuditFilters> = {}, page: { limit?: number; before?: number | null } = {}) => {
  const read = remoteAudit(store, OWNER_READER, { ...NONE, ...filters }, page);
  if (!read.ok) throw new Error(read.message);
  return read;
};

let alex: Principal, sam: Principal, samRead: Principal, vic: Principal, taskA: string;

beforeEach(async () => {
  out = [];
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-audit-")));
  file = join(dir, "orders.db");
  A = join(dir, "project-a"); B = join(dir, "project-b");
  for (const repo of [A, B]) { mkdirSync(repo); execFileSync("git", ["init", "-q", repo]); }
  store = openStore(file);
  const owner = addApprover(store, "alex", NOW);
  if (!owner.ok) throw new Error("alex");
  passwords["alex"] = owner.token;
  const person = addApprover(store, "sam", NOW, { name: "alex", token: owner.token });
  if (!person.ok) throw new Error("sam");
  passwords["sam"] = person.token;
  expect(store.setAccountProjects("sam", [A], "alex", NOW)).toEqual({ ok: true });
  const invite = store.mintInvite("viewer", "alex", NOW);
  passwords["vic"] = "vic-long-password-1";
  expect(store.consumeInviteAndCreateAccount({ tokenValue: invite.token, name: "vic", credentialHash: hashPassword(passwords["vic"]) }, NOW)).toMatchObject({ ok: true });
  for (const repo of [A, B]) {
    const filed = await local(["task", "add", `Work in ${repo === A ? "a" : "b"}`, "--repo", repo, "--json"]);
    expect(filed.code, filed.text).toBe(0);
    if (repo === A) taskA = String((last()["task"] as { id: string }).id);
  }
  alex = principal("alex", token("alex", "alex-ci", "act"), "act", null);
  sam = principal("sam", token("sam", "laptop", "act"), "act", [A]);
  samRead = principal("sam", token("sam", "laptop · old", "read"), "read", [A]);
  vic = principal("vic", token("vic", "laptop", "read"), "read", null);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the audit projection", () => {
  it("reads old and new lines in one vocabulary, leaves out requests, rewrites nothing, and the chain still verifies", async () => {
    // Lines as 0.9.44 wrote them: the old final words, no tool.
    const old = [
      line("sam", "task show", "done", "token laptop", { repo: A }),
      line("sam", "task add", "usage", "token laptop"),
      line("sam", "task list", "failed", "token laptop", { repo: A }),
      line("sam", "task show", "refused", "token laptop · not-found"),
      line("sam", "task show", "requested", "token laptop", { repo: A }),
      line("sam", "task show", "done", "token laptop", { repo: A, source: "mcp" }),
    ];
    const before = store.handle.prepare(`SELECT * FROM action_ledger WHERE id BETWEEN ? AND ?`).all(old[0]!, old.at(-1)!);
    const seals = store.handle.prepare(`SELECT * FROM ledger_seal WHERE id BETWEEN ? AND ?`).all(old[0]!, old.at(-1)!);
    // And new ones, through the real remote paths.
    expect((await as(sam, ["task", "show", taskA, "--json"])).code).toBe(0);
    expect((await as(samRead, ["task", "steer", taskA, "--note", "smaller", "--json"])).code).toBe(3);
    const viaTool = await callPersonTool({ principal: sam, role: "approver", tokenName: "laptop" }, store, (argv, opts) => runOperateAs(argv, { ...opts, options: { now: NOW } }), { name: "task_show", arguments: { ref: taskA } });
    expect(viaTool.kind).toBe("result");

    const actions = audit().actions;
    expect(actions.map(one => [one.person, one.token, one.source, one.kind, one.name, one.outcome, one.reason])).toEqual([
      ["sam", "laptop", "mcp", "tool", "task_show", "ok", null],
      ["sam", "laptop · old", "api", "command", "task steer", "refused", "read-only"],
      ["sam", "laptop", "api", "command", "task show", "ok", null],
      ["sam", "laptop", "mcp", "tool", "task show", "ok", null],
      ["sam", "laptop", "api", "command", "task show", "refused", "not-found"],
      ["sam", "laptop", "api", "command", "task list", "error", null],
      ["sam", "laptop", "api", "command", "task add", "refused", "usage"],
      ["sam", "laptop", "api", "command", "task show", "ok", null],
    ]);
    expect(actions[0]).toMatchObject({ command: "task show", tool: "task_show", repo: A, taskId: taskA });
    expect(JSON.stringify(actions)).not.toContain("token laptop");
    // The old lines and their seals are byte for byte what they were; the whole chain verifies.
    expect(store.handle.prepare(`SELECT * FROM action_ledger WHERE id BETWEEN ? AND ?`).all(old[0]!, old.at(-1)!)).toEqual(before);
    expect(store.handle.prepare(`SELECT * FROM ledger_seal WHERE id BETWEEN ? AND ?`).all(old[0]!, old.at(-1)!)).toEqual(seals);
    const verified = await local(["ledger", "verify", "--json"]);
    expect(verified.code, verified.text).toBe(0);
    expect(JSON.parse(verified.text)).toMatchObject({ ok: true, chain: { ok: true } });
  });

  it("maps every outcome word and parses since strictly", () => {
    expect(["done", "refused", "usage", "failed", "requested", "something-new"].map(auditOutcome)).toEqual(["ok", "refused", "refused", "error", null, "error"]);
    expect(sinceOf("7d", NOW)).toBe("2026-09-29T12:00:00.000Z");
    expect(sinceOf("3650d", NOW)).not.toBeNull();
    for (const bad of ["0d", "-1d", "07d", "1.5d", "7", "7h", "d", " 7d", "7d ", "3651d", "99999d"]) expect(sinceOf(bad, NOW), bad).toBeNull();
  });

  it("names the token by exact, longest match, and never echoes what it can't place", () => {
    const tokens = [{ id: "aaaaaaaaaaaa", name: "laptop" }, { id: "bbbbbbbbbbbb", name: "laptop · old" }];
    expect(readDetail("token laptop", tokens)).toEqual({ token: "laptop", tool: null, reason: null });
    expect(readDetail("token laptop · old", tokens)).toEqual({ token: "laptop · old", tool: null, reason: null });
    expect(readDetail("token laptop · old · read-only · tool task_show", tokens)).toEqual({ token: "laptop · old", tool: "task_show", reason: "read-only" });
    expect(readDetail("token laptop · not-found", tokens)).toEqual({ token: "laptop", tool: null, reason: "not-found" });
    // Before a token was proved the line names its id.
    expect(readDetail("token bbbbbbbbbbbb · unauthenticated", tokens)).toEqual({ token: "laptop · old", tool: null, reason: "unauthenticated" });
    for (const unknown of ["token laptops", "token so_aaaaaaaaaaaa_secret", "laptop", null]) expect(readDetail(unknown, tokens)).toEqual({ token: null, tool: null, reason: null });
    expect(readDetail("token laptop · Some Free Text", tokens).reason).toBeNull();
  });

  it("filters by person, token, source and since, alone and together", () => {
    line("sam", "task show", "done", "token laptop", { repo: A, at: "2026-09-01T00:00:00.000Z" });
    line("sam", "task show", "done", "token laptop · old", { repo: A });
    line("sam", "task list", "done", "token laptop · old · tool list_tasks", { repo: A, source: "mcp" });
    line("vic", "status", "done", "token laptop");
    line("alex", "status", "refused", "token alex-ci · read-only");
    const names = (filters: Partial<AuditFilters>) => audit(filters).actions.map(one => `${one.person}/${one.token}/${one.source}/${one.name}`);
    expect(names({ person: "sam" })).toEqual(["sam/laptop · old/mcp/list_tasks", "sam/laptop · old/api/task show", "sam/laptop/api/task show"]);
    // A name two people use is one named history; a name that prefixes another is not the other.
    expect(names({ token: "laptop" })).toEqual(["vic/laptop/api/status", "sam/laptop/api/task show"]);
    expect(names({ token: "laptop", person: "sam" })).toEqual(["sam/laptop/api/task show"]);
    expect(names({ token: "laptop · old" })).toEqual(["sam/laptop · old/mcp/list_tasks", "sam/laptop · old/api/task show"]);
    expect(names({ token: "no-such-token" })).toEqual([]);
    expect(names({ source: "mcp" })).toEqual(["sam/laptop · old/mcp/list_tasks"]);
    expect(names({ person: "sam", since: sinceOf("7d", NOW) })).toEqual(["sam/laptop · old/mcp/list_tasks", "sam/laptop · old/api/task show"]);
    expect(names({ person: "sam", source: "api", token: "laptop · old", since: sinceOf("1d", NOW) })).toEqual(["sam/laptop · old/api/task show"]);
    expect(remoteAudit(store, OWNER_READER, { ...NONE, person: "nobody" })).toEqual({ ok: false, reason: "not-found", message: "Not found." });
  });

  it("pages newest first by entry id: later lines never shift or repeat an older page", () => {
    const ids = Array.from({ length: 5 }, (_, index) => line("sam", `task show`, "done", `token laptop`, { repo: A, at: `2026-10-0${index + 1}T00:00:00.000Z` }));
    line("sam", "task show", "requested", "token laptop");
    const first = audit({}, { limit: 2 });
    expect(first.actions.map(one => one.id)).toEqual([ids[4], ids[3]]);
    expect(first.nextCursor).toBe(String(ids[3]));
    line("sam", "task show", "done", "token laptop", { repo: A });
    line("sam", "task show", "done", "token laptop", { repo: A });
    const second = audit({}, { limit: 2, before: Number(first.nextCursor) });
    expect(second.actions.map(one => one.id)).toEqual([ids[2], ids[1]]);
    const third = audit({}, { limit: 2, before: Number(second.nextCursor) });
    expect(third.actions.map(one => one.id)).toEqual([ids[0]]);
    expect(third.nextCursor).toBeNull();
    // A token filter that skips most lines still fills its page and says when there is more.
    for (let index = 0; index < 5; index++) line("vic", "status", "done", "token laptop");
    line("sam", "status", "done", "token laptop · old");
    expect(audit({ token: "laptop · old" }, { limit: 1 })).toMatchObject({ nextCursor: null, actions: [{ person: "sam", token: "laptop · old" }] });
    expect(audit({}, { limit: 500 }).limit).toBe(100);
  });
});

describe("toolroll audit", () => {
  /** sam's line in A, alex's in A and B, an unplaced refusal of alex's, and vic's own. */
  async function everyone(): Promise<void> {
    expect((await as(sam, ["task", "show", taskA, "--json"])).code).toBe(0);
    line("alex", "task list", "done", "token alex-ci", { repo: A });
    line("alex", "task list", "done", "token alex-ci", { repo: B });
    line("alex", "task approve", "refused", "token alex-ci · step-up");
    expect((await as(vic, ["status", "--json"])).code).toBe(0);
  }
  const who = (text: string) => (JSON.parse(text) as { actions: { person: string; repo: string | null; command: string }[] }).actions
    .filter(one => one.command !== "audit").map(one => `${one.person}:${one.repo === null ? "-" : one.repo === A ? "A" : "B"}`);

  it("shows the owner everyone, an approver everyone within their projects, and anyone else only themselves", async () => {
    await everyone();
    const owner = await local(["audit", "--json"]);
    expect(owner.code, owner.text).toBe(0);
    expect(who(owner.text)).toEqual(["vic:-", "alex:-", "alex:B", "alex:A", "sam:A"]);
    const all = await as(alex, ["audit", "--json"]);
    expect(all.code, all.text).toBe(0);
    expect(who(all.text)).toEqual(["vic:-", "alex:-", "alex:B", "alex:A", "sam:A"]);
    // sam approves in A only: other people's lines in A, and every one of sam's own.
    line("sam", "task show", "refused", "token laptop · not-found");
    const limited = await as(sam, ["audit", "--json"]);
    expect(limited.code, limited.text).toBe(0);
    expect(who(limited.text)).toEqual(["sam:-", "alex:A", "sam:A"]);
    // vic watches: their own lines only, whatever they ask for.
    const viewer = await as(vic, ["audit", "--json"]);
    expect(who(viewer.text)).toEqual(["vic:-"]);
    expect(JSON.parse(viewer.text)).toMatchObject({ ok: true, command: "audit", filters: { person: null, token: null, source: null, since: null }, limit: 20, nextCursor: null });
  });

  it("answers another person a reader may not see exactly like a person who doesn't exist", async () => {
    await everyone();
    const hidden = await as(vic, ["audit", "--person", "sam", "--json"]);
    const missing = await as(vic, ["audit", "--person", "nobody", "--json"]);
    expect(hidden.code).toBe(3);
    expect(hidden.text).toBe(missing.text);
    expect(JSON.parse(hidden.text)).toEqual({ envelopeVersion: 1, ok: false, command: "audit", reason: "not-found", message: "Not found." });
    expect(who((await as(vic, ["audit", "--person", "vic", "--json"])).text)).toEqual(["vic:-"]);
    expect(who((await as(sam, ["audit", "--person", "alex", "--json"])).text)).toEqual(["alex:A"]);
  });

  it("takes the filters, refuses bad ones, and pages with a cursor", async () => {
    await everyone();
    expect(who((await local(["audit", "--person", "alex", "--source", "api", "--since", "7d", "--token", "alex-ci", "--json"])).text)).toEqual(["alex:-", "alex:B", "alex:A"]);
    // Remotely --token is a credential flag and stays refused; the same filter is --token-name.
    const credential = await as(alex, ["audit", "--token", "alex-ci", "--json"]);
    expect(credential.code).toBe(3);
    expect(JSON.parse(credential.text)).toMatchObject({ ok: false, reason: "usage" });
    expect(who((await as(alex, ["audit", "--token-name", "alex-ci", "--json"])).text)).toEqual(["alex:-", "alex:B", "alex:A"]);
    for (const bad of [["--since", "0d"], ["--since", "7"], ["--source", "web"], ["--limit", "0"], ["--limit", "101"], ["--cursor", "abc"], ["--token", "so_aaaaaaaaaaaa_x"], ["--repo", A], ["extra"]]) {
      const refused = await local(["audit", ...bad, "--json"]);
      expect(refused.code, bad.join(" ")).toBe(2);
      expect(JSON.parse(refused.text), bad.join(" ")).toMatchObject({ ok: false, command: "audit", reason: "usage" });
    }
    const first = await local(["audit", "--limit", "2", "--json"]);
    const page = JSON.parse(first.text) as { actions: { id: number }[]; nextCursor: string };
    expect(page.actions).toHaveLength(2);
    const next = JSON.parse((await local(["audit", "--limit", "2", "--cursor", page.nextCursor, "--json"])).text) as { actions: { id: number }[] };
    expect(next.actions[0]!.id).toBeLessThan(page.actions[1]!.id);
    // People read one line per action, and how to get the next page.
    const human = await local(["audit", "--person", "alex", "--limit", "1"]);
    expect(human.code).toBe(0);
    expect(human.text).toMatch(/^2026-10-06 12:00 {2}ok {2}alex {2}alex-ci {2}api {2}audit\nOlder: toolroll audit --cursor \d+ --person alex --limit 1$/);
    expect((await local(["audit", "--person", "alex", "--limit", "1", "--source", "api", "--cursor", String(audit({ person: "alex", token: "alex-ci" }).actions.find(one => one.name === "task approve")!.id + 1)])).text)
      .toMatch(/^2026-10-06 12:00 {2}refused \(step-up\) {2}alex {2}alex-ci {2}api {2}task approve\nOlder: /);
    expect((await local(["audit", "--person", "vic", "--source", "mcp"])).text).toBe("No remote actions.");
  });

  it("is itself in the remote history, as a read", async () => {
    expect((await as(samRead, ["audit", "--json"])).code).toBe(0);
    expect(audit({ person: "sam" }).actions[0]).toMatchObject({ name: "audit", token: "laptop · old", outcome: "ok" });
  });
});

describe("People → a person", () => {
  it("lists every token with its standing and last use, links each to its actions, and escapes what people typed", () => {
    const tokens = [
      { id: "aaaaaaaaaaaa", account: "sam", name: "<b>laptop</b>", access: "act" as const, createdAt: NOW.toISOString(), createdBy: "sam", expiresAt: "2027-01-01T00:00:00.000Z", lastUsedAt: "2026-10-06T11:58:00.000Z", revokedAt: null, revokedBy: null },
      { id: "bbbbbbbbbbbb", account: "sam", name: "ci", access: "read" as const, createdAt: NOW.toISOString(), createdBy: "sam", expiresAt: "2026-10-01T00:00:00.000Z", lastUsedAt: null, revokedAt: null, revokedBy: null },
      { id: "cccccccccccc", account: "sam", name: "old", access: "read" as const, createdAt: NOW.toISOString(), createdBy: "sam", expiresAt: "2027-01-01T00:00:00.000Z", lastUsedAt: null, revokedAt: NOW.toISOString(), revokedBy: "alex" },
    ];
    const html = personAuditHtml({ name: "sam", tokens, token: null, nextCursor: "41", now: NOW, actions: [
      { id: 42, at: NOW.toISOString(), person: "sam", token: "<b>laptop</b>", source: "mcp", kind: "tool", name: "task_show", command: "task show", tool: "task_show", repo: "/srv/a-very-long-project-name", taskId: "t-1", outcome: "refused", reason: "not-found" },
    ] });
    expect(html).toContain("<h1>sam</h1>");
    expect(html).toContain(`<a href="/people?person=sam&amp;token-name=%3Cb%3Elaptop%3C%2Fb%3E">&lt;b&gt;laptop&lt;/b&gt;</a>`);
    expect(html).toContain("Active · Can act · last used 2026-10-06 11:58 UTC");
    expect(html).toContain("Expired · Read only · last used never");
    expect(html).toContain("Revoked · Read only");
    expect(html).toContain(`<span class="outcome outcome-refused">Refused</span>task_show · <a href="/t/t-1">t-1</a>`);
    expect(html).toContain("2026-10-06 12:00 UTC · &lt;b&gt;laptop&lt;/b&gt; · Agent (MCP) · a-very-long-project-name · not-found");
    expect(html).toContain(`<a href="/people?person=sam&amp;before=41">Older actions</a>`);
    expect(html).not.toContain("<b>");
    const empty = personAuditHtml({ name: "vic", tokens: [], token: "ci", nextCursor: null, now: NOW, actions: [] });
    expect(empty).toContain("No API tokens.");
    expect(empty).toContain("No remote actions with this token.");
    expect(empty).toContain(`<p class="meta">With ci</p><p><a href="/people?person=vic">All tokens</a></p>`);
    expect(empty).not.toContain("Older actions");
  });

  describe("over HTTP", () => {
    let server: Server, base: string;
    beforeEach(async () => {
      server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), clock: () => new Date() });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (typeof address !== "object" || address === null) throw new Error("no address");
      base = `http://127.0.0.1:${address.port}`;
      expect((await as(sam, ["task", "show", taskA, "--json"])).code).toBe(0);
      line("alex", "task list", "done", "token alex-ci", { repo: B });
      line("vic", "status", "done", "token laptop");
    });
    afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
    const login = async (name: string): Promise<string> => {
      const response = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token: passwords[name]! }), redirect: "manual" });
      expect(response.status).toBe(303);
      return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
    };
    const get = async (cookie: string, path: string) => {
      const response = await fetch(`${base}${path}`, { headers: { cookie }, redirect: "manual" });
      return { status: response.status, html: await response.text() };
    };

    it("lets an approver open anyone, within their projects, and anyone else only themselves", async () => {
      const operator = await login("alex");
      const people = await get(operator, "/people");
      expect(people.html).toContain(`<a href="/people?person=sam">Tokens and remote activity</a>`);
      const samPage = await get(operator, "/people?person=sam");
      expect(samPage.status).toBe(200);
      expect(samPage.html).toContain("<h1>sam</h1>");
      expect(samPage.html).toContain(`href="/people?person=sam&amp;token-name=laptop"`);
      expect(samPage.html).toContain(`<span class="outcome outcome-ok">OK</span>task show`);
      expect((await get(operator, "/people?person=sam&token-name=laptop+%C2%B7+old")).html).toContain("No remote actions with this token.");
      expect((await get(operator, "/people?person=alex")).html).toContain("task list");

      // sam approves in A: alex's line in B is not theirs to see.
      const limited = await login("sam");
      const ownLink = await get(limited, "/people");
      expect(ownLink.html).toContain(`<a href="/people?person=sam">Your remote activity</a>`);
      const alexForSam = await get(limited, "/people?person=alex");
      expect(alexForSam.status).toBe(200);
      expect(alexForSam.html).toContain("No remote actions.");

      // vic watches: their own page, and nobody else's — read exactly like nobody.
      const viewer = await login("vic");
      expect((await get(viewer, "/people?person=vic")).html).toContain("status");
      const hidden = await get(viewer, "/people?person=sam");
      const missing = await get(viewer, "/people?person=nobody");
      expect(hidden.status).toBe(404);
      expect(hidden.html).toContain("No such person.");
      expect(missing.status).toBe(404);
      const stable = (html: string) => html.replace(/name="csrf" value="[0-9a-f]+"/g, "").replace(/nonce="[^"]+"/g, "");
      expect(stable(hidden.html).replaceAll("person=sam", "person=nobody")).toBe(stable(missing.html));
      expect((await get(viewer, "/people?person=vic&before=nope")).status).toBe(400);
    });
  });
});

it("formats one line per action, outcome first", () => {
  expect(auditLine({ id: 1, at: NOW.toISOString(), person: "sam", token: null, source: "mcp", kind: "tool", name: "list_tasks", command: "task list", tool: "list_tasks", repo: "/srv/shop", taskId: null, outcome: "error", reason: null }))
    .toBe("2026-10-06 12:00  error  sam  unknown token  mcp  list_tasks  shop");
});
