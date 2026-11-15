/**
 * Settings → Computers' sections (the eight settings plan, F2), in-process: read admission before any loader (the
 * builders list keeps /fleet's instance-only admission, Connect a builder keeps /start-builder's open one), what each
 * person may change (register, retire, move, note: an approver's browser session with instance access, never the
 * demo), the two change documents, their drafts after a refusal, and the old ids links still name.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { BrowserComputer, BrowserComputers } from "../browser-workspace.js";
import { htmlString, joinHtml, type Html } from "../html.js";
import { HUB_ANCHORS } from "../settings-groups-ui.js";
import { requestContext } from "./request-context.js";
import { RETIRED_ROUTES, SETTINGS_RETIRED } from "./retired-routes.js";
import { ROUTES } from "./route-table.js";
import { computersSections, type ComputersDeps, type ComputersSubject } from "./settings-computers.js";
import { SETTINGS_SECTIONS } from "./settings-section-table.js";
import { changeDocument, renderArea, type SectionImpl, type SectionImpls, type SectionPerson } from "./settings-sections.js";

const render = <T>(run: () => T): T => requestContext.run({ csrf: "c-1", returnTo: "/settings/computers" }, run);
const text = (parts: readonly Html[]): string => htmlString(joinHtml([...parts]));
const NOW = new Date("2026-11-14T10:00:00Z");

const OPERATOR: SectionPerson = { name: "alex", via: "cookie", role: "approver", authority: "full", operator: true, restricted: false, installation: true, passwordSet: true,
  principal: { caller: "cookie", capability: "act", viewer: false, token: false }, unscopedConsole: false, demo: false };
const PERSONAS: Record<string, SectionPerson> = {
  operator: OPERATOR,
  "installation approver": { ...OPERATOR, name: "ines", operator: false },
  "project-limited approver": { ...OPERATOR, name: "lim", operator: false, restricted: true, installation: false },
  viewer: { ...OPERATOR, name: "vera", role: "viewer", operator: false, principal: { caller: "cookie", capability: "read", viewer: true, token: false } },
  "API token": { ...OPERATOR, via: "bearer", principal: { caller: "bearer", capability: "act", viewer: false, token: true } },
  "read-only token": { ...OPERATOR, via: "bearer", principal: { caller: "bearer", capability: "read", viewer: false, token: true } },
  "local owner": { ...OPERATOR, authority: "local-owner", passwordSet: false },
  "demo approver": { ...OPERATOR, demo: true },
};
const ALL = Object.keys(PERSONAS);
/** Who reads each section: Connect a builder as /start-builder admitted (everyone), the computers as /fleet did (instance access). */
const READS: Record<string, readonly string[]> = { start: ALL, builders: ALL.filter(one => one !== "project-limited approver") };
/** Who may register, retire, move and note: an approver's full browser session with instance access, never the demo's
 * (the local owner's posts there are refused, so it gets no controls). */
const MANAGE = ["operator", "installation approver"];

const computer = (over: Partial<BrowserComputer> = {}): BrowserComputer => ({
  name: "studio", host: "studio.local", capacity: 2, retired: false, state: "building", building: [{ taskId: "t1", title: "Fix the footer", href: "/t/t1", project: "shop" }],
  hidden: 0, heardAt: "2026-11-14T09:59:00Z", registeredAt: "2026-11-01T09:00:00Z", projects: ["shop"], note: null,
  reserved: [{ id: "t2", title: "Add a refund button", href: "/t/t2", project: "shop", taken: false }], ...over,
});
const LIST = (manage: boolean): BrowserComputers => ({ list: [computer(), computer({ name: "attic", host: "attic.local", state: "offline", building: [], reserved: [] })], manage, queueRevision: 7, shared: 1 });
function deps(over: Partial<ComputersDeps> = {}): ComputersDeps {
  return { computers: (_now, manage) => LIST(manage), connected: () => false, projectName: repo => repo.split("/").pop()!, registerNonce: () => "n".repeat(32),
    ago: () => "1 minute ago", ...over };
}
const SUBJECT: ComputersSubject = { task: null, computer: null, drafts: {} };
const base = (person: SectionPerson, project: string | null = "/w/shop") => ({ person, project, now: NOW, prefs: { theme: "system" as const, accent: "#000000", advanced: false } });

/** Every loader a spy around the real one. */
function spied(impls: SectionImpls) {
  const calls: Record<string, { summary: ReturnType<typeof vi.fn>; detail: ReturnType<typeof vi.fn> | null }> = {};
  const out: Record<string, SectionImpl<unknown, unknown>> = {};
  for (const [id, impl] of Object.entries(impls) as [string, SectionImpl<unknown, unknown>][]) {
    const summary = vi.fn(impl.loadSummary), detail = impl.loadDetail === undefined ? null : vi.fn(impl.loadDetail);
    calls[id] = { summary, detail };
    out[id] = { ...impl, loadSummary: summary, ...(detail === null ? {} : { loadDetail: detail }) };
  }
  return { impls: out as unknown as SectionImpls, calls };
}

