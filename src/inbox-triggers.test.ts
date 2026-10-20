/**
 * Inbox triggers (v89): mail arriving in the operator's mailbox starts
 * cards. The store, the trigger pass, the real mail parser and the Send
 * email step are real; the mailbox is scripted (raw messages by UID), and
 * Google's token endpoint answers from a script.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { FLOW_TEMPLATES } from "./flows.js";
import { addFlowTriggerTo, runFlowTriggers, type TriggerIo } from "./flow-triggers.js";
import { saveEmailSettings, sendEmail, sendingAccount, type Mail } from "./flow-actions.js";
import { freshText, mailboxAccess, readMail, type MailReader, type MailboxAccess } from "./mailbox.js";
import { disconnectGoogle, finishGoogleConsent, googleAccessToken, googleConsent, readGoogleMail, saveGoogleClient } from "./google-mail.js";
import { flowDefinitionOf } from "./flow-engine.js";
import { createDecisionServer } from "./serve.js";

const T0 = new Date("2026-09-25T09:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

/** A raw message as a mail server would hold it. */
function raw(mail: { from: string; subject: string; body: string; id?: string; headers?: Record<string, string> }): string {
  return [
    `From: ${mail.from}`, "To: support@shop.example", `Subject: ${mail.subject}`, "Date: Thu, 25 Sep 2026 09:05:00 +0000",
    ...(mail.id === undefined ? [] : [`Message-ID: ${mail.id}`]),
    ...Object.entries(mail.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", mail.body,
  ].join("\r\n");
}

/** A scripted mailbox: messages by UID, read through the real parser, and every sign-in it saw. */
function mailbox(validity = "7001") {
  const messages: { uid: number; source: string }[] = [];
  const seen: { access: MailboxAccess; folder: string }[] = [];
  let next = 41;
  const reader: MailReader = async (access, folder, after, limit) => {
    seen.push({ access, folder });
    const last = next - 1;
    if (after === null || after.validity !== validity) return { ok: true, at: { validity, uid: last }, mails: [], renumbered: after !== null, more: false };
    const waiting = messages.filter(one => one.uid > after.uid);
    const taken = waiting.slice(0, limit);
    return { ok: true, at: { validity, uid: taken.at(-1)?.uid ?? after.uid }, mails: await Promise.all(taken.map(one => readMail(one.uid, one.source))), renumbered: false, more: waiting.length > taken.length };
  };
  return { reader, seen, deliver: (source: string) => { messages.push({ uid: next++, source }); } };
}

let dir: string, repo: string, store: Store, password: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-inbox-")));
  repo = join(dir, "shop");
  mkdirSync(repo);
  store = openStore(join(dir, "orders.db"));
  for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "ops", T0);
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("bootstrap");
  password = alex.token;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const replies = () => store.createFlow({ repo, name: "Customer replies", definitionJson: JSON.stringify(FLOW_TEMPLATES.find(one => one.id === "email-replies")!.definition), by: "alex" }, T0);
const mailServer = (imap = true) => expect(saveEmailSettings(dir, { host: "smtp.shop.example", port: "587", secure: "", user: "support@shop.example", from: "support@shop.example", password: "app-password-1", ...(imap ? { imapHost: "imap.shop.example", imapPort: "993" } : {}) }).ok).toBe(true);

