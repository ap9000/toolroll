import { describe, expect, test } from "vitest";
import { SECRET_PATTERNS, scanForSecrets } from "./evidence.js";
import { createLiveReply, createLiveSender, LIVE_STATUS, partialDisplay, settledText, type LiveView } from "./live-reply.js";

/** One made-up value per detector family (none is a real credential), each matched by scanForSecrets. */
const SECRETS: Record<string, string[]> = {
  "private-key": ["-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN OPENSSH PRIVATE KEY-----"],
  "aws-access-key": [`AKIA${"Q7".repeat(8)}`, `ASIA${"Z3".repeat(8)}`],
  "github-token": [`ghp_${"aB3".repeat(12)}`, `github_pat_${"x9Y".repeat(8)}`],
  "slack-token": ["xoxb-1234567890-a1b2c3d4"],
  "npm-auth-token": ["_authToken=npm_a1b2c3d4", "_authToken = npm_a1b2c3d4"],
  "openai-key": [`sk-${"q1W2e3R4".repeat(4)}`, `sk-ant-${"q1W2e3R4".repeat(4)}`],
  "stripe-key": [`sk_live_${"a1B2c3D4".repeat(3)}`, `whsec_${"a1B2c3D4".repeat(3)}`],
  "google-api-key": [`AIza${"a1B2c3D4e5".repeat(3)}x_y-z`],
  "gitlab-token": [`glpat-${"a1B2c3D4e5".repeat(2)}`],
  "telegram-bot-token": [`123456789:AA${"a1B2c3D4e5F".repeat(3)}`],
  "discord-bot-token": [`N${"a1B2c3D4e5F6".repeat(2)}.Ab1-Cd.${"a1B2c3D4e5".repeat(3)}`],
  "password-in-url": ["https://deploy:hunter22@db.internal.net/x"],
};
const LEAD = "Here is the value";

describe("live partials never show a password or key", () => {
  test("every detector family has a sample, and each sample is a detected secret", () => {
    expect(Object.keys(SECRETS).sort()).toEqual(SECRET_PATTERNS.map(one => one.name).sort());
    for (const sample of Object.values(SECRETS).flat()) expect(scanForSecrets(`${LEAD} ${sample} `), sample).not.toHaveLength(0);
  });

  // Punctuation right before the value ("Key=-----BEGIN RSA ") must not let any of it through either.
  const PREFIXES = ["", "Key=", "(", "\""];
  test.each(Object.entries(SECRETS).flatMap(([family, samples]) => samples.flatMap(sample => PREFIXES.map(prefix => [family, sample, prefix] as const))))("%s split at every boundary never shows any of it (%s after %j)", (_family, sample, prefix) => {
    for (let cut = 1; cut <= sample.length; cut += 1) {
      // A cut-off value then a space is a finished word that isn't a secret; only the whole value then a space is one.
      for (const tail of cut === sample.length ? ["", " "] : [""]) {
        const raw = `${LEAD} ${prefix}${sample.slice(0, cut)}${tail}`;
        const shown = partialDisplay(raw, false);
        if (shown.kind === "shown") expect(shown.text, JSON.stringify(raw)).toBe(LEAD);
        // The whole secret, finished or not, closes the preview; it never shows.
        if (cut === sample.length && tail === " ") expect(shown.kind, raw).toBe("blocked");
      }
    }
  });

  test("around a multiline private-key header: every prefix is withheld or blocked past the header's start", () => {
    const block = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1b2c3d4\n";
    for (let cut = 1; cut <= block.length; cut += 1) {
      const shown = partialDisplay(`Key:\n${block.slice(0, cut)}`, false);
      if (shown.kind === "shown") expect(shown.text).toBe("Key:");
    }
    expect(partialDisplay(`Key:\n${block}more words `, false).kind).toBe("blocked");
    // A finished step's text is checked whole too.
    expect(partialDisplay(`Key:\n${block}`, true).kind).toBe("blocked");
  });
});

