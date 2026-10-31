/**
 * The eval world's dispatch gate (docs/plans/evals-nightly.md, part C, "Budget: reservations, not a start-only cap"),
 * and the provider-gate logic the runner needs at run time, ported from scripts/provider-gate.mjs so it ships in dist.
 *
 * An eval attempt runs in a world of its own (evals.ts). Before the world starts, the attempt's runner makes a gate
 * folder beside the world's database (which no agent's fence lets it write) holding `gate.json`: the case's dispatch
 * limit and its per-dispatch cap. The world's processes find it through TOOLROLL_EVAL_GATE. Every provider dispatch
 * the world makes takes one numbered slot first (an exclusive create, so two dispatches never take the same one):
 *
 *   - every invokeAgent call (builder, planner, repair, reviewer, scout), run under the cap (`--max-budget-usd`);
 *   - every lead request, which bypasses invokeAgent: a subscription request is capped the same way, and a direct API
 *     request is bounded by the lead turn's own reservation, which lead.ts holds to the slots left × the cap;
 *   - the helpers that would call a provider without any record (task sizing, flow drafts, subagent turns) refuse in
 *     an eval world instead.
 *
 * Past the limit, or where a dispatch can't be capped (a provider that can't hold a dollar cap), the dispatch refuses
 * and nothing is spent. Outside an eval world (no TOOLROLL_EVAL_GATE) nothing here changes anything. The variable
 * only ever narrows: it caps and counts, and a gate that can't be read refuses every dispatch (fail closed).
 *
 * The runner reads the slots back after the attempt (`evalGateSlots`) and settles each dispatch against the campaign's
 * reservation; a dispatch the world's database shows without a slot is settled at its full cap all the same.
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";

export const EVAL_GATE_ENV = "TOOLROLL_EVAL_GATE";
/** The gate's terms: how many dispatches the attempt may make, and each one's cap in micro-dollars. */
export type EvalGateConfig = { v: 1; max: number; capMicrousd: number };
/** One slot a dispatch took. */
export type EvalGateSlot = { n: number; kind: string; pid: number; at: string };
export type EvalDispatch =
  | { active: false }
  | { active: true; ok: true; n: number; capUsd: number; capMicrousd: number }
  | { active: true; ok: false; why: string };

const CONFIG = "gate.json";
const SLOTS = "slots";
const OVER = "over-limit";
const MAX_GATE_BYTES = 4096;

/** At most `limit` bodies at once; the others start in the order they asked, as each running one ends (provider-gate
 * limiter). */
export function limiter(limit: number): <T>(body: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("a limiter takes a whole number, 1 or more");
  let running = 0;
  const queue: (() => void)[] = [];
  const next = (): void => { if (running < limit && queue.length > 0) { running += 1; queue.shift()!(); } };
  return <T>(body: () => Promise<T>): Promise<T> => new Promise<void>(start => { queue.push(start); next(); }).then(async () => {
    try { return await body(); } finally { running -= 1; next(); }
  });
}

/** Read a small regular file without following a link; null when it isn't one, is too big or can't be read. */
export function readNoFollow(path: string, maxBytes: number): Buffer | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0)); } catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const out = Buffer.alloc(stat.size);
    let at = 0;
    while (at < out.length) {
      const got = readSync(fd, out, at, out.length - at, at);
      if (got === 0) break;
      at += got;
    }
    return at === out.length ? out : null;
  } catch { return null; } finally { closeSync(fd); }
}

const validConfig = (value: unknown): value is EvalGateConfig => {
  if (typeof value !== "object" || value === null) return false;
  const one = value as Record<string, unknown>;
  return one["v"] === 1 && Number.isInteger(one["max"]) && (one["max"] as number) >= 0 && (one["max"] as number) <= 50
    && Number.isInteger(one["capMicrousd"]) && (one["capMicrousd"] as number) > 0 && (one["capMicrousd"] as number) <= 50_000_000;
};

/** Make a world's gate in `dir` (a fresh folder the runner owns): its terms, and an empty slots folder. Refuses a folder
 * that already holds a gate. */
export function openEvalGate(dir: string, config: EvalGateConfig): void {
  if (!validConfig(config)) throw new Error("an eval gate needs a whole dispatch limit and a positive cap");
  mkdirSync(join(dir, SLOTS), { recursive: false, mode: 0o700 });
  const fd = openSync(join(dir, CONFIG), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, JSON.stringify(config)); } finally { closeSync(fd); }
}

