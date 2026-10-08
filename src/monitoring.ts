/**
 * Monitoring (v104): what Toolroll does, sent to the tools a company
 * already watches. One loop in `up` makes a pass every few seconds; each
 * destination is sent to by one process at a time (a lease in
 * `monitoring_status`), in ledger order, at least once: its cursor moves only
 * after a delivery lands, so a failure is retried (backing off to five
 * minutes) and nothing is skipped or reordered.
 *
 * - `webhook`: sealed ledger entries, POSTed in batches, each request signed
 *   (`x-standing-orders-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of
 *   "<t>.<body>" with the signing secret>`). Each batch carries the chain
 *   head, so the receiver keeps its own copy of the checkpoints.
 * - `folder`: the same events as JSON Lines, a file per day.
 * - `traces`: each finished run as an OpenTelemetry span (OTLP/HTTP JSON),
 *   and each completed task as the root span its runs hang under. Model,
 *   tokens, cost and timings; never a prompt, a diff or a file.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import type { SealedLedgerEntry, Store } from "./store.js";
import type { MonitoringSettings } from "./monitoring-settings.js";
import { COMPLETION_ACTION } from "./result-completion.js";

export type Sink = "webhook" | "folder" | "traces";
export const SIGNATURE_HEADER = "x-standing-orders-signature";
const BATCH = 200;
const LEASE_MS = 60_000;
const TIMEOUT_MS = 10_000;
const CHECKPOINT_EVERY_MS = 60 * 60_000;

/** An audit event: the ledger entry and its seal, as the stream sends it. */
export function auditEvent(entry: SealedLedgerEntry, instance: string): Record<string, unknown> {
  return {
    type: "standing-orders.audit", instance, id: entry.id, at: entry.at, actor: entry.actor, project: entry.repo, task: entry.taskId, run: entry.runId,
    action: entry.action, outcome: entry.outcome, source: entry.source, detail: entry.detail, seal: entry.seal,
  };
}

/** The signature a receiver recomputes: HMAC-SHA256(secret, "<t>.<body>"), hex. */
export function signature(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex")}`;
}

const backoff = (failures: number) => Math.min(5 * 60_000, 5_000 * 2 ** Math.min(failures, 10));
const hex = (text: string, length: number) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, length);
const nanos = (at: string) => `${BigInt(Date.parse(at)) * 1_000_000n}`;

export type MonitoringDeps = { fetch?: typeof fetch; now?: () => Date; holder: string; instance: string; version: string };

/** One pass over every destination that's set up. Returns what it sent, per destination. */
export async function monitoringPass(store: Store, settings: MonitoringSettings, deps: MonitoringDeps): Promise<Partial<Record<Sink, number>>> {
  const sent: Partial<Record<Sink, number>> = {};
  const heads: Delivered["head"][] = [];
  const audit = (delivered: Delivered) => { if (delivered.head !== null) heads.push(delivered.head); return delivered.count; };
  // A new destination gets the whole audit history; traces start from now.
  if (settings.webhook !== null) sent.webhook = audit(await deliver(store, "webhook", targetOf(settings.webhook.url), () => 0, deps, entries => postSigned(settings.webhook!, entries, store, deps)));
  if (settings.folder !== null) sent.folder = audit(await deliver(store, "folder", targetOf(settings.folder.path), () => 0, deps, async entries => { appendFolder(settings.folder!.path, entries, deps.instance); return entries.length; }));
  if (settings.traces !== null) sent.traces = (await deliver(store, "traces", targetOf(settings.traces.endpoint), () => store.ledgerHeadId(), deps, entries => postTraces(settings.traces!, entries, store, deps))).count;
  checkpointSent(store, heads, (deps.now ?? (() => new Date()))());
  return sent;
}

/** The furthest head the audit stream delivered, kept as an automatic checkpoint once the whole chain verifies.
 * Automatic checkpoints write no ledger entry, so recording one gives the stream nothing new to send (and checkpoint)
 * next pass. At most one an hour, so a busy stream neither floods the table nor walks the whole chain every pass. */
function checkpointSent(store: Store, heads: Delivered["head"][], now: Date): void {
  const head = heads.reduce<Delivered["head"]>((best, one) => best === null || (one !== null && one.through > best.through) ? one : best, null);
  if (head === null) return;
  const newest = store.ledgerCheckpoints(1)[0];
  if (newest !== undefined && (newest.through >= head.through || now.getTime() - Date.parse(newest.at) < CHECKPOINT_EVERY_MS)) return;
  try { store.ledgerCheckpoint("system", now, { head }); } catch { /* a busy database: the next delivery tries again */ }
}

/** What one delivery sent: its count, and the sealed head it carried (null when nothing landed). */
type Delivered = { count: number; head: { through: number; hash: string } | null };

