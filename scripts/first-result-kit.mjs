/**
 * The first-result clock's parts that need no world (docs/plans/public-release.md, B1 and slice 1): a small terminal
 * screen that reads what a program drew at a pseudo-terminal, the trace of a newcomer's first run (each step with its
 * time, its kind and what was on screen), the split timings, the report, and how each install path is started.
 * scripts/first-result-e2e.mjs drives the journeys with these; src/first-result-kit.test.ts proves them.
 *
 * Nothing here starts a process or reads the network.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

// ------------------------------------------------------------------ the screen

/** Code points a terminal draws two cells wide (East Asian wide and the emoji block): close enough to read words. */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1FAFF}]/u;

/**
 * A terminal screen of `rows` × `cols` cells fed with what a program wrote (escape sequences and all). It keeps only
 * what is drawn now: cursor moves, erases and scrolling are applied, colours and modes are dropped. Enough to read the
 * words of a screen drawn by Ink (the terminal UI) or a plain program, not a full terminal.
 */
export class Screen {
  constructor(rows = 40, cols = 120) {
    this.rows = rows; this.cols = cols;
    this.grid = Array.from({ length: rows }, () => this.blank());
    this.r = 0; this.c = 0; this.saved = [0, 0];
    this.pending = "";
    /** Lines scrolled off the top, oldest first (kept short). */
    this.scrolled = [];
  }
  blank() { return Array.from({ length: this.cols }, () => " "); }
  lineFeed() {
    if (this.r < this.rows - 1) { this.r += 1; return; }
    this.scrolled.push(this.grid.shift().join("").replace(/\s+$/, ""));
    if (this.scrolled.length > 500) this.scrolled.splice(0, this.scrolled.length - 500);
    this.grid.push(this.blank());
  }
  put(char) {
    const wide = WIDE.test(char);
    if (this.c + (wide ? 1 : 0) >= this.cols) { this.c = 0; this.lineFeed(); }
    this.grid[this.r][this.c] = char;
    this.c += 1;
    if (wide && this.c < this.cols) { this.grid[this.r][this.c] = ""; this.c += 1; }
  }
  eraseLine(row, from, to) { for (let col = Math.max(0, from); col < Math.min(this.cols, to); col += 1) this.grid[row][col] = " "; }
  csi(params, final, priv) {
    const nums = params === "" ? [] : params.split(";").map(one => (one === "" ? null : Number(one)));
    const n = (index = 0, fallback = 1) => { const value = nums[index]; return value === null || value === undefined || !Number.isFinite(value) || value === 0 ? fallback : value; };
    const clampRow = row => Math.max(0, Math.min(this.rows - 1, row));
    const clampCol = col => Math.max(0, Math.min(this.cols - 1, col));
    if (priv) return; // modes (?25l and the like): nothing drawn
    switch (final) {
      case "A": this.r = clampRow(this.r - n()); break;
      case "B": this.r = clampRow(this.r + n()); break;
      case "C": this.c = clampCol(this.c + n()); break;
      case "D": this.c = clampCol(this.c - n()); break;
      case "E": this.r = clampRow(this.r + n()); this.c = 0; break;
      case "F": this.r = clampRow(this.r - n()); this.c = 0; break;
      case "G": this.c = clampCol(n() - 1); break;
      case "d": this.r = clampRow(n() - 1); break;
      case "H": case "f": this.r = clampRow(n(0) - 1); this.c = clampCol(n(1) - 1); break;
      case "J": {
        const mode = nums[0] ?? 0;
        if (mode === 0) { this.eraseLine(this.r, this.c, this.cols); for (let row = this.r + 1; row < this.rows; row += 1) this.eraseLine(row, 0, this.cols); }
        else if (mode === 1) { this.eraseLine(this.r, 0, this.c + 1); for (let row = 0; row < this.r; row += 1) this.eraseLine(row, 0, this.cols); }
        else for (let row = 0; row < this.rows; row += 1) this.eraseLine(row, 0, this.cols);
        break;
      }
      case "K": {
        const mode = nums[0] ?? 0;
        if (mode === 0) this.eraseLine(this.r, this.c, this.cols);
        else if (mode === 1) this.eraseLine(this.r, 0, this.c + 1);
        else this.eraseLine(this.r, 0, this.cols);
        break;
      }
      case "X": this.eraseLine(this.r, this.c, this.c + n()); break;
      case "P": { const row = this.grid[this.r]; row.splice(this.c, n()); while (row.length < this.cols) row.push(" "); break; }
      case "@": { const row = this.grid[this.r]; row.splice(this.c, 0, ...Array(n()).fill(" ")); row.length = this.cols; break; }
      case "L": for (let i = 0; i < n(); i += 1) { this.grid.splice(this.r, 0, this.blank()); this.grid.length = this.rows; } break;
      case "M": for (let i = 0; i < n(); i += 1) { this.grid.splice(this.r, 1); this.grid.push(this.blank()); } break;
      case "S": for (let i = 0; i < n(); i += 1) { this.grid.shift(); this.grid.push(this.blank()); } break;
      case "T": for (let i = 0; i < n(); i += 1) { this.grid.pop(); this.grid.unshift(this.blank()); } break;
      case "s": this.saved = [this.r, this.c]; break;
      case "u": [this.r, this.c] = this.saved; break;
      default: break; // m (colours), r (scroll region) and the rest draw nothing
    }
  }
  /** Feed what the program wrote. A sequence cut in two between writes is finished by the next write. */
  write(text) {
    const chars = [...(this.pending + text)];
    this.pending = "";
    let i = 0;
    while (i < chars.length) {
      const char = chars[i];
      if (char === "\u001b") {
        const next = chars[i + 1];
        if (next === undefined) { this.pending = chars.slice(i).join(""); return; }
        if (next === "[") {
          let j = i + 2, priv = false, params = "";
          if (chars[j] !== undefined && /[?>=!]/.test(chars[j])) { priv = true; j += 1; }
          while (j < chars.length && /[0-9;:]/.test(chars[j])) { params += chars[j]; j += 1; }
          while (j < chars.length && /[ -/]/.test(chars[j])) j += 1; // intermediates
          if (j >= chars.length) { this.pending = chars.slice(i).join(""); return; }
          this.csi(params.replace(/:/g, ";"), chars[j], priv);
          i = j + 1;
          continue;
        }
        if (next === "]" || next === "P" || next === "_" || next === "^") {
          // OSC / DCS / APC / PM: up to BEL or ESC \
          let j = i + 2;
          while (j < chars.length && chars[j] !== "\u0007" && !(chars[j] === "\u001b" && chars[j + 1] === "\\")) j += 1;
          if (j >= chars.length) { this.pending = chars.slice(i).join(""); return; }
          i = chars[j] === "\u0007" ? j + 1 : j + 2;
          continue;
        }
        if (next === "(" || next === ")" || next === "*" || next === "+" || next === "#") { i += 3; continue; }
        if (next === "7") this.saved = [this.r, this.c];
        else if (next === "8") [this.r, this.c] = this.saved;
        else if (next === "M") { if (this.r > 0) this.r -= 1; else { this.grid.pop(); this.grid.unshift(this.blank()); } }
        else if (next === "c") { this.grid = Array.from({ length: this.rows }, () => this.blank()); this.r = 0; this.c = 0; }
        else if (next === "D") this.lineFeed();
        else if (next === "E") { this.lineFeed(); this.c = 0; }
        i += 2;
        continue;
      }
      if (char === "\r") this.c = 0;
      else if (char === "\n") { this.lineFeed(); this.c = 0; }
      else if (char === "\b") this.c = Math.max(0, this.c - 1);
      else if (char === "\t") this.c = Math.min(this.cols - 1, (Math.floor(this.c / 8) + 1) * 8);
      else if (char >= " " && char !== "\u007f" && !(char >= "\u0080" && char <= "\u009f")) this.put(char);
      i += 1;
    }
  }
  /** What is on the screen now: each row without its trailing spaces, without the empty rows at the end. */
  text() {
    return this.grid.map(row => row.join("").replace(/\s+$/, "")).join("\n").replace(/\n+$/, "");
  }
}

