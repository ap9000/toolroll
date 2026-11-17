/**
 * "Ask the agent to restyle my workbench": the person's own lead reads and changes the terminal workbench's look
 * (tui.toml) through two tools, toolroll_view_read and toolroll_view_set, and `toolroll view theme set` / `toolroll
 * view reset` undo it from the CLI. Data only: a theme is a built-in base and role colours, never code.
 *
 * One safety story, the Rust side's: every read and write goes through the workbench binary's own `view` command
 * (tui/crates/toolroll-tui/src/view_cli.rs), which uses the Settings screen's writer (every folder up to the root
 * trusted, the file opened and replaced relative to its folder with openat/renameat, never through a link, 0600,
 * comments and unknown keys kept) and reads the result back with the screen's own strict reader. Node has no openat, so
 * a second writer here could not keep the same promise; one writer is one story to test.
 *
 * The binary is the one the screen itself runs: chosen and checked by tui-launch.ts (where it lives, who owns it, its
 * contract), and run only while it is still that file, as a program and arguments with a bounded wait and output.
 * `[keys]` is never changed this way (view_cli.rs refuses it): a remapped key could make an accept or a cancel a
 * one-key accident.
 */
import { execFileSync } from "node:child_process";
import { chooseTuiBinary, identityOf, type BinaryIdentity } from "./tui-launch.js";
import { engineContractDigest } from "./contracts/engine-api.js";

export type ViewVerb = "read" | "set" | "reset";
/** `unsure`: the workbench didn't answer (a timeout, a crash, words that aren't its JSON), so a change may or may not
 * have been written; the lead records it as uncertain, never as failed. */
export type ViewAnswer = { ok: true; body: Record<string, unknown> } | { ok: false; why: string; unsure?: true };
/** Runs `toolroll-tui view <verb>` (a change on standard input for set). Tests pass their own. */
export type ViewRunner = (verb: ViewVerb, input?: string) => ViewAnswer;

/** At most this long for an answer, and this much of it. */
const VIEW_TIMEOUT_MS = 5_000;
const VIEW_MAX_OUTPUT = 256 * 1024;

const same = (a: BinaryIdentity | null, b: BinaryIdentity): boolean =>
  a !== null && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;

/** The environment the binary reads tui.toml's place from: the person's home and config folders only. */
function viewEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const) if (env[key] !== undefined) out[key] = env[key];
  return out;
}

/** Read one answer: the binary's JSON (its `why` on a refusal), never its raw words. */
export function viewAnswerOf(stdout: string): ViewAnswer {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.trim().split("\n").pop() ?? ""); } catch { return { ok: false, why: "the workbench answered something unreadable", unsure: true }; }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, why: "the workbench answered something unreadable", unsure: true };
  const body = parsed as Record<string, unknown>;
  if (body["ok"] === false) return { ok: false, why: typeof body["why"] === "string" ? body["why"].slice(0, 400) : "the workbench refused it" };
  return { ok: true, body };
}

/** The production runner: the checked workbench binary, run only while it is still the file that was checked. */
export function binaryViewRunner(env: NodeJS.ProcessEnv = process.env): ViewRunner {
  return (verb, input) => {
    const choice = chooseTuiBinary({ env, screenReader: false, platform: process.platform, arch: process.arch, contract: engineContractDigest() });
    if (!choice.ok) return { ok: false, why: `the terminal workbench isn't available here (${choice.why})` };
    if (!same(identityOf(choice.binary), choice.identity)) return { ok: false, why: "the terminal workbench changed while it was being checked" };
    try {
      const stdout = execFileSync(choice.binary, ["view", verb], {
        input: input ?? "", encoding: "utf8", timeout: VIEW_TIMEOUT_MS, maxBuffer: VIEW_MAX_OUTPUT, env: viewEnv(env), stdio: ["pipe", "pipe", "ignore"],
      });
      return viewAnswerOf(stdout);
    } catch (error) {
      // A refusal exits 1 with its JSON on standard output.
      const out = (error as { stdout?: unknown }).stdout;
      if (typeof out === "string" && out.trim() !== "") return viewAnswerOf(out);
      return { ok: false, why: "the terminal workbench didn't answer", unsure: true };
    }
  };
}

