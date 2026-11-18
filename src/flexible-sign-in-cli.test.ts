/**
 * `toolroll config set|clear|show flexible-sign-in` (operate.ts flexibleSignInConfig): your own Claude sign-in for
 * threads from a hidden prompt only (the prompt is the test's stand-in: easySeams.askHidden), a person's act with their
 * password, never a value on the command line. Isolated store and state folder; made-up tokens; no model.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { setFlexibleSetting } from "./flexible-available.js";
import { hashPassword } from "./scope.js";
import { mintApiToken } from "./api-tokens.js";
import { runOperate, EXIT } from "./operate.js";
import { standInToken } from "../test/flexible-sign-in-kit.js";

const NOW = new Date();
const PASSWORD = "alex-password-1";
let dir: string, state: string, file: string, store: Store, actToken: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-sign-in-cli-")));
  state = join(dir, "toolroll");
  mkdirSync(state);
  file = join(state, "orders.db");
  store = openStore(file);
  store.saveApprover("alex", hashPassword(PASSWORD), NOW);
  store.saveApprover("vic", hashPassword("vic-password-1"), NOW);
  store.handle.prepare("UPDATE approver SET role = 'viewer' WHERE name = 'vic'").run();
  setFlexibleSetting(store, true, "alex", NOW);
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account: "alex", name: "act", secretHash: minted.hash, access: "act", expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(), by: "alex" }, NOW);
  actToken = minted.token;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** One CLI run, as JSON, with a stand-in hidden prompt that answers `paste` (and records what it was asked). */
async function cli(args: string[], paste: string | null, env: Record<string, string> = {}): Promise<{ code: number; out: Record<string, unknown>; asked: string[]; raw: string }> {
  const lines: string[] = [], asked: string[] = [];
  const saved = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
  Object.assign(process.env, env);
  try {
    const code = await runOperate("config", [...args, "--json"], line => lines.push(line), { databaseFile: file,
      ...(paste === null ? {} : { easySeams: { askHidden: async (question: string) => { asked.push(question); return paste; } } }) });
    const raw = lines.join("\n");
    return { code, out: JSON.parse(raw) as Record<string, unknown>, asked, raw };
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
}
const rows = () => store.handle.prepare("SELECT person, state FROM flexible_sign_in ORDER BY staged_at").all().map(row => ({ ...row }));
const ledger = () => store.handle.prepare("SELECT actor, outcome FROM action_ledger WHERE action = 'claude sign-in for threads' ORDER BY id").all().map(row => ({ ...row }));
const files = () => { const at = join(state, "tool-secrets", "flexible-sign-in"); return existsSync(at) ? readdirSync(at) : []; };
const as = (name = "alex", password = PASSWORD) => ["--as", name, "--token", password];

describe("config set flexible-sign-in", () => {
  test("a value on the command line is refused before anything else (and said to be in shell history); nothing is asked or kept", async () => {
    const token = standInToken();
    for (const args of [["set", "flexible-sign-in", token, ...as()], ["set", "flexible-sign-in", ...as("alex", token)], ["set", "flexible-sign-in", "--as", token]]) {
      const refused = await cli(args, standInToken());
      expect(refused.code).toBe(EXIT.usage);
      expect(refused.out).toMatchObject({ ok: false, reason: "argument" });
      expect(String(refused.out["message"])).toContain("claude setup-token");
      expect(refused.asked).toEqual([]);
      expect(refused.raw).not.toContain(token.slice(14, 30));
    }
    expect(await cli(["set", "flexible-sign-in", "extra", ...as()], standInToken())).toMatchObject({ code: EXIT.usage, out: { reason: "usage" }, asked: [] });
    expect(rows()).toEqual([]);
    expect(files()).toEqual([]);
  });

  test("a person's act with their own password only: a lead's or remote token, an API token, a wrong password, a viewer: refused, nothing kept or ledgered", async () => {
    const token = standInToken();
    for (const [args, env] of [
      [as(), { TOOLROLL_LEAD_TOKEN: "lt_x" }],
      [as(), { TOOLROLL_REMOTE_TOKEN: actToken }],
      [as("alex", actToken), {}],
      [as("alex", "not-it"), {}],
      [as("vic", "vic-password-1"), {}],
    ] as [string[], Record<string, string>][]) {
      const refused = await cli(["set", "flexible-sign-in", ...args], token, env);
      expect(refused.code, JSON.stringify([args[1], env])).toBe(EXIT.refused);
      expect(refused.raw).not.toContain(token.slice(14, 30));
    }
    expect(rows()).toEqual([]);
    expect(files()).toEqual([]);
    expect(ledger()).toEqual([]);
  });

  test("saved from the hidden prompt (a wrapped paste too), replaced, shown and cleared; an API key or garbage is refused without quoting it; no terminal asks nothing", async () => {
    const first = standInToken(), second = standInToken();
    expect(await cli(["set", "flexible-sign-in", ...as()], null)).toMatchObject({ code: EXIT.usage, asked: [] });
    const key = ["sk", "ant", "api03", "q".repeat(40)].join("-");
    const keyed = await cli(["set", "flexible-sign-in", ...as()], key);
    expect(keyed).toMatchObject({ code: EXIT.refused, out: { reason: "api-key" } });
    expect(keyed.raw).not.toContain("q".repeat(8));
    expect(await cli(["set", "flexible-sign-in", ...as()], "not a token at all")).toMatchObject({ code: EXIT.refused, out: { reason: "shape" } });
    expect(rows()).toEqual([]);

    const saved = await cli(["set", "flexible-sign-in", "--no-check", ...as()], `${first.slice(0, 30)}\n${first.slice(30)}`);
    expect(saved).toMatchObject({ code: EXIT.ok, out: { ok: true, saved: true, replaced: false, check: "not-checked", signIn: { state: "active" } } });
    expect(saved.asked).toEqual(["Paste the token from `claude setup-token`: "]);
    expect(saved.raw).not.toContain(first.slice(14, 30));
    expect(await cli(["set", "flexible-sign-in", ...as()], second)).toMatchObject({ code: EXIT.ok, out: { replaced: true } });
    expect(rows()).toEqual([{ person: "alex", state: "active" }]);
    expect(files()).toHaveLength(1);
    expect(await cli(["show", "flexible-sign-in", ...as()], null)).toMatchObject({ code: EXIT.ok, out: { signIn: { state: "active", check: "not-checked" } } });
    expect(await cli(["show", "flexible-sign-in", ...as("alex", "not-it")], null)).toMatchObject({ code: EXIT.refused });
    expect(await cli(["clear", "flexible-sign-in", ...as()], null)).toMatchObject({ code: EXIT.ok, out: { removed: true } });
    expect(rows()).toEqual([]);
    expect(files()).toEqual([]);
    expect(await cli(["show", "flexible-sign-in", ...as()], null)).toMatchObject({ code: EXIT.ok, out: { signIn: { state: "none" } } });
    expect(ledger().map(row => row["outcome"])).toEqual(["saved", "replaced", "retired", "removed", "retired"]);
    const everything = JSON.stringify(store.handle.prepare("SELECT * FROM action_ledger").all()) + JSON.stringify(store.handle.prepare("SELECT * FROM flexible_sign_in").all());
    for (const value of [first, second]) expect(everything).not.toContain(value.slice(14, 30));
  });
});
