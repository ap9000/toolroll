/** Scripted Discord API and provider responses; no live account acceptance. */
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { openStore, type Store } from "./store.js";
import { addApprover, propose, approve } from "./scope.js";
import {
  ChatState,
  chatHash,
  type ChatContent,
} from "./chat-delivery-state.js";
import {
  DiscordError,
  discordApi,
  checkDiscordCredentials,
  saveDiscordCredentials,
  loadDiscordCredentials,
  type DiscordApi,
} from "./discord-api.js";
import {
  receiveDiscord,
  processDiscordEvent,
  deliverDiscordPart,
  planDiscordNotifications,
  discordCard,
  type DiscordChatOptions,
  planDiscordRooms,
} from "./discord-chat.js";
import { Client } from "discord.js";
import { followDiscord, discordReadyMatches } from "./discord.js";
import { knowledgeView } from "./project-knowledge.js";
import { resolveChannelMate } from "./chat-channel.js";
import { prepareSharedAction } from "./chat-actions.js";
import { verifyApproverStanding } from "./principal.js";
import { assignmentOf } from "./assignment.js";
import { TeamLeads } from "./team-leads.js";
import { ceilingDigestOf } from "./principal.js";
import { discordSettingsHtml } from "./discord-settings.js";
import { effectivePrimary, savePrimary } from "./webhooks.js";
import { createDecisionServer } from "./serve.js";
import { flowFromSteps } from "./flows.js";
import { advanceFlows } from "./flow-engine.js";
const BOT = "100000000000000001",
  MEMBER = "100000000000000002",
  CHANNEL = "100000000000000003";
const ID = {
  app: BOT,
  bot: BOT,
  workspace: "Synthetic application",
  installation: chatHash(`discord:${BOT}:${BOT}`),
};
const TOKEN = ["synthetic", "discord", "fixture", "token", "never-sent"].join(
  "-",
);
let dir: string,
  repo: string,
  store: Store,
  state: ChatState,
  now: Date,
  options: DiscordChatOptions,
  password: string,
  serial: number,
  projects: string[];
let calls: Array<{
    method: string;
    path: string;
    body: Record<string, unknown>;
    file?: { bytes: Uint8Array; name: string };
  }>,
  answers: Array<{
    text: string;
    calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
    before?: () => void;
  }>;
const snow = () => String(100000000000001000n + BigInt(++serial));
const message = (content: string, extra: Record<string, unknown> = {}) => ({
  id: snow(),
  channel_id: CHANNEL,
  author: { id: MEMBER },
  type: 0,
  content,
  ...extra,
});
const receive = (text: string, extra: Record<string, unknown> = {}) =>
  receiveDiscord(state, ID, "MESSAGE_CREATE", message(text, extra), now);
const sends = () => calls.filter((c) => c.method !== "GET");
const sentText = () => JSON.stringify(sends().at(-1)?.body.embeds ?? []);
async function drain() {
  for (let i = 0; i < 20 && (await deliverDiscordPart(options)); i++);
}
function pair() {
  const code = state.pairing(
    ID.installation,
    "alex",
    store.accountOf("alex")!.generation,
    now,
  );
  return state.pair(ID, chatHash(code), MEMBER, CHANNEL, now)!;
}
function interaction(
  token: string,
  id: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id: snow(),
    application_id: ID.app,
    type: 3,
    channel_id: CHANNEL,
    channel: { id: CHANNEL, type: 1 },
    user: { id: MEMBER },
    message: { id, channel_id: CHANNEL, author: { id: BOT } },
    data: { component_type: 2, custom_id: `so_${token}` },
    token: "interaction-credential-must-not-persist",
    ...extra,
  };
}
async function tap(
  token: string,
  id: string,
  extra: Record<string, unknown> = {},
) {
  receiveDiscord(
    state,
    ID,
    "INTERACTION_CREATE",
    interaction(token, id, extra),
    now,
  );
  await processDiscordEvent(options);
  await drain();
}
function card() {
  const row = state
    .prepare(
      "SELECT * FROM chat_part WHERE json_extract(payload,'$.proposal') IS NOT NULL ORDER BY id DESC LIMIT 1",
    )
    .get()!;
  return {
    id: Number(row.id),
    proposal: Number(JSON.parse(String(row.payload)).proposal),
    message: String(row.message),
    token: String(
      state
        .prepare(
          "SELECT token FROM chat_action WHERE part=? AND phase='confirm' AND consumed IS NULL",
        )
        .get(Number(row.id))?.token,
    ),
  };
}
function source() {
  store.createTask({ id: "sample", title: "Clear Discord progress" }, now);
  const ref = store.refFor("built-in", "sample").id;
  store.placeTask(ref, repo);
  propose(store, {
    taskId: "sample",
    goal: "Clear progress",
    touches: ["src/a.ts"],
    acceptance: [
      {
        id: "c1",
        statement: "Progress is clear",
        how: null,
        evidence: ["manual-review"],
      },
    ],
    now,
  });
  const scope = store.getScope("sample")!;
  expect(approve(store, "sample", "alex", now, scope.digest, password).ok).toBe(
    true,
  );
  const route = store.routeAuthorityFor(ref, "builder");
  if (!route?.ok) throw Error("route");
  const run = store.startRun({
    taskRef: ref,
    leaseId: "test",
    runner: "fixture",
    branch: "fixture",
    worktree: repo,
    route: route.stamp,
    now,
  });
  store.stampRun(run, { scopeDigest: scope.digest });
  store.finishRun(run, { outcome: "built", committed: true, now });
  return { ref, run };
}
test.each([
  ['{"text":42}', "text:"], ["not JSON", "payload:"], ['{"version":2,"text":"Later version"}', "version:"],
])("an unreadable saved part stops retrying and keeps its problem: %s", async (payload, path) => {
  const event = plan([{ text: "Saved reply" }]);
  state.prepare("UPDATE chat_part SET payload=? WHERE event=?").run(payload, event);
  expect(await deliverDiscordPart(options)).toBe(true);
  const row = state.prepare("SELECT payload,state,next_at,problem,attempts,uncertain FROM chat_part WHERE event=?").get(event);
  expect(row).toMatchObject({ payload, state: "dropped", next_at: null, problem: expect.stringContaining(path), attempts: 0, uncertain: 0 });
  expect(sends()).toEqual([]);
  now = new Date(now.getTime() + 60_000);
  state.lease(ID.installation, "test", now);
  expect(await deliverDiscordPart(options)).toBe(false);
  expect(state.prepare("SELECT payload,state,next_at,problem,attempts,uncertain FROM chat_part WHERE event=?").get(event)).toEqual(row);
});

