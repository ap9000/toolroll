/**
 * Flow files (flow-share.ts): a flow exported here imports on another
 * installation with the same zones and paths, its triggers off and its
 * scripts held; secrets, hook addresses, names and cards never leave; and a
 * malformed or oversized file is refused with a plain reason.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { run as exec } from "./exec.js";
import type { Runner } from "./backend.js";
import { flowDefinitionOf } from "./flow-engine.js";
import { saveScript } from "./flow-scripts.js";
import { setFlowSecret } from "./flow-secrets.js";
import { addFlowTriggerTo, saveHooksBase, triggerConfigOf } from "./flow-triggers.js";
import { runFlowSteps, type StepIo } from "./flow-steps.js";
import { FLOW_TEMPLATES, flowFromSteps, type FlowDefinition } from "./flows.js";
import { GALLERY, galleryDiagram } from "./flow-gallery.js";
import { exportFlow, fetchFlowFile, FLOW_FILE_MAX_BYTES, flowShape, importFlow, parseFlowFile, planFlowImport, rawFlowUrl, type FetchLike } from "./flow-share.js";
import { runOperate } from "./operate.js";
import { parseContract } from "./contracts/contract.js";
import { flowFileSchema } from "./contracts/flow.js";

const NOW = new Date("2026-10-01T09:00:00.000Z");
const GHP = ["ghp", "Q".repeat(36)].join("_");
let dir: string, here: string, there: string, repo: string, theirs: string, store: Store, other: Store, alexToken: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-flow-share-")));
  here = join(dir, "here"); there = join(dir, "there");
  mkdirSync(here); mkdirSync(there);
  repo = join(dir, "shop"); theirs = join(dir, "their-shop");
  for (const path of [repo, theirs]) {
    mkdirSync(path);
    execFileSync("git", ["init", "-q", "-b", "main", path]);
    writeFileSync(join(path, "README.md"), "Shop\n");
    execFileSync("git", ["-C", path, "add", "."]);
    execFileSync("git", ["-C", path, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "seed"]);
    execFileSync("git", ["-C", path, "remote", "add", "origin", "git@github.com:acme/shop.git"]);
  }
  // Two installations: this one, with alex and priya, and another with only sam.
  store = openStore(join(here, "orders.db"));
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  alexToken = alex.token;
  addApprover(store, "priya", NOW, { name: "alex", token: alexToken });
  store.upsertProject(repo, "shop", NOW);
  other = openStore(join(there, "orders.db"));
  if (!addApprover(other, "sam", NOW).ok) throw new Error("sam");
  other.upsertProject(theirs, "their-shop", NOW);
});
afterEach(() => { store.close(); other.close(); rmSync(dir, { recursive: true, force: true }); });

/** A flow with every kind of path: a sort, a script's answers, a decision, a wait, a time limit and a merge. */
function richFlow(): number {
  saveScript(store, repo, { name: "triage", about: "Says whether the report is a bug", language: "python", body: "import sys\nprint('goto: bug')" }, "alex", NOW);
  const definition = flowFromSteps([
    { id: "inbox", title: "Inbox", kind: "inbox", remindAfter: "2 days", thenMoveTo: "Triage" },
    { id: "triage", title: "Triage", kind: "check", script: "triage", runIn: "folder", routes: [{ answer: "bug", goesTo: "Sort" }, { answer: "other", goesTo: "Done" }], secrets: ["CRM_KEY"], ifFails: "Inbox" },
    { id: "sort", title: "Sort", kind: "sort", question: "How urgent is it?", answers: [{ answer: "Urgent", means: "Customers are blocked", goesTo: "Build" }, { answer: "Later", goesTo: "Inbox" }], sureAt: 85, ifNotSure: "Inbox", alsoNote: [{ question: "Does it mention money?", kind: "yes-no" }] },
    { id: "build", title: "Build", kind: "task", instructions: "Fix {{card.title}}. Ask priya before touching billing.", planning: "required" },
    { id: "review", title: "Review", kind: "approval", decider: "priya", remindAfter: "1 day" },
    { id: "pr", title: "Open PR", kind: "pull-request", merge: "squash", ifFails: "Build" },
    { id: "ping", title: "Tell them", kind: "email", to: "priya@shop.example", subject: "Fixed: {{card.title}}", body: "It's done." },
    { id: "hold", title: "Wait for reply", kind: "wait", waitFor: "reply", wait: "3 days", ifNoReply: "Done" },
    { id: "call", title: "Call CRM", kind: "request", method: "POST", url: "https://crm.example.com/api/notes", headers: { Authorization: "Bearer {{secret.CRM_KEY}}", "X-Debug": `token ${GHP}` }, body: "{\"note\": \"{{card.title}}\"}" },
    { id: "done", title: "Done", kind: "done" },
  ], null);
  return store.createFlow({ repo, name: "Bug bash", definitionJson: JSON.stringify(definition), by: "alex" }, NOW);
}

