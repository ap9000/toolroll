/**
 * Being seen never brings a session back (live terminals review, round 2 finding 1): a session ended elsewhere (another
 * process, the Sessions page) is dropped by its cached copy's next touch, never written back by it.
 */
import { afterEach, expect, test, vi } from "vitest";
import { openStore } from "../store.js";
import { addApprover } from "../scope.js";
import { PersistentSessions, type Session } from "./session.js";

afterEach(() => { vi.restoreAllMocks(); });

test("a touch after the saved session was ended drops it instead of saving it again", () => {
  const store = openStore(":memory:");
  const T0 = new Date("2026-10-20T10:00:00.000Z");
  if (!addApprover(store, "alex", T0).ok) throw new Error("bootstrap failed");
  const sessions = new PersistentSessions(store);
  const id = "a".repeat(64);
  const now = Date.now();
  const session: Session = { name: "alex", csrf: "c", role: "approver", generation: store.accountOf("alex")!.generation, createdAt: now, lastSeen: now, project: null, projectRevision: 0, sawBoardAt: null };
  sessions.set(id, session);
  const hash = PersistentSessions.hash(id);
  expect(store.webSession(hash)).not.toBeNull();
  // Ended elsewhere: the row is gone, this process still has the cached copy.
  store.dropWebSession(hash);
  vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
  session.lastSeen = now + 61_000;
  sessions.persist(session, true);
  expect(store.webSession(hash)).toBeNull();
  expect(sessions.holds(session)).toBe(false);
  store.close();
});

test("a touch of a kept session still saves it", () => {
  const store = openStore(":memory:");
  if (!addApprover(store, "alex", new Date()).ok) throw new Error("bootstrap failed");
  const sessions = new PersistentSessions(store);
  const id = "b".repeat(64);
  const now = Date.now();
  const session: Session = { name: "alex", csrf: "c", role: "approver", generation: store.accountOf("alex")!.generation, createdAt: now, lastSeen: now, project: null, projectRevision: 0, sawBoardAt: null };
  sessions.set(id, session);
  vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
  session.lastSeen = now + 61_000;
  sessions.persist(session, true);
  expect(store.webSession(PersistentSessions.hash(id))?.lastSeen).toBe(now + 61_000);
  expect(sessions.holds(session)).toBe(true);
  store.close();
});

test("a project switch (an ordinary save) never brings back a session ended elsewhere (round 3)", () => {
  const store = openStore(":memory:");
  if (!addApprover(store, "alex", new Date()).ok) throw new Error("bootstrap failed");
  const sessions = new PersistentSessions(store);
  const id = "c".repeat(64);
  const now = Date.now();
  const session: Session = { name: "alex", csrf: "c", role: "approver", generation: store.accountOf("alex")!.generation, createdAt: now, lastSeen: now, project: null, projectRevision: 0, sawBoardAt: null };
  sessions.set(id, session);
  store.dropWebSession(PersistentSessions.hash(id));
  expect(sessions.stillSaved(id)).toBe(false);
  session.project = "/somewhere";
  sessions.persist(session);
  expect(store.webSession(PersistentSessions.hash(id))).toBeNull();
  expect(sessions.holds(session)).toBe(false);
  store.close();
});
