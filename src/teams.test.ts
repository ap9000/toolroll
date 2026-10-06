/** Microsoft Teams on the shared chat layer: a proved Bot Framework token,
 * activities saved before the acknowledgement, pairing per person, cards
 * with submit tokens, rooms that follow a team conversation. Scripted
 * fetchers only; no network. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { ChatState, chatHash } from "./chat-delivery-state.js";
import { createDecisionServer } from "./serve.js";
import { checkTeamsCredentials, forgetTeamsKeys, forgetTeamsToken, saveTeamsCredentials, teamsIdentity, verifyTeamsToken, type TeamsApi, type TeamsCredentials } from "./teams-api.js";
import { deliverTeamsPart, planTeamsNotifications, planTeamsRooms, processTeamsEvent, receiveTeams, type TeamsChatOptions } from "./teams-chat.js";
import { flowFromSteps } from "./flows.js";
import { PLATFORM_LIMITS } from "./text-limits.js";
import { advanceFlows } from "./flow-engine.js";
import { prepareSharedAction } from "./chat-actions.js";
import { resolveChannelMate } from "./chat-channel.js";
import { verifyApproverStanding, ceilingDigestOf } from "./principal.js";
import { assignmentOf } from "./assignment.js";
import { TeamLeads } from "./team-leads.js";

const APP = "11111111-2222-4333-8444-555555555555", TENANT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", SECRET = "secret-value-for-tests-1234567890";
const SERVICE = "https://smba.trafficmanager.net/teams/";
const ALEX = "29:1alex-user-id-xxxxxxxxxxxxxx", SAM = "29:1sam-user-id-yyyyyyyyyyyyyy";
const DM_ALEX = "a:1dm-alex-conversation-id", DM_SAM = "a:1dm-sam-conversation-id", CHANNEL = "19:room-channel-id@thread.tacv2";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");
function token(claims: Record<string, unknown>, kid = "kid-1"): string {
  const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid })), body = b64(JSON.stringify({ iss: "https://api.botframework.com", aud: APP, exp: Math.floor(Date.now() / 1000) + 600, serviceurl: SERVICE, ...claims }));
  const signature = signBytes("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey);
  return `Bearer ${head}.${body}.${b64(signature)}`;
}
const scriptedFetch = (extra: (url: string, init?: RequestInit) => Response | null = () => null): typeof fetch => (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const custom = extra(url, init);
  if (custom !== null) return custom;
  if (url.startsWith("https://login.microsoftonline.com/")) return Response.json({ access_token: "bot-token", expires_in: 3600 });
  if (url.endsWith("/keys")) return Response.json({ keys: [{ kty: "RSA", kid: "kid-1", n: jwk.n, e: jwk.e }] });
  if (url.startsWith("https://login.botframework.com/")) return Response.json({ jwks_uri: "https://login.botframework.com/v1/.well-known/keys" });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

describe("Teams shared chat", () => {
  let dir: string, repo: string, store: Store, state: ChatState, now: Date, password: string, credentials: TeamsCredentials, projects: string[];
  let calls: Array<{ method: string; serviceUrl: string; path: string; body?: Record<string, unknown> }>, answers: Array<{ text: string; calls?: Array<{ id: string; name: string; args: Record<string, unknown> }> }>;
  let options: TeamsChatOptions, ids = 0;
  const api: TeamsApi = async (method, serviceUrl, path, body) => {
    calls.push({ method, serviceUrl, path, ...(body ? { body } : {}) });
    if (method === "GET") { const member = path.split("/members/")[1]; return { id: decodeURIComponent(member ?? "") }; }
    return { id: `act-${++ids}` };
  };
  const activity = (conversation: string, from: string, text: string, extra: Record<string, unknown> = {}) => ({
    type: "message", id: `in-${++ids}`, serviceUrl: SERVICE, text, from: { id: from }, recipient: { id: `28:${APP}` },
    conversation: { id: conversation, conversationType: conversation === CHANNEL ? "channel" : "personal", tenantId: TENANT }, ...extra,
  });
  const receive = (raw: unknown) => receiveTeams(state, credentials, raw, SERVICE, now);
  const sends = () => calls.filter(call => call.method !== "GET");
  const lastText = () => { const body = sends().at(-1)?.body ?? {}; const card = (body.attachments as { content?: { body?: { text?: string }[] } }[] | undefined)?.[0]?.content?.body?.[0]?.text; return String(card ?? body.text ?? ""); };
  const lastActions = () => ((sends().at(-1)?.body?.attachments as { content?: { actions?: Record<string, unknown>[] } }[] | undefined)?.[0]?.content?.actions ?? []);
  async function drain() { for (let i = 0; i < 20 && (await deliverTeamsPart(options)); i++); }
  const pairAs = (who: string, member: string, conversation: string) => {
    const code = state.pairing(credentials.installation, who, store.accountOf(who)!.generation, now);
    state.setMeta(credentials.installation, `serviceUrl:${conversation}`, SERVICE, now);
    return state.pair(credentials, chatHash(code), member, conversation, now);
  };
  /** A pending card on alex's own Teams thread, planned as a part, without a model turn. */
  function draft(payload: Record<string, unknown>) {
    const binding = state.bindingFor(credentials.installation, ALEX)!;
    const resolved = resolveChannelMate(store, { approver: binding.approver, approverGeneration: binding.generation }, projects, now);
    if (!resolved.ok) throw Error("session");
    const opened = store.openMateTurn({ approver: "alex", session: resolved.session.id, thread: resolved.thread.id, credentialKey: resolved.session.credentialKey, reservedMicrousd: 0, dailyTurns: 50, weeklyCeilingMicrousd: 0, deadlineMs: 60000 }, now);
    if (!opened.ok) throw Error("turn");
    const started = store.startMateTurn(opened.id, now); if (!started.ok) throw Error("start");
    const id = store.draftMateProposal({ thread: resolved.thread.id, turn: opened.id, kind: "action", payload, ceilingDigest: resolved.who.ceilingDigest }, now);
    store.finalizeMateTurn(opened.id, started.generation, { state: "answered", settledMicrousd: 0, tokensIn: 1, tokensOut: 1 }, now);
    const event = chatHash(`card${++ids}`);
    state.enqueue({ id: event, installation: credentials.installation, binding: binding.id, kind: "message", channel: DM_ALEX, member: ALEX, ts: "x", thread: "x", payload: "{}", created: now.toISOString() });
    state.plan(event, [{ text: "", proposal: id }], now);
    return id;
  }

  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-teams-")));
    repo = join(dir, "repo"); mkdirSync(repo); mkdirSync(join(dir, "evidence"));
    execFileSync("git", ["init", "-q", repo]); writeFileSync(join(repo, "README.md"), "Synthetic Teams test\n");
    execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "seed"]);
    store = openStore(join(dir, "state.db")); state = new ChatState(store, "teams");
    now = new Date("2026-09-21T21:00:00Z"); calls = []; answers = []; projects = [repo]; ids = 0;
    forgetTeamsToken(); forgetTeamsKeys();
    const alex = addApprover(store, "alex", now); if (!alex.ok) throw Error("alex"); password = alex.token;
    // Every step: these journeys prove the per-step behaviour quiet chat keeps for people who choose it.
    store.setNotificationPreference("alex", { mode: "all" }, "alex", now);
    for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", now);
    store.setChatConfig({ provider: "claude-subscription", model: "default", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, "alex", now);
    credentials = await checkTeamsCredentials(APP, TENANT, SECRET, scriptedFetch());
    saveTeamsCredentials(dir, credentials);
    options = { store, identity: credentials, api, owner: "test", current: () => true, readProjects: async () => projects, evidenceRoot: join(dir, "evidence"), origin: () => "https://console.example", clock: () => now,
      subscriptionRunner: vi.fn(async () => { const answer = answers.shift(); if (!answer) throw Error("No scripted answer"); return { ok: true, answer: { text: answer.text, calls: answer.calls ?? [], tokensIn: 10, tokensOut: 5, reportedCostMicrousd: null } }; }) };
    state.lease(credentials.installation, "test", now);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  test("credentials shape one installation; the inbound token is proved against the published key, issuer, audience, expiry and service URL", async () => {
    expect(credentials).toMatchObject(teamsIdentity(APP, TENANT));
    expect(credentials.bot).toBe(`28:${APP}`);
    const fetcher = scriptedFetch();
    expect(await verifyTeamsToken(token({}), APP, fetcher)).toEqual({ appId: APP, serviceUrl: SERVICE });
    expect(await verifyTeamsToken(token({ aud: "other-app" }), APP, fetcher)).toBeNull();
    expect(await verifyTeamsToken(token({ iss: "https://evil.example" }), APP, fetcher)).toBeNull();
    expect(await verifyTeamsToken(token({ exp: Math.floor(Date.now() / 1000) - 3600 }), APP, fetcher)).toBeNull();
    expect(await verifyTeamsToken(token({}, "unknown-kid"), APP, fetcher)).toBeNull();
    const tampered = token({}).replace(/\.[^.]+$/, ".AAAA");
    expect(await verifyTeamsToken(tampered, APP, fetcher)).toBeNull();
    expect(await verifyTeamsToken(undefined, APP, fetcher)).toBeNull();
  });

  test("the receiver saves a proved activity before answering 200 and rejects a stranger's token; activities never store the bearer token", async () => {
    const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repos: projects, configDir: dir, teamsFetcher: scriptedFetch() });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address !== "object") throw Error("listen");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const post = (auth: string | undefined, body: unknown) => fetch(`${base}/teams/messages`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) });
      expect((await post(undefined, activity(DM_ALEX, ALEX, "hello"))).status).toBe(401);
      expect((await post(token({ aud: "other" }), activity(DM_ALEX, ALEX, "hello"))).status).toBe(401);
      const code = state.pairing(credentials.installation, "alex", store.accountOf("alex")!.generation, now);
      expect((await post(token({}), activity(DM_ALEX, ALEX, `pair ${code}`))).status).toBe(200);
      const events = state.prepare("SELECT * FROM chat_event").all();
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain(code);
      expect(JSON.stringify(events)).not.toContain("Bearer");
      // A token whose service URL differs from the activity's is refused.
      expect((await post(token({ serviceurl: "https://other.example/" }), activity(DM_ALEX, ALEX, "hello"))).status).toBe(200);
      expect(state.prepare("SELECT count(*) n FROM chat_event").get()?.n).toBe(1);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  test("each teammate pairs their own Teams account, commands answer without a model, and a card confirms Mark complete behind a second tap", async () => {
    const sam = addApprover(store, "sam", now, { name: "alex", token: password }); if (!sam.ok) throw Error("sam");
    store.setNotificationPreference("sam", { mode: "all" }, "sam", now);
    const code = state.pairing(credentials.installation, "alex", store.accountOf("alex")!.generation, now);
    expect(receive(activity(DM_ALEX, ALEX, `pair ${code}`))).toBe(true);
    await processTeamsEvent(options); await drain();
    expect(lastText()).toContain("Connected to Toolroll");
    expect(sends().at(-1)?.path).toBe(`/v3/conversations/${encodeURIComponent(DM_ALEX)}/activities`);
    expect(pairAs("sam", SAM, DM_SAM)).not.toBeNull();
    expect(state.bindings(credentials.installation).map(one => one.approver)).toEqual(["alex", "sam"]);
    expect(receive(activity(DM_SAM, SAM, "status"))).toBe(true);
    await processTeamsEvent(options); await drain();
    expect(sends().at(-1)?.path).toContain(encodeURIComponent(DM_SAM));
    expect(lastText()).toContain("Recent work");
    expect(options.subscriptionRunner).not.toHaveBeenCalled();
    // A Ready result and a Mark complete card for alex.
    store.createTask({ id: "sample", title: "Clear Teams progress" }, now);
    const ref = store.refFor("built-in", "sample").id; store.placeTask(ref, repo);
    propose(store, { taskId: "sample", goal: "Clear progress", touches: ["src/a.ts"], acceptance: [{ id: "c1", statement: "Progress is clear", how: null, evidence: ["check"] }], now });
    const scope = store.getScope("sample")!;
    expect(approve(store, "sample", "alex", now, scope.digest, password).ok).toBe(true);
    const route = store.routeAuthorityFor(ref, "builder", null); if (!route?.ok) throw Error("route");
    const run = store.startRun({ taskRef: ref, leaseId: "l", runner: "fixture", branch: "fixture", worktree: repo, route: route.stamp, now });
    store.stampRun(run, { scopeDigest: scope.digest, baseRevision: "b".repeat(40) });
    store.recordOutcomeFacts(run, { headRevision: "a".repeat(40), handoff: "Done." });
    store.finishRun(run, { outcome: "built", committed: true, now });
    store.setTaskState("sample", "done", now);
    const who = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, projects); if (!who.ok) throw Error("who");
    const payload = prepareSharedAction(store, who.who, "result_accept", { task: "sample", run }, join(dir, "evidence"), now);
    const proposal = draft({ ...payload });
    await drain();
    expect(lastText()).toContain("Accept and finish: Clear Teams progress");
    const confirm = lastActions().find(action => action.title === "Confirm")!;
    const cardId = String(state.prepare("SELECT message FROM chat_part WHERE json_extract(payload,'$.proposal')=?").get(proposal)?.message);
    const tap = (data: Record<string, unknown>) => receive({ type: "message", id: `tap-${++ids}`, serviceUrl: SERVICE, from: { id: ALEX }, recipient: { id: `28:${APP}` }, conversation: { id: DM_ALEX, conversationType: "personal", tenantId: TENANT }, replyToId: cardId, value: data });
    // A button whose data Toolroll didn't make is answered with why; a stale one says so; neither does anything.
    expect(tap({ so: "not-a-token" })).toBe(true);
    await processTeamsEvent(options); await drain();
    expect(lastText()).toBe("That button couldn't be read (value.so: must be a Toolroll button token). Nothing was done.");
    expect(tap({ ...(confirm as { data: Record<string, unknown> }).data, extra: 1 })).toBe(true);
    await processTeamsEvent(options); await drain();
    expect(lastText()).toContain("value: unknown key 'extra'");
    expect(tap({ so: "0".repeat(32) })).toBe(true);
    await processTeamsEvent(options); await drain();
    expect(lastText()).toContain("That button expired or was already used.");
    expect(store.getMateProposal(proposal)?.state).toBe("pending");
    expect(tap((confirm as { data: Record<string, unknown> }).data)).toBe(true);
    await processTeamsEvent(options); await drain();
    expect(lastText()).toContain("This records that you handled this exact result. Confirm?");
    const yes = lastActions().find(action => action.title === "Yes, accept and finish")!;
    expect(tap((yes as { data: Record<string, unknown> }).data)).toBe(true);
    await processTeamsEvent(options); await drain();
    expect(lastText()).toContain("Accepted and finished.");
    expect(assignmentOf(store, "sample", now, { principal: "operator", repos: projects }, join(dir, "evidence"))).toMatchObject({ state: "complete", completion: { actor: "operator:alex" } });
    expect(store.getMateProposal(proposal)?.outcome).toMatchObject({ ok: true, via: "teams" });
    expect(store.proofAcceptance(run)).toBeNull();
  });

  test("a Teams channel follows a team conversation: the manager binds it, members' mentions enter the shared queue, and replies come back", async () => {
    const sam = addApprover(store, "sam", now, { name: "alex", token: password }); if (!sam.ok) throw Error("sam");
    store.setNotificationPreference("sam", { mode: "all" }, "sam", now);
    expect(pairAs("alex", ALEX, DM_ALEX)).not.toBeNull();
    expect(pairAs("sam", SAM, DM_SAM)).not.toBeNull();
    const domain = new TeamLeads(store, () => projects);
    const actor = (name: string) => ({ name, generation: store.accountOf(name)!.generation });
    const lead = domain.execute(actor("alex"), { operation: "create-lead", args: { name: "Engineering", instructions: "Keep it simple.", projects } }, now); if (!lead.ok) throw Error(lead.message);
    const made = domain.execute(actor("alex"), { operation: "create-conversation", args: { leadId: (lead.result as { leadId: string }).leadId, title: "Website launch", visibility: "team", projects } }, now); if (!made.ok) throw Error(made.message);
    const conversation = (made.result as { conversationId: string }).conversationId, thread = (made.result as { threadId: number }).threadId;
    expect(domain.execute(actor("alex"), { operation: "member", args: { conversationId: conversation, account: "sam", role: "contributor", active: true, expectedRevision: 1, joinLead: true, expectedLeadRevision: 1 } }, now).ok).toBe(true);
    for (const name of ["alex", "sam"]) store.mintTeamMateSession({ approver: name, approverGeneration: actor(name).generation, thread, credentialKey: "fixture", ceilingMicrousd: 0, ceilingDigest: ceilingDigestOf(projects), termsDigest: "t".repeat(64) }, now);
    expect(receive(activity(CHANNEL, ALEX, "<at>Toolroll</at> hello?"))).toBe(false);
    expect(receive(activity(CHANNEL, ALEX, "<at>Toolroll</at> team 1"))).toBe(true);
    await processTeamsEvent(options); await drain();
    expect(sends().at(-1)?.path).toBe(`/v3/conversations/${encodeURIComponent(CHANNEL)}/activities`);
    expect(lastText()).toContain("This room now follows Website launch (lead Engineering)");
    expect(receive(activity(CHANNEL, SAM, "<at>Toolroll</at> Add a criterion for the footer"))).toBe(true);
    await processTeamsEvent(options); await drain();
    const queued = store.handle.prepare("SELECT q.author, q.request_id, m.text FROM team_message q JOIN mate_message m ON m.id = q.message WHERE q.conversation = ? ORDER BY q.message").all(conversation);
    expect(queued).toEqual([{ author: "sam", request_id: expect.stringMatching(/^teams:19:/), text: "Add a criterion for the footer" }]);
    const claim = domain.claimNext("fixture-runner", now)!;
    expect(domain.finish(claim, { status: "answered", text: "Added: the footer must show the current year." }, now)).toBe(true);
    await planTeamsRooms(options); await drain();
    expect(sends().at(-1)?.path).toBe(`/v3/conversations/${encodeURIComponent(CHANNEL)}/activities`);
    expect(lastText()).toBe("Added: the footer must show the current year.");
    expect(receive(activity(CHANNEL, ALEX, "<at>Toolroll</at> team off"))).toBe(true);
    await processTeamsEvent(options); await drain();
    expect(state.room(credentials.installation, CHANNEL)).toBeNull();
  });

  test("a Teams channel feeds a flow: a mention with 'flow N' connects it, a mention in the channel is a card, and the bot answers in that thread (v89)", async () => {
    expect(pairAs("alex", ALEX, DM_ALEX)).not.toBeNull();
    now = new Date(now.getTime() + 30_000);
    const flow = store.createFlow({ repo, name: "Requests", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }], null)) }, now);
    const OTHER = "29:1other-user-id-zzzzzzzzzzzzzz";
    const post = (id: string) => `${CHANNEL};messageid=${id}`;
    expect(receive({ ...activity(post("1001"), OTHER, "<at>Toolroll</at> Need a new laptop"), id: "1001", conversation: { id: post("1001"), conversationType: "channel", tenantId: TENANT } })).toBe(false);
    expect(receive({ ...activity(post("1002"), ALEX, `<at>Toolroll</at> flow ${flow}`), id: "1002", conversation: { id: post("1002"), conversationType: "channel", tenantId: TENANT } })).toBe(true);
    await processTeamsEvent(options); await drain();
    expect(lastText()).toContain("This channel now feeds Requests");
    expect(receive({ ...activity(post("1003"), OTHER, "<at>Toolroll</at> Need a new laptop"), id: "1003", conversation: { id: post("1003"), conversationType: "channel", tenantId: TENANT } })).toBe(true);
    await processTeamsEvent(options); await drain();
    const card = store.flowCards(flow, true)[0]!;
    expect(card).toMatchObject({ title: "Need a new laptop", createdBy: "Teams", source: { chat: { app: "teams", chat: CHANNEL, conversation: post("1003"), thread: "1003" } } });
    // The answer goes in that post's thread.
    expect(sends().at(-1)!.path).toBe(`/v3/conversations/${encodeURIComponent(post("1003"))}/activities`);
    expect(lastText()).toContain("Added to Requests as a card.");
    // A reply in the thread (a mention on the same post) joins the card's discussion.
    expect(receive({ ...activity(post("1003"), OTHER, "<at>Toolroll</at> It's the Dell."), id: "1004", conversation: { id: post("1003"), conversationType: "channel", tenantId: TENANT } })).toBe(true);
    await processTeamsEvent(options); await drain();
    expect(store.flowComments(card.id).map(one => one.body)).toEqual(["It's the Dell."]);
  });

  test("the lead's voice in Teams: a tool turn shows typing (Teams gives bots no reactions); the reply is Markdown with a labelled link and no header or internal id", async () => {
    expect(pairAs("alex", ALEX, DM_ALEX)).not.toBeNull();
    answers.push(
      { text: "Checking.", calls: [{ id: "q1", name: "list_tasks", args: {} }] },
      { text: "## Payout\n**Ready**: see https://console.example/chat?task=payout (run #4)." },
    );
    expect(receive(activity(DM_ALEX, ALEX, "how is the payout fix?"))).toBe(true);
    await processTeamsEvent(options); await drain();
    const typing = sends().filter(call => call.body?.["type"] === "typing");
    expect(typing.length).toBeGreaterThanOrEqual(1);
    expect(typing[0]).toMatchObject({ method: "POST", serviceUrl: SERVICE, path: `/v3/conversations/${encodeURIComponent(DM_ALEX)}/activities` });
    expect(sends().some(call => /reaction/i.test(call.path))).toBe(false);
    expect(sends().at(-1)!.body).toEqual({ type: "message", text: "Payout\n\n**Ready**: see [the task](https://console.example/chat?task=payout).", textFormat: "markdown" });
    // A quick answer shows no typing.
    const typed = typing.length;
    answers.push({ text: "All quiet." });
    expect(receive(activity(DM_ALEX, ALEX, "anything else?"))).toBe(true);
    await processTeamsEvent(options); await drain();
    expect(sends().filter(call => call.body?.["type"] === "typing")).toHaveLength(typed);
    expect(lastText()).toBe("All quiet.");
  });

  test("the lead's question arrives as card buttons with Something else, and a tap is the owner's next message (ask_owner)", async () => {
    expect(pairAs("alex", ALEX, DM_ALEX)).not.toBeNull();
    answers.push(
      { text: "", calls: [{ id: "q1", name: "ask_owner", args: { question: "Which customers first?", options: ["Paid", "Trial", "All"] } }] },
      { text: "That decides the order." },
    );
    expect(receive(activity(DM_ALEX, ALEX, "Email customers about the outage"))).toBe(true);
    await processTeamsEvent(options); await drain();
    expect(lastText()).toContain("Which customers first?");
    expect(lastActions().map(action => action["title"])).toEqual(["Paid", "Trial", "All", "Something else"]);
    const paid = lastActions()[0] as { data: Record<string, unknown> };
    const askId = String(state.prepare("SELECT message FROM chat_part WHERE json_extract(payload,'$.ask') IS NOT NULL").get()?.message);
    answers.push({ text: "Paid customers first." });
    expect(receive({ type: "message", id: `tap-${++ids}`, serviceUrl: SERVICE, from: { id: ALEX }, recipient: { id: `28:${APP}` }, conversation: { id: DM_ALEX, conversationType: "personal", tenantId: TENANT }, replyToId: askId, value: paid.data })).toBe(true);
    await processTeamsEvent(options); await drain();
    expect(sends().some(call => call.method === "PUT" && JSON.stringify(call.body).includes("You chose: Paid"))).toBe(true);
    await processTeamsEvent(options); await drain();
    const request = vi.mocked(options.subscriptionRunner!).mock.calls.at(-1)![0];
    expect(request.history.filter(one => one.role === "operator").at(-1)).toMatchObject({ text: "Paid" });
    expect(lastText()).toContain("Paid customers first.");
  });

  test("a flow decision in Teams: Approve / Edit / Send back on the card, and Send back takes the next message as the note (v88)", async () => {
    expect(pairAs("alex", ALEX, DM_ALEX)).not.toBeNull();
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
    await planTeamsNotifications(options);
    await drain();
    expect(lastText()).toContain("We refunded it.");
    expect(lastActions().map(action => action["title"])).toEqual(["Approve", "Edit", "Send back", "Open"]);
    const back = lastActions().find(action => action["title"] === "Send back") as { data: Record<string, unknown> };
    const cardId = String(state.prepare("SELECT message FROM chat_part WHERE json_extract(payload,'$.flow') IS NOT NULL").get()?.message);
    expect(receive({ type: "message", id: `tap-${++ids}`, serviceUrl: SERVICE, from: { id: ALEX }, recipient: { id: `28:${APP}` }, conversation: { id: DM_ALEX, conversationType: "personal", tenantId: TENANT }, replyToId: cardId, value: back.data })).toBe(true);
    await processTeamsEvent(options); await drain();
    expect(lastText()).toContain("Your next message here is the note");
    // A note longer than a chat message holds is refused with the limit, never cut, and the card stays put.
    expect(receive(activity(DM_ALEX, ALEX, "Mention the 5-day wait. ".repeat(110)))).toBe(true);
    await processTeamsEvent(options); await drain();
    expect(lastText()).toBe("That's too long to take from here. Keep it to 2,000 characters, or send it back in Toolroll.");
    expect(store.getFlowCard(card)).toMatchObject({ stage: "check", note: null });
    expect(receive(activity(DM_ALEX, ALEX, "Mention the 5-day wait."))).toBe(true);
    await processTeamsEvent(options); await drain();
    expect(store.getFlowCard(card)).toMatchObject({ stage: "draft", note: "Mention the 5-day wait." });
    expect(lastText()).toBe("↩️ Sent back to Write the reply with your note.");
  });

  test("text longer than one Teams message goes out as several, never cut, with the buttons after all of it", async () => {
    expect(pairAs("alex", ALEX, DM_ALEX)).not.toBeNull();
    const binding = state.bindingFor(credentials.installation, ALEX)!;
    const event = chatHash(`long${++ids}`);
    state.enqueue({ id: event, installation: credentials.installation, binding: binding.id, kind: "notice", channel: DM_ALEX, member: ALEX, ts: "x", thread: "x", payload: "{}", created: now.toISOString() });
    const text = Array.from({ length: 160 }, (_, i) => `Line ${i}: the refund for order ${i} matches its receipt.`).join("\n");
    expect(text.length).toBeGreaterThan(PLATFORM_LIMITS.teams);
    state.plan(event, [{ text, link: { label: "Open", path: "/flows/1?card=2" } }], now);
    calls = [];
    await drain();
    const posted = sends();
    expect(posted.length).toBe(2);
    expect(posted[0]!.body).toEqual({ type: "message", text: text.slice(0, PLATFORM_LIMITS.teams), textFormat: "plain" });
    expect(lastText()).toBe(text.slice(PLATFORM_LIMITS.teams));
    expect(lastActions().map(action => action["title"])).toEqual(["Open"]);
    expect(String(posted[0]!.body!["text"]) + lastText()).toBe(text);
  });

  test("a flow choice in Teams: the flow's own options as buttons, a tap moves the card, and a message instead is the note only when answered Yes", async () => {
    expect(pairAs("alex", ALEX, DM_ALEX)).not.toBeNull();
    now = new Date(now.getTime() + 30_000);
    const flow = store.createFlow({ repo, name: "Fixes", by: "alex", definitionJson: JSON.stringify(flowFromSteps([
      { id: "build", title: "Build", kind: "task" },
      { id: "choose", title: "What next?", kind: "choose", options: [{ label: "Ship it", goesTo: "Ship" }, { label: "Ignore", goesTo: "end" }] },
      { id: "ship", title: "Ship", kind: "inbox" },
    ], null)) }, now);
    const choiceCard = () => String(state.prepare("SELECT message FROM chat_part WHERE json_extract(payload,'$.choose') IS NOT NULL ORDER BY id DESC LIMIT 1").get()?.message);
    const first = store.addFlowCard({ flow, title: "Checkout rounding", description: "Totals are off by a cent", stage: "choose", by: "alex" }, now);
    advanceFlows(store, repo, now);
    await planTeamsNotifications(options); await drain();
    expect(lastText()).toContain("Totals are off by a cent");
    expect(lastText()).toContain("Or reply with what you'd change.");
    expect(lastActions().map(action => action["title"])).toEqual(["Ship it", "Ignore", "Card"]);
    const ship = lastActions().find(action => action["title"] === "Ship it") as { data: Record<string, unknown> };
    expect(receive({ type: "message", id: `tap-${++ids}`, serviceUrl: SERVICE, from: { id: ALEX }, recipient: { id: `28:${APP}` }, conversation: { id: DM_ALEX, conversationType: "personal", tenantId: TENANT }, replyToId: choiceCard(), value: ship.data })).toBe(true);
    await processTeamsEvent(options); await drain();
    expect(store.getFlowCard(first)).toMatchObject({ stage: "ship" });
    expect(sends().some(call => call.method === "PUT" && JSON.stringify(call.body).includes("You chose “Ship it”. Ship it. Moved to Ship."))).toBe(true);

    const second = store.addFlowCard({ flow, title: "Header spacing", description: "The header is cramped on phones", stage: "choose", by: "alex" }, now);
    advanceFlows(store, repo, now);
    await planTeamsNotifications(options); await drain();
    // Teams has no thread to reply in: a message here is asked about first, and only Yes makes it the note.
    expect(receive(activity(DM_ALEX, ALEX, "Use 16px, not 12px."))).toBe(true);
    await processTeamsEvent(options); await drain();
    expect(lastText()).toContain("Use this as your note on “Header spacing”?");
    expect(lastActions().map(action => action["title"])).toEqual(["Yes", "No"]);
    expect(store.getFlowCard(second)).toMatchObject({ stage: "choose" });
    const yes = lastActions().find(action => action["title"] === "Yes") as { data: Record<string, unknown> };
    const asked = String(state.prepare("SELECT message FROM chat_part WHERE json_extract(payload,'$.note') IS NOT NULL ORDER BY id DESC LIMIT 1").get()?.message);
    expect(receive({ type: "message", id: `tap-${++ids}`, serviceUrl: SERVICE, from: { id: ALEX }, recipient: { id: `28:${APP}` }, conversation: { id: DM_ALEX, conversationType: "personal", tenantId: TENANT }, replyToId: asked, value: yes.data })).toBe(true);
    await processTeamsEvent(options); await drain();
    expect(store.getFlowCard(second)).toMatchObject({ stage: "build", note: "Use 16px, not 12px." });
    expect(sends().some(call => call.method === "PUT" && JSON.stringify(call.body).includes("↩️ Sent to Build with your note."))).toBe(true);
    // Its words aren't kept once answered.
    expect(state.prepare("SELECT count(*) AS n FROM chat_flow_note WHERE words IS NOT NULL").get()?.n).toBe(0);
    expect(store.flowEvents(second).at(-1)).toMatchObject({ outcome: "sent-back", actor: "alex" });
  });
});
