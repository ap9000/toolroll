import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { expect, test } from "vitest";
import { interactiveClaudeKit } from "../test/interactive-claude-kit.js";
import { liveSessionWindowSchema, threadFactsSchema } from "./contracts/engine-api.js";

test("runtime and terminal facts are additive; legacy windows still parse", () => {
  const fixture = JSON.parse(readFileSync(new URL("../test/fixtures/engine-api/live-session-window-thread.json", import.meta.url), "utf8"));
  expect(liveSessionWindowSchema.parse(fixture)).toEqual(fixture);
  const legacy = structuredClone(fixture);
  delete legacy.thread.runtime; delete legacy.thread.terminal;
  expect(liveSessionWindowSchema.parse(legacy)).toEqual(legacy);
  for (const runtime of ["stream-json", "interactive"]) expect(threadFactsSchema.safeParse({ ...fixture.thread, runtime }).success).toBe(true);
  for (const change of [{ protocol: 2 }, { cols: 0 }, { generation: 0 }, { lifecycle: "ready" }, { control: "granted" }, { executable: "claude" }]) {
    expect(threadFactsSchema.safeParse({ ...fixture.thread, terminal: { ...fixture.thread.terminal, ...change } }).success).toBe(false);
  }
  // Generated schema fixture intentionally unchanged: lead regenerates ENGINE_WRITE_SCHEMAS=1, then reviews digest.
});

test("keys, slash commands, fake permission, resize, Unicode, long output and controlled exit", async () => {
  const kit = interactiveClaudeKit();
  try {
    await kit.wait(e => e.event === "ready");
    expect(kit.text()).toContain("\x1b[?1049h");
    kit.input.write(Buffer.from([0xe6])); kit.input.write(Buffer.from([0x97, 0xa5]));
    await kit.wait(e => e.event === "key" && e.key === "日");
    kit.input.write("\x7f\x1b["); kit.input.write("A/status\r");
    await kit.wait(e => e.event === "command" && e.text === "/status");
    expect(kit.text()).toContain("Synthetic session ready");
    kit.input.write("/permission\r"); await kit.wait(e => e.event === "permission");
    kit.input.write("y"); await kit.wait(e => e.event === "permission-answer" && e.allowed === true);
    kit.control({ id: "size", op: "resize", cols: 40, rows: 12 });
    await kit.wait(e => e.event === "control" && e.id === "size");
    expect(kit.text()).toContain("40×12");
    kit.input.write("/long 300\r"); await kit.wait(e => e.event === "long" && e.count === 300);
    expect(kit.text()).toContain("Synthetic line 300: 日本語 😀");
    kit.input.write("/attacks\r"); await kit.wait(e => e.event === "command" && e.text === "/attacks");
    expect(kit.text()).toContain("CLIPSECRET"); // Deliberately raw: the fixture exercises the production filter later.
    kit.control({ id: "barrier", op: "barrier" }); await kit.wait(e => e.event === "control" && e.id === "barrier");
    kit.input.write("/exit 7\r"); expect(await kit.done).toBe(7);
    expect(kit.text()).toContain("\x1b[?1049l");
    expect(kit.events.map(e => e.seq)).toEqual(kit.events.map((_, i) => i + 1));
  } finally { kit.input.destroy(); kit.controls.destroy(); await kit.done.catch(() => {}); }
});

test("output backpressure delays ready without dropping queued input", async () => {
  let release: (() => void) | undefined;
  let first = true;
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) {
    if (first) { first = false; release = callback; } else callback();
  } });
  const kit = interactiveClaudeKit(output);
  try {
    expect(kit.events).toHaveLength(0);
    expect(kit.input.write("/status\r")).toBe(false);
    expect(kit.input.writableLength).toBeGreaterThan(0);
    expect(release).toBeDefined(); const resume = release!; release = undefined; resume();
    await kit.wait(e => e.event === "command" && e.text === "/status");
    kit.control({ op: "exit", code: 0 }); expect(await kit.done).toBe(0);
  } finally { release?.(); kit.input.destroy(); kit.controls.destroy(); await kit.done.catch(() => {}); }
});

test("invalid controls fail closed and Ctrl-C exits without a model", async () => {
  const bad = interactiveClaudeKit();
  await bad.wait(e => e.event === "ready");
  bad.control({ op: "resize", cols: -1, rows: 24 });
  await expect(bad.done).rejects.toThrow("dimensions");
  const interrupted = interactiveClaudeKit();
  await interrupted.wait(e => e.event === "ready");
  interrupted.input.write("\x03");
  expect(await interrupted.done).toBe(130);
});