/** What a round trip must keep: each zone, what it does and where every path leads. */
const paths = (definition: FlowDefinition) => definition.stages.map(one => ({
  id: one.id, title: one.title, kind: one.kind, next: one.next, onFail: one.onFail, zone: one.zone,
  answers: one.sort?.answers.map(answer => [answer.answer, answer.to]) ?? null, routes: one.routes?.map(route => [route.answer, route.to]) ?? null, limit: one.limit ?? null,
}));

/** A recorded file imported here as the recording did: owner-less deciders are priya, written-out emails sam's. */
function planned(json: string): { plan?: FlowDefinition; refused?: string } {
  try {
    const file = parseFlowFile(json);
    const values = Object.fromEntries(file.parameters.map(one => [one.id, one.default ?? (one.id.startsWith("decider") ? "priya" : one.id.startsWith("email-to") ? "sam@shop.example" : "x")]));
    return { plan: planFlowImport(store, repo, file, values, "alex").definition };
  } catch (error) { return { refused: (error as Error).message }; }
}
/** The drawing a recorded file was exported from: its import, or (for one that can't import here) its zones as read. */
function definitionOf(one: { name: string; json: string }): FlowDefinition {
  const source = [...FLOW_TEMPLATES.map(template => [`template ${template.id}`, template.definition] as const), ...GALLERY.filter(template => template.steps !== undefined).map(template => [`gallery ${template.id}`, galleryDiagram(template)] as const)]
    .find(([name]) => name === one.name)?.[1];
  if (source !== undefined) return source;
  return JSON.parse((JSON.parse(readFileSync(new URL("../test/fixtures/flows/steps.json", import.meta.url), "utf8")) as { valid: { name: string; canonical: string }[] }).valid.find(each => each.name === one.name)!.canonical) as FlowDefinition;
}

