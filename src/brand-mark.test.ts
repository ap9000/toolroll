/**
 * Integration logos: every icon is one 24x24 currentColor path, centred at one
 * optical size; every one-click service, catalog tool, chat app and
 * integration shows its logo or a letter tile in the same frame, a custom tool
 * always a letter.
 */
import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BRAND_ICONS, type BrandIcon } from "./brand-icons.js";
import { brandIconHtml, brandMarkHtml } from "./brand-mark.js";
import { BrandIcon as BrandIconView } from "./browser/brand-mark.js";
import { htmlString } from "./html.js";

const SIMPLE_ICONS = ["betterstack", "chrome", "claude", "cloudflare", "confluence", "discord", "figma", "github", "gmail", "intercom", "jira", "linear",
  "notion", "paypal", "posthog", "sentry", "shadcn", "square", "stripe", "supabase", "telegram", "vercel", "webflow", "wix", "zapier"];
const SVGL = ["canva", "openai", "playwright", "slack", "teams"];
/**
 * The exact box around path data as the generator writes it: absolute M, then relative c, l, h, v and z.
 * A curve reaches past its end points only where its derivative is zero, so those points are added too.
 */
function bounds(d: string): { width: number; height: number; center: { x: number; y: number } } {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const xs: number[] = [], ys: number[] = [];
  const take = () => Number(tokens[i++]);
  /** Where a cubic from p0 to p3 turns, along one axis. */
  const turns = (p0: number, p1: number, p2: number, p3: number, into: number[]) => {
    const a = p1 - p0, b = p2 - p1, c = p3 - p2, qa = a - 2 * b + c, qb = 2 * (b - a);
    const roots = Math.abs(qa) < 1e-12 ? (qb === 0 ? [] : [-a / qb]) : (() => {
      const disc = qb * qb - 4 * qa * a;
      return disc < 0 ? [] : [(-qb + Math.sqrt(disc)) / (2 * qa), (-qb - Math.sqrt(disc)) / (2 * qa)];
    })();
    for (const t of roots) if (t > 0 && t < 1) into.push((1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3);
  };
  let i = 0, x = 0, y = 0, startX = 0, startY = 0, command = "";
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i]!)) command = tokens[i++]!;
    if (command === "M") { x = startX = take(); y = startY = take(); }
    else if (command === "l") { x += take(); y += take(); }
    else if (command === "h") x += take();
    else if (command === "v") y += take();
    else if (command === "c") {
      const [x1, y1, x2, y2, dx, dy] = [take(), take(), take(), take(), take(), take()];
      turns(x, x + x1, x + x2, x + dx, xs); turns(y, y + y1, y + y2, y + dy, ys);
      x += dx; y += dy;
    } else if (command === "z") { x = startX; y = startY; command = ""; }
    else throw Error(`unexpected path command ${command || tokens[i]}`);
    xs.push(x); ys.push(y);
  }
  const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return { width: right - left, height: bottom - top, center: { x: (left + right) / 2, y: (top + bottom) / 2 } };
}

test("every icon is one 24x24 currentColor path, centred at one optical size, from Simple Icons or svgl", () => {
  expect(Object.keys(BRAND_ICONS).sort()).toEqual([...SIMPLE_ICONS, ...SVGL].sort());
  for (const [id, icon] of Object.entries(BRAND_ICONS) as [string, BrandIcon][]) {
    expect(icon.source, id).toBe(SVGL.includes(id) ? "svgl" : "Simple Icons");
    expect(icon.title.length, id).toBeGreaterThan(0);
    expect(icon.path, id).toMatch(/^M[-+.,\deMmLlHhVvCcSsQqTtAaZz ]+$/);
    const box = bounds(icon.path);
    // The area of a 20x20 square, unless that would pass the box (a wide wordmark fills its width).
    const long = Math.max(box.width, box.height);
    if (long < 23.99) expect(Math.sqrt(box.width * box.height), id).toBeCloseTo(20, 1);
    else expect(long, id).toBeCloseTo(24, 1);
    expect(box.center.x, id).toBeCloseTo(12, 1);
    expect(box.center.y, id).toBeCloseTo(12, 1);
    const html = htmlString(brandMarkHtml(id, icon.title, true));
    expect(html.match(/<svg[^>]*>/g), id).toEqual(['<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">']);
    expect(html.match(/<path /g)?.length, id).toBe(1);
    expect(html, id).not.toMatch(/#[0-9a-f]{3,6}|rgb\(|url\(|<image|href=/i);
    expect(renderToStaticMarkup(createElement(BrandIconView, { id: id as never })).replace("></path>", "/>"), id).toBe(htmlString(brandIconHtml(id as never)));
  }
  // Only OpenAI keeps its source's even-odd rule; its holes rely on it.
  expect(Object.entries(BRAND_ICONS).filter(([, one]) => (one as BrandIcon).evenodd).map(([id]) => id)).toEqual(["openai"]);
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

