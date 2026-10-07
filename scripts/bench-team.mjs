#!/usr/bin/env node
/** Synthetic, loopback-only team load. Build first. Never accepts a database or server address.
 * Not a release check. All owned children are awaited and scratch data is removed before returning.
 */
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { cpus, platform, arch } from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));
const stages = { steady: { reads: 1, writes: 1 }, busy: { reads: 4, writes: 10 }, stress: { reads: 12, writes: 50 } };
function parse(argv) {
  const options = { engineers: 5, agents: 10, seconds: 15, tasks: 1000, stages: Object.keys(stages) };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, ''), raw = argv[++i];
    if (key === 'stages' && raw && raw.split(',').every(name => Object.hasOwn(stages, name))) { options.stages = raw.split(','); continue; }
    const maximum = { engineers: 100, agents: 200, seconds: 60, tasks: 10000 }[key];
    if (!maximum || !/^\d+$/.test(raw ?? '') || Number(raw) < 1 || Number(raw) > maximum) throw Error('Use --engineers 1..100 --agents 1..200 --seconds 1..60 --tasks 1..10000 --stages steady,busy,stress. No database or URL is accepted.');
    options[key] = Number(raw);
  }
  return options;
}
const rounded = value => Math.round(value * 100) / 100;
const distribution = values => {
  const sorted = values.sort((a, b) => a - b);
  const at = q => sorted.length ? rounded(sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]) : null;
  return { count: values.length, p50Ms: at(.5), p99Ms: at(.99), maxMs: at(1) };
};