describe("export then import", () => {
  test("round-trips zones and paths onto another installation, with triggers off and scripts held", () => {
    const flow = richFlow();
    const row = store.getFlow(flow)!;
    const made = [
      addFlowTriggerTo(store, row, { kind: "github", watch: "issues", label: "bug" }, "alex", NOW, here),
      addFlowTriggerTo(store, row, { kind: "schedule", schedule: "daily 22:00", script: "triage", zone: "Triage" }, "alex", NOW, here),
      addFlowTriggerTo(store, row, { kind: "button", label: "Report a bug", questions: ["What broke?"] }, "alex", NOW, here),
    ];
    expect(made.every(one => one.ok)).toBe(true);

    const exported = exportFlow(store, row, here);
    // The file is exactly what flowFileSchema (docs/flow-file.schema.json) reads.
    expect(parseContract(flowFileSchema, JSON.parse(exported.json))).toMatchObject({ ok: true });
    expect(exported.fileName).toBe("bug-bash.toolroll-flow.json");
    expect(exported.file).toMatchObject({ format: "toolroll-flow", version: 1, name: "Bug bash" });
    expect(exported.file.parameters.map(one => one.id)).toEqual(["decider-review", "email-to-ping", "github-repo", "github-label"]);
    expect(exported.file.needs).toEqual(expect.arrayContaining(["github", "openrouter", "email", "secret:CRM_KEY", "script:triage"]));

    // The file, read back on the other installation, with what it asks for given.
    const file = parseFlowFile(exported.json);
    const plan = planFlowImport(other, theirs, file, { "email-to-ping": "{{card.email}}", "decider-review": "sam" }, "sam");
    const imported = importFlow(other, plan, "sam", NOW, there);
    expect(imported.said).toBe("Imported Bug bash. Its 3 triggers are off until you turn them on. Approve its script on the Scripts panel before it runs.");
    const copy = other.getFlow(imported.id)!;
    const original = flowDefinitionOf(row)!, arrived = flowDefinitionOf(copy)!;
    expect(arrived.start).toBe(original.start);
    expect(paths(arrived)).toEqual(paths(original));
    expect(arrived.stages.find(one => one.id === "review")).toMatchObject({ approver: "sam" });
    expect(arrived.stages.find(one => one.id === "build")?.instructions).toBe("Fix {{card.title}}. Ask [a person] before touching billing.");
    expect(other.flowTriggers(copy.id).map(one => [one.kind, one.state])).toEqual([["github", "paused"], ["schedule", "paused"], ["button", "paused"]]);
    expect(other.flowTriggers(copy.id).map(one => triggerConfigOf(one))).toEqual([
      expect.objectContaining({ kind: "github", repo: "acme/shop", label: "bug" }),
      expect.objectContaining({ kind: "schedule", script: "triage", zone: "triage" }),
      expect.objectContaining({ kind: "button", label: "Report a bug" }),
    ]);
    expect(other.flowScript(theirs, "triage")).toMatchObject({ held: "imported", language: "python", savedBy: "sam" });
  });

  test("every template exports and imports to exactly the same zones and paths", () => {
    for (const template of FLOW_TEMPLATES) {
      const id = store.createFlow({ repo, name: template.label, definitionJson: JSON.stringify(template.definition), by: "alex" }, NOW);
      const exported = exportFlow(store, store.getFlow(id)!, here);
      const file = parseFlowFile(exported.json);
      const values = Object.fromEntries(file.parameters.filter(one => one.id.startsWith("email-to-")).map(one => [one.id, "{{card.email}}"]));
      const imported = importFlow(other, planFlowImport(other, theirs, file, values, "sam"), "sam", NOW, there);
      const arrived = flowDefinitionOf(other.getFlow(imported.id)!)!;
      // Every field the file uses is one docs/flow-file.schema.json describes: the file is exactly what flowFileSchema reads.
      expect(parseContract(flowFileSchema, JSON.parse(exported.json)), template.id).toMatchObject({ ok: true });
      const original = flowDefinitionOf(store.getFlow(id)!)!;
      expect(flowShape(arrived), template.id).toBe(flowShape(original));
      expect(paths(arrived), template.id).toEqual(paths(original));
    }
  });

  test("exports the same bytes 0.9.34 did, and importing them draws the same flow", () => {
    // Recorded from the pre-Zod exportFlow and parseFlowFile (test/fixtures/flows/flow-files.json).
    const recorded = JSON.parse(readFileSync(new URL("../test/fixtures/flows/flow-files.json", import.meta.url), "utf8")) as { files: { name: string; json: string; imported: string | null; refused: string | null }[] };
    saveScript(store, repo, { name: "triage", about: "Says whether the report is a bug", language: "python", body: "print('goto: bug')" }, "alex", NOW);
    for (const one of recorded.files) {
      const definition = (JSON.parse(one.json) as { zones: unknown[] }).zones.length > 0 ? planned(one.json) : null;
      const id = store.createFlow({ repo, name: one.name, definitionJson: JSON.stringify(definitionOf(one)), by: "alex" }, NOW);
      expect(exportFlow(store, store.getFlow(id)!, null).json, one.name).toBe(one.json);
      expect(definition === null ? null : definition.refused ?? JSON.stringify(definition.plan), one.name).toBe(one.refused ?? one.imported);
    }
  });

  test("a flow file written before subagents were named so (D5) reads exactly as one written since", () => {
    const recorded = JSON.parse(readFileSync(new URL("../test/fixtures/flows/flow-files.json", import.meta.url), "utf8")) as { files: { json: string }[] };
    const today = recorded.files.find(one => one.json.includes('"kind": "subagent"'))!.json;
    const before = today.replaceAll('"kind": "subagent"', '"kind": "teammate"').replaceAll('"subagent": ', '"teammate": ').replaceAll('"subagent:', '"teammate:');
    expect(before).toContain('"kind": "teammate"');
    expect(parseFlowFile(before)).toEqual(parseFlowFile(today));
  });

  test("an imported script waits for approval before a zone runs it", async () => {
    const flow = richFlow();
    const exported = exportFlow(store, store.getFlow(flow)!, here);
    const plan = planFlowImport(other, theirs, parseFlowFile(exported.json), { "email-to-ping": "{{card.email}}" }, "sam");
    const { id } = importFlow(other, plan, "sam", NOW, there);
    setFlowSecret(there, theirs, "CRM_KEY", "crm-value-123456");
    const card = other.addFlowCard({ flow: id, title: "Checkout breaks", description: null, stage: "triage", by: "sam" }, NOW);
    const io: StepIo = { gh: vi.fn<Runner>(async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, notFound: false })), git: exec, shell: exec, fetch: vi.fn() as unknown as typeof fetch, dir: there, scratch: join(there, "scratch"), base: "main", evidenceRoot: there };
    expect(await runFlowSteps(other, theirs, NOW, io)).toEqual({ ran: 0, problems: [] });
    expect(other.getFlowCard(card)?.waiting).toBe("The triage script came with an imported flow. Approve it on the Scripts panel to run it.");
    expect(other.approveFlowScript(theirs, "triage")).toBe(true);
    expect(other.flowScript(theirs, "triage")?.held).toBeNull();
    expect((await runFlowSteps(other, theirs, NOW, io)).ran).toBe(1);
  });
});