/** A destination's name in its status row: a digest of its address (the address itself may carry a key). */
export const targetOf = (address: string) => hex(`standing-orders/monitoring/${address}`, 16);

/** Send what's due to one destination: hold it, start it over if it now points elsewhere, read after its cursor,
 * hand the batch over, and move the cursor only when it landed and nothing changed meanwhile. */
async function deliver(store: Store, sink: Sink, target: string, start: () => number, deps: MonitoringDeps, send: (entries: SealedLedgerEntry[]) => Promise<number>): Promise<Delivered> {
  const now = deps.now ?? (() => new Date());
  const at = now();
  const none = { count: 0, head: null };
  if (!store.holdMonitoring(sink, deps.holder, at, new Date(at.getTime() + LEASE_MS))) return none;
  let status = store.monitoringStatus(sink)[0];
  if (status === undefined || status.target !== target) {
    store.resetMonitoring(sink, target, start());
    status = store.monitoringStatus(sink)[0]!;
  }
  if (status.nextTryAt != null && Date.parse(status.nextTryAt) > at.getTime()) return none;
  const from = status.through;
  const entries = store.sealedAfter(from, BATCH);
  if (entries.length === 0) return none;
  const last = entries[entries.length - 1]!;
  try {
    const count = await send(entries);
    if (!store.monitoringDelivered(sink, deps.holder, target, from, last.id, count, now())) return none;
    return { count, head: last.seal === null ? null : { through: last.id, hash: last.seal.hash } };
  } catch (error) {
    store.monitoringFailed(sink, deps.holder, target, error instanceof Error ? error.message : String(error), now(), new Date(now().getTime() + backoff(status.failures + 1)));
    return none;
  }
}

async function post(url: string, body: string, headers: Record<string, string>, deps: MonitoringDeps): Promise<void> {
  const response = await (deps.fetch ?? fetch)(url, {
    method: "POST", body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "content-type": "application/json", "user-agent": `toolroll/${deps.version}`, ...headers },
  });
  await response.body?.cancel().catch(() => {});
  if (response.status < 200 || response.status > 299) throw new Error(`${new URL(url).host} answered ${response.status}`);
}

async function postSigned(webhook: NonNullable<MonitoringSettings["webhook"]>, entries: SealedLedgerEntry[], store: Store, deps: MonitoringDeps): Promise<number> {
  const last = entries[entries.length - 1]!;
  const body = JSON.stringify({ events: entries.map(one => auditEvent(one, deps.instance)), chain: { through: last.id, head: last.seal?.hash ?? null } });
  const timestamp = Math.floor((deps.now ?? (() => new Date()))().getTime() / 1000);
  await post(webhook.url, body, { [SIGNATURE_HEADER]: signature(webhook.secret, timestamp, body), "x-standing-orders-delivery": `${entries[0]!.id}-${last.id}` }, deps);
  return entries.length;
}

/** Append events to the day's file (by each entry's own day), made readable by its owner only. The folder must be
 * a real folder of this user's that nobody else can write to (a link, or a shared folder, could send the stream
 * somewhere else). */
function appendFolder(folder: string, entries: SealedLedgerEntry[], instance: string): void {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const stat = lstatSync(folder);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("the folder is a link, not a folder");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("the folder belongs to someone else");
  if ((stat.mode & 0o022) !== 0) throw new Error("others can write to the folder");
  const byDay = new Map<string, string[]>();
  for (const entry of entries) {
    const day = /^\d{4}-\d{2}-\d{2}/.test(entry.at) ? entry.at.slice(0, 10) : "undated";
    byDay.set(day, [...(byDay.get(day) ?? []), JSON.stringify(auditEvent(entry, instance))]);
  }
  for (const [day, lines] of byDay) {
    // Never through a link someone left where the day's file goes: it would append to wherever it points.
    const handle = openSync(join(folder, `standing-orders-audit-${day}.jsonl`), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try { writeSync(handle, `${lines.join("\n")}\n`); fsyncSync(handle); } finally { closeSync(handle); }
  }
}

type Attribute = { key: string; value: { stringValue: string } | { intValue: string } | { doubleValue: number } };
const money = (key: string, value: number | null) => value === null ? [] : [{ key, value: { doubleValue: value } }];
const attr = (key: string, value: string | number | null | undefined): Attribute[] =>
  value === null || value === undefined ? [] : [{ key, value: typeof value === "string" ? { stringValue: value } : Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } }];

