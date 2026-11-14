#!/usr/bin/env node
/** Click paths (the one-workspace plan, slice S0): how many clicks and full page loads the common jobs take today,
 * measured in a browser on the demo (as `toolroll demo` serves it: a fenced sandbox, a scripted lead, no model call,
 * nothing reaching outside), at 1440x900, signed in through the demo's own one-time link. Each job starts on a fresh
 * demo with Work open (`/`, slice S2a) and Passwordless on (the no-password case), and ends when the console itself
 * shows it done:
 *
 *   approve-plan      approve the plan Work shows first (the scope is approved)
 *   review-accept     open the waiting result and accept it (the task is done)
 *   send-back         open the waiting result and send it back with a note (the revision is filed)
 *   watch-running     open the running task's live activity (the activity panel is showing)
 *   start-task        file a new task (the task exists)
 *   add-project       add a git repository from a projects folder (the project is added; this demo gets a projects
 *                     folder, which `toolroll demo` doesn't have)
 *   approve-plan-password  the same approval with Passwordless off, measured up to the password field and stopped there:
 *                     nothing is typed. The task page carrying the password field is a ceremony load.
 *
 * A click is a pressed control; typing into a field is counted apart. A load is a full document load after Work is
 * open; a ceremony load (a page with a password field, or a ceremony route in test/destinations.json) is counted apart
 * from the others. Each number is held to its ceiling in test/click-path-ceilings.json: a run over any ceiling fails.
 * A slice that shortens a path lowers its ceiling in the same change; `--write-ceilings` rewrites the file from the run.
 *
 *   npm run build && node scripts/click-paths-journey.mjs [--port <n>] [--only <name regex>] [--out <report.json>]
 *     [--write-ceilings] [--playwright <playwright/index.mjs>] [--chromium <browser executable>]
 *
 * The report goes to output/click-paths/report.json (ignored by Git) unless --out names another file. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, assertFixtureSafe, isolateEnvironment } from "./settings-journey/fixture.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at === -1 ? fallback : args[at + 1]; };
const flag = name => args.includes(name);
const CEILINGS_FILE = join(ROOT, "test", "click-path-ceilings.json");
const MANIFEST_FILE = join(ROOT, "test", "destinations.json");
const port = Number(option("--port", "0"));
if (!Number.isInteger(port) || port < 0 || port === 4180) throw new Error("--port must be a free port other than 4180 (0 picks one)");
const only = option("--only", null) === null ? null : new RegExp(option("--only", ""), "i");
const outFile = resolve(option("--out", join(ROOT, "output", "click-paths", "report.json")));

for (const file of readdirSync(join(ROOT, "src")).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
  const built = join(ROOT, "dist", file.replace(/\.ts$/, ".js"));
  if (!existsSync(built) || statSync(built).mtimeMs < statSync(join(ROOT, "src", file)).mtimeMs) throw new Error(`Run npm run build first: ${file}`);
}

// The environment first: HOME, the config folder and the databases all point into one temp root, and the demo
// sandboxes are made inside it too; it is removed at the end however the run ends.
const isolated = isolateEnvironment();
const tmpBefore = process.env.TMPDIR;
process.env.TMPDIR = join(isolated.root, "tmp");
mkdirSync(process.env.TMPDIR);
const dist = path => import(pathToFileURL(join(ROOT, "dist", path)).href);
const { createDemoSandbox } = await dist("demo.js");
const { createDecisionServer } = await dist("serve.js");
const { setPasswordless } = await dist("passwordless.js");
const { matchRoute } = await dist("server/route-table.js");
const ceremonyRoutes = new Set(Object.entries(JSON.parse(readFileSync(MANIFEST_FILE, "utf8")).routes).filter(([, entry]) => entry.kind === "ceremony").map(([id]) => id));

async function playwright() {
  const given = option("--playwright", null) ?? process.env.PLAYWRIGHT_MODULE ?? null;
  const cache = join(homedir(), ".npm", "_npx");
  const cached = existsSync(cache) ? readdirSync(cache).map(one => join(cache, one, "node_modules/playwright/index.mjs")).filter(one => existsSync(one)) : [];
  const executable = option("--chromium", null);
  for (const candidate of given === null ? [...cached, "playwright"] : [given]) {
    const loaded = await import(candidate.startsWith("/") ? pathToFileURL(candidate).href : candidate).catch(() => null);
    if (loaded?.chromium !== undefined && existsSync(executable ?? loaded.chromium.executablePath())) return { chromium: loaded.chromium, executable };
  }
  throw new Error("Needs Playwright and its browser: npx playwright install chromium, or pass --playwright <playwright/index.mjs> (and --chromium <browser>)");
}

/** A fresh demo world, served on 127.0.0.1. */
async function demoWorld({ passwordless, projectsFolder }) {
  const made = createDemoSandbox(new Date());
  if (passwordless) setPasswordless(made.store, true, made.seed.login.name, new Date());
  let folder = null, newRepo = null;
  if (projectsFolder) {
    folder = join(made.sandbox, "projects");
    newRepo = join(folder, "ledger-tools");
    mkdirSync(newRepo, { recursive: true });
    const git = more => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=demo", "-c", "user.email=demo@example.invalid", ...more], { cwd: newRepo, stdio: "ignore" });
    git(["init", "-q"]);
    git(["commit", "-q", "--allow-empty", "-m", "Start"]);
  }
  const server = createDecisionServer({ store: made.store, evidenceRoot: made.evidenceRoot, clock: () => new Date(), repos: made.seed.repos, demoLead: made.lead,
    ...(folder === null ? {} : { projectRoots: [folder] }) });
  await new Promise((ready, failed) => { server.once("error", failed); server.listen(port, "127.0.0.1", ready); });
  const bound = server.address().port;
  assertFixtureSafe({ root: isolated.root, liveDb: isolated.liveDb, port: bound, paths: { sandbox: made.sandbox, evidence: made.evidenceRoot } });
  const close = () => new Promise(closed => { made.lead.stop(); server.close(() => { made.store.close(); closed(); }); });
  return { made, server, base: `http://127.0.0.1:${bound}`, store: made.store, newRepo, close };
}

