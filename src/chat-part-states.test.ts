/** An outgoing chat part's states: a dropped part is never brought back by new content. */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { CHAT_RETRY_STEPS_MS, ChatState, chatRetryAt } from "./chat-delivery-state.js";

let dir: string, store: Store, state: ChatState;
const now = new Date("2026-11-09T12:00:00Z");
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-part-")));
  store = openStore(join(dir, "state.db"));
  state = new ChatState(store, "slack");
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** One planned part on a saved event. */
function part(event: string): number {
  state.enqueue({ id: event, installation: "installation-part", binding: null, kind: "message", channel: "D1", member: "U1", ts: "1789700000.000001", thread: "1789700000.000001", payload: { text: "hello" }, created: now.toISOString() });
  state.plan(event, [{ text: "first words" }], now);
  return Number(state.prepare("SELECT id FROM chat_part WHERE provider=:provider AND event=?").get(event)!["id"]);
}
const row = (id: number) => { const one = state.part(id)!; return { state: one.state, text: JSON.parse(one.payload).text as string }; };

test("a repaint sends a pending or sent part again with its new content", () => {
  const waiting = part("e-pending");
  expect(state.repaint(waiting, { text: "second words" })).toBe(true);
  expect(row(waiting)).toEqual({ state: "pending", text: "second words" });

  const sent = part("e-sent");
  state.partSent(sent, "1789700000.000500", now);
  expect(state.part(sent)!.state).toBe("sent");
  expect(state.repaint(sent, { text: "second words", edit: "1789700000.000500" })).toBe(true);
  expect(row(sent)).toEqual({ state: "pending", text: "second words" });
});

test("a repaint refuses a dropped part: it stays dropped, with the content it had", () => {
  const id = part("e-dropped");
  state.partSent(id, "1789700000.000500", now);
  state.dropPart(id, "Chat disconnected");
  expect(state.repaint(id, { text: "second words", edit: "1789700000.000500" })).toBe(false);
  expect(row(id)).toEqual({ state: "dropped", text: "first words" });
  // Nothing is waiting to go out.
  expect(state.nextPart("installation-part", true, now)).toBeNull();
});

test("a repaint of a part that isn't there changes nothing", () => {
  expect(state.repaint(999, { text: "words" })).toBe(false);
});

/** Every source file that is not a test. */
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return files(path);
  return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
});

test("every statement that sets a part back to pending refuses a dropped one", () => {
  const found: string[] = [], unguarded: string[] = [];
  for (const file of files(import.meta.dirname)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/UPDATE chat_part SET/g)) {
      // One statement: up to where it is run.
      const statement = source.slice(match.index, match.index + 600).split(/\.(?:run|get|all)\(/)[0]!;
      const [set, where = ""] = statement.split(/\bWHERE\b/);
      if (!/state\s*=\s*'pending'/.test(set!)) continue;
      found.push(file.slice(import.meta.dirname.length + 1));
      if (!/state\s*(?:<>|!=)\s*'dropped'/.test(where)) unguarded.push(file.slice(import.meta.dirname.length + 1));
    }
  }
  expect(unguarded).toEqual([]);
  // The door (ChatState.repaint), the four batch and card repaints, and the refused screenshot's line.
  expect(found.sort()).toEqual(["chat-delivery-state.ts", "chat-delivery.ts", "chat-delivery.ts", "chat-delivery.ts", "chat-delivery.ts", "result-shots.ts"]);
});

// ---- a dropped message is final --------------------------------------------------------------------------------------

