/**
 * The provider registry: three ways to spend, one semantic request. The
 * argv dialects are asserted exactly — a drifted flag is a silent behavior
 * change in somebody's repository at 3am — and the OpenRouter overrides are
 * pinned to constants: keys never caller-supplied, values TOML-quoted, the
 * API key excluded from every shell the model itself launches.
 */

import { FINDINGS_MODEL_SCHEMA } from "./contracts/review-findings.js";
import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adapterFor, auditOf, validateSpec, reportsCost, inspectionOf, MODEL_ID, OPENROUTER_ENV_KEY, PROVIDER_IDS, MONEY_CAPABILITIES, ALL_CREDENTIAL_ENV } from "./provider.js";
import { runStreamJsonl } from "./exec.js";
import { REVIEW_OUTPUT_LIMITS } from "./structured-output.js";
import { parseReview } from "./reviewer.js";
import { evidenceRequest, isEvidenceOnlyReply } from "./review-evidence.js";
import { parseLearning } from "./project-learning.js";

const ASK = {
  phase: "build" as const,
  brief: "do the thing",
  model: null as string | null,
  maxTurns: 40,
  permissionMode: "auto",
  skipPermissions: false,
  resumeSession: null as string | null,
};

describe("argv dialects", () => {
  test("claude speaks exactly the dialect the suite has always proven", () => {
    // stream-json since arc 1: the terminal result event is the old
    // buffered envelope; only the output format (and its required
    // --verbose) changed — every other flag is byte-identical.
    expect(adapterFor("claude").argv({ ...ASK, model: "sonnet" })).toEqual([
      "-p", "do the thing",
      "--output-format", "stream-json",
      "--verbose",
      "--max-turns", "40",
      "--permission-mode", "auto",
      "--model", "sonnet",
      "--disallowedTools", "ScheduleWakeup,CronCreate,Monitor",
    ]);
    expect(adapterFor("claude").argv({ ...ASK, resumeSession: "s-1" })).toContain("--resume");
  });

  test("headless claude runs cannot schedule a wakeup, cron job or monitor (run 2085)", () => {
    for (const phase of ["build", "repair", "plan"] as const) {
      const argv = adapterFor("claude").argv({ ...ASK, phase, resumeSession: phase === "repair" ? "s-1" : null });
      expect(argv[argv.indexOf("--disallowedTools") + 1]).toBe("ScheduleWakeup,CronCreate,Monitor");
    }
    // The reviewer already runs with Read as its only tool.
    expect(adapterFor("claude").argv({ ...ASK, phase: "review" })).not.toContain("--disallowedTools");
  });

  test("codex: exec --json, sandboxed workspace-write, brief positional, resume a subcommand", () => {
    const argv = adapterFor("codex").argv({ ...ASK, model: "gpt-5-codex" });
    expect(argv[0]).toBe("exec");
    expect(argv).toContain("--json");
    expect(argv).toContain("--skip-git-repo-check");
    expect(argv).toEqual(expect.arrayContaining(["--sandbox", "workspace-write", "-m", "gpt-5-codex"]));
    expect(argv[argv.length - 1]).toBe("do the thing");
    // Never ephemeral: repair resumes persisted sessions.
    expect(argv).not.toContain("--ephemeral");

    const full = adapterFor("codex").argv({ ...ASK, skipPermissions: true });
    expect(full).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(full).not.toContain("--sandbox");

    const resumed = adapterFor("codex").argv({ ...ASK, resumeSession: "thread-1" });
    expect(resumed.slice(0, 3)).toEqual(["exec", "resume", "thread-1"]);
  });

  test("codex resume carries the sandbox as a config override — `exec resume` has no --sandbox flag (0.145.0 exits 2 before initializing)", () => {
    const resumed = adapterFor("codex").argv({ ...ASK, resumeSession: "thread-1", model: "gpt-5-codex" });
    expect(resumed).not.toContain("--sandbox");
    expect(resumed).not.toContain("-s");
    expect(resumed).toEqual(expect.arrayContaining(["-c", 'sandbox_mode="workspace-write"', "-m", "gpt-5-codex", "--json", "--skip-git-repo-check"]));
    expect(resumed[resumed.length - 1]).toBe("do the thing");
    // The same exact mode the fresh turn was sealed with, in both spellings.
    expect(adapterFor("codex").argv({ ...ASK, resumeSession: "thread-1", skipPermissions: true })).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(adapterFor("codex").argv({ ...ASK, resumeSession: "thread-1", skipPermissions: true })).not.toContain('sandbox_mode="workspace-write"');
    // A resumed reviewer correction keeps read-only isolation, as an override.
    const review = adapterFor("codex").argv({ ...ASK, resumeSession: "review-1", phase: "review" });
    expect(review).not.toContain("--sandbox");
    expect(review).toEqual(expect.arrayContaining(["--ignore-user-config", "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"']));
    expect(review).not.toContain("workspace-write");
    // A fresh turn is byte-identical to before: the flag form.
    expect(adapterFor("codex").argv({ ...ASK })).toEqual(expect.arrayContaining(["--sandbox", "workspace-write"]));
    expect(adapterFor("openrouter").argv({ ...ASK, resumeSession: "thread-2" })).not.toContain("--sandbox");
  });

  test("claude review phase keeps its resumable, cwd-confined isolation argv", () => {
    const build = adapterFor("claude").argv({ ...ASK, phase: "build" });
    expect(build).not.toContain("--strict-mcp-config");
    expect(build).not.toContain("--safe-mode");
    expect(build).not.toContain("--restricted");

    const argv = adapterFor("claude").argv({ ...ASK, phase: "review" });
    expect(argv).toEqual(
      expect.arrayContaining([
        "--restricted",
        "--safe-mode",
        "--tools", "Read",
        "--permission-prompts", "none",
        "--strict-mcp-config",
        "--mcp-config", '{"mcpServers":{}}',
      ]),
    );
    // Every ordinary flag still rides — this is additive, not a swap.
    expect(argv).toEqual(expect.arrayContaining(["--permission-mode", "auto", "--max-turns", "40"]));
    // Structured-output correction resumes this exact confined session.
    // Persistence must remain on for that resume to be real.
    expect(argv).not.toContain("--no-session-persistence");
    const resumed = adapterFor("claude").argv({ ...ASK, phase: "review", resumeSession: "review-session-1" });
    expect(resumed).toEqual(expect.arrayContaining(["--resume", "review-session-1", "--restricted", "--safe-mode", "--tools", "Read"]));
    expect(resumed).toEqual(expect.arrayContaining(["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--json-schema"]));
    expect(resumed).not.toContain("--no-session-persistence");

    // Review isolation wins even if a malformed caller asks for the global
    // autonomy bypass. Restricted mode refuses that combination itself; the
    // plane omits it so a safe review still runs instead of failing at init.
    const bypassAttempt = adapterFor("claude").argv({ ...ASK, phase: "review", skipPermissions: true });
    expect(bypassAttempt).not.toContain("--dangerously-skip-permissions");
    expect(bypassAttempt).toContain("--restricted");
  });

  test("run 1467's fix: claude review turns carry a strict --json-schema; build and codex never do", () => {
    const build = adapterFor("claude").argv({ ...ASK, phase: "build" });
    expect(build).not.toContain("--json-schema");

    const argv = adapterFor("claude").argv({ ...ASK, phase: "review" });
    const schemaIndex = argv.indexOf("--json-schema");
    expect(schemaIndex).toBeGreaterThan(-1);
    const schema = JSON.parse(argv[schemaIndex + 1] ?? "null") as Record<string, unknown>;
    // Run 1638: the API refuses a root union (`tools.N.custom.input_schema.type:
    // Field required`, and a root type beside anyOf/oneOf is refused too), so
    // the review and the evidence read request share ONE flat object whose
    // only required key is version; the parsers, not the schema, tell the
    // two shapes apart and refuse a mixed one.
    expect(schema["type"]).toBe("object");
    expect(schema["additionalProperties"]).toBe(false);
    expect(schema["required"]).toEqual(["version"]);
    for (const combinator of ["anyOf", "oneOf", "allOf", "if", "not", "$ref", "$defs"]) expect(schema).not.toHaveProperty(combinator);
    const properties = schema["properties"] as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(["comments", "criteria", "findings", "learning", "learningAssessment", "readEvidence", "version"]);
    // The build review's findings are their one schema (src/contracts/review-findings.ts), exactly.
    expect(properties["findings"]).toEqual(FINDINGS_MODEL_SCHEMA);
    expect(properties["readEvidence"]).toMatchObject({ type: "object", required: ["file", "sha256", "offset", "length"], additionalProperties: false, properties: { file: { maxLength: 100 }, sha256: { pattern: "^[0-9a-f]{64}$" }, offset: { minimum: 0 }, length: { minimum: 1, maximum: 65536 } } });
    // The exact evidence-only reply the read brief dictates is admitted by the
    // machine parser; a reply carrying readEvidence beside review fields is
    // refused by parseReview, and one with only version by both.
    const read = { file: "REVIEW-CONTEXT-ctx-1.txt", sha256: "b".repeat(64), offset: 0, length: 65536 };
    expect(evidenceRequest(JSON.stringify({ version: 1, readEvidence: read }))).toEqual(read);
    expect(isEvidenceOnlyReply(JSON.stringify({ version: 1, readEvidence: read, comments: [] }))).toBe(false);
    const mixed = parseReview(JSON.stringify({ version: 1, readEvidence: read, comments: [], criteria: [{ id: "c1", judgement: "upholds", note: "x" }] }), new Set(["src/file.ts"]), new Set(["c1"]));
    expect(mixed).toMatchObject({ ok: false, problems: [{ reason: expect.stringContaining("readEvidence must be sent alone") }] });
    expect(evidenceRequest(JSON.stringify({ version: 1 }))).toBeNull();
    expect(parseReview(JSON.stringify({ version: 1 }), new Set(["src/file.ts"]), new Set(["c1"]))).toMatchObject({ ok: false, problems: [{ reason: "comments must be an array" }] });
    expect(properties).toHaveProperty("comments");
    expect(properties).toHaveProperty("criteria");
    expect(properties["learning"]).toEqual({});
    expect(properties["learningAssessment"]).toEqual({});
    for (const field of ["comments", "criteria"] as const) {
      const shape = properties[field] as { maxItems: number; items: { properties: { note: { type: string } } } };
      expect(shape.maxItems).toBe(REVIEW_OUTPUT_LIMITS[field]);
      expect(shape.items.properties.note).toEqual({ type: "string" });
      // Run1656: Claude exhausted StructuredOutput retries on a 251-character
      // ASCII note which our own 500-unit parser accepts. The provider shape
      // must not reject native-valid notes before our correction flow sees them.
      for (const note of ["a".repeat(251), "a".repeat(500), "😀".repeat(250)]) {
        expect(parseReview(JSON.stringify({ version: 1, comments: [{ path: "src/file.ts", note }], criteria: [{ id: "c1", judgement: "cannot-tell", note }] }), new Set(["src/file.ts"]), new Set(["c1"])).ok).toBe(true);
      }
      // Transport is a permissive shape, never the semantic authority. No
      // native limit is raised and no text or judgement is silently clipped.
      const astralOverflow = "😀".repeat(251);
      expect(parseReview(JSON.stringify({ version: 1, comments: [{ path: "src/file.ts", note: astralOverflow }], criteria: [{ id: "c1", judgement: "contradicts", note: astralOverflow }] }), new Set(["src/file.ts"]), new Set(["c1"])).ok).toBe(false);
    }

    // Text limits are not duplicated in the transport (UTF-16 native notes,
    // UTF-8 learning bytes, and code-point schema lengths are not equivalent).
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "maxLength" || key === "minLength") throw Error(`duplicated text bound: ${key}`);
        visit(child);
      }
    };
    for (const field of ["comments", "criteria", "learning", "learningAssessment"]) visit(properties[field]);
    const learning = (observation: string) => [{ kind: "project", observation, action: "a".repeat(500), paths: ["src/" + "p".repeat(293) + ".ts"], phases: ["review"], evidence: [{ artifactId: 1, sha256: "a".repeat(64), excerpt: "e".repeat(300) }] }];
    for (const observation of ["a".repeat(126), "a".repeat(500), "😀".repeat(125)]) {
      expect(parseLearning(learning(observation))[0]?.observation).toBe(observation);
    }
    for (const observation of ["a".repeat(501), "😀".repeat(126)]) {
      expect(() => parseLearning(learning(observation))).toThrow();
      // Invalid optional advice is handled by the learning ledger, not by
      // altering or rejecting the core contradiction.
      expect(parseReview(JSON.stringify({ version: 1, comments: [], criteria: [{ id: "c1", judgement: "contradicts", note: "Evidence fails." }], learning: learning(observation) }), new Set(), new Set(["c1"]))).toMatchObject({ ok: true, criteria: [{ judgement: "contradicts" }] });
    }
    expect(parseReview(JSON.stringify({ version: 1, comments: [], criteria: [{ id: "c1", judgement: "upholds", note: "a".repeat(501) }] }), new Set(), new Set(["c1"])).ok).toBe(false);

    // No other phase, and no other provider, gets the flag — a formatting
    // floor for the one phase and the one provider run 1467 actually hit.
    for (const phase of ["build", "plan", "repair"] as const) {
      expect(adapterFor("claude").argv({ ...ASK, phase }).join(" ")).not.toContain("--json-schema");
    }
    expect(adapterFor("codex").argv({ ...ASK, phase: "review" }).join(" ")).not.toContain("--json-schema");
  });

  test("codex review phase gets a read-only sandbox, refusing approvals, and ignores the user's own config — never workspace-write", () => {
    const build = adapterFor("codex").argv({ ...ASK, phase: "build" });
    expect(build).toContain("workspace-write");
    expect(build).not.toContain("--ignore-user-config");

    const argv = adapterFor("codex").argv({ ...ASK, phase: "review" });
    expect(argv).not.toContain("workspace-write");
    expect(argv).toEqual(
      expect.arrayContaining([
        "--ignore-user-config",
        "--sandbox", "read-only",
        "-c", 'approval_policy="never"',
        "-c", 'web_search="disabled"',
      ]),
    );
    // Reviewer is never dispatched with skipPermissions, but even if a
    // caller somehow asked, review isolation wins — no bypass road exists
    // for the one phase that must never mutate.
    const bypassAttempt = adapterFor("codex").argv({ ...ASK, phase: "review", skipPermissions: true });
    expect(bypassAttempt).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(bypassAttempt).toContain("read-only");
  });

  test("openrouter rides codex under a private provider key, TOML-quoted, key shell-excluded", () => {
    const argv = adapterFor("openrouter").argv({ ...ASK, model: "anthropic/claude-sonnet-4.5" });
    expect(adapterFor("openrouter").binary).toBe(adapterFor("codex").binary);
    const joined = argv.join(" ");
    expect(joined).toContain('model_provider="standing-orders_openrouter"');
    expect(joined).toContain('base_url="https://openrouter.ai/api/v1"');
    expect(joined).toContain(`env_key="${OPENROUTER_ENV_KEY}"`);
    // The model's own shells never inherit the key — only the transport.
    expect(joined).toContain(`shell_environment_policy.exclude=["${OPENROUTER_ENV_KEY}"]`);
  });

  test("Codex transports use stdin and explicit images for fresh and resumed isolated review only", () => {
    for (const provider of ["codex", "openrouter"] as const) {
      const adapter = adapterFor(provider);
      for (const resumeSession of [null, "session-1"]) {
        const request = { ...ASK, phase: "review" as const, resumeSession, reviewImages: ["/sealed/screen shot.png"] };
        const args = adapter.argv(request);
        expect(args.at(-1)).toBe("-");
        expect(args).toEqual(expect.arrayContaining(["--image", "/sealed/screen shot.png", "features.shell_tool=false"]));
        expect(args).not.toContain(ASK.brief);
        expect(adapter.stdin?.(request)).toBe(ASK.brief);
      }
      expect(adapter.stdin?.(ASK)).toBeUndefined();
      expect(adapter.argv({ ...ASK, reviewImages: ["/sealed/ignored.png"] })).not.toContain("--image");
    }
  });
});