/** A saved theme's name, as the workbench accepts it (view_cli.rs / settings.rs theme_name_ok): cleaned before it goes. */
export const THEME_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** The built-in themes. */
export const BUILT_IN_THEMES = ["terminal", "light", "dark", "high-contrast"] as const;

/** How many changes the person's lead may make in a minute. */
export const VIEW_CHANGES_PER_MINUTE = 10;
/** The ledger's word for a change made this way (action-ledger.ts recordActionWhole). Each change is two entries:
 * "pending", written before the workbench is touched, holding the whole change; then "done" or "failed" when the
 * workbench answered, or "uncertain" when it never did (a timeout, a crash; it may or may not have applied), naming
 * the pending one. Pending, done and uncertain all count toward the limit. */
export const VIEW_LEDGER_ACTION = "workbench look changed";
export type ViewOutcome = "pending" | "done" | "failed" | "uncertain";

/**
 * `toolroll view [show]`, `toolroll view theme set <name>`, `toolroll view reset`: the CLI's own way to the same
 * changes (the undo for the lead's toolroll_view_set). It runs as the person at their terminal; the same workbench
 * writer and checks apply.
 */
export async function runViewCommand(argv: readonly string[], write: (line: string) => void, runner: ViewRunner = binaryViewRunner()): Promise<number> {
  const [verb, ...rest] = argv;
  const say = (answer: ViewAnswer, words: (body: Record<string, unknown>) => string): number => {
    if (!answer.ok) { write(`toolroll view: ${answer.why}`); return 1; }
    write(words(answer.body));
    return 0;
  };
  if (verb === undefined || verb === "show") {
    return say(runner("read"), body => {
      const settings = (body["settings"] ?? {}) as Record<string, unknown>;
      const saved = ((body["themes"] as Record<string, unknown> | undefined)?.["saved"] ?? []) as { name?: unknown }[];
      return [`theme: ${String(settings["theme"] ?? "terminal")}`, `density: ${String(settings["density"] ?? "compact")}`,
        `saved themes: ${saved.length === 0 ? "none" : saved.map(one => String(one.name)).join(", ")}`].join("\n");
    });
  }
  if (verb === "theme" && rest[0] === "set" && rest.length === 2) {
    const name = rest[1]!;
    if (!(BUILT_IN_THEMES as readonly string[]).includes(name) && !THEME_NAME.test(name)) {
      write("toolroll view: a theme is terminal, light, dark, high-contrast or a saved theme's name (lowercase letters, digits and dashes)");
      return 2;
    }
    return say(runner("set", JSON.stringify({ theme: name })), body => {
      const changed = Array.isArray(body["changed"]) ? body["changed"].map(String) : [];
      return changed.length === 0 ? `Theme: ${name}.` : changed.join("\n");
    });
  }
  if (verb === "reset" && rest.length === 0) return say(runner("reset"), body => String(body["said"] ?? "Your workbench settings are back to the defaults."));
  write("usage: toolroll view [show] | toolroll view theme set <name> | toolroll view reset");
  return 2;
}

/**
 * Who may restyle this computer's workbench through the lead: a browser session (never a token or an API client), from
 * this computer (loopback, no proxy), signed in as this computer's local owner, or as the one person of a
 * single-person install. Never another person on a team install, a remote session, a shared team chat or a task's
 * agents (those never reach the person's own conversation).
 */
export function viewAllowedFor(facts: { via: string; authority?: string; name: string; fromThisComputer: boolean; approvers: readonly string[] }): boolean {
  if (facts.via !== "cookie" || !facts.fromThisComputer) return false;
  if (facts.authority === "local-owner") return true;
  return facts.approvers.length === 1 && facts.approvers[0] === facts.name;
}
