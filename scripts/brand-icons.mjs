// Generates src/brand-icons.ts: every integration logo as one monochrome
// path in a 24x24 box, centred and scaled to one optical size. Run it after
// changing a source: `node scripts/brand-icons.mjs`. Nothing here runs with
// Toolroll, and paper and simple-icons are not Toolroll dependencies: when
// the checkout lacks the pinned versions, the first run installs them into
// node_modules/.cache/brand-icons.
//
// Sources: Simple Icons (npm simple-icons, CC0), already one path each; and
// SVGs saved as published under assets/brand-icons/: five from svgl
// (svgl.app, MIT) and Zapier's asterisk from Simple Icons 9.10.0. A logo's
// shapes are kept exactly as drawn, every fill becomes currentColor, and only
// scale and position change: no shape is merged, cut or redrawn. Overlapping
// shapes simply paint over one another in the one colour; a white glyph (the
// Canva C, the Teams T) stays see-through, its outline added in the opposite
// winding once per shape it sits on.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PINNED = { paper: "0.12.18", "simple-icons": "16.34.0" };
const CACHE = join(root, "node_modules/.cache/brand-icons");

/** paper and simple-icons from `base`, or null unless it has exactly the pinned versions. */
function load(base) {
  const version = name => { try { return JSON.parse(readFileSync(join(base, "node_modules", name, "package.json"), "utf8")).version; } catch { return null; } };
  if (!Object.entries(PINNED).every(([name, pin]) => version(name) === pin)) return null;
  const require = createRequire(join(base, "package.json"));
  return { paper: require("paper"), simpleIcons: require("simple-icons") };
}

let found = load(root) ?? load(CACHE);
if (!found) {
  const specs = Object.entries(PINNED).map(([name, pin]) => `${name}@${pin}`);
  console.log(`Installing ${specs.join(" and ")} into node_modules/.cache/brand-icons for this generator.`);
  mkdirSync(CACHE, { recursive: true });
  const npm = spawnSync("npm", ["install", "--no-save", "--no-audit", "--no-fund", "--prefix", CACHE, ...specs], { stdio: "inherit" });
  if (npm.status !== 0 || !(found = load(CACHE))) throw Error(`Could not install ${specs.join(" and ")}.`);
}
const { paper, simpleIcons } = found;
/**
 * The box is 24. Every mark gets the area of a 20x20 square (its sides'
 * geometric mean is 20), so a wide wordmark (Wix) reads the same size as a
 * square mark beside it; no side may pass the box.
 */
const SIZE = 24, MARK = 20;

/** id → Simple Icons slug. */
const SIMPLE = {
  stripe: "stripe", notion: "notion", linear: "linear", sentry: "sentry", jira: "jira", confluence: "confluence",
  intercom: "intercom", square: "square", paypal: "paypal", webflow: "webflow", wix: "wix",
  vercel: "vercel", cloudflare: "cloudflare", figma: "figma", posthog: "posthog", betterstack: "betterstack",
  telegram: "telegram", discord: "discord", github: "github", gmail: "gmail", claude: "claude", supabase: "supabase",
  shadcn: "shadcnui", chrome: "googlechrome",
};

/**
 * id → a saved SVG. Elements are numbered in document order, defs left out.
 * `shapes` are the drawn elements (a gradient layer repeating a shape is
 * left out: it adds nothing in one colour); `holes` are white glyphs.
 * `evenodd` keeps the source's own fill rule where its holes rely on it.
 */
