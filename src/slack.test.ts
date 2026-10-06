/** Scripted Slack API and membership runner. No live Slack acceptance is claimed. */
import { notifyPeople } from "./flow-people.js";
import { TEAMMATE_TEMPLATES } from "./teammates.js";
import { addressedTo as messageTeammateWords, replyToAsker } from "./teammate-desk.js";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { MATE_ASK_TTL_MS, openStore, type Store } from "./store.js";
import { applyChatAskTap, chatAskButtons } from "./chat-ask.js";
import { addApprover, propose, approve } from "./scope.js";
import { SlackState, slackHash, type SlackContent } from "./slack-state.js";
import {
  SlackError,
  slackApi,
  uploadSlackBytes,
  saveSlackCredentials,
  loadSlackCredentials,
  SLACK_MANIFEST,
  type SlackApi,
} from "./slack-api.js";
import {
  receiveSlack,
  processSlackEvent,
  deliverSlackPart,
  planSlackNotifications,
  slackBlocks,
  type SlackChatOptions,
  planSlackRooms,
} from "./slack-chat.js";
import { knowledgeView } from "./project-knowledge.js";
import { resolveChannelMate, parityGaps } from "./chat-channel.js";
import { prepareSharedAction } from "./chat-actions.js";
import { verifyApproverStanding } from "./principal.js";
import { assignmentOf } from "./assignment.js";
import { TeamLeads } from "./team-leads.js";
import { ceilingDigestOf } from "./principal.js";
import { telegramProgressCard } from "./telegram-progress.js";
import { slackSettingsHtml } from "./slack-settings.js";
import { effectivePrimary, savePrimary } from "./webhooks.js";
import { createDecisionServer } from "./serve.js";
import { ToolrollSlackSocket } from "./slack.js";
import { flowFromSteps } from "./flows.js";
import { advanceFlows } from "./flow-engine.js";
import { chooseFlowCard } from "./flow-send.js";
import { runFlowSteps } from "./flow-steps.js";
import { run as exec } from "./exec.js";

// Synthetic credentials for the scripted wire, assembled so evidence scans do not flag a real token.
const FIXTURE_BOT_TOKEN = ["xoxb", "fixture", "private", "token"].join("-");
const ID = {
  installation: "installation-test",
  team: "TTEST",
  app: "ATEST",
  bot: "UBOT",
  workspace: "Test workspace",
};
const MEMBER = "UTEST",
  CHANNEL = "DTEST",
  TS = "1789700000.000001";
