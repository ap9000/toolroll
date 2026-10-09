/**
 * Full export (v105): one folder or .zip with everything Toolroll
 * knows, a manifest of SHA-256 hashes and a README; never a secret. From the
 * command line and from Settings → Data (behind the password), and recorded
 * in the action ledger.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { inflateRawSync } from "node:zlib";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { runOperate } from "./operate.js";
import { mintApiToken } from "./api-tokens.js";
import { buildExport, categoryOf, exportZip, redactKeyShapes, type FullExport } from "./export.js";

let dir: string, file: string, store: Store, home: string | undefined;
const NOW = new Date("2026-09-20T12:00:00.000Z");
const REPO = "/repo/shop";

/** Key-shaped values planted in free text, and the secrets kept in their own places. None may appear in an export. */
/** Assembled at run time so no key-shaped text sits in the source (push protection, and the house rule). */
const k = (...parts: string[]) => parts.join("");
const PLANTED = {
  anthropic: k("sk-", "ant-api03-Zq8vT4mK2pL9xR7wY3nB6cF1hJ5dG0sA-EXAMPLEKEY"),
  openai: k("sk-", "proj-4f9KqLmN2pR7sT1vW8xY3zA6bC0dE5gH"),
  github: k("ghp", "_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"),
  slack: k("xox", "b-1234567890-0987654321-AbCdEfGhIjKlMnOpQrSt"),
  aws: k("AKI", "AIOSFODNN7EXAMPLE"),
  telegram: k("712", "3456789:AAHfK2mZq8vT4mK2pL9xR7wY3nB6cF1hJ5d"),
  stripe: k("whs", "ec_AbCdEfGhIjKlMnOpQrStUvWx12345678"),
  webhook: "monitoring-signing-secret-0123456789abcdef0123456789",
  clientSecret: "oidc-client-secret-kept-in-sign-in-json",
  mailPassword: "mail-password-kept-in-email-json",
  collector: "collector-header-value-api-key",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-export-"));
  file = join(dir, "orders.db");
  home = process.env["HOME"];
  process.env["HOME"] = dir;
  store = openStore(file);
});
afterEach(() => { store.close(); process.env["HOME"] = home; rmSync(dir, { recursive: true, force: true }); });

/** An installation with a bit of everything, and secrets everywhere they could hide. */
function seed(): { password: string; apiToken: string; hashes: string[] } {
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  const api = mintApiToken();
  store.createApiToken({ id: api.id, account: "alex", name: "ci", secretHash: api.hash, access: "read", expiresAt: "2027-01-01T00:00:00.000Z", by: "alex" }, NOW);
  const oauth = mintApiToken();
  const client = store.registerOAuthClient({ id: "synthetic-client", name: "Example Agent", redirectUris: ["https://agent.example/cb"], source: "synthetic-source-hash" }, NOW, 10, 5)!;
  store.createOAuthGrant("synthetic-code-hash", { id: oauth.id, account: "alex", name: "MCP: Example Agent", secretHash: oauth.hash, access: "read", expiresAt: "2027-01-01T00:00:00.000Z" },
    { client: client.id, account: "alex", generation: store.accountOf("alex")!.generation, projects: [REPO], resource: "https://toolroll.example/mcp", accessExpiresAt: "2026-10-07T00:00:00.000Z", refreshHash: "synthetic-first-refresh-hash" }, NOW);
  store.rotateOAuthGrant(oauth.id, { client: client.id, resource: "https://toolroll.example/mcp", refreshHash: "synthetic-first-refresh-hash" },
    { refreshHash: "synthetic-next-refresh-hash", accessHash: "synthetic-access-hash", accessExpiresAt: "2026-10-07T01:00:00.000Z" }, NOW, () => [REPO]);
  // A task and its revision, scoped and run, with usage and cost.
  store.createTask({ id: "refunds", title: `Refunds (key ${PLANTED.anthropic})`, filedBy: { name: "alex", kind: "person" } }, NOW);
  const ref = store.refFor("built-in", "refunds").id;
  store.placeTask(ref, REPO);
  const run = store.startRun({ taskRef: ref, leaseId: "l-1", runner: "b1", branch: "standing-orders/refunds", worktree: "/w/refunds",
    route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: NOW });
  store.recordUsage(run, { tokensIn: 1000, tokensOut: 200, costUsd: 1.25 });
  store.finishRun(run, { outcome: "built", now: NOW });
  store.recordAction({ at: NOW.toISOString(), actor: "alex", repo: REPO, taskId: "refunds", runId: run, action: "note", outcome: "recorded", source: "work", detail: `pasted ${PLANTED.github}` });
  store.setBudget({ scope: "project", key: REPO, limitMicrousd: 50_000_000, hardStop: true }, "alex", NOW);
  // A chat, a flow and a subagent, each carrying a pasted key.
  const thread = store.openLeadThread("alex", "ceiling", NOW).thread;
  store.appendLeadMessage({ thread: thread.id, turn: null, role: "operator", text: `use ${PLANTED.slack} and ${PLANTED.openai}` }, NOW);
  const flow = store.createFlow({ repo: REPO, name: "Support", by: "alex", definitionJson: JSON.stringify({ version: 1, start: "inbox", stages: [{ id: "inbox", title: "Inbox", kind: "inbox", zone: {}, next: null, onFail: null }] }) }, NOW);
  store.addFlowCard({ flow, title: "Customer email", description: `bot ${PLANTED.telegram}`, stage: "inbox", by: "alex" }, NOW);
  const mate = store.createSubagent({ repo: REPO, handle: "maya", soul: "Helps with refunds.", model: null, manager: "alex", by: "alex" }, NOW);
  store.addSubagentMemory({ subagent: mate, text: `aws ${PLANTED.aws}, stripe ${PLANTED.stripe}`, source: "person", by: "alex" }, NOW);
  // Secrets kept in files beside the database.
  writeFileSync(join(dir, "monitoring.json"), JSON.stringify({ webhook: { url: "https://logs.example.com/hook", secret: PLANTED.webhook }, folder: null,
    traces: { endpoint: "https://otel.example.com", header: { name: "x-honeycomb-team", value: PLANTED.collector } } }));
  writeFileSync(join(dir, "sign-in.json"), JSON.stringify({ issuer: "https://acme.okta.com", clientId: "so-app", clientSecret: PLANTED.clientSecret, rules: [] }));
  writeFileSync(join(dir, "email.json"), JSON.stringify({ host: "smtp.example.com", port: 587, from: "so@example.com", user: "so", password: PLANTED.mailPassword }));
  const hashes = [
    "synthetic-first-refresh-hash", "synthetic-next-refresh-hash", "synthetic-code-hash", "synthetic-source-hash",
    ...(store.handle.prepare("SELECT credential_hash AS h FROM approver").all() as { h: string }[]).map(one => one.h),
    ...(store.handle.prepare("SELECT secret_hash AS h FROM api_token").all() as { h: string }[]).map(one => one.h),
  ];
  return { password: alex.token, apiToken: api.token, hashes };
}

