/** Bounded, in-memory performance measurements. Never retain URLs, SQL, or identities. */
import { monitorEventLoopDelay, type ELDHistogram } from 'node:perf_hooks';
import type { BudgetLimit } from './request-budget.js';
import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders, OutgoingHttpHeader } from 'node:http';

export const TELEMETRY_WINDOW_MS = 300_000;
const SLICE_MS = 10_000;
/** monitorEventLoopDelay samples by sleeping this long, so every raw sample includes it. */
const EVENT_LOOP_RESOLUTION_MS = 20;
export const LATENCY_BUCKETS = [0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.015, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30, 60];
export const ROUTE_FAMILIES = ['cli', 'mcp', 'team', 'team-stream', 'chat', 'chat-stream', 'flows', 'flow-stream', 'tasks', 'results', 'decisions', 'sessions', 'settings', 'projects', 'assets', 'auth', 'metrics', 'health', 'console', 'other'] as const;
export type RouteFamily = typeof ROUTE_FAMILIES[number];
export type StreamFamily = 'team-stream' | 'chat-stream' | 'flow-stream' | 'other';
export const STREAM_FAMILIES: readonly StreamFamily[] = ['team-stream', 'chat-stream', 'flow-stream', 'other'];
export const QUEUE_BUCKETS = [0, 1024, 4096, 16384, 65536, 262144, 1048576];

/** Only literals from the allowlist can become labels, including for unknown or malformed paths. */
export function routeFamily(raw: string): RouteFamily {
  let path: string;
  try { path = new URL(raw, 'http://localhost').pathname; } catch { return 'other'; }
  if (path === '/api/cli') return 'cli';
  if (path === '/mcp' || path.startsWith('/mcp/')) return 'mcp';
  if (path === '/api/team/events') return 'team-stream';
  if (path === '/api/team') return 'team';
  if (path === '/chat/stream') return 'chat-stream';
  if (/^\/flows\/[^/]+\/live$/.test(path)) return 'flow-stream';
  if (path === '/metrics') return 'metrics';
  if (path === '/health') return 'health';
  const first = path.split('/')[1];
  switch (first) {
    case 'chat': case 'lead': return 'chat';
    case 'flows': case 'recipes': return 'flows';
    case 't': case 'tasks': case 'queue': return 'tasks';
    case 'r': case 'runs': case 'review': return 'results';
    case 'd': case 'i': return 'decisions';
    case 'code': case 'session': return 'sessions';
    case 'settings': case 'people': case 'spend': return 'settings';
    case 'projects': return 'projects';
    case 'assets': return 'assets';
    case 'login': case 'logout': case 'auth': return 'auth';
    case '': case 'work': case 'inbox': case 'board': case 'fleet': case 'menu': case 'done': return 'console';
    default: return 'other';
  }
}

type Counts = { bins: number[]; count: number; sum: number; max: number };
const counts = (): Counts => ({ bins: Array.from({ length: LATENCY_BUCKETS.length + 1 }, () => 0), count: 0, sum: 0, max: 0 });
export type LatencySummary = { count: number; p50Ms: number | null; p99Ms: number | null; maxMs: number | null; totalMs: number };
const summary = (value: Counts): LatencySummary => {
  const percentile = (fraction: number): number | null => {
    if (value.count === 0) return null;
    const rank = Math.ceil(value.count * fraction); let n = 0;
    for (const [i, count] of value.bins.entries()) {
      n += count;
      if (n >= rank) return Math.min(LATENCY_BUCKETS[i] ?? value.max, value.max) * 1000;
    }
    return value.max * 1000;
  };
  return { count: value.count, p50Ms: percentile(0.5), p99Ms: percentile(0.99), maxMs: value.count ? value.max * 1000 : null, totalMs: value.sum * 1000 };
};

