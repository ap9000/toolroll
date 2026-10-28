/**
 * One console where every action a page visit used to take would fire (docs/plans/get-side-effects.md): an open
 * sign-in pause a probe has seen signed out (the next "connected" probe lifts it and resumes work), the lead on by
 * default with no lead yet, a lead turn past its deadline (settling it writes spend), a never-checked model list, a
 * git project, and every probe seam reporting to `note`. Shared by src/server/get-quiet*.test.ts and the attack suite.
 *
 * The caller mocks node:child_process, node:https and fetch so they report to the same `note`.
 */
import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../src/store.js";
import { addApprover } from "../src/scope.js";
import { createDecisionServer } from "../src/serve.js";
import type { ServeOptions } from "../src/server/http.js";
import { setLimitOverride } from "../src/request-budget.js";
import { modeDigestOf, modeTermsJson, presetTerms } from "../src/modes.js";

export const QUIET_T0 = new Date("2026-10-27T12:00:00.000Z");

/** What a read may write (the plan's "Allowed bookkeeping"): whole tables, and per-row exceptions. */
const BOOKKEEPING_TABLES = ["action_ledger", "ledger_seal", "request_budget_usage", "agent_seen", "run_efficiency", "ceremony_nonce", "agent_view", "oauth_client", "oauth_code"];
const bookkeepingRow = (table: string, row: Record<string, unknown>): Record<string, unknown> | null => {
  if (table === "service_cursor" && row["key"] === "workspace-content:v1") return null;
  if (table === "installation_fact" && row["key"] === "first-success-at") return null;
  if (table === "web_session") { const { last_seen: _seen, ...kept } = row; return kept; }
  if (table === "credential") { const { last_used_at: _used, ...kept } = row; return kept; }
  return row;
};

export type QuietWorld = Awaited<ReturnType<typeof openQuietWorld>>;

