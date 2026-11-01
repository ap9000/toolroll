#!/usr/bin/env node
/** The Settings journey (Settings revamp S1, docs/plans/settings-revamp.md §5 S1 and §6).
 *
 * Boots a SYNTHETIC fixture (scripts/settings-journey/fixture.mjs: temp HOME, temp database, in-process console on
 * 127.0.0.1 at a random port; it refuses any path that reaches the real setup), opens each step file's pages at 1440
 * and 390, and for every page:
 *   1. the first screen with the real scroller intact (`-top.png`), then the read-only probes
 *      (scripts/settings-journey/probes.mjs: one h1, no sideways scroll, 44px phone targets, aria-invalid messages,
 *      secret-input opt-outs, visible focus, sticky bars never covering focus, sidebar rows);
 *   2. the end of the sheet, scrolled in the real scroller (`-end.png`, when it scrolls);
 *   3. the full length with inner scrollers unrolled (`-full.png`);
 *   4. last, on a fresh load, ArrowDown in every choice group: nothing may be sent.
 * Pages with `noJs: true` run once more with JavaScript off. Step-file actions then drive their own states (a forced
 * validation error, a dialog) and call the action probes.
 *
 * Step files: scripts/settings-journey/<slice>.mjs, each exporting
 *   about    one line
 *   fixture  "lived-in" (default) or "fresh"
 *   pages    [{ name, path, as?: "owner"|"viewer"|"anon", noJs?, skip?: [probe names], ready?: selector }]
 *   actions  [{ name, as?, path?, noJs?, run: async ctx => findings[] }]   (ctx: page, fixture, width, goto, shot, probes)
 * Later slices add their own step file; nothing edits this runner except S1.
 *
 * Report-only stage: findings listed in scripts/settings-journey/allowlist.json (key "<step>/<page>@<width>:<probe>")
 * are known and reported, not failed; the slices that fix them delete their lines. A finding outside the list fails
 * the run unless --report-only. Allowlist lines that now pass are reported as ready to delete.
 *
 *   npm run build && node scripts/settings-journey.mjs [--steps baseline,spend] [--only <page regex>] [--widths 1440,390]
 *     [--out <dir under evidence/>] [--report-only] [--write-allowlist] [--playwright <playwright/index.mjs>]
 *
 * Output goes to evidence/settings-journey/<time>/ (ignored by Git): screenshots, report.json, report.md. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FIXTURE_KINDS, OWNER, ROOT, VIEWER, isolateEnvironment, startFixture } from "./settings-journey/fixture.mjs";
import * as probes from "./settings-journey/probes.mjs";

export const STEPS_DIR = join(ROOT, "scripts", "settings-journey");
export const ALLOWLIST_FILE = join(STEPS_DIR, "allowlist.json");
export const WIDTHS = { 1440: { width: 1440, height: 900 }, 390: { width: 390, height: 844 } };
const NOT_STEPS = new Set(["fixture", "probes"]);
const ACCOUNTS = ["owner", "viewer", "anon"];
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The key an allowlist line names: one probe on one page of one step at one width. */
export const findingKey = ({ step, page, width, probe }) => `${step}/${page}@${width}:${probe}`;

/** A step module's problems, as sentences; empty when it can run. Paths are console paths, never a host. */
export function stepProblems(step, name) {
  const out = [];
  if (!SLUG.test(name)) out.push(`step name ${name} isn't a lowercase slug`);
  if (typeof step.about !== "string" || step.about.trim() === "") out.push(`${name}: about is missing`);
  if (step.fixture !== undefined && !FIXTURE_KINDS.includes(step.fixture)) out.push(`${name}: fixture must be one of ${FIXTURE_KINDS.join(", ")}`);
  const pages = step.pages ?? [], actions = step.actions ?? [];
  if (!Array.isArray(pages) || !Array.isArray(actions)) return [...out, `${name}: pages and actions are lists`];
  if (pages.length + actions.length === 0) out.push(`${name}: no pages or actions`);
  const names = new Set();
  for (const one of [...pages, ...actions]) {
    if (!SLUG.test(one?.name ?? "")) { out.push(`${name}: ${JSON.stringify(one?.name)} isn't a lowercase slug`); continue; }
    if (names.has(one.name)) out.push(`${name}: ${one.name} appears twice`);
    names.add(one.name);
    if (one.as !== undefined && !ACCOUNTS.includes(one.as)) out.push(`${name}/${one.name}: as must be one of ${ACCOUNTS.join(", ")}`);
    if (one.path !== undefined && (typeof one.path !== "string" || !one.path.startsWith("/") || one.path.startsWith("//") || /[\s\\]/.test(one.path))) out.push(`${name}/${one.name}: path must be a console path like /settings`);
    if (one.skip !== undefined && (!Array.isArray(one.skip) || one.skip.some(probe => !probes.PROBE_NAMES.includes(probe)))) out.push(`${name}/${one.name}: skip names an unknown probe`);
  }
  for (const one of pages) if (typeof one?.path !== "string") out.push(`${name}/${one?.name}: a page needs a path`);
  for (const one of actions) if (typeof one?.run !== "function") out.push(`${name}/${one?.name}: an action needs run()`);
  return out;
}