/** One saved message that nothing has answered yet. */
function message(event: string): void {
  state.enqueue({ id: event, installation: "installation-part", binding: null, kind: "message", channel: "D1", member: "U1", ts: "1789700000.000001", thread: "1789700000.000001", payload: { text: "hello" }, created: now.toISOString() });
}
const eventState = (event: string) => String(state.prepare("SELECT state FROM chat_event WHERE provider=:provider AND id=?").get(event)!["state"]);
const partsOf = (event: string) => Number(state.prepare("SELECT COUNT(*) AS n FROM chat_part WHERE provider=:provider AND event=?").get(event)!["n"]);
const minted = () => ["chat_action", "chat_question_action", "chat_ask_action", "chat_flow_choice", "chat_flow_note", "chat_flow_action"]
  .map(table => Number(state.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE provider=:provider`).get()!["n"])).reduce((sum, n) => sum + n, 0);

test("a message dropped when its chat was disconnected is never written back to done", () => {
  message("e-late");
  state.revoke("installation-part", now);
  expect(eventState("e-late")).toBe("dropped");
  // Its handler was still working and finishes late.
  state.finish("e-late");
  expect(eventState("e-late")).toBe("dropped");
});

test("a reply planned for a dropped message is not saved: no part, no button, nothing to send", () => {
  message("e-late-reply");
  state.revoke("installation-part", now);
  expect(state.plan("e-late-reply", [{ text: "late words", question: { id: 7, choices: [{ choice: "a", label: "A" }] } } as never], now)).toBe(false);
  expect(eventState("e-late-reply")).toBe("dropped");
  expect(partsOf("e-late-reply")).toBe(0);
  expect(minted()).toBe(0);
  expect(state.nextPart("installation-part", true, now)).toBeNull();
});

test("a message its handler refused stays dropped too, and a waiting one is still planned and done", () => {
  message("e-refused");
  state.finish("e-refused", true);
  expect(state.plan("e-refused", [{ text: "words" }], now)).toBe(false);
  expect(eventState("e-refused")).toBe("dropped");

  message("e-waiting");
  expect(state.plan("e-waiting", [{ text: "words" }], now)).toBe(true);
  expect(eventState("e-waiting")).toBe("done");
  expect(partsOf("e-waiting")).toBe(1);
  // Done can still be dropped (a handler that gives the event up); dropped can't come back.
  state.finish("e-waiting", true);
  expect(eventState("e-waiting")).toBe("dropped");
});

test("every statement that writes a message done refuses a dropped one", () => {
  const found: string[] = [], unguarded: string[] = [];
  for (const file of files(import.meta.dirname)) {
    const source = readFileSync(file, "utf8"), name = file.slice(import.meta.dirname.length + 1);
    for (const match of source.matchAll(/UPDATE chat_event SET/g)) {
      const statement = source.slice(match.index, match.index + 600).split(/\.(?:run|get|all)\(/)[0]!;
      const [set, where = ""] = statement.split(/\bWHERE\b/);
      // A fixed 'done', or a state passed in (the two doors that can write it).
      if (!/\bstate\s*=\s*(?:'done'|\?)/.test(set!)) continue;
      found.push(name);
      // Telegram's door writes only from 'running' under its claim; the shared door names the dropped state.
      if (!/state\s*(?:<>|!=)\s*'dropped'/.test(where) && !/state\s*=\s*'running'/.test(where)) unguarded.push(name);
    }
  }
  expect(unguarded).toEqual([]);
  expect(found.sort()).toEqual(["chat-delivery-state.ts", "chat-messages.ts"]);
});

// ---- one retry rule --------------------------------------------------------------------------------------------------

test("a failed send waits for the app's own time or the step for its count of failures, whichever is longer", () => {
  const after = (retryMs: number, attempts: number) => new Date(chatRetryAt(now, retryMs, attempts)).getTime() - now.getTime();
  expect(CHAT_RETRY_STEPS_MS).toEqual([5000, 15000, 60000, 300000]);
  expect([0, 1, 2, 3, 4, 50].map(attempts => after(1000, attempts))).toEqual([5000, 15000, 60000, 300000, 300000, 300000]);
  expect(after(120_000, 0)).toBe(120_000);
  expect(after(120_000, 3)).toBe(300_000);
});

test("a failed send never drops a part, however many times it fails", () => {
  const id = part("e-failing");
  for (let tries = 0; tries < 30; tries++) state.partFailed(id, { problem: "not sent", until: now.toISOString(), uncertain: true });
  const one = state.part(id)!;
  expect({ state: one.state, attempts: one.attempts, uncertain: one.uncertain }).toEqual({ state: "pending", attempts: 30, uncertain: 30 });
});

test("Slack, Discord and Teams all time a retry with the one rule", () => {
  for (const name of ["slack-chat.ts", "discord-chat.ts", "teams-chat.ts"]) {
    const source = readFileSync(join(import.meta.dirname, name), "utf8");
    const failed = [...source.matchAll(/partFailed\(/g)];
    expect(failed.length, name).toBe(1);
    expect(source, name).toMatch(/chatRetryAt\(/);
    expect(source, name).not.toMatch(/15_?000,\s*60_?000/);
  }
});