function plan(parts: ChatContent[]) {
  const id = snow();
  state.enqueue({
    id,
    installation: ID.installation,
    binding: state.binding(ID.installation)!.id,
    kind: "message",
    channel: CHANNEL,
    member: MEMBER,
    ts: id,
    thread: id,
    payload: "{}",
    created: now.toISOString(),
  });
  state.plan(id, parts, now);
  return id;
}
function draft(
  payload: Record<string, unknown>,
  kind: Parameters<Store["draftMateProposal"]>[0]["kind"] = "action",
) {
  const resolved = resolveChannelMate(
    store,
    {
      approver: "alex",
      approverGeneration: store.accountOf("alex")!.generation,
    },
    projects,
    now,
  );
  if (!resolved.ok) throw Error("session");
  const opened = store.openMateTurn(
    {
      approver: "alex",
      session: resolved.session.id,
      thread: resolved.thread.id,
      credentialKey: resolved.session.credentialKey,
      reservedMicrousd: 0,
      dailyTurns: 50,
      weeklyCeilingMicrousd: 0,
      deadlineMs: 60000,
    },
    now,
  );
  if (!opened.ok) throw Error("turn");
  const started = store.startMateTurn(opened.id, now);
  if (!started.ok) throw Error("start");
  const proposal = store.draftMateProposal(
    {
      thread: resolved.thread.id,
      turn: opened.id,
      kind,
      payload,
      ceilingDigest: resolved.who.ceilingDigest,
    },
    now,
  );
  store.finalizeMateTurn(
    opened.id,
    started.generation,
    { state: "answered", settledMicrousd: 0, tokensIn: 1, tokensOut: 1 },
    now,
  );
  plan([{ text: "", proposal }]);
  return proposal;
}
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-discord-")));
  repo = join(dir, "repo");
  mkdirSync(repo);
  mkdirSync(join(dir, "evidence"));
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "README.md"), "Synthetic Discord test\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-qm",
    "seed",
  ]);
  store = openStore(join(dir, "state.db"));
  state = new ChatState(store, "discord");
  now = new Date("2026-09-18T03:00:00Z");
  serial = 0;
  calls = [];
  answers = [];
  projects = [repo];
  const account = addApprover(store, "alex", now);
  if (!account.ok) throw Error("account");
  password = account.token;
  // Every step: these journeys prove the per-step behaviour quiet chat keeps for people who choose it.
  store.setNotificationPreference("alex", { mode: "all" }, "alex", now);
  for (const phase of ["build", "plan", "review"])
    store.setPhaseConfig(
      "installation",
      phase,
      "claude",
      "sonnet",
      "test",
      now,
    );
  store.setChatConfig(
    {
      provider: "claude-subscription",
      model: "default",
      dailyTurns: 50,
      weeklyCeilingMicrousd: 0,
      priceInMicrousd: 0,
      priceOutMicrousd: 0,
    },
    "alex",
    now,
  );
  const api: DiscordApi = async (method, path, body = {}, file) => {
    calls.push({ method, path, body, ...(file ? { file } : {}) });
    if (path === `/users/${MEMBER}`) return { id: MEMBER };
    if (path === `/channels/${CHANNEL}`)
      return { id: CHANNEL, type: 1, recipients: [{ id: MEMBER }] };
    if (method === "GET") return { items: [] };
    return {
      id: method === "PATCH" ? path.split("/").at(-1) : snow(),
      channel_id: CHANNEL,
      author: { id: BOT },
      ...(file
        ? {
            attachments: [
              { id: snow(), filename: file.name, size: file.bytes.length },
            ],
          }
        : {}),
    };
  };
  options = {
    store,
    identity: ID,
    api,
    owner: "test",
    current: () => true,
    readProjects: async () => projects,
    evidenceRoot: join(dir, "evidence"),
    origin: () => "https://console.example",
    clock: () => now,
    subscriptionRunner: vi.fn(async () => {
      const answer = answers.shift();
      if (!answer) throw Error("No scripted answer");
      answer.before?.();
      return {
        ok: true,
        answer: {
          text: answer.text,
          calls: answer.calls ?? [],
          tokensIn: 10,
          tokensOut: 5,
          reportedCostMicrousd: null,
        },
      };
    }),
  };
  state.lease(ID.installation, "test", now);
  pair();
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test("pairing is one use, hashed, private and bound to the current account", async () => {
  state.revoke(ID.installation, now);
  const code = state.pairing(
    ID.installation,
    "alex",
    store.accountOf("alex")!.generation,
    now,
  );
  expect(receive(`pair ${code}`)).toBe(true);
  expect(
    JSON.stringify(state.prepare("SELECT * FROM chat_event").all()),
  ).not.toContain(code);
  await processDiscordEvent(options);
  await drain();
  expect(sentText()).toContain("Connected to Toolroll");
  expect(state.pair(ID, chatHash(code), MEMBER, CHANNEL, now)).toBeNull();
  for (const extra of [
    { guild_id: snow() },
    { author: { id: snow() } },
    { author: { id: BOT, bot: true } },
    { webhook_id: snow() },
    { message_reference: { message_id: snow(), channel_id: snow() } },
  ])
    expect(receive("private", extra)).toBe(false);
});
test("the lead's voice in Discord: a tool turn gets one 👍 on the owner's message and typing; the reply is one Markdown description with a labelled link and no title, header or internal id", async () => {
  answers.push(
    { text: "Checking.", calls: [{ id: "q1", name: "list_tasks", args: {} }] },
    { text: "## Payout\n**Ready**: see https://console.example/chat?task=payout (run #4). Ask @everyone." },
  );
  const body = message("how is the payout fix?");
  expect(receiveDiscord(state, ID, "MESSAGE_CREATE", body, now)).toBe(true);
  await processDiscordEvent(options);
  await drain();
  expect(calls.filter((c) => c.method === "PUT").map((c) => c.path)).toEqual([`/channels/${CHANNEL}/messages/${body.id}/reactions/%F0%9F%91%8D/@me`]);
  expect(calls.some((c) => c.method === "POST" && c.path === `/channels/${CHANNEL}/typing`)).toBe(true);
  const reply = sends().filter((c) => c.path === `/channels/${CHANNEL}/messages`).at(-1)!.body;
  expect(reply.embeds).toEqual([{ description: "Payout\n**Ready**: see [the task](https://console.example/chat?task=payout). Ask @\u200beveryone.", color: 0x297b70 }]);
  expect(reply.allowed_mentions).toEqual({ parse: [], replied_user: false });
  // A quick answer gets no reaction and no typing.
  const typed = calls.filter((c) => c.path.endsWith("/typing")).length;
  answers.push({ text: "All quiet." });
  receive("anything else?");
  await processDiscordEvent(options);
  await drain();
  expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  expect(calls.filter((c) => c.path.endsWith("/typing"))).toHaveLength(typed);
  // The REST wrapper admits exactly these two routes beyond messages: the 👍 and typing.
  const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
  await expect(discordApi(TOKEN, fetcher)("PUT", `/channels/${CHANNEL}/messages/${body.id}/reactions/%F0%9F%91%8D/@me`)).resolves.toEqual({});
  await expect(discordApi(TOKEN, fetcher)("POST", `/channels/${CHANNEL}/typing`)).resolves.toEqual({});
  await expect(discordApi(TOKEN, fetcher)("PUT", `/channels/${CHANNEL}/messages/${body.id}/reactions/%F0%9F%92%A9/@me`)).rejects.toThrow("Invalid Discord request");
});