describe("what never leaves", () => {
  test("planted secrets, hook addresses, names, chat bindings and cards never appear in an export", () => {
    const flow = richFlow();
    const row = store.getFlow(flow)!;
    setFlowSecret(here, repo, "CRM_KEY", "planted-crm-secret-value-9f2c");
    expect(saveHooksBase(here, "https://hooks.planted-host.example").ok).toBe(true);
    const hook = addFlowTriggerTo(store, row, { kind: "webhook", title: "Sentry error" }, "priya", NOW, here);
    const signed = addFlowTriggerTo(store, row, { kind: "github", watch: "pulls", delivery: "webhook" }, "priya", NOW, here);
    if (!hook.ok || !signed.ok) throw new Error("triggers");
    const hookHash = store.getFlowTrigger(hook.id)!.hookHash!;
    // A channel someone connected from Slack, and a card with its history.
    store.addFlowTrigger({ flow, kind: "chat", configJson: JSON.stringify({ kind: "chat", app: "slack", installation: "T0PLANTED", chat: "C0PLANTED", binding: 4242, zone: null }), hookHash: null, cursor: null, nextAt: null, by: "priya" }, NOW);
    store.addFlowCard({ flow, title: "Planted card about Northwind", description: "Planted card history", stage: "inbox", by: "priya" }, NOW);

    const exported = exportFlow(store, row, here);
    const text = exported.json;
    for (const planted of ["planted-crm-secret-value-9f2c", GHP, "hooks.planted-host", hook.reveal!.path, hook.reveal!.path.split("/").pop()!, signed.reveal!.secret!, hookHash,
      "priya", "Priya", "alex", "priya@shop.example", "T0PLANTED", "C0PLANTED", "4242", "Northwind", "Planted card"]) expect(text, planted).not.toContain(planted);
    expect(text).not.toMatch(/"(hookHash|binding|cards|owner|createdBy|savedBy)":/);
    expect(exported.left).toEqual(["the slack channel trigger (connect a channel from the channel itself)"]);
    // The secret is named, so the import knows to ask for it; the header that held a key is gone.
    expect(exported.file.needs).toContain("secret:CRM_KEY");
    expect(text).toContain("Bearer {{secret.CRM_KEY}}");
    // It's still a flow file another installation reads.
    expect(() => parseFlowFile(text)).not.toThrow();
  });
});

