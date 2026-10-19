/**
 * The live conversation's records (live-records.ts): what may reach the file
 * and what never does. A command's text and output only under the project's
 * opt-in; credential shapes hidden before anything is cut; paths only inside
 * the run's own checkout; steps closed only by their own result, an unknown
 * end never shown as success; and a reader that trusts nothing it reads back.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  createLiveRecorder, HIDDEN_KEY_BLOCK, HIDDEN_LINE, HIDDEN_TARGET, OUTSIDE_PROJECT, parseLiveRecord, parseLiveRecords,
  projectLiveText, redactLiveLines, serializeLiveRecord, SOME_FILE, type LiveRecord,
} from "./live-records.js";

const T = new Date("2026-10-18T12:00:00.000Z");
const recorder = (commands: boolean, base: string | null = "/pool/wt") => createLiveRecorder({ base, commands, clock: () => T });
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, content: unknown, isError?: boolean) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, ...(isError === undefined ? {} : { is_error: isError }) }] } });
const all = (r: ReturnType<typeof recorder>, events: Record<string, unknown>[]) => events.flatMap(event => r.observe(event));
const onDisk = (records: LiveRecord[]) => records.map(serializeLiveRecord).join("\n");

describe("what reaches the file", () => {
  test("with commands hidden, no command text and no output is ever recorded — only the step and how it ended", () => {
    const r = recorder(false);
    const records = all(r, [tool("a", "Bash", { command: "cat .env && npm test" }), result("a", "API_TOKEN=abc123\nall passed")]);
    expect(records).toEqual([
      { k: "step", at: T.toISOString(), id: "s1", kind: "command" },
      { k: "done", at: T.toISOString(), id: "s1", ok: true },
    ]);
    expect(onDisk(records)).not.toContain("npm test");
    expect(onDisk(records)).not.toContain("abc123");
    // Codex the same.
    const c = all(recorder(false), [
      { type: "item.started", item: { id: "i1", type: "command_execution", command: "bash -lc 'make deploy'" } },
      { type: "item.completed", item: { id: "i1", type: "command_execution", command: "bash -lc 'make deploy'", aggregated_output: "secret output", exit_code: 0, status: "completed" } },
    ]);
    expect(onDisk(c)).not.toMatch(/make deploy|secret output/);
  });

  test("with commands shown, a command is its first line, unwrapped, and a credential-shaped one is hidden whole", () => {
    const r = recorder(true);
    const step = (command: string) => (r.observe(tool(`t-${command.length}-${Math.random()}`, "Bash", { command }))[0] as { target?: string }).target;
    expect(step("npm test")).toBe("npm test");
    expect(step("npm run build\nnpm test")).toBe("npm run build …");
    expect(all(recorder(true), [{ type: "item.started", item: { id: "i", type: "command_execution", command: "/bin/bash -lc 'git status'" } }])[0]).toMatchObject({ target: "git status" });
    for (const secret of ["DB_PASSWORD=hunter2 npm start", "curl -H 'Authorization: Bearer abcdefghij1234' x", "curl https://u:p@host/x", "curl 'https://api.x.com/v1?access_token=abc'", "echo ghp_" + "a1".repeat(18)]) {
      expect(step(secret)).toBe(HIDDEN_TARGET);
    }
    // A secret on a later line hides the whole command, not just the first line it shows.
    expect(step("echo hi\nexport GITHUB_TOKEN=xyz")).toBe(HIDDEN_TARGET);
  });

  test("output is redacted line by line before it is cut to its tail, and a key block is hidden whole", () => {
    const r = recorder(true);
    r.observe(tool("a", "Bash", { command: "make" }));
    const noise = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const output = ["-----BEGIN OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXktdjEAAAAA", "-----END OPENSSH PRIVATE KEY-----", ...noise, "password: hunter2", "Bearer abcdefghijklmnop", "done"].join("\n");
    const [done] = r.observe(result("a", output));
    expect(done).toMatchObject({ k: "done", ok: true });
    const out = (done as { out: string[] }).out;
    expect(out).toHaveLength(20);
    expect(out.slice(-3)).toEqual([HIDDEN_LINE, HIDDEN_LINE, "done"]);
    expect(out.join("\n")).not.toMatch(/hunter2|abcdefghijklmnop|b3BlbnNz/);
    // The key block on its own, and one never closed.
    const k = recorder(true);
    k.observe(tool("b", "Bash", { command: "cat key" }));
    expect((k.observe(result("b", "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nstill key"))[0] as { out: string[] }).out).toEqual(["before", HIDDEN_KEY_BLOCK]);
  });

  test("the agent's own words are redacted the same way: generic session values, userinfo URLs and a pasted key block", () => {
    const words = recorder(false).observe({ type: "assistant", message: { content: [{ type: "text", text: [
      "Found it.", "SESSION=abc123", "cloning https://abc123@example.com/repo.git",
      "-----BEGIN PRIVATE KEY-----", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "-----END PRIVATE KEY-----", "Moving on.",
    ].join("\n") }] } });
    expect(words).toEqual([{ k: "say", at: T.toISOString(), t: ["Found it.", HIDDEN_LINE, HIDDEN_LINE, HIDDEN_KEY_BLOCK, "Moving on."] }]);
  });

  test("a key block split across messages stays hidden, a bare key body is hidden, a hash is not; a long message survives the round trip", () => {
    const r = recorder(false);
    const say = (text: string) => r.observe({ type: "assistant", message: { content: [{ type: "text", text }] } });
    expect(say("Here it is:\n-----BEGIN PRIVATE KEY-----")).toEqual([{ k: "say", at: T.toISOString(), t: ["Here it is:", HIDDEN_KEY_BLOCK] }]);
    expect(say("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----")).toEqual([]);
    expect(say("Done.")).toEqual([{ k: "say", at: T.toISOString(), t: ["Done."] }]);
    expect(say("b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABlwAAAAdzc2gtcn")[0]).toEqual({ k: "say", at: T.toISOString(), t: [HIDDEN_LINE] });
    expect(say("commit 3f2a9c1e4b5d6a7f8e9d0c1b2a3f4e5d6c7b8a9f")[0]).toMatchObject({ t: ["commit 3f2a9c1e4b5d6a7f8e9d0c1b2a3f4e5d6c7b8a9f"] });
    const long = say(Array.from({ length: 401 }, () => "x").join("\n"));
    expect(parseLiveRecords(onDisk(long)).flatMap(one => (one.k === "say" ? one.t : []))).toHaveLength(401);
  });

  test("a read, search or edit result — file contents — is never stored, even with commands shown", () => {
    const r = recorder(true);
    const records = all(r, [tool("a", "Read", { file_path: "/pool/wt/.env" }), result("a", "STRIPE_KEY=sk_live_x\nOTHER=1"), tool("b", "Grep", { pattern: "TODO" }), result("b", "src/a.ts:1: TODO", true)]);
    expect(onDisk(records)).not.toMatch(/STRIPE|OTHER|src\/a\.ts:1/);
    expect(records.filter(one => one.k === "done")).toEqual([
      { k: "done", at: T.toISOString(), id: "s1", ok: true },
      { k: "done", at: T.toISOString(), id: "s2", ok: false },
    ]);
  });

  test("a path shows relative to the run's own checkout, and anything outside it never shows", () => {
    const target = (path: string, base: string | null = "/pool/wt") => (recorder(false, base).observe(tool("a", "Edit", { file_path: path }))[0] as { target?: string }).target;
    expect(target("/pool/wt/src/a.ts")).toBe("src/a.ts");
    expect(target("src/b.ts")).toBe("src/b.ts");
    expect(target("/pool/wt/../wt-other/x.ts")).toBe(OUTSIDE_PROJECT);
    expect(target("/pool/wt-other/x.ts")).toBe(OUTSIDE_PROJECT);
    expect(target("/Users/alex/.ssh/id_rsa")).toBe(OUTSIDE_PROJECT);
    expect(target("../../etc/passwd")).toBe(OUTSIDE_PROJECT);
    expect(target("/pool/wt")).toBe(OUTSIDE_PROJECT);
    expect(target("/pool/wt/src/a.ts", null)).toBe(SOME_FILE);
    // A web fetch shows its host alone: no credentials, port, path or query.
    expect((recorder(false).observe(tool("w", "WebFetch", { url: "https://user:pw@docs.example.com:8443/a?token=x" }))[0] as { target?: string }).target).toBe("docs.example.com");
    // An unknown or MCP tool says nothing about itself, not even its name.
    expect(recorder(true).observe(tool("m", "mcp__vault__read_secret", { name: "prod" }))).toEqual([{ k: "step", at: T.toISOString(), id: "s1", kind: "tool" }]);
  });
});

describe("how a step ends", () => {
  test("only its own result closes it; duplicates, strangers and subagents change nothing", () => {
    const r = recorder(true);
    const records = all(r, [
      tool("a", "Bash", { command: "npm test" }),
      tool("a", "Bash", { command: "npm test" }),
      result("zz", "stranger"),
      { type: "assistant", parent_tool_use_id: "a", message: { content: [{ type: "tool_use", id: "sub", name: "Bash", input: { command: "rm -rf /" } }, { type: "text", text: "subagent words" }] } },
      result("a", "1 failed", true),
    ]);
    expect(records.map(one => one.k)).toEqual(["step", "done"]);
    expect(records[1]).toMatchObject({ id: "s1", ok: false, out: ["1 failed"] });
    // A subagent's own turn ending or session starting never closes this run's open step.
    const p = recorder(true);
    p.observe(tool("a", "Task", { description: "look around" }));
    expect(p.observe({ type: "result", parent_tool_use_id: "a" })).toEqual([]);
    expect(p.observe({ type: "system", subtype: "init", parent_tool_use_id: "a" })).toEqual([]);
    expect(p.observe(result("a", "found it"))).toEqual([{ k: "done", at: T.toISOString(), id: "s1", ok: true }]);
  });

  test("a turn end, a new session and the process ending close what is open as unknown — never as success", () => {
    for (const closer of [{ type: "result", subtype: "success" }, { type: "system", subtype: "init" }]) {
      const r = recorder(true);
      r.observe(tool("a", "Bash", { command: "sleep 100" }));
      expect(r.observe(closer)[0]).toEqual({ k: "done", at: T.toISOString(), id: "s1", ok: null });
    }
    const r = recorder(true);
    r.observe(tool("a", "Bash", { command: "sleep 100" }));
    expect(r.end()).toEqual([{ k: "done", at: T.toISOString(), id: "s1", ok: null }]);
    expect(r.end()).toEqual([]);
  });

  test("Codex: a nonzero exit beats 'completed', a missing exit is unknown, and a failed item is a failure", () => {
    const run = (item: Record<string, unknown>) => {
      const r = recorder(true);
      r.observe({ type: "item.started", item: { id: "i", ...item } });
      return r.observe({ type: "item.completed", item: { id: "i", ...item } })[0];
    };
    expect(run({ type: "command_execution", command: "x", exit_code: 2, status: "completed" })).toMatchObject({ ok: false });
    expect(run({ type: "command_execution", command: "x", status: "completed" })).toMatchObject({ ok: null });
    expect(run({ type: "command_execution", command: "x", exit_code: 0, status: "completed" })).toMatchObject({ ok: true });
    expect(run({ type: "mcp_tool_call", status: "failed" })).toMatchObject({ ok: false });
    // A file change that completes without having started opens and closes at once.
    const r = recorder(false);
    expect(r.observe({ type: "item.completed", item: { id: "f", type: "file_change", status: "completed", changes: [{ path: "/pool/wt/a.ts" }, { path: "/pool/wt/b.ts" }] } }))
      .toEqual([{ k: "step", at: T.toISOString(), id: "s1", kind: "edit", target: "a.ts and 1 more" }, { k: "done", at: T.toISOString(), id: "s1", ok: true }]);
  });
});

describe("reading the file back", () => {
  test("only known shapes within their caps are read, and every string is cleaned and redacted again", () => {
    const at = T.toISOString();
    expect(parseLiveRecord(JSON.stringify({ k: "say", at, t: ["fine", "PASSWORD=x", "\u001b[31mred\u001b[0m ‮evil"] }))).toEqual({ k: "say", at, t: ["fine", HIDDEN_LINE, "red evil"] });
    expect(parseLiveRecord(JSON.stringify({ k: "step", at, id: "s1", kind: "command", target: "export TOKEN=abc" }))).toEqual({ k: "step", at, id: "s1", kind: "command", target: HIDDEN_TARGET });
    expect(parseLiveRecord(JSON.stringify({ k: "done", at, id: "s1", ok: false, out: ["Bearer abcdefghijkl"] }))).toEqual({ k: "done", at, id: "s1", ok: false, out: [HIDDEN_LINE] });
    // A key block written into the file by hand is hidden whole on the way out, body and all.
    expect(parseLiveRecord(JSON.stringify({ k: "done", at, id: "s1", ok: true, out: ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA", "-----END RSA PRIVATE KEY-----", "ok"] })))
      .toEqual({ k: "done", at, id: "s1", ok: true, out: [HIDDEN_KEY_BLOCK, "ok"] });
    expect(parseLiveRecord(JSON.stringify({ k: "say", at, t: ["-----BEGIN OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXk"] }))).toEqual({ k: "say", at, t: [HIDDEN_KEY_BLOCK] });
    // However the BEGIN line is disguised — any escape form, invisible characters, look-alike letters — the body stays hidden.
    for (const begin of [
      "-----BEGIN \u001b[38:2::255:0:0mPRIVATE KEY\u001b[0m-----", "-----BEGIN \u009b31mPRIVATE KEY\u009b0m-----",
      "-----BEGIN PRI\u200bVATE KEY-----", "-----BEGIN\u200e PRIVATE\u200f KEY\u061c-----", "-----BEGIN PRIVATE\u2060 KEY\ufeff-----",
      "-----BEGIN ＰＲＩＶＡＴＥ KEY-----", "  -----begin private key-----\r", "-----BEGIN PRIVATE-KEY-----",
      "\u001b]0;-----BEGIN PRIVATE KEY-----\u0007", "\u009d0;-----BEGIN PRIVATE KEY-----\u009c", "--\u001b[0m---BEGIN PRIVATE KEY-----",
      "‐‐‐‐‐BEGIN PRIVATE KEY‐‐‐‐‐", "-----END OLD KEY----- -----BEGIN PRIVATE KEY-----",
      "-----BE\u001b]0;x\u0007GIN PRIVATE KEY-----", "-----BE\u001b7GIN PRIVATE KEY-----", "\u001b[-----BEGIN PRIVATE KEY-----",
      "-----BEGIN PRIVATE KEY-----\u001b]0;-----END PRIVATE KEY-----\u0007",
    ]) expect(redactLiveLines([begin, "YWJj", "-----END PRIVATE KEY-----", "after"]), begin).toEqual([HIDDEN_KEY_BLOCK, "after"]);
    // A BEGIN split across two lines still opens the block; a short-wrapped body line alone is hidden too.
    expect(redactLiveLines(["see -----BEG", "IN PRIVATE KEY-----", "YWJj", "-----END PRIVATE KEY-----", "after"])).toEqual(["see -----BEG", HIDDEN_KEY_BLOCK, "after"]);
    expect(redactLiveLines(["-----BE", "G", "IN PRIVATE KEY-----", "YWJj", "-----END PRIVATE KEY-----", "after"])).toEqual(["-----BE", "G", HIDDEN_KEY_BLOCK, "after"]);
    expect(redactLiveLines(["\u001b]0;-----BEG\u0007", "IN PRIVATE KEY-----", "YWJj", "-----END PRIVATE KEY-----", "after"])).toEqual(["", HIDDEN_KEY_BLOCK, "after"]);
    // A hidden line never leaves anything of itself in the carried state.
    const state = { inKey: false, tail: "" };
    redactLiveLines(["password: 1234567890123456"], state);
    expect(state.tail).toBe("|||");
    // A header's own trailing dashes never read as an END; an END counts only as a whole END line.
    expect(redactLiveLines(["-----BEGIN PRIVATE KEY-----", "ENDx", "YWJj", "-----END PRIVATE KEY-----", "after"])).toEqual([HIDDEN_KEY_BLOCK, "after"]);
    // An escape split across lines is finished before the next line is read.
    expect(redactLiveLines(["-----BE\u001b[", "31mGIN PRIVATE KEY-----", "YWJj", "-----END PRIVATE KEY-----", "after"])).toEqual(["-----BE", HIDDEN_KEY_BLOCK, "after"]);
    expect(redactLiveLines(["-----BE\u001b]0;title", "still title\u0007GIN PRIVATE KEY-----", "YWJj", "-----END PRIVATE KEY-----", "after"])).toEqual(["-----BE", HIDDEN_KEY_BLOCK, "after"]);
    expect(redactLiveLines(["MIIEowIBAAKCAQEAx9Zk3", "MIIEowIBAAKCAQEAx9Zk3bQa"])).toEqual(["MIIEowIBAAKCAQEAx9Zk3", HIDDEN_LINE]);
    // A whole key on one line, and a block whose END comes with a hyphenated label.
    expect(redactLiveLines(["-----BEGIN KEY----- YWJj -----END KEY-----", "after"])).toEqual([HIDDEN_KEY_BLOCK, "after"]);
    expect(redactLiveLines(["-----BEGIN PRIVATE-KEY-----", "YWJj", "-----END PRIVATE-KEY-----", "after"])).toEqual([HIDDEN_KEY_BLOCK, "after"]);
    // Invisible characters never reach the view at all.
    expect(redactLiveLines(["a\u200bb\u2066c\ufeff"])).toEqual(["abc"]);
    // Colour codes or controls inside the BEGIN and END lines change nothing.
    expect(redactLiveLines(["-----BEGIN \u001b[31mPRIVATE KEY\u001b[0m-----", "YWJj", "-----END\u0007 PRIVATE KEY-----", "after"])).toEqual([HIDDEN_KEY_BLOCK, "after"]);
    // Across records too: a block begun in one record hides the next record's body.
    const forged = [{ k: "say", at, t: ["-----BEGIN RSA PRIVATE KEY-----"] }, { k: "say", at, t: ["MIIEowIBAAKCAQEA"] }, { k: "say", at, t: ["-----END RSA PRIVATE KEY-----", "fine"] }];
    expect(parseLiveRecords(forged.map(one => JSON.stringify(one)).join("\n")).flatMap(one => (one.k === "say" ? one.t : []))).toEqual([HIDDEN_KEY_BLOCK, "fine"]);
    // A step's target inside an open block is hidden like any line.
    const stepped = [{ k: "say", at, t: ["-----BEGIN PRIVATE KEY-----"] }, { k: "step", at, id: "s1", kind: "search", target: "YWJj" }, { k: "say", at, t: ["-----END PRIVATE KEY-----"] }];
    // A search for a key's header is a search: it hides itself, and never hides what follows.
    const search = recorder(false);
    expect(search.observe(tool("g", "Grep", { pattern: "-----BEGIN PRIVATE KEY-----" }))[0]).toMatchObject({ target: HIDDEN_TARGET });
    expect(search.observe({ type: "assistant", message: { content: [{ type: "text", text: "No keys committed." }] } })).toEqual([{ k: "say", at: T.toISOString(), t: ["No keys committed."] }]);
    const parsed = parseLiveRecords(stepped.map(one => JSON.stringify(one)).join("\n"));
    expect(parsed.find(one => one.k === "step")).toMatchObject({ target: HIDDEN_TARGET });
    expect(JSON.stringify(parsed)).not.toContain("YWJj");
    for (const forged of [
      { k: "html", at, t: "<script>" }, { k: "step", at, id: "../x", kind: "command" }, { k: "step", at, id: "s1", kind: "Bash" },
      { k: "done", at, id: "s1", ok: "yes" }, { k: "say", at: "not a time", t: ["x"] }, { k: "say", at, t: "x" }, { k: "open", at, detail: "everything" },
    ]) expect(parseLiveRecord(JSON.stringify(forged))).toBeNull();
    expect(parseLiveRecord(JSON.stringify({ k: "say", at, t: ["x".repeat(9000)] }))).toBeNull();
    expect(parseLiveRecord("not json")).toBeNull();
    // An oversized record is written as `cut`, never as itself.
    expect(JSON.parse(serializeLiveRecord({ k: "say", at, t: Array.from({ length: 10 }, () => "y".repeat(1000)) }))).toEqual({ k: "cut", at });
  });

  test("the plain projection the run page and peek show", () => {
    const r = recorder(true);
    const records = all(r, [
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: [{ type: "text", text: "Looking at the form" }] } },
      tool("a", "Read", { file_path: "/pool/wt/src/form.ts" }), result("a", "…"),
      tool("b", "Bash", { command: "npm test" }), result("b", "1 failed", true),
      tool("c", "TodoWrite", { todos: [] }),
    ]);
    expect(projectLiveText(parseLiveRecords(onDisk(records)))).toEqual([
      "the agent session started", "Looking at the form", "→ reading `src/form.ts`", "→ running `npm test`", "  ✗ failed", "→ organizing its plan",
    ]);
  });
});

describe("an ACP agent's conversation (acp-client.ts hands each update over as {acp: update})", () => {
  const opencode = JSON.parse(readFileSync(new URL("./fixtures/acp/opencode-1.18.18.json", import.meta.url), "utf8")) as { updates: Record<string, unknown>[] };
  const acp = (update: Record<string, unknown>) => ({ acp: update });

  test("OpenCode's real turn: the command it names only in a later update is shown once, with its output under the opt-in", () => {
    const on = recorder(true, "<work>");
    const records = [...all(on, opencode.updates.map(acp)), ...on.end()];
    const steps = records.filter(one => one.k === "step");
    expect(steps).toEqual([{ k: "step", at: T.toISOString(), id: "s1", kind: "command", target: "ls -la" }]);
    const done = records.find(one => one.k === "done");
    expect(done).toMatchObject({ k: "done", id: "s1", ok: true, out: expect.arrayContaining([expect.stringContaining("notes.txt")]) });
    // Without the project's opt-in: the step shows, its command and output don't.
    const off = recorder(false, "<work>");
    const quiet = [...all(off, opencode.updates.map(acp)), ...off.end()];
    expect(quiet.filter(one => one.k === "step")).toEqual([{ k: "step", at: T.toISOString(), id: "s1", kind: "command" }]);
    expect(onDisk(quiet)).not.toContain("ls -la");
    expect(onDisk(quiet)).not.toContain("notes.txt");
  });

  test("words arrive in chunks and are shown as one message; a path outside the checkout is never named", () => {
    const r = recorder(true, "/pool/wt");
    const records = [
      ...all(r, [
        acp({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading " } }),
        acp({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "the file." } }),
        acp({ sessionUpdate: "tool_call", toolCallId: "r1", title: "read", kind: "read", status: "pending", locations: [{ path: "/pool/wt/src/a.ts" }] }),
        acp({ sessionUpdate: "tool_call_update", toolCallId: "r1", status: "completed" }),
        acp({ sessionUpdate: "tool_call", toolCallId: "r2", title: "read", kind: "read", status: "completed", locations: [{ path: "/Users/someone/.ssh/id_rsa" }] }),
        acp({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } }),
      ]),
      ...r.end(),
    ];
    expect(records.filter(one => one.k === "say").map(one => (one as { t: string[] }).t)).toEqual([["Reading the file."], ["Done."]]);
    expect(records.filter(one => one.k === "step").map(one => (one as { target?: string }).target)).toEqual(["src/a.ts", OUTSIDE_PROJECT]);
    expect(onDisk(records)).not.toContain(".ssh");
  });

  test("a call that never gets a target or starts is still shown when the run ends; permission answers are steps", () => {
    const r = recorder(true);
    const records = [
      ...all(r, [
        acp({ sessionUpdate: "tool_call", toolCallId: "h1", title: "think", kind: "think", status: "pending" }),
        acp({ sessionUpdate: "permission", toolCallId: "x", title: "rm -rf build", kind: "execute", granted: true }),
      ]),
      ...r.end(),
    ];
    expect(records.filter(one => one.k === "step")).toEqual([
      expect.objectContaining({ kind: "tool", target: "allowed once: rm -rf build", once: true }),
      expect.objectContaining({ kind: "plan", once: true }),
    ]);
    // Without the opt-in, the answer shows and the command it was about doesn't.
    const quiet = recorder(false);
    const hidden = [...all(quiet, [acp({ sessionUpdate: "permission", toolCallId: "x", title: "rm -rf build", kind: "execute", granted: false })]), ...quiet.end()];
    expect(hidden.filter(one => one.k === "step")).toEqual([expect.objectContaining({ kind: "tool", target: "refused", once: true })]);
    expect(onDisk(hidden)).not.toContain("rm -rf");
  });
});
