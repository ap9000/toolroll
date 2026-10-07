/**
 * `toolroll tokens …` (v111): a person's own API tokens from the terminal, behind their password. Synthetic people and
 * projects only; every database is a temporary file.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, hashPassword } from "./scope.js";
import { parseApiToken, secretMatches, tokenLive, tokenProjects } from "./api-tokens.js";
import { reproveRemote, remoteAllows } from "./operate-remote.js";
import { runTokensCommand, type TokensCliContext } from "./tokens-cli.js";
import { TOKEN_NOTICE_KIND, tokenNoticePass } from "./token-notices.js";
import { credentialsHtml } from "./credentials-ui.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const DAY = 86_400_000;
let dir: string, store: Store, A: string, B: string, password: string, out: string[], clock: Date;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-tokens-")));
  A = join(dir, "shop"); B = join(dir, "docs");
  for (const repo of [A, B]) { mkdirSync(repo); execFileSync("git", ["init", "-q", repo]); }
  store = openStore(join(dir, "orders.db"));
  const owner = addApprover(store, "alex", NOW);
  if (!owner.ok) throw new Error("alex");
  password = owner.token;
  store.upsertProject(A, "shop", NOW);
  store.upsertProject(B, "docs", NOW);
  out = [];
  clock = NOW;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

function context(extra: Partial<TokensCliContext> & { stdin?: string } = {}): TokensCliContext {
  return {
    store, write: line => { out.push(line); }, json: true, clock: () => clock, caller: "local", rememberedName: null,
    interactive: () => false, ask: async () => { throw new Error("prompted"); }, askHidden: async () => { throw new Error("prompted"); },
    readStdin: async limit => { const piped = extra.stdin ?? `${password}\n`; return Buffer.byteLength(piped) > limit ? null : piped; },
    ...extra,
  };
}
const tokens = (argv: string[], extra: Partial<TokensCliContext> & { stdin?: string } = {}) => {
  const parsed = new Map<string, string | true>(), positional: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const one = argv[index]!;
    if (!one.startsWith("--")) positional.push(one);
    else if (one === "--password-stdin" || one === "--json") parsed.set(one.slice(2), true);
    else parsed.set(one.slice(2), argv[++index]!);
  }
  return runTokensCommand(positional, parsed, context(extra));
};
const last = () => JSON.parse(out.at(-1)!) as Record<string, unknown>;
const create = async (name: string, more: string[] = []) => {
  expect(await tokens(["create", "--as", "alex", "--name", name, "--access", "act", "--days", "30", "--password-stdin", ...more]), out.at(-1)).toBe(0);
  return last() as { token: string; id: string; expiresAt: string; projects: string[] | null };
};
/** Everything a later command, the ledger and notifications could show. */
const everythingSaid = () => [...out.slice(1), JSON.stringify(store.actionLedger({ repos: null, limit: 500 })), JSON.stringify(store.handle.prepare("SELECT * FROM notification").all())].join("\n");