describe("refusals and the preview", () => {
  const good = () => {
    const id = store.createFlow({ repo, name: "Fixes", definitionJson: JSON.stringify(FLOW_TEMPLATES[0]!.definition), by: "alex" }, NOW);
    return JSON.parse(exportFlow(store, store.getFlow(id)!, here).json) as Record<string, any>;
  };

  test("a malformed or oversized file is refused with a plain reason", () => {
    const file = good();
    const refused = (text: string) => { try { parseFlowFile(text); return null; } catch (error) { return (error as Error).message; } };
    expect(refused("{ not json")).toBe("That isn't a flow file: it isn't valid JSON.");
    expect(refused("[]")).toBe("That isn't a flow file: it should be one JSON object.");
    expect(refused(JSON.stringify({ ...file, format: "n8n" }))).toBe("That isn't a Toolroll flow file: its format isn't \"toolroll-flow\".");
    expect(refused(JSON.stringify({ ...file, version: 2 }))).toBe("version: made by a newer Toolroll (version 2; this one reads up to 1)");
    expect(refused(JSON.stringify({ ...file, zones: [] }))).toBe("zones: at least 1 item");
    expect(refused(JSON.stringify({ ...file, zones: [{ ...file.zones[0], next: "nowhere" }, ...file.zones.slice(1)] }))).toBe("zones[0].next: there's no zone called nowhere");
    expect(refused(JSON.stringify({ ...file, triggers: [{ kind: "chat", app: "slack" }] }))).toBe("triggers[0].kind: a chat channel trigger can't come from a file; connect the channel from the channel itself");
    expect(refused(JSON.stringify({ ...file, scripts: [{ name: "deploy", about: "Deploys", body: `curl -H "token: ${GHP}"` }] }))).toMatch(/^scripts\[0\]: That looks like a key or password/);
    expect(refused(JSON.stringify({ ...file, zones: file.zones.map((one: Record<string, unknown>) => one["kind"] === "approval" ? { ...one, decider: "{{param.who}}" } : one) }))).toBe("The file uses {{param.who}} but doesn't say what it asks for.");
    // A field another kind of zone has is refused by name, and a key from the saved drawing's words names the step's.
    expect(refused(JSON.stringify({ ...file, zones: [{ ...file.zones[0], decider: "owner" }, ...file.zones.slice(1)] }))).toBe("zones[0]: unknown key 'decider'");
    expect(refused(JSON.stringify({ ...file, zones: [{ ...file.zones[0], onFail: "inbox" }, ...file.zones.slice(1)] }))).toBe("zones[0]: unknown key 'onFail' (did you mean ifFails?)");
    expect(refused(JSON.stringify({ ...file, about: "x".repeat(FLOW_FILE_MAX_BYTES) }))).toBe("That file is too big: a flow file is at most 256 KB.");
  });

  test("the import previews in plain words: instructions as untrusted text, triggers off, scripts held, what it asks for", async () => {
    const flow = richFlow();
    addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "github", watch: "issues", label: "bug" }, "alex", NOW, here);
    const path = join(dir, "bug-bash.toolroll-flow.json");
    writeFileSync(path, exportFlow(store, store.getFlow(flow)!, here).json);
    const lines: string[] = [];
    const cli = (argv: string[]) => runOperate("flows", [...argv, "--json"], line => { lines.push(line); }, { databaseFile: join(here, "orders.db"), now: NOW });
    expect(await cli(["import", path, "--repo", repo, "--as", "alex", "--token", alexToken])).toBe(3);
    expect(JSON.parse(lines.pop()!)).toMatchObject({ ok: false, reason: "invalid-file", message: "This flow asks for email-to-ping: Who Tell them emails. Give it with --param email-to-ping=<value>." });

    // Removed here, the script comes from the file, held until someone approves it.
    expect(store.removeFlowScript(repo, "triage")).toBe(true);
    expect(await cli(["import", path, "--repo", repo, "--param", "email-to-ping={{card.email}}", "--param", "github-label=triage", "--as", "alex", "--token", alexToken])).toBe(0);
    const preview = JSON.parse(lines.pop()!) as { applied: boolean; title: string; terms: string[] };
    expect(preview).toMatchObject({ applied: false, title: "Import the Bug bash flow into shop" });
    const words = preview.terms.join("\n");
    expect(words).toContain("Its instructions come from the file, not from you");
    expect(words).toContain("The agent is asked: Fix [card title]. Ask [a person] before touching billing.");
    expect(words).toContain("GitHub issues in acme/shop labeled triage, from people with write access (checked every 2 minutes) → Inbox. Arrives switched off until you turn it on.");
    expect(words).toContain("Adds the triage script (Python): Says whether the report is a bug\nIt can't run until you approve it on the Scripts panel.");
    expect(words).toContain("Filled in: decider-review = owner; email-to-ping = {{card.email}}; github-repo = (left empty); github-label = triage");
    expect(words).toContain("A saved secret called CRM_KEY");
    expect(store.listFlows([repo]).map(one => one.name)).toEqual(["Bug bash"]);

    expect(await cli(["import", path, "--repo", repo, "--param", "email-to-ping={{card.email}}", "--yes", "--as", "alex", "--token", alexToken])).toBe(0);
    const done = JSON.parse(lines.pop()!) as { applied: boolean; flow: { id: number; triggers: { state: string }[] } };
    expect(done.applied).toBe(true);
    expect(done.flow.triggers.map(one => one.state)).toEqual(["paused"]);
    expect(store.flowScript(repo, "triage")?.held).toBe("imported");
    expect(await cli(["script", "approve", "--repo", repo, "--name", "triage", "--as", "alex", "--token", alexToken])).toBe(0);
    expect(JSON.parse(lines.pop()!)).toMatchObject({ applied: true, said: "Approved triage. Zones that run it go on." });
    expect(store.flowScript(repo, "triage")?.held).toBeNull();
  });

  test("export writes the file; import refuses an oversized file and plain http before reading it", async () => {
    const flow = richFlow();
    const lines: string[] = [];
    const cli = (argv: string[], fetcher?: FetchLike) => runOperate("flows", [...argv, "--json"], line => { lines.push(line); }, { databaseFile: join(here, "orders.db"), now: NOW, ...(fetcher === undefined ? {} : { flowFetch: fetcher }) });
    const out = join(dir, "out.toolroll-flow.json");
    expect(await cli(["export", String(flow), "--out", out])).toBe(0);
    expect(JSON.parse(lines.pop()!)).toMatchObject({ ok: true, path: out, fileName: "bug-bash.toolroll-flow.json" });
    const big = join(dir, "big.toolroll-flow.json");
    writeFileSync(big, " ".repeat(FLOW_FILE_MAX_BYTES + 1));
    expect(await cli(["import", big, "--repo", repo, "--as", "alex", "--token", alexToken])).toBe(3);
    expect(JSON.parse(lines.pop()!)).toMatchObject({ reason: "invalid-file", message: "That file is too big: a flow file is at most 256 KB." });
    const never = vi.fn<FetchLike>();
    expect(await cli(["import", "http://gist.github.com/sam/abc", "--repo", repo, "--as", "alex", "--token", alexToken], never)).toBe(3);
    expect(JSON.parse(lines.pop()!)).toMatchObject({ message: "Flow files are fetched over HTTPS only. Use an https:// address, or download the file and import it." });
    expect(never).not.toHaveBeenCalled();
  });

  test("an address is fetched from GitHub only, over HTTPS, and cut off past the cap", async () => {
    expect(rawFlowUrl("https://gist.github.com/sam/0123abcd")).toBe("https://gist.github.com/sam/0123abcd/raw");
    expect(rawFlowUrl("https://github.com/acme/flows/blob/main/bug-bash.toolroll-flow.json")).toBe("https://raw.githubusercontent.com/acme/flows/main/bug-bash.toolroll-flow.json");
    expect(rawFlowUrl("https://example.com/flow.json")).toBeNull();
    const stream = (bytes: number) => new ReadableStream<Uint8Array>({ start(controller) { for (let sent = 0; sent < bytes; sent += 65_536) controller.enqueue(new Uint8Array(Math.min(65_536, bytes - sent)).fill(32)); controller.close(); } });
    const answer = (body: ReadableStream<Uint8Array>, url = "https://gist.githubusercontent.com/sam/0123abcd/raw/x.json"): FetchLike => async () => ({ ok: true, status: 200, url, headers: new Headers(), body });
    await expect(fetchFlowFile("https://example.com/flow.json", answer(stream(10)))).rejects.toThrow("Toolroll fetches flow files from a gist or a file on GitHub. Download it and import the file instead.");
    await expect(fetchFlowFile("https://gist.github.com/sam/0123abcd", answer(stream(FLOW_FILE_MAX_BYTES + 10)))).rejects.toThrow("That file is too big: a flow file is at most 256 KB.");
    await expect(fetchFlowFile("https://gist.github.com/sam/0123abcd", answer(stream(10), "https://evil.example/x"))).rejects.toThrow("That address sent Toolroll somewhere other than GitHub.");
    expect(await fetchFlowFile("https://gist.github.com/sam/0123abcd", answer(stream(10)))).toBe(" ".repeat(10));
  });
});