/** Every step file's name, or the named ones; throws on an unknown name. */
export function stepNames(wanted = null) {
  const all = readdirSync(STEPS_DIR).filter(file => file.endsWith(".mjs")).map(file => basename(file, ".mjs")).filter(name => !NOT_STEPS.has(name)).sort();
  if (wanted === null) return all;
  for (const name of wanted) if (!all.includes(name)) throw new Error(`no step file scripts/settings-journey/${name}.mjs`);
  return wanted;
}

export async function loadStep(name) {
  const step = await import(pathToFileURL(join(STEPS_DIR, `${name}.mjs`)).href);
  const problems = stepProblems(step, name);
  if (problems.length > 0) throw new Error(`step file ${name}: ${problems.join("; ")}`);
  return step;
}

export function readAllowlist(file = ALLOWLIST_FILE) {
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== "string")) throw new Error("allowlist.json must map keys to reasons");
  return parsed;
}

/** Splits findings into new (fail) and known (allowlisted), and lists allowlist lines inside the run's scope that
 * no longer fire. `ran` is the set of "<step>/<page>@<width>" the run covered with each probe it ran. */
export function classify(findings, allowlist, ran) {
  const fresh = [], known = [];
  const fired = new Set(findings.map(findingKey));
  for (const one of findings) (Object.hasOwn(allowlist, findingKey(one)) ? known : fresh).push(one);
  const burned = Object.keys(allowlist).filter(key => ran.has(key) && !fired.has(key));
  return { fresh, known, burned };
}