describe("spec validation", () => {
  test("model ids: real catalog ids pass, argv- and TOML-hostile ones refuse", () => {
    for (const good of ["opus", "gpt-5-codex", "anthropic/claude-sonnet-4.5", "meta-llama/llama-3.3-70b:free"]) {
      expect(MODEL_ID.test(good)).toBe(true);
    }
    for (const bad of ["-rf", "", "a".repeat(200), 'x"y', "a b", "no\nnewlines"]) {
      expect(MODEL_ID.test(bad)).toBe(false);
    }
  });

  test("openrouter without a model is refused — no default exists across a catalog", () => {
    expect(validateSpec({ provider: "openrouter", model: null })).toMatchObject({ ok: false });
    expect(validateSpec({ provider: "openrouter", model: "qwen/qwen3-coder" })).toEqual({ ok: true });
    expect(validateSpec({ provider: "claude", model: null })).toEqual({ ok: true });
  });

  test("only claude reports dollars; the inspection surface says so", () => {
    expect(reportsCost("claude")).toBe(true);
    expect(reportsCost("codex")).toBe(false);
    expect(reportsCost("openrouter")).toBe(false);
    expect(inspectionOf("codex").identityProbe).toEqual(["login", "status"]);
    expect(inspectionOf("claude").identityProbe).toBeNull();
    expect(inspectionOf("openrouter").requiresEnv).toBe(OPENROUTER_ENV_KEY);
  });
});