/** The world's gate, as this process's environment names it: null outside an eval world, its terms, or why it can't
 * be read (which refuses every dispatch). */
export function evalWorldGate(env: Readonly<Record<string, string | undefined>> = process.env): { dir: string; config: EvalGateConfig } | { dir: string; problem: string } | null {
  const dir = env[EVAL_GATE_ENV];
  if (dir === undefined || dir === "") return null;
  const bytes = readNoFollow(join(dir, CONFIG), MAX_GATE_BYTES);
  if (bytes === null) return { dir, problem: "this eval world's dispatch gate can't be read, so nothing is dispatched" };
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { parsed = null; }
  return validConfig(parsed) ? { dir, config: parsed } : { dir, problem: "this eval world's dispatch gate is malformed, so nothing is dispatched" };
}

/** Take one dispatch slot of this eval world, before a provider is called. Outside an eval world: `{ active: false }`. */
export function takeEvalDispatch(kind: string, env: Readonly<Record<string, string | undefined>> = process.env, now: Date = new Date()): EvalDispatch {
  const gate = evalWorldGate(env);
  if (gate === null) return { active: false };
  if ("problem" in gate) return { active: true, ok: false, why: gate.problem };
  const record = JSON.stringify({ kind: kind.slice(0, 80), pid: process.pid, at: now.toISOString() });
  for (let n = 1; n <= gate.config.max; n++) {
    let fd: number;
    try { fd = openSync(join(gate.dir, SLOTS, `${n}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      return { active: true, ok: false, why: "this eval world's dispatch gate can't be written, so nothing is dispatched" };
    }
    try { writeSync(fd, record); } finally { closeSync(fd); }
    return { active: true, ok: true, n, capUsd: gate.config.capMicrousd / 1_000_000, capMicrousd: gate.config.capMicrousd };
  }
  // Remembered for the runner: an attempt that asked past its limit is a fail, whatever it built.
  try { const fd = openSync(join(gate.dir, OVER), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600); closeSync(fd); } catch { /* the slots alone still hold the limit */ }
  return { active: true, ok: false, why: `this eval case's limit of ${gate.config.max} provider dispatches is reached (eval-dispatch-limit)` };
}

/** Whether this process is in an eval world (any gate named, readable or not): the uncapped helpers refuse there. */
export function inEvalWorld(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return evalWorldGate(env) !== null;
}

/** What a direct-API lead turn may reserve in an eval world: the cap times the slots still free. Null outside one; 0
 * when the gate can't be read. */
export function evalLeadAllowanceMicrousd(env: Readonly<Record<string, string | undefined>> = process.env): number | null {
  const gate = evalWorldGate(env);
  if (gate === null) return null;
  if ("problem" in gate) return 0;
  const used = evalGateSlots(gate.dir)?.length ?? gate.config.max;
  return Math.max(0, gate.config.max - used) * gate.config.capMicrousd;
}

/** Whether a dispatch in this world asked past its limit (and was refused). */
export function evalGateOverLimit(dir: string): boolean {
  try { return lstatSync(join(dir, OVER)).isFile(); } catch { return false; }
}

/** The slots a world's dispatches took, read back by the runner (never following a link). Null when the folder can't
 * be read whole: the runner then settles every dispatch the world's database shows at its full cap. */
export function evalGateSlots(dir: string): EvalGateSlot[] | null {
  let names: string[];
  try { names = readdirSync(join(dir, SLOTS)); } catch { return null; }
  const slots: EvalGateSlot[] = [];
  for (const name of names) {
    const match = /^([1-9][0-9]{0,2})\.json$/.exec(name);
    if (match === null) return null;
    const bytes = readNoFollow(join(dir, SLOTS, name), MAX_GATE_BYTES);
    if (bytes === null) return null;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; } catch { return null; }
    slots.push({ n: Number(match[1]), kind: typeof parsed["kind"] === "string" ? parsed["kind"] : "unknown", pid: Number(parsed["pid"]) || 0, at: typeof parsed["at"] === "string" ? parsed["at"] : "" });
  }
  return slots.sort((a, b) => a.n - b.n);
}
