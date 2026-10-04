/**
 * The flow gallery: Flows → New and Settings → Flows show every template grouped, each is created from its page
 * with sample answers (its zones, triggers and scripts, exactly as previewed), and every template validates and
 * never merges without a person — against a real store and a real console.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { flowDefinitionOf } from "./flow-engine.js";
import { reachableWithout, validateFlowDefinition } from "./flows.js";
import { galleryUseHtml } from "./flow-gallery-ui.js";
import { BLANK, buildFromGallery, GALLERY, galleryDiagram, previewGallery, SEND_RESULT, type GalleryAnswers } from "./flow-gallery.js";

const T0 = new Date("2026-10-01T09:00:00.000Z");
/** Sample answers a person might give, none of them the defaults. */
const SAMPLE: GalleryAnswers = { label: "bug-report", branch: "release", time: "23:00", schedule: "weekdays 03:00", command: "npm run journeys -- --real-models", outdated: "pip" };
const NEW = {
  ship: ["Overnight bug bash", "Dependency PR babysitter", "Release notes writer", "Docs follow the code", "PR second opinion"],
  health: ["Fix failing CI", "Flaky test hunter", "Morning plane review", "Nightly real-model journeys", "Weekly upkeep", "Error to fix"],
  users: ["Feedback to feature"],
};
const BUSINESS = ["Research flow", "Spam filter", "Lead routing", "Exception routing", "Email replies", "Reply and follow up", "Decisions that don't stall"];

let dir: string, repo: string, plain: string, store: Store;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-gallery-")));
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