/** Lifetime histogram plus a ring of ten-second slices. Cost and memory do not grow with traffic. */
export class TimingHistogram {
  readonly total = counts();
  private readonly slices = new Map<number, Counts>();
  constructor(private readonly clock: () => number) {}
  observe(seconds: number, weight = 1): void {
    if (!Number.isFinite(seconds) || seconds < 0 || weight <= 0) return;
    const at = Math.floor(this.clock() / SLICE_MS);
    this.prune(at);
    let slice = this.slices.get(at);
    if (!slice) { slice = counts(); this.slices.set(at, slice); }
    let bin = LATENCY_BUCKETS.findIndex(bound => seconds <= bound);
    if (bin < 0) bin = LATENCY_BUCKETS.length;
    for (const value of [this.total, slice]) {
      value.bins[bin]! += weight; value.count += weight; value.sum += seconds * weight; value.max = Math.max(value.max, seconds);
    }
  }
  private prune(at: number): void {
    for (const key of this.slices.keys()) if (key <= at - TELEMETRY_WINDOW_MS / SLICE_MS) this.slices.delete(key);
  }
  recent(): LatencySummary {
    this.prune(Math.floor(this.clock() / SLICE_MS));
    const merged = counts();
    for (const value of this.slices.values()) {
      value.bins.forEach((n, i) => { merged.bins[i]! += n; });
      merged.count += value.count; merged.sum += value.sum; merged.max = Math.max(merged.max, value.max);
    }
    return summary(merged);
  }
}

export type HealthSnapshot = {
  version: 1; windowSeconds: number; uptimeSeconds: number;
  requests: LatencySummary; routes: Partial<Record<RouteFamily, LatencySummary>>;
  eventLoop: LatencySummary; writes: { wait: LatencySummary; hold: LatencySummary; statement: LatencySummary };
  streams: { open: number; queuedBytes: number; maxQueuedBytes: number };
  budgetRefusals: number;
};

export class ServerTelemetry {
  readonly requests: TimingHistogram;
  readonly routes = new Map<RouteFamily, TimingHistogram>();
  readonly eventLoop: TimingHistogram;
  readonly writeWait: TimingHistogram;
  readonly writeHold: TimingHistogram;
  readonly writeStatement: TimingHistogram;
  readonly refusals = new Map<string, number>();
  private readonly recentRefusals = new Map<number, number>();
  private readonly streams = new Map<ServerResponse, StreamFamily>();
  private monitor: ELDHistogram | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly started: number;
  constructor(readonly clock: () => number = () => performance.now()) {
    this.started = clock();
    this.requests = new TimingHistogram(clock); this.eventLoop = new TimingHistogram(clock);
    this.writeWait = new TimingHistogram(clock); this.writeHold = new TimingHistogram(clock); this.writeStatement = new TimingHistogram(clock);
    for (const family of ROUTE_FAMILIES) this.routes.set(family, new TimingHistogram(clock));
  }
  start(): void {
    if (this.monitor) return;
    this.monitor = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS }); this.monitor.enable();
    this.timer = setInterval(() => this.sampleEventLoop(), 1000); this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.sampleEventLoop(); this.monitor?.disable(); this.monitor = undefined; this.timer = undefined;
  }
  /**
   * Native nanosecond samples, folded into bounded buckets once a second, never one retained object per tick.
   * Each raw sample includes the sampling timer's own interval, so it is subtracted: an idle loop reads near zero.
   */
  sampleEventLoop(): void {
    const h = this.monitor;
    if (!h || !h.count) return;
    const count = h.count, steps = Math.min(count, 1000);
    let previous = 0;
    for (let i = 1; i <= steps; i++) {
      const rank = Math.floor(i * count / steps);
      this.eventLoop.observe(Math.max(0, h.percentile(100 * rank / count) / 1e6 - EVENT_LOOP_RESOLUTION_MS) / 1000, rank - previous); previous = rank;
    }
    h.reset();
  }
  budgetRefused(route: 'api' | 'mcp', reason: BudgetLimit | 'unavailable'): void {
    const key = `${route}:${reason}`;
    this.refusals.set(key, (this.refusals.get(key) ?? 0) + 1);
    const at = Math.floor(this.clock() / SLICE_MS);
    this.pruneRefusals(at); this.recentRefusals.set(at, (this.recentRefusals.get(at) ?? 0) + 1);
  }
  private pruneRefusals(at: number): void {
    for (const key of this.recentRefusals.keys()) if (key <= at - TELEMETRY_WINDOW_MS / SLICE_MS) this.recentRefusals.delete(key);
  }
  observeRequest(family: RouteFamily, milliseconds: number): void {
    this.requests.observe(milliseconds / 1000); this.routes.get(family)!.observe(milliseconds / 1000);
  }
  openStream(response: ServerResponse, family: StreamFamily): void {
    this.streams.set(response, family);
    const closed = () => this.streams.delete(response);
    response.once('close', closed); response.once('finish', closed);
  }
  streamQueues(family?: StreamFamily): number[] {
    return [...this.streams].filter(([response, kind]) => !response.destroyed && !response.writableEnded && (family === undefined || family === kind)).map(([response]) => response.writableLength);
  }
  snapshot(): HealthSnapshot {
    this.sampleEventLoop(); this.pruneRefusals(Math.floor(this.clock() / SLICE_MS));
    const queues = this.streamQueues();
    return {
      version: 1, windowSeconds: TELEMETRY_WINDOW_MS / 1000, uptimeSeconds: (this.clock() - this.started) / 1000,
      requests: this.requests.recent(), routes: Object.fromEntries([...this.routes].map(([route, histogram]) => [route, histogram.recent()]).filter(([, value]) => (value as LatencySummary).count > 0)),
      eventLoop: this.eventLoop.recent(), writes: { wait: this.writeWait.recent(), hold: this.writeHold.recent(), statement: this.writeStatement.recent() },
      streams: { open: queues.length, queuedBytes: queues.reduce((sum, bytes) => sum + bytes, 0), maxQueuedBytes: queues.reduce((max, bytes) => Math.max(max, bytes), 0) },
      budgetRefusals: [...this.recentRefusals.values()].reduce((sum, n) => sum + n, 0),
    };
  }
}

