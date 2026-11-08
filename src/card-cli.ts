/** `toolroll card <source>` (docs/plans/toolroll-cards.md): the card chat shows, from the same records, on the command line. */
import { CARD_SOURCES, type CardPlan, type CardSourceName } from "./card-catalog.js";
import { cardPlainText } from "./card-render.js";
import { readCardSource, type CardReader } from "./card-sources.js";
import { buildChatCard } from "./chat-card.js";
import { capabilitiesOf } from "./lead-capabilities.js";
import type { Store } from "./store.js";

const flags = [
  { name: "repo", takesValue: true, meaning: "one project; default: all of yours" },
  { name: "task", takesValue: true, meaning: "findings and handover: the task" },
  { name: "state", takesValue: true, meaning: "tasks: queued, running, done, failed or cancelled" },
  { name: "limit", takesValue: true, meaning: "how many rows, up to 20" },
  { name: "flow", takesValue: true, meaning: "flow_zones: the flow's number" },
  { name: "days", takesValue: true, meaning: "flow_zones: how far back, up to 90" },
] as const;
export const CARD_DESCRIPTOR = { invocation: "card", synopsis: `show Toolroll's own data as chat's cards do: ${CARD_SOURCES.join(", ")} (read only)`, flags };
export type CardCliContext = { store: Store; write: (line: string) => void; json: boolean; now: Date; actor: string | null; repos: readonly string[]; evidenceRoot?: string;
  /** The CLI's own envelope (operate.ts succeed/fail): one JSON document under --json, plain lines otherwise. */
  ok: (result: Record<string, unknown>, lines: () => string[]) => number;
  no: (reason: string, message: string) => number };

export function runCardCommand(positional: readonly string[], options: ReadonlyMap<string, string | true>, context: CardCliContext): number {
  const fail = (reason: string, message: string): number => context.no(reason, message);
  const source = positional[0] as CardSourceName | undefined;
  if (source === undefined || !CARD_SOURCES.includes(source)) return fail("usage", `Use card <${CARD_SOURCES.join("|")}> [--repo PATH] [--task ID] [--state S] [--limit N] [--flow N] [--days N].`);
  if (context.actor === null) return fail("unauthenticated", "Sign in first: the remembered local login drives card.");
  const { store, now } = context, actor = context.actor;
  const capabilities = (repos: readonly string[]) => capabilitiesOf(store, { repos, admitted: context.repos, actor, integrations: [], now });
  const reader: CardReader = { store, now, who: { name: actor, repos: context.repos }, ...(context.evidenceRoot === undefined ? {} : { evidenceRoot: context.evidenceRoot }),
    providers: repos => capabilities(repos).projects.flatMap(one => one.agents.map(agent => ({ project: one.repo, provider: agent.provider, model: agent.model, roles: agent.roles, state: agent.state }))),
    workers: repos => capabilities(repos).workers.map(one => ({ name: one.name, state: one.state, capacity: one.capacity, running: one.running.length })) };
  const value = (name: string): string | undefined => { const got = options.get(name); return typeof got === "string" ? got : undefined; };
  const number = (name: string): Record<string, number> => { const got = Number(value(name)); return value(name) === undefined || !Number.isSafeInteger(got) || got < 1 ? {} : { [name]: got }; };
  const props = { source, ...(value("repo") === undefined ? {} : { repo: value("repo") }), ...(value("task") === undefined ? {} : { task: value("task") }), ...(value("state") === undefined ? {} : { state: value("state") }), ...number("limit"), ...number("flow"), ...number("days") };
  const read = readCardSource(reader, source, { repo: value("repo") ?? null, ...(value("task") === undefined ? {} : { task: value("task")! }), ...(value("state") === undefined ? {} : { state: value("state")! }), ...number("limit"), ...number("flow"), ...number("days") });
  if ("problem" in read) return fail("refused", read.problem);
  const plan: CardPlan = { buttons: [], parts: [
    ...(read.facts.length === 0 ? [] : [{ type: "Fields" as const, props }]),
    { type: "Table" as const, props },
    ...(read.notes === undefined || read.notes.length === 0 ? [] : [{ type: "Notes" as const, props }]),
    ...(read.points.length === 0 ? [] : [{ type: "Chart" as const, props: { ...props, chart: "bar" } }]),
  ] };
  const built = buildChatCard(reader, plan, id => typeof id === "string" ? id : null, () => ({ ok: true }));
  if (!built.ok) return fail("refused", built.message);
  return context.ok({ card: built.card }, () => cardPlainText(built.card).split("\n"));
}