async function until(what, test, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await test()) return;
    if (Date.now() > end) throw new Error(`timed out waiting: ${what}`);
    await new Promise(next => setTimeout(next, 150));
  }
}

/** The tasks whose plan waits for an approval. */
const waitingPlans = store => store.listTasks().filter(task => { const scope = store.getScope(task.id); return scope !== null && scope.approvedAt == null; }).map(task => task.id);

const FLOWS = [
  {
    name: "approve-plan", about: "approve the plan Work shows first", passwordless: true,
    async run({ page, store, click }) {
      const pane = page.locator('[data-work-panel] [data-home-approval="approve"]');
      await pane.waitFor();
      const id = await page.locator('[data-group="decide"] [data-row]').first().getAttribute("data-row");
      const before = waitingPlans(store);
      await click(pane.locator("[data-home-approve]"));
      await until(`a plan of ${id} approved`, () => waitingPlans(store).length === before.length - 1);
      const approved = before.filter(one => !waitingPlans(store).includes(one));
      if (approved.length !== 1 || !approved[0].startsWith(id)) throw new Error(`approved ${approved.join(", ")}, not ${id}'s plan`);
      return `${approved[0]} approved`;
    },
  },
  {
    name: "review-accept", about: "open the waiting result and accept it", passwordless: true,
    async run({ page, store, click }) {
      const id = "fix-payout-rounding";
      await click(page.locator(`[data-row="${id}"] .k-row-t`));
      await click(page.locator(`[data-work-task="${id}"] [data-work-accept]:not([aria-disabled])`));
      await until(`${id} done`, () => store.getTask(id)?.state === "done");
      return `${id} done`;
    },
  },
  {
    name: "send-back", about: "open the waiting result and send it back with a note", passwordless: true,
    async run({ page, store, click, type }) {
      const id = "fix-payout-rounding";
      await click(page.locator(`[data-row="${id}"] .k-row-t`));
      const box = page.locator(`[data-work-task="${id}"] [data-work-send-back]`);
      await type(box.locator("textarea"), "Round half-cents up, not down.");
      const send = box.getByRole("button", { name: "Send back" });
      // The send takes a press once the result on screen has settled (a redraw holds it for a moment).
      await until("Send back takes a press", async () => await send.getAttribute("aria-disabled") === null);
      await click(send);
      await until(`${id}'s revision filed`, () => store.getTask(`${id}-v2`) !== null);
      return `${id}-v2 filed`;
    },
  },
  {
    name: "watch-running", about: "open the running task's live activity", passwordless: true,
    async run({ page, store, click }) {
      const id = "harden-webhook-retries";
      if (store.getTask(id)?.state !== "running") throw new Error(`${id} isn't running in the demo`);
      await click(page.locator(`[data-row="${id}"] .k-row-t`));
      await click(page.locator(`[data-work-task="${id}"] [data-work-watch]`));
      await page.locator('[data-task-panel="activity"]').waitFor({ state: "visible" });
      return `${id}'s activity showing`;
    },
  },
  {
    name: "start-task", about: "file a new task", passwordless: true,
    async run({ page, store, click, type }) {
      const title = "Show the payout currency next to every amount";
      await click(page.locator(".so-rail").getByRole("link", { name: "New task" }));
      await type(page.locator("#nt-form textarea[name=title]"), title);
      await click(page.locator('#nt-form button[type=submit][aria-label="File task"]'));
      await page.waitForURL(url => url.pathname.startsWith("/t/"));
      const id = decodeURIComponent(new URL(page.url()).pathname.slice(3));
      await until(`task ${id} filed`, () => store.getTask(id)?.title === title);
      return `${id} filed`;
    },
  },
  {
    name: "add-project", about: "add a git repository from a projects folder", passwordless: true, projectsFolder: true,
    async run({ page, store, click, type, newRepo }) {
      const want = realpathSync(newRepo);
      await click(page.locator(".so-rail").getByRole("link", { name: "Manage projects", exact: true }));
      await click(page.getByRole("button", { name: "Add project" }).first());
      await type(page.locator("#add-path"), newRepo);
      await click(page.getByRole("button", { name: "Add and open" }));
      await until("the project added", () => store.listProjects().some(one => one.path === want));
      return "ledger-tools added";
    },
  },
  {
    name: "approve-plan-password", about: "approve with Passwordless off, up to the password field (nothing typed)", passwordless: false,
    async run({ page, store, click }) {
      const pane = page.locator('[data-work-panel] [data-home-approval="review"]');
      await pane.waitFor();
      const id = await page.locator('[data-group="decide"] [data-row]').first().getAttribute("data-row");
      const before = waitingPlans(store);
      await click(pane.getByRole("link", { name: /Review the plan/ }));
      await click(page.getByRole("button", { name: "Approve", exact: true }).first());
      await page.locator("input[type=password]").first().waitFor({ state: "visible" });
      if (waitingPlans(store).length !== before.length) throw new Error(`a plan was approved without a password`);
      return `stopped at ${id}'s password field`;
    },
  },
];