describe("settled text", () => {
  test.each([
    ["Use `npm te", "Use"],
    ["Use `npm test` now and", "Use `npm test` now"],
    ["See **bo", "See"],
    ["See **bold words** and", "See **bold words**"],
    ["Open [the docs](https://exa", "Open"],
    ["Open [the docs](https://example.com/a) then", "Open [the docs](https://example.com/a)"],
    ["Run:\n```\nnpm test\n", "Run:"],
    ["Run:\n```\nnpm test\n```\nthen", "Run:\n```\nnpm test\n```"],
    ["unfinished", ""],
    ["Two words", "Two"],
  ])("%j shows %j", (raw, settled) => {
    expect(settledText(raw)).toBe(settled);
  });

  test("partials get the final reply's presentation: foreign links by their host, ids dropped unless asked", () => {
    expect(partialDisplay("See https://example.com/a/b and run #12 now ", false)).toEqual({ kind: "shown", text: "See [example.com](https://example.com/a/b) and the run now" });
    expect(partialDisplay("Run #12 and run #13 both ", false)).toEqual({ kind: "shown", text: "The run and the run both" });
    expect(partialDisplay("Run #12 is done ", false, { asked: "what is the run id?" })).toEqual({ kind: "shown", text: "Run #12 is done" });
    expect(partialDisplay("A [label](https://evil.example.net/x) here ", false, { appOrigin: "http://127.0.0.1:4180" })).toEqual({ kind: "shown", text: "A [evil.example.net](https://evil.example.net/x) here" });
  });
});

describe("the live view", () => {
  const keysOk = (view: LiveView) => Object.keys(view).every(key => ["phase", "status", "text", "why"].includes(key));

  test("ack → status → shaped partial → final, with the status line in plain words and no view carrying anything but words", () => {
    const reply = createLiveReply({}, { queued: true });
    const views: LiveView[] = [reply.view()];
    const push = (event: Parameters<typeof reply.push>[0]) => { if (reply.push(event)) views.push(reply.view()); };
    push({ kind: "started", turn: 7 });
    push({ kind: "step", turn: 7, step: 1 });
    push({ kind: "tool", turn: 7, step: 1, id: "7:1:0", label: "Listing tasks" });
    push({ kind: "tool-result", turn: 7, step: 1, id: "7:1:0", outcome: { state: "succeeded" } });
    push({ kind: "step", turn: 7, step: 2 });
    push({ kind: "text", turn: 7, step: 2, text: "Two tasks are **rea" });
    push({ kind: "text", turn: 7, step: 2, text: "Two tasks are **ready** to check." });
    push({ kind: "text", turn: 7, step: 2, text: "Two tasks are **ready** to check.", final: true });
    reply.close("answered");
    views.push(reply.view());
    expect(views).toEqual([
      { phase: "queued" },
      { phase: "working", status: LIVE_STATUS.thinking },
      { phase: "working", status: "Listing tasks…" },
      { phase: "working", status: LIVE_STATUS.thinking },
      { phase: "writing", status: LIVE_STATUS.writing, text: "Two tasks are" },
      { phase: "writing", status: LIVE_STATUS.writing, text: "Two tasks are **ready** to" },
      { phase: "writing", status: LIVE_STATUS.writing, text: "Two tasks are **ready** to check." },
      { phase: "closed", why: "answered" },
    ]);
    expect(views.every(keysOk)).toBe(true);
    expect(reply.turn).toBe(7);
    expect(reply.tools()).toEqual([[{ id: "7:1:0", label: "Listing tasks", state: "succeeded" }], []]);
  });

  test("a repair or shorten step says so", () => {
    const reply = createLiveReply();
    reply.push({ kind: "step", turn: 1, step: 2, reason: "repair" });
    expect(reply.status()).toBe(LIVE_STATUS.repair);
    reply.push({ kind: "step", turn: 1, step: 3, reason: "shorten" });
    expect(reply.view()).toEqual({ phase: "working", status: LIVE_STATUS.shorten });
  });

  test("blocked closes and clears at once, and nothing after it shows, an answered close included", () => {
    for (const how of ["event", "text"] as const) {
      const reply = createLiveReply();
      reply.push({ kind: "step", turn: 1, step: 1 });
      reply.push({ kind: "text", turn: 1, step: 1, text: "So far so good and " });
      expect(reply.view()).toMatchObject({ phase: "writing", text: "So far so good and" });
      if (how === "event") reply.push({ kind: "blocked", turn: 1 });
      else reply.push({ kind: "text", turn: 1, step: 1, text: `So far so good and ${SECRETS["github-token"]![0]} ` });
      expect(reply.view()).toEqual({ phase: "closed", why: "blocked" });
      expect(reply.push({ kind: "text", turn: 1, step: 1, text: "Clean words later. " })).toBe(false);
      reply.close("answered");
      expect(reply.view()).toEqual({ phase: "closed", why: "blocked" });
      expect(reply.status()).toBe(LIVE_STATUS.held);
    }
  });

  test("a failed close drops the partial text", () => {
    const reply = createLiveReply();
    reply.push({ kind: "text", turn: 1, step: 1, text: "Half an answer " });
    reply.close("failed");
    expect(reply.view()).toEqual({ phase: "closed", why: "failed" });
  });
});