describe("the turn bound codex does not have", () => {
  test("codex phase intervals are normalized without shortening a progressing plan", () => {
    expect(adapterFor("codex").clampTimeout("build", 30 * 60_000)).toBe(20 * 60_000);
    expect(adapterFor("codex").clampTimeout("plan", 15 * 60_000)).toBe(15 * 60_000);
    expect(adapterFor("codex").clampTimeout("repair", 5 * 60_000)).toBe(5 * 60_000);
    expect(adapterFor("claude").clampTimeout("build", 30 * 60_000)).toBe(30 * 60_000);
  });
});

describe("the streaming JSONL transport", () => {
  test("delivers a prompt larger than OS argv limits intact through stdin and closes input", async () => {
    const input = 'sealed "evidence"\n雪\u0000'.repeat(30000);
    const script = `let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:require('node:crypto').createHash('sha256').update(input).digest('hex')}})); });`;
    const result = await runStreamJsonl(process.execPath, ["-e", script], { stdin: input, timeoutMs: 5000 });
    const { createHash } = await import("node:crypto");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).item.text).toBe(createHash("sha256").update(input).digest("hex"));
  });

  test("closed prompt input is a failed delivery even when the child reports success", async () => {
    const script = `require('node:fs').closeSync(0); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}})); setTimeout(() => process.exit(0),100);`;
    const result = await runStreamJsonl(process.execPath, ["-e", script], { stdin: "x".repeat(2 * 1024 * 1024), timeoutMs: 5000 });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("prompt input failed");
    expect(result.timedOut).toBe(false);
  });

  test("retains only the load-bearing lines from an arbitrarily long stream", async () => {
    // A child that floods 50k noise events, then says what matters. The
    // buffered runner would overflow at 8 MiB and lose the terminal usage;
    // the stream keeps three lines.
    const script = `
      process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"t-9"})+"\\n");
      for (let i = 0; i < 50000; i++) {
        process.stdout.write(JSON.stringify({type:"item.delta",noise:"x".repeat(200),i})+"\\n");
      }
      process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"first"}})+"\\n");
      process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"the last word"}})+"\\n");
      process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:123,output_tokens:45}})+"\\n");
    `;
    const result = await runStreamJsonl(process.execPath, ["-e", script], { timeoutMs: 30_000 });
    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n").filter(one => one !== "");
    expect(lines.length).toBe(3);
    expect(result.stdout).toContain('"t-9"');
    expect(result.stdout).toContain('"input_tokens":123');
    // Only the LAST agent message survives.
    expect(result.stdout).toContain("the last word");
    expect(result.stdout).not.toContain('"first"');
    expect(result.stdout).not.toContain("item.delta");
  });

  test("a missing binary is not-found, not a hang", async () => {
    const result = await runStreamJsonl("definitely-not-a-binary-xyz", [], { timeoutMs: 5_000 });
    expect(result.notFound).toBe(true);
  });

  test("a runaway process is killed at the clock and says timedOut", async () => {
    const result = await runStreamJsonl(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 500 });
    expect(result.timedOut).toBe(true);
  });
});

