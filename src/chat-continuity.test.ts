// @vitest-environment happy-dom
/**
 * The no-React chat page's continuity script (chat-continuity.ts) on a conversation shown before it existed (quiet page
 * visits): its first send starts the conversation, and the page moves its binding and its draft to that one only on
 * the send's own acknowledgement or receipt.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CHAT_CONTINUITY_SCRIPT } from "./chat-continuity.js";

const page = () => {
  document.body.innerHTML = `<div id="chat-thread"></div>
    <form method="post" action="/chat" class="card composer" data-chat-session="0" data-chat-task="" data-chat-user="alex" data-chat-busy="0" data-chat-version="v0">
      <textarea name="message"></textarea><input type="hidden" name="request" value="${"a".repeat(32)}"><input type="hidden" name="request-session" value="0"><button type="submit">Send</button>
    </form>
    <form method="post" action="/chat" data-prompt><input type="hidden" name="message" value="Catch me up"><button type="submit">Catch me up</button></form>
    <p id="chat-connection"></p><p id="chat-reconnect" hidden><button type="button">Reconnect</button></p><button id="chat-new-update" hidden></button>`;
  new Function(CHAT_CONTINUITY_SCRIPT)();
};
const type = (text: string) => {
  const box = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
  box.value = text;
  box.dispatchEvent(new Event("input", { bubbles: true }));
};
const settle = () => new Promise(done => setTimeout(done, 30));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => { sessionStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; });

// Each page below runs the real script, whose document and window listeners outlive its test: the race goes first.
test("a poll begun before the first send, landing while it is on its way, does not disconnect the page", async () => {
  let acknowledge!: () => void, release: (() => void) | null = null, posted = false, hold = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted = true;
      const request = new URLSearchParams(String(init.body)).get("request");
      await new Promise<void>(done => { acknowledge = done; });
      return json({ ok: true, session: 9, task: "", request }, 202);
    }
    const asked = new URL(String(input), "http://x").searchParams.get("request");
    if (hold) { hold = false; await new Promise<void>(done => { release = done; }); }
    // The server starts the conversation as the send arrives, before it answers.
    return json({ session: posted ? 9 : 0, task: "", version: "v0", pending: false, received: posted && asked !== null });
  }));
  page();
  await settle();
  hold = true;
  window.dispatchEvent(new Event("online"));
  await settle();
  type("Start it");
  document.querySelector<HTMLFormElement>(".composer")!.requestSubmit();
  await settle();
  release!();
  await settle();
  expect(document.querySelector("#chat-connection")!.textContent).not.toContain("changed or ended");
  acknowledge();
  await new Promise(done => setTimeout(done, 1_200));
  expect(document.querySelector("#chat-connection")!.textContent).not.toContain("changed or ended");
  expect(document.querySelector<HTMLElement>("#chat-reconnect")!.hidden).toBe(true);
  expect(document.querySelector<HTMLInputElement>('.composer [name="request-session"]')!.value).toBe("9");
});

test("the first send's acknowledgement moves the page, every bound form and the next draft to the conversation it started", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
    ? json({ ok: true, session: 9, task: "", request: new URLSearchParams(String(init.body)).get("request") }, 202)
    : String(input).startsWith("/chat/mate/status") ? json({ session: 9, task: "", version: "v0", pending: false, received: true }) : json({})));
  page();
  type("Start the release notes");
  document.querySelector<HTMLFormElement>(".composer")!.requestSubmit();
  await settle();
  expect(document.querySelector("#chat-connection")!.textContent).not.toContain("changed or ended");
  expect([...document.querySelectorAll<HTMLInputElement>('[name="request-session"]')].map(one => one.value)).toEqual(["9", "9"]);
  type("And the changelog");
  expect(sessionStorage.getItem("standing-orders:chat-draft:9:")).toContain("And the changelog");
  expect(sessionStorage.getItem("standing-orders:chat-draft:0:")).toBeNull();
});

test("a conversation started elsewhere is not adopted without this page's own receipt", async () => {
  // The send's answer is lost; the poll finds conversation 12, which holds no receipt of this page's request.
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
    ? Promise.reject(new Error("lost"))
    : json({ session: 12, task: "", version: "v0", pending: false, received: false })));
  page();
  type("Start it");
  document.querySelector<HTMLFormElement>(".composer")!.requestSubmit();
  await settle();
  await new Promise(done => setTimeout(done, 1_600));
  expect(document.querySelector("#chat-connection")!.textContent).toContain("changed or ended");
  expect(document.querySelector<HTMLInputElement>('.composer [name="request-session"]')!.value).toBe("0");
});

test("before any send, the read-only status keeps the page current and does not ask to reconnect", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ session: 0, task: "", version: "v0", pending: false, received: false })));
  page();
  await settle();
  expect(document.querySelector<HTMLElement>("#chat-reconnect")!.hidden).toBe(true);
});