describe("read admission runs before any loader: a denied section is never read", () => {
  test.each(Object.entries(PERSONAS))("%s", (name, person) => {
    for (const asked of [{ section: null, open: false }, { section: "builders", open: true }]) {
      const computers = vi.fn(deps().computers);
      const { impls, calls } = spied(computersSections(deps({ computers }), { ...SUBJECT, computer: "studio" }));
      render(() => renderArea("computers", impls, base(person), asked));
      for (const section of SETTINGS_SECTIONS.filter(one => one.area === "computers")) {
        const admitted = READS[section.id]!.includes(name);
        expect(calls[section.id]!.summary, `${name} × ${section.id}`).toHaveBeenCalledTimes(admitted ? 1 : 0);
        expect(calls[section.id]!.detail?.mock.calls.length ?? 0, `${name} × ${section.id} detail`).toBe(admitted && asked.open && asked.section === section.id ? 1 : 0);
      }
      // The computers list itself is read only for a person the builders section admits.
      expect(computers.mock.calls.length > 0, name).toBe(READS["builders"]!.includes(name));
    }
  });
});

describe("what each person sees and may change", () => {
  const page = (person: SectionPerson, subject: ComputersSubject = SUBJECT, asked = { section: null as string | null, open: false }) =>
    render(() => text(renderArea("computers", computersSections(deps(), subject), base(person), asked).sections));
  test.each(Object.entries(PERSONAS))("%s", (name, person) => {
    const shown = page(person, { ...SUBJECT, computer: "studio" }, { section: "builders", open: true });
    const manage = MANAGE.includes(name);
    expect(shown).toContain("toolroll up");
    expect(shown.includes('href="/settings/change/register-computer"'), `${name} register`).toBe(manage);
    expect(shown.includes('href="/settings/change/retire-computer?computer=studio"'), `${name} retire`).toBe(manage);
    expect(shown.includes('action="/queue/move"'), `${name} move`).toBe(manage);
    expect(shown.includes('action="/queue/note"'), `${name} note`).toBe(manage);
    // Every person the builders section admits reads the computers and one's details, as Agents showed them.
    expect(shown.includes('data-computer="studio"'), `${name} list`).toBe(READS["builders"]!.includes(name));
    expect(shown.includes("Add a refund button"), `${name} reserved`).toBe(READS["builders"]!.includes(name));
  });
  test("a project-limited person is told who starts a builder; the rest how to keep one running", () => {
    expect(page(PERSONAS["project-limited approver"]!)).toContain("Starting a builder takes someone who manages this Toolroll");
    expect(page(OPERATOR)).toContain("Keep it running");
  });
  test("a task's own project, not the open one, and whether a builder serves it", () => {
    const connected = vi.fn(() => true);
    const shown = render(() => text(renderArea("computers", computersSections(deps({ connected }), { ...SUBJECT, task: { id: "t9", repo: "/w/api", runner: "studio" } }),
      base(OPERATOR, "/w/shop"), { section: "start", open: false }).sections));
    expect(shown).toContain("A builder is connected to <strong>api</strong>");
    expect(connected).toHaveBeenCalledWith("/w/api", NOW, "studio");
    expect(render(() => text(renderArea("computers", computersSections(deps(), SUBJECT), base(OPERATOR, "/w/shop"), { section: null, open: false }).sections)))
      .toContain("<strong>No builder is connected</strong> to <strong>shop</strong>");
  });
  test("only the asked computer's details are drawn; an unknown one says so", () => {
    const one = page(OPERATOR, { ...SUBJECT, computer: "studio" }, { section: "builders", open: true });
    expect(one.match(/Reserved for it/g)?.length).toBe(1);
    expect(page(OPERATOR, { ...SUBJECT, computer: "nobody" }, { section: "builders", open: true })).toContain("There&#39;s no computer named nobody.");
    // Not opened: rows and a Details link each, no details.
    const closed = page(OPERATOR);
    expect(closed).not.toContain("Reserved for it");
    expect(closed).toContain('href="/settings/computers?section=builders&amp;open=1&amp;computer=studio#builders"');
  });
});