describe("the claude streaming transport", () => {
  const line = (event: Record<string, unknown>): string => `process.stdout.write(${JSON.stringify(JSON.stringify(event))}+"\\n");`;

  test("a flood past the old 8 MiB kill still lands the accounting envelope", async () => {
    const { runClaudeStreamJsonl } = await import("./exec.js");
    const script = `
      ${line({ type: "system", subtype: "init", session_id: "s-big" })}
      for (let i = 0; i < 50000; i++) {
        process.stdout.write(JSON.stringify({type:"assistant",message:{content:"x".repeat(200)},parent_tool_use_id:null,i})+"\\n");
      }
      ${line({ type: "result", subtype: "success", is_error: false, result: "survived", session_id: "s-big", usage: { input_tokens: 7, output_tokens: 8 }, total_cost_usd: 0.05 })}
    `;
    const result = await runClaudeStreamJsonl(process.execPath, ["-e", script], { timeoutMs: 30_000 });
    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n").filter(one => one !== "");
    expect(lines.length).toBe(2); // init + primary result, nothing else retained
    const parsed = adapterFor("claude").parse(result.stdout);
    expect(parsed.costUsd).toBe(0.05);
    expect(parsed.initObserved).toBe(true);
    expect(parsed.promptConsumed).toBe(true);
  });

  test("the receipt fires once at the first top-level assistant event — child events never fire it", async () => {
    const { runClaudeStreamJsonl } = await import("./exec.js");
    const script = `
      ${line({ type: "system", subtype: "init" })}
      ${line({ type: "assistant", message: {}, parent_tool_use_id: "tool-1" })}
      ${line({ type: "assistant", message: {}, parent_tool_use_id: null })}
      ${line({ type: "assistant", message: {}, parent_tool_use_id: null })}
      ${line({ type: "result", subtype: "success", is_error: false })}
    `;
    let receipts = 0;
    await runClaudeStreamJsonl(process.execPath, ["-e", script], {
      timeoutMs: 30_000,
      onReceipt: () => {
        receipts += 1;
      },
    });
    expect(receipts).toBe(1);
  });

  test("a success result is the fallback receipt; an error result never is", async () => {
    const { runClaudeStreamJsonl } = await import("./exec.js");
    const success = `${line({ type: "result", subtype: "success", is_error: false })}`;
    const failure = `${line({ type: "result", subtype: "error_during_execution", is_error: true, result: "died at startup" })}`;
    let onSuccess = 0;
    let onFailure = 0;
    await runClaudeStreamJsonl(process.execPath, ["-e", success], { timeoutMs: 30_000, onReceipt: () => void (onSuccess += 1) });
    await runClaudeStreamJsonl(process.execPath, ["-e", failure], { timeoutMs: 30_000, onReceipt: () => void (onFailure += 1) });
    expect(onSuccess).toBe(1);
    expect(onFailure).toBe(0);
  });

  test("throwing listeners are latched and isolated — the run is unharmed (finding 13)", async () => {
    const { runClaudeStreamJsonl } = await import("./exec.js");
    const script = `
      ${line({ type: "system", subtype: "init", session_id: "s-iso" })}
      ${line({ type: "assistant", message: {}, parent_tool_use_id: null })}
      ${line({ type: "result", subtype: "success", is_error: false, result: "fine" })}
    `;
    let receiptCalls = 0;
    let eventCalls = 0;
    const result = await runClaudeStreamJsonl(process.execPath, ["-e", script], {
      timeoutMs: 30_000,
      onReceipt: () => {
        receiptCalls += 1;
        throw new Error("recorder down");
      },
      onStreamEvent: () => {
        eventCalls += 1;
        throw new Error("renderer down");
      },
    });
    expect(result.code).toBe(0);
    expect(receiptCalls).toBe(1); // latched: one firing, even though it threw
    expect(eventCalls).toBe(3);
    expect(adapterFor("claude").parse(result.stdout).finalMessage).toBe("fine");
  });

  test("the session id is stamped from the init event, the moment it arrives", async () => {
    const { runClaudeStreamJsonl } = await import("./exec.js");
    const script = `
      ${line({ type: "system", subtype: "init", session_id: "s-early" })}
      setInterval(()=>{}, 1000); // hang: the id must not wait for exit
    `;
    let seen: string | null = null;
    await runClaudeStreamJsonl(process.execPath, ["-e", script], {
      timeoutMs: 1_500,
      onSessionId: id => {
        seen = id;
      },
    });
    expect(seen).toBe("s-early");
  });

  test("split chunks and a task-notification result first — retention is structural, not positional", async () => {
    const { runClaudeStreamJsonl } = await import("./exec.js");
    // Write the stream in awkward pieces: a line split mid-JSON across
    // writes, and a background result BEFORE the real one.
    const script = `
      const a = JSON.stringify({type:"result",subtype:"success",is_error:false,origin:{kind:"task-notification"},total_cost_usd:9.9});
      const b = JSON.stringify({type:"result",subtype:"success",is_error:false,result:"the real one",total_cost_usd:0.1});
      process.stdout.write(a.slice(0, 10));
      setTimeout(() => {
        process.stdout.write(a.slice(10) + "\\n" + b.slice(0, 4));
        setTimeout(() => process.stdout.write(b.slice(4) + "\\n"), 20);
      }, 20);
    `;
    const result = await runClaudeStreamJsonl(process.execPath, ["-e", script], { timeoutMs: 30_000 });
    const parsed = adapterFor("claude").parse(result.stdout);
    expect(parsed.finalMessage).toBe("the real one");
    expect(parsed.costUsd).toBe(0.1);
  });
});