test("a long reply is split as written before it is shaped: the link that straddles a part's limit arrives whole, named, in one part", async () => {
  // Over Discord's 2,000 the lead is asked once to shorten; a reply still over it is split across messages, never cut.
  const long = `${"word ".repeat(355)}**Ready** see https://console.example/chat?task=payout now. ${"more ".repeat(100)}`;
  answers.push({ text: long }, { text: long });
  receive("tell me everything");
  await processDiscordEvent(options);
  await drain();
  const descriptions = sends().filter((c) => c.path === `/channels/${CHANNEL}/messages`).map((c) => String(c.body.embeds?.[0]?.description ?? ""));
  expect(descriptions.length).toBeGreaterThan(1);
  for (const one of descriptions) {
    expect(one.length).toBeLessThanOrEqual(1800);
    expect(one.split("**").length % 2).toBe(1);
  }
  expect(descriptions.filter((one) => one.includes("[the task](https://console.example/chat?task=payout)"))).toHaveLength(1);
});

test("replayed DM creates one model turn and lost send receipt reconciles by nonce", async () => {
  const body = message("What needs my attention?");
  answers.push({ text: "One result needs review." });
  expect(receiveDiscord(state, ID, "MESSAGE_CREATE", body, now)).toBe(true);
  expect(receiveDiscord(state, ID, "MESSAGE_CREATE", body, now)).toBe(false);
  await processDiscordEvent(options);
  const base = options.api;
  let saved: Record<string, unknown> = {};
  options.api = async (m, p, b, f) => {
    const result = await base(m, p, b, f);
    if (m === "POST") {
      saved = { ...result, nonce: b?.nonce };
      throw new DiscordError("lost receipt", 5000, true);
    }
    return result;
  };
  await deliverDiscordPart(options);
  state
    .prepare("UPDATE chat_part SET payload=?")
    .run(JSON.stringify({ text: "Updated while delivery was uncertain" }));
  now = new Date(now.getTime() + 6000);
  state.lease(ID.installation, "test", now);
  options.api = async (m, p, b, f) =>
    p.endsWith("?limit=100") ? { items: [saved] } : base(m, p, b, f);
  await drain();
  expect(options.subscriptionRunner).toHaveBeenCalledTimes(1);
  expect(sends().filter((c) => c.method === "POST")).toHaveLength(1);
  expect(sends().at(-1)?.method).toBe("PATCH");
  expect(sentText()).toContain("Updated while delivery was uncertain");
  expect(state.prepare("SELECT state FROM chat_part").get()?.state).toBe(
    "sent",
  );
});
test("knowledge proposals confirm once and edit the same message with Discord audit", async () => {
  answers.push(
    {
      text: "Save the instructions.",
      calls: [
        {
          id: "change",
          name: "propose_action",
          args: {
            operation: "knowledge_instructions",
            repo: "r1",
            instructions: "Keep updates concise.",
          },
        },
      ],
    },
    { text: "Review the proposed instructions." },
  );
  receive("Save instructions");
  await processDiscordEvent(options);
  await drain();
  const c = card();
  await tap(c.token, c.message);
  expect(knowledgeView(store, repo, "alex").knowledge.instructions).toBe(
    "Keep updates concise.",
  );
  expect(store.getMateProposal(c.proposal)?.outcome).toMatchObject({
    via: "discord",
    ok: true,
  });
  expect(sends().at(-1)?.path.endsWith(c.message)).toBe(true);
  expect(sends().at(-1)?.method).toBe("PATCH");
  await tap(c.token, c.message);
  expect(knowledgeView(store, repo, "alex").revision).toBe(1);
  expect(
    JSON.stringify(state.prepare("SELECT payload FROM chat_event").all()),
  ).not.toContain("interaction-credential");
});
test.each([
  "message",
  "app",
  "group",
  "sender",
  "expiry",
  "projects",
  "revoked",
])("rejects a button after %s changes", async (fault) => {
  const { ref } = source();
  draft({ task: "sample", reason: "Inspect wording" }, "hold");
  await drain();
  const c = card();
  if (fault === "expiry") {
    now = new Date(now.getTime() + 86_400_001);
    state.lease(ID.installation, "test", now);
  }
  if (fault === "projects") projects = [];
  if (fault === "revoked") state.revoke(ID.installation, now);
  await tap(
    c.token,
    fault === "message" ? snow() : c.message,
    fault === "app"
      ? { application_id: snow() }
      : fault === "group"
        ? { channel: { type: 3 } }
        : fault === "sender"
          ? { user: { id: snow() } }
          : {},
  );
  expect(store.activeHolds(ref, now)).toHaveLength(0);
});
test("a button Toolroll didn't make is answered with why and does nothing; a stale one says so; a stranger's tap gets no answer", async () => {
  const { ref } = source();
  draft({ task: "sample", reason: "Inspect wording" }, "hold");
  await drain();
  const c = card();
  await tap(c.token, c.message, { data: { component_type: 2, custom_id: "so_not-a-token" } });
  // Discord shows markdown: the underscore is escaped so it reads as written.
  expect(JSON.parse(sentText())[0].description).toBe("That button couldn't be read (data.custom\\_id: not a Toolroll button). Nothing was done.");
  await tap("0".repeat(32), c.message);
  expect(sentText()).toContain("That button expired or was already used.");
  const sent = sends().length;
  await tap(c.token, c.message, { user: { id: snow() }, data: { custom_id: "nope" } });
  await tap(c.token, c.message, { message: { id: c.message, channel_id: CHANNEL, author: { id: snow() } }, data: { custom_id: "nope" } });
  expect(sends()).toHaveLength(sent);
  expect(store.activeHolds(ref, now)).toHaveLength(0);
  expect(store.getMateProposal(c.proposal)?.state).toBe("pending");
});
test("protected actions retain the existing exact review link even for a forged token", async () => {
  source();
  const resolved = resolveChannelMate(
    store,
    {
      approver: "alex",
      approverGeneration: store.accountOf("alex")!.generation,
    },
    projects,
    now,
  );
  if (!resolved.ok) throw Error("session");
  draft({
    ...prepareSharedAction(
      store,
      resolved.who,
      "task_cancel",
      { task: "sample" },
      options.evidenceRoot,
      now,
    ),
  });
  await drain();
  const c = card();
  expect(JSON.stringify(sends().at(-1)?.body.components)).toContain(
    `/chat/action/${c.proposal}`,
  );
  expect(JSON.stringify(sends().at(-1)?.body.components)).not.toContain(
    "custom_id",
  );
  await tap(c.token, c.message);
  expect(store.getTask("sample")?.state).not.toBe("cancelled");
});
test("irreversible answers need a second confirmation and record Discord", async () => {
  const { run } = source();
  const decision = store.saveDecision(
    {
      run,
      urgency: "blocking",
      recap: "Choose failure behavior",
      question: "Fail open?",
      options: [
        {
          id: "open",
          label: "Fail open",
          consequence: "Continue without the check",
          reversible: false,
        },
        {
          id: "closed",
          label: "Fail closed",
          consequence: "Stop this request",
          reversible: true,
        },
      ],
      recommendation: "closed",
    },
    now,
  );
  draft(
    {
      task: "sample",
      decision,
      option: "open",
      optionLabel: "Fail open",
      reversible: false,
      rationale: "Operator choice",
    },
    "answer",
  );
  await drain();
  const c = card();
  await tap(c.token, c.message);
  expect(store.getDecision(decision)?.state).toBe("open");
  expect(sentText()).toMatch(/irreversible/i);
  const yes = String(
    state
      .prepare(
        "SELECT token FROM chat_action WHERE part=? AND phase='yes' AND consumed IS NULL",
      )
      .get(c.id)?.token,
  );
  await tap(yes, c.message);
  expect(store.getDecision(decision)?.answeredVia).toBe("discord");
});
test("screenshots send verified original bytes, reject changes and retain result links", async () => {
  const { run } = source(),
    bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqRkAAAAASUVORK5CYII=",
      "base64",
    ),
    key = `${run}/screenshot.png`,
    sha256 = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(join(options.evidenceRoot, String(run)));
  writeFileSync(join(options.evidenceRoot, key), bytes);
  const artifact = store.saveArtifact(
    {
      run,
      kind: "screenshot",
      key,
      bytesOriginal: bytes.length,
      bytesStored: bytes.length,
      truncated: false,
      sha256,
      capture: "Synthetic screenshot",
    },
    now,
  );
  for (const tampered of [false, true]) {
    if (tampered) writeFileSync(join(options.evidenceRoot, key), "changed");
    plan([
      {
        text: "Screenshot 1",
        image: { taskId: "sample", run, artifact, sha256 },
      },
    ]);
    await drain();
  }
  expect(sends().filter((c) => c.file)).toHaveLength(1);
  expect(sends().find((c) => c.file)?.file?.bytes).toEqual(bytes);
  expect(sentText()).toContain("Screenshot not sent");
  expect(JSON.stringify(sends()[0]?.body.components)).toContain(
    `/chat?task=sample`,
  );
});
test("progress edits one message; switching primary excludes pending notices but keeps replies", async () => {
  const { run, ref } = source();
  await planDiscordNotifications(options);
  await drain();
  store.hold(ref, "Review the result", null, now);
  store.enqueueNotification(
    {
      source: { run },
      dedupeKey: `review:start:${run}`,
      kind: "review-started",
      subject: "Review started",
      body: "Reviewing",
    },
    now,
  );
  await planDiscordNotifications(options);
  options.canNotify = () => false;
  receive("What remains?");
  answers.push({ text: "Your ordinary reply." });
  await processDiscordEvent(options);
  await drain();
  expect(sends()).toHaveLength(2);
  options.canNotify = () => true;
  await drain();
  expect(sends().at(-1)?.method).toBe("PATCH");
  expect(state.prepare("SELECT count(*) n FROM chat_progress").get()?.n).toBe(
    1,
  );
});
test("incoming attachments are explained without a provider call; rate limits and revoked access stop sends", async () => {
  receive("Read this", { attachments: [{ id: snow() }] });
  await processDiscordEvent(options);
  await drain();
  expect(options.subscriptionRunner).not.toHaveBeenCalled();
  expect(sentText()).toContain("Incoming files");
  plan([{ text: "Saved reply" }]);
  const api = options.api;
  options.api = async (m, p, b, f) => {
    if (m === "POST") throw new DiscordError("ratelimited", 123000);
    return api(m, p, b, f);
  };
  await deliverDiscordPart(options);
  expect(
    state.prepare("SELECT retry_at FROM chat_runtime").get()?.retry_at,
  ).toBe(new Date(now.getTime() + 123000).toISOString());
  state.revoke(ID.installation, now);
  options.api = api;
  await drain();
  expect(sends()).toHaveLength(1);
});
test("credentials stay private; card text cannot ping people or hide terms in markdown", () => {
  const credentials = {
    ...ID,
    botToken: TOKEN,
    workspace: "Long <application> " + "portfolio ".repeat(20),
  };
  saveDiscordCredentials(dir, credentials);
  expect(loadDiscordCredentials(dir)).toEqual(credentials);
  if (process.platform !== "win32")
    expect(statSync(join(dir, "discord-connection.json")).mode & 0o777).toBe(
      0o600,
    );
  const html = discordSettingsHtml(store, dir, "csrf");
  expect(html).toContain("&lt;application&gt;");
  expect(html).not.toContain(TOKEN);
  savePrimary(dir, "discord");
  expect(effectivePrimary({}, dir, true).channel).toBe("discord");
  const card = discordCard(
    "Result\n@everyone ||hidden|| [link](https://example.com)",
  );
  expect(card.allowed_mentions).toEqual({ parse: [], replied_user: false });
  expect(JSON.stringify(card)).not.toContain("@everyone");
  expect(JSON.stringify(card)).toContain("\\\\|");
});
test("REST validates routes, sanitizes provider failures and preserves fractional retry delay", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify({ retry_after: 1.25 }), { status: 429 }),
  );
  await expect(
    discordApi(TOKEN, fetcher)("POST", `/channels/${CHANNEL}/messages`, {}),
  ).rejects.toMatchObject({ retryMs: 1250, code: "ratelimited" });
  expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
  await expect(
    discordApi(TOKEN, fetcher)("GET", "https://example.com"),
  ).rejects.toThrow("Invalid Discord request");
  expect(fetcher).toHaveBeenCalledTimes(1);
  const bad = discordApi(
    TOKEN,
    async () =>
      new Response(JSON.stringify({ message: TOKEN }), { status: 401 }),
  );
  await expect(bad("GET", "/users/@me")).rejects.not.toThrow(TOKEN);
});
test("setup validates bot identity, accepts optional app bot metadata and rejects a configured interaction endpoint", async () => {
  const fetcher: typeof fetch = async (url) =>
    new Response(
      JSON.stringify(
        String(url).endsWith("users/@me")
          ? { id: BOT, bot: true }
          : { id: BOT, name: "Fixture" },
      ),
    );
  expect((await checkDiscordCredentials(TOKEN, fetcher)).installation).toBe(
    ID.installation,
  );
  expect(
    discordReadyMatches(
      { application: { id: BOT }, user: { id: BOT, bot: true } },
      ID,
    ),
  ).toBe(true);
  expect(
    discordReadyMatches(
      { application: { id: snow() }, user: { id: BOT, bot: true } },
      ID,
    ),
  ).toBe(false);
  const wrong: typeof fetch = async (url) =>
    new Response(
      JSON.stringify(
        String(url).endsWith("users/@me")
          ? { id: BOT, bot: true }
          : { id: BOT, interactions_endpoint_url: "https://old.example" },
      ),
    );
  await expect(checkDiscordCredentials(TOKEN, wrong)).rejects.toThrow(
    "Interactions Endpoint",
  );
});
test("HTTP setup requires CSRF, same origin and password and never echoes the token", async () => {
  const fetcher: typeof fetch = async (url) =>
    new Response(
      JSON.stringify(
        String(url).endsWith("users/@me")
          ? { id: BOT, bot: true }
          : { id: BOT, bot: { id: BOT }, name: ID.workspace },
      ),
    );
  const server = createDecisionServer({
    store,
    evidenceRoot: options.evidenceRoot,
    repos: projects,
    configDir: dir,
    discordFetcher: fetcher,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw Error("listen");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const login = await fetch(base + "/login", {
        method: "POST",
        body: new URLSearchParams({ name: "alex", token: password }),
        redirect: "manual",
      }),
      cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const html = await (
        await fetch(base + "/settings/discord", { headers: { cookie } })
      ).text(),
      csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    const fields = { csrf, password, "bot-token": TOKEN },
      post = (f: Record<string, string>, origin = base) =>
        fetch(base + "/settings/discord/connect", {
          method: "POST",
          headers: { cookie, origin },
          body: new URLSearchParams(f),
          redirect: "manual",
        });
    expect((await post({ ...fields, csrf: "bad" })).status).toBe(403);
    expect((await post(fields, "https://wrong.example")).status).toBe(403);
    expect((await post({ ...fields, password: "wrong" })).status).toBe(403);
    expect((await post(fields)).status).toBe(303);
    expect((await post(fields)).status).toBe(409);
    expect(
      await (
        await fetch(base + "/settings/discord", { headers: { cookie } })
      ).text(),
    ).not.toContain(TOKEN);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("Gateway validates READY and persists a button before acknowledging without storing its token", async () => {
  saveDiscordCredentials(dir, { ...ID, botToken: TOKEN });
  state.prepare("UPDATE chat_runtime SET owner=NULL,lease_until=NULL").run();
  const controller = new AbortController(),
    raw = interaction("a".repeat(32), snow());
  vi.spyOn(Client.prototype, "login").mockImplementation(async function () {
    this.emit("raw", {
      t: "READY",
      d: { application: { id: BOT }, user: { id: BOT, bot: true } },
    });
    this.emit("raw", { t: "INTERACTION_CREATE", d: raw });
    return TOKEN;
  });
  const wire = vi.fn(async (url: unknown, init: RequestInit) => {
    expect(String(url)).toContain("/callback");
    expect(state.prepare("SELECT kind FROM chat_event").get()?.kind).toBe(
      "action",
    );
    expect(JSON.parse(String(init.body))).toEqual({ type: 6 });
    controller.abort();
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", wire);
  await followDiscord({
    ...options,
    dir,
    signal: controller.signal,
    notifications: () => false,
  });
  expect(wire).toHaveBeenCalledTimes(1);
  expect(
    JSON.stringify(state.prepare("SELECT payload FROM chat_event").all()),
  ).not.toContain(raw.token);
});

test("a recovered screenshot remains one upload when its repaint receipt is also lost", async () => {
  const { run } = source(),
    bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqRkAAAAASUVORK5CYII=",
      "base64",
    ),
    key = `${run}/image.png`,
    sha256 = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(join(options.evidenceRoot, String(run)));
  writeFileSync(join(options.evidenceRoot, key), bytes);
  const artifact = store.saveArtifact(
    {
      run,
      kind: "screenshot",
      key,
      bytesOriginal: bytes.length,
      bytesStored: bytes.length,
      truncated: false,
      sha256,
      capture: "Synthetic screenshot",
    },
    now,
  );
  plan([
    { text: "Screenshot", image: { taskId: "sample", run, artifact, sha256 } },
  ]);
  const base = options.api;
  let saved: Record<string, unknown> = {},
    lostEdit = false;
  options.api = async (m, p, b, f) => {
    if (p.endsWith("?limit=100")) return { items: [saved] };
    const answer = await base(m, p, b, f);
    if (m === "POST") {
      saved = { ...answer, nonce: b?.nonce };
      throw new DiscordError("lost receipt", 5000, true);
    }
    if (m === "PATCH" && !lostEdit) {
      lostEdit = true;
      throw new DiscordError("lost edit receipt", 5000, true);
    }
    return answer;
  };
  await deliverDiscordPart(options);
  now = new Date(now.getTime() + 16000);
  state.lease(ID.installation, "test", now);
  await deliverDiscordPart(options);
  now = new Date(now.getTime() + 61000);
  state.lease(ID.installation, "test", now);
  await drain();
  expect(sends().filter((c) => c.file)).toHaveLength(1);
  expect(sends().filter((c) => c.method === "POST")).toHaveLength(1);
  expect(state.prepare("SELECT state FROM chat_part").get()?.state).toBe(
    "sent",
  );
});
test("a reply to a result message carries its exact saved result into the shared assistant", async () => {
  const { run } = source();
  plan([{ text: "Result is ready", task: "sample", run }]);
  await drain();
  const parent = String(
    state.prepare("SELECT message FROM chat_part").get()?.message,
  );
  answers.push({ text: "I am reviewing this exact result." });
  receive("What needs changing?", {
    type: 19,
    message_reference: { message_id: parent, channel_id: CHANNEL },
  });
  await processDiscordEvent(options);
  const request = vi.mocked(options.subscriptionRunner!).mock.calls[0]![0];
  expect(request.dataDocument).toContain('"sample"');
  expect(JSON.stringify(request.history)).toContain(
    `replying to result #${run} from execution sample`,
  );
});

test("punctuation-heavy headings fit Discord without losing any approval text", () => {
  const heading = "\\".repeat(150),
    text = heading + "\nReview the exact result",
    card = discordCard(text, [
      { type: 2, style: 2, label: "Confirm", custom_id: "synthetic" },
    ]);
  const embed = (
    card.embeds as Array<{ title: string; description: string }>
  )[0]!;
  expect(embed.title.length).toBeLessThanOrEqual(256);
  expect(embed.title).toBe("Toolroll");
  expect(embed.description).toContain("\\".repeat(300));
  expect(embed.description).toContain("Review the exact result");
});

/** A Ready result of the fixture task: approved scope, a finished attempt with a recorded head, the task done. */
function ready() {
  const { ref, run } = source();
  store.recordOutcomeFacts(run, { headRevision: "a".repeat(40), handoff: "Progress is clear." });
  store.setTaskState("sample", "done", now);
  return { ref, run };
}
test("teammates pair their own Discord accounts, and status, task and help answer from the database without a model", async () => {
  const sam = addApprover(store, "sam", now, { name: "alex", token: password });
  if (!sam.ok) throw Error("sam");
  store.setNotificationPreference("sam", { mode: "all" }, "sam", now);
  const original = options.api;
  const SAM = snow(), DSAM = snow();
  options = { ...options, api: async (method, path, body = {}, file) => {
    if (path === `/users/${SAM}`) return { id: SAM };
    if (path === `/channels/${DSAM}`) return { id: DSAM, type: 1, recipients: [{ id: SAM }] };
    return original(method, path, body, file);
  } };
  const code = state.pairing(ID.installation, "sam", store.accountOf("sam")!.generation, now);
  expect(state.pair(ID, chatHash(code), SAM, DSAM, now)).toMatchObject({ approver: "sam", member: SAM });
  expect(state.bindings(ID.installation).map(one => one.approver)).toEqual(["alex", "sam"]);
  expect(receive("status")).toBe(true);
  await processDiscordEvent(options);
  await drain();
  expect(sends().at(-1)?.path).toContain(`/channels/${CHANNEL}/messages`);
  expect(sentText()).toContain("Recent work");
  expect(receive("help", { author: { id: SAM }, channel_id: DSAM })).toBe(true);
  await processDiscordEvent(options);
  await drain();
  expect(sends().at(-1)?.path).toContain(`/channels/${DSAM}/messages`);
  expect(sentText()).toContain("Toolroll in chat");
  expect(options.subscriptionRunner).not.toHaveBeenCalled();
  state.revokeBinding(state.bindingFor(ID.installation, SAM)!, now);
  expect(state.bindings(ID.installation).map(one => one.approver)).toEqual(["alex"]);
  expect(receive("status", { author: { id: SAM }, channel_id: DSAM })).toBe(false);
});
test("mark complete confirms behind a second tap in Discord and records the assignment check for the exact result", async () => {
  const { run } = ready();
  const who = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, projects);
  if (!who.ok) throw Error("who");
  const payload = prepareSharedAction(store, who.who, "result_accept", { task: "sample", run }, join(dir, "evidence"), now);
  draft({ ...payload });
  await drain();
  const c = card();
  expect(sentText()).toContain("Accept and finish: Clear Discord progress");
  await tap(c.token, c.message);
  expect(sentText()).toContain("This records that you handled this exact result. Confirm?");
  expect(JSON.stringify(sends().at(-1)?.body.components)).toContain("Yes, accept and finish");
  expect(assignmentOf(store, "sample", now, { principal: "operator", repos: projects }, join(dir, "evidence"))?.state).toBe("ready-to-check");
  const yes = state.prepare("SELECT token FROM chat_action WHERE part=? AND phase='yes' AND consumed IS NULL").get(c.id)!;
  await tap(String(yes.token), c.message);
  expect(assignmentOf(store, "sample", now, { principal: "operator", repos: projects }, join(dir, "evidence"))).toMatchObject({ state: "complete", completion: { actor: "operator:alex" } });
  expect(store.proofAcceptance(run)).toBeNull();
  expect(sentText()).toContain("Accepted and finished.");
  expect(store.getMateProposal(c.proposal)?.outcome).toMatchObject({ ok: true, via: "discord" });
});

test("a Discord guild channel follows a team conversation: a manager binds it with team 1, paired members' messages enter the shared queue, and replies come back to the channel", async () => {
  const sam = addApprover(store, "sam", now, { name: "alex", token: password });
  if (!sam.ok) throw Error("sam");
  store.setNotificationPreference("sam", { mode: "all" }, "sam", now);
  const original = options.api;
  const SAM = snow(), DSAM = snow(), GUILD = snow(), ROOM = snow();
  options = { ...options, api: async (method, path, body = {}, file) => {
    if (path === `/users/${SAM}`) return { id: SAM };
    if (path === `/channels/${DSAM}`) return { id: DSAM, type: 1, recipients: [{ id: SAM }] };
    if (method === "POST" && path === `/channels/${ROOM}/messages`) { calls.push({ method, path, body }); return { id: snow(), channel_id: ROOM, author: { id: BOT } }; }
    return original(method, path, body, file);
  } };
  const samCode = state.pairing(ID.installation, "sam", store.accountOf("sam")!.generation, now);
  expect(state.pair(ID, chatHash(samCode), SAM, DSAM, now)).not.toBeNull();
  const domain = new TeamLeads(store, () => projects);
  const actor = (name: string) => ({ name, generation: store.accountOf(name)!.generation });
  const lead = domain.execute(actor("alex"), { operation: "create-lead", args: { name: "Engineering", instructions: "Keep it simple.", projects } }, now);
  if (!lead.ok) throw Error(lead.message);
  const made = domain.execute(actor("alex"), { operation: "create-conversation", args: { leadId: (lead.result as { leadId: string }).leadId, title: "Website launch", visibility: "team", projects } }, now);
  if (!made.ok) throw Error(made.message);
  const conversation = (made.result as { conversationId: string }).conversationId, thread = (made.result as { threadId: number }).threadId;
  expect(domain.execute(actor("alex"), { operation: "member", args: { conversationId: conversation, account: "sam", role: "contributor", active: true, expectedRevision: 1, joinLead: true, expectedLeadRevision: 1 } }, now).ok).toBe(true);
  for (const name of ["alex", "sam"]) store.mintTeamMateSession({ approver: name, approverGeneration: actor(name).generation, thread, credentialKey: "fixture", ceilingMicrousd: 0, ceilingDigest: ceilingDigestOf(projects), termsDigest: "t".repeat(64) }, now);
  const inRoom = (text: string, user = MEMBER) => receive(text, { guild_id: GUILD, channel_id: ROOM, author: { id: user } });
  const roomTexts = () => calls.filter(c => c.path === `/channels/${ROOM}/messages` && c.method === "POST").map(c => JSON.stringify(c.body.embeds ?? c.body.content ?? ""));
  expect(inRoom("hello?")).toBe(false);
  expect(inRoom("team 1")).toBe(true);
  await processDiscordEvent(options); await drain();
  expect(roomTexts().at(-1)).toContain("This room now follows Website launch (lead Engineering)");
  expect(state.room(ID.installation, ROOM)).toMatchObject({ kind: "group", conversation, boundBy: "alex" });
  expect(inRoom("Add a criterion for the footer", SAM)).toBe(true);
  await processDiscordEvent(options); await drain();
  const queued = store.handle.prepare("SELECT q.author, q.request_id, m.text FROM team_message q JOIN mate_message m ON m.id = q.message WHERE q.conversation = ? ORDER BY q.message").all(conversation);
  expect(queued).toEqual([{ author: "sam", request_id: expect.stringMatching(new RegExp(`^discord:${ROOM}:`)), text: "Add a criterion for the footer" }]);
  expect(options.subscriptionRunner).not.toHaveBeenCalled();
  const claim = domain.claimNext("fixture-runner", now)!;
  expect(domain.finish(claim, { status: "answered", text: "Added: the footer must show the current year." }, now)).toBe(true);
  await planDiscordRooms(options); await drain();
  expect(roomTexts().at(-1)).toContain("Added: the footer must show the current year.");
  expect(roomTexts().some(text => text.includes("sam:"))).toBe(false);
  expect(inRoom("team off")).toBe(true);
  await processDiscordEvent(options); await drain();
  expect(state.room(ID.installation, ROOM)).toBeNull();
});

test("a flow decision in Discord: the draft with Approve / Edit / Send back, Edit by the next message, Approve on the fresh card (v88)", async () => {
  now = new Date(now.getTime() + 30_000);
  const flow = store.createFlow({ repo, name: "Support", by: "alex", definitionJson: JSON.stringify(flowFromSteps([
    { title: "Inbox", kind: "inbox" },
    { id: "draft", title: "Write the reply", kind: "draft", instructions: "Reply to {{card.title}}" },
    { id: "check", title: "Check the reply", kind: "approval", decider: "owner", ifFails: "Write the reply" },
    { id: "post", title: "Post it", kind: "notify", message: "{{stage.draft}}" },
  ], null)) }, now);
  const card = store.addFlowCard({ flow, title: "Refund for order 42?", description: null, stage: "check", by: "alex" }, now);
  store.updateFlowCard(card, { outputs: { draft: "Hi Priya,\nwe refunded it." } }, now);
  advanceFlows(store, repo, now);
  await planDiscordNotifications(options);
  await drain();
  type Button = { label: string; custom_id?: string; style: number };
  const buttonsOf = (call: { body: Record<string, unknown> }) => ((call.body.components as Array<{ components: Button[] }>)[0]?.components ?? []);
  const flowPart = () => state.prepare("SELECT message FROM chat_part WHERE json_extract(payload,'$.flow') IS NOT NULL ORDER BY id DESC LIMIT 1").get()!;
  const notice = sends().at(-1)!;
  expect(sentText()).toContain("Hi Priya,\\nwe refunded it.");
  const first = buttonsOf(notice);
  expect(first.map(one => one.label)).toEqual(["Approve", "Edit", "Send back", "Open"]);
  const token = (buttons: Button[], label: string) => buttons.find(one => one.label === label)!.custom_id!.slice(3);
  const noticeId = String(flowPart().message);
  await tap(token(first, "Edit"), noticeId);
  expect(sentText()).toContain("as your next message here");
  receive("Hi Priya, refunded today.");
  await processDiscordEvent(options);
  await drain();
  expect(store.getFlowCard(card)!.outputs["draft"]).toBe("Hi Priya, refunded today.");
  const fresh = buttonsOf(sends().at(-1)!);
  const freshId = String(flowPart().message);
  // A tap on the old card, or with the new token on the old card, changes nothing.
  await tap(token(first, "Approve"), noticeId);
  await tap(token(fresh, "Approve"), noticeId);
  expect(store.getFlowCard(card)!.stage).toBe("check");
  await tap(token(fresh, "Approve"), freshId);
  expect(store.getFlowCard(card)!.stage).toBe("post");
  const repainted = sends().at(-1)!;
  expect(repainted.method).toBe("PATCH");
  expect(repainted.path.endsWith(`/messages/${freshId}`)).toBe(true);
  expect(sentText()).toContain("You approved it. Approved. Moved to Post it.");
  expect(buttonsOf(repainted).map(one => one.label)).toEqual(["Open"]);
});

test("a flow choice in Discord: the flow's own options as buttons, a reply to the notice is the note, another message is asked about once, and Ignore closes a card as Ignored", async () => {
  now = new Date(now.getTime() + 30_000);
  const flow = store.createFlow({ repo, name: "Fixes", by: "alex", definitionJson: JSON.stringify(flowFromSteps([
    { id: "build", title: "Build", kind: "task" },
    { id: "choose", title: "What next?", kind: "choose", options: [{ label: "Ship it", goesTo: "Ship" }, { label: "Ignore", goesTo: "end" }] },
    { id: "ship", title: "Ship", kind: "inbox" },
  ], null)) }, now);
  type Button = { label: string; custom_id?: string; style: number };
  const buttonsOf = (call: { body: Record<string, unknown> }) => ((call.body.components as Array<{ components: Button[] }>)[0]?.components ?? []);
  const choicePart = () => String(state.prepare("SELECT message FROM chat_part WHERE json_extract(payload,'$.choose') IS NOT NULL ORDER BY id DESC LIMIT 1").get()!.message);
  const notePart = () => String(state.prepare("SELECT message FROM chat_part WHERE json_extract(payload,'$.note') IS NOT NULL ORDER BY id DESC LIMIT 1").get()!.message);
  const first = store.addFlowCard({ flow, title: "Checkout rounding", description: "Totals are off by a cent", stage: "choose", by: "alex" }, now);
  advanceFlows(store, repo, now);
  await planDiscordNotifications(options);
  await drain();
  expect(sentText()).toContain("Totals are off by a cent");
  expect(sentText()).toContain("Or reply with what you'd change.");
  expect(buttonsOf(sends().at(-1)!).map(one => one.label)).toEqual(["Ship it", "Ignore", "Card"]);
  // A reply to the notice itself is the note.
  receive("Round half-even instead.", { message_reference: { message_id: choicePart(), channel_id: CHANNEL } });
  await processDiscordEvent(options);
  await drain();
  expect(store.getFlowCard(first)).toMatchObject({ stage: "build", note: "Round half-even instead." });
  expect(sentText()).toContain("Sent to Build with your note.");
  // A reply to that notice once it's spent changes nothing.
  receive("Actually, round up.", { message_reference: { message_id: choicePart(), channel_id: CHANNEL } });
  await processDiscordEvent(options);
  await drain();
  expect(sentText()).toContain("already made");
  expect(store.getFlowCard(first)).toMatchObject({ stage: "build", note: "Round half-even instead." });

  const second = store.addFlowCard({ flow, title: "Old banner", description: "Remove the 2025 banner", stage: "choose", by: "alex" }, now);
  advanceFlows(store, repo, now);
  await planDiscordNotifications(options);
  await drain();
  // Any other message is asked about, once: No passes it to the lead, and the card still waits.
  receive("What's running right now?");
  await processDiscordEvent(options);
  await drain();
  expect(sentText()).toContain("Use this as your note on “Old banner”?");
  expect(buttonsOf(sends().at(-1)!).map(one => one.label)).toEqual(["Yes", "No"]);
  expect(options.subscriptionRunner).not.toHaveBeenCalled();
  const no = buttonsOf(sends().at(-1)!).find(one => one.label === "No")!.custom_id!.slice(3);
  answers.push({ text: "Nothing is running." });
  await tap(no, notePart());
  expect(sentText()).toContain("Passed to the lead.");
  await processDiscordEvent(options);
  await drain();
  expect(options.subscriptionRunner).toHaveBeenCalledTimes(1);
  expect(sentText()).toContain("Nothing is running.");
  expect(store.getFlowCard(second)).toMatchObject({ stage: "choose", state: "active" });
  // Asked once per choice: the next message is the lead's straight away.
  answers.push({ text: "All quiet." });
  receive("Anything failing?");
  await processDiscordEvent(options);
  await drain();
  expect(options.subscriptionRunner).toHaveBeenCalledTimes(2);
  expect(sentText()).toContain("All quiet.");
  const ignore = buttonsOf(calls.filter(one => one.method === "POST" && buttonsOf(one).some(button => button.label === "Ignore")).at(-1)!).find(one => one.label === "Ignore")!.custom_id!.slice(3);
  await tap(ignore, choicePart());
  expect(store.getFlowCard(second)).toMatchObject({ state: "cancelled", waiting: "Ignored" });
  expect(sentText()).toContain("You chose “Ignore”. Ignored. The card is closed.");
  // Every choice is ledgered with the person and where it was made (newest first).
  expect(store.actionLedger({ repos: [repo] }).filter(one => one.action === "flow choice").map(one => [one.actor, one.outcome, one.detail])).toEqual([
    ["alex", "ignored", "Fixes · card 2 · What next?: “Ignore” · via Discord"],
    ["alex", "replied", "Fixes · card 1 · What next?: a reply to Build · via Discord"],
  ]);
});

test("a Discord channel feeds a flow: 'flow N' connects it, anyone's message is a card answered in reply, and a reply to it joins the card (v89)", async () => {
  now = new Date(now.getTime() + 30_000);
  const flow = store.createFlow({ repo, name: "Requests", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }], null)) }, now);
  const GUILD = snow(), ROOM = snow(), OTHER = snow();
  const inRoom = (text: string, user = MEMBER, extra: Record<string, unknown> = {}) => receive(text, { guild_id: GUILD, channel_id: ROOM, author: { id: user }, ...extra });
  expect(inRoom("Need a new laptop", OTHER)).toBe(false);
  expect(inRoom(`flow ${flow}`)).toBe(true);
  await processDiscordEvent(options); await drain();
  expect(sentText()).toContain("This channel now feeds Requests");
  const message = inRoom("Need a new laptop", OTHER);
  expect(message).toBe(true);
  await processDiscordEvent(options); await drain();
  const card = store.flowCards(flow, true)[0]!;
  expect(card).toMatchObject({ title: "Need a new laptop", createdBy: "Discord", source: { kind: "chat", chat: { app: "discord", chat: ROOM } } });
  const said = sends().at(-1)!;
  expect(said.path).toBe(`/channels/${ROOM}/messages`);
  expect(said.body.message_reference).toMatchObject({ message_id: card.source!.chat!.thread });
  expect(sentText()).toContain("Added to Requests as a card.");
  expect(inRoom("It's the Dell.", OTHER, { type: 19, message_reference: { message_id: card.source!.chat!.thread, channel_id: ROOM, guild_id: GUILD } })).toBe(true);
  await processDiscordEvent(options); await drain();
  expect(store.flowComments(card.id).map(one => one.body)).toEqual(["It's the Dell."]);
});

