import { test, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { superviseController, type ControllerState } from "./controller-supervisor.js";

test("clean exit and actual SIGKILL each restart one controller; explicit stop has no successor", async () => {
  const root = mkdtempSync(join(tmpdir(), "so-controller-supervisor-"));
  const fixture = join(root, "worker.cjs");
  writeFileSync(fixture, `
    const fs = require('node:fs');
    const file = process.argv[2];
    let starts = []; try { starts = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    starts.push(process.pid); fs.writeFileSync(file, JSON.stringify(starts));
    if (starts.length === 1) process.exit(0);
    if (starts.length === 2) process.kill(process.pid, 'SIGKILL');
    setInterval(() => {}, 1000);
  `);
  const controller = new AbortController();
  const states: ControllerState[] = [];
  const ready = setInterval(() => { try { if (JSON.parse(readFileSync(join(root, "starts.json"), "utf8")).length === 3) controller.abort(); } catch {} }, 20);
  const safety = setTimeout(() => controller.abort(), 8_000);
  try {
    await superviseController({ file: process.execPath, argv: [fixture, join(root, "starts.json")], signal: controller.signal,
      retryMs: 20, maxRetryMs: 80, shutdownMs: 500,
      onState: state => { states.push(state); },
    });
    expect(JSON.parse(readFileSync(join(root, "starts.json"), "utf8"))).toHaveLength(3);
    expect(states.filter(state => state.phase === "backoff")).toEqual([
      expect.objectContaining({ generation: 1, exit: { code: 0, signal: null }, retryMs: 20 }),
      expect.objectContaining({ generation: 2, retryMs: 40 }),
    ]);
    const killed = states.find(state => state.phase === "backoff" && state.generation === 2)!;
    // Windows represents forced termination as a nonzero code, POSIX as a signal.
    expect(killed.exit!.signal === "SIGKILL" || killed.exit!.code !== 0).toBe(true);
    expect(states.at(-1)).toEqual({ phase: "stopped", generation: 3, controllerPid: null });
  } finally { clearInterval(ready); clearTimeout(safety); controller.abort(); rmSync(root, { recursive: true, force: true }); }
});

test("missing runtime backs off, and cancellation during backoff prevents another spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "so-controller-missing-"));
  const controller = new AbortController();
  const states: ControllerState[] = [];
  try {
    await superviseController({ file: join(root, "missing-node"), argv: [], signal: controller.signal, retryMs: 10,
      onState: state => { states.push(state); if (state.phase === "backoff") controller.abort(); },
    });
    expect(states.map(state => state.phase)).toEqual(["starting", "backoff", "stopped"]);
  } finally { controller.abort(); rmSync(root, { recursive: true, force: true }); }
});

test("cancellation at the final pre-spawn boundary starts nothing", async () => {
  const controller = new AbortController();
  const states: ControllerState[] = [];
  await superviseController({ file: process.execPath, argv: ["-e", "process.exit(78)"], signal: controller.signal,
    onState: state => { states.push(state); if (state.phase === "starting") controller.abort(); },
  });
  expect(states.map(state => state.phase)).toEqual(["starting", "stopped"]);
});

test("with ipc and a label, the caller hears the controller and its lines say whose they are", async () => {
  const controller = new AbortController();
  const heard: unknown[] = [];
  const written: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    await superviseController({
      file: process.execPath, argv: ["-e", "process.on('message', m => { console.log('got ' + m.hello); console.error('half'); process.send({ back: m.hello }, () => process.exit(0)); });"],
      signal: controller.signal, ipc: true, label: "[worker]", retryMs: 10,
      onSpawn: child => { child.on("message", message => { heard.push(message); controller.abort(); }); child.send({ hello: "there" }); },
    });
  } finally { process.stderr.write = write; controller.abort(); }
  expect(heard).toEqual([{ back: "there" }]);
  expect(written).toEqual(expect.arrayContaining(["[worker] got there\n", "[worker] half\n"]));
});
