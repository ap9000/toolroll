// @vitest-environment happy-dom
/**
 * The queue's drag script, EXECUTED (portfolio arc slice 1b, fix 2): a
 * refused move's typed text/plain 409 lands on the dragged card as a
 * problem row — via textContent, never markup — while an HTML refusal, a
 * login bounce, or anything unexpected still navigates. serve.test.ts owns
 * the server contract; this is the client's half of it.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { queueScript } from "./serve.js";

const REGION =
  `<div id="queue-region"><div class="lanes" data-queue-revision="4">` +
  `<section class="lane queue-column" data-column="anyone">` +
  `<div class="card queue-card" data-task="t-1" data-taken="0"><p class="row"><span class="queue-handle">≡ </span>` +
  `<a href="/t/t-1">one</a></p><p class="row meta"><form><input type="hidden" name="csrf" value="deadbeef">` +
  `<input type="hidden" name="projectRevision" value="1"></form></p></div>` +
  `<div class="card queue-card" data-task="t-2" data-taken="0"><p class="row"><span class="queue-handle">≡ </span>` +
  `<a href="/t/t-2">two</a></p></div>` +
  `</section></div></div><p id="queue-region-stamp"></p>`;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

type Reply = { ok: boolean; status: number; type?: string; contentType?: string; text?: string };

const stubFetch = (reply: Reply): { url: string; init: RequestInit }[] => {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: reply.ok,
      status: reply.status,
      type: reply.type ?? "basic",
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? reply.contentType ?? null : null) },
      text: () => Promise.resolve(reply.text ?? ""),
    });
  });
  return calls;
};

/** Drag t-2 and drop it on t-1: pointerdown on the handle, pointerup over the target. */
const dropTwoOnOne = (): void => {
  const handle = document.querySelector('[data-task="t-2"] .queue-handle');
  const target = document.querySelector('[data-task="t-1"] a');
  if (handle === null || target === null) throw new Error("fixture lost its cards");
  (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => target;
  handle.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
  document.getElementById("queue-region")?.dispatchEvent(new Event("pointerup", { bubbles: true, cancelable: true }));
};

describe("queueScript, executed", () => {
  let navigated: string[];

  beforeEach(() => {
    document.body.innerHTML = REGION;
    navigated = [];
    // location.href assignments are recorded, not performed.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { get href() { return "/queue"; }, set href(v: string) { navigated.push(v); }, origin: "http://localhost", pathname: "/queue" },
    });
    // eslint-disable-next-line no-eval -- the shipped inline script, verbatim
    eval(queueScript());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("a typed text/plain 409 lands on the dragged card as text — markup inert, nothing navigates", async () => {
    const calls = stubFetch({ ok: false, status: 409, contentType: "text/plain; charset=utf-8", text: "that task is being taken right now — it keeps its claim <b>x</b>" });
    dropTwoOnOne();
    await flush();

    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("/queue/move");
    expect(String(calls[0]?.init.body)).toContain("task=t-2");
    expect(String(calls[0]?.init.body)).toContain("before=t-1");
    expect(String(calls[0]?.init.body)).toContain("queueRevision=4");
    const row = document.querySelector('[data-task="t-2"] .queue-problem');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("being taken right now");
    expect(row?.querySelector("b")).toBeNull(); // textContent, never innerHTML
    expect(document.querySelector('[data-task="t-1"] .queue-problem')).toBeNull();
    expect(navigated).toEqual([]);

    // A second refusal replaces the row rather than stacking.
    stubFetch({ ok: false, status: 409, contentType: "text/plain; charset=utf-8", text: "the queue moved underneath you — it just reloaded" });
    dropTwoOnOne();
    await flush();
    expect(document.querySelectorAll('[data-task="t-2"] .queue-problem').length).toBe(1);
    expect(document.querySelector('[data-task="t-2"] .queue-problem')?.textContent).toContain("moved underneath you");
  });

  test("an HTML 409 (the stale-project page) navigates instead of inlining", async () => {
    stubFetch({ ok: false, status: 409, contentType: "text/html; charset=utf-8", text: "<html><body>request refused</body></html>" });
    dropTwoOnOne();
    await flush();
    expect(document.querySelector(".queue-problem")).toBeNull();
    expect(navigated).toEqual(["/tasks?view=order"]);
  });

  test("a login bounce goes to the login page, never inline", async () => {
    stubFetch({ ok: false, status: 401, contentType: "text/plain; charset=utf-8", text: "authenticate first" });
    dropTwoOnOne();
    await flush();
    expect(document.querySelector(".queue-problem")).toBeNull();
    expect(navigated).toEqual(["/login"]);
  });

  test("a login redirect on the post-move refetch navigates — the login page never lands in the region", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      calls.push(url);
      return Promise.resolve(
        url === "/queue/move"
          ? { ok: true, status: 200, type: "basic", headers: { get: () => "text/plain" }, text: () => Promise.resolve("moved") }
          : { ok: false, status: 0, type: "opaqueredirect", headers: { get: () => null }, text: () => Promise.resolve("<html>login</html>") },
      );
    });
    dropTwoOnOne();
    await flush();
    expect(calls).toEqual(["/queue/move", "/tasks?view=order&fragment=1"]);
    expect(document.getElementById("queue-region")?.textContent).not.toContain("login");
    expect(document.querySelector('[data-task="t-1"]')).not.toBeNull();
    expect(navigated).toEqual(["/login"]);
  });

  test("a successful move re-fetches the fragment and swaps the region", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      calls.push(url);
      return Promise.resolve(
        url === "/queue/move"
          ? { ok: true, status: 200, type: "basic", headers: { get: () => "text/plain" }, text: () => Promise.resolve("moved") }
          : { ok: true, status: 200, type: "basic", headers: { get: () => "text/html" }, text: () => Promise.resolve(`<div class="lanes" data-queue-revision="5"><p>fresh</p></div>`) },
      );
    });
    dropTwoOnOne();
    await flush();
    expect(calls).toEqual(["/queue/move", "/tasks?view=order&fragment=1"]);
    expect(document.getElementById("queue-region")?.textContent).toContain("fresh");
    expect(navigated).toEqual([]);
  });
});