describe("the provider audit — report before enforcement", () => {
  test("facts are stated and nothing is enforced", () => {
    const codex = auditOf("codex");
    expect(codex.transport).toBe("streaming-jsonl");
    expect(codex.initSignal).toBe("thread.started");
    // --ephemeral exists and is deliberately not passed: it breaks resume,
    // and the audit says so instead of silently choosing.
    expect(codex.isolation.flag).toBe("--ephemeral");
    expect(codex.isolation.resumeSafe).toBe(false);
    expect(codex.isolation.enforced).toBe(false);

    const claude = auditOf("claude");
    expect(claude.transport).toBe("streaming-jsonl");
    // The init signal claude gained with the streaming transport (arc 1).
    // This is CAPABILITY metadata — whether a given run saw it lives in
    // the envelope's initObserved, never here (finding 16).
    expect(claude.initSignal).toBe("system-init");
    expect(claude.isolation).toMatchObject({ flag: "--restricted", resumeSafe: true, enforced: false });

    for (const id of PROVIDER_IDS) {
      const audit = auditOf(id);
      expect(audit.configSurface.length).toBeGreaterThan(0);
      expect(audit.isolation.enforced).toBe(false);
    }
  });

  test("codexParse observes initialization; claudeParse now does too", () => {
    const codex = adapterFor("codex");
    const started = codex.parse(JSON.stringify({ type: "thread.started", thread_id: "t-1" }));
    expect(started.initObserved).toBe(true);
    const silent = codex.parse("");
    expect(silent.initObserved).toBe(false);

    const claude = adapterFor("claude");
    const init = JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" });
    expect(claude.parse(init).initObserved).toBe(true);
    expect(claude.parse(init).sessionId).toBe("s-1");
    // No events at all: the transport HAS an init signal, it was not seen.
    expect(claude.parse("").initObserved).toBe(false);
    expect(claude.parse("not json").initObserved).toBe(false);
    // The legacy buffered envelope (recorded fixtures) still carries none.
    expect(claude.parse("{}").initObserved).toBe(null);
  });

  test("Codex canonicalizes one identity and rejects conflicting thread.started ids", () => {
    const codex = adapterFor("codex");
    const canonical = codex.parse(
      [
        JSON.stringify({ type: "thread.started", thread_id: "  thread-1  " }),
        JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      ].join("\n"),
    );
    expect(canonical).toMatchObject({ sessionId: "thread-1", protocolError: null, initObserved: true });

    const conflicting = codex.parse(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
        JSON.stringify({ type: "thread.started", thread_id: "thread-2" }),
      ].join("\n"),
    );
    expect(conflicting.sessionId).toBe(null);
    expect(conflicting.protocolError).toMatch(/conflicting thread\.started session ids/);
  });
});

