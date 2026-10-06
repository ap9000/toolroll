/**
 * Starter flows: Settings → Flows offers them with what each does and never does, one yes switches one on (its
 * trigger and zones, together, once), the overnight queue holds cards until its hours, and a task's "Do this every
 * time…" and the lead's chat card offer the matching one — against a real store and a real console.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { advanceFlows, flowDefinitionOf } from "./flow-engine.js";
import { flowFromSteps, validateFlowDefinition, withinHours } from "./flows.js";
import { addFlowTriggerTo, runFlowTriggers, type TriggerIo } from "./flow-triggers.js";
import { starterForWork, starterOf, startersFor, switchOnStarter, STARTER_FLOWS } from "./flow-starters.js";
import { startersHtml } from "./flow-starters-ui.js";

const T0 = new Date("2026-09-30T09:00:00.000Z");

let dir: string, repo: string, plain: string, store: Store;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-starters-")));
  repo = join(dir, "shop");
  plain = join(dir, "notes");
  mkdirSync(repo);
  mkdirSync(plain);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/alex/shop.git"]);
  execFileSync("git", ["init", "-q", plain]);
  store = openStore(join(dir, "orders.db"));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("starter flows", () => {
  test("c3: switching one on creates its trigger and zones, together and once; each says what it does and never does", () => {
    const views = startersFor(store, repo);
    expect(views.map(one => [one.id, one.on, one.blocked])).toEqual([["ci-fix", null, null], ["issue-task", null, null], ["overnight", null, null], ["plane-review", null, null]]);
    expect(views[0]!.does).toEqual(["Watches checks on main in alex/shop.", "Files a task to fix each failure, under your usual approvals.", "Asks you to review the fix."]);
    for (const one of views) expect(one.never).toMatch(/^Never merges/);

    const ci = switchOnStarter(store, starterOf("ci-fix")!, repo, "alex", T0, dir);
    expect(ci).toMatchObject({ ok: true, said: "Fix failing CI is on.", already: false });
    const flow = store.getFlow((ci as { flow: number }).flow)!;
    expect(flow).toMatchObject({ name: "Fix failing CI", owner: "alex", state: "active" });
    expect(flowDefinitionOf(flow)!.stages.map(one => [one.id, one.kind, one.next])).toEqual([["fix", "task", "review"], ["review", "approval", "done"], ["done", "done", null]]);
    expect(flowDefinitionOf(flow)!.stages.find(one => one.id === "review")).toMatchObject({ toOwner: true, onFail: "fix" });
    expect(store.flowTriggers(flow.id).map(one => [one.kind, one.state, JSON.parse(one.configJson)])).toEqual([["github", "active", { kind: "github", repo: "alex/shop", watch: "checks", label: null, branch: "main", from: "team", delivery: "poll", zone: "fix" }]]);
    expect(switchOnStarter(store, starterOf("ci-fix")!, repo, "alex", T0, dir)).toEqual({ ok: true, flow: flow.id, said: "Fix failing CI is already on.", already: true });
    expect(store.listFlows([repo])).toHaveLength(1);
    expect(startersFor(store, repo)[0]!.on).toEqual({ flow: flow.id });

    const issues = switchOnStarter(store, starterOf("issue-task")!, repo, "alex", T0, dir) as { flow: number };
    expect(store.flowTriggers(issues.flow).map(one => JSON.parse(one.configJson))).toEqual([expect.objectContaining({ kind: "github", watch: "issues", label: "toolroll", zone: "build" })]);
    expect(flowDefinitionOf(store.getFlow(issues.flow)!)!.stages.find(one => one.kind === "update")).toMatchObject({ close: false });

    // Not on GitHub: the GitHub starters say so and make nothing; the overnight queue still works.
    expect(startersFor(store, plain).map(one => one.blocked)).toEqual(["This project isn't on GitHub, so this can't watch it.", "This project isn't on GitHub, so this can't watch it.", null, null]);
    expect(switchOnStarter(store, starterOf("ci-fix")!, plain, "alex", T0, dir)).toEqual({ ok: false, said: "This project isn't on GitHub, so this can't watch it." });
    expect(store.listFlows([plain])).toEqual([]);
    expect(switchOnStarter(store, starterOf("overnight")!, plain, "alex", T0, dir)).toMatchObject({ ok: true });
    // Only the plane review opens pull requests, and none merges.
    for (const starter of STARTER_FLOWS) expect(starter.steps.some(step => step.kind === "pull-request")).toBe(starter.id === "plane-review");
    for (const starter of STARTER_FLOWS) expect([...starter.steps, ...starter.ownSteps ?? []].some(step => step.merge !== undefined)).toBe(false);
  });

  test("c2: the Morning plane review switches on as a daily plane review, then research, a build, a pull request, and a holding zone for every failure", () => {
    const view = startersFor(store, plain).find(one => one.id === "plane-review")!;
    expect(view).toMatchObject({ name: "Morning plane review", on: null, blocked: null, never: "Never merges or ships anything without you. Each fix waits for your approval." });
    expect(view.does[2]).toMatch(/^Finds the cause\. One in this project gets a fix/);
    const made = switchOnStarter(store, starterOf("plane-review")!, plain, "alex", T0, dir);
    expect(made).toMatchObject({ ok: true, said: "Morning plane review is on.", already: false });
    const flow = store.getFlow((made as { flow: number }).flow)!;
    const stages = flowDefinitionOf(flow)!.stages;
    expect(stages.map(one => [one.id, one.kind, one.next, one.onFail])).toEqual([
      ["find-cause", "report", "fix", "needs-a-look"], ["fix", "task", "pull-request", "needs-a-look"], ["pull-request", "pull-request", "done", "needs-a-look"],
      ["needs-a-look", "inbox", "done", null], ["done", "done", null, null]]);
    expect(stages.find(one => one.id === "pull-request")!.merge).toBeUndefined();
    expect(stages[0]!.instructions).toContain("say exactly what to change in Toolroll's settings");
    expect(stages[1]!.instructions).toContain("{{stage.find-cause}}");
    expect(store.flowTriggers(flow.id).map(one => [one.kind, JSON.parse(one.configJson)])).toEqual([["schedule", { kind: "plane-review", schedule: expect.stringMatching(/^daily:07:30(@.+)?$/), zone: "find-cause" }]]);
    expect(startersFor(store, plain).find(one => one.id === "plane-review")!.on).toEqual({ flow: flow.id });

    // In Toolroll's own repository, the fixes land in Toolroll.
    const own = join(dir, "own");
    mkdirSync(own);
    writeFileSync(join(own, "package.json"), JSON.stringify({ name: "toolroll" }));
    expect(startersFor(store, own).find(one => one.id === "plane-review")!.does[2]).toBe("Finds the cause in Toolroll's code, builds a fix under your usual approvals, and opens a pull request.");
    const ours = switchOnStarter(store, starterOf("plane-review")!, own, "alex", T0, dir) as { flow: number };
    const ourStages = flowDefinitionOf(store.getFlow(ours.flow)!)!.stages;
    expect(ourStages[0]!.instructions).toContain("This project is Toolroll itself, so the fix belongs here.");
    expect(ourStages[1]!.instructions).not.toContain("No build needed");
  });

  test("the overnight queue holds a card added in the day until 22:00, and one added at night goes straight on", () => {
    expect(withinHours({ from: "22:00", to: "06:00", timeZone: "UTC" }, new Date("2026-09-30T14:00:00Z"))).toBe(false);
    expect(withinHours({ from: "22:00", to: "06:00", timeZone: "UTC" }, new Date("2026-09-30T22:00:00Z"))).toBe(true);
    expect(withinHours({ from: "22:00", to: "06:00", timeZone: "UTC" }, new Date("2026-10-01T05:59:00Z"))).toBe(true);
    expect(withinHours({ from: "09:00", to: "17:00", timeZone: "Europe/London" }, new Date("2026-09-30T08:30:00Z"))).toBe(true);
    expect(() => validateFlowDefinition({ version: 1, start: "a", stages: [{ id: "a", title: "Tonight", kind: "wait", wait: { for: "hours", from: "25:00", to: "06:00" } }] })).toThrow("stages[0].wait.from: must be a time like 22:00");

    const made = switchOnStarter(store, starterOf("overnight")!, repo, "alex", T0, dir) as { flow: number };
    const flow = store.getFlow(made.flow)!;
    // Pinned to UTC here so the test reads the same anywhere; a real one uses the computer's time zone.
    const definition = flowDefinitionOf(flow)!;
    definition.stages[0]!.wait = { ...definition.stages[0]!.wait!, timeZone: "UTC" };
    store.saveFlow(flow.id, { name: flow.name, definitionJson: JSON.stringify(validateFlowDefinition(definition)), sawRevision: flow.revision, by: "alex" }, T0);
    expect(store.flowTriggers(flow.id).map(one => JSON.parse(one.configJson))).toEqual([expect.objectContaining({ kind: "button", label: "Queue for tonight", zone: "tonight" })]);
    const card = store.addFlowCard({ flow: flow.id, title: "Tidy the README", description: null, stage: "tonight", by: "alex" }, new Date("2026-09-30T14:00:00Z"));
    advanceFlows(store, repo, new Date("2026-09-30T14:00:00Z"));
    expect(store.getFlowCard(card)).toMatchObject({ stage: "tonight", waiting: "Waiting until 22:00." });
    advanceFlows(store, repo, new Date("2026-09-30T21:59:00Z"));
    expect(store.getFlowCard(card)!.stage).toBe("tonight");
    advanceFlows(store, repo, new Date("2026-09-30T22:01:00Z"));
    expect(store.getFlowCard(card)!.stage).toBe("build");
  });

  test("\"Do this every time…\" offers the starter that matches the work", () => {
    expect(starterForWork("CI failed on main: unit tests are red").id).toBe("ci-fix");
    expect(starterForWork("Fix the failing checks on the release branch").id).toBe("ci-fix");
    expect(starterForWork("Fix https://github.com/alex/shop/issues/42").id).toBe("issue-task");
    expect(starterForWork("Tidy the README").id).toBe("overnight");
  });

  test("c3/c4: Settings → Flows offers the starters, marks the one asked about, and one Switch on creates its trigger and zones", async () => {
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("alex");
    store.upsertProject(repo, "shop", T0);
    const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo, configDir: dir });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address !== "object") throw new Error("listen");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const cookie = (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: alex.token }), redirect: "manual" }))
        .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
      const page = await (await fetch(`${base}/settings/flows?repo=${encodeURIComponent(repo)}&starter=overnight`, { headers: { cookie } })).text();
      expect(page).toContain("<h1>Flows</h1>");
      expect(page.match(/data-starter="[a-z-]+"/g)).toEqual(['data-starter="overnight"', 'data-starter="ci-fix"', 'data-starter="issue-task"', 'data-starter="plane-review"']);
      expect(page).toContain('data-starter="overnight" data-suggested="true"');
      expect(page).toContain("Never merges or pushes to your branch. You decide what ships.");
      expect(page.match(/<button type="submit">Switch on<\/button>/g)).toHaveLength(4);
      const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;

      const switched = await fetch(`${base}/settings/flows/on`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, redirect: "manual",
        body: new URLSearchParams({ csrf, repo, starter: "ci-fix" }) });
      expect(switched.status).toBe(303);
      expect(switched.headers.get("location")).toBe(`/settings/flows?repo=${encodeURIComponent(repo)}&said=${encodeURIComponent("Fix failing CI is on.")}`);
      const flow = store.listFlows([repo]).find(one => one.name === "Fix failing CI")!;
      expect(flowDefinitionOf(flow)!.stages.map(one => one.kind)).toEqual(["task", "approval", "done"]);
      expect(store.flowTriggers(flow.id).map(one => one.kind)).toEqual(["github"]);
      const after = await (await fetch(`${base}${switched.headers.get("location")}`, { headers: { cookie } })).text();
      expect(after).toContain(`<a class="button-link starter-open" href="/flows/${flow.id}">Open flow</a>`);
      expect(after).toContain("Fix failing CI is on.");
      // A stale form is refused; nothing more is made.
      expect((await fetch(`${base}/settings/flows/on`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, redirect: "manual",
        body: new URLSearchParams({ csrf: "stale", repo, starter: "overnight" }) })).status).toBe(403);
      expect(store.listFlows([repo])).toHaveLength(1);

      // The Morning plane review switches on from here too.
      const fresh = await (await fetch(`${base}/settings/flows?repo=${encodeURIComponent(repo)}`, { headers: { cookie } })).text();
      const token = /name="csrf" value="([^"]+)"/.exec(fresh)![1]!;
      const review = await fetch(`${base}/settings/flows/on`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, redirect: "manual",
        body: new URLSearchParams({ csrf: token, repo, starter: "plane-review" }) });
      expect(review.status).toBe(303);
      const plane = store.listFlows([repo]).find(one => one.name === "Morning plane review")!;
      expect(store.flowTriggers(plane.id).map(one => JSON.parse(one.configJson).kind)).toEqual(["plane-review"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test("one failing CI run files one card and one task, however many triggers watch the checks", async () => {
    const ci = switchOnStarter(store, starterOf("ci-fix")!, repo, "alex", T0, dir) as { flow: number };
    // A second checks trigger on the same flow, and a second flow that also fixes CI.
    expect(addFlowTriggerTo(store, store.getFlow(ci.flow)!, { kind: "github", watch: "checks", branch: "main" }, "alex", T0, dir)).toMatchObject({ ok: true });
    const other = store.createFlow({ repo, name: "Fix CI again", definitionJson: JSON.stringify(flowFromSteps(starterOf("ci-fix")!.steps, null)), by: "alex" }, T0);
    expect(addFlowTriggerTo(store, store.getFlow(other)!, { kind: "github", watch: "checks", branch: "main" }, "alex", T0, dir)).toMatchObject({ ok: true });
    const failed = { name: "CI", conclusion: "failure", head_branch: "main", head_sha: "0123456789abcdef", display_title: "Release 0.9.10", created_at: "2026-09-30T09:05:00Z", html_url: "https://github.com/alex/shop/actions/runs/1" };
    const io: TriggerIo = { gh: async () => ({ code: 0, stdout: JSON.stringify({ workflow_runs: [failed] }), stderr: "", timedOut: false, notFound: false }), fetch, dir };
    const later = new Date("2026-09-30T09:10:00.000Z");
    expect(await runFlowTriggers(store, repo, later, io)).toMatchObject({ added: 1, checked: 3, problems: [] });
    expect([...store.flowCards(ci.flow, true), ...store.flowCards(other, true)].map(one => one.title)).toEqual(["Checks failed on main: CI"]);
    expect(store.activeFlowTriggers(repo).filter(one => one.lastOutcome?.includes("already a card in “Fix failing CI”"))).toHaveLength(2);
    // The next check finds the same failing run and makes nothing.
    expect(await runFlowTriggers(store, repo, new Date("2026-09-30T09:20:00.000Z"), io)).toMatchObject({ added: 0, problems: [] });
    expect(advanceFlows(store, repo, later).filed).toHaveLength(1);
    expect(advanceFlows(store, repo, later).filed).toHaveLength(0);
  });

  test("the page reads in plain words when nothing can be switched on here", () => {
    const html = startersHtml({ repo: plain, projects: [{ path: plain, name: "notes" }], starters: startersFor(store, plain), csrf: "x", canSwitch: true, suggested: null, said: null, problem: null });
    expect(html.match(/Switch on<\/button>/g)).toHaveLength(2);
    expect(html).toContain("This project isn&#39;t on GitHub, so this can&#39;t watch it.");
    expect(startersHtml({ repo: plain, projects: [], starters: startersFor(store, plain), csrf: "", canSwitch: false, suggested: null, said: null, problem: null })).toContain("An approver switches these on.");
  });
});
