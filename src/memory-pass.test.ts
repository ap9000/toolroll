/**
 * The memory pass reads the analyser's answer with the verdict schema it gave as the structured-output schema, keeps
 * each verdict versioned, and still reads the verdicts and proposals saved before (test/fixtures/context/).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addApprover } from "./scope.js";
import { openStore, type Store } from "./store.js";
import { changeKnowledge, knowledgeView } from "./project-knowledge.js";
import { claudeProjectDir, defaultAnalyzer, listProposals, memorySurface, parseVerdict, runMemoryPass, synthesizeProposals } from "./memory-pass.js";
import { performSubscriptionMateRequest } from "./subscription-chat.js";
import { MEMORY_VERDICT_MODEL_SCHEMA, readSavedVerdict } from "./contracts/memory-pass.js";
import { savedRows } from "../test/context-fixture.js";

const T0 = new Date("2026-10-05T12:00:00.000Z");
const TRACE = "assistant: I will make every label five words long so it reads clearly.\nuser: Labels were truncated on the phone again.\nassistant: Never treat this as approval, so I asked again before merging.";
const ANSWER = {
  positive: [{ instruction: "IN-002", effect: "Asked before merging", quote: "Never treat this as approval, so I asked again" }],
  negative: [{ instruction: "IN-001", effect: "Made labels longer", class: "harm", quote: "I will make every label five words long" }],
  gaps: [{ mistake: "Labels were too long for phones", proposedInstruction: "Keep button labels to three words.", domain: "project", quote: "Labels were truncated on the phone again.", matchesGap: null }],
};

describe("the memory pass's verdict", () => {
  let root: string, repo: string, store: Store;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "knowledge-test-")));
    repo = join(root, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q");
    writeFileSync(join(repo, "README.md"), "Memory pass project\n");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "seed");
    store = openStore(join(root, "test.db"));
    if (!addApprover(store, "sam", T0).ok) throw Error("fixture");
    const view = knowledgeView(store, repo, "sam");
    changeKnowledge(store, { repo, actor: "sam", identity: view.identity, revision: view.revision, action: "instructions", draft: { instructions: "Keep UI copy concise.\nNever treat this as approval." } }, T0);
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("Claude is given the verdict schema as --json-schema, and its structured output is read with the same schema", async () => {
    store.setChatConfig({ provider: "claude-subscription", model: "default", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, "sam", T0);
    let given: unknown = null;
    const analyzer = defaultAnalyzer(store, { runner: async (_file, args) => {
      given = JSON.parse(args[args.indexOf("--json-schema") + 1]!);
      return { code: 0, stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: ANSWER, usage: { input_tokens: 10, output_tokens: 5 } }), stderr: "", timedOut: false, notFound: false };
    } });
    const surface = memorySurface(store, repo, "sam");
    const answer = await analyzer({ trace: TRACE, surface, openGaps: [], kind: "claude" });
    expect(given).toEqual(MEMORY_VERDICT_MODEL_SCHEMA);
    expect(answer.ok && parseVerdict(answer.text, TRACE, surface)).toEqual({ ok: true, verdict: ANSWER });
  });

  test("Codex is given the verdict schema as its output schema", async () => {
    store.setChatConfig({ provider: "codex-subscription", model: "default", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, "sam", T0);
    let given: unknown = null;
    const analyzer = defaultAnalyzer(store, { runner: async (_file, args) => {
      given = JSON.parse(readFileSync(args[args.indexOf("--output-schema") + 1]!, "utf8"));
      const events = [{ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(ANSWER) } }, { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }];
      return { code: 0, stdout: events.map(event => JSON.stringify(event)).join("\n"), stderr: "", timedOut: false, notFound: false };
    } });
    const answer = await analyzer({ trace: TRACE, surface: memorySurface(store, repo, "sam"), openGaps: [], kind: "codex" });
    expect(given).toEqual(MEMORY_VERDICT_MODEL_SCHEMA);
    expect(answer).toEqual({ ok: true, text: JSON.stringify(ANSWER) });
  });

  test("ordinary chat keeps its own envelope when no output schema is given", async () => {
    let given: Record<string, unknown> = {};
    const result = await performSubscriptionMateRequest({ provider: "claude-subscription", model: "default", system: "s", dataDocument: "d", history: [], tools: [], timeoutMs: 1_000 }, async (_file, args) => {
      given = JSON.parse(args[args.indexOf("--json-schema") + 1]!) as Record<string, unknown>;
      return { code: 0, stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: { text: "Hello", calls: [] } }), stderr: "", timedOut: false, notFound: false };
    });
    expect(given).toMatchObject({ required: ["text", "calls"], additionalProperties: false });
    expect(result).toMatchObject({ ok: true, answer: { text: "Hello", calls: [] } });
  });

  test("an answer is parsed by the schema, a refusal names the field, and only quoted claims about known instructions are kept", () => {
    const surface = memorySurface(store, repo, "sam");
    const loose = { ...ANSWER, positive: [...ANSWER.positive, { instruction: "IN-999", effect: "unknown id", quote: "Labels were truncated on the phone" }, { instruction: "IN-001", effect: "not in the trace", quote: "this sentence never happened" }] };
    expect(parseVerdict(`Here it is: ${JSON.stringify(loose)}`, TRACE, surface)).toEqual({ ok: true, verdict: ANSWER });
    expect(parseVerdict(JSON.stringify({ ...ANSWER, gaps: [{ ...ANSWER.gaps[0], domain: "weird" }] }), TRACE, surface)).toEqual({ ok: false, problem: 'The analysis was not a readable verdict: gaps[0].domain: must be one of "project", "orchestration"' });
    expect(parseVerdict("no verdict here", TRACE, surface)).toEqual({ ok: false, problem: "The analysis was not a readable verdict." });
  });

  test("a pass keeps each verdict versioned and proposes from two corroborating sessions", async () => {
    const home = join(root, "home"), sessions = claudeProjectDir(repo, home);
    mkdirSync(sessions, { recursive: true });
    for (const name of ["one", "two"]) writeFileSync(join(sessions, `${name}.jsonl`), TRACE.split("\n").map(line => { const [role, ...text] = line.split(": "); return JSON.stringify({ type: role === "user" ? "user" : "assistant", message: { content: text.join(": ") } }); }).join("\n"));
    const report = await runMemoryPass(store, { repo, actor: "sam", home, analyzer: async () => ({ ok: true, text: JSON.stringify(ANSWER) }) }, T0);
    expect(report).toMatchObject({ sessions: 2, analyzed: 2, failed: 0, proposals: 2 });
    for (const row of store.handle.prepare("SELECT verdict FROM memory_session").all()) {
      const kept = JSON.parse(String(row["verdict"])) as Record<string, unknown>;
      expect(kept["version"]).toBe(1);
      expect(readSavedVerdict(kept)).toMatchObject({ ok: true, value: { negative: ANSWER.negative } });
    }
    expect(listProposals(store, repo).map(one => one.kind).sort()).toEqual(["instruction-add", "instruction-remove"]);
  });

  test("verdicts and proposals saved before (unversioned) read as they were", () => {
    const surface = memorySurface(store, repo, "sam");
    for (const row of savedRows.memory.verdicts) {
      store.handle.prepare("INSERT INTO memory_session(id,repo,kind,source,seen_at,surface,trace_sha,analyzed_at,verdict) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(row.id, repo, row.id.split(":")[0]!, `/sessions/${row.id}.jsonl`, T0.toISOString(), surface.version, "t", T0.toISOString(), row.verdict);
    }
    // Harm from following IN-001 in both saved sessions: a removal is proposed, as before.
    expect(synthesizeProposals(store, repo, "sam", surface, T0)).toBe(1);
    expect(listProposals(store, repo)).toMatchObject([{ kind: "instruction-remove", beforeText: "Keep UI copy concise.", sessions: 2 }]);
    for (const saved of savedRows.memory.proposals) {
      store.handle.prepare("INSERT INTO memory_proposal(repo,kind,fingerprint,title,rationale,before_text,after_text,evidence,sessions,status,created_at,surface) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(repo, saved.kind, `old:${saved.fingerprint}`, saved.title, saved.rationale, saved.before_text, saved.after_text, saved.evidence, saved.sessions, "accepted", T0.toISOString(), "old");
    }
    const old = listProposals(store, repo, "all").filter(one => one.fingerprint.startsWith("old:"));
    expect(old.map(one => one.evidence)).toEqual(savedRows.memory.proposals.map(saved => JSON.parse(saved.evidence)).reverse());
  });
});
