// Generates src/brand-icons.ts: every integration logo as one monochrome
// 24x24 path, the mark's larger side 20 and centred. Run it after changing a
// source: `node scripts/brand-icons.mjs`. Nothing here runs with Toolroll.
//
// Sources: Simple Icons (npm simple-icons, CC0), already one path each; and
// five SVGs from svgl (svgl.app, MIT) saved as published under
// assets/brand-icons/. A multi-colour svgl mark is flattened by its recipe
// below, checked by eye: layers that shade one shape become that shape, a
// white glyph becomes a hole, and a shape in front cuts a thin gap into the
// shapes behind it, so overlapping shapes stay apart instead of merging.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import paper from "paper";
import * as simpleIcons from "simple-icons";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = 24, MARK = 20;
/** The gap a front shape cuts, in final units (the mark is 20). */
const GAP = 0.9;

/** id → Simple Icons slug. */
const SIMPLE = {
  stripe: "stripe", notion: "notion", linear: "linear", sentry: "sentry", jira: "jira", confluence: "confluence",
  intercom: "intercom", zapier: "zapier", square: "square", paypal: "paypal", webflow: "webflow", wix: "wix",
  vercel: "vercel", cloudflare: "cloudflare", figma: "figma", posthog: "posthog", betterstack: "betterstack",
  telegram: "telegram", discord: "discord", github: "github", gmail: "gmail", claude: "claude", supabase: "supabase",
  shadcn: "shadcnui", chrome: "googlechrome",
};

/**
 * id → svgl file and recipe. Elements are numbered in document order, defs
 * left out. `shapes` run back to front; each is the union of `from`, less the
 * union of `holes`. Elements in no shape are colour overlays on a shape
 * already listed, or (Playwright's dark outlines) shading of the masks.
 */
const SVGL = {
  slack: { title: "Slack", file: "slack.svg", shapes: [{ from: [0] }, { from: [1] }, { from: [2] }, { from: [3] }] },
  teams: { title: "Microsoft Teams", file: "microsoft-teams.svg",
    // Back body, front body, the two heads, then the T tile in front of them all.
    shapes: [{ from: [0] }, { from: [1] }, { from: [4] }, { from: [7] }, { from: [10], holes: [12] }] },
  canva: { title: "Canva", file: "canva.svg", shapes: [{ from: [0], holes: [5] }] },
  openai: { title: "OpenAI", file: "openai.svg", shapes: [{ from: [0] }] },
  // The red mask behind (with its shading), the green mask in front (with its shading).
  playwright: { title: "Playwright", file: "playwright.svg", shapes: [{ from: [2, 4, 6] }, { from: [3, 5] }] },
};

paper.setup(new paper.Size(SIZE, SIZE));

/** Path data with every number separated: compact arc flags ("a1 1 0 011 1") trip paper's parser. */
function spaced(d) {
  const ARITY = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
  const out = [];
  const re = /\s*,?\s*([a-zA-Z])|\s*,?\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/gy;
  let command = "", index = 0, match, at = 0;
  const flag = /\s*,?\s*([01])/y;
  while (at < d.length) {
    if (/^[\s,]*$/.test(d.slice(at))) break;
    // Arc flags are the 4th and 5th numbers of an arc, and may be single unseparated digits.
    if (command.toLowerCase() === "a" && (index % 7 === 3 || index % 7 === 4)) {
      flag.lastIndex = at;
      match = flag.exec(d);
      if (!match) throw Error(`Bad arc flag at ${at} in ${d.slice(at, at + 20)}`);
      out.push(match[1]); index++; at = flag.lastIndex; continue;
    }
    re.lastIndex = at;
    match = re.exec(d);
    if (!match) throw Error(`Bad path data at ${at}: ${d.slice(at, at + 20)}`);
    at = re.lastIndex;
    if (match[1]) { command = match[1]; index = 0; out.push(command); }
    else { out.push(match[2]); index++; }
    if (ARITY[command.toLowerCase()] === undefined) throw Error(`Unknown command ${command}`);
  }
  return out.join(" ");
}

const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;

/** The drawn elements of an SVG, in order, as paper items with their fill rule. */
function elements(svg) {
  const body = svg.replace(/<defs[\s\S]*?<\/defs>/g, "").replace(/<clipPath[\s\S]*?<\/clipPath>/g, "");
  const groupRule = /<g[^>]*fill-rule="evenodd"/.test(body) ? "evenodd" : "nonzero";
  return [...body.matchAll(/<(path|rect|circle)\b[^>]*>/g)].map(([tag, kind]) => {
    let item;
    if (kind === "path") item = new paper.CompoundPath(spaced(attr(tag, "d")));
    else if (kind === "rect") {
      const [x, y, w, h, rx] = ["x", "y", "width", "height", "rx"].map(n => Number(attr(tag, n) ?? 0));
      item = new paper.Path.Rectangle(new paper.Rectangle(x, y, w, h), new paper.Size(rx, rx));
    } else item = new paper.Path.Circle(new paper.Point(Number(attr(tag, "cx")), Number(attr(tag, "cy"))), Number(attr(tag, "r")));
    item.fillRule = attr(tag, "fill-rule") ?? groupRule;
    item.remove();
    return item;
  });
}