const SAVED = {
  zapier: { title: "Zapier", source: "Simple Icons", file: "zapier.svg", shapes: [0] },
  slack: { title: "Slack", source: "svgl", file: "slack.svg", shapes: [0, 1, 2, 3] },
  // Back body, front body, the two heads, the T tile; the T is white.
  teams: { title: "Microsoft Teams", source: "svgl", file: "microsoft-teams.svg", shapes: [0, 1, 4, 7, 10], holes: [12] },
  canva: { title: "Canva", source: "svgl", file: "canva.svg", shapes: [0], holes: [5] },
  openai: { title: "OpenAI", source: "svgl", file: "openai.svg", shapes: [0], evenodd: true },
  // Every coloured element: the masks, their shading and the dark outlines.
  playwright: { title: "Playwright", source: "svgl", file: "playwright.svg", shapes: [0, 1, 2, 3, 4, 5, 6] },
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

/** The drawn elements of an SVG, in order, as paper paths. */
function elements(svg) {
  const body = svg.replace(/<defs[\s\S]*?<\/defs>/g, "").replace(/<clipPath[\s\S]*?<\/clipPath>/g, "");
  return [...body.matchAll(/<(path|rect|circle)\b[^>]*>/g)].map(([tag, kind]) => {
    let item;
    if (kind === "path") item = new paper.CompoundPath(spaced(attr(tag, "d")));
    else if (kind === "rect") {
      const [x, y, w, h, rx] = ["x", "y", "width", "height", "rx"].map(n => Number(attr(tag, n) ?? 0));
      item = new paper.Path.Rectangle(new paper.Rectangle(x, y, w, h), new paper.Size(rx, rx));
    } else item = new paper.Path.Circle(new paper.Point(Number(attr(tag, "cx")), Number(attr(tag, "cy"))), Number(attr(tag, "r")));
    item.remove();
    return item;
  });
}

/** One saved logo's subpaths: its shapes as drawn, then each white glyph wound against the shapes under it. */
function subpaths(svg, recipe) {
  const parts = elements(svg);
  const shapes = recipe.shapes.map(i => parts[i]);
  const out = shapes.map(shape => shape.clone({ insert: false }));
  for (const i of recipe.holes ?? []) {
    const hole = parts[i], inside = hole.interiorPoint;
    const under = shapes.filter(shape => shape.contains(inside));
    for (const shape of under) {
      const copy = hole.clone({ insert: false });
      const outer = (shape.children ?? [shape]).find(one => one.contains(inside)) ?? shape;
      copy.clockwise = !outer.clockwise;
      out.push(copy);
    }
  }
  return out;
}

/** Scale and centre to the one optical size, then write compact path data. */
function fit(items) {
  const group = new paper.Group({ children: items, insert: false });
  const { width, height } = group.bounds;
  group.scale(Math.min(MARK / Math.sqrt(width * height), SIZE / Math.max(width, height)), group.bounds.center);
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
for (const [id, recipe] of Object.entries(SAVED)) {
  const svg = readFileSync(join(root, "assets/brand-icons", recipe.file), "utf8");
  icons[id] = { title: recipe.title, source: recipe.source, path: fit(subpaths(svg, recipe)), ...(recipe.evenodd ? { evenodd: true } : {}) };
}

const sorted = Object.keys(icons).sort();
const lines = sorted.map(id => `  ${JSON.stringify(id)}: { title: ${JSON.stringify(icons[id].title)}, source: ${JSON.stringify(icons[id].source)}, ` +
  `${icons[id].evenodd ? "evenodd: true, " : ""}path: ${JSON.stringify(icons[id].path)} },`);
const version = PINNED["simple-icons"];
writeFileSync(join(root, "src/brand-icons.ts"), `/**
 * Integration logos: each one path in a 24x24 box, filled with currentColor,
 * centred, with the area of a 20x20 square. Generated by
 * scripts/brand-icons.mjs from Simple Icons ${version} (CC0), Zapier's asterisk
 * from Simple Icons 9.10.0 and svgl (MIT), the last two saved in
 * assets/brand-icons/; do not edit by hand. The logos are their owners'
 * trademarks, used only to name the integrations. See THIRD_PARTY_NOTICES.md.
 */
export type BrandIcon = { title: string; source: "Simple Icons" | "svgl"; evenodd?: true; path: string };

export const BRAND_ICONS = {
${lines.join("\n")}
} as const satisfies Record<string, BrandIcon>;

export type BrandIconId = keyof typeof BRAND_ICONS;
`);
console.log(`Wrote ${sorted.length} icons to src/brand-icons.ts`);