describe("an email trigger", () => {
  test("watches from now on: the first check notes where the inbox stands, then each new message is a card; machines, this account and other senders are left out", async () => {
    mailServer();
    const flow = replies();
    const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "email", sender: "example.com, @partner.example, shop.example", subject: null }, "alex", T0, dir);
    if (!made.ok) throw new Error(made.message);
    const box = mailbox();
    box.deliver(raw({ from: "Old <old@example.com>", subject: "Before the trigger", body: "Already here." }));
    const io: TriggerIo = { gh: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false, notFound: false }), fetch, dir, mail: box.reader };
    // The first look: signed in with the mail server's account, read-only, no backlog.
    expect(await runFlowTriggers(store, repo, at(1), io)).toMatchObject({ added: 0, problems: [] });
    expect(box.seen[0]).toMatchObject({ folder: "INBOX", access: { host: "imap.shop.example", port: 993, secure: true, user: "support@shop.example", password: "app-password-1" } });
    expect(store.flowTriggers(flow)[0]!.lastOutcome).toBe("Watching the inbox of support@shop.example: new email from now on becomes cards.");
    box.deliver(raw({ from: "Priya Shah <Priya@Example.com>", subject: "Refund for order 42?", id: "<m1@example.com>", headers: { References: "<m0@example.com>" },
      body: "Hi,\n\nI was charged twice for order 42.\n\nThanks,\nPriya\n-- \nPriya Shah, Example Inc.\n\nOn Wed, 24 Sep 2026, Support <support@shop.example> wrote:\n> Thanks for your order." }));
    box.deliver(raw({ from: "Priya Shah <priya@example.com>", subject: "Out of office: Refund", body: "I'm away until Monday.", headers: { "Auto-Submitted": "auto-replied" } }));
    box.deliver(raw({ from: "Support <support@shop.example>", subject: "Re: Refund for order 42?", body: "Our own reply." }));
    box.deliver(raw({ from: "Someone <someone@elsewhere.example>", subject: "Not for this flow", body: "Other sender." }));
    box.deliver(raw({ from: "Lee <lee@mail.partner.example>", subject: "", body: "Do you ship to Canada?" }));
    // Two minutes later, the next check.
    expect(await runFlowTriggers(store, repo, at(4), io)).toMatchObject({ added: 2 });
    const cards = store.flowCards(flow, true).reverse();
    expect(cards.map(card => [card.title, card.stage, card.createdBy])).toEqual([["Refund for order 42?", "write", "Email"], ["Email from Lee", "write", "Email"]]);
    // The sender, then only the new words: no signature, no quoted history.
    expect(cards[0]!.description).toBe("From: Priya Shah <priya@example.com>\n\nHi,\n\nI was charged twice for order 42.\n\nThanks,\nPriya");
    expect(cards[0]!.source).toEqual({ kind: "email", label: "Email from priya@example.com", url: null, mail: { id: "<m1@example.com>", references: ["<m0@example.com>"], subject: "Refund for order 42?", from: "priya@example.com" } });
    expect(store.flowTriggers(flow)[0]!.lastOutcome).toBe("Added 2 cards. Left out 2 items: Email from priya@example.com: an automatic reply, and others.");
    // Nothing new: nothing added, and nothing is ever read twice.
    expect(await runFlowTriggers(store, repo, at(7), io)).toMatchObject({ added: 0 });
    expect(store.flowCards(flow, true)).toHaveLength(2);
  });

  test("a reply to the sender stays in their thread; to anyone else it's a new email", async () => {
    mailServer();
    const flow = replies();
    const card = store.addFlowCard({ flow, title: "Refund for order 42?", description: "From: Priya <priya@example.com>\n\nCharged twice.", stage: "send", by: "Email", byKind: "automation",
      source: { kind: "email", label: "Email from priya@example.com", url: null, mail: { id: "<m1@example.com>", references: ["<m0@example.com>"], subject: "Refund for order 42?", from: "priya@example.com" } } }, T0);
    store.updateFlowCard(card, { outputs: { write: "Hi Priya, we've refunded it." } }, T0);
    const stage = flowDefinitionOf(store.getFlow(flow)!)!.stages.find(one => one.id === "send")!;
    const sent: Mail[] = [];
    const mail = async (_settings: unknown, message: Mail) => { sent.push(message); return { ok: true as const, id: "<r1@shop.example>" }; };
    expect(await sendEmail(stage, store.getFlowCard(card)!, { dir, mail })).toMatchObject({ state: "passed", said: "Emailed priya@example.com." });
    expect(sent[0]).toMatchObject({ to: ["priya@example.com"], subject: "Re: Refund for order 42?", inReplyTo: "<m1@example.com>", references: ["<m0@example.com>", "<m1@example.com>"] });
    await sendEmail({ ...stage, email: { to: "team@shop.example", subject: "FYI", body: "{{stage.write}}" } }, store.getFlowCard(card)!, { dir, mail });
    expect(sent[1]!.inReplyTo).toBeUndefined();
  });

  test("the words: quoted history, forwarded headers and signatures go; the new words stay", async () => {
    expect(freshText("Yes please.\r\n\r\nOn Tue, 23 Sep 2026 at 10:00, Sam <sam@example.com> wrote:\r\n> Want it?\r\n")).toBe("Yes please.");
    expect(freshText("See below.\n\nFrom: Sam <sam@example.com>\nSent: Tuesday\nSubject: Hi")).toBe("See below.");
    expect(freshText("Two lines\n\n\n\nand more\n> quoted\n-- \nSig")).toBe("Two lines\n\nand more");
    const bounce = await readMail(1, raw({ from: "MAILER-DAEMON@mx.example", subject: "Undelivered", body: "It bounced." }));
    expect(bounce.automatic).toBe(true);
    const person = await readMail(2, raw({ from: "Sam <sam@example.com>", subject: "  Hello\tthere ", body: "Hi" }));
    expect(person).toMatchObject({ automatic: false, from: "sam@example.com", fromName: "Sam", subject: "Hello there", text: "Hi", messageId: null });
  });

  test("without a mailbox set up the trigger says so and backs off; sending still works without one", async () => {
    mailServer(false);
    const flow = replies();
    const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "email" }, "alex", T0, dir);
    if (!made.ok) throw new Error(made.message);
    const pass = await runFlowTriggers(store, repo, at(1), { gh: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false, notFound: false }), fetch, dir, mail: mailbox().reader });
    expect(pass.problems[0]).toContain("Reading mail isn't set up yet. Add the IMAP address in Settings → Email.");
    expect(store.flowTriggers(flow)[0]).toMatchObject({ failures: 1, lastOutcome: "Reading mail isn't set up yet. Add the IMAP address in Settings → Email." });
    expect((await sendingAccount(dir, fetch)).ok).toBe(true);
  });
});