describe("claudeParse — the streaming envelope", () => {
  const claude = adapterFor("claude");
  const result = (extra: Record<string, unknown>): string =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done it",
      session_id: "s-7",
      usage: { input_tokens: 100, output_tokens: 20 },
      total_cost_usd: 0.42,
      ...extra,
    });

  test("the first primary result is the envelope — identical facts to the buffered format", () => {
    const parsed = claude.parse(
      [JSON.stringify({ type: "system", subtype: "init", session_id: "s-7" }), result({})].join("\n"),
    );
    expect(parsed.sessionId).toBe("s-7");
    expect(parsed.finalMessage).toBe("done it");
    expect(parsed.tokensIn).toBe(100);
    expect(parsed.tokensOut).toBe(20);
    expect(parsed.costUsd).toBe(0.42);
    expect(parsed.initObserved).toBe(true);
    expect(parsed.promptConsumed).toBe(true);
    expect(parsed.protocolError).toBe(null);
  });

  test("conflicting init and terminal session ids are protocol-invalid and never select either id", () => {
    const parsed = claude.parse(
      [JSON.stringify({ type: "system", subtype: "init", session_id: "s-init" }), result({ session_id: "s-result" })].join("\n"),
    );
    expect(parsed.sessionId).toBe(null);
    expect(parsed.protocolError).toMatch(/different session ids/);
    // The terminal can still account for a consumed turn; protocol identity
    // is an independent gate at invokeAgent.
    expect(parsed.promptConsumed).toBe(true);
  });

  test("conflicting init session ids are protocol-invalid even when the terminal agrees with the first", () => {
    const parsed = claude.parse(
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "  " }),
        JSON.stringify({ type: "system", subtype: "init", session_id: "s-first" }),
        JSON.stringify({ type: "system", subtype: "init", session_id: " s-first " }),
        JSON.stringify({ type: "system", subtype: "init", session_id: "s-second" }),
        result({ session_id: "s-first" }),
      ].join("\n"),
    );
    expect(parsed).toMatchObject({
      sessionId: null,
      initObserved: true,
      promptConsumed: true,
      protocolError: expect.stringMatching(/conflicting system\/init session ids/),
    });
  });

  test("a transport overflow witness after a valid Claude result remains a failure without losing usage", () => {
    const parsed = claude.parse(
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "s-stable" }),
        result({
          session_id: "s-stable",
          result: "done",
          usage: { input_tokens: 19, output_tokens: 5 },
        }),
        JSON.stringify({
          type: "result",
          subtype: "standing-orders-stream-event-overflow",
          is_error: true,
          result: '{"type":"standing-orders.stream-event-overflow"}',
        }),
      ].join("\n"),
    );

    expect(parsed).toMatchObject({
      sessionId: "s-stable",
      finalMessage: "done",
      tokensIn: 19,
      tokensOut: 5,
      structuralTerminal: { failed: true, code: "standing-orders-stream-event-overflow" },
    });
  });

  test("a later blank init cannot erase the first usable session identity", () => {
    const parsed = claude.parse(
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "s-stable" }),
        JSON.stringify({ type: "system", subtype: "init", session_id: " \t " }),
        result({ session_id: "s-stable" }),
      ].join("\n"),
    );
    expect(parsed).toMatchObject({ sessionId: "s-stable", initObserved: true, protocolError: null });
  });

  test("blank session ids normalize to absence in streaming and legacy Claude envelopes", () => {
    const streaming = claude.parse(
      [JSON.stringify({ type: "system", subtype: "init", session_id: " \t " }), result({ session_id: "\n" })].join("\n"),
    );
    expect(streaming.sessionId).toBe(null);
    expect(streaming.protocolError).toBe(null);
    expect(claude.parse(JSON.stringify({ result: "old shape", session_id: "   " })).sessionId).toBe(null);
  });

  test("origin allowlist (finding 10): only absent or human origins are primary", () => {
    // A task-notification result FIRST must not steal the envelope.
    const stolen = claude.parse(
      [
        result({ origin: { kind: "task-notification" }, total_cost_usd: 9.99, result: "background noise" }),
        result({}),
      ].join("\n"),
    );
    expect(stolen.costUsd).toBe(0.42);
    expect(stolen.finalMessage).toBe("done it");

    // Explicit human origin qualifies.
    expect(claude.parse(result({ origin: { kind: "human" } })).costUsd).toBe(0.42);

    // Every other kind — including ones the SDK has not invented yet —
    // fails closed as non-primary.
    for (const kind of ["channel", "peer", "coordinator", "somewhere-new"]) {
      const parsed = claude.parse(result({ origin: { kind } }));
      expect(parsed.costUsd).toBe(null);
      expect(parsed.finalMessage).toBe(null);
      expect(parsed.promptConsumed).toBe(false);
    }
  });

  test("error results keep their diagnostics but never prove consumption (finding 15)", () => {
    const errored = claude.parse(
      result({ subtype: "error_during_execution", is_error: true, result: "auth token expired" }),
    );
    expect(errored.finalMessage).toBe("auth token expired"); // diagnostics survive
    expect(errored.promptConsumed).toBe(false); // prose is not proof
    expect(errored.initObserved).toBe(false); // no init event in this stream
  });

  test("run 1467's fix: a structured_output result (the --json-schema turn) wins over the plain result string", () => {
    const structured = { version: 1, comments: [], criteria: [{ id: "c1", judgement: "upholds", note: "fine" }] };
    const parsed = claude.parse(result({ structured_output: structured, result: "```json\n" + JSON.stringify(structured) + "\n```" }));
    // The re-serialized structured field, not the fenced prose the model
    // would have spoken without --json-schema — this is exactly what run
    // 1467's malformed JSON (code fences around the object) needed.
    expect(parsed.finalMessage).toBe(JSON.stringify(structured));
    expect(JSON.parse(parsed.finalMessage ?? "null")).toEqual(structured);
  });

  test("no structured_output field: the plain result string still carries the reply, unchanged", () => {
    const parsed = claude.parse(result({ result: "plain text reply" }));
    expect(parsed.finalMessage).toBe("plain text reply");
  });

  test("structuredOutput carries only the structured_output field, never prose that happens to be JSON", () => {
    const structured = { kind: "report", report: { title: "t", summary: "s", report: "r" } };
    expect(claude.parse(result({ structured_output: structured, result: "" })).structuredOutput).toBe(JSON.stringify(structured));
    const prose = claude.parse(result({ result: JSON.stringify(structured) }));
    expect(prose.finalMessage).toBe(JSON.stringify(structured));
    expect(prose.structuredOutput).toBeNull();
  });

  test("a null structured_output field falls back to the plain result string", () => {
    const parsed = claude.parse(result({ structured_output: null, result: "fallback" }));
    expect(parsed.finalMessage).toBe("fallback");
  });

  test("a stream with no primary result gives the same nulls as an unparseable envelope", () => {
    const parsed = claude.parse(JSON.stringify({ type: "assistant", message: {} }));
    expect(parsed.sessionId).toBe(null);
    expect(parsed.tokensIn).toBe(null);
    expect(parsed.costUsd).toBe(null);
    expect(parsed.usageRaw).toBe(null);
  });

  test("the legacy buffered envelope still parses, with no init or consumption signal", () => {
    const parsed = claude.parse(
      JSON.stringify({ result: "old shape", session_id: "s-0", usage: { input_tokens: 5, output_tokens: 6 }, total_cost_usd: 0.01 }),
    );
    expect(parsed.finalMessage).toBe("old shape");
    expect(parsed.tokensIn).toBe(5);
    expect(parsed.initObserved).toBe(null);
    expect(parsed.promptConsumed).toBe(null);
    expect(parsed.structuralTerminal).toBe(null);
  });

  test("a legacy buffered result with no subtype is structurally unknown, not a fabricated failure", () => {
    const parsed = claude.parse(JSON.stringify({ result: "legacy success-shaped output", session_id: "s-legacy" }));
    expect(parsed).toMatchObject({
      sessionId: "s-legacy",
      finalMessage: "legacy success-shaped output",
      structuralTerminal: null,
    });
  });

  test("a streaming primary result with a missing subtype remains a structural failure", () => {
    const parsed = claude.parse(
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "s-stream" }),
        JSON.stringify({ type: "result", is_error: false, result: "malformed", session_id: "s-stream" }),
      ].join("\n"),
    );
    expect(parsed.structuralTerminal).toMatchObject({ failed: true });
  });
});