/** Spans for the batch's finished runs and completed tasks (the rest of the ledger isn't traced; the cursor passes it). */
export function spansFor(store: Store, entries: SealedLedgerEntry[]): Record<string, unknown>[] {
  const spans: Record<string, unknown>[] = [];
  const rootOf = (taskId: string) => store.revisionAncestryStatus(taskId).chain[0] ?? taskId;
  for (const entry of entries) {
    if (entry.source !== "work") continue;
    if (entry.action === "run finished" && entry.runId !== null) {
      const run = store.getRun(entry.runId);
      const taskId = run === null ? null : store.externalIdFor(run.taskRef);
      if (run === null || taskId === null || run.finishedAt === null) continue;
      const root = rootOf(taskId);
      const ref = store.refForId(run.taskRef);
      const failed = run.outcome === "failed" || run.outcome === "refused" || run.outcome === "interrupted";
      spans.push({
        traceId: hex(`standing-orders/trace/${root}`, 32), spanId: hex(`standing-orders/run/${run.id}`, 16), parentSpanId: hex(`standing-orders/task/${root}`, 16),
        name: `${run.role} · ${run.provider}`, kind: 1, startTimeUnixNano: nanos(run.startedAt), endTimeUnixNano: nanos(run.finishedAt),
        attributes: [
          ...attr("standing_orders.task.id", taskId), ...attr("standing_orders.task.root", root), ...attr("standing_orders.project", ref?.repo == null ? null : basename(ref.repo)),
          ...attr("standing_orders.run.id", run.id), ...attr("standing_orders.run.role", run.role), ...attr("standing_orders.run.outcome", run.outcome),
          ...attr("gen_ai.system", run.provider), ...attr("gen_ai.request.model", run.model), ...attr("gen_ai.usage.input_tokens", run.tokensIn),
          ...attr("gen_ai.usage.output_tokens", run.tokensOut), ...money("standing_orders.cost_usd", run.costUsd),
        ],
        // The outcome's word only: a run's reason is free text (a path, a provider's message).
        status: failed ? { code: 2, message: run.outcome ?? "failed" } : { code: 1 },
      });
    } else if (entry.action === COMPLETION_ACTION && entry.taskId !== null) {
      const root = rootOf(entry.taskId);
      const task = store.getTask(root);
      if (task === null) continue;
      const ref = store.lookupRef(root);
      spans.push({
        traceId: hex(`standing-orders/trace/${root}`, 32), spanId: hex(`standing-orders/task/${root}`, 16),
        name: `task · ${ref?.repo == null ? "unplaced" : basename(ref.repo)}`, kind: 1, startTimeUnixNano: nanos(task.createdAt), endTimeUnixNano: nanos(entry.at),
        attributes: [...attr("standing_orders.task.id", root), ...attr("standing_orders.project", ref?.repo == null ? null : basename(ref.repo)), ...attr("standing_orders.completed_by", entry.actor)],
        status: { code: 1 },
      });
    }
  }
  return spans;
}

async function postTraces(traces: NonNullable<MonitoringSettings["traces"]>, entries: SealedLedgerEntry[], store: Store, deps: MonitoringDeps): Promise<number> {
  const spans = spansFor(store, entries);
  if (spans.length === 0) return 0;
  const body = JSON.stringify({ resourceSpans: [{
    resource: { attributes: [...attr("service.name", "toolroll"), ...attr("service.version", deps.version), ...attr("service.instance.id", deps.instance)] },
    scopeSpans: [{ scope: { name: "toolroll", version: deps.version }, spans }],
  }] });
  const url = traces.endpoint.endsWith("/v1/traces") ? traces.endpoint : `${traces.endpoint}/v1/traces`;
  await post(url, body, traces.header === null ? {} : { [traces.header.name]: traces.header.value }, deps);
  return spans.length;
}

/** This build's version, from its package.json ("unknown" when it can't be read). */
export function packageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch { return "unknown"; }
}

/** Who this process is, for the lease: host, pid and a random part (a restarted pid is a new holder). */
export function monitoringHolder(): string {
  return `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

/** The loop `up` runs: a pass every `everyMs`, settings read afresh each time (a change applies at the next pass). */
export function startMonitoring(options: { store: Store; settings: () => MonitoringSettings; instance: string; version: string; everyMs?: number; progress?: (line: string) => void }): () => void {
  const holder = monitoringHolder();
  let stopped = false, timer: NodeJS.Timeout | null = null;
  const pass = async () => {
    if (stopped) return;
    try {
      const settings = options.settings();
      if (settings.webhook !== null || settings.folder !== null || settings.traces !== null) {
        await monitoringPass(options.store, settings, { holder, instance: options.instance, version: options.version });
      }
    } catch (error) {
      options.progress?.(`monitoring: a pass failed (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!stopped) timer = setTimeout(() => void pass(), options.everyMs ?? 5_000);
  };
  timer = setTimeout(() => void pass(), 1_000);
  return () => { stopped = true; if (timer !== null) clearTimeout(timer); };
}