/** SSE latency is time to opening headers; a live view's lifetime is not request work. */
export function instrumentRequest(telemetry: ServerTelemetry, request: IncomingMessage, response: ServerResponse): void {
  const family = routeFamily(request.url ?? '/'), started = telemetry.clock(); let recorded = false;
  const record = () => { if (!recorded) { recorded = true; telemetry.observeRequest(family, telemetry.clock() - started); } };
  const writeHead = response.writeHead;
  response.writeHead = function (this: ServerResponse, ...args: [number, (string | OutgoingHttpHeaders | OutgoingHttpHeader[])?, (OutgoingHttpHeaders | OutgoingHttpHeader[])?]) {
    const result = Reflect.apply(writeHead, this, args) as ServerResponse;
    const headers = typeof args[1] === 'object' ? args[1] : args[2];
    const contentType = this.getHeader('content-type') ?? (headers && !Array.isArray(headers) ? Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] : undefined);
    if (String(contentType).startsWith('text/event-stream') && !recorded) {
      record(); telemetry.openStream(this, STREAM_FAMILIES.includes(family as StreamFamily) ? family as StreamFamily : 'other');
    }
    return result;
  } as ServerResponse['writeHead'];
  response.once('finish', record); response.once('close', record);
}

export function healthWords(health: HealthSnapshot): string {
  const ms = (n: number | null) => n === null ? 'no samples' : `${n.toFixed(2)} ms`;
  const timing = (value: LatencySummary) => value.count ? `p50 ${ms(value.p50Ms)}, p99 ${ms(value.p99Ms)} (${value.count} samples)` : 'no samples yet';
  return [
    `Server health — last 5 minutes (up ${Math.floor(health.uptimeSeconds)} seconds; approximate percentiles)`,
    `Requests: ${timing(health.requests)}.`,
    ...Object.entries(health.routes).map(([route, value]) => `  ${route}: ${timing(value)}.`),
    `Event-loop delay: ${timing(health.eventLoop)}; 20 ms sampling interval.`,
    `SQLite write-lock waits: ${timing(health.writes.wait)}.`,
    `SQLite time holding a write transaction: ${timing(health.writes.hold)}.`,
    `SQLite standalone writes, including lock waits: ${timing(health.writes.statement)}.`,
    `Live streams: ${health.streams.open} open; ${health.streams.queuedBytes} bytes waiting to send, largest queue ${health.streams.maxQueuedBytes} bytes.`,
    `Request-budget refusals: ${health.budgetRefusals}.`,
  ].join('\n');
}