describe("flow gallery", () => {
  test("c2: every template validates, its triggers check out, and nothing merges without a person", () => {
    for (const template of [...GALLERY, BLANK]) {
      for (const answers of [{}, SAMPLE]) {
        const preview = previewGallery(store, template, repo, answers, "alex", T0);
        const { definition } = preview.built;
        expect(validateFlowDefinition(JSON.parse(JSON.stringify(definition))), template.id).toEqual(definition);
        expect(preview.startsFrom, template.id).toHaveLength(template.triggers.length);
        expect(preview.built.does.join(" "), template.id).not.toMatch(/\{\{/);
        expect(JSON.stringify(preview.built.triggers), template.id).not.toMatch(/\{\{(ask|script|github)/);
        // No template merges anything; a pull request it opens waits for a person.
        expect(definition.stages.filter(one => one.merge !== undefined), template.id).toEqual([]);
        expect(preview.built.never, template.id).toMatch(/^(Never|Does nothing)/);
        // Every new template's pull requests open only after a person decided (the plane review's fix is a task under the usual approvals).
        if (template.id !== "morning-plane-review" && template.id !== "issues-to-prs") {
          const unapproved = reachableWithout(definition.stages, definition.start, one => one.kind === "approval");
          expect(definition.stages.filter(one => one.kind === "pull-request" && unapproved.has(one.id)).map(one => one.id), template.id).toEqual([]);
        }
      }
      expect(validateFlowDefinition(galleryDiagram(template))).toBeTruthy();
    }
    // Answers fill in where they belong; bad ones are refused in plain words.
    const bash = buildFromGallery(store, GALLERY.find(one => one.id === "overnight-bug-bash")!, repo, SAMPLE);
    expect(bash.definition.stages[0]).toMatchObject({ kind: "wait", wait: { for: "hours", from: "23:00", to: "06:00" } });
    expect(bash.triggers).toEqual([{ kind: "github", watch: "issues", label: "bug-report" }]);
    expect(bash.does[0]).toBe("Watches issues labelled “bug-report” in alex/shop, from people with write access.");
    const upkeep = buildFromGallery(store, GALLERY.find(one => one.id === "weekly-upkeep")!, repo, SAMPLE);
    expect(upkeep.scripts[0]!.body).toContain("pip list --outdated");
    expect(upkeep.does[0]).toBe("Checks for outdated pip packages every weekday at 03:00, with no AI.");
    expect(() => buildFromGallery(store, GALLERY.find(one => one.id === "fix-ci")!, repo, { branch: "no spaces please" })).toThrow("That branch name isn't valid.");
    expect(() => buildFromGallery(store, GALLERY.find(one => one.id === "nightly-journeys")!, repo, { schedule: "whenever" })).toThrow("Say when like");
    expect(() => buildFromGallery(store, GALLERY.find(one => one.id === "fix-ci")!, plain, {})).toThrow("This project isn't on GitHub");
  });

  test("c1: the gallery shows the templates grouped, and each is created from its page with sample answers", async () => {
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
      const get = async (path: string) => (await fetch(`${base}${path}`, { headers: { cookie } })).text();
      const post = (path: string, form: Record<string, string>) => fetch(`${base}${path}`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, redirect: "manual", body: new URLSearchParams(form) });

      // Flows → New: four groups, in order, with the brief's templates in theirs and the business ones under Operations.
      const gallery = await get("/flows/new");
      expect(gallery.match(/<h2 id="gallery-[a-z]+">[^<]+<\/h2>/g)).toEqual(["Ship code", "Keep it healthy", "Hear from users", "Operations"].map((label, i) => `<h2 id="gallery-${["ship", "health", "users", "ops"][i]}">${label}</h2>`));
      const group = (id: string) => [...gallery.split(`data-group="${id}"`)[1]!.split("</div>")[0]!.matchAll(/<h3>([^<]+)<\/h3>/g)].map(one => one[1]!.replace(/&#39;/g, "'"));
      for (const [id, names] of Object.entries(NEW)) expect(group(id)).toEqual(expect.arrayContaining(names));
      expect(group("ops")).toEqual(BUSINESS);
      expect(gallery.match(/>Use this<\/a>/g)).toHaveLength(GALLERY.length);
      expect(gallery).toContain('<li>Dependabot or Renovate</li>');
      expect(gallery).toContain('<svg class="gallery-zones"');
      // The Flows list leads to it; Settings → Flows shows it beside the starters.
      expect(await get("/flows")).toContain('<a class="button-link" href="/flows/new">New flow</a>');
      const settings = await get(`/settings/flows?repo=${encodeURIComponent(repo)}`);
      expect(settings).toContain('data-starter="ci-fix"');
      expect(settings).toContain(`href="/flows/new/weekly-upkeep?repo=${encodeURIComponent(repo)}"`);

      // Each template, from its page: preview the sample answers, then create exactly that.
      for (const template of [...GALLERY, BLANK]) {
        const page = await get(`/flows/new/${template.id}?repo=${encodeURIComponent(repo)}`);
        expect(page, template.id).toContain("What it will do");
        expect(page, template.id).toContain(template.never.replace(/'/g, "&#39;"));
        const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
        const answers = Object.fromEntries(template.asks.map(ask => [ask.key, SAMPLE[ask.key]!]));
        const previewed = await post(`/flows/new/${template.id}`, { csrf, repo, name: "", intent: "preview", ...answers });
        expect(previewed.status, template.id).toBe(200);
        const shown = await previewed.text();
        const digest = /name="previewed" value="([^"]*)"/.exec(shown)![1]!;
        expect(digest, template.id).not.toBe("");
        const before = store.listFlows([repo]).length;
        const made = await post(`/flows/new/${template.id}`, { csrf, repo, name: "", intent: "create", previewed: digest, ...answers });
        expect(made.status, template.id).toBe(303);
        const flow = store.getFlow(Number(/^\/flows\/(\d+)$/.exec(made.headers.get("location") ?? "")?.[1]))!;
        expect(store.listFlows([repo])).toHaveLength(before + 1);
        expect(flow, template.id).toMatchObject({ name: template.name, owner: "alex", state: "active" });
        const definition = flowDefinitionOf(flow)!;
        expect(definition, template.id).toEqual(buildFromGallery(store, template, repo, answers).definition);
        const triggers = store.flowTriggers(flow.id).map(one => JSON.parse(one.configJson) as Record<string, unknown>);
        expect(triggers.map(one => one["kind"]), template.id).toEqual(template.triggers.map(one => one["kind"]));
        for (const trigger of triggers) expect(trigger["zone"], template.id).toBe(definition.start);
        for (const stage of definition.stages.filter(one => one.kind === "check")) expect(store.flowScript(repo, stage.script!), template.id).not.toBeNull();
      }
      // The answers landed where they belong.
      const byName = (name: string) => store.listFlows([repo]).find(one => one.name === name)!;
      expect(store.flowTriggers(byName("Fix failing CI").id).map(one => JSON.parse(one.configJson))).toEqual([expect.objectContaining({ kind: "github", watch: "checks", branch: "release", repo: "alex/shop" })]);
      expect(store.flowTriggers(byName("Dependency PR babysitter").id).map(one => JSON.parse(one.configJson))).toEqual([expect.objectContaining({ watch: "pulls", label: "bug-report", from: "anyone" })]);
      expect(store.flowTriggers(byName("Nightly real-model journeys").id).map(one => JSON.parse(one.configJson))).toEqual([expect.objectContaining({ kind: "schedule", schedule: expect.stringMatching(/^weekdays:03:00(@.+)?$/), title: "Nightly journeys" })]);
      expect(store.flowScript(repo, "nightly-journeys")).toMatchObject({ body: "npm run journeys -- --real-models", timeoutMinutes: 60 });
      expect(store.flowTriggers(byName("Morning plane review").id).map(one => JSON.parse(one.configJson))).toEqual([expect.objectContaining({ kind: "plane-review", schedule: expect.stringMatching(/^daily:23:00/) })]);
      expect(store.flowTriggers(byName("Error to fix").id).map(one => JSON.parse(one.configJson))).toEqual([expect.objectContaining({ kind: "webhook", titleField: "data.issue.title" })]);

      // Answers changed after the preview are previewed again, not made.
      const page = await get(`/flows/new/fix-ci?repo=${encodeURIComponent(repo)}`);
      const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
      const stale = /name="previewed" value="([^"]*)"/.exec(page)![1]!;
      const count = store.listFlows([repo]).length;
      const changed = await post("/flows/new/fix-ci", { csrf, repo, name: "", intent: "create", previewed: stale, branch: "develop" });
      expect(changed.status).toBe(200);
      expect(await changed.text()).toContain("Your answers changed. Check the preview, then create the flow.");
      expect(store.listFlows([repo])).toHaveLength(count);
      // "Send me the result": off by default on every template's page; ticked, the flow ends with it.
      const research = await get(`/flows/new/research?repo=${encodeURIComponent(repo)}`);
      expect(research).toContain(`<input type="checkbox" name="send-result" value="yes" data-send-result><span>Send me the result`);
      const ticked = await post("/flows/new/research", { csrf, repo, name: "Answers", intent: "preview", "send-result": "yes" });
      const tickedPage = await ticked.text();
      expect(tickedPage).toContain('value="yes" checked data-send-result');
      expect(tickedPage).toContain(SEND_RESULT.does);
      const made = await post("/flows/new/research", { csrf, repo, name: "Answers", intent: "create", "send-result": "yes", previewed: /name="previewed" value="([^"]*)"/.exec(tickedPage)![1]! });
      expect(made.status).toBe(303);
      const answers = flowDefinitionOf(store.getFlow(Number(/^\/flows\/(\d+)$/.exec(made.headers.get("location") ?? "")?.[1]))!)!;
      expect(answers.stages.map(one => [one.id, one.kind, one.next])).toEqual([["inbox", "inbox", "research"], ["research", "report", "check"], ["check", "approval", "share"], ["share", "notify", "send-result"], ["send-result", "send", "done"], ["done", "done", null]]);
      // A project that isn't on GitHub can't use a GitHub template: the page says why and offers no Create.
      const fixCi = GALLERY.find(one => one.id === "fix-ci")!;
      let problem = "";
      try { previewGallery(store, fixCi, plain, {}, "alex", T0); } catch (error) { problem = (error as Error).message; }
      const offGitHub = galleryUseHtml({ template: fixCi, projects: [{ path: plain, name: "notes" }], repo: plain, answers: {}, name: fixCi.name, preview: null, problem, csrf: "x", diagram: galleryDiagram(fixCi) });
      expect(offGitHub).toContain("This project isn&#39;t on GitHub, so this can&#39;t watch it.");
      expect(offGitHub).not.toContain('value="create"');
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