describe("toolroll tokens", () => {
  test("create shows the token once; list, revoke, the ledger and notices never show it again", async () => {
    const made = await create("laptop");
    expect(made).toMatchObject({ ok: true, command: "tokens create", name: "laptop", access: "act", projects: null, daysLeft: 30 });
    const parsed = parseApiToken(made.token)!;
    expect(parsed.id).toBe(made.id);
    // Only the hash is kept.
    const kept = store.apiTokenSecret(made.id)!;
    expect(secretMatches(parsed.secret, kept.secretHash)).toBe(true);
    expect(JSON.stringify(store.handle.prepare("SELECT * FROM api_token").all())).not.toContain(parsed.secret);

    expect(await tokens(["list", "--as", "alex", "--password-stdin"])).toBe(0);
    expect(last()).toMatchObject({ ok: true, tokens: [{ id: made.id, name: "laptop", access: "act", projects: null, lastUsedAt: null, expiresAt: made.expiresAt, stopsAt: null }] });
    expect(Object.keys((last()["tokens"] as object[])[0]!)).not.toContain("token");
    expect(await tokens(["revoke", "laptop", "--as", "alex", "--password-stdin"])).toBe(0);
    expect(last()).toMatchObject({ ok: true, id: made.id, name: "laptop" });
    expect(store.apiTokenSecret(made.id)!.row.revokedBy).toBe("alex");
    expect(await tokens(["list", "--as", "alex", "--password-stdin"])).toBe(0);
    expect(last()).toMatchObject({ tokens: [] });
    tokenNoticePass(store, new Date(NOW.getTime() + 29 * DAY));
    expect(everythingSaid()).not.toContain(parsed.secret);
    expect(everythingSaid()).not.toContain(made.token);
    // Every create and revoke is in the ledger, with who did it.
    expect(store.actionLedger({ repos: null, source: "access" }).filter(one => one.action.startsWith("API token")).map(one => [one.action, one.actor]))
      .toEqual(expect.arrayContaining([["API token created: laptop", "alex"], ["API token revoked: laptop", "alex"]]));
  });

  test("the human answer prints the token once, and the password never comes from argv, a remote caller or the lead", async () => {
    expect(await tokens(["create", "--as", "alex", "--name", "ci", "--access", "read", "--days", "90", "--password-stdin"], { json: false })).toBe(0);
    expect(out.join("\n").match(/so_[a-f0-9]{12}_[A-Za-z0-9_-]{43}/g)).toHaveLength(1);
    expect(out.join("\n")).toContain("reads in all your projects");
    for (const flag of ["--password", "--token", "--token-file", "--token-env"]) {
      out = [];
      expect(await tokens(["list", "--as", "alex", flag, "hunter2-not-real"]), flag).toBe(2);
      expect(last()).toMatchObject({ ok: false, reason: "usage" });
      expect(out.join("\n")).not.toContain("hunter2-not-real");
    }
    out = [];
    expect(await tokens(["list", "--as", "alex", "--password-stdin"], { caller: "remote" })).toBe(3);
    expect(last()).toMatchObject({ reason: "remote-refused" });
    expect(await tokens(["list", "--as", "alex", "--password-stdin"], { caller: "lead" })).toBe(3);
    expect(last()).toMatchObject({ reason: "lead-refused" });
    // No terminal and no --password-stdin: nothing is assumed, and the remembered login's password is never read.
    expect(await tokens(["list"], { rememberedName: "alex" })).toBe(2);
    // A hidden prompt at a terminal; the remembered login supplies only the name.
    let asked = "";
    expect(await tokens(["list"], { rememberedName: "alex", json: false, interactive: () => true, askHidden: async question => { asked = question; return password; } })).toBe(0);
    expect(asked).toBe("password: ");
    // A wrong password, too much piped in, a viewer's act token: refused.
    expect(await tokens(["list", "--as", "alex", "--password-stdin"], { stdin: "wrong-password\n" })).toBe(3);
    expect(last()).toMatchObject({ reason: "unauthenticated" });
    expect(await tokens(["list", "--as", "alex", "--password-stdin"], { stdin: "x".repeat(5000) })).toBe(2);
    const invite = store.mintInvite("viewer", "alex", NOW);
    store.consumeInviteAndCreateAccount({ tokenValue: invite.token, name: "casey", credentialHash: hashPassword("synthetic-viewer-pass") }, NOW);
    expect(await tokens(["create", "--as", "casey", "--name", "x", "--access", "act", "--days", "30", "--password-stdin"], { stdin: "synthetic-viewer-pass" })).toBe(3);
    expect(last()).toMatchObject({ reason: "viewer" });
    expect(await tokens(["create", "--as", "casey", "--name", "x", "--access", "read", "--days", "30", "--password-stdin"], { stdin: "synthetic-viewer-pass" })).toBe(0);
  });

  test("terms are checked against policy before the password: days, access, name and projects", async () => {
    let read = 0;
    const counted = { readStdin: async () => { read++; return password; } };
    for (const argv of [
      ["--name", "ci", "--access", "act", "--days", "400"],
      ["--name", "ci", "--access", "act"],
      ["--name", "ci", "--access", "admin", "--days", "30"],
      ["--access", "act", "--days", "30"],
      ["--name", "ci", "--access", "act", "--days", "30", "--projects", " , "],
    ]) expect(await tokens(["create", "--as", "alex", "--password-stdin", ...argv], counted), argv.join(" ")).toBe(2);
    expect(read).toBe(0);
    expect(await tokens(["create", "--as", "alex", "--name", "ci", "--access", "act", "--days", "30", "--projects", "not-a-project", "--password-stdin"])).toBe(3);
    expect(last()).toMatchObject({ reason: "unknown-project" });
    expect(store.apiTokens("alex")).toEqual([]);
  });

  test("revoke and rotate find a token by id, or by a name only one current token has", async () => {
    const first = await create("laptop"), second = await create("laptop");
    expect(await tokens(["revoke", "laptop", "--as", "alex", "--password-stdin"])).toBe(3);
    expect(last()).toMatchObject({ reason: "ambiguous" });
    expect(await tokens(["rotate", "nothing-here", "--as", "alex", "--password-stdin"])).toBe(3);
    expect(last()).toMatchObject({ reason: "not-found" });
    expect(await tokens(["revoke", first.id, "--as", "alex", "--password-stdin"])).toBe(0);
    expect(tokenLive(store.apiTokenSecret(first.id)!.row, NOW.getTime())).toBe(false);
    expect(tokenLive(store.apiTokenSecret(second.id)!.row, NOW.getTime())).toBe(true);
    // Someone else's token is not yours to revoke, by id or name.
    const sam = addApprover(store, "sam", NOW, { name: "alex", token: password });
    if (!sam.ok) throw new Error("sam");
    expect(await tokens(["revoke", second.id, "--as", "sam", "--password-stdin"], { stdin: sam.token })).toBe(3);
    expect(tokenLive(store.apiTokenSecret(second.id)!.row, NOW.getTime())).toBe(true);
  });

  test("rotate keeps the terms and end date, overlaps for 10 minutes, then the old token stops", async () => {
    const old = await create("laptop", ["--projects", "shop"]);
    clock = new Date(NOW.getTime() + DAY);
    out = [];
    expect(await tokens(["rotate", "laptop", "--as", "alex", "--password-stdin"])).toBe(0);
    const rotated = last() as { token: string; id: string; expiresAt: string; projects: string[]; replaced: { id: string; stopsAt: string } };
    expect(rotated).toMatchObject({ ok: true, command: "tokens rotate", name: "laptop", access: "act", projects: [A], expiresAt: old.expiresAt, replaced: { id: old.id, stopsAt: new Date(clock.getTime() + 10 * 60_000).toISOString() } });
    expect(rotated.token).not.toBe(old.token);
    expect(store.apiTokenSecret(rotated.id)!.row).toMatchObject({ replaces: old.id, projects: [A], expiresAt: old.expiresAt });
    const oldRow = () => store.apiTokenSecret(old.id)!.row;
    expect(oldRow()).toMatchObject({ replacedBy: rotated.id, revokedAt: null });
    // Both work inside the overlap; at its end the old one stops, before any cleanup runs.
    const before = clock.getTime() + 10 * 60_000 - 1, after = clock.getTime() + 10 * 60_000;
    expect(tokenLive(oldRow(), before)).toBe(true);
    expect(tokenLive(oldRow(), after)).toBe(false);
    expect(tokenLive(store.apiTokenSecret(rotated.id)!.row, after)).toBe(true);
    const principal = { kind: "person" as const, account: "alex", generation: store.accountOf("alex")!.generation, scope: "act" as const, tokenId: old.id, projects: [A] };
    expect(reproveRemote(store, principal, new Date(before))).toMatchObject({ ok: true });
    expect(reproveRemote(store, principal, new Date(after))).toEqual({ ok: false });
    // A replaced token can't be rotated again; its replacement can, and still never past the same end date.
    expect(await tokens(["rotate", old.id, "--as", "alex", "--password-stdin"])).toBe(3);
    expect(last()).toMatchObject({ reason: "replaced" });
    // The pass records the end, once, and the ledger names who rotated.
    expect(tokenNoticePass(store, new Date(after)).ended).toBe(1);
    expect(tokenNoticePass(store, new Date(after)).ended).toBe(0);
    expect(oldRow()).toMatchObject({ revokedBy: "system", revokedAt: new Date(after).toISOString() });
    const ledger = store.actionLedger({ repos: null, source: "access" });
    expect(ledger.find(one => one.action === "API token rotated: laptop")).toMatchObject({ actor: "alex" });
    expect(ledger.find(one => one.action === "API token revoked: laptop" && one.actor === "system")?.detail).toContain("overlap ended");
    expect(everythingSaid()).not.toContain(parseApiToken(rotated.token)!.secret);
    // Shown in the rotate answer itself, and nowhere after it.
    expect(out[0]).toContain(rotated.token);
    expect(everythingSaid()).not.toContain(rotated.token);
    // --overlap is bounded.
    expect(await tokens(["rotate", rotated.id, "--overlap", "600", "--as", "alex", "--password-stdin"])).toBe(2);
  });

  test("a project-limited token is refused outside its projects, and never wider than its person's access", async () => {
    const made = await create("shop-only", ["--projects", "shop"]);
    expect(made.projects).toEqual([A]);
    const row = store.apiTokenSecret(made.id)!.row;
    const generation = store.accountOf("alex")!.generation;
    const principal = { kind: "person" as const, account: "alex", generation, scope: "act" as const, tokenId: made.id, projects: tokenProjects(store.accountOf("alex")!.projects, row.projects) };
    expect(principal.projects).toEqual([A]);
    expect(remoteAllows(store, principal, A)).toBe(true);
    expect(remoteAllows(store, principal, B)).toBe(false);
    expect(remoteAllows(store, principal, null)).toBe(false);
    // A principal claiming more than the token's limit is refused outright.
    expect(reproveRemote(store, { ...principal, projects: null }, NOW)).toEqual({ ok: false });
    expect(reproveRemote(store, { ...principal, projects: [A, B] }, NOW)).toEqual({ ok: false });
    expect(reproveRemote(store, principal, NOW)).toMatchObject({ ok: true });
    // The limit narrows the person's access; it never keeps a project they have lost.
    expect(tokenProjects([B], [A])).toEqual([]);
    expect(tokenProjects([A, B], null)).toEqual([A, B]);
    expect(tokenProjects(null, null)).toBeNull();
  });

  test("7 and 1 days before expiry its person is told once each, in their chats and on its card", async () => {
    const made = await create("laptop");
    const sam = addApprover(store, "sam", NOW, { name: "alex", token: password });
    if (!sam.ok) throw new Error("sam");
    const notices = () => store.handle.prepare("SELECT dedupe_key, recipient, subject FROM notification WHERE kind = ?").all(TOKEN_NOTICE_KIND);
    const expires = Date.parse(made.expiresAt);
    expect(tokenNoticePass(store, new Date(expires - 8 * DAY)).sent).toEqual([]);
    expect(tokenNoticePass(store, new Date(expires - 7 * DAY)).sent).toEqual([{ token: made.id, days: 7 }]);
    expect(tokenNoticePass(store, new Date(expires - 6 * DAY)).sent).toEqual([]);
    expect(tokenNoticePass(store, new Date(expires - DAY + 1)).sent).toEqual([{ token: made.id, days: 1 }]);
    expect(tokenNoticePass(store, new Date(expires - 1)).sent).toEqual([]);
    expect(notices()).toEqual([
      { dedupe_key: `${TOKEN_NOTICE_KIND}:${made.id}:7`, recipient: "alex", subject: "Your API token laptop expires in 7 days" },
      { dedupe_key: `${TOKEN_NOTICE_KIND}:${made.id}:1`, recipient: "alex", subject: "Your API token laptop expires tomorrow" },
    ]);
    expect(store.actionLedger({ repos: null, source: "access" }).filter(one => one.action === "API token expiry notice: laptop")).toHaveLength(2);
    // A token made with less than a day left is told once; replaced and revoked tokens are told nothing.
    clock = new Date(expires - 3 * DAY);
    const replaced = await create("ci"), gone = await create("old");
    store.handle.prepare("UPDATE api_token SET expires_at = ? WHERE id IN (?, ?)").run(new Date(clock.getTime() + 12 * 3_600_000).toISOString(), replaced.id, gone.id);
    expect(await tokens(["rotate", replaced.id, "--overlap", "0", "--as", "alex", "--password-stdin"])).toBe(0);
    const replacement = (last() as { id: string }).id;
    expect(await tokens(["revoke", gone.id, "--as", "alex", "--password-stdin"])).toBe(0);
    expect(tokenNoticePass(store, clock).sent).toEqual([{ token: replacement, days: 1 }]);
    expect(tokenNoticePass(store, clock).sent).toEqual([]);
    // The card says it once, beside its projects, and never shows a secret.
    const html = credentialsHtml({ who: "alex", everyone: false, canSeeEveryone: false, sessions: [], tokens: store.apiTokens("alex"), now: clock.getTime() }, "csrf", {});
    expect(html).toContain("Expires within a day");
    expect(html.match(/Expires within a day/g)).toHaveLength(1);
    expect(html).toContain("All projects");
    expect(html).not.toMatch(/so_[a-f0-9]{12}_/);
    const soon = credentialsHtml({ who: "alex", everyone: false, canSeeEveryone: false, sessions: [], tokens: store.apiTokens("alex"), now: expires - 5 * DAY }, "csrf", {});
    expect(soon).toContain("Expires in 5 days");
  });
});