/** Rows that some pages have and others lack, against the rows most pages show. */
export function sidebarDrift(byPage) {
  const signatures = Object.entries(byPage).filter(([, rows]) => Array.isArray(rows));
  if (signatures.length < 2) return [];
  const counts = new Map();
  for (const [, rows] of signatures) { const key = JSON.stringify(rows); counts.set(key, (counts.get(key) ?? 0) + 1); }
  const common = JSON.parse([...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  const out = [];
  for (const [page, rows] of signatures) {
    const missing = common.filter(row => !rows.includes(row)), extra = rows.filter(row => !common.includes(row));
    if (missing.length + extra.length > 0) out.push({ page, detail: `sidebar differs from the other pages${missing.length ? `; missing: ${missing.slice(0, 4).join(" | ")}` : ""}${extra.length ? `; extra: ${extra.slice(0, 4).join(" | ")}` : ""}` });
  }
  return out;
}

async function openProject(page, base) {
  await page.goto(base + "/projects");
  const button = page.locator('form[action="/projects/open"] button').first();
  if (await button.count() > 0 && await button.isVisible()) { await button.click(); await page.waitForLoadState("networkidle").catch(() => {}); }
}

/** Runs the journey and answers the report. `browser` is a launched Playwright browser; `root`/`liveDb` come from
 * isolateEnvironment, which must already have run. */
export async function runJourney({ browser, root, liveDb, steps, widths = ["1440", "390"], only = null, out, allowlist = {} }) {
  const findings = [], shots = [], pagesSeen = [], errors = [];
  const ran = new Set();
  for (const name of steps) {
    const step = await loadStep(name);
    for (const label of widths) {
      const viewport = WIDTHS[label];
      if (viewport === undefined) throw new Error(`unknown width ${label}`);
      const fixture = await startFixture({ kind: step.fixture ?? "lived-in", root, liveDb });
      const contexts = new Map();
      const contextFor = async (as, noJs = false) => {
        const key = `${as}:${noJs}`;
        if (!contexts.has(key)) {
          const context = await browser.newContext({ viewport, deviceScaleFactor: 2, javaScriptEnabled: !noJs, reducedMotion: "reduce" });
          if (as !== "anon") {
            const who = as === "viewer" ? VIEWER : OWNER;
            if (fixture.kind === "fresh" && as === "viewer") throw new Error(`${name}: the fresh fixture has no viewer`);
            if (fixture.kind === "lived-in" || fixture.store.accountOf?.(who.name)) {
              await context.addCookies([await fixture.cookieFor(who)]);
              if (fixture.kind === "lived-in") { const setup = await context.newPage(); await openProject(setup, fixture.base); await setup.close(); }
            }
          }
          contexts.set(key, context);
        }
        return contexts.get(key);
      };
      const folder = join(out, name);
      mkdirSync(folder, { recursive: true });
      const shoot = async (page, file, full = false) => {
        const path = join(folder, `${file}.png`);
        await page.screenshot({ path, fullPage: full, animations: "disabled" });
        shots.push(relative(out, path));
      };
      const sidebars = {};
      try {
        for (const entry of step.pages ?? []) {
          if (only !== null && !only.test(entry.name)) continue;
          for (const noJs of entry.noJs ? [false, true] : [false]) {
            const pageName = noJs ? `${entry.name}-nojs` : entry.name;
            const record = list => findings.push(...list.map(one => ({ step: name, page: pageName, width: label, ...one })));
            const page = await (await contextFor(entry.as ?? "owner", noJs)).newPage();
            try {
              const answer = await page.goto(fixture.base + entry.path, { waitUntil: "load" });
              await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
              if (entry.ready) await page.locator(entry.ready).first().waitFor({ timeout: 10_000 });
              const status = answer?.status() ?? null;
              pagesSeen.push({ step: name, page: pageName, width: label, path: entry.path, landed: page.url().slice(fixture.base.length), status });
              if (status !== null && status >= 500) record([{ probe: "load", detail: `${entry.path} answered ${status}` }]);
              await shoot(page, `${pageName}-${label}-top`);
              const probed = await probes.probePage(page, { width: viewport.width, skip: entry.skip ?? [] });
              for (const probe of probes.PAGE_PROBES) if (!(entry.skip ?? []).includes(probe.name) && !(probe.phoneOnly && viewport.width > probes.PHONE_MAX) && !(probe.desktopOnly && viewport.width <= probes.PHONE_MAX)) ran.add(findingKey({ step: name, page: pageName, width: label, probe: probe.name }));
              record(probed.findings);
              if (probed.sidebar !== null && !noJs) sidebars[`${pageName}:${entry.as ?? "owner"}`] = probed.sidebar;
              if (await probes.scrollToEnd(page) !== null) await shoot(page, `${pageName}-${label}-end`);
              await probes.unroll(page);
              await shoot(page, `${pageName}-${label}-full`, true);
              if (probed.arrowKeys && !noJs) {
                await page.goto(fixture.base + entry.path, { waitUntil: "load" });
                await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
                record(await probes.arrowKeys(page));
              }
            } catch (error) {
              errors.push(`${name}/${pageName}@${label}: ${error.message.split("\n")[0]}`);
              record([{ probe: "load", detail: error.message.split("\n")[0] }]);
            } finally { await page.close(); }
          }
        }
        // Compared among the pages one account sees: a viewer's sidebar may rightly differ from the owner's.
        for (const as of ACCOUNTS) {
          const mine = Object.fromEntries(Object.entries(sidebars).filter(([key]) => key.endsWith(`:${as}`)));
          for (const drift of sidebarDrift(mine)) findings.push({ step: name, page: drift.page.slice(0, -(as.length + 1)), width: label, probe: "sidebar", detail: drift.detail });
        }
        for (const action of step.actions ?? []) {
          if (only !== null && !only.test(action.name)) continue;
          const page = await (await contextFor(action.as ?? "owner", action.noJs === true)).newPage();
          const ctx = {
            page, fixture, width: viewport.width, label, probes,
            goto: async path => { const answer = await page.goto(fixture.base + path, { waitUntil: "load" }); await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {}); return answer; },
            shot: (file, { full = false } = {}) => shoot(page, `${action.name}-${file}-${label}`, full),
          };
          try {
            if (action.path) await ctx.goto(action.path);
            const answered = await action.run(ctx);
            const list = Array.isArray(answered) ? answered : [];
            for (const one of list) ran.add(findingKey({ step: name, page: action.name, width: label, probe: one.probe }));
            findings.push(...list.map(one => ({ step: name, page: action.name, width: label, probe: one.probe, detail: one.detail })));
          } catch (error) {
            errors.push(`${name}/${action.name}@${label}: ${error.message.split("\n")[0]}`);
            findings.push({ step: name, page: action.name, width: label, probe: "load", detail: error.message.split("\n")[0] });
          } finally { await page.close(); }
        }
      } finally {
        for (const context of contexts.values()) await context.close();
        await fixture.close();
      }
    }
  }
  const verdict = classify(findings, allowlist, ran);
  return { findings, shots, pages: pagesSeen, errors, ...verdict };
}

function markdown(report, out) {
  const rows = list => list.map(one => `| ${one.step}/${one.page} | ${one.width} | ${one.probe} | ${one.detail.replace(/\|/g, "\\|")} |`);
  return [
    `# Settings journey (synthetic fixture)`,
    "",
    `Steps: ${report.steps.join(", ")} · widths: ${report.widths.join(", ")} · pages: ${report.pages.length} · shots: ${report.shots.length} · folder: ${out}`,
    "",
    `**${report.fresh.length} new finding(s)** (not on the allowlist), ${report.known.length} known, ${report.burned.length} allowlist line(s) now passing.`,
    "",
    ...(report.fresh.length ? ["## New", "", "| Page | Width | Probe | Detail |", "|---|---|---|---|", ...rows(report.fresh), ""] : []),
    ...(report.burned.length ? ["## Allowlist lines to delete (they pass now)", "", ...report.burned.map(key => `- \`${key}\``), ""] : []),
    ...(report.known.length ? ["## Known (allowlisted)", "", "| Page | Width | Probe | Detail |", "|---|---|---|---|", ...rows(report.known), ""] : []),
  ].join("\n");
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const option = name => { const at = args.indexOf(name); return at === -1 ? null : args[at + 1]; };
  if (!existsSync(join(ROOT, "dist", "serve.js"))) { console.error("Build first: npm run build"); process.exit(2); }
  // Playwright and its browser load from the real home (npm cache, browser cache) before the fixture swaps HOME.
  const { loadPlaywright } = await import("./e2e-kit.mjs");
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const { root, liveDb, restore } = isolateEnvironment();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = resolve(option("--out") ?? join(ROOT, "evidence", "settings-journey", stamp));
  if (relative(join(ROOT, "evidence"), out).startsWith("..")) { console.error("--out must be under evidence/ (ignored by Git)"); process.exit(2); }
  mkdirSync(out, { recursive: true });
  const steps = stepNames(option("--steps")?.split(",").filter(Boolean) ?? null);
  const widths = option("--widths")?.split(",").filter(Boolean) ?? ["1440", "390"];
  const allowlist = readAllowlist();
  let exit = 0;
  try {
    const report = { steps, widths, ...await runJourney({ browser, root, liveDb, steps, widths, only: option("--only") === null ? null : new RegExp(option("--only")), out, allowlist }) };
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1));
    writeFileSync(join(out, "report.md"), markdown(report, out));
    if (args.includes("--write-allowlist")) {
      const next = { ...Object.fromEntries(Object.entries(allowlist).filter(([key]) => !report.burned.includes(key))) };
      for (const one of report.fresh) next[findingKey(one)] ??= `known at S1 (${one.detail.slice(0, 100)})`;
      writeFileSync(ALLOWLIST_FILE, JSON.stringify(Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b))), null, 1) + "\n");
      console.log(`allowlist: ${Object.keys(next).length} line(s) written to ${relative(ROOT, ALLOWLIST_FILE)}`);
    }
    console.log(markdown(report, out).split("\n## Known")[0]);
    console.log(`report: ${join(out, "report.md")}`);
    if (report.errors.length > 0) { console.error(`errors:\n${report.errors.join("\n")}`); exit = 1; }
    if (report.fresh.length > 0 && !args.includes("--report-only") && !args.includes("--write-allowlist")) exit = 1;
  } finally {
    await browser.close();
    restore();
  }
  process.exit(exit);
}