test("the lead's question arrives as buttons with Something else, and a tap is the owner's next message (ask_owner)", async () => {
  type Button = { label: string; custom_id?: string; style: number };
  const buttonsOf = (call: { body: Record<string, unknown> }) => ((call.body.components as Array<{ components: Button[] }> | undefined)?.[0]?.components ?? []);
  const runner = vi.mocked(options.subscriptionRunner!);
  answers.push(
    { text: "", calls: [{ id: "q1", name: "ask_owner", args: { question: "Ship it today or Friday?", options: ["Today", "Friday"] } }] },
    { text: "It depends on one thing." },
  );
  expect(receive("When should the release go out?")).toBe(true);
  await processDiscordEvent(options);
  await drain();
  expect(sentText()).toContain("Ship it today or Friday?");
  const buttons = buttonsOf(sends().at(-1)!);
  expect(buttons.map(one => one.label)).toEqual(["Today", "Friday", "Something else"]);
  const askId = String(state.prepare("SELECT message FROM chat_part WHERE json_extract(payload,'$.ask') IS NOT NULL ORDER BY id DESC LIMIT 1").get()!.message);
  answers.push({ text: "Friday it is." });
  await tap(buttons[1]!.custom_id!.slice(3), askId);
  expect(sentText()).toContain("You chose: Friday");
  await processDiscordEvent(options);
  await drain();
  const history = runner.mock.calls.at(-1)![0].history;
  expect(history.filter(one => one.role === "operator").at(-1)).toMatchObject({ text: "Friday" });
  expect(sentText()).toContain("Friday it is.");
});