describe("Slack shared chat", () => {
  let dir: string,
    repo: string,
    store: Store,
    state: SlackState,
    now: Date,
    options: SlackChatOptions,
    password: string;
  let calls: Array<{ method: string; args: Record<string, unknown> }>;
  let answers: Array<{
    text: string;
    calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
    before?: () => void;
  }>;
  let runner: NonNullable<SlackChatOptions["subscriptionRunner"]>,
    projects: string[],
    serial: number;
  const message = (text: string, extra: Record<string, unknown> = {}) => ({
    api_app_id: ID.app,
    team_id: ID.team,
    event_id: `Ev${++serial}`,
    event: {
      type: "message",
      channel_type: "im",
      user: MEMBER,
      channel: CHANNEL,
      ts: TS,
      text,
      ...extra,
    },
  });
  const receive = (text: string, extra: Record<string, unknown> = {}) =>
    receiveSlack(state, ID, "events_api", message(text, extra), now);
  const sends = () =>
    calls.filter(
      (c) => c.method === "chat.postMessage" || c.method === "chat.update",
    );
  async function drain() {
    for (let i = 0; i < 20 && (await deliverSlackPart(options)); i++);
  }
  const pair = () => {
    const code = state.pairing(
      ID.installation,
      "alex",
      store.accountOf("alex")!.generation,
      now,
    );
    return state.pair(ID, slackHash(code), MEMBER, CHANNEL, now)!;
  };
  function action(token: string, ts = TS, extra: Record<string, unknown> = {}) {
    return {
      api_app_id: ID.app,
      team: { id: ID.team },
      type: "block_actions",
      user: { id: MEMBER },
      channel: { id: CHANNEL },
      container: { type: "message", channel_id: CHANNEL, message_ts: ts },
      message: { thread_ts: TS },
      actions: [
        {
          action_id: "standing_orders_confirm",
          value: token,
          action_ts: `1789700000.${String(++serial).padStart(6, "0")}`,
        },
      ],
      ...extra,
    };
  }
  async function tap(
    token: string,
    ts: string,
    extra: Record<string, unknown> = {},
  ) {
    receiveSlack(state, ID, "interactive", action(token, ts, extra), now);
    await processSlackEvent(options);
    await drain();
  }
  function latestCard() {
    const row = state.db
      .prepare(
        "SELECT * FROM slack_part WHERE json_extract(payload,'$.proposal') IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
      .get()!;
    const token = state.db
      .prepare(
        "SELECT token FROM slack_action WHERE part=? AND phase='confirm' AND consumed IS NULL",
      )
      .get(Number(row.id))!;
    return {
      id: Number(row.id),
      proposal: Number(
        (JSON.parse(String(row.payload)) as SlackContent).proposal,
      ),
      ts: String(row.message),
      token: String(token.token),
    };
  }
  function source() {
    store.createTask({ id: "sample", title: "Clarify Slack progress" }, now);
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
    expect(
      approve(store, "sample", "alex", now, scope.digest, password).ok,
    ).toBe(true);
    const route = store.routeAuthorityFor(ref, "builder", null);
    if (!route?.ok) throw Error("route");
    const run = store.startRun({
      taskRef: ref,
      leaseId: "sample-lease",
      runner: "test",
      branch: "test",
      worktree: repo,
      route: route.stamp,
      now,
    });
    store.stampRun(run, { scopeDigest: scope.digest });
    store.finishRun(run, { outcome: "built", committed: true, now });
    return { ref, run };
  }
  function draft(
    payload: Record<string, unknown>,
    kind: Parameters<Store["draftMateProposal"]>[0]["kind"] = "action",
  ) {
    const binding = state.binding(ID.installation)!;
    const resolved = resolveChannelMate(
      store,
      { approver: binding.approver, approverGeneration: binding.generation },
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
    const id = store.draftMateProposal(
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
    const event = slackHash(`card${++serial}`);
    state.enqueue({
      id: event,
      installation: ID.installation,
      binding: binding.id,
      kind: "message",
      channel: CHANNEL,
      member: MEMBER,
      ts: TS,
      thread: TS,
      payload: "{}",
      created: now.toISOString(),
    });
    state.plan(event, [{ text: "", proposal: id }], now);
    return { id, who: resolved.who };
  }
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-slack-")));
    repo = join(dir, "repo");
    mkdirSync(repo);
    mkdirSync(join(dir, "evidence"));
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "Synthetic Slack test\n");
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
    state = new SlackState(store);
    now = new Date("2026-09-17T20:00:00Z");
    serial = 0;
    calls = [];
    answers = [];
    projects = [repo];
    const added = addApprover(store, "alex", now);
    if (!added.ok) throw Error("account");
    password = added.token;
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
    let sent = 100;
    const api: SlackApi = vi.fn(async (method, args = {}) => {
      calls.push({ method, args });
      if (method === "users.info")
        return {
          user: { id: MEMBER, team_id: ID.team, deleted: false, is_bot: false },
        };
      if (method === "conversations.info")
        return { channel: { id: CHANNEL, is_im: true, user: MEMBER } };
      if (method === "chat.postMessage")
        return { ts: `1789700000.${String(sent++).padStart(6, "0")}` };
      if (method === "chat.update") return { ts: args.ts };
      if (method === "files.getUploadURLExternal")
        return {
          file_id: "FFILE",
          upload_url: "https://files.slack.com/upload/v1/test",
        };
      if (method === "files.completeUploadExternal")
        return { files: [{ id: "FFILE" }] };
      return {};
    });
    runner = vi.fn(async () => {
      const next = answers.shift();
      if (!next) throw Error("No scripted answer");
      next.before?.();
      return {
        ok: true,
        answer: {
          text: next.text,
          calls: next.calls ?? [],
          tokensIn: 10,
          tokensOut: 5,
          reportedCostMicrousd: null,
        },
      };
    });
    options = {
      store,
      identity: ID,
      api,
      owner: "test",
      readProjects: async () => projects,
      evidenceRoot: join(dir, "evidence"),
      current: () => true,
      origin: () => "https://console.example",
      clock: () => now,
      subscriptionRunner: runner,
      upload: vi.fn(async () => {}),
    };
    state.lease(ID.installation, "test", now);
    pair();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test("pairs only once to a live account, hashes codes and rejects another workspace or sender", async () => {
    state.revoke(ID.installation, now);
    const code = state.pairing(
      ID.installation,
      "alex",
      store.accountOf("alex")!.generation,
      now,
    );
    const payload = message(`pair ${code}`);
    expect(receiveSlack(state, ID, "events_api", payload, now)).toBe(true);
    expect(
      JSON.stringify(state.db.prepare("SELECT * FROM slack_event").all()),
    ).not.toContain(code);
    await processSlackEvent(options);
    expect(state.binding(ID.installation)?.member).toBe(MEMBER);
    await drain();
    expect(sends().at(-1)?.args.text).toContain("Connected to Toolroll");
    expect(receive("private projects", { user: "UOTHER" })).toBe(false);
    expect(
      receiveSlack(
        state,
        ID,
        "events_api",
        { ...message("private"), team_id: "TOTHER" },
        now,
      ),
    ).toBe(false);
    expect(
      receive("public", { channel_type: "channel", channel: "COTHER" }),
    ).toBe(false);
    expect(receive("bot echo", { bot_id: "BBOT" })).toBe(false);
    expect(state.pair(ID, slackHash(code), "UOTHER", "DOTHER", now)).toBeNull();
  });
  test("a reply in a thread about one task stays on it: the /task status and the lead's answer name that task; a new message is for the lead", async () => {
    store.createTask({ id: "login", title: "Fix the login page" }, now);
    store.placeTask(store.refFor("built-in", "login").id, repo);
    const lastPart = () => JSON.parse(String(state.db.prepare("SELECT payload FROM slack_part ORDER BY id DESC LIMIT 1").get()!.payload)) as SlackContent;
    const asked = () => {
      const request = (runner as unknown as { mock: { calls: [{ history: { role: string; text?: string }[] }][] } }).mock.calls.at(-1)![0];
      return String(request.history.filter((one) => one.role === "operator").at(-1)?.text);
    };
    const send = async (text: string, extra: Record<string, unknown>) => {
      expect(receive(text, extra)).toBe(true);
      await processSlackEvent(options);
      await drain();
    };
    await send("/task login", { ts: "1789700001.000001" });
    expect(lastPart()).toMatchObject({ task: "login" });
    await send("/lead", { ts: "1789700002.000001" });
    expect(store.chatFocus("slack", state.binding(ID.installation)!.id)).toBeNull();
    // A reply in the status message's thread is about the login page.
    answers.push({ text: "It waits for your approval." });
    await send("How is it going?", { ts: "1789700003.000001", thread_ts: "1789700001.000001" });
    expect(asked()).toContain("Current task: login.");
    // The lead's answer names the task too, so the thread stays on it.
    expect(lastPart()).toMatchObject({ text: "It waits for your approval.", task: "login" });
    // A new message outside the thread is for the lead.
    answers.push({ text: "Nothing else needs you." });
    await send("Anything else?", { ts: "1789700004.000001" });
    expect(asked()).not.toContain("Current task");
    expect(lastPart().task).toBeUndefined();
  });
  test("the lead's voice in Slack: a tool turn gets one :thumbsup: on the owner's message; the reply goes out as mrkdwn with no header, a labelled link and no internal ids", async () => {
    answers.push(
      { text: "Checking.", calls: [{ id: "q1", name: "list_tasks", args: {} }] },
      { text: "## Payout\n**Ready**: see https://console.example/chat?task=payout (run #4)." },
    );
    receive("how is the payout fix?");
    await processSlackEvent(options);
    await drain();
    const reactions = calls.filter((c) => c.method === "reactions.add");
    expect(reactions).toEqual([{ method: "reactions.add", args: { channel: CHANNEL, timestamp: TS, name: "thumbsup" } }]);
    const reply = sends().at(-1)!.args;
    expect(reply).toMatchObject({ mrkdwn: true, text: "Payout\n*Ready*: see <https://console.example/chat?task=payout|the task>." });
    expect(reply.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: "Payout\n*Ready*: see <https://console.example/chat?task=payout|the task>." } }]);
    // No permission for reactions: skipped silently, and the reply still goes out; a quick answer gets no reaction.
    const base = options.api;
    options.api = async (method, args) => {
      if (method === "reactions.add") throw new SlackError("missing_scope");
      return base(method, args);
    };
    answers.push({ text: "Checking.", calls: [{ id: "q2", name: "list_tasks", args: {} }] }, { text: "All quiet." });
    receive("anything else?");
    await processSlackEvent(options);
    await drain();
    expect(sends().at(-1)!.args.text).toBe("All quiet.");
    options.api = base;
    answers.push({ text: "Still quiet." });
    receive("and now?");
    await processSlackEvent(options);
    await drain();
    expect(calls.filter((c) => c.method === "reactions.add")).toHaveLength(1);
  });

  test("one request survives duplicate events and reply delivery loss without a second model turn", async () => {
    const body = message("What needs my attention?");
    answers.push({ text: "No task needs your attention." });
    expect(receiveSlack(state, ID, "events_api", body, now)).toBe(true);
    expect(receiveSlack(state, ID, "events_api", body, now)).toBe(false);
    await processSlackEvent(options);
    const base = options.api;
    options.api = async (method, args) => {
      if (method === "chat.postMessage")
        throw new SlackError("lost receipt", 5000, true);
      return base(method, args);
    };
    await deliverSlackPart(options);
    expect(
      state.db.prepare("SELECT uncertain FROM slack_part").get()?.uncertain,
    ).toBe(1);
    options.api = base;
    now = new Date(now.getTime() + 6000);
    state.lease(ID.installation, "test", now);
    await drain();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(sends().at(-1)?.args.thread_ts).toBe(TS);
    expect(state.db.prepare("SELECT state FROM slack_part").get()?.state).toBe(
      "sent",
    );
  });
  test("shared knowledge change confirms once, records Slack, and edits its original card", async () => {
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
    receive("Save these instructions");
    await processSlackEvent(options);
    await drain();
    const card = latestCard();
    await tap(card.token, card.ts);
    expect(knowledgeView(store, repo, "alex").knowledge.instructions).toBe(
      "Keep updates concise.",
    );
    expect(store.getMateProposal(card.proposal)?.outcome).toMatchObject({
      via: "slack",
      ok: true,
    });
    expect(sends().at(-1)?.method).toBe("chat.update");
    expect(sends().at(-1)?.args.ts).toBe(card.ts);
    await tap(card.token, card.ts);
    expect(knowledgeView(store, repo, "alex").revision).toBe(1);
  });
  test("protected changes always use the existing secure review link, including forged callbacks", async () => {
    source();
    const binding = state.binding(ID.installation)!;
    const resolved = resolveChannelMate(
      store,
      { approver: "alex", approverGeneration: binding.generation },
      projects,
      now,
    );
    if (!resolved.ok) throw Error("session");
    const prepared = prepareSharedAction(
      store,
      resolved.who,
      "task_cancel",
      { task: "sample" },
      options.evidenceRoot,
      now,
    );
    draft({ ...prepared });
    await drain();
    const card = latestCard();
    const blocks = sends().at(-1)!.args.blocks as Array<{
      elements?: Array<{ url?: string; value?: string }>;
    }>;
    expect(blocks.flatMap((b) => b.elements ?? []).map((b) => b.url)).toContain(
      `https://console.example/chat/action/${card.proposal}`,
    );
    expect(blocks.flatMap((b) => b.elements ?? []).some((b) => b.value)).toBe(
      false,
    );
    await tap(card.token, card.ts);
    expect(store.getTask("sample")?.state).not.toBe("cancelled");
  });
  test.each(["sender", "message", "expiry", "projects", "revoked"])(
    "refuses a confirmation after %s changes",
    async (fault) => {
      const { ref } = source();
      draft({ task: "sample", reason: "Inspect the wording" }, "hold");
      await drain();
      const card = latestCard();
      if (fault === "expiry") {
        now = new Date(now.getTime() + 86_400_001);
        state.lease(ID.installation, "test", now);
      }
      if (fault === "projects") projects = [];
      if (fault === "revoked") state.revoke(ID.installation, now);
      await tap(
        card.token,
        fault === "message" ? "1789700000.999999" : card.ts,
        fault === "sender" ? { user: { id: "UOTHER" } } : {},
      );
      expect(store.activeHolds(ref, now)).toHaveLength(0);
    },
  );
  test("a button Toolroll didn't make is answered with why and does nothing; a stale one says so; a link or a stranger's tap gets no answer", async () => {
    const { ref } = source();
    draft({ task: "sample", reason: "Inspect the wording" }, "hold");
    await drain();
    const card = latestCard();
    const said = () => JSON.stringify(sends().at(-1)!.args);
    await tap("not-a-token", card.ts);
    expect(said()).toContain("That button couldn't be read (actions[0].value: must be a Toolroll button token). Nothing was done.");
    await tap(card.token, card.ts, { actions: [{ action_id: "toolroll_launch", value: card.token, action_ts: "1789700000.900001" }] });
    expect(said()).toContain("actions[0].action_id: not a Toolroll button");
    await tap("0".repeat(32), card.ts);
    expect(said()).toContain("That button expired or was already used.");
    const sent = sends().length;
    await tap("not-a-token", card.ts, { user: { id: "UOTHER" } });
    await tap(card.token, card.ts, { actions: [{ action_id: "toolroll_link_2", action_ts: "1789700000.900002" }] });
    expect(sends()).toHaveLength(sent);
    expect(store.activeHolds(ref, now)).toHaveLength(0);
    expect(store.getMateProposal(card.proposal)?.state).toBe("pending");
  });
  test("revocation during a provider wait suppresses tools, proposals and outbound data", async () => {
    answers.push({
      text: "Ready.",
      calls: [
        {
          id: "change",
          name: "propose_action",
          args: {
            operation: "knowledge_instructions",
            repo: "r1",
            instructions: "Do not save.",
          },
        },
      ],
      before: () => state.revoke(ID.installation, now),
    });
    receive("Save instructions");
    await processSlackEvent(options);
    await drain();
    expect(sends()).toHaveLength(0);
    expect(knowledgeView(store, repo, "alex").revision).toBe(0);
  });
  test("verified screenshots use the external upload API and altered bytes are refused", async () => {
    const { run } = source(),
      bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqRkAAAAASUVORK5CYII=",
        "base64",
      ),
      key = `${run}/screenshot.png`;
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
        sha256: slackHash(bytes.toString("binary")),
        capture: "Synthetic screenshot",
      },
      now,
    );
    // Hash the original bytes exactly, as the evidence recorder does.
    const { createHash } = await import("node:crypto"),
      hash = createHash("sha256").update(bytes).digest("hex");
    store.handle
      .prepare("UPDATE artifact SET sha256=? WHERE id=?")
      .run(hash, artifact);
    const binding = state.binding(ID.installation)!;
    for (const [i, tampered] of [false, true].entries()) {
      if (tampered) writeFileSync(join(options.evidenceRoot, key), "changed");
      const id = `image${i}`;
      state.enqueue({
        id,
        installation: ID.installation,
        binding: binding.id,
        kind: "message",
        channel: CHANNEL,
        member: MEMBER,
        ts: TS,
        thread: TS,
        payload: "{}",
        created: now.toISOString(),
      });
      state.plan(
        id,
        [
          {
            text: "Screenshot 1",
            image: { taskId: "sample", run, artifact, sha256: hash },
          },
        ],
        now,
      );
      await drain();
    }
    expect(options.upload).toHaveBeenCalledTimes(1);
    expect(
      calls.filter((c) => c.method === "files.completeUploadExternal"),
    ).toHaveLength(1);
    expect(sends().at(-1)?.args.text).toContain("Screenshot not sent");
  });
  test("progress facts update one exact-result card and exclude history before pairing", async () => {
    const { run } = source();
    await planSlackNotifications(options);
    await drain();
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
    await planSlackNotifications(options);
    await drain();
    expect(
      state.db.prepare("SELECT count(*) n FROM slack_progress").get()?.n,
    ).toBe(1);
    expect(sends().filter((c) => c.method === "chat.postMessage")).toHaveLength(
      1,
    );
    const content = JSON.parse(
      String(
        state.db
          .prepare(
            "SELECT p.payload FROM slack_part p JOIN slack_progress s ON s.part=p.id",
          )
          .get()?.payload,
      ),
    ) as SlackContent;
    expect(content.text).toBe(
      telegramProgressCard(store, store.getRun(run)!, "sample", repo, now, options.evidenceRoot).text,
    );
  });
  test("rate limits are persisted and a second owner cannot take a live connection", async () => {
    expect(state.lease(ID.installation, "other", now)).toBe(false);
    receive("Summarize work");
    answers.push({ text: "Ready" });
    await processSlackEvent(options);
    const api = options.api;
    options.api = async (method, args) => {
      if (method === "chat.postMessage")
        throw new SlackError("ratelimited", 120_000);
      return api(method, args);
    };
    await deliverSlackPart(options);
    expect(
      state.db.prepare("SELECT retry_at FROM slack_runtime").get()?.retry_at,
    ).toBe(new Date(now.getTime() + 120_000).toISOString());
  });
  test("credentials stay in an owner-only file; setup escapes names and never echoes tokens", () => {
    const credentials = {
      ...ID,
      workspace: "A <workspace> " + "long ".repeat(25),
      appToken: "xapp-fixture-secret",
      botToken: FIXTURE_BOT_TOKEN,
    };
    saveSlackCredentials(dir, credentials);
    expect(loadSlackCredentials(dir)).toEqual(credentials);
    if (process.platform !== "win32")
      expect(statSync(join(dir, "slack-connection.json")).mode & 0o777).toBe(
        0o600,
      );
    const html = slackSettingsHtml(store, dir, "csrf");
    expect(html).toContain("&lt;workspace&gt;");
    expect(html).not.toContain(credentials.botToken);
    expect(html).not.toContain(credentials.appToken);
    savePrimary(dir, "slack");
    expect(effectivePrimary({}, dir, true).channel).toBe("slack");
    expect(parityGaps()).toEqual([]);
    expect(SLACK_MANIFEST.oauth_config.scopes.bot).toContain("channels:history");
  });

  test("switching notification channels does not send an old Slack alert or block an ordinary reply", async () => {
    source();
    await planSlackNotifications(options);
    options.canNotify = () => false;
    receive("What remains?");
    answers.push({ text: "Your ordinary chat reply." });
    await processSlackEvent(options);
    await drain();
    expect(sends()).toHaveLength(1);
    expect(sends()[0]?.args.text).toBe("Your ordinary chat reply.");
    options.canNotify = () => true;
    await drain();
    expect(sends()).toHaveLength(2);
  });

  test("a long incoming message reports its actual size without starting the model", async () => {
    receive("a".repeat(4000));
    await processSlackEvent(options);
    await drain();
    expect(sends()[0]?.args.text).toContain("4,000");
    expect(runner).not.toHaveBeenCalled();
  });

  test("a restart after the engine answers recovers its original request receipt", async () => {
    receive("What needs review?");
    answers.push({ text: "The saved result is ready to inspect." });
    const plan = vi
      .spyOn(SlackState.prototype, "plan")
      .mockImplementationOnce(() => {
        throw Error("crash after engine receipt");
      });
    await processSlackEvent(options);
    plan.mockRestore();
    now = new Date(now.getTime() + 6000);
    state.lease(ID.installation, "test", now);
    await processSlackEvent(options);
    await drain();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(sends().at(-1)?.args.text).toContain("saved result");
  });

  test("irreversible decisions require a fresh second confirmation and record Slack in the audit", async () => {
    const { run } = source();
    const decision = store.saveDecision(
      {
        run,
        urgency: "blocking",
        recap: "Choose the failure behavior",
        question: "Fail open or closed?",
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
        rationale: "Explicit operator choice",
      },
      "answer",
    );
    await drain();
    const first = latestCard();
    await tap(first.token, first.ts);
    expect(store.getDecision(decision)?.state).toBe("open");
    const yes = String(
      state.db
        .prepare(
          "SELECT token FROM slack_action WHERE part=? AND phase='yes' AND consumed IS NULL",
        )
        .get(first.id)?.token,
    );
    await tap(yes, first.ts);
    expect(store.getDecision(decision)?.answeredVia).toBe("slack");
    expect(store.getDecision(decision)?.choice).toBe("open");
    await tap(yes, first.ts);
    expect(store.getDecision(decision)?.choice).toBe("open");
  });

  test("HTTP setup requires a current password, CSRF and same origin, and completes the three-part API handshake", async () => {
    const handshake: string[] = [];
    const fetcher: typeof fetch = async (url) => {
      const method = new URL(String(url)).pathname.split("/").at(-1)!;
      handshake.push(method);
      return new Response(
        JSON.stringify({
          ok: true,
          ...(method === "auth.test"
            ? {
                team_id: ID.team,
                user_id: ID.bot,
                bot_id: "BBOT",
                team: ID.workspace,
              }
            : method === "bots.info"
              ? { bot: { app_id: ID.app } }
              : {}),
        }),
      );
    };
    const server = createDecisionServer({
      store,
      evidenceRoot: options.evidenceRoot,
      repos: projects,
      configDir: dir,
      slackFetcher: fetcher,
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address !== "object") throw Error("listen");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const login = await fetch(base + "/login", {
        method: "POST",
        body: new URLSearchParams({ name: "alex", token: password }),
        redirect: "manual",
      });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const html = await (
          await fetch(base + "/settings/slack", { headers: { cookie } })
        ).text(),
        csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
      const post = (fields: Record<string, string>, origin = base) =>
        fetch(base + "/settings/slack/connect", {
          method: "POST",
          headers: { cookie, origin },
          body: new URLSearchParams(fields),
          redirect: "manual",
        });
      const fields = {
        csrf,
        password,
        "app-token": "xapp-fixture-private-token",
        "bot-token": FIXTURE_BOT_TOKEN,
      };
      expect((await post({ ...fields, csrf: "bad" })).status).toBe(403);
      expect((await post(fields, "https://wrong.example")).status).toBe(403);
      expect((await post({ ...fields, password: "wrong" })).status).toBe(403);
      expect(loadSlackCredentials(dir)).toBeNull();
      expect((await post(fields)).status).toBe(303);
      expect(handshake).toEqual([
        "auth.test",
        "bots.info",
        "apps.connections.open",
      ]);
      expect(loadSlackCredentials(dir)?.team).toBe(ID.team);
      expect((await post(fields)).status).toBe(409);
      const screen = await (
        await fetch(base + "/settings/slack", { headers: { cookie } })
      ).text();
      expect(screen).not.toContain(fields["app-token"]);
      expect(screen).not.toContain(fields["bot-token"]);
      expect(
        addApprover(store, "backup-owner", now, {
          name: "alex",
          token: password,
        }).ok,
      ).toBe(true);
      expect(
        store.setAccountProjects("alex", [repo], "backup-owner", now).ok,
      ).toBe(true);
      const restrictedLogin = await fetch(base + "/login", {
        method: "POST",
        body: new URLSearchParams({ name: "alex", token: password }),
        redirect: "manual",
      });
      const restrictedCookie = restrictedLogin.headers
        .get("set-cookie")!
        .split(";")[0]!;
      expect(
        (
          await fetch(base + "/settings/slack", {
            headers: { cookie: restrictedCookie },
            redirect: "manual",
          })
        ).status,
      ).toBe(403);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  /** A Ready result of the fixture task: approved scope, a finished attempt with a recorded head, the task done. */
  function ready() {
    const { ref, run } = source();
    store.recordOutcomeFacts(run, { headRevision: "a".repeat(40), handoff: "Progress is clear." });
    store.setTaskState("sample", "done", now);
    return { ref, run };
  }
  test("teammates pair their own Slack accounts, and status, task and help answer from the database without a model", async () => {
    const sam = addApprover(store, "sam", now, { name: "alex", token: password });
    if (!sam.ok) throw Error("sam");
    store.setNotificationPreference("sam", { mode: "all" }, "sam", now);
    const original = options.api;
    options = { ...options, api: vi.fn(async (method, args = {}) => {
      if (method === "users.info") return { user: { id: args.user, team_id: ID.team, deleted: false, is_bot: false } };
      if (method === "conversations.info") return { channel: { id: args.channel, is_im: true, user: args.channel === "DSAM" ? "USAM" : MEMBER } };
      return original(method, args);
    }) };
    const code = state.pairing(ID.installation, "sam", store.accountOf("sam")!.generation, now);
    expect(state.pair(ID, slackHash(code), "USAM", "DSAM", now)).toMatchObject({ approver: "sam", member: "USAM" });
    expect(state.bindings(ID.installation).map(one => one.approver)).toEqual(["alex", "sam"]);
    // alex cannot pair a second Slack identity; sam cannot pair alex's member id.
    const again = state.pairing(ID.installation, "alex", store.accountOf("alex")!.generation, now);
    expect(state.pair(ID, slackHash(again), "UALEX2", "DALEX2", now)).toBeNull();
    expect(receive("status")).toBe(true);
    await processSlackEvent(options);
    await drain();
    expect(String(sends().at(-1)?.args["channel"])).toBe(CHANNEL);
    expect(String(sends().at(-1)?.args["text"])).toContain("Recent work");
    expect(receive("/help", { user: "USAM", channel: "DSAM" })).toBe(true);
    await processSlackEvent(options);
    await drain();
    expect(String(sends().at(-1)?.args["channel"])).toBe("DSAM");
    expect(String(sends().at(-1)?.args["text"])).toContain("Toolroll in chat");
    expect(runner).not.toHaveBeenCalled();
    // Unpairing sam leaves alex's binding live.
    state.revokeBinding(state.bindingFor(ID.installation, "USAM")!, now);
    expect(state.bindings(ID.installation).map(one => one.approver)).toEqual(["alex"]);
    expect(receive("status", { user: "USAM", channel: "DSAM" })).toBe(false);
  });
  test("mark complete confirms behind a second tap in Slack and records the assignment check for the exact result", async () => {
    const { run } = ready();
    const who = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, projects);
    if (!who.ok) throw Error("who");
    const payload = prepareSharedAction(store, who.who, "result_accept", { task: "sample", run }, join(dir, "evidence"), now);
    draft({ ...payload });
    await drain();
    const c = latestCard();
    expect(String(sends().at(-1)?.args["text"])).toContain("Accept and finish: Clarify Slack progress");
    await tap(c.token, c.ts);
    const armed = sends().at(-1)!;
    expect(String(armed.args["text"])).toContain("This records that you handled this exact result. Confirm?");
    expect(JSON.stringify(armed.args["blocks"])).toContain("Yes, accept and finish");
    expect(assignmentOf(store, "sample", now, { principal: "operator", repos: projects }, join(dir, "evidence"))?.state).toBe("ready-to-check");
    const yes = state.db.prepare("SELECT token FROM slack_action WHERE part=? AND phase='yes' AND consumed IS NULL").get(c.id)!;
    await tap(String(yes.token), c.ts);
    expect(assignmentOf(store, "sample", now, { principal: "operator", repos: projects }, join(dir, "evidence"))).toMatchObject({ state: "complete", completion: { actor: "operator:alex" } });
    expect(store.proofAcceptance(run)).toBeNull();
    expect(String(sends().at(-1)?.args["text"])).toContain("Accepted and finished.");
    expect(store.getMateProposal(c.proposal)?.outcome).toMatchObject({ ok: true, via: "slack" });
  });


  test("a Slack channel follows a team conversation: a manager binds it with team 1, paired members' messages enter the shared queue, and replies and cards come back to the channel", async () => {
    const sam = addApprover(store, "sam", now, { name: "alex", token: password });
    if (!sam.ok) throw Error("sam");
    store.setNotificationPreference("sam", { mode: "all" }, "sam", now);
    const original = options.api;
    options = { ...options, api: vi.fn(async (method, args = {}) => {
      if (method === "users.info") return { user: { id: args.user, team_id: ID.team, deleted: false, is_bot: false } };
      if (method === "conversations.info") return { channel: { id: args.channel, is_im: true, user: args.channel === "DSAM" ? "USAM" : MEMBER } };
      return original(method, args);
    }) };
    const samCode = state.pairing(ID.installation, "sam", store.accountOf("sam")!.generation, now);
    expect(state.pair(ID, slackHash(samCode), "USAM", "DSAM", now)).not.toBeNull();
    const domain = new TeamLeads(store, () => projects);
    const actor = (name: string) => ({ name, generation: store.accountOf(name)!.generation });
    const lead = domain.execute(actor("alex"), { operation: "create-lead", args: { name: "Engineering", instructions: "Keep it simple.", projects } }, now);
    if (!lead.ok) throw Error(lead.message);
    const made = domain.execute(actor("alex"), { operation: "create-conversation", args: { leadId: (lead.result as { leadId: string }).leadId, title: "Website launch", visibility: "team", projects } }, now);
    if (!made.ok) throw Error(made.message);
    const conversation = (made.result as { conversationId: string }).conversationId, thread = (made.result as { threadId: number }).threadId;
    expect(domain.execute(actor("alex"), { operation: "member", args: { conversationId: conversation, account: "sam", role: "contributor", active: true, expectedRevision: 1, joinLead: true, expectedLeadRevision: 1 } }, now).ok).toBe(true);
    for (const name of ["alex", "sam"]) store.mintTeamMateSession({ approver: name, approverGeneration: actor(name).generation, thread, credentialKey: "fixture", ceilingMicrousd: 0, ceilingDigest: ceilingDigestOf(projects), termsDigest: "t".repeat(64) }, now);
    const ROOM = "CROOM";
    const inRoom = (text: string, user = MEMBER, ts = TS) => receive(text, { channel_type: "channel", channel: ROOM, user, ts });
    // A channel the app merely sits in: nothing is saved.
    expect(inRoom("hello?")).toBe(false);
    // sam (contributor) sees nothing to bind; alex (manager) binds.
    expect(inRoom("team", "USAM")).toBe(true);
    await processSlackEvent(options); await drain();
    expect(sends().at(-1)?.args).toMatchObject({ channel: ROOM });
    expect(String(sends().at(-1)?.args["text"])).toContain("No team conversation you manage");
    expect(inRoom("team 1")).toBe(true);
    await processSlackEvent(options); await drain();
    expect(String(sends().at(-1)?.args["text"])).toContain("This room now follows Website launch (lead Engineering)");
    expect(state.room(ID.installation, ROOM)).toMatchObject({ kind: "group", conversation, boundBy: "alex" });
    // sam's message in the channel is saved to the conversation as sam, once.
    expect(inRoom("Add a criterion for the footer", "USAM", "1789700000.000777")).toBe(true);
    await processSlackEvent(options); await drain();
    const queued = () => store.handle.prepare("SELECT q.author, q.request_id, m.text FROM team_message q JOIN mate_message m ON m.id = q.message WHERE q.conversation = ? ORDER BY q.message").all(conversation);
    expect(queued()).toEqual([{ author: "sam", request_id: expect.stringMatching(/^slack:CROOM:/), text: "Add a criterion for the footer" }]);
    expect(runner).not.toHaveBeenCalled();
    // The lead answers (the runtime's job, simulated); the next cycle carries the reply to the channel.
    const claim = domain.claimNext("fixture-runner", now)!;
    expect(domain.finish(claim, { status: "answered", text: "Added: the footer must show the current year." }, now)).toBe(true);
    await planSlackRooms(options); await drain();
    expect(sends().at(-1)?.args).toMatchObject({ channel: ROOM, text: "Added: the footer must show the current year." });
    // alex's browser message echoes with its author; sam's own Slack message never did.
    expect(domain.execute(actor("alex"), { operation: "send", args: { conversationId: conversation, requestId: "web-1", text: "Also check the phone layout." } }, now).ok).toBe(true);
    await planSlackRooms(options); await drain();
    expect(sends().at(-1)?.args).toMatchObject({ channel: ROOM, text: "alex: Also check the phone layout." });
    expect(sends().some(call => String(call.args["text"]).startsWith("sam:"))).toBe(false);
    const before = sends().length;
    await planSlackRooms(options); await drain();
    expect(sends().length).toBe(before);
    // /team off by a contributor changes nothing; by the manager it stops the room.
    expect(inRoom("team off", "USAM")).toBe(true);
    await processSlackEvent(options); await drain();
    expect(String(sends().at(-1)?.args["text"])).toBe("This room follows nothing you can change.");
    expect(inRoom("team off")).toBe(true);
    await processSlackEvent(options); await drain();
    expect(state.room(ID.installation, ROOM)).toBeNull();
  });

  test("a flow decision arrives with its draft and Approve / Edit / Send back; Edit takes the next message, and Approve decides it (v88)", async () => {
    now = new Date(now.getTime() + 30_000);
    const flow = store.createFlow({ repo, name: "Support", by: "alex", definitionJson: JSON.stringify(flowFromSteps([
      { title: "Inbox", kind: "inbox" },
      { id: "draft", title: "Write the reply", kind: "draft", instructions: "Reply to {{card.title}}" },
      { id: "check", title: "Check the reply", kind: "approval", decider: "owner", ifFails: "Write the reply" },
      { id: "post", title: "Post it", kind: "notify", message: "{{stage.draft}}" },
    ], null)) }, now);
    const card = store.addFlowCard({ flow, title: "Refund for order 42?", description: "Charged twice", stage: "check", by: "alex" }, now);
    store.updateFlowCard(card, { outputs: { draft: "Hi Priya,\nwe refunded it." } }, now);
    advanceFlows(store, repo, now);
    await planSlackNotifications(options);
    await drain();
    const flowPart = () => state.db.prepare("SELECT id, message FROM slack_part WHERE json_extract(payload,'$.flow') IS NOT NULL ORDER BY id DESC LIMIT 1").get()!;
    const buttonsOf = (call: { args: Record<string, unknown> }) =>
      ((call.args.blocks as Array<{ type: string; elements?: Array<{ text: { text: string }; value?: string; action_id: string }> }>).find(block => block.type === "actions")?.elements ?? []);
    const notice = sends().at(-1)!;
    // The draft as written, line break and all, with the three buttons and the link.
    expect(notice.method).toBe("chat.postMessage");
    expect(notice.args.thread_ts).toBeUndefined();
    expect(JSON.stringify(notice.args.blocks)).toContain("Hi Priya,\\nwe refunded it.");
    const first = buttonsOf(notice);
    expect(first.map(one => one.text.text)).toEqual(["Approve", "Edit", "Send back", "Open"]);
    const tokenOf = (buttons: typeof first, label: string) => buttons.find(one => one.text.text === label)!.value!;
    const press = async (id: string, token: string, ts: string) => {
      receiveSlack(state, ID, "interactive", { ...action(token, ts), message: {}, actions: [{ action_id: id, value: token, action_ts: `1789700001.${String(++serial).padStart(6, "0")}` }] }, now);
      await processSlackEvent(options);
      await drain();
    };
    const noticeTs = String(flowPart().message);
    // Edit: the next message is the draft; it comes back with fresh buttons.
    await press("standing_orders_flow_edit", tokenOf(first, "Edit"), noticeTs);
    expect(String(sends().at(-1)!.args.text)).toContain("as your next message here");
    expect(sends().at(-1)!.args.thread_ts).toBe(noticeTs);
    receive("Hi Priya, refunded today. Sorry!");
    await processSlackEvent(options);
    await drain();
    expect(store.getFlowCard(card)!.outputs["draft"]).toBe("Hi Priya, refunded today. Sorry!");
    const again = sends().at(-1)!;
    expect(JSON.stringify(again.args.blocks)).toContain("your version of the draft");
    // The first notice's buttons are spent; the new Approve decides it and the notice says so, without buttons.
    await press("standing_orders_flow_approve", tokenOf(first, "Approve"), noticeTs);
    expect(String(sends().at(-1)!.args.text)).toContain("already decided");
    expect(store.getFlowCard(card)!.stage).toBe("check");
    const fresh = buttonsOf(again);
    const againTs = String(flowPart().message);
    // Someone pressing on another message changes nothing.
    await press("standing_orders_flow_approve", tokenOf(fresh, "Approve"), noticeTs);
    expect(store.getFlowCard(card)!.stage).toBe("check");
    await press("standing_orders_flow_approve", tokenOf(fresh, "Approve"), againTs);
    expect(store.getFlowCard(card)!.stage).toBe("post");
    const repainted = sends().at(-1)!;
    expect(repainted).toMatchObject({ method: "chat.update", args: { ts: againTs } });
    expect(String(repainted.args.text)).toContain("✅ You approved it. Approved. Moved to Post it.");
    expect(buttonsOf(repainted).map(one => one.text.text)).toEqual(["Open"]);
    expect(store.flowComments(card).map(one => one.body)).toEqual(["Edited the draft in Slack."]);
  });

  test("Send to me arrives with its links; a choice brings the flow's own options, each its own button, and a tap moves the card once", async () => {
    now = new Date(now.getTime() + 30_000);
    const flow = store.createFlow({ repo, name: "Fixes", by: "alex", definitionJson: JSON.stringify(flowFromSteps([
      { id: "build", title: "Build", kind: "task" },
      { id: "tell", title: "Send me the result", kind: "send" },
      { id: "choose", title: "What next?", kind: "choose", options: [{ label: "Ship it", goesTo: "Ship" }, { label: "Later", goesTo: "Later" }, { label: "Ignore", goesTo: "end" }] },
      { id: "ship", title: "Ship", kind: "inbox" }, { id: "later", title: "Later", kind: "inbox" },
    ], null)) }, now);
    const card = store.addFlowCard({ flow, title: "Checkout rounding", description: "Totals are off by a cent", stage: "tell", by: "alex" }, now);
    advanceFlows(store, repo, now);
    advanceFlows(store, repo, now);
    expect(store.getFlowCard(card)!.stage).toBe("choose");
    await planSlackNotifications(options);
    await drain();
    const buttonsOf = (call: { args: Record<string, unknown> }) =>
      ((call.args.blocks as Array<{ type: string; elements?: Array<{ text: { text: string }; value?: string; action_id: string; url?: string }> }>).find(block => block.type === "actions")?.elements ?? []);
    const posted = sends().filter(one => one.method === "chat.postMessage");
    // The send: what was done (the card's details, as nothing was written down since), with its link.
    const sent = posted.find(one => JSON.stringify(one.args.blocks).includes("Totals are off by a cent") && !JSON.stringify(one.args.blocks).includes("Choose one"))!;
    expect(buttonsOf(sent).map(one => one.text.text)).toEqual(["Card"]);
    const choice = posted.find(one => JSON.stringify(one.args.blocks).includes("Choose one"))!;
    const buttons = buttonsOf(choice);
    expect(buttons.map(one => [one.text.text, one.action_id])).toEqual([["Ship it", "toolroll_flow_choose_0"], ["Later", "toolroll_flow_choose_1"], ["Ignore", "toolroll_flow_choose_2"], ["Card", "toolroll_link"]]);
    const ts = String(state.db.prepare("SELECT message FROM slack_part WHERE json_extract(payload,'$.choose') IS NOT NULL ORDER BY id DESC LIMIT 1").get()!.message);
    const press = async (token: string) => {
      receiveSlack(state, ID, "interactive", { ...action(token, ts), message: {}, actions: [{ action_id: "toolroll_flow_choose_1", value: token, action_ts: `1789700001.${String(++serial).padStart(6, "0")}` }] }, now);
      await processSlackEvent(options);
      await drain();
    };
    await press(buttons[1]!.value!);
    expect(store.getFlowCard(card)!.stage).toBe("later");
    expect(sends().at(-1)).toMatchObject({ method: "chat.update", args: { ts } });
    expect(String(sends().at(-1)!.args.text)).toContain("✅ You chose “Later”. Later. Moved to Later.");
    expect(buttonsOf(sends().at(-1)!).map(one => one.text.text)).toEqual(["Card"]);
    await press(buttons[0]!.value!);
    expect(String(sends().at(-1)!.args.text)).toContain("already chosen");
    expect(store.getFlowCard(card)!.stage).toBe("later");
    expect(store.flowEvents(card).at(-1)).toMatchObject({ actor: "alex", note: "Chose “Later” in Slack" });

    // A reply in the notice's thread is the note.
    const choiceTs = () => String(state.db.prepare("SELECT message FROM slack_part WHERE json_extract(payload,'$.choose') IS NOT NULL ORDER BY id DESC LIMIT 1").get()!.message);
    const replyInThread = async (text: string, thread: string) => {
      receive(text, { ts: `1789700200.${String(++serial).padStart(6, "0")}`, thread_ts: thread });
      await processSlackEvent(options);
      await drain();
    };
    const second = store.addFlowCard({ flow, title: "Header spacing", description: "Cramped on phones", stage: "choose", by: "alex" }, now);
    advanceFlows(store, repo, now);
    await planSlackNotifications(options);
    await drain();
    await replyInThread("Use 16px.", choiceTs());
    expect(store.getFlowCard(second)).toMatchObject({ stage: "build", note: "Use 16px." });
    expect(String(sends().at(-1)!.args.text)).toContain("↩️ Sent to Build with your note.");

    // Chosen in the console instead: the Slack buttons and the notice's thread are spent too, and nothing more is asked.
    const third = store.addFlowCard({ flow, title: "Old banner", description: "Remove the 2025 banner", stage: "choose", by: "alex" }, now);
    advanceFlows(store, repo, now);
    await planSlackNotifications(options);
    await drain();
    const thirdTs = choiceTs();
    const thirdButtons = buttonsOf(sends().filter(one => one.method === "chat.postMessage" && JSON.stringify(one.args.blocks).includes("Old banner")).at(-1)!);
    expect(chooseFlowCard(store, { card: third, choice: 0, note: null, actor: "alex", where: "Toolroll", repos: [repo] }, now)).toMatchObject({ ok: true });
    expect(state.db.prepare("SELECT count(*) AS n FROM slack_flow_choice WHERE card=? AND consumed IS NULL").get(third)!.n).toBe(0);
    receiveSlack(state, ID, "interactive", { ...action(thirdButtons[1]!.value!, thirdTs), message: {}, actions: [{ action_id: "toolroll_flow_choose_1", value: thirdButtons[1]!.value!, action_ts: `1789700001.${String(++serial).padStart(6, "0")}` }] }, now);
    await processSlackEvent(options);
    await drain();
    expect(String(sends().at(-1)!.args.text)).toContain("already chosen");
    await replyInThread("Keep it a week.", thirdTs);
    expect(String(sends().at(-1)!.args.text)).toContain("already made");
    expect(store.getFlowCard(third)).toMatchObject({ stage: "ship" });
  });

  test("a teammate's question arrives with its options and Answer in words; a tap answers it once, a stale tap changes nothing, and Answer in words takes the next message (v93)", async () => {
    now = new Date(now.getTime() + 30_000);
    const flow = store.createFlow({ repo, name: "Support", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }], null)) }, now);
    const mate = store.createTeammate({ repo, handle: "maya", soul: TEAMMATE_TEMPLATES[0]!.soul, model: null, manager: "alex", by: "alex" }, now);
    const ask = (title: string) => {
      const card = store.addFlowCard({ flow, title, description: null, stage: "inbox", by: "alex" }, now);
      const id = store.openTeammateQuestion({ teammate: mate, card, entry: 1, question: `Refund all of ${title}?`, options: [{ id: "o1", label: "Yes" }, { id: "o2", label: "Half" }], askedOf: "alex" }, now)!;
      notifyPeople(store, store.getFlowCard(card)!, ["alex"], null, { key: `teammate-q:${id}`, attention: true, subject: `Maya · Support asks about “${title}”`, body: "Over my $50 limit." }, now);
      return id;
    };
    const buttonsOf = (call: { args: Record<string, unknown> }) =>
      ((call.args.blocks as Array<{ type: string; elements?: Array<{ text: { text: string }; value?: string; action_id: string }> }>).find(block => block.type === "actions")?.elements ?? []);
    const partTs = () => String(state.db.prepare("SELECT message FROM slack_part WHERE json_extract(payload,'$.question') IS NOT NULL ORDER BY id DESC LIMIT 1").get()!.message);
    const press = async (id: string, token: string, ts: string) => {
      receiveSlack(state, ID, "interactive", { ...action(token, ts), message: {}, actions: [{ action_id: id, value: token, action_ts: `1789700001.${String(++serial).padStart(6, "0")}` }] }, now);
      await processSlackEvent(options);
      await drain();
    };
    const first = ask("order 42");
    await planSlackNotifications(options);
    await drain();
    const notice = sends().at(-1)!;
    expect(String(notice.args.text)).toContain("Maya · Support asks about “order 42”");
    const buttons = buttonsOf(notice);
    expect(buttons.map(one => one.text.text)).toEqual(["Yes", "Half", "Answer in words", "Open"]);
    const firstTs = partTs();
    // A tap on the wrong message changes nothing; the right one answers, once, and the notice says so without buttons.
    await press("standing_orders_question_choice", buttons[1]!.value!, "1789700999.000001");
    expect(store.teammateQuestion(first)!.state).toBe("open");
    await press("standing_orders_question_choice", buttons[1]!.value!, firstTs);
    expect(store.teammateQuestion(first)).toMatchObject({ state: "answered", choice: "o2", answeredBy: "alex", answeredVia: "slack" });
    const repainted = sends().at(-1)!;
    expect(repainted).toMatchObject({ method: "chat.update", args: { ts: firstTs } });
    expect(String(repainted.args.text)).toContain("✅ You answered: Half.");
    expect(buttonsOf(repainted).map(one => one.text.text)).toEqual(["Open"]);
    await press("standing_orders_question_choice", buttons[0]!.value!, firstTs);
    expect(store.teammateQuestion(first)!.choice).toBe("o2");
    // In words: the next message is the answer.
    const second = ask("order 43");
    await planSlackNotifications(options);
    await drain();
    const words = buttonsOf(sends().at(-1)!).find(one => one.text.text === "Answer in words")!;
    expect(words.action_id).toBe("toolroll_question_words");
    await press("standing_orders_question_words", words.value!, partTs());
    expect(String(sends().at(-1)!.args.text)).toContain("Your next message here is your answer");
    receive("Refund $50 and send a coupon for the rest.");
    await processSlackEvent(options);
    await drain();
    expect(store.teammateQuestion(second)).toMatchObject({ state: "answered", choice: null, answer: "Refund $50 and send a coupon for the rest.", answeredVia: "slack" });
    expect(String(sends().at(-1)!.args.text)).toContain("It picks the card up again now.");
  });

  test("the lead's question arrives with its options and Something else; a tap sends the option as the owner's next message, once", async () => {
    const buttonsOf = (call: { args: Record<string, unknown> }) =>
      ((call.args.blocks as Array<{ type: string; elements?: Array<{ text: { text: string }; value?: string; action_id: string }> }>).find(block => block.type === "actions")?.elements ?? []);
    const press = async (id: string, token: string, ts: string) => {
      receiveSlack(state, ID, "interactive", { ...action(token, ts), message: {}, actions: [{ action_id: id, value: token, action_ts: `1789700001.${String(++serial).padStart(6, "0")}` }] }, now);
      await processSlackEvent(options);
      await drain();
    };
    const asked = () => {
      const request = (runner as unknown as { mock: { calls: [{ history: { role: string; text?: string }[] }][] } }).mock.calls.at(-1)![0];
      return String(request.history.filter((one) => one.role === "operator").at(-1)?.text);
    };
    answers.push(
      { text: "", calls: [{ id: "q1", name: "ask_owner", args: { question: "Which page first?", options: ["Login", "Signup"] } }] },
      { text: "One choice changes the plan." },
    );
    expect(receive("Fix the sign-in pages")).toBe(true);
    await processSlackEvent(options);
    await drain();
    const question = sends().at(-1)!;
    expect(String(question.args.text)).toContain("Which page first?");
    const buttons = buttonsOf(question);
    expect(buttons.map(one => one.text.text)).toEqual(["Login", "Signup", "Something else"]);
    const askTs = String(state.db.prepare("SELECT message FROM slack_part WHERE json_extract(payload,'$.ask') IS NOT NULL ORDER BY id DESC LIMIT 1").get()!.message);
    // Something else asks for words and keeps the buttons.
    await press("toolroll_question_words", buttons[2]!.value!, askTs);
    expect(String(sends().at(-1)!.args.text)).toContain("Type your answer here");
    // A tap is the owner's next message: the lead reads "Login" as what they said.
    const turns = (runner as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    answers.push({ text: "Starting with the login page." });
    await press("toolroll_question_choice", buttons[0]!.value!, askTs);
    expect(sends().some(one => one.method === "chat.update" && one.args.ts === askTs && String(one.args.text).includes("You chose: Login") && buttonsOf(one).length === 0)).toBe(true);
    await processSlackEvent(options);
    await drain();
    expect((runner as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(turns + 1);
    expect(asked()).toBe("Login");
    expect(String(sends().at(-1)!.args.text)).toContain("Starting with the login page.");
    // A second tap changes nothing.
    await press("toolroll_question_choice", buttons[1]!.value!, askTs);
    await processSlackEvent(options);
    expect((runner as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(turns + 1);
  });

  test("the lead's question works in a thread of the owner's own chat, says expired when too old, and its buttons never block a purge", async () => {
    const buttonsOf = (call: { args: Record<string, unknown> }) =>
      ((call.args.blocks as Array<{ type: string; elements?: Array<{ text: { text: string }; value?: string; action_id: string }> }>).find(block => block.type === "actions")?.elements ?? []);
    const THREAD = "1789699999.000001";
    const press = async (token: string, ts: string) => {
      receiveSlack(state, ID, "interactive", { ...action(token, ts), message: { thread_ts: THREAD }, actions: [{ action_id: "toolroll_question_choice", value: token, action_ts: `1789700001.${String(++serial).padStart(6, "0")}` }] }, now);
      await processSlackEvent(options);
      await drain();
    };
    const askPart = () => state.db.prepare("SELECT id,message FROM slack_part WHERE json_extract(payload,'$.ask') IS NOT NULL ORDER BY id DESC LIMIT 1").get()!;
    // Asked in a thread: the buttons are drawn there, and a tap's answer comes back in the same thread.
    answers.push(
      { text: "", calls: [{ id: "q1", name: "ask_owner", args: { question: "Which page first?", options: ["Login", "Signup"] } }] },
      { text: "One choice changes the plan." },
    );
    expect(receive("Fix the sign-in pages", { thread_ts: THREAD })).toBe(true);
    await processSlackEvent(options);
    await drain();
    const question = sends().at(-1)!;
    expect(question.args.thread_ts).toBe(THREAD);
    const buttons = buttonsOf(question);
    expect(buttons.map(one => one.text.text)).toEqual(["Login", "Signup", "Something else"]);
    answers.push({ text: "Starting with the login page." });
    await press(buttons[0]!.value!, String(askPart().message));
    await processSlackEvent(options);
    await drain();
    expect(sends().at(-1)!.args).toMatchObject({ text: expect.stringContaining("Starting with the login page."), thread_ts: THREAD });
    // A question left past its time: the tap says it expired, not that it was answered, and sends nothing to the lead.
    answers.push(
      { text: "", calls: [{ id: "q2", name: "ask_owner", args: { question: "Which test first?", options: ["Unit", "Browser"] } }] },
      { text: "Pick one." },
    );
    expect(receive("Add tests", { ts: "1789700000.000201" })).toBe(true);
    await processSlackEvent(options);
    await drain();
    const second = askPart();
    const unit = buttonsOf(sends().at(-1)!)[0]!.value!;
    // A tap under a binding whose person is not the one the lead asked is ignored: nothing said, nothing used up.
    const binding = state.bindingFor(ID.installation, MEMBER)!;
    state.enqueue({ id: "other-approver-tap", installation: ID.installation, binding: binding.id, kind: "action", channel: CHANNEL, member: MEMBER, ts: String(second.message), thread: THREAD, payload: "{}", created: now.toISOString() });
    expect(store.transact(() => applyChatAskTap({ store, state }, state.event("other-approver-tap")!, { ...binding, approver: "sam" }, unit, now))).toBe(true);
    expect(state.db.prepare("SELECT COUNT(*) AS n FROM slack_part WHERE event='other-approver-tap'").get()!.n).toBe(0);
    expect(state.event("other-approver-tap")!.state).toBe("done");
    expect(chatAskButtons(state, Number(second.id), now)).toHaveLength(3);
    // Answered by typing within the day: a tap repaints the question once, without its buttons, under its own time.
    const created = String(state.db.prepare("SELECT created FROM slack_part WHERE id=?").get(Number(second.id))!.created);
    answers.push({ text: "Unit first, then." });
    expect(receive("Unit", { ts: "1789700000.000202", thread_ts: THREAD })).toBe(true);
    await processSlackEvent(options);
    await drain();
    const asking = (runner as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    let sent = sends().length;
    await press(unit, String(second.message));
    expect(sends().slice(sent)).toMatchObject([{ method: "chat.update", args: { ts: String(second.message), text: expect.stringContaining("This question was already answered.") } }]);
    expect(buttonsOf(sends().at(-1)!)).toEqual([]);
    expect(state.db.prepare("SELECT created FROM slack_part WHERE id=?").get(Number(second.id))!.created).toBe(created);
    // A later tap (a stale card) edits nothing more and posts nothing.
    sent = sends().length;
    await press(unit, String(second.message));
    expect(sends().slice(sent)).toEqual([]);
    expect((runner as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(asking);
    // A question left past its time is too old to edit: the first tap says it expired once, in the thread; later taps say nothing.
    answers.push(
      { text: "", calls: [{ id: "q3", name: "ask_owner", args: { question: "Which browser first?", options: ["Safari", "Chrome"] } }] },
      { text: "Pick one." },
    );
    expect(receive("Add browser tests", { ts: "1789700000.000203" })).toBe(true);
    await processSlackEvent(options);
    await drain();
    const third = askPart();
    const safari = buttonsOf(sends().at(-1)!)[0]!.value!;
    const before = (runner as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    now = new Date(now.getTime() + MATE_ASK_TTL_MS);
    state.lease(ID.installation, "test", now);
    sent = sends().length;
    await press(safari, String(third.message));
    expect(sends().slice(sent)).toMatchObject([{ method: "chat.postMessage", args: { text: "This question expired. If it still matters, send your answer as a message.", thread_ts: THREAD } }]);
    sent = sends().length;
    await press(safari, String(third.message));
    expect(sends().slice(sent)).toEqual([]);
    await processSlackEvent(options);
    expect((runner as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(before);
    // Deleting a part (and the turn) is never blocked by its buttons.
    expect(Number(state.db.prepare("SELECT COUNT(*) AS n FROM slack_ask_action WHERE part=?").get(Number(second.id))!.n)).toBe(3);
    state.db.prepare("DELETE FROM slack_part WHERE id=?").run(Number(second.id));
    expect(Number(state.db.prepare("SELECT COUNT(*) AS n FROM slack_ask_action WHERE part=?").get(Number(second.id))!.n)).toBe(0);
  });

  test("in a room the lead's question has no buttons: a tap there would not be the owner's own message", () => {
    const binding = state.bindingFor(ID.installation, MEMBER)!;
    state.enqueue({ id: "room-event", installation: ID.installation, binding: binding.id, kind: "message", channel: "CROOM", member: MEMBER, ts: TS, thread: TS, payload: JSON.stringify({ text: "hi" }), created: now.toISOString() });
    state.plan("room-event", [{ text: "Which page first?", ask: { turn: 1, options: ["Login", "Signup"] } }], now);
    const part = Number(state.db.prepare("SELECT id FROM slack_part WHERE event='room-event'").get()!.id);
    expect(chatAskButtons(state, part, now)).toEqual([]);
    state.enqueue({ id: "dm-event", installation: ID.installation, binding: binding.id, kind: "message", channel: CHANNEL, member: MEMBER, ts: TS, thread: TS, payload: JSON.stringify({ text: "hi" }), created: now.toISOString() });
    state.plan("dm-event", [{ text: "Which page first?", ask: { turn: 1, options: ["Login", "Signup"] } }], now);
    const own = Number(state.db.prepare("SELECT id FROM slack_part WHERE event='dm-event'").get()!.id);
    expect(chatAskButtons(state, own, now).map(one => one.label)).toEqual(["Login", "Signup", "Something else"]);
  });

  test("a message to a teammate by name lands on its desk instead of the lead, and its answer comes back in Slack (v96)", async () => {
    now = new Date(now.getTime() + 30_000);
    store.createTeammate({ repo, handle: "maya", soul: TEAMMATE_TEMPLATES[0]!.soul, model: null, manager: "alex", by: "alex" }, now);
    const turnsBefore = Number(store.handle.prepare("SELECT COUNT(*) AS n FROM mate_turn").get()!.n);
    receive("@maya where's order 2201?");
    await processSlackEvent(options);
    await drain();
    expect(String(sends().at(-1)!.args.text)).toContain("Maya has it. The answer comes here when it's done.");
    const desk = store.listFlows([repo]).find(one => one.name === "Maya's desk")!;
    const [card] = store.flowCards(desk.id, false);
    expect(card).toMatchObject({ title: "where's order 2201?", createdBy: "alex", source: { kind: "message", label: "Slack message" } });
    expect(Number(store.handle.prepare("SELECT COUNT(*) AS n FROM mate_turn").get()!.n)).toBe(turnsBefore);
    replyToAsker(store, desk, card!, store.teammateByHandle(repo, "maya")!, "Order 2201 shipped yesterday.", now);
    await planSlackNotifications(options);
    await drain();
    expect(String(sends().at(-1)!.args.text)).toContain("Maya · Support: where's order 2201?");
    expect(String(sends().at(-1)!.args.text)).toContain("Order 2201 shipped yesterday.");
    // Not addressed to a teammate ("Maya can …"), it still goes to the lead.
    expect(messageTeammateWords("Maya can refund up to $100 now")).toBeNull();
  });

  test("a Slack channel feeds a flow: 'flow N' from a paired approver connects it, anyone's message is a card, a thread reply joins it, and an Update zone answers in the thread (v89)", async () => {
    now = new Date(now.getTime() + 30_000);
    const flow = store.createFlow({ repo, name: "Requests", by: "alex", definitionJson: JSON.stringify(flowFromSteps([
      { title: "Inbox", kind: "inbox" },
      { id: "answer", title: "Answer", kind: "update", message: "Thanks, we're on it: {{card.title}}" },
    ], null)) }, now);
    const ROOM = "CREQ", MSG = "1789700100.000001";
    const inRoom = (text: string, user = MEMBER, ts = TS, extra: Record<string, unknown> = {}) => receive(text, { channel_type: "channel", channel: ROOM, user, ts, ...extra });
    // Not connected: nothing in the channel is saved; only a paired approver's words connect it.
    expect(inRoom("Need a new laptop", "UOTHER", MSG)).toBe(false);
    expect(inRoom(`flow ${flow}`, "UOTHER")).toBe(false);
    expect(inRoom(`<@UBOT> flow ${flow}`)).toBe(true);
    await processSlackEvent(options); await drain();
    expect(sends().at(-1)!.args).toMatchObject({ channel: ROOM });
    expect(String(sends().at(-1)!.args.text)).toContain("This channel now feeds Requests");
    expect(store.flowTriggers(flow).map(one => [one.kind, one.state])).toEqual([["chat", "active"]]);
    // Anyone's message there is a card; the bot says so in the message's thread, with a link to it.
    expect(inRoom("Need a new laptop\nMine died this morning.", "UOTHER", MSG)).toBe(true);
    await processSlackEvent(options); await drain();
    const card = store.flowCards(flow, true)[0]!;
    expect(card).toMatchObject({ title: "Need a new laptop", description: "Need a new laptop\nMine died this morning.", stage: "inbox", createdBy: "Slack",
      source: { kind: "chat", label: "Slack message", chat: { app: "slack", chat: ROOM, conversation: ROOM, thread: MSG } } });
    expect(sends().at(-1)!.args).toMatchObject({ channel: ROOM, thread_ts: MSG });
    expect(String(sends().at(-1)!.args.text)).toContain("Added to Requests as a card.");
    expect(JSON.stringify(sends().at(-1)!.args.blocks)).toContain(`https://console.example/flows/${flow}?card=${card.id}`);
    // A reply in that thread joins the card's discussion, and the bot stays quiet.
    const before = sends().length;
    expect(inRoom("It's the Dell from 2023.", "UOTHER", "1789700100.000002", { thread_ts: MSG })).toBe(true);
    await processSlackEvent(options); await drain();
    expect(store.flowComments(card.id).map(one => [one.author, one.body])).toEqual([["someone (Slack)", "It's the Dell from 2023."]]);
    expect(sends().length).toBe(before);
    // An Update zone answers in the thread the card came from.
    store.moveFlowCard(card.id, { to: "answer", outcome: "moved", actor: "alex" }, now);
    const pass = await runFlowSteps(store, repo, now, { gh: exec, git: exec, shell: exec, fetch, dir, scratch: join(dir, "scratch"), base: "main" });
    expect(pass).toEqual({ ran: 1, problems: [] });
    await drain();
    expect(sends().at(-1)!).toMatchObject({ method: "chat.postMessage", args: { channel: ROOM, thread_ts: MSG, text: "Thanks, we're on it: Need a new laptop" } });
    expect(store.getFlowCard(card.id)!.outputs["answer"]).toBe("Answered in the Slack thread.");
    // "flow off" stops it; after that the channel is quiet again.
    expect(inRoom("flow off")).toBe(true);
    await processSlackEvent(options); await drain();
    expect(String(sends().at(-1)!.args.text)).toBe("This channel no longer feeds Requests.");
    expect(inRoom("Another request", "UOTHER", "1789700100.000003")).toBe(false);
  });

  test("Send back takes the next message as the note, and cancel leaves the card where it is (v88)", async () => {
    now = new Date(now.getTime() + 30_000);
    const flow = store.createFlow({ repo, name: "Support", by: "alex", definitionJson: JSON.stringify(flowFromSteps([
      { title: "Inbox", kind: "inbox" },
      { id: "draft", title: "Write the reply", kind: "draft", instructions: "Reply to {{card.title}}" },
      { id: "check", title: "Check the reply", kind: "approval", decider: "owner", ifFails: "Write the reply" },
      { id: "post", title: "Post it", kind: "notify", message: "{{stage.draft}}" },
    ], null)) }, now);
    const card = store.addFlowCard({ flow, title: "Refund for order 42?", description: null, stage: "check", by: "alex" }, now);
    store.updateFlowCard(card, { outputs: { draft: "We refunded it." } }, now);
    advanceFlows(store, repo, now);
    await planSlackNotifications(options);
    await drain();
    const ts = String(state.db.prepare("SELECT message FROM slack_part WHERE json_extract(payload,'$.flow') IS NOT NULL").get()!.message);
    const token = String(state.db.prepare("SELECT token FROM slack_flow_action WHERE action='send-back'").get()!.token);
    const press = async () => {
      receiveSlack(state, ID, "interactive", { ...action(token, ts), message: {}, actions: [{ action_id: "standing_orders_flow_send_back", value: token, action_ts: `1789700001.${String(++serial).padStart(6, "0")}` }] }, now);
      await processSlackEvent(options);
      await drain();
    };
    await press();
    expect(String(sends().at(-1)!.args.text)).toContain("goes back to Write the reply");
    receive("cancel");
    await processSlackEvent(options);
    await drain();
    expect(String(sends().at(-1)!.args.text)).toContain("Left it where it is");
    expect(store.getFlowCard(card)!.stage).toBe("check");
    await press();
    receive("Mention the 5-day wait.");
    await processSlackEvent(options);
    await drain();
    expect(store.getFlowCard(card)).toMatchObject({ stage: "draft", note: "Mention the 5-day wait." });
    expect(String(sends().at(-1)!.args.text)).toBe("↩️ Sent back to Write the reply with your note.");
  });

});

test("Socket Mode validates the app on every hello and preserves Slack's real envelope shape", async () => {
  class Inspectable extends ToolrollSlackSocket {
    receive(packet: unknown) {
      return this.onWebSocketMessage(JSON.stringify(packet), false);
    }
  }
  const socket = new Inspectable({
    appToken: "xapp-fixture-private-token",
    autoReconnectEnabled: false,
  });
  socket.expectedApp = "ATEST";
  const connected = vi.fn(),
    wrong = vi.fn(),
    envelope = vi.fn();
  socket.on("connected", connected);
  socket.on("slack_event", envelope);
  socket.wrongApp = wrong;
  await socket.receive({ type: "hello", connection_info: { app_id: "ATEST" } });
  expect(connected).toHaveBeenCalledTimes(1);
  await socket.receive({
    type: "events_api",
    envelope_id: "envelope",
    payload: {
      api_app_id: "ATEST",
      team_id: "TTEST",
      event: { type: "message", text: "hello" },
    },
  });
  expect(envelope).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "events_api",
      body: expect.objectContaining({ team_id: "TTEST" }),
      ack: expect.any(Function),
    }),
  );
  await socket.receive({
    type: "hello",
    connection_info: { app_id: "AOTHER" },
  });
  expect(wrong).toHaveBeenCalledTimes(1);
  expect(connected).toHaveBeenCalledTimes(1);
  await socket.disconnect();
});

test("Slack wire errors omit secrets, honor Retry-After, and never follow upload redirects", async () => {
  const api = slackApi("xoxb-private", async (_url, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer xoxb-private",
    );
    expect(init?.redirect).toBe("error");
    return new Response("", { status: 429, headers: { "Retry-After": "23" } });
  });
  await expect(api("chat.postMessage", {})).rejects.toMatchObject({
    code: "ratelimited",
    retryMs: 23000,
  });
  const unknown = slackApi(
    "xoxb-private",
    async () =>
      new Response(JSON.stringify({ ok: false, error: "xoxb-private" })),
  );
  await expect(unknown("auth.test")).rejects.not.toThrow("xoxb-private");
  const fetcher = vi.fn();
  await expect(
    uploadSlackBytes(
      "https://evil.example/upload",
      new Uint8Array([1]),
      fetcher,
    ),
  ).rejects.toThrow("invalid upload");
  expect(fetcher).not.toHaveBeenCalled();
  const blocks = slackBlocks("Result\n<!channel> <https://evil.example|click>");
  expect(JSON.stringify(blocks)).not.toContain('"mrkdwn"');

});