/** Text with every escape sequence and control character taken out (a whole transcript, for words and stack traces). */
export function plainText(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\u001b\[[0-9;?:>=!]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b[()*+#]./g, "").replace(/\u001b./g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\r/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/** Whether a program's words show a stack trace or a raw error (what a newcomer must never see). */
export function looksLikeStackTrace(text) {
  return /^\s+at .+[(\s].*:\d+:\d+\)?$/m.test(text) || /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|Unhandled|ERR_[A-Z_]+)\b/.test(text) || /node:internal\//.test(text);
}

// ------------------------------------------------------------------ the trace

/** A step's kind. The three counted kinds are the plan's (v2, finding 1): a decision the person must make, an
 * interaction (a key, a click, a command typed), and a wait. `not-possible` marks a step the surface can't do today;
 * the steps the person takes instead follow it, marked `fallback`, and are counted like any other. */
export const KINDS = ["decision", "interaction", "wait", "not-possible", "note"];

/** The moments the clock marks, in the order a first run passes them (B1.3's splits). */
export const MARKS = ["clock", "installed", "started", "task-sent", "terms-shown", "filed", "approved", "build-start", "build-end", "ready", "accepted"];

/** The split timings reported for every timed journey: each from one mark to the next one that was reached. */
export const SPLITS = [
  { name: "install", from: "clock", to: "installed", about: "the install command, or npx's download until Toolroll prints its first line" },
  { name: "start", from: "installed", to: "started", about: "until the first screen is drawn" },
  { name: "first task filed", from: "started", to: ["terms-shown", "filed"], about: "writing the task (keys are instant here) and Toolroll reading it, until its terms show or it is filed" },
  { name: "plan/approval", from: ["terms-shown", "filed"], to: "approved", about: "the plan (when it takes the plan road) and the approval" },
  { name: "build", from: "approved", to: "build-end", about: "from the approval until the build ends" },
  { name: "result ready", from: "build-end", to: "ready", about: "checks, until the result reads Ready" },
  { name: "reviewed/accepted", from: "ready", to: "accepted", about: "reading the result and accepting it" },
];

/** The person's time the journey doesn't spend (it presses keys at once), added once to the measured time (B1.2). */
export const PERSON_ALLOWANCE = { "typing the task": 20, "reading the terms": 10, "reviewing the result": 30 };
export const PERSON_SECONDS = Object.values(PERSON_ALLOWANCE).reduce((sum, one) => sum + one, 0);

const round = seconds => Math.round(seconds * 10) / 10;
/** At most `limit` lines of a screen, for a trace entry. */
export const clip = (text, limit = 40) => { const lines = String(text ?? "").split("\n"); return lines.length <= limit ? lines.join("\n") : [...lines.slice(0, limit), `… (${lines.length - limit} more lines)`].join("\n"); };

/**
 * A newcomer's first run, step by step. The clock starts when the trace is made (or at `mark("clock")`); every step and
 * mark is in seconds since then. Quitting is never a step: the journey stops the program outside the trace.
 */
export function createTrace(journey, { now = () => Date.now() } = {}) {
  let t0 = now();
  const entries = [], marks = {};
  let fallback = false;
  const at = () => round((now() - t0) / 1000);
  const trace = {
    journey, entries, marks,
    /** Start the clock here (the install command's spawn): the steps before it (choosing and typing the command) are at 0. */
    startClock() { t0 = now(); for (const entry of entries) { entry.at = 0; entry.beforeClock = true; } for (const key of Object.keys(marks)) delete marks[key]; marks.clock = 0; return trace; },
    /** One step. `screen` is what was on screen when it was taken. */
    step(kind, what, { surface = "terminal", screen = null, keys = null, note = null, instead = null } = {}) {
      if (!KINDS.includes(kind)) throw new Error(`a step is ${KINDS.join(", ")}, not ${kind}`);
      const entry = { at: at(), kind, what, surface, ...(keys === null ? {} : { keys }), ...(screen === null ? {} : { screen: clip(screen) }), ...(note === null ? {} : { note }), ...(instead === null ? {} : { instead }), ...(fallback && kind !== "not-possible" && kind !== "note" ? { fallback: true } : {}) };
      entries.push(entry);
      return entry;
    },
    decision(what, options) { return trace.step("decision", what, options); },
    interaction(what, options) { return trace.step("interaction", what, options); },
    note(what, options) { return trace.step("note", what, options); },
    /** A step this surface can't do today, and what the person does instead; the steps after it are the fallback until `endFallback`. */
    notPossible(what, instead, options = {}) { const entry = trace.step("not-possible", what, { ...options, instead }); fallback = true; return entry; },
    endFallback() { fallback = false; },
    /** A wait: begun now, ended by the returned function (with what was on screen at its end). */
    beginWait(what, { surface = "terminal" } = {}) {
      const started = now();
      return ({ screen = null, note = null } = {}) => {
        const entry = trace.step("wait", what, { surface, screen, note });
        entry.at = round((started - t0) / 1000);
        entry.seconds = round((now() - started) / 1000);
        return entry;
      };
    },
    /** A moment the clock marks (the first time only). */
    mark(name) { if (!MARKS.includes(name)) throw new Error(`no mark ${name}`); if (!(name in marks)) marks[name] = at(); return marks[name]; },
    elapsed: at,
  };
  marks.clock = 0;
  return trace;
}

/** The three counts (and the rest) of a trace's steps. Fallback steps count like any other; `fallback` says how many. */
export function countsOf(entries) {
  const of = kind => entries.filter(one => one.kind === kind);
  return {
    decisions: of("decision").length,
    interactions: of("interaction").length,
    waits: of("wait").length,
    waitSeconds: round(of("wait").reduce((sum, one) => sum + (one.seconds ?? 0), 0)),
    notPossible: of("not-possible").length,
    fallback: entries.filter(one => one.fallback).length,
  };
}

/** Each split's seconds, from the marks reached (null when either end wasn't). */
export function splitsOf(marks) {
  const first = names => [names].flat().map(name => marks[name]).filter(one => typeof one === "number").sort((a, b) => a - b)[0] ?? null;
  return SPLITS.map(one => {
    const from = first(one.from), to = first(one.to);
    return { name: one.name, about: one.about, seconds: from === null || to === null ? null : round(to - from) };
  });
}

/** The measured time (clock to Accepted) and the total with the person's allowance, or nulls when it wasn't accepted. */
export function totalOf(marks) {
  const machine = typeof marks.accepted === "number" ? marks.accepted : null;
  return { machineSeconds: machine, personSeconds: PERSON_SECONDS, totalSeconds: machine === null ? null : round(machine + PERSON_SECONDS) };
}

// ------------------------------------------------------------------ install paths

/** The README's own install paths (v2, finding 1) and the one the plan leads with; `local` is this checkout's build. */
export const INSTALLS = ["npx", "npm", "brew", "local"];
/** The Homebrew formula the README names. */
export const BREW_FORMULA = "ap9000/toolroll/toolroll";

/** What a package source is: a registry spec (toolroll@1.2.3) or a local tarball or folder. Null when it is neither. */
export function packageSource(spec, cwd = process.cwd()) {
  if (typeof spec !== "string" || spec === "") return null;
  if (/^toolroll@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec)) return { kind: "registry", spec, version: spec.slice("toolroll@".length) };
  const path = isAbsolute(spec) ? spec : resolve(cwd, spec);
  if (existsSync(path) && (path.endsWith(".tgz") ? statSync(path).isFile() : existsSync(join(path, "package.json")))) return { kind: "local", spec: path, version: null };
  return null;
}

/**
 * Why a real run may not start, or null when it may. A real run makes real model calls and downloads the package, so it
 * starts only on purpose: `--package <toolroll@x.y.z | path>` and `--confirm-real-run`; brew installs into this
 * computer's own Homebrew, so it also needs `--allow-brew`.
 */
export function realRunRefusal({ journeys, pkg, confirmed, install, allowBrew }, cwd = process.cwd()) {
  if (journeys === "scripted") return null;
  const usage = "node scripts/first-result-e2e.mjs --journeys real --package toolroll@<version> --confirm-real-run [--install npx|npm|brew] [--allow-brew]";
  if (!INSTALLS.includes(install)) return `--install is ${INSTALLS.join(", ")}, not ${install}`;
  if (!confirmed) return `a real run makes real model calls and downloads the package; start it on purpose: ${usage}`;
  if (install !== "local" && packageSource(pkg, cwd) === null) return `--package must be toolroll@<version> (the registry) or a packed tarball or folder: ${usage}`;
  if (install === "brew" && !allowBrew) return "--install brew installs into this computer's own Homebrew (not a throwaway folder): add --allow-brew to do that on purpose";
  return null;
}

/**
 * How one install path is run, inside the journey's throwaway folder `root`: the install command (null for npx, which
 * downloads as it starts, and for this checkout's build) and the command typed at the terminal to start Toolroll. npm
 * installs into a throwaway prefix; every path starts with an empty npm cache.
 */
export function launchPlan({ install, pkg, root, localBin, brewPrefix = null }) {
  const cache = join(root, "npm-cache");
  const npmEnv = { npm_config_cache: cache };
  if (install === "local") return { install: null, start: "toolroll", env: {}, path: [], notes: ["this checkout's build: no download or install is measured"] };
  const source = packageSource(pkg);
  const notes = source?.kind === "local" ? ["a local package: the registry download is not measured (v2: only the registry download counts)"] : [];
  if (install === "npx") return { install: null, start: `npx -y ${pkg}`, env: npmEnv, path: [], notes: [...notes, "npx downloads as it starts: the install split ends at Toolroll's first line"] };
  if (install === "npm") {
    const prefix = join(root, "npm-prefix");
    return { install: { command: "npm", args: ["install", "-g", pkg], env: { ...npmEnv, npm_config_prefix: prefix } }, start: "toolroll", env: npmEnv, path: [join(prefix, "bin")], notes: [...notes, "npm install -g into a throwaway prefix (the same download and install, not this computer's global folder)"] };
  }
  if (install === "brew") {
    return { install: { command: "brew", args: ["install", BREW_FORMULA], env: {}, realHome: true }, start: "toolroll", env: npmEnv, path: brewPrefix === null ? [] : [join(brewPrefix, "bin")],
      notes: [`brew installs the tap's formula (${BREW_FORMULA}), whatever version it holds; --package names what was meant`, "brew installs into this computer's own Homebrew"] };
  }
  throw new Error(`no install path ${install}`);
}

// ------------------------------------------------------------------ the report

const seconds = value => (value === null || value === undefined ? "—" : `${value} s`);
const fence = text => ["```", String(text).replace(/```/g, "ˋˋˋ"), "```"];

/** The report's markdown: the run, each journey's counts, splits, criteria and trace. */
export function reportMarkdown(report) {
  const lines = [`# First result — ${report.mode} (${report.startedAt})`, ""];
  lines.push(report.mode === "scripted"
    ? "Scripted: the models answer at once from scripts, so the times are Toolroll's own machine time and prove the driver, the step counts and the failure paths; they are not a newcomer's time."
    : "Real models, the package named below, a throwaway home and npm cache. The person's allowance is added once to the measured time.", "");
  lines.push(`- Package: ${report.package.spec}${report.package.version ? ` (version ${report.package.version})` : ""}${report.package.integrity ? `, ${report.package.integrity}` : ""}`);
  lines.push(`- Install path: ${report.install}${report.notes.length > 0 ? ` — ${report.notes.join("; ")}` : ""}`);
  lines.push(`- Task (frozen): “${report.task}”`);
  lines.push(`- Repository (frozen): ${report.repo}`);
  lines.push(`- Machine: ${report.machine.os}, ${report.machine.cpu}, ${report.machine.memoryGb} GB, Node ${report.machine.node}${report.machine.network ? `; network: ${report.machine.network}` : ""}`);
  lines.push(`- Person allowance: ${PERSON_SECONDS} s (${Object.entries(PERSON_ALLOWANCE).map(([name, value]) => `${name} ${value} s`).join(", ")}), added once`, "");
  lines.push("| Journey | Result | Decisions | Interactions | Waits | Not possible today | Measured | With allowance |", "|---|---|---|---|---|---|---|---|");
  for (const one of report.journeys) {
    const counts = one.counts;
    lines.push(`| ${one.name} | ${one.ok ? "ran" : `failed: ${String(one.error ?? "").split("\n")[0].slice(0, 80)}`} | ${counts.decisions} | ${counts.interactions} | ${counts.waits} (${counts.waitSeconds} s) | ${counts.notPossible} | ${seconds(one.total?.machineSeconds)} | ${seconds(one.total?.totalSeconds)} |`);
  }
  lines.push("");
  for (const one of report.journeys) {
    lines.push(`## ${one.name}`, "", one.about, "");
    if (one.error) lines.push(`**The journey failed:** ${one.error}`, "");
    if (one.splits.some(split => split.seconds !== null)) {
      lines.push("| Split | Seconds | What it covers |", "|---|---|---|", ...one.splits.map(split => `| ${split.name} | ${seconds(split.seconds)} | ${split.about} |`), "");
      lines.push(`Marks: ${Object.entries(one.marks).map(([name, value]) => `${name} ${value} s`).join(" · ")}`, "");
    }
    if (one.criteria.length > 0) lines.push("| Criterion | Met | What was seen |", "|---|---|---|", ...one.criteria.map(c => `| ${c.id} ${c.text} | ${c.met === null ? "not measured" : c.met ? "yes" : "**no**"} | ${String(c.seen).replace(/\|/g, "\\|").replace(/\n/g, " ")} |`), "");
    lines.push("Trace (decision: the person must choose; interaction: a key, click or command; wait: the person waits):", "");
    let lastScreen = null;
    for (const entry of one.trace) {
      const mark = entry.kind === "not-possible" ? "NOT POSSIBLE IN THE TERMINAL TODAY" : entry.kind;
      lines.push(`- ${entry.at.toFixed(1)} s · **${mark}**${entry.fallback ? " (instead)" : ""} · ${entry.surface} · ${entry.what}${entry.seconds !== undefined ? ` — waited ${entry.seconds} s` : ""}${entry.keys ? ` · keys: ${entry.keys}` : ""}${entry.instead ? ` — instead: ${entry.instead}` : ""}${entry.note ? ` (${entry.note})` : ""}`);
      if (entry.screen && entry.kind !== "interaction") {
        if (entry.screen === lastScreen) lines.push("  (the same screen as above)");
        else lines.push("", ...fence(entry.screen), "");
        lastScreen = entry.screen;
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
