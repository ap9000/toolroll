import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../cli.js";
import { ENVELOPE_VERSION, envelopeJson } from "../envelope.js";
import { runOperate } from "../operate.js";
import { REMOTE_ARGUMENTS } from "../operate-remote-arguments.js";
import { REMOTE_REFUSED_FLAGS } from "../operate-remote.js";
import { COMMAND_ENTRIES, COMMAND_GUIDE, GUIDE_INVOCATIONS, REMOTE_POLICY, REMOTE_POLICY_COUNT } from "../surface.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { checkedEnvelopeJson, COMMAND_OUTPUTS, commandOutputSchema, commandRowSchema, envelopeProblems, envelopeSchema } from "./cli.js";

const T0 = new Date("2026-08-13T22:00:00.000Z");
const FIXTURE = new URL("../../test/fixtures/cli/envelopes.txt", import.meta.url);
const offline = { fetch: async () => { throw new Error("offline"); } };
const quickGit = async () => ({ code: 1, stdout: "", stderr: "", timedOut: false, notFound: true });

/** The production check: the path-named lines `checkedEnvelopeJson` logs. */
const read = (input: unknown): SampleVerdict => {
  const problems = envelopeProblems(input);
  return problems.length === 0 ? { ok: true } : { ok: false, lines: problems };
};

/** Each recorded answer in the byte fixture: its command line and the envelope it wrote. */
function recorded(): { argv: string; envelope: Record<string, unknown> }[] {
  return readFileSync(FIXTURE, "utf8").split(/\n\n(?=\$ )/).map(block => {
    const [argv = "", ...body] = block.split("\n");
    return { argv, envelope: JSON.parse(body.join("\n")) as Record<string, unknown> };
  });
}

const refusal = (command: string) => ({ envelopeVersion: ENVELOPE_VERSION, ok: false, command, reason: "usage", message: "Use it properly." });