describe("the serialized live sender", () => {
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));

  test("one in flight, the newest waiting view wins, and generations only grow", async () => {
    const sent: [string, number][] = [];
    const gates: ReturnType<typeof deferred>[] = [];
    const sender = createLiveSender<string>({ send: (view, generation) => { sent.push([view, generation]); const gate = deferred(); gates.push(gate); return gate.promise; } });
    sender.offer("a");
    sender.offer("b");
    sender.offer("c");
    await tick();
    expect(sent).toEqual([["a", 1]]);
    gates[0]!.resolve();
    await tick(); await tick();
    expect(sent).toEqual([["a", 1], ["c", 3]]);
    expect(sender.generation).toBe(3);
    gates[1]!.resolve();
    await sender.close();
  });

  test("close drops the waiting view, waits for the one in flight, and refuses every later view", async () => {
    const sent: string[] = [];
    const gate = deferred();
    const sender = createLiveSender<string>({ send: view => { sent.push(view); return gate.promise; } });
    sender.offer("first");
    await tick();
    sender.offer("dropped");
    let closed = false;
    const closing = sender.close().then(() => { closed = true; });
    await tick();
    expect(closed).toBe(false);
    gate.resolve();
    await closing;
    sender.offer("late");
    await tick();
    expect(sent).toEqual(["first"]);
    expect(sender.closed).toBe(true);
  });

  test("a view whose standing proof settles after close never reaches the transport", async () => {
    const sent: string[] = [];
    const proof = deferred();
    const sender = createLiveSender<string>({ send: view => { sent.push(view); }, standing: async () => { await proof.promise; return true; } });
    sender.offer("late partial");
    await tick();
    const closing = sender.close();
    proof.resolve();
    await closing;
    expect(sent).toEqual([]);
  });

  test("standing refused or a failed send drops only that view", async () => {
    const sent: string[] = [];
    let allowed = false;
    const sender = createLiveSender<string>({ standing: () => allowed, send: view => { if (view === "boom") throw new Error("down"); sent.push(view); } });
    sender.offer("refused");
    await tick();
    allowed = true;
    sender.offer("boom");
    await tick();
    sender.offer("kept");
    await tick();
    await sender.close();
    expect(sent).toEqual(["kept"]);
  });

  test("spacing holds the next send back and keeps only the newest view meanwhile", async () => {
    let now = 0;
    const sent: string[] = [];
    const sender = createLiveSender<string>({ send: view => { sent.push(view); }, spacingMs: 50, now: () => now });
    sender.offer("one");
    await tick();
    sender.offer("two");
    sender.offer("three");
    await tick();
    expect(sent).toEqual(["one"]);
    now = 60;
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(sent).toEqual(["one", "three"]);
    await sender.close();
  });
});
