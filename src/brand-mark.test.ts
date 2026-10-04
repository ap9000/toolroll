/**
 * Integration logos: every icon is one 24x24 currentColor path, centred at one
 * optical size; every one-click service, catalog tool, chat app and
 * integration shows its logo or a letter tile in the same frame, a custom tool
 * always a letter.
 */
import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import paper from "paper";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BRAND_ICONS, type BrandIcon } from "./brand-icons.js";
import { BRAND_MARK_CSS, brandIconFor, brandIconHtml, brandMarkHtml, TILE_PHONE } from "./brand-mark.js";
import { BrandIcon as BrandIconView } from "./browser/brand-mark.js";
import { ONE_CLICK } from "./mcp-connect.js";
import { TOOL_CATALOG } from "./project-tools.js";
import { integrationsNow } from "./integrations.js";
import { INTEGRATIONS_CSS, integrationsHtml } from "./integrations-ui.js";
import { TOOLS_CSS, toolsHtml } from "./tools-ui.js";
import { settingsGroups, settingsTiles } from "./serve.js";
import { openStore } from "./store.js";

const SIMPLE_ICONS = ["betterstack", "chrome", "claude", "cloudflare", "confluence", "discord", "figma", "github", "gmail", "intercom", "jira", "linear",
  "notion", "paypal", "posthog", "sentry", "shadcn", "square", "stripe", "supabase", "telegram", "vercel", "webflow", "wix", "zapier"];
const SVGL = ["canva", "openai", "playwright", "slack", "teams"];
/** Services and tools no source has a logo for. */
const LETTERS = ["attio", "klaviyo", "mobbin", "context7"];

/** What one mark shows: an icon id, or the letter in its tile. */
function shown(html: string): { icon: string | null; letter: string | null; connected: boolean } {
  const path = html.match(/<path fill="currentColor"(?: fill-rule="evenodd")? d="([^"]+)"\/>/)?.[1] ?? null;
  const icon = path === null ? null : Object.entries(BRAND_ICONS).find(([, one]) => one.path === path)?.[0] ?? "unknown";
  const letter = html.match(/data-letter aria-hidden="true">([^<]+)<\/span>/)?.[1] ?? null;
  return { icon, letter, connected: html.includes('data-connected="true"') };
}
const marks = (html: string) => [...html.matchAll(/<span class="brand-mark"[\s\S]*?<\/span>/g)].map(([one]) => one);