describe("the change documents", () => {
  const doc = (id: string, person: SectionPerson, subject: ComputersSubject = SUBJECT, problem: string | null = null) =>
    render(() => changeDocument(id, computersSections(deps(), subject), base(person), problem));
  test("register: the form, its one-use token and the password typed now, only for a person who may register", () => {
    const answer = doc("register-computer", OPERATOR);
    const body = answer.ok ? htmlString(answer.body) : "";
    expect(body).toContain('action="/fleet/runner/register"');
    expect(body).toContain(`name="nonce" value="${"n".repeat(32)}"`);
    expect(body).toMatch(/<input type="password" name="token" autocomplete="current-password" required>/);
    for (const name of ALL.filter(one => !MANAGE.includes(one))) {
      const { impls, calls } = spied(computersSections(deps(), SUBJECT));
      expect(render(() => changeDocument("register-computer", impls, base(PERSONAS[name]!), null)), name).toMatchObject({ ok: false, status: 403 });
      expect(calls["start"]!.summary, name).not.toHaveBeenCalled();
    }
  });
  test("register after a refusal: the safe drafts come back (name, how many, which field), never a password", () => {
    const answer = doc("register-computer", OPERATOR, { ...SUBJECT, drafts: { name: "studio-2", capacity: "4", field: "name" } }, "A computer's name is one short line, no control characters.");
    const body = answer.ok ? htmlString(answer.body) : "";
    expect(body).toContain('value="studio-2"');
    expect(body).toMatch(/<option value="4" selected>/);
    expect(body).toContain('aria-invalid="true"');
    expect(body).not.toMatch(/type="password"[^>]*value=/);
    // A capacity the form doesn't offer is not echoed.
    const odd = doc("register-computer", OPERATOR, { ...SUBJECT, drafts: { capacity: "<b>" } });
    expect(odd.ok && htmlString(odd.body)).not.toContain("&lt;b&gt;");
  });
  test("retire: the named computer and what happens, its password, and nothing for anyone else", () => {
    const answer = doc("retire-computer", OPERATOR, { ...SUBJECT, computer: "studio" });
    const body = answer.ok ? htmlString(answer.body) : "";
    expect(body).toContain('action="/fleet/runner/retire"');
    expect(body).toContain('name="name" value="studio"');
    expect(body).toContain("Retire studio");
    const missing = doc("retire-computer", OPERATOR, { ...SUBJECT, computer: "nobody" });
    expect(missing.ok && htmlString(missing.body)).toContain("There&#39;s no computer by that name to retire.");
    expect(missing.ok && htmlString(missing.body)).not.toContain('action="/fleet/runner/retire"');
    for (const name of ALL.filter(one => !MANAGE.includes(one))) expect(doc("retire-computer", PERSONAS[name]!, { ...SUBJECT, computer: "studio" }), name).toMatchObject({ ok: false, status: 403 });
  });
});

describe("old addresses and ids", () => {
  test("/start-builder lands on Connect a builder keeping its task; /fleet's computers are the builders section", () => {
    const row = ROUTES.find(one => one.id === "start-builder")!;
    expect(row.retired).toBe(true);
    expect(SETTINGS_RETIRED["start-builder"]).toMatchObject({ to: "/settings/computers", section: "start" });
    expect(RETIRED_ROUTES["start-builder"]!(new URL("http://x/start-builder?task=t-1&csrf=x"))).toBe("/settings/computers?task=t-1&section=start");
    expect(RETIRED_ROUTES["start-builder"]!(new URL("http://x/start-builder"))).toBe("/settings/computers?section=start");
  });
  test("every #id a link in src names on Computers (or on a page retired into it) is on the page exactly once", () => {
    const page = render(() => text(renderArea("computers", computersSections(deps(), { ...SUBJECT, computer: "studio" }), base(OPERATOR), { section: "builders", open: true }).sections));
    const ids = new Set<string>(SETTINGS_SECTIONS.filter(one => one.area === "computers").flatMap(one => [one.id, ...one.oldIds]));
    const retired = Object.entries(SETTINGS_RETIRED).filter(([, one]) => one.to === "/settings/computers").map(([id]) => ROUTES.find(row => row.id === id)!.sample);
    const pages = ["/settings/computers", ...retired].map(path => path.replace(/[/]/g, "\\/"));
    const link = new RegExp(`(?:${pages.join("|")})(?:\\?[^"'\`#\\s]*)?#([a-z][a-z0-9-]*)`, "g");
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx|mjs)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
    });
    for (const file of [...walk("src"), ...walk("scripts")]) for (const match of readFileSync(file, "utf8").matchAll(link)) ids.add(match[1]!);
    for (const target of Object.values(HUB_ANCHORS)) if (target.startsWith("/settings/computers#")) ids.add(target.split("#")[1]!);
    expect(ids).toContain("workers");
    for (const id of ids) expect(page.split(`id="${id}"`).length - 1, id).toBe(1);
  });
});