export async function openQuietWorld(note: (what: string) => void, extra: Partial<ServeOptions> = {}) {
  let signedIn = false;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "so-getquiet-")));
  const repo = join(root, "repo"); mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const configDir = join(root, "config"); mkdirSync(configDir);
  const store: Store = openStore(join(configDir, "state.db"));
  const operator = addApprover(store, "alex", QUIET_T0);
  if (!operator.ok) throw Error("operator");
  setLimitOverride(store, "*", { readPerMinute: 600, actPerMinute: 600, perDay: 10000 }, "alex", QUIET_T0);
  for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", QUIET_T0);
  const made = store.createConsoleTask({ id: "one", title: "task one", repo, goal: "do one", acceptance: [{ id: "c1", statement: "one is done.", evidence: ["manual-review"] }], filedVia: "cli" }, QUIET_T0);
  if (!made.ok) throw Error(made.reason);
  store.raw().prepare("INSERT INTO provider_auth_pause (provider, ordinal, opened_at, probe_saw_out) VALUES ('claude', 1, ?, 1)").run(QUIET_T0.toISOString());
  const generation = store.accountOf("alex")!.generation;
  const leadSession = store.mintLeadSession({ approver: "alex", approverGeneration: generation, credentialKey: "k".repeat(64), ceilingMicrousd: 10_000_000, ceilingDigest: "c".repeat(64), termsDigest: "t".repeat(64) }, QUIET_T0);
  const leadThread = store.openLeadThread("alex", "c".repeat(64), QUIET_T0).thread;
  const turn = store.openLeadTurn({ approver: "alex", session: leadSession, thread: leadThread.id, credentialKey: "k".repeat(64), reservedMicrousd: 10_000, dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 1_000 }, QUIET_T0);
  if (!turn.ok) throw Error(turn.reason);
  if (!store.startLeadTurn(turn.id, QUIET_T0).ok) throw Error("start");
  writeFileSync(join(configDir, "telegram-token"), "", { mode: 0o600 });
  const server: Server = createDecisionServer({
    store, evidenceRoot: join(root, "evidence"), repo, admittedRepos: () => [repo], configDir, telegramTokenFile: join(configDir, "telegram-token"),
    leadByDefault: true, connectionHome: root, toolHome: root,
    connectionProbe: async (file: string, args: readonly string[]) => { note(`probe ${file} ${args.join(" ")}`); return signedIn
      ? { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "", timedOut: false, notFound: false }
      : { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "", timedOut: false, notFound: false }; },
    modelCatalogFetcher: (async (input: string | URL | Request) => { note(`fetch ${String(input)}`); throw new Error("offline"); }) as typeof fetch,
    modelRunner: async (command, args) => { note(`version ${command} ${args.join(" ")}`); return { code: 1, stdout: "", stderr: "" }; },
    firstTaskRunner: async (file: string, args: readonly string[]) => { note(`first-task ${file} ${args.join(" ")}`); return { code: 1, stdout: "", stderr: "", timedOut: false, notFound: true }; },
    ghList: async () => { note("gh list"); return { ok: false, reason: "gh-missing", message: "gh is not installed" } as never; },
    chatFetcher: (async (input: string | URL | Request) => { note(`chat fetch ${String(input)}`); throw new Error("offline"); }) as typeof fetch,
    subscriptionChatRunner: async () => { note("lead model"); throw new Error("no model in this test"); },
    ...extra,
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  const send = (path: string, method: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> =>
    new Promise((resolve, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, connection: "close", ...headers } }, response => {
        let text = "";
        response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode!, body: text, headers: response.headers }));
      });
      request.on("error", reject); request.end(body);
    });
  const post = (path: string, cookie: string, form: Record<string, string>, accept?: string) =>
    send(path, "POST", { cookie, origin, "content-type": "application/x-www-form-urlencoded", ...(accept === undefined ? {} : { accept }) }, new URLSearchParams(form).toString());

  return {
    store, server, port, origin, root, repo, turnId: turn.id, send, post,
    setSignedIn(value: boolean) { signedIn = value; },
    /** Sign in, and open the project so every page renders it. Returns the cookie and the session's form token. */
    async signIn(): Promise<{ cookie: string; csrf: string }> {
      const login = await send("/login", "POST", { "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams({ name: "alex", token: operator.token }).toString());
      if (login.status !== 303) throw Error(`sign-in ${login.status}`);
      const cookie = login.headers["set-cookie"]!.map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec((await send("/projects", "GET", { cookie })).body)![1]!;
      if ((await post("/projects/select", cookie, { csrf, path: repo })).status !== 303) throw Error("open project");
      return { cookie, csrf };
    },
    /** An operating mode already past its expiry: closing it (and withdrawing what it approved) is not a page's job. */
    signExpiredMode() {
      const terms = presetTerms("hands-off", new Date(QUIET_T0.getTime() + 3_600_000).toISOString());
      store.signMode({ repo, name: "hands-off", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, QUIET_T0);
    },
    openModes: () => Number(store.raw().prepare("SELECT COUNT(*) AS n FROM operating_mode WHERE revoked_at IS NULL").get()!["n"]),
    pauseOpen: () => store.raw().prepare("SELECT lifted_at FROM provider_auth_pause WHERE provider = 'claude'").get()!["lifted_at"] === null,
    notifications: () => Number(store.raw().prepare("SELECT COUNT(*) AS n FROM notification").get()!["n"]),
    /** Every table but the allowed bookkeeping, hashed. */
    snapshot(): Record<string, string> {
      const tables = store.raw().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
        .map(row => String(row["name"])).filter(name => !BOOKKEEPING_TABLES.includes(name));
      return Object.fromEntries(tables.map(table => {
        const rows = store.raw().prepare(`SELECT * FROM "${table}"`).all().map(row => bookkeepingRow(table, row)).filter(row => row !== null);
        return [table, createHash("sha256").update(JSON.stringify(rows)).digest("hex")];
      }));
    },
    changed: (before: Record<string, string>, after: Record<string, string>) => Object.keys({ ...before, ...after }).filter(key => before[key] !== after[key]),
    async close() {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