describe("the console", () => {
  test("Export downloads the file; Import previews it in plain words, refuses a bad file, then makes the flow with its trigger off", async () => {
    const flow = richFlow();
    addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "github", watch: "issues", label: "bug" }, "alex", NOW, here);
    const { createDecisionServer } = await import("./serve.js");
    const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo, configDir: here });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address !== "object") throw new Error("listen");
    const base = `http://127.0.0.1:${address.port}`;
    const post = (cookie: string, fields: Record<string, string>) => fetch(`${base}/flows/import`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, redirect: "manual", body: new URLSearchParams(fields) });
    try {
      const cookie = (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: alexToken }), redirect: "manual" }))
        .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
      const download = await fetch(`${base}/flows/${flow}/export`, { headers: { cookie } });
      expect(download.status).toBe(200);
      expect(download.headers.get("content-disposition")).toBe('attachment; filename="bug-bash.toolroll-flow.json"');
      const document = await download.text();
      expect(document).not.toContain("priya");

      const list = await (await fetch(`${base}/flows`, { headers: { cookie } })).text();
      expect(list).toContain("Or import a flow file");
      const csrf = /name="csrf" value="([^"]+)"/.exec(list)![1]!;
      const bad = await post(cookie, { csrf, repo, document: "{ nope" });
      expect(bad.status).toBe(303);
      expect(decodeURIComponent(bad.headers.get("location")!)).toBe("/flows?problem=That isn't a flow file: it isn't valid JSON.");
      const insecure = await post(cookie, { csrf, repo, document: "", url: "http://gist.github.com/sam/1" });
      expect(decodeURIComponent(insecure.headers.get("location")!)).toContain("Flow files are fetched over HTTPS only.");

      store.removeFlowScript(repo, "triage");
      const preview = await post(cookie, { csrf, repo, document });
      expect(preview.status).toBe(400);
      const asks = await preview.text();
      expect(asks).toContain("This flow asks for email-to-ping: Who Tell them emails.");
      expect(asks).toContain('name="param.email-to-ping"');
      expect(asks).not.toContain('value="yes">Import flow');

      const ready = await post(cookie, { csrf, repo, document, "param.email-to-ping": "{{card.email}}" });
      expect(ready.status).toBe(200);
      const words = await ready.text();
      expect(words).toContain("Into shop. Nothing is made until you import it.");
      expect(words).toContain("Its instructions come from the file, not from you");
      expect(words).toContain("Arrives switched off until you turn it on.");
      expect(words).toContain("It can&#39;t run until you approve it on the Scripts panel.");
      const previewed = /name="previewed" value="([^"]+)"/.exec(words)![1]!;
      // The preview's own fields, defaults filled in, confirm what was shown (the first preview posted none of them).
      expect(words).toContain('name="param.decider-review" value="owner"');
      // Changed after the preview: shown again, not made.
      expect((await post(cookie, { csrf, repo, document, "param.email-to-ping": "ops@example.com", previewed, confirm: "yes" })).status).toBe(409);
      expect(store.listFlows([repo])).toHaveLength(1);
      const made = await post(cookie, { csrf, repo, document, "param.email-to-ping": "{{card.email}}", "param.decider-review": "owner", "param.github-repo": "", "param.github-label": "bug", previewed, confirm: "yes" });
      expect(made.status).toBe(303);
      const copy = store.listFlows([repo]).find(one => one.id !== flow)!;
      expect(made.headers.get("location")).toBe(`/flows/${copy.id}`);
      expect(store.flowTriggers(copy.id).map(one => one.state)).toEqual(["paused"]);
      expect(store.flowScript(repo, "triage")?.held).toBe("imported");
      const approved = await fetch(`${base}/flows/${copy.id}/scripts`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, approve: "yes", name: "triage" }) });
      expect(await approved.json()).toMatchObject({ ok: true, said: "Approved. Zones that run it go on." });
      expect(store.flowScript(repo, "triage")?.held).toBeNull();
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