describe("the CLI's machine contract", () => {
  it("holds: the envelope's JSON Schema round trip loses nothing, recorded answers pass, malformed ones are named by path", () => {
    const answers = recorded();
    expect(answers.length).toBeGreaterThanOrEqual(20);
    const integration = { key: "telegram", group: "chat", name: "Telegram", state: "maybe", account: null, detail: null, checked: true, checkedAt: null, lastSuccessAt: null, lastError: null, lastErrorAt: null, usedBy: [], action: { kind: "setup", label: "Set up" } };
    const status = answers.find(one => one.envelope["command"] === "status" && one.envelope["ok"] === true)!.envelope;
    const { projects: _projects, ...withoutProjects } = status;
    assertContract({
      schema: envelopeSchema,
      read,
      valid: [
        ...answers.map(one => ({ name: one.argv, input: one.envelope })),
        { name: "a key a newer Toolroll adds", input: { ...status, somethingNew: [1, 2] } },
        { name: "a command outside the guide", input: { envelopeVersion: 1, ok: true, command: "runner reap", recovered: [] } },
      ],
      invalid: [
        { name: "no envelope version", input: { ok: true, command: "status" }, paths: ["envelopeVersion"] },
        { name: "a newer envelope", input: { envelopeVersion: 2, ok: true, command: "status" }, paths: ["envelopeVersion"] },
        { name: "ok as text", input: { envelopeVersion: 1, ok: "yes", command: "status" }, paths: ["ok"] },
        { name: "no command", input: { envelopeVersion: 1, ok: true }, paths: ["command"] },
        { name: "a refusal without its reason", input: { envelopeVersion: 1, ok: false, command: "status", message: "no" }, paths: ["reason"] },
        { name: "status without projects", input: withoutProjects, paths: ["projects"] },
        { name: "an integration in no state", input: { envelopeVersion: 1, ok: true, command: "integrations", integrations: [integration], counts: { connected: 0, "not-set-up": 0, broken: 0 } }, paths: ["integrations[0].state"] },
        { name: "a task in no state", input: { envelopeVersion: 1, ok: true, command: "task show", ...(answers.find(one => one.envelope["command"] === "task show" && one.envelope["ok"])!.envelope), task: { id: "t", title: "t", state: "sleeping", createdAt: "", updatedAt: "", priority: 0 } }, paths: ["task.state"] },
      ],
    });
  });

  it("gives every declared command its own answer schema, in guide order, and generates the guide from them", () => {
    expect(COMMAND_GUIDE).toEqual(COMMAND_ENTRIES.map(entry => entry.guide));
    expect(COMMAND_ENTRIES.length).toBe(224);
    const names = COMMAND_ENTRIES.map(entry => entry.guide.envelopeCommand ?? entry.guide.invocation);
    expect(new Set(names).size, "two rows answer as one command").toBe(names.length);
    for (const [index, entry] of COMMAND_ENTRIES.entries()) {
      const name = names[index]!;
      expect(commandRowSchema.safeParse(entry.guide).success, name).toBe(true);
      expect(entry.output, name).toBe(commandOutputSchema(name));
      expect(entry.output.safeParse(refusal(name)).success, `${name} refuses its own refusal`).toBe(true);
      expect(entry.output.safeParse(refusal(`${name} other`)).success, `${name} reads another command's answer`).toBe(false);
    }
    // A command that names its fields is declared in the guide, and answers only as itself.
    for (const [name, schema] of Object.entries(COMMAND_OUTPUTS)) {
      expect(names, name).toContain(name);
      expect(schema.safeParse(refusal(name)).success, name).toBe(true);
      expect(schema.safeParse(refusal(name === "status" ? "ready" : "status")).success, name).toBe(false);
    }
  });

  it("says for every command row whether it may run remotely, classified once by name", () => {
    // Each row names its policy exactly once; a classification naming no row is stale.
    expect(REMOTE_POLICY_COUNT, "a row is classified twice").toBe(REMOTE_POLICY.size);
    expect(GUIDE_INVOCATIONS.filter(invocation => !REMOTE_POLICY.has(invocation)), "rows without a remote policy").toEqual([]);
    expect([...REMOTE_POLICY.keys()].filter(invocation => !GUIDE_INVOCATIONS.includes(invocation)), "policies for no row").toEqual([]);
    for (const { guide } of COMMAND_ENTRIES) expect(["yes", "no", "step-up"], guide.invocation).toContain(guide.remote);
    // The schema itself demands it.
    const { remote: _remote, ...unclassified } = COMMAND_GUIDE.find(row => row.invocation === "status")!;
    expect(commandRowSchema.safeParse(unclassified).success).toBe(false);
    expect(commandRowSchema.safeParse({ ...unclassified, remote: "maybe" }).success).toBe(false);
    const policy = (invocation: string) => COMMAND_GUIDE.find(row => row.invocation === invocation)?.remote;
    // The filed minimums: this machine's infrastructure never runs remotely; approvals, people and policy are a step-up.
    for (const invocation of ["up", "serve", "daemon", "watch", "bridge", "tick", "mcp", "models update", "setup show", "setup clear", "onboard", "update", "link",
      "repos add", "keys status", "keys set", "keys clear", "keys verify", "keys auth", "providers", "publish", "publish merge", "publish grant", "runner register",
      "runner retire", "runner bind", "runner capacity", "enroll", "reap", "demo", "", "pulls", "graph"]) expect(policy(invocation), invocation).toBe("no");
    for (const invocation of ["task approve", "task regate", "routine approve", "decide", "people list", "people invite", "people projects", "people revoke",
      "mode show", "mode set", "mode revoke", "chat-approval on", "config set", "verify set"]) expect(policy(invocation), invocation).toBe("step-up");
    // A person's own API tokens are a password step-up, never a token's act: a token can't make, list, revoke or rotate one.
    for (const invocation of ["tokens create", "tokens list", "tokens revoke", "tokens rotate"]) expect(policy(invocation), invocation).toBe("step-up");
    for (const invocation of ["status", "task add", "task show", "task list"]) expect(policy(invocation), invocation).toBe("yes");
  });

  it("requires an explicit argument audit for every remotely allowed command", () => {
    const yes = COMMAND_GUIDE.filter(row => row.remote === "yes");
    expect([...REMOTE_ARGUMENTS.keys()].sort()).toEqual(yes.map(row => row.invocation).sort());
    for (const row of yes) {
      const audit = REMOTE_ARGUMENTS.get(row.invocation)!;
      for (const flag of row.flags ?? []) {
        expect(audit.flags.has(flag.name) || REMOTE_REFUSED_FLAGS.has(flag.name), `${row.invocation} --${flag.name} needs a remote audit`).toBe(true);
      }
      for (const [index, positional] of (row.positionals ?? []).entries()) {
        expect(audit.positionals[index]?.name, `${row.invocation} ${positional.name} needs a remote audit`).toBe(positional.name);
      }
    }
  });

  it("writes exactly what envelopeJson writes, logging a disagreement and never throwing", () => {
    const logged = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const wrong = { ok: true, command: "status", generatedAt: 7 };
      expect(checkedEnvelopeJson(wrong)).toBe(envelopeJson(wrong));
      expect(String(logged.mock.calls[0]?.[0])).toMatch(/^toolroll status --json: its answer disagrees with its schema — generatedAt: must be a string/);
      logged.mockClear();
      const fine = { ok: false, command: "task show", reason: "unknown-task", message: "no task `x`" };
      expect(checkedEnvelopeJson(fine)).toBe(envelopeJson(fine));
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("marks item 14 partly done in the plan", () => {
    const plan = readFileSync(new URL("../../docs/plans/zod-revamp.md", import.meta.url), "utf8");
    expect(plan).toMatch(/\| 14 ◐ partly done \| \*\*CLI JSON input\/output\*\*/);
    expect(plan).toMatch(/^- \*\*14\. CLI JSON input and output\*\* — partly done \(2026-10-06\)\./m);
  });
});

describe("the CLI's --json bytes", () => {
  // Only the clock is fixed, so a scan's and a notification's own timestamps repeat.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  /** Each sample's exact bytes, with the temporary folder written as <dir>. */
  async function samples(): Promise<string> {
    const dir = realpathSync(await mkdtemp(join(tmpdir(), "toolroll-cli-bytes-")));
    const db = join(dir, "orders.db"), repo = join(dir, "shop");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    const out: string[] = [];
    const options = { databaseFile: db, now: T0, gitRunner: quickGit, releaseIo: offline, integrationIo: { env: {}, repos: [repo] } } as Parameters<typeof runOperate>[3];
    const record = async (argv: readonly string[], run: (write: (line: string) => void) => Promise<number>) => {
      const lines: string[] = [];
      const code = await run(line => lines.push(line));
      out.push(`$ ${argv.join(" ")} → ${code}\n${lines.join("\n")}`.split(dir).join("<dir>"));
    };
    const operate = (argv: readonly string[]) => record(argv, write => runOperate(argv[0]!, argv.slice(1), write, options));
    const cli = (argv: readonly string[]) => record(argv, write => main([...argv], write));
    try {
      await cli(["contract", "--json"]);
      await cli(["contract", "--commands", "--json"]);
      await cli(["contract", "--bogus", "--json"]);
      await cli([dir, "--json", "--local"]);
      await operate(["task", "add", "Tidy the README", "--id", "t-readme", "--repo", repo, "--json"]);
      await operate(["task", "add", "Fix the login form", "--id", "t-login", "--repo", repo, "--json"]);
      await operate(["task", "list", "--json"]);
      await operate(["task", "show", "t-readme", "--json"]);
      await operate(["task", "show", "no-such-task", "--json"]);
      await operate(["task", "hold", "t-login", "--reason", "waiting on design", "--json"]);
      await operate(["task", "wait", "--json"]);
      await operate(["status", "--json"]);
      await operate(["status", "--bogus", "--json"]);
      await operate(["ready", "--json"]);
      await operate(["integrations", "--saved", "--json"]);
      await operate(["flows", "list", "--json"]);
      await operate(["flows", "show", "no-such-flow", "--json"]);
      await operate(["grants", "--json"]);
      await operate(["runner", "list", "--json"]);
      await operate(["routine", "list", "--json"]);
      await operate(["outbox", "list", "--json"]);
      await operate(["incident", "list", "--json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return `${out.join("\n\n")}\n`;
  }

  // The recorded file was written by the code before item 14: the same state answers with the same bytes.
  it("keeps every sampled answer's exact bytes", async () => {
    await expect(await samples()).toMatchFileSnapshot("../../test/fixtures/cli/envelopes.txt");
  });
});
