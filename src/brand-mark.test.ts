/**
 * Integration logos: every icon is one 24x24 currentColor path, the mark's
 * larger side 20 and centred; every one-click service, catalog tool, chat app
 * and integration shows its logo or a letter tile in the same frame.
 */
import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import paper from "paper";
import { BRAND_ICONS } from "./brand-icons.js";
import { brandIconFor, brandMarkHtml } from "./brand-mark.js";
import { ONE_CLICK } from "./mcp-connect.js";
import { TOOL_CATALOG } from "./project-tools.js";
import { integrationsNow } from "./integrations.js";
import { integrationsHtml } from "./integrations-ui.js";
import { toolsHtml } from "./tools-ui.js";
import { settingsGroups } from "./serve.js";
import { openStore } from "./store.js";

const SIMPLE_ICONS = ["betterstack", "chrome", "claude", "cloudflare", "confluence", "discord", "figma", "github", "gmail", "intercom", "jira", "linear",
  "notion", "paypal", "posthog", "sentry", "shadcn", "square", "stripe", "supabase", "telegram", "vercel", "webflow", "wix", "zapier"];
const SVGL = ["canva", "openai", "playwright", "slack", "teams"];
/** Services and tools no source has a logo for. */
const LETTERS = ["attio", "klaviyo", "mobbin", "context7"];

/** What one mark shows: an icon id, or the letter in its tile. */
function shown(html: string): { icon: string | null; letter: string | null; connected: boolean } {
  const path = html.match(/<path fill="currentColor" d="([^"]+)"\/>/)?.[1] ?? null;
  const icon = path === null ? null : Object.entries(BRAND_ICONS).find(([, one]) => one.path === path)?.[0] ?? "unknown";
  const letter = html.match(/data-letter aria-hidden="true">([^<]+)<\/span>/)?.[1] ?? null;
  return { icon, letter, connected: html.includes('data-connected="true"') };
}
const marks = (html: string) => [...html.matchAll(/<span class="brand-mark"[\s\S]*?<\/span>/g)].map(([one]) => one);

test("every icon is one 24x24 currentColor path, its larger side 20 and centred, from Simple Icons or svgl", () => {
  expect(Object.keys(BRAND_ICONS).sort()).toEqual([...SIMPLE_ICONS, ...SVGL].sort());
  paper.setup(new paper.Size(24, 24));
  for (const [id, icon] of Object.entries(BRAND_ICONS)) {
    expect(icon.source, id).toBe(SVGL.includes(id) ? "svgl" : "Simple Icons");
    expect(icon.title.length, id).toBeGreaterThan(0);
    expect(icon.path, id).toMatch(/^M[-+.,\deMmLlHhVvCcSsQqTtAaZz ]+$/);
    const box = new paper.CompoundPath(icon.path).bounds;
    expect(Math.max(box.width, box.height), id).toBeCloseTo(20, 1);
    expect(box.center.x, id).toBeCloseTo(12, 1);
    expect(box.center.y, id).toBeCloseTo(12, 1);
    const html = brandMarkHtml(id, icon.title, true);
    expect(html.match(/<svg[^>]*>/g), id).toEqual(['<svg viewBox="0 0 24 24" focusable="false">']);
    expect(html.match(/<path /g)?.length, id).toBe(1);
    expect(html, id).not.toMatch(/#[0-9a-f]{3,6}|rgb\(|url\(|<image|href=/i);
  }
});

test("nothing loads at runtime: the icons are inline data, and the svgl sources are vendored", () => {
  const source = readFileSync(new URL("./brand-icons.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/\bimport\b|fetch\(|https?:\/\//);
  for (const file of ["slack", "microsoft-teams", "canva", "openai", "playwright"]) {
    expect(readFileSync(new URL(`../assets/brand-icons/${file}.svg`, import.meta.url), "utf8")).toContain("<svg");
  }
  const notices = readFileSync(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  expect(notices).toContain("Simple Icons (CC0 1.0) and svgl (MIT)");
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

test("Tools: connect tiles and tool cards use the mark, ink when connected; a custom tool keeps a letter", () => {
  const html = toolsHtml({
    repo: "/work/shop", project: "shop", kit: null, wanted: null, catalog: [], found: [],
    connections: [{ id: "stripe", label: "Stripe", about: "Payments", state: "connected" }, { id: "attio", label: "Attio", about: "CRM", state: "open" }],
    tools: [
      { tool: { name: "sentry", spec: { ...TOOL_CATALOG.find(t => t.name === "sentry")! }, source: "catalog", createdBy: "alex", lastTest: null }, secretsSet: ["SENTRY_ACCESS_TOKEN"] },
      { tool: { name: "postgres", spec: { name: "postgres", transport: "stdio", command: "npx", args: [], url: null, secrets: [], bearer: null, headerSecrets: {}, about: "Database" }, source: "custom", createdBy: "alex", lastTest: null }, secretsSet: [] },
    ] as never,
  }, "csrf", true);
  expect(marks(html).map(shown)).toEqual([
    { icon: "sentry", letter: null, connected: true },
    { icon: null, letter: "P", connected: true },
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
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Settings home: the four chat apps carry their logos, ink once set up", () => {
  const groups = settingsGroups({ channel: "telegram", implicit: false, configured: ["telegram"] });
  const tiles = groups.flatMap(group => group.tiles).filter(tile => tile.brand !== undefined);
  expect(tiles.map(tile => [tile.brand, tile.status?.tone])).toEqual([["telegram", "ok"], ["slack", "off"], ["discord", "off"], ["teams", "off"]]);
  for (const tile of tiles) expect(brandIconFor(tile.brand!)).toBe(tile.brand);
});