test("every icon is one 24x24 currentColor path, centred at one optical size, from Simple Icons or svgl", () => {
  expect(Object.keys(BRAND_ICONS).sort()).toEqual([...SIMPLE_ICONS, ...SVGL].sort());
  paper.setup(new paper.Size(24, 24));
  for (const [id, icon] of Object.entries(BRAND_ICONS) as [string, BrandIcon][]) {
    expect(icon.source, id).toBe(SVGL.includes(id) ? "svgl" : "Simple Icons");
    expect(icon.title.length, id).toBeGreaterThan(0);
    expect(icon.path, id).toMatch(/^M[-+.,\deMmLlHhVvCcSsQqTtAaZz ]+$/);
    const box = new paper.CompoundPath(icon.path).bounds;
    // The area of a 20x20 square, unless that would pass the box (a wide wordmark fills its width).
    const long = Math.max(box.width, box.height);
    if (long < 23.99) expect(Math.sqrt(box.width * box.height), id).toBeCloseTo(20, 1);
    else expect(long, id).toBeCloseTo(24, 1);
    expect(box.center.x, id).toBeCloseTo(12, 1);
    expect(box.center.y, id).toBeCloseTo(12, 1);
    const html = brandMarkHtml(id, icon.title, true);
    expect(html.match(/<svg[^>]*>/g), id).toEqual(['<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">']);
    expect(html.match(/<path /g)?.length, id).toBe(1);
    expect(html, id).not.toMatch(/#[0-9a-f]{3,6}|rgb\(|url\(|<image|href=/i);
    expect(renderToStaticMarkup(createElement(BrandIconView, { id: id as never })).replace("></path>", "/>"), id).toBe(brandIconHtml(id as never));
  }
  // Only OpenAI keeps its source's even-odd rule; its holes rely on it.
  expect(Object.entries(BRAND_ICONS).filter(([, one]) => (one as BrandIcon).evenodd).map(([id]) => id)).toEqual(["openai"]);
});

test("a wide wordmark reads at its neighbours' size, and Zapier is its asterisk", () => {
  paper.setup(new paper.Size(24, 24));
  const box = (id: keyof typeof BRAND_ICONS) => new paper.CompoundPath(BRAND_ICONS[id].path).bounds;
  expect(box("wix").width).toBeCloseTo(24, 1);
  expect(box("wix").height).toBeGreaterThan(8.5);
  // The asterisk is about square; the boxed wordmark it replaces is not.
  expect(box("zapier").width / box("zapier").height).toBeCloseTo(1, 1);
  expect(readFileSync(new URL("../assets/brand-icons/zapier.svg", import.meta.url), "utf8")).toContain("<title>Zapier</title>");
});

test("the mark ships its own sizes, switching to the phone size with the tool tiles' layout", () => {
  expect(TILE_PHONE).toBe("@media(max-width:600px)");
  expect(BRAND_MARK_CSS).toContain(":root{--brand-mark:32px}@media(max-width:600px){:root{--brand-mark:28px}}");
  expect(BRAND_MARK_CSS).toContain("width:var(--brand-mark);height:var(--brand-mark)");
  expect(TOOLS_CSS).toContain(`${TILE_PHONE}{.tools .connect-grid{grid-template-columns:1fr 1fr}`);
  // No page sizes the mark itself; Integrations lines its text up by the mark's own size.
  for (const css of [TOOLS_CSS, INTEGRATIONS_CSS]) expect(css).not.toMatch(/\.brand-mark(?: svg)?\{[^}]*(?:width|height|font-size)/);
  expect(INTEGRATIONS_CSS).toContain("calc(var(--brand-mark) + 10px)");
});

test("nothing loads at runtime: the icons are inline data, and the svgl sources are vendored", () => {
  const source = readFileSync(new URL("./brand-icons.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/\bimport\b|fetch\(|https?:\/\//);
  for (const file of ["slack", "microsoft-teams", "canva", "openai", "playwright", "zapier"]) {
    expect(readFileSync(new URL(`../assets/brand-icons/${file}.svg`, import.meta.url), "utf8")).toContain("<svg");
  }
  const notices = readFileSync(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  expect(notices).toContain("Simple Icons (CC0 1.0) and svgl (MIT)");
  expect(notices).toContain("Simple Icons 9.10.0");
  expect(notices).toContain("trademarks");
});

test("every one-click service and catalog tool shows its logo, or a letter tile for the four without one", () => {
  for (const one of [...ONE_CLICK.map(s => ({ id: s.id, label: s.label })), ...TOOL_CATALOG.map(t => ({ id: t.name, label: t.label }))]) {
    const mark = shown(brandMarkHtml(one.id, one.label, false));
    if (LETTERS.includes(one.id)) expect(mark, one.id).toEqual({ icon: null, letter: one.label[0]!.toUpperCase(), connected: false });
    else expect(mark.icon, one.id).toBe(brandIconFor(one.id));
    expect(mark.icon ?? mark.letter, one.id).not.toBeNull();
    expect(mark.icon, one.id).not.toBe("unknown");
  }
  expect(brandIconFor("atlassian")).toBe("jira");
  expect(brandIconFor("chrome-devtools")).toBe("chrome");
  expect(brandIconFor("shadcn")).toBe("shadcn");
});

test("Tools: connect tiles and tool cards use the mark, ink when connected; a custom tool keeps a letter, even named after a brand", () => {
  const html = toolsHtml({
    repo: "/work/shop", project: "shop", kit: null, wanted: null, catalog: [], found: [],
    connections: [{ id: "stripe", label: "Stripe", about: "Payments", state: "connected" }, { id: "attio", label: "Attio", about: "CRM", state: "open" }],
    tools: [
      { tool: { name: "sentry", spec: { ...TOOL_CATALOG.find(t => t.name === "sentry")! }, source: "catalog", createdBy: "alex", lastTest: null }, secretsSet: ["SENTRY_ACCESS_TOKEN"] },
      { tool: { name: "postgres", spec: { name: "postgres", transport: "stdio", command: "npx", args: [], url: null, secrets: [], bearer: null, headerSecrets: {}, about: "Database" }, source: "custom", createdBy: "alex", lastTest: null }, secretsSet: [] },
      { tool: { name: "linear", spec: { name: "linear", transport: "stdio", command: "npx", args: [], url: null, secrets: [], bearer: null, headerSecrets: {}, about: "My own Linear bridge" }, source: "custom", createdBy: "alex", lastTest: null }, secretsSet: [] },
    ] as never,
  }, "csrf", true);
  expect(marks(html).map(shown)).toEqual([
    { icon: "sentry", letter: null, connected: true },
    { icon: null, letter: "P", connected: true },
    { icon: null, letter: "L", connected: true },
    { icon: "stripe", letter: null, connected: true },
    { icon: null, letter: "A", connected: false },
  ]);
});

test("Integrations: every row shows its logo or a letter tile, ink only when connected", () => {
  const dir = mkdtempSync(join(tmpdir(), "so-brand-"));
  const store = openStore(join(dir, "orders.db"));
  try {
    const list = integrationsNow({ store, dir, telegramTokenFile: join(dir, "telegram-token"), env: {}, repos: [], toolHome: dir });
    const html = integrationsHtml(list, "csrf", {});
    const rows = [...html.matchAll(/data-integration="([^"]+)" data-state="([^"]+)">([\s\S]*?)<\/div><\/div>/g)];
    expect(rows.length).toBe(list.length);
    const seen = Object.fromEntries(rows.map(([, key, state, body]) => {
      const [mark] = marks(body!);
      expect(mark, key).toBeDefined();
      const one = shown(mark!);
      expect(one.connected, key).toBe(state === "connected");
      return [key, one.icon ?? `letter ${one.letter}`];
    }));
    expect(seen).toEqual({
      telegram: "telegram", slack: "slack", discord: "discord", teams: "teams", github: "github", linear: "linear",
      email: "letter E", mcp: "letter M", monitoring: "letter M", "agent:claude": "claude", "agent:codex": "openai",
    });
    expect(brandIconFor("mcp:/work/shop:supabase")).toBe("supabase");
    const gmail = integrationsHtml([{ ...list.find(one => one.key === "email")!, account: "alex@gmail.com" }], "", {});
    expect(shown(marks(gmail)[0]!).icon).toBe("gmail");
    // A project's own tool is a letter even when its name matches a logo; a catalog tool shows its logo.
    const tool = { ...list.find(one => one.key === "mcp")!, group: "tools" as const, name: "figma" };
    expect(shown(marks(integrationsHtml([{ ...tool, key: "mcp:/work/shop:figma", custom: true }], "", {}))[0]!)).toMatchObject({ icon: null, letter: "F" });
    expect(shown(marks(integrationsHtml([{ ...tool, key: "mcp:/work/shop:figma" }], "", {}))[0]!).icon).toBe("figma");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Settings home: the four chat apps draw their logo like the other tiles' icons, no tile, their state line kept", () => {
  const groups = settingsGroups({ channel: "telegram", implicit: false, configured: ["telegram"] });
  const tiles = groups.flatMap(group => group.tiles).filter(tile => tile.brand !== undefined);
  expect(tiles.map(tile => [tile.brand, tile.status?.words])).toEqual([["telegram", "Gets alerts"], ["slack", "Not set up"], ["discord", "Not set up"], ["teams", "Not set up"]]);
  const html = settingsTiles(groups);
  expect(html).not.toContain("brand-mark");
  for (const tile of tiles) {
    const link = html.match(new RegExp(`<a href="${tile.href}">([\\s\\S]*?)</a>`))?.[1] ?? "";
    // The svg sits where every other tile's icon sits, so the same rule sizes and colours it.
    expect(link.startsWith(brandIconHtml(tile.brand!)), tile.href).toBe(true);
    expect(link, tile.href).toContain(`provider-status--${tile.status!.tone}`);
  }
  expect(html.match(/<a href="\/settings\/tools"><svg /)).not.toBeNull();
});
