/**
 * D5: the central team CLI and native coding sessions were deprecated in 0.9.56 and are removed. Every legacy command
 * below answers with one removal line (one envelope with --json), runs nothing and is hidden from help and the command
 * contract. `connect` still saves a profile, with its warning. The local lead's own commands stay visible and quiet.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { main } from "./cli.js";
import { maybeRunConnectCommand } from "./connect-cli.js";
import { deprecationWarning, removedMessage } from "./deprecations.js";

/** The exact legacy inventory: each invocation and the words its warning names. */
const TEAM: readonly { argv: string[]; named: string }[] = [
  ...["list", "create", "update", "member", "transfer"].map(action => ({ argv: ["lead", action], named: `lead ${action}` })),
  ...["list", "create", "show", "member", "edit", "withdraw", "read", "follow", "stop"].map(action => ({ argv: ["conversation", action], named: `conversation ${action}` })),
  { argv: ["chat", "--lead", "l1", "--conversation", "c1"], named: "chat --conversation" },
  { argv: ["brief", "--lead", "l1", "--conversation", "c1"], named: "brief --conversation" },
];
const SESSION: readonly { argv: string[]; named: string }[] =
  ["capabilities", "list", "show", "changes", "start", "send", "stop", "resume", "recover"].map(action => ({ argv: ["session", action], named: `session ${action}` }));

describe("removed central team and native session commands", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "toolroll-deprecated-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const run = async (argv: readonly string[]) => {
    const stdout: string[] = [], stderr: string[] = [];
    const team = { profileFile: join(dir, "profiles.json"), stderr: (line: string) => stderr.push(line), fetch: (() => { throw new Error("no network in this test"); }) as typeof fetch };
    const code = await main([...argv], line => stdout.push(line), { connect: team, remote: team });
    return { code, stdout, stderr };
  };

  test.each([...TEAM, ...SESSION])("$named answers that it was removed, as one --json envelope, and runs nothing", async ({ argv, named }) => {
    const kind = argv[0] === "session" ? "session" : "team";
    const { code, stdout, stderr } = await run([...argv, "--json"]);
    expect(code).toBe(2);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: false, reason: "removed", message: removedMessage(named, kind) });
    const plain = await run([...argv]);
    expect(plain.stdout).toEqual([removedMessage(named, kind)]);
  });

  test("connect still saves a profile path and warns once on stderr", async () => {
    const { code, stdout, stderr } = await run(["connect", "--json"]);
    expect(code).toBe(2);
    expect(stderr.filter(line => line.startsWith("Warning:"))).toEqual([deprecationWarning("connect", "team")]);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: false, code: "usage" });
  });

  test("the local lead's commands never warn", async () => {
    const db = join(dir, "orders.db");
    for (const argv of [["lead", "--db", db], ["lead", "token", "--db", db], ["lead", "say", "on it", "--db", db], ["brief", "--db", db], ["brief", "--local", "--db", db]]) {
      const { stderr } = await run([...argv, "--json"]);
      expect(stderr.filter(line => line.startsWith("Warning:")), argv.join(" ")).toEqual([]);
    }
  });

  test("help and the command contract name none of them, and keep the local lead's", async () => {
    const help: string[] = [];
    await main(["help"], line => help.push(line));
    const text = help.join("\n");
    for (const hidden of [/toolroll session\b/, /toolroll connect\b/, /toolroll conversation\b/, /toolroll lead +named leads/, /--lead <id> --conversation/]) expect(text).not.toMatch(hidden);
    expect(text).toContain("toolroll lead token");
    expect(text).toContain('toolroll lead say "<text>"');

    const contract: string[] = [];
    expect(await main(["contract", "--commands", "--json"], line => contract.push(line))).toBe(0);
    const invocations = (JSON.parse(contract.join("\n")) as { commands: { invocation: string }[] }).commands.map(one => one.invocation);
    for (const legacy of [...TEAM, ...SESSION].map(one => one.named.replace(/ --conversation$/, ""))) {
      if (legacy === "chat" || legacy === "brief") continue;
      expect(invocations, legacy).not.toContain(legacy);
    }
    expect(invocations).toEqual(expect.arrayContaining(["lead token", "lead say", "chat", "brief"]));
    expect(invocations.some(one => one.startsWith("session ") || one.startsWith("conversation "))).toBe(false);

    const capabilities: string[] = [];
    await main(["contract", "--json"], line => capabilities.push(line));
    expect(capabilities.join("\n")).not.toContain("session-client");
  });
});

describe("what the removal must keep (slim review)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "toolroll-removed-keep-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const secret = "s3cret-token-value-0123456789";
  const reply = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as unknown as typeof fetch;
  const connect = async (fetcher: typeof fetch) => {
    const stdout: string[] = [];
    const code = await maybeRunConnectCommand(["connect", "https://central.example", "--as", "alex", "--token-stdin", "--json"], line => stdout.push(line),
      { profileFile: join(dir, "profiles.json"), stderr: () => undefined, readStdin: async () => secret, fetch: fetcher });
    return { code, stdout, saved: existsSync(join(dir, "profiles.json")) };
  };
  const snapshot = { leads: [], conversations: [], selected: null, participants: [], messages: [], canManage: false, canSend: false, cursor: 0, truncated: false, projects: [], accounts: [] };

  test("a chat with a saved central profile is refused as removed, never run against this computer's lead", async () => {
    const file = join(dir, "profiles.json");
    writeFileSync(file, JSON.stringify({ version: 1, active: "default", profiles: { default: { origin: "https://central.example", account: "alex", token: secret } } }), { mode: 0o600 });
    const stdout: string[] = [];
    const team = { profileFile: file, stderr: () => undefined, fetch: (() => { throw new Error("no network in this test"); }) as typeof fetch };
    expect(await main(["chat", "--say", "Continue the work", "--json"], line => stdout.push(line), { connect: team, remote: team })).toBe(2);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: false, reason: "removed", message: removedMessage("chat --conversation", "team") });
  });

  test("connect never shows the credential a server's refusal echoes", async () => {
    const { code, stdout } = await connect(reply({ version: 1, ok: false, code: "forbidden", message: `The token ${secret} is not valid.` }, 403));
    expect(code).toBe(1);
    expect(stdout.join("\n")).not.toContain(secret);
    expect(JSON.parse(stdout[0]!).message).toBe("The token [redacted] is not valid.");
  });

  test("connect saves nothing on a success without a well-formed listing, and saves on one with it", async () => {
    const bare = await connect(reply({ version: 1, ok: true, code: "ok", message: "ok" }));
    expect(bare.code).toBe(1);
    expect(JSON.parse(bare.stdout[0]!)).toMatchObject({ ok: false, code: "service-unavailable" });
    expect(bare.saved).toBe(false);
    const broken = await connect(reply({ version: 1, ok: true, code: "ok", message: "ok", snapshot: { ...snapshot, messages: [{ id: "x" }] } }));
    expect(broken.code).toBe(1);
    expect(broken.saved).toBe(false);
    const good = await connect(reply({ version: 1, ok: true, code: "ok", message: "ok", snapshot }));
    expect(good.code).toBe(0);
    expect(good.saved).toBe(true);
  });
});
