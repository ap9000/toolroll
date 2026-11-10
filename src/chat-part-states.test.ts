/** An outgoing chat part's states: a dropped part is never brought back by new content. */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { ChatState } from "./chat-delivery-state.js";

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

test("every statement that sets a part back to pending refuses a dropped one", () => {
  const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
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