describe("the gemini dialect (Phase 3, attested at 0.57.0)", () => {
  const ASK = {
    phase: "build" as const,
    brief: "do the thing",
    model: "gemini-2.5-pro" as string | null,
    maxTurns: 40,
    permissionMode: "acceptEdits",
    skipPermissions: false,
    resumeSession: null as string | null,
  };

  test("headless stream-json with the ONE sealed autonomy dial", () => {
    const argv = adapterFor("gemini").argv({ ...ASK });
    expect(argv).toEqual([
      "-p", "do the thing",
      // S2 (live, v0.57.0): headless is trust-gated; the plane's own
      // leased worktree is trusted per-invocation, on the argv.
      "--skip-trust",
      "--output-format", "stream-json",
      "--approval-mode", "auto_edit",
      "-m", "gemini-2.5-pro",
    ]);
  });

  test("S4: the full matrix — every adapter sheds every OTHER provider's credential env, keeps only its own", () => {
    const OWN: Record<"claude" | "codex" | "openrouter" | "gemini", string[]> = {
      claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
      codex: ["OPENAI_API_KEY", "CODEX_API_KEY"],
      openrouter: ["OPENROUTER_API_KEY"],
      gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    };
    const all = Object.values(OWN).flat();
    for (const id of ["claude", "codex", "openrouter", "gemini"] as const) {
      const omit = adapterFor(id).extraOmitEnv;
      for (const key of OWN[id]) expect(omit).not.toContain(key); // keeps its own
      for (const key of all) {
        if (!OWN[id].includes(key)) expect(omit).toContain(key); // sheds every foreign one
      }
    }
    // ALL_CREDENTIAL_ENV (the probe strip) is the union — every key, no owner.
    for (const key of all) expect(ALL_CREDENTIAL_ENV).toContain(key);
  });

  test("skipPermissions maps to yolo exactly where claude maps it to bypass", () => {
    expect(adapterFor("gemini").argv({ ...ASK, skipPermissions: true })).toContain("yolo");
    expect(adapterFor("gemini").argv({ ...ASK, skipPermissions: true })).not.toContain("auto_edit");
  });

  test("session identity: minted on start, resumed on repair, never both", () => {
    const started = adapterFor("gemini").argv({ ...ASK, startSessionId: "aaaa-bbbb" });
    expect(started).toContain("--session-id");
    expect(started).toContain("aaaa-bbbb");
    expect(started).not.toContain("--resume");
    const resumed = adapterFor("gemini").argv({ ...ASK, resumeSession: "cccc-dddd", startSessionId: "aaaa-bbbb" });
    expect(resumed).toContain("--resume");
    expect(resumed).not.toContain("--session-id");
  });

  test("no turn bound and no dollar cap exist to render", () => {
    const argv = adapterFor("gemini").argv({ ...ASK, maxBudgetUsd: 3 });
    expect(argv.join(" ")).not.toContain("--max-turns");
    expect(argv.join(" ")).not.toContain("--max-budget-usd");
  });

  test("phase intervals match the long-running codex posture", () => {
    expect(adapterFor("gemini").clampTimeout("build", 30 * 60_000)).toBe(20 * 60_000);
    expect(adapterFor("gemini").clampTimeout("plan", 15 * 60_000)).toBe(15 * 60_000);
    expect(adapterFor("gemini").clampTimeout("repair", 9 * 60_000)).toBe(5 * 60_000);
  });

  test("a full stream parses: init identity, assembled message, tokens, structural success", () => {
    const stream = [
      "Loaded cached credentials.", // startup prose: dropped, not fatal
      JSON.stringify({ type: "init", timestamp: "t", session_id: "s-1", model: "gemini-2.5-pro" }),
      JSON.stringify({ type: "synthetic_message", content: "all done" }),
      JSON.stringify({ type: "not-a-real-event", whatever: true }),
      JSON.stringify({ type: "result", status: "success", stats: { input_tokens: 900, output_tokens: 88, total_tokens: 988 } }),
    ].join("\n");
    const envelope = adapterFor("gemini").parse(stream);
    expect(envelope).toMatchObject({
      sessionId: "s-1",
      finalMessage: "all done",
      tokensIn: 900,
      tokensOut: 88,
      costUsd: null,
      initObserved: true,
      promptConsumed: true,
    });
  });

  test("session ids are trimmed, while blank ids normalize to absence for Gemini and Codex", () => {
    expect(adapterFor("gemini").parse(JSON.stringify({ type: "init", session_id: "  gemini-1\t", model: "m" })).sessionId).toBe("gemini-1");
    expect(adapterFor("codex").parse(JSON.stringify({ type: "thread.started", thread_id: "\n codex-1 " })).sessionId).toBe("codex-1");
    expect(adapterFor("gemini").parse(JSON.stringify({ type: "init", session_id: " \t ", model: "m" })).sessionId).toBe(null);
    expect(adapterFor("codex").parse(JSON.stringify({ type: "thread.started", thread_id: "\n" })).sessionId).toBe(null);
  });

  test("an error-status result is NOT consumption — and its message is diagnostics", () => {
    const stream = [
      JSON.stringify({ type: "init", session_id: "s-1", model: "m" }),
      JSON.stringify({ type: "result", status: "error", error: { type: "X", message: "the model refused" } }),
    ].join("\n");
    const envelope = adapterFor("gemini").parse(stream);
    expect(envelope.promptConsumed).toBe(false);
    expect(envelope.diagnostic).toBe("the model refused");
  });

  test("a dead-at-startup stream: no init, nothing consumed, malformed lines skipped", () => {
    const envelope = adapterFor("gemini").parse("please set an auth method\n{truncated js");
    expect(envelope).toMatchObject({ sessionId: null, initObserved: false, promptConsumed: false, tokensIn: null });
  });

  test("conflicting init ids fail closed while the last result and bounded diagnostic are retained", () => {
    const stream = [
      JSON.stringify({ type: "init", session_id: "first", model: "m" }),
      JSON.stringify({ type: "init", session_id: "second", model: "m" }),
      JSON.stringify({ type: "error", severity: "warning", message: "loop detected" }),
      JSON.stringify({ type: "error", severity: "error", message: "x".repeat(5000) }),
      JSON.stringify({ type: "result", status: "error", stats: { input_tokens: 1, output_tokens: 1 } }),
      JSON.stringify({ type: "result", status: "success", stats: { input_tokens: 5, output_tokens: 6 } }),
    ].join("\n");
    const envelope = adapterFor("gemini").parse(stream);
    expect(envelope.sessionId).toBe(null);
    expect(envelope.protocolError).toMatch(/conflicting init session ids/);
    expect(envelope.tokensIn).toBe(5);
    expect(envelope.promptConsumed).toBe(true);
    expect(Buffer.byteLength(envelope.diagnostic ?? "", "utf8")).toBeLessThanOrEqual(2 * 1024 + 4);
  });

  test("a diagnostic that trips the secret scanner is withheld, and controls collapse", () => {
    const leaky = [
      JSON.stringify({ type: "init", session_id: "s-1", model: "m" }),
      JSON.stringify({ type: "error", severity: "error", message: "auth failed for AKIAABCDEFGHIJKLMNOP" }),
      JSON.stringify({ type: "result", status: "error" }),
    ].join("\n");
    expect(adapterFor("gemini").parse(leaky).diagnostic).toContain("withheld");

    const controlly = [
      JSON.stringify({ type: "init", session_id: "s-1", model: "m" }),
      JSON.stringify({ type: "error", severity: "error", message: "line one\u0007\u001b[31mline two" }),
      JSON.stringify({ type: "result", status: "error" }),
    ].join("\n");
    const diagnostic = adapterFor("gemini").parse(controlly).diagnostic ?? "";
    expect(diagnostic).not.toMatch(/[\u0000-\u001f]/);
    expect(diagnostic).toContain("line one");
  });

  test("gemini needs an explicit model — the harness default drifts", () => {
    expect(validateSpec({ provider: "gemini", model: null }).ok).toBe(false);
    expect(validateSpec({ provider: "gemini", model: "gemini-2.5-flash" }).ok).toBe(true);
  });

  test("money honesty: tokens only, no cap to hold, never in a tournament", () => {
    expect(reportsCost("gemini")).toBe(false);
    expect(MONEY_CAPABILITIES.gemini).toMatchObject({
      nativeDollarCapFlag: null,
      usageSemantics: "per-invocation",
      tournamentEligible: false,
    });
    expect(MONEY_CAPABILITIES.gemini.whyIneligible).toContain("tokens");
  });

  test("the audit states the posture: init event, NATIVE resume (S1 proved), required terminal, minted identity", () => {
    expect(auditOf("gemini")).toMatchObject({
      transport: "streaming-jsonl",
      // S1 live spike 2026-08-29 proved headless resume-by-uuid.
      resume: "native",
      initSignal: "init-event",
      sessionIdentity: "minted",
      terminalContract: "required",
    });
    // Tier-1 settlement is untouched by construction.
    expect(auditOf("claude").terminalContract).toBe("none");
    expect(auditOf("codex").terminalContract).toBe("none");
    // The hooks surface is NAMED — the config-leak class the audit exists for.
    expect(auditOf("gemini").configSurface.join(" ")).toContain("HOOKS");
  });
});