async function stage(options, name, abort) {
  const evidence = join(root, 'evidence'); mkdirSync(evidence, { recursive: true });
  const scratch = realpathSync(mkdtempSync(join(evidence, '.bench-team-'))), nonce = randomBytes(24).toString('hex');
  writeFileSync(join(scratch, 'bench-owner.json'), JSON.stringify({ nonce, parent: process.pid }), { mode: 0o600 });
  const child = fork(new URL('./fixtures/bench-team-server.mjs', import.meta.url), [scratch, nonce, String(options.engineers), String(options.agents), String(options.tasks)], {
    cwd: root, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    // Do not forward provider credentials or the caller's database/configuration selectors.
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, TOOLROLL_DB: join(scratch, 'orders.db'), STANDING_ORDERS_DB: join(scratch, 'orders.db'), XDG_CONFIG_HOME: join(scratch, 'config'), TOOLROLL_NO_UPDATE_CHECK: '1', TOOLROLL_STORAGE_SWEEP: 'off', TOOLROLL_NO_TASK_CLASSIFIER: '1' },
  });
  let errors = '', stopped = false;
  child.stderr.on('data', data => { errors = (errors + data).slice(-8192); });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => { stopped = true; resolve({ code, signal }); }));
  const messages = new Map(), backlog = new Map();
  child.on('message', message => { const waiting = messages.get(message.kind); if (waiting) { messages.delete(message.kind); waiting.resolve(message); } else backlog.set(message.kind, message); });
  const receive = kind => {
    if (backlog.has(kind)) { const value = backlog.get(kind); backlog.delete(kind); return Promise.resolve(value); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { messages.delete(kind); reject(Error(`Scratch server did not send ${kind}: ${errors}`)); }, 60_000);
      const onAbort = () => { clearTimeout(timer); messages.delete(kind); reject(Error('Benchmark interrupted.')); };
      const fail = () => { clearTimeout(timer); abort.removeEventListener('abort', onAbort); messages.delete(kind); reject(Error(`Scratch server exited before ${kind}: ${errors}`)); };
      child.once('exit', fail); abort.addEventListener('abort', onAbort, { once: true });
      messages.set(kind, { resolve(value) { clearTimeout(timer); child.off('exit', fail); abort.removeEventListener('abort', onAbort); resolve(value); } });
    });
  };
  const streams = [], inFlight = new Set();
  try {
    const ready = await receive('ready'), url = ready.url, tokens = ready.tokens;
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw Error('Scratch server did not bind loopback.');
    await Promise.all(tokens.map(async token => {
      const controller = new AbortController(); streams.push(controller);
      const response = await fetch(`${url}/api/team/events?conversation=${encodeURIComponent(ready.conversation)}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.any([abort, controller.signal, AbortSignal.timeout((options.seconds + 60) * 1000)]) });
      if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('text/event-stream')) throw Error(`Live view failed (${response.status}).`);
      const reader = response.body.getReader();
      const drain = (async () => { try { while (!(await reader.read()).done) {} } catch { /* own shutdown */ } finally { reader.releaseLock(); } })();
      controller.drain = drain;
    }));
    // Warm the real remote CLI dispatcher before measured load (same route and authorization as installed CLI).
    const warm = await fetch(`${url}/api/cli`, { method: 'POST', headers: { authorization: `Bearer ${tokens[0]}`, 'content-type': 'application/json' }, body: JSON.stringify({ argv: ['task', 'list', '--limit', '40', '--json'] }), signal: AbortSignal.any([abort, AbortSignal.timeout(30_000)]) });
    const warmResult = await warm.json(); if (warm.status !== 200 || warmResult.exitCode !== 0) throw Error(`Remote CLI warmup failed: ${JSON.stringify(warmResult)}`);
    child.send({ kind: 'load', rate: stages[name].writes, seconds: options.seconds });
    await receive('writers-ready');
    const latencies = [], wireLatencies = [], statuses = {}, slots = Array.from({ length: options.engineers }, () => 0);
    const start = performance.now(), end = start + options.seconds * 1000, interval = 1000 / stages[name].reads;
    let scheduled = 0, dropped = 0, commandFailures = 0, transportFailures = 0;
    const request = async (engineer, due) => {
      const sent = performance.now();
      try {
        const answer = await fetch(`${url}/api/cli`, { method: 'POST', headers: { authorization: `Bearer ${tokens[engineer]}`, 'content-type': 'application/json' }, body: JSON.stringify({ argv: ['task', 'list', '--limit', '40', '--json'] }), signal: AbortSignal.any([abort, AbortSignal.timeout(30_000)]) });
        const body = await answer.json(); statuses[answer.status] = (statuses[answer.status] ?? 0) + 1;
        if (answer.status === 200 && body.exitCode !== 0) commandFailures++;
      } catch { transportFailures++; }
      finally { const finished = performance.now(); wireLatencies.push(finished - sent); latencies.push(finished - due); slots[engineer]--; }
    };
    // Fixed offered rate, staggered people, at most four requests in flight per person. Dropped work is reported.
    for (let tick = 0; start + tick * interval < end; tick++) {
      for (let engineer = 0; engineer < options.engineers; engineer++) {
        const due = start + tick * interval + engineer * interval / options.engineers;
        if (due >= end) break;
        if (abort.aborted) throw Error('Benchmark interrupted.');
        const wait = due - performance.now(); if (wait > 0) await delay(wait, undefined, { signal: abort });
        scheduled++;
        if (slots[engineer] >= 4) { dropped++; continue; }
        slots[engineer]++;
        const pending = request(engineer, due); inFlight.add(pending); void pending.finally(() => inFlight.delete(pending));
      }
    }
    if (performance.now() < end) await delay(end - performance.now(), undefined, { signal: abort });
    await Promise.all(inFlight);
    const writer = await receive('writers-done');
    const health = await (await fetch(`${url}/health`, { headers: { authorization: `Bearer ${tokens[0]}`, accept: 'application/json' }, signal: AbortSignal.any([abort, AbortSignal.timeout(30_000)]) })).json();
    const metrics = await (await fetch(`${url}/metrics`, { headers: { authorization: `Bearer ${tokens[0]}` }, signal: AbortSignal.any([abort, AbortSignal.timeout(30_000)]) })).text();
    const latency = distribution(latencies), wireLatency = distribution(wireLatencies);
    const symptoms = [];
    if (statuses[429]) symptoms.push('request budget refused work');
    if (commandFailures || transportFailures || Object.keys(statuses).some(code => Number(code) >= 500)) symptoms.push('requests failed');
    if (dropped) symptoms.push('client concurrency limit dropped offered work');
    if (latency.p99Ms > 250) symptoms.push('request p99 exceeded 250 ms');
    if (health.eventLoop.p99Ms > 100) symptoms.push('event-loop p99 exceeded 100 ms');
    if (health.writes.wait.p99Ms > 50 || writer.wait.p99Ms > 50) symptoms.push('write-lock p99 exceeded 50 ms');
    if (writer.failed || writer.missed) symptoms.push('progress writers failed or fell behind');
    return { name, offered: { remoteCallsPerEngineerPerSecond: stages[name].reads, progressWritesPerAgentPerSecond: stages[name].writes }, elapsedSeconds: rounded((performance.now() - start) / 1000), scheduled, dropped, statuses, commandFailures, transportFailures, latency, wireLatency, health, writer, metricsPresent: ['toolroll_http_request_duration_seconds', 'toolroll_event_loop_delay_seconds', 'toolroll_sqlite_write_wait_seconds', 'toolroll_sse_connections', 'toolroll_request_budget_refusals_total'].every(metric => metrics.includes(metric)), symptoms };
  } finally {
    for (const stream of streams) stream.abort();
    await Promise.allSettled([...streams.map(stream => stream.drain), ...inFlight]);
    if (child.connected) child.send({ kind: 'stop' });
    const kill = setTimeout(() => { if (!stopped) child.kill('SIGKILL'); }, 20_000);
    await exit; clearTimeout(kill);
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (!existsSync(join(root, 'dist', 'server-telemetry.js'))) throw Error('Build this checkout first: npm run build.');
  const controller = new AbortController();
  const interrupt = () => controller.abort(); process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const results = [];
    for (const name of options.stages) {
      process.stderr.write(`Synthetic benchmark: ${options.engineers} engineers, ${options.agents} agents, ${name} (${options.seconds}s)\n`);
      results.push(await stage(options, name, controller.signal));
    }
    console.log(JSON.stringify({ version: 1, synthetic: true, generatedAt: new Date().toISOString(), options, fixture: { tasks: Math.max(options.tasks, options.agents), runs: options.agents, sharedConversations: 1 }, machine: { node: process.version, platform: platform(), arch: arch(), cpus: cpus().length }, scratchRemoved: true, stages: results, firstDegradation: results.find(result => result.symptoms.length)?.name ?? null, limitations: [
      'Loopback HTTP against the actual server and remote CLI dispatcher; no WAN, browser rendering, provider work or installed-runtime capacity claim.',
      'Fresh scratch database per stage; seeded task/run history and synthetic check-progress upserts, with no model execution or production database access.',
      'Each engineer has a read token and one draining live view on a shared conversation. Default request budgets remain enabled; warmup consumes one request on the first token.',
      'Agents are logical writers distributed over at most four SQLite worker connections. Worker write timing is reported separately from server-process telemetry.',
      'Latency includes time from the scheduled send; four outstanding requests per engineer cap load. Drops and writer scheduling misses are explicit.',
      'Server percentiles are histogram estimates over up to five minutes, including stream setup and warmup. Client and writer percentiles use recorded timings.',
    ] }, null, 2));
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