const report = { synthetic: true, modelCalls: 0, viewport: "1440x900", flows: {} };
const failures = [];
const { chromium, executable } = await playwright();
const browser = await chromium.launch({ headless: true, ...(executable === null ? {} : { executablePath: executable }) });
try {
  for (const flow of FLOWS.filter(one => only === null || only.test(one.name))) {
    const world = await demoWorld(flow);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", colorScheme: "light" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const counts = { clicks: 0, typed: 0, loads: 0, ceremonyLoads: 0 };
    const seen = [];
    let counting = false;
    const pending = [];
    // A full document load is a main-frame document response that isn't a redirect.
    page.on("response", response => {
      const request = response.request();
      if (!counting || !request.isNavigationRequest() || request.frame() !== page.mainFrame() || response.status() >= 300 && response.status() < 400) return;
      pending.push((async () => {
        const url = new URL(response.url());
        const body = await response.text().catch(() => "");
        const route = matchRoute("GET", url.pathname, "console");
        const ceremony = body.includes('"sensitive":true') || (route !== null && ceremonyRoutes.has(route.id));
        if (ceremony) counts.ceremonyLoads += 1; else counts.loads += 1;
        seen.push(`${ceremony ? "ceremony load" : "load"} ${url.pathname}`);
      })());
    });
    const labelOf = locator => locator.first().evaluate(element => element.innerText.trim() || element.getAttribute("aria-label") || element.tagName.toLowerCase()).catch(() => "?");
    const click = async locator => { counts.clicks += 1; seen.push(`click ${await labelOf(locator)}`.replace(/\s+/g, " ").slice(0, 80)); await locator.first().click(); await page.waitForLoadState("load"); };
    const type = async (locator, text) => { counts.typed += 1; seen.push("type"); await locator.first().fill(text); };
    const started = Date.now();
    try {
      await page.goto(world.base + world.server.mintSignInLink(world.made.seed.login.name));
      await page.goto(world.base + "/", { waitUntil: "load" });
      await page.locator("[data-work]").waitFor();
      counting = true;
      const outcome = await flow.run({ page, store: world.store, click, type, newRepo: world.newRepo });
      // A load the last click started finishes before the count is read.
      await page.waitForTimeout(700);
      await page.waitForLoadState("load");
      await Promise.all(pending);
      if (errors.length > 0) throw new Error(`browser errors: ${errors.join(" | ")}`);
      report.flows[flow.name] = { about: flow.about, ...counts, outcome, steps: seen, ms: Date.now() - started };
      console.log(`PASS ${flow.name.padEnd(22)} ${counts.clicks} clicks, ${counts.typed} typed, ${counts.loads} loads, ${counts.ceremonyLoads} ceremony loads — ${outcome}`);
    } catch (error) {
      failures.push(`${flow.name}: ${error.message.split("\n")[0]}`);
      mkdirSync(dirname(outFile), { recursive: true });
      await page.screenshot({ path: join(dirname(outFile), `${flow.name}-failed.png`) }).catch(() => undefined);
      console.log(`FAIL ${flow.name}: ${error.message.split("\n")[0]}`);
    } finally {
      await context.close();
      await world.close();
    }
  }
} finally {
  await browser.close();
  if (tmpBefore === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = tmpBefore;
  isolated.restore();
}

// Ceilings: every measured number at or under its ceiling; a flow without one fails.
const METRICS = ["clicks", "typed", "loads", "ceremonyLoads"];
if (flag("--write-ceilings") && failures.length === 0) {
  const kept = existsSync(CEILINGS_FILE) ? JSON.parse(readFileSync(CEILINGS_FILE, "utf8")) : {};
  const flows = { ...(kept.flows ?? {}) };
  for (const [name, one] of Object.entries(report.flows)) flows[name] = Object.fromEntries(METRICS.map(key => [key, one[key]]));
  const lines = Object.entries(flows).map(([name, one]) => `    ${JSON.stringify(name)}: ${JSON.stringify(one)}`);
  writeFileSync(CEILINGS_FILE, `{\n  "about": ${JSON.stringify(kept.about ?? "")},\n  "flows": {\n${lines.join(",\n")}\n  }\n}\n`);
  console.log(`wrote ${CEILINGS_FILE}`);
}
const ceilings = JSON.parse(readFileSync(CEILINGS_FILE, "utf8")).flows;
for (const [name, one] of Object.entries(report.flows)) {
  const ceiling = ceilings[name];
  if (ceiling === undefined) { failures.push(`${name}: no ceiling in test/click-path-ceilings.json`); continue; }
  for (const key of METRICS) if (one[key] > ceiling[key]) failures.push(`${name}: ${key} ${one[key]} is over its ceiling ${ceiling[key]}`);
}
report.failures = failures;
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${"flow".padEnd(24)}${METRICS.map(key => key.padStart(15)).join("")}`);
for (const [name, one] of Object.entries(report.flows)) console.log(`${name.padEnd(24)}${METRICS.map(key => `${one[key]} / ${ceilings[name]?.[key] ?? "-"}`.padStart(15)).join("")}`);
console.log(`\nreport: ${outFile}`);
if (failures.length > 0) { console.log(`\n${failures.length} failed:\n${failures.map(one => `  ${one}`).join("\n")}`); process.exitCode = 1; }