describe("a Google account", () => {
  const CLIENT = "123456789012-abcdefghij0123456789klmnopqrstuv.apps.googleusercontent.com";
  /** Google's token endpoint, scripted: what it was asked, and its answers in turn. */
  function google(...answers: { status: number; body: Record<string, unknown> }[]) {
    const asked: { url: string; form: URLSearchParams }[] = [];
    const fetcher = (async (url: string | URL, init?: RequestInit) => {
      asked.push({ url: String(url), form: new URLSearchParams(String(init?.body ?? "")) });
      const answer = answers.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { fetcher, asked };
  }
  const idToken = (email: string) => ["e30", Buffer.from(JSON.stringify({ email, email_verified: true })).toString("base64url"), "sig"].join(".");
  // A client secret shape, made when the test runs.
  const secret = () => ["GOCSPX", "k".repeat(28)].join("-");

  test("connect: consent with PKCE, the code becomes a saved refresh token, and mail is read and sent with XOAUTH2", async () => {
    expect(saveGoogleClient(dir, { clientId: "not-a-client", clientSecret: secret() })).toMatchObject({ ok: false });
    expect(saveGoogleClient(dir, { clientId: CLIENT, clientSecret: secret() })).toEqual({ ok: true });
    expect(statSync(join(dir, "google-mail.json")).mode & 0o777).toBe(0o600);
    const consent = googleConsent(readGoogleMail(dir)!, "http://127.0.0.1:4180/settings/google/callback", "alex", T0.getTime());
    const asked = new URL(consent.url);
    expect(asked.origin + asked.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({ client_id: CLIENT, scope: "https://mail.google.com/ openid email", access_type: "offline", prompt: "consent", code_challenge_method: "S256", state: consent.visit.state });
    const token = google(
      { status: 200, body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3599, scope: "openid https://mail.google.com/ https://www.googleapis.com/auth/userinfo.email", id_token: idToken("alex@gmail.example") } },
      { status: 200, body: { access_token: "at-2", expires_in: 3599 } },
    );
    expect(await finishGoogleConsent(dir, consent.visit, "4/code-from-google", token.fetcher)).toEqual({ ok: true, address: "alex@gmail.example" });
    expect(Object.fromEntries(token.asked[0]!.form)).toMatchObject({ grant_type: "authorization_code", code: "4/code-from-google", code_verifier: consent.visit.verifier, redirect_uri: "http://127.0.0.1:4180/settings/google/callback" });
    // Reading and sending both sign in with a fresh access token; one refresh serves both until it nears its end.
    expect(await mailboxAccess(dir, token.fetcher)).toEqual({ ok: true, address: "alex@gmail.example", access: { host: "imap.gmail.com", port: 993, secure: true, user: "alex@gmail.example", accessToken: "at-2" } });
    expect(await sendingAccount(dir, token.fetcher)).toMatchObject({ ok: true, settings: { host: "smtp.gmail.com", port: 465, secure: true, from: "alex@gmail.example", accessToken: "at-2" } });
    expect(token.asked.map(one => one.form.get("grant_type"))).toEqual(["authorization_code", "refresh_token"]);
    await disconnectGoogle(dir, token.fetcher);
    expect(token.asked.at(-1)!.url).toContain("https://oauth2.googleapis.com/revoke?token=rt-1");
    expect(readGoogleMail(dir)).toBeNull();
  });

  test("refused: no mail access ticked, and a connection Google no longer accepts", async () => {
    saveGoogleClient(dir, { clientId: CLIENT, clientSecret: secret() });
    const consent = googleConsent(readGoogleMail(dir)!, "http://127.0.0.1:4180/settings/google/callback", "alex");
    const narrow = google({ status: 200, body: { access_token: "at", refresh_token: "rt", scope: "openid email", id_token: idToken("alex@gmail.example") } });
    expect(await finishGoogleConsent(dir, consent.visit, "4/code", narrow.fetcher)).toMatchObject({ ok: false, message: expect.stringContaining("didn't allow mail access") });
    const good = google({ status: 200, body: { access_token: "at", refresh_token: "rt", scope: "https://mail.google.com/ openid email", id_token: idToken("alex@gmail.example") } });
    await finishGoogleConsent(dir, consent.visit, "4/code", good.fetcher);
    const lost = google({ status: 400, body: { error: "invalid_grant" } });
    expect(await googleAccessToken(dir, lost.fetcher, T0.getTime() + 86_400_000)).toEqual({ ok: false, permanent: true, said: "Google no longer accepts this connection. Connect the account again in Settings → Email." });
  });

  test("the console: Connect goes to Google, the return needs no session but a live state from this browser, and Settings then shows the account", async () => {
    const token = google({ status: 200, body: { access_token: "at", refresh_token: "rt", scope: "https://mail.google.com/ openid email", id_token: idToken("alex@gmail.example") } });
    const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repos: [repo], configDir: dir, googleFetch: token.fetcher, telegramTokenFile: join(dir, "telegram-token") });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("listen");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const cookie = (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: password }), redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
      const settings = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(settings)![1]!;
      type Email = { google: { connected: string | null; redirect: string | null } };
      const view = async () => ((await (await fetch(`${base}/settings?format=workspace`, { headers: { cookie } })).json()) as { view: { email: Email } }).view.email;
      // The address to register with Google is this page's own.
      expect((await view()).google).toEqual({ connected: null, clientId: "", redirect: `${base}/settings/google/callback` });
      const connect = await fetch(`${base}/settings/google`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, clientId: CLIENT, clientSecret: secret() }), redirect: "manual" });
      // A page that moves on to Google by itself: a form answered with another site's address is stopped by form-action 'self'.
      expect(connect.status).toBe(200);
      const going = await connect.text();
      expect(going).toContain("Going to Google to sign in");
      const google = new URL(/content="0;url=([^"]+)"/.exec(going)![1]!.replace(/&amp;/g, "&"));
      expect(google.origin).toBe("https://accounts.google.com");
      expect(google.searchParams.get("redirect_uri")).toBe(`${base}/settings/google/callback`);
      // The browser that started it holds the state (Lax, so it rides Google's redirect back; the session cookie is Strict and stays behind).
      const started = connect.headers.get("set-cookie")!;
      expect(started).toMatch(new RegExp(`^so-sign-in=${google.searchParams.get("state")}; Path=/settings/google/callback; Max-Age=900; HttpOnly; SameSite=Lax$`));
      const here = { cookie: started.split(";")[0]! };
      const callback = `${base}/settings/google/callback?state=${google.searchParams.get("state")}&code=4%2Fcode-from-google`;
      // Anyone else's browser (someone sent the sign-in link) is refused, and the sign-in isn't spent.
      expect(await (await fetch(callback)).text()).toContain("That Google sign-in was started in another browser.");
      expect(await (await fetch(`${base}/settings/google/callback?state=made-up-state-0000&code=4%2Fcode-from-google`, { headers: { cookie: "so-sign-in=made-up-state-0000" } })).text()).toContain("That Google sign-in expired.");
      const back = await fetch(callback, { headers: here });
      expect(await back.text()).toContain("Connected alex@gmail.example. Send email steps and Email inbox triggers use it now.");
      expect(back.headers.get("set-cookie")).toBe("so-sign-in=; Path=/settings/google/callback; Max-Age=0; HttpOnly; SameSite=Lax");
      expect(await (await fetch(callback, { headers: here })).text()).toContain("That Google sign-in expired.");
      expect((await view()).google).toMatchObject({ connected: "alex@gmail.example", clientId: CLIENT });
      expect(JSON.stringify(readGoogleMail(dir))).toContain('"refreshToken":"rt"');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