const unite = items => items.slice(1).reduce((all, one) => { const next = all.unite(one, { insert: false }); return next; }, items[0].clone({ insert: false }).unite(items[0], { insert: false }));

/** The shape grown by `by` all round: its union with copies shifted in 32 directions. */
function grown(shape, by) {
  let all = shape.clone({ insert: false });
  for (let i = 0; i < 32; i++) {
    const angle = (i / 32) * Math.PI * 2;
    const copy = shape.clone({ insert: false });
    copy.translate(new paper.Point(Math.cos(angle) * by, Math.sin(angle) * by));
    all = all.unite(copy, { insert: false });
  }
  return all;
}

function flatten(svg, recipe) {
  const parts = elements(svg);
  const silhouettes = recipe.shapes.map(shape => unite(shape.from.map(i => parts[i])));
  const span = Math.max(...silhouettes.map(s => Math.max(s.bounds.width, s.bounds.height)));
  const gap = (GAP / MARK) * span;
  return recipe.shapes.map((shape, at) => {
    let region = silhouettes[at];
    if (shape.holes) region = region.subtract(unite(shape.holes.map(i => parts[i])), { insert: false });
    for (const front of silhouettes.slice(at + 1)) {
      if (region.bounds.intersects(front.bounds.expand(gap * 2))) region = region.subtract(grown(front, gap), { insert: false });
    }
    return region;
  });
}

/** Scale and centre so the larger side is MARK, then write compact path data. */
function fit(items) {
  const group = new paper.Group({ children: items, insert: false });
  const box = group.bounds;
  group.scale(MARK / Math.max(box.width, box.height), box.center);
  group.translate(new paper.Point(SIZE / 2, SIZE / 2).subtract(group.bounds.center));
  const data = group.children.map(child => child.pathData).join("");
  return data.replace(/-?\d*\.?\d+(e-?\d+)?/g, n => {
    const r = Math.round(Number(n) * 1000) / 1000;
    return String(Object.is(r, -0) ? 0 : r).replace(/^(-?)0\./, "$1.");
  }).replace(/([a-zA-Z]) /g, "$1").replace(/ -/g, "-").replace(/,-/g, "-");
}

const icons = {};
for (const [id, slug] of Object.entries(SIMPLE)) {
  const icon = Object.values(simpleIcons).find(one => one?.slug === slug);
  if (!icon) throw Error(`Simple Icons has no ${slug}`);
  const path = new paper.CompoundPath(spaced(icon.path));
  path.remove();
  icons[id] = { title: icon.title, source: "Simple Icons", path: fit([path]) };
}
for (const [id, recipe] of Object.entries(SVGL)) {
  const svg = readFileSync(join(root, "assets/brand-icons", recipe.file), "utf8");
  icons[id] = { title: recipe.title, source: "svgl", path: fit(flatten(svg, recipe)) };
}

const sorted = Object.keys(icons).sort();
const lines = sorted.map(id => `  ${JSON.stringify(id)}: { title: ${JSON.stringify(icons[id].title)}, source: ${JSON.stringify(icons[id].source)}, path: ${JSON.stringify(icons[id].path)} },`);
const version = JSON.parse(readFileSync(join(root, "node_modules/simple-icons/package.json"), "utf8")).version;
writeFileSync(join(root, "src/brand-icons.ts"), `/**
 * Integration logos: each one path in a 24x24 box, filled with currentColor,
 * the mark's larger side 20 and centred. Generated by scripts/brand-icons.mjs
 * from Simple Icons ${version} (CC0) and svgl (MIT, assets/brand-icons/); do
 * not edit by hand. The logos are their owners' trademarks, used only to name
 * the integrations. See THIRD_PARTY_NOTICES.md.
 */
export type BrandIcon = { title: string; source: "Simple Icons" | "svgl"; path: string };

export const BRAND_ICONS = {
${lines.join("\n")}
} as const satisfies Record<string, BrandIcon>;

export type BrandIconId = keyof typeof BRAND_ICONS;
`);
console.log(`Wrote ${sorted.length} icons to src/brand-icons.ts`);