const exportOf = (who = "alex") => buildExport(store, { who, now: NOW, evidenceRoot: join(dir, "evidence"), configDir: dir });
const textOf = (exported: FullExport) => exported.files.map(one => one.data.toString("utf8")).join("\n");

/** Every file in a .zip, read back with nothing but its own central directory. */
function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const size = zip.readUInt32LE(at + 20), nameLength = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32), offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    files.set(name, inflateRawSync(zip.subarray(start, start + size)));
    at += 46 + nameLength + extra + comment;
  }
  return files;
}

test("the manifest lists every other file with its SHA-256, and a README explains the layout", () => {
  seed();
  const exported = exportOf();
  const paths = exported.files.map(one => one.path);
  expect(paths).toContain("README.md");
  expect(paths.at(-1)).toBe("manifest.json");
  const manifest = JSON.parse(exported.files.at(-1)!.data.toString("utf8"));
  expect(manifest).toMatchObject({ format: "standing-orders/export/v1", generatedAt: NOW.toISOString(), generatedBy: "alex" });
  expect(manifest.files.map((one: { path: string }) => one.path).sort()).toEqual(paths.filter(one => one !== "manifest.json").sort());
  for (const entry of manifest.files as { path: string; sha256: string; bytes: number }[]) {
    const data = exported.files.find(one => one.path === entry.path)!.data;
    expect(entry.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    expect(entry.bytes).toBe(data.length);
  }
  const readme = exported.files.find(one => one.path === "README.md")!.data.toString("utf8");
  for (const folder of ["projects/", "tasks/", "runs/", "ledger/", "evidence-packs/", "chats/", "flows/", "subagents/", "settings/", "manifest.json"]) expect(readme).toContain(folder);
});

test("the export covers tasks, runs, the ledger and its checkpoints, evidence packs, chats, flows, subagents and settings", () => {
  seed();
  store.ledgerCheckpoint("alex", NOW);
  const exported = exportOf();
  const rows = (path: string) => exported.files.find(one => one.path === path)!.data.toString("utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  expect(rows("tasks/task.jsonl")).toMatchObject([{ id: "refunds" }]);
  expect(rows("tasks/task_ref.jsonl")[0]).toMatchObject({ repo: REPO, filed_by: "alex" });
  expect(rows("runs/run.jsonl")[0]).toMatchObject({ tokens_in: 1000, tokens_out: 200, cost_usd: 1.25 });
  expect(rows("runs/run_spend.jsonl")).toHaveLength(1);
  expect(rows("ledger/action_ledger.jsonl").map(one => one.action)).toContain("note");
  expect(rows("ledger/ledger_seal.jsonl").length).toBeGreaterThan(0);
  expect(rows("ledger/ledger_checkpoint.jsonl")).toHaveLength(1);
  expect(JSON.parse(exported.files.find(one => one.path === "evidence-packs/refunds.json")!.data.toString("utf8"))).toMatchObject({ format: "standing-orders/evidence-pack/v1", task: { id: "refunds" }, totals: { runs: 1 } });
  expect(rows("chats/lead_message.jsonl")).toHaveLength(1);
  expect(rows("flows/flow.jsonl")[0]).toMatchObject({ name: "Support" });
  expect(rows("flows/flow_card.jsonl")[0]).toMatchObject({ title: "Customer email" });
  expect(rows("subagents/subagent.jsonl")[0]).toMatchObject({ handle: "maya" });
  expect(rows("subagents/subagent_memory.jsonl")).toHaveLength(1);
  expect(rows("people/approver.jsonl")[0]).toMatchObject({ name: "alex" });
  expect(rows("settings/budget.jsonl")[0]).toMatchObject({ scope_key: REPO, limit_microusd: 50_000_000 });
  expect(JSON.parse(exported.files.find(one => one.path === "settings/files.json")!.data.toString("utf8"))).toMatchObject({
    monitoring: { webhook: { origin: "https://logs.example.com" }, traces: { origin: "https://otel.example.com", header: "x-honeycomb-team" } },
    signIn: { issuer: "https://acme.okta.com", clientId: "so-app" }, email: { host: "smtp.example.com", user: "so" },
  });
  // Every table the database keeps lands somewhere; a new one lands in "other", never nowhere.
  expect(categoryOf("a_table_added_later")).toBe("other");
  const tables = (store.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memory_search%'").all() as { name: string }[]).map(one => one.name);
  const manifest = exported.manifest;
  for (const table of tables) expect(manifest.files.some(one => one.path === `${categoryOf(table)}/${table}.jsonl`) || manifest.excluded.tables.includes(table)).toBe(true);
});

test("no secret, token, key or password hash appears in the export", () => {
  const { password, apiToken, hashes } = seed();
  // A signed-in session and a pairing code exist too.
  store.handle.prepare("INSERT INTO web_session (id_hash, account, csrf, role, generation, created_at, last_seen, project_revision) VALUES (?, 'alex', ?, 'approver', 1, ?, ?, 0)").run("session-id-hash-planted", "csrf-planted-value", NOW.toISOString(), NOW.toISOString());
  const exported = exportOf();
  const zip = [...unzip(exportZip(exported)).values()].map(one => one.toString("utf8")).join("\n");
  for (const text of [textOf(exported), zip]) {
    for (const [name, value] of Object.entries(PLANTED)) expect(text.includes(value), name).toBe(false);
    expect(text).not.toContain(password);
    expect(text).not.toContain(apiToken);
    // The whole secret (base64url, which can itself contain "_"): the part after "so_<id>_", never a short tail.
    expect(text).not.toContain(apiToken.split("_").slice(2).join("_"));
    for (const hash of hashes) expect(text).not.toContain(hash);
    expect(text).not.toMatch(/scrypt\$/);
    expect(text).not.toContain("session-id-hash-planted");
    expect(text).not.toContain("csrf-planted-value");
  }
  // What was pasted is still there around the key; the key itself is redacted.
  expect(textOf(exported)).toContain("Refunds (key [redacted])");
  expect(exported.manifest.excluded.tables).toEqual(expect.arrayContaining(["web_session", "ceremony_nonce", "chat_pair"]));
  expect(exported.manifest.excluded.columns).toEqual(expect.arrayContaining(["approver.credential_hash", "api_token.secret_hash", "invite.token_hash", "flow_trigger.hook_hash", "push_subscription.auth", "chat_action.token"]));
  // Token counts are usage, kept.
  expect(exported.manifest.excluded.columns).not.toContain("run.tokens_in");
  expect(redactKeyShapes(`Authorization: Bearer ${"a".repeat(40)}`)).toBe("Authorization: [redacted]");
});

test("the command line writes a new folder or .zip and records the export in the ledger", async () => {
  const { apiToken } = seed();
  store.close();
  let lines: string[] = [];
  const run = async (argv: string[]) => { lines = []; const code = await runOperate("export", argv, line => { lines.push(line); }, { databaseFile: file }); return { code, out: lines.join("\n") }; };
  try {
    expect((await run([])).code).toBe(2);
    const folder = join(dir, "out");
    const made = await run(["--out", folder, "--json"]);
    expect(made.code).toBe(0);
    expect(JSON.parse(made.out)).toMatchObject({ ok: true, out: folder, zip: false });
    const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")) as { files: { path: string; sha256: string }[] };
    const onDisk = (at: string): string[] => readdirSync(at).flatMap(name => statSync(join(at, name)).isDirectory() ? onDisk(join(at, name)) : [relative(folder, join(at, name))]);
    expect(onDisk(folder).sort()).toEqual([...manifest.files.map(one => one.path), "manifest.json"].sort());
    for (const one of manifest.files) expect(createHash("sha256").update(readFileSync(join(folder, one.path))).digest("hex")).toBe(one.sha256);
    expect(statSync(join(folder, "manifest.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(folder, "ledger", "action_ledger.jsonl"), "utf8")).toContain('"action":"everything exported"');
    // An existing path is never overwritten.
    expect((await run(["--out", folder])).code).toBe(1);
    const archive = join(dir, "out.zip");
    expect((await run(["--out", archive, "--zip"])).out).toContain(`to ${archive}.`);
    const files = unzip(readFileSync(archive));
    const names = [...files.keys()];
    expect(names.every(one => one.startsWith("standing-orders-export-"))).toBe(true);
    expect(names.some(one => one.endsWith("/manifest.json"))).toBe(true);
    expect([...files.values()].some(one => one.includes(apiToken))).toBe(false);
  } finally {
    store = openStore(file);
  }
  expect(store.handle.prepare("SELECT actor, detail FROM action_ledger WHERE action = 'everything exported' ORDER BY id").all()).toEqual([
    { actor: "command line", detail: "as a folder" }, { actor: "command line", detail: "as a .zip" },
  ]);
  expect(existsSync(join(dir, "out", "README.md"))).toBe(true);
});

test("Settings → Data downloads the .zip behind the password, for an instance operator only, and the ledger records it", async () => {
  const { password } = seed();
  const sam = addApprover(store, "sam", NOW, { name: "alex", token: password });
  if (!sam.ok) throw new Error("sam");
  expect(store.setAccountProjects("sam", [REPO], "alex", NOW)).toEqual({ ok: true });
  const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: REPO, configDir: dir, telegramTokenFile: join(dir, "telegram-token") });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const signIn = async (name: string, token: string) => (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" }))
      .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
    const cookie = await signIn("alex", password);
    expect(await (await fetch(`${base}/settings`, { headers: { cookie } })).text()).toContain('href="/settings/data"');
    const page = await (await fetch(`${base}/settings/data`, { headers: { cookie } })).text();
    expect(page).toContain("<h1>Data</h1>");
    expect(page).toContain('name="password"');
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)![1]!;
    const post = (fields: Record<string, string>) => fetch(`${base}/settings/data`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, ...fields }), redirect: "manual" });
    const refused = await post({ password: "wrong" });
    expect(refused.status).toBe(303);
    expect(refused.headers.get("location")).toContain("/settings/data?problem=");
    expect(store.handle.prepare("SELECT 1 FROM action_ledger WHERE action = 'everything exported'").get()).toBeUndefined();
    const download = await post({ password });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/zip");
    expect(download.headers.get("content-disposition")).toMatch(/^attachment; filename="standing-orders-export-.+\.zip"$/);
    const files = unzip(Buffer.from(await download.arrayBuffer()));
    const manifest = [...files.entries()].find(([name]) => name.endsWith("/manifest.json"))![1];
    expect(JSON.parse(manifest.toString("utf8"))).toMatchObject({ generatedBy: "alex" });
    const all = [...files.values()].map(one => one.toString("utf8")).join("\n");
    expect(all).not.toContain(password);
    expect(all).not.toContain(PLANTED.webhook);
    expect(store.handle.prepare("SELECT actor, detail FROM action_ledger WHERE action = 'everything exported'").all()).toEqual([{ actor: "alex", detail: "downloaded as a .zip" }]);
    // Someone who isn't an instance operator can't see the page or download.
    const samCookie = await signIn("sam", sam.token);
    expect((await fetch(`${base}/settings/data`, { headers: { cookie: samCookie }, redirect: "manual" })).status).toBe(403);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("a private key goes whole: header, body and footer, and a Telegram keyboard's callback tokens aren't exported", async () => {
  const { redactKeyShapes } = await import("./export.js");
  const body = ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "BKcwggSjAgEAAoIBAQC7o4qne60TB3wo"].join("\n");
  const pem = [k("-----BEGIN ", "PRIVATE KEY-----"), body, k("-----END ", "PRIVATE KEY-----")].join("\n");
  const out = redactKeyShapes(`here it is:\n${pem}\nthanks`);
  expect(out).toBe("here it is:\n[redacted]\nthanks");
  expect(out).not.toContain("MIIEvQ");
});