describe("the historical Telegram delivery manifest", () => {
  // Review 1660 (c3): the corrected manifest's completeness check must be a
  // machine receipt inside the unchanged native gate, not a script somebody
  // remembers to run. The script reads Git objects only — the exact diff
  // ba101e6..8217f55 under src/ — so it never touches the working tree.
  test("scripts/delivery-manifest-check.mjs proves all 23 paths, every hash and the digest", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const manifest = JSON.parse(readFileSync(resolve(root, "docs/TELEGRAM_DELIVERY_CANDIDATE_2026-09-15.json"), "utf8")) as { files: { path: string }[]; sourceDigest: string };
    expect(manifest.files).toHaveLength(23);
    expect(manifest.files.map((f) => f.path)).toContain("src/claim.ts");
    expect(manifest.sourceDigest).toBe("80ba1b57c26f8375013dfac7cdd3165ab2dc7125a739757dd7df48b088cca2ad");

    const check = spawnSync(process.execPath, ["scripts/delivery-manifest-check.mjs"], { cwd: root, encoding: "utf8", timeout: 10_000 });
    expect(check.error).toBeUndefined();
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
    const result = check.stdout.trim();
    expect(result).toBe("delivery-manifest-check: docs/TELEGRAM_DELIVERY_CANDIDATE_2026-09-15.json lists all 23 src/ paths changed in ba101e6..8217f55; every sha256 matches 8217f55 bytes and sourceDigest recomputes");
    console.log(result);
  });
});

test("provider certification rejects retired review flags and invalid routes before dispatch", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (const [args, message] of [
    [["--provider", "gemini", "--model", "gemini-test", "--review"], "unknown option --review"],
    [["--provider", "claude", "--model", "test", "--review-provider", "codex"], "unknown option --review-provider"],
    [["--provider", "claude", "--model", "test", "--review-model", "test"], "unknown option --review-model"],
    [["--provider", "unsupported", "--model", "test"], "--provider is claude, codex, gemini or openrouter"],
    [["--provider", "claude"], "--model is required because task approvals seal exact routing"],
    [["--provider"], "--provider needs a value"],
  ] as const) {
    const check = spawnSync(process.execPath, ["scripts/provider-canary.mjs", ...args], { cwd: root, encoding: "utf8", timeout: 10_000 });
    expect(check.error).toBeUndefined();
    expect(check.status).toBe(2);
    expect(check.stderr).toContain(message);
    expect(check.stdout).toBe("");
  }
});
