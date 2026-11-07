/** One-line pings (docs/plans/plain-toolroll.md P1.5): the payload rule table. Each ping is one line built from the
 * task's stored number and fixed words; it carries no title and no free text (a hostile subject or body never rides
 * it); its link is an allowed shape; a task's ping opens /n/<n>; the worker shows one "Open" action, which lands where
 * the tap does. */
import { describe, expect, test } from "vitest";
import { createContext, runInContext } from "node:vm";
import { buildPushPayload, LINK_SHAPES, PUSH_WORDS, pushLineOf } from "./push.js";
import { PWA_WORKER } from "./server/pages-assets.js";
import type { Notification } from "./store.js";

const HOSTILE = "Secret pricing change <script>alert(1)</script> https://evil.example";
function notice(over: Partial<Notification>): Notification {
  return { id: 7, recipient: null, dedupeKey: "k", kind: "other", subject: HOSTILE, body: HOSTILE, createdAt: "2026-11-05T00:00:00.000Z", pushClass: "attention",
    link: null, resolvedAt: null, scope: "task", project: "/repo", taskRef: 41, taskId: "fix-the-footer", run: 3, ...over };
}

describe("the payload rule table", () => {
  const rows: [Partial<Notification>, string][] = [
    [{ kind: "plan-ready", pushClass: "decision" }, "#41: plan ready"],
    [{ kind: "decision", pushClass: "decision", link: "/d/12" }, "#41 has a question"],
    [{ kind: "task-ask", pushClass: "attention" }, "#41 has a question"],
    [{ kind: "pull-request-ready", pushClass: "merge", link: "/t/fix-the-footer#merge" }, "#41 is ready to review"],
    [{ kind: "merge", pushClass: "merge", link: "/tasks?view=ready" }, "#41 is ready to review"],
    [{ kind: "contest", pushClass: "pick" }, "#41 is ready to review"],
    [{ kind: "build-failed", pushClass: "attention", link: "/r/3" }, "#41 needs you"],
  ];
  test.each(rows)("%o says %s, opens /n/41, and carries nothing else", (over, line) => {
    const payload = JSON.parse(buildPushPayload(notice(over), 2)) as Record<string, unknown>;
    expect(payload).toEqual({ title: "Toolroll", body: line, url: "/n/41", tag: "so-7", waiting: 2 });
  });

  test("a fact with no task keeps its class's fixed words and its own allowed link; a disallowed one falls back", () => {
    for (const pushClass of Object.keys(PUSH_WORDS) as (keyof typeof PUSH_WORDS)[]) {
      const line = pushLineOf(notice({ pushClass, taskRef: null, link: "/system" }));
      expect(line, pushClass).toEqual({ body: PUSH_WORDS[pushClass].body, url: "/system" });
      expect(LINK_SHAPES.some(shape => shape.test(pushLineOf(notice({ pushClass, taskRef: null, link: "https://evil.example/" })).url)), pushClass).toBe(true);
    }
  });

  test("every line is one line, from the number and fixed words only, and every link is an allowed shape", () => {
    for (const kind of ["plan-ready", "decision", "task-ask", "merge", "pull-request-ready", "build-failed", "anything"]) {
      for (const pushClass of ["decision", "pick", "merge", "attention", "progress"] as const) {
        for (const taskRef of [41, null]) {
          const payload = JSON.parse(buildPushPayload(notice({ kind, pushClass, taskRef }))) as { title: string; body: string; url: string };
          expect(payload.title).toBe("Toolroll");
          expect(payload.body).not.toMatch(/\n/);
          expect(payload.body).not.toContain("Secret");
          expect(payload.body).not.toContain("fix-the-footer");
          expect(payload.body).toMatch(/^(#41(: plan ready| has a question| is ready to review| needs you)|[a-zA-Z —]+)$/);
          expect(LINK_SHAPES.some(shape => shape.test(payload.url)), `${kind} ${pushClass} ${taskRef}`).toBe(true);
        }
      }
    }
  });
});

describe("the worker", () => {
  test("shows one Open action, and the action and the tap land on the same page", async () => {
    const handlers: Record<string, (event: unknown) => void> = {};
    const shown: { options: { actions?: { action: string; title: string }[]; data: { url: string } } }[] = [];
    const opened: string[] = [];
    const self = {
      addEventListener: (name: string, handler: (event: unknown) => void) => { handlers[name] = handler; },
      registration: { showNotification: (_title: string, options: never) => { shown.push({ options }); return Promise.resolve(); } },
      location: { origin: "https://toolroll.example" },
    };
    const clients = { matchAll: () => Promise.resolve([]), openWindow: (target: string) => { opened.push(target); return Promise.resolve(); } };
    runInContext(PWA_WORKER, createContext({ self, clients, URL }));
    handlers["push"]!({ data: { json: () => JSON.parse(buildPushPayload(notice({ kind: "plan-ready" }))) }, waitUntil: () => {} });
    expect(shown[0]!.options.actions).toEqual([{ action: "open", title: "Open" }]);
    for (const action of ["", "open"]) {
      let done: Promise<unknown> = Promise.resolve();
      handlers["notificationclick"]!({ action, notification: { close: () => {}, data: shown[0]!.options.data }, waitUntil: (promise: Promise<unknown>) => { done = promise; } });
      await done;
    }
    expect(opened).toEqual(["https://toolroll.example/n/41", "https://toolroll.example/n/41"]);
  });
});
