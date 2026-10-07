import { adapterPolicy } from "./server/route-policy.js";
/**
 * A person's tools on the HTTP gateway. A person signs in with their own API token (api-tokens.ts) and every tool call
 * is the exact `toolroll` command line they could type, run on the server under their principal through
 * `runOperateAs` with source "mcp": the command's own authorization, project grants and attribution apply, and its
 * `--json` envelope is the answer. Nothing here reads data directly — a coordinator handler would skip the person's
 * project grants — and nothing here approves, answers or changes people or policy: those verbs have no tool.
 *
 * tools/list follows the account's role and the token's scope; dispatch checks again, independent of the list.
 */

import { parseContract, toModelSchema } from "./contracts/contract.js";
import { PERSON_TOOL_INPUTS, PERSON_TOOL_OUTPUTS, type PersonToolInput, type PersonToolName } from "./contracts/gateway-tools.js";
import { reportToolOutput } from "./contracts/lead-tools.js";
import { callArguments, type CallOutcome, type Json } from "./mcp-core.js";
import type { Store } from "./store.js";
import type { Principal } from "./operate.js";

/** The shared remote seam (operate.ts): who runs a command on the server, and the runner itself. Type-only, so a
 * change to either breaks this build instead of drifting; the value is loaded lazily (operate.ts imports serve.ts). */
export type { Principal } from "./operate.js";
export type RunOperateAs = typeof import("./operate.js").runOperateAs;

/** A signed-in person: the principal the command runs as, and what their account may do. */
export type Person = { principal: Principal; role: "approver" | "viewer"; tokenName: string };

type PersonTool<N extends PersonToolName> = {
  description: string;
  /** Acts change something: an act token on an account that may act. */
  acts: boolean;
  argv: (args: PersonToolInput<N>) => string[];
};

const TOOLS: { [N in PersonToolName]: PersonTool<N> } = {
  status: {
    description: "Running work, queued reasons, results to review and plan windows, over the projects you may see.",
    acts: false,
    argv: () => ["status"],
  },
  list_tasks: {
    description: "A page of tasks in the projects you may see. Filter by state and repo; cursor-paginated.",
    acts: false,
    argv: args => [
      "task", "list",
      ...(args.state === undefined ? [] : ["--state", args.state]),
      ...(args.repo === undefined ? [] : ["--repo", args.repo]),
      ...(args.cursor === undefined ? [] : ["--cursor", String(args.cursor)]),
      ...(args.limit === undefined ? [] : ["--limit", String(args.limit)]),
    ],
  },
  task_show: {
    description: "One task in full. A task outside your projects answers unknown-task.",
    acts: false,
    argv: args => ["task", "show", args.ref],
  },
  task_review: {
    description: "A task's compact result packet: saved conclusion, changed files, checks, findings, screenshots, plan and next actions. Pass run for an exact finished attempt; all includes LOW findings.",
    acts: false,
    argv: args => ["task", "review", args.ref, "--brief", ...(args.run === undefined ? [] : ["--run", String(args.run)]), ...(args.all === true ? ["--all"] : [])],
  },
  review_findings: {
    description: "One run's automatic review findings.",
    acts: false,
    argv: args => ["task", "review", String(args.run)],
  },
  file_task: {
    description: "File a task into one of your projects, under your name. It waits for approval as usual; approving stays in the console or chat. Replaying the same idempotency_key returns the first answer.",
    acts: true,
    argv: args => ["task", "add", args.title, "--repo", args.repo, "--key", args.idempotency_key, ...(args.deliverable === "report" ? ["--report"] : [])],
  },
};

const NAMES = Object.keys(PERSON_TOOL_INPUTS) as PersonToolName[];

/** What this person may call: every read, and the acts only on an act token of an account that acts. */
export function personTools(person: Person): { name: PersonToolName; description: string; inputSchema: Json }[] {
  return NAMES.filter(name => mayCall(person, name)).map(name => ({ name, description: TOOLS[name].description, inputSchema: toModelSchema(PERSON_TOOL_INPUTS[name]) as Json }));
}

const mayCall = (person: Person, name: PersonToolName): boolean =>
  !TOOLS[name].acts || person.principal.scope === "act" && person.role === "approver";

/** One person tools/call: read by its schema, checked against the person, then run as the command it names. */
export async function callPersonTool(person: Person, store: Store, runAs: RunOperateAs, params: Record<string, unknown>): Promise<CallOutcome> {
  const name = typeof params["name"] === "string" ? params["name"] : "";
  if (!(NAMES as string[]).includes(name)) return { kind: "error", code: -32602, message: `no tool \`${name}\``, fatal: false };
  const tool = name as PersonToolName;
  const rawArgs = callArguments(params);
  if (rawArgs === null) return { kind: "error", code: -32602, message: "arguments must be an object", fatal: false };
  const read = parseContract<Record<string, unknown>>(PERSON_TOOL_INPUTS[tool] as never, rawArgs);
  if (!read.ok) return { kind: "error", code: -32602, message: read.issues.map(one => one.line).join("; "), fatal: false };
  if (!adapterPolicy({ caller: "bearer", capability: person.principal.scope, token: true }, TOOLS[tool].acts ? "act" : "read").ok || !mayCall(person, tool)) {
    const why = person.principal.scope === "read" ? "this token reads only — make an act token in the console to file work" : "your account can watch, not act";
    return refused(`${tool}: ${why}`);
  }
  const argv = [...(TOOLS[tool].argv as (args: Record<string, unknown>) => string[])(read.value), "--json"];
  let written = "";
  let code: number;
  try {
    code = await runAs(argv, { principal: person.principal, store, write: chunk => { written += chunk; }, source: "mcp", tool });
  } catch (error) {
    return refused(`the command failed on the server: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = written.trim();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refused(text === "" ? `the command answered nothing (exit ${code})` : text);
  }
  const ok = code === 0 && typeof body === "object" && body !== null && (body as Record<string, unknown>)["ok"] === true;
  if (ok) reportToolOutput("gateway", tool, PERSON_TOOL_OUTPUTS[tool], body);
  return { kind: "result", result: ok ? { content: [{ type: "text", text }] } : { content: [{ type: "text", text }], isError: true } };
}

const refused = (message: string): CallOutcome => ({ kind: "result", result: { content: [{ type: "text", text: message }], isError: true } });
