import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore, type Store } from "./store.js";
import { addApprover, approve } from "./scope.js";
import { bridgePass, followBridge, hashPairingCode, mintPairingCode, PAIRING_TTL_MS, saveBotToken, TOKEN_ENV, type TelegramTransport } from "./telegram.js";
import { PHONE_BACK_TO_LEAD, PHONE_FOCUS_LINE, PHONE_HELP, phoneCommand, phoneStatus, phoneTask, phoneTaskChoices, phoneTaskListText, phoneTaskView, resolvePhoneTask } from "./telegram-status.js";
import { propose } from "./scope.js";
import { diagnoseTaskDispatch } from "./dispatch.js";
import { runOperate, EXIT } from "./operate.js";
import { saveRepos } from "./repos.js";

const NOW = new Date("2026-09-13T06:00:00Z");
const REPO = "/private/projects/standing-orders";
const FOREIGN = "/private/projects/secret-project";
const BOT = "777000";
const CHAT = 4242;
const USER = 31337;
const command = (id: number, text: string, extra: Record<string, unknown> = {}) => ({
  update_id: id,
  message: { message_id: 1000 + id, chat: { id: CHAT, type: "private" }, from: { id: USER }, text, ...extra },
});

function scripted() {
  const updates: unknown[][] = [];
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const transport: TelegramTransport = async (method, params) => {
    calls.push({ method, params });
    return { ok: true, result: method === "getUpdates" ? updates.shift() ?? [] : { message_id: calls.length + 100 } };
  };
  return { updates, calls, transport, texts: () => calls.filter(c => c.method === "sendMessage").map(c => String(c.params["text"])) };
}

describe("read-only phone status", () => {
  let store: Store;
  let dir: string;
  let db: string;
  let operatorToken: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-phone-status-"));
    db = join(dir, "orders.db");
    store = openStore(db);
    const operator = addApprover(store, "operator", NOW);
    if (!operator.ok) throw new Error("bootstrap");
    operatorToken = operator.token;
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  function task(id = "mobile-nav", repo: string | null = REPO, title = "Polish mobile navigation") {
    store.createTask({ id, title }, NOW);
    const ref = store.refFor("built-in", id).id;
    if (repo !== null) store.placeTask(ref, repo);
    return ref;
  }

  function result(id: string, verdict: "verified" | "attested" | "short" | "refuted" | null = "verified") {
    const ref = task(id);
    const run = store.startRun({ taskRef: ref, runner: "worker", leaseId: `lease-${id}`, branch: `standing-orders/${id}`, worktree: REPO,
      route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: NOW });
    store.setRunPhase(run, "verifying-proof");
    store.finishRun(run, { outcome: "built", committed: true, now: NOW });
    if (verdict !== null) store.saveProofVerdict(run, verdict, [], NOW);
    store.setTaskState(id, "done", NOW);
    return { ref, run };
  }

  function pair() {
    const code = mintPairingCode();
    store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "operator", by: "operator", ttlMs: PAIRING_TTL_MS }, NOW);
    expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: String(CHAT), userId: String(USER), updateId: 1 }, NOW).ok).toBe(true);
  }

  const pass = (s: ReturnType<typeof scripted>, readProjects: () => Promise<readonly string[]> = async () => [REPO]) =>
    bridgePass(store, { botId: BOT, transport: s.transport, clock: () => NOW, deliver: false, readProjects });

  test("`/task` names ONE precise destination from the recorded state: the exact result's checks or changes, the approval control, the recovery page, or the task itself", () => {
    const { run } = result("verified-one", "verified");
    expect(phoneTaskView(store, [REPO], "verified-one", NOW).link).toEqual({ label: "Open checks", path: `/chat?task=verified-one&result=${run}&tab=checks` });
    const bare = result("no-verdict", null);
    expect(phoneTaskView(store, [REPO], "no-verdict", NOW).link).toEqual({ label: "Open changes", path: `/chat?task=no-verdict&result=${bare.run}&tab=changes` });
    // The result named is this execution's own recorded run, not the newest run anywhere.
    expect(bare.run).not.toBe(run);
    task("scoped");
    for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "operator", NOW);
    propose(store, { taskId: "scoped", goal: "do it", now: NOW });
    const scoped = phoneTaskView(store, [REPO], "scoped", NOW);
    expect(diagnoseTaskDispatch(store, "scoped", NOW)?.action).toBe("approve-scope");
    expect(scoped.link).toEqual({ label: "Review & start", path: "/chat?task=scoped#task-chat-action" });
    expect(scoped.text).not.toContain("Read-only status");
    const failed = task("stopped");
    store.setTaskState("stopped", "failed", NOW);
    void failed;
    expect(diagnoseTaskDispatch(store, "stopped", NOW)?.action).toBe("retry-task");
    expect(phoneTaskView(store, [REPO], "stopped", NOW).link).toEqual({ label: "Review recovery options", path: "/t/stopped" });
    // A worker that must be started: the task lens, whose words say what remains.
    const idle = task("idle-task");
    void idle;
    propose(store, { taskId: "idle-task", goal: "wait for a worker", now: NOW });
    expect(approve(store, "idle-task", "operator", NOW, store.getScope("idle-task")!.digest, operatorToken).ok).toBe(true);
    expect(["start-worker", "approve-scope"]).toContain(diagnoseTaskDispatch(store, "idle-task", NOW)?.action);
    expect(phoneTaskView(store, [REPO], "idle-task", NOW).link?.path.startsWith("/chat?task=idle-task")).toBe(true);
    // Foreign or unknown: no text about it, no link.
    task("foreign", FOREIGN, "hidden-title");
    expect(phoneTaskView(store, [REPO], "foreign", NOW)).toEqual({ text: phoneTask(store, [REPO], "nope", NOW), link: null, run: null });
    expect(phoneTaskView(store, [REPO], "nope", NOW).link).toBeNull();
  });

  test("a restricted account's `/task` and `/status` see only the projects it may access, even when the registry names more — no title, no link, no status line leaks", async () => {
    // A second approver, allowed only REPO, paired to this phone; the registry (the console's managed list) still names both projects.
    expect(addApprover(store, "limited", NOW, { name: "operator", token: operatorToken }).ok).toBe(true);
    expect(store.setAccountProjects("limited", [REPO], "operator", NOW).ok).toBe(true);
    expect(store.accountCanAccess("limited", FOREIGN)).toBe(false);
    const code = mintPairingCode();
    store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "limited", by: "operator", ttlMs: PAIRING_TTL_MS }, NOW);
    expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: String(CHAT), userId: String(USER), updateId: 1 }, NOW).ok).toBe(true);
    task("allowed-task", REPO, "Allowed project task");
    task("private-task", FOREIGN, "PRIVATE PROJECT SENTINEL");
    const s = scripted();
    const registry = async () => [REPO, FOREIGN];
    const passWith = () => bridgePass(store, { botId: BOT, transport: s.transport, clock: () => NOW, deliver: false, readProjects: registry, conversation: { evidenceRoot: dir, phoneOrigin: () => "https://console.example", subscriptionRunner: async () => { throw new Error("a read-only command must not call a provider"); } } });
    s.updates.push([command(2, "/task private-task"), command(3, "/status"), command(4, "/task allowed-task")]);
    expect(await passWith()).toMatchObject({ ok: true, report: { statusReplies: 3, problems: [] } });
    const [hidden, status, allowed] = s.calls.filter(c => c.method === "sendMessage");
    expect(String(hidden!.params["text"])).toBe("No such task in your connected projects. Send /tasks to pick one.");
    expect(hidden!.params["reply_markup"]).toBeUndefined();
    expect(String(status!.params["text"])).not.toMatch(/PRIVATE PROJECT SENTINEL|private-task|secret-project/);
    expect(String(status!.params["text"])).toContain("allowed-task");
    expect(allowed!.params["reply_markup"]).toEqual({ inline_keyboard: [[{ text: "Open task", url: "https://console.example/chat?task=allowed-task" }]] });
    expect(s.texts().join("\n")).not.toContain("PRIVATE PROJECT SENTINEL");
  });

  test("the picker as text (Slack, Discord, Teams): a numbered list; /task takes a number, an id or title words; nothing outside the ceiling", () => {
    task("checkout-button", REPO, "Checkout button spacing");
    task("mobile-nav", REPO, "Polish mobile navigation");
    task("foreign", FOREIGN, "PRIVATE PROJECT SENTINEL");
    const choices = phoneTaskChoices(store, [REPO], NOW);
    expect(choices.map(one => one.id).sort()).toEqual(["checkout-button", "mobile-nav"]);
    const text = phoneTaskListText(choices, null);
    expect(text).toMatch(/^Your tasks\n1\. /);
    expect(text).toContain("Send /task <number or name> to talk about one.");
    expect(text).not.toContain("PRIVATE PROJECT SENTINEL");
    expect(phoneTaskListText(choices, "Checkout button spacing")).toMatch(/^Talking about: Checkout button spacing\n/);
    expect(resolvePhoneTask(store, [REPO], NOW, "1")).toMatchObject({ kind: "one", id: choices[0]!.id });
    expect(resolvePhoneTask(store, [REPO], NOW, "mobile-nav")).toMatchObject({ kind: "one", id: "mobile-nav", view: "mobile-nav", title: "Polish mobile navigation" });
    expect(resolvePhoneTask(store, [REPO], NOW, "checkout SPACING")).toMatchObject({ kind: "one", id: "checkout-button" });
    expect(resolvePhoneTask(store, [REPO], NOW, "foreign")).toEqual({ kind: "none" });
    expect(resolvePhoneTask(store, [REPO], NOW, "sentinel")).toEqual({ kind: "none" });
    expect(resolvePhoneTask(store, [REPO], NOW, "9")).toEqual({ kind: "none" });
    task("checkout-total", REPO, "Checkout total rounding");
    expect(resolvePhoneTask(store, [REPO], NOW, "checkout")).toMatchObject({ kind: "many", choices: [expect.anything(), expect.anything()] });
    expect(phoneTaskListText([], null)).toContain("No open or recent tasks");
  });

  test("the picker: /tasks offers tasks as buttons, a tap or /task <name> chooses one, plain messages then carry it, and /lead goes back", async () => {
    pair();
    task("checkout-button", REPO, "Checkout button spacing");
    task("mobile-nav", REPO, "Polish mobile navigation");
    task("foreign", FOREIGN, "PRIVATE PROJECT SENTINEL");
    expect(phoneCommand("/tasks")).toEqual({ kind: "tasks" });
    expect(phoneCommand("/task")).toEqual({ kind: "tasks" });
    expect(phoneCommand("/lead")).toEqual({ kind: "lead" });
    expect(phoneCommand("/task checkout spacing")).toEqual({ kind: "task", id: "checkout spacing" });
    const binding = store.liveTelegramBindingFor(BOT, String(USER))!;
    const s = scripted();
    // The connected projects are REPO only: a task elsewhere is never offered.
    const passWith = () => bridgePass(store, { botId: BOT, transport: s.transport, clock: () => NOW, deliver: false, readProjects: async () => [REPO], conversation: { evidenceRoot: dir, phoneOrigin: () => null } });
    const sends = () => s.calls.filter(c => c.method === "sendMessage");
    type Keyboard = { inline_keyboard: { text: string; callback_data: string }[][] };
    s.updates.push([command(2, "/tasks")]);
    await passWith();
    const list = sends().at(-1)!;
    expect(String(list.params["text"])).toBe("Pick a task to talk about:");
    const keyboard = (list.params["reply_markup"] as Keyboard).inline_keyboard;
    expect(keyboard.map(row => row[0]!.text.split(" · ")[0]).sort()).toEqual(["Checkout button spacing", "Polish mobile navigation"]);
    expect(JSON.stringify(keyboard)).not.toContain("PRIVATE PROJECT SENTINEL");
    // A tap chooses the task and turns the list into its status.
    const checkout = keyboard.find(row => row[0]!.text.startsWith("Checkout"))![0]!;
    s.updates.push([{ update_id: 3, callback_query: { id: "cb1", from: { id: USER }, data: checkout.callback_data, message: { message_id: 555, chat: { id: CHAT, type: "private" } } } }]);
    await passWith();
    expect(store.chatFocus("telegram", binding.id)).toBe("checkout-button");
    const edit = s.calls.filter(c => c.method === "editMessageText").at(-1)!;
    expect(String(edit.params["text"])).toContain("Checkout button spacing");
    expect(String(edit.params["text"])).toContain(PHONE_FOCUS_LINE);
    expect(store.telegramMessageBindings(binding, "555")).toMatchObject([{ taskId: "checkout-button", run: null }]);
    // A plain message now carries the chosen task into the turn.
    s.updates.push([command(4, "Make the spacing 16px.")]);
    await passWith();
    expect(store.listTelegramConversations(BOT).at(-1)).toMatchObject({ taskId: "checkout-button", context: expect.stringContaining("chose this task") });
    // /status says so; /task <words> chooses by title; an ambiguous word offers buttons.
    s.updates.push([command(5, "/status")]);
    await passWith();
    expect(s.texts().at(-1)).toMatch(/^Talking about: Checkout button spacing · \/lead to switch back/);
    s.updates.push([command(6, "/task mobile")]);
    await passWith();
    expect(store.chatFocus("telegram", binding.id)).toBe("mobile-nav");
    expect(s.texts().at(-1)).toContain(PHONE_FOCUS_LINE);
    const mobileStatus = String(s.calls.indexOf(sends().at(-1)!) + 101);
    expect(store.telegramMessageBindings(binding, mobileStatus)).toMatchObject([{ taskId: "mobile-nav" }]);
    task("checkout-total", REPO, "Checkout total rounding");
    s.updates.push([command(7, "/task checkout")]);
    await passWith();
    expect(s.texts().at(-1)).toBe("Several tasks match. Pick one:");
    expect((sends().at(-1)!.params["reply_markup"] as Keyboard).inline_keyboard).toHaveLength(2);
    expect(store.chatFocus("telegram", binding.id)).toBe("mobile-nav");
    // /lead goes back: plain messages are for the lead again.
    s.updates.push([command(8, "/lead")]);
    await passWith();
    expect(s.texts().at(-1)).toBe(PHONE_BACK_TO_LEAD);
    expect(store.chatFocus("telegram", binding.id)).toBeNull();
    s.updates.push([command(9, "What needs me?")]);
    await passWith();
    expect(store.listTelegramConversations(BOT).at(-1)).toMatchObject({ taskId: null });
    // A reply to a message that showed a task is about that task, whatever the chat chose since.
    s.updates.push([command(10, "Is it done yet?", { reply_to_message: { message_id: 555 } })]);
    await passWith();
    expect(store.listTelegramConversations(BOT).at(-1)).toMatchObject({ taskId: "checkout-button", context: expect.stringContaining("Current task: checkout-button") });
    s.updates.push([command(11, "Make the menu sticky.", { reply_to_message: { message_id: Number(mobileStatus) } })]);
    await passWith();
    expect(store.listTelegramConversations(BOT).at(-1)).toMatchObject({ taskId: "mobile-nav" });
    expect(store.chatFocus("telegram", binding.id)).toBeNull();
    // "Back to the lead" on that message: it no longer shows a task, so a reply to it is for the lead.
    s.updates.push([{ update_id: 12, callback_query: { id: "cb2", from: { id: USER }, data: "pick:lead", message: { message_id: 555, chat: { id: CHAT, type: "private" } } } }]);
    await passWith();
    expect(store.telegramMessageBindings(binding, "555")).toEqual([]);
    s.updates.push([command(13, "Anything else?", { reply_to_message: { message_id: 555 } })]);
    await passWith();
    expect(store.listTelegramConversations(BOT).at(-1)).toMatchObject({ taskId: null });
  });

  test("the reply carries the button only under a trusted origin read at reply time; unconfigured, the same text says the console is where", async () => {
    pair();
    const { run } = result("verified-one", "verified");
    const s = scripted();
    let origin: string | null = null;
    const passWith = () => bridgePass(store, { botId: BOT, transport: s.transport, clock: () => NOW, deliver: false, readProjects: async () => [REPO], conversation: { evidenceRoot: dir, phoneOrigin: () => origin } });
    const sends = () => s.calls.filter(c => c.method === "sendMessage");
    s.updates.push([command(2, "/task verified-one")]);
    expect(await passWith()).toMatchObject({ ok: true, report: { statusReplies: 1 } });
    expect(sends().at(-1)!.params["reply_markup"]).toBeUndefined();
    expect(s.texts().at(-1)).toContain("Read-only status. Saved files and full actions are in the console.");
    origin = "https://console.example";
    s.updates.push([command(3, "/task verified-one")]);
    expect(await passWith()).toMatchObject({ ok: true, report: { statusReplies: 1 } });
    expect(sends().at(-1)!.params["reply_markup"]).toEqual({ inline_keyboard: [[{ text: "Open checks", url: `https://console.example/chat?task=verified-one&result=${run}&tab=checks` }]] });
    expect(s.texts().at(-1)).not.toContain("Read-only status");
    expect(s.texts().at(-1)).toContain("Next: Open this task's result");
    // /status and /help never carry a button, and nothing changed.
    s.updates.push([command(4, "/status"), command(5, "/help")]);
    expect(await passWith()).toMatchObject({ ok: true, report: { statusReplies: 2 } });
    expect(sends().slice(-2).every(c => c.params["reply_markup"] === undefined)).toBe(true);
    expect(PHONE_HELP).toContain("nothing changes until you act");
    expect(PHONE_HELP).not.toMatch(/localhost|http/);
    for (const table of ["run", "claim", "mate_turn", "lead_proposal", "chat_action"]) {
      expect(store.raw().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!["n"]).toBe(table === "run" ? 1 : 0);
    }
  });

  test("commands are explicit, bounded, and never interpret prose or shell syntax", () => {
    expect(phoneCommand("/task mobile-nav")).toEqual({ kind: "task", id: "mobile-nav" });
    expect(phoneCommand("/status")).toEqual({ kind: "status" });
    expect(phoneCommand("/start")).toEqual({ kind: "help" });
    expect(phoneCommand("/task x; delete everything")).toEqual({ kind: "help" });
    expect(phoneCommand("/task " + "x".repeat(65))).toEqual({ kind: "help" });
    expect(phoneCommand("/status@someone_else")).toBeNull();
    expect(phoneCommand("cancel all my tasks")).toBeNull();
  });

  test("projects are admitted before reading rows; null and foreign projects stay invisible", () => {
    task(); task("foreign", FOREIGN, "hidden-title"); task("unplaced", null, "unplaced-title");
    const read = phoneStatus(store, [REPO], NOW);
    expect(read).toContain("mobile-nav");
    expect(read).not.toMatch(/hidden-title|unplaced-title|secret-project|\/private/);
    expect(phoneTask(store, [REPO], "foreign", NOW)).toBe(phoneTask(store, [REPO], "does-not-exist", NOW));
    expect(phoneStatus(store, [], NOW)).toContain("No connected projects");
    expect(phoneTask(store, [], "mobile-nav", NOW)).not.toContain("Polish");
  });

  test.each(["short", "refuted", null] as const)("a done row with %s proof is not presented as finished", verdict => {
    result("needs-proof", verdict);
    const overview = phoneStatus(store, [REPO], NOW);
    expect(overview).toContain("Needs attention · 1");
    expect(overview).not.toContain("Finished ·");
    const detail = phoneTask(store, [REPO], "needs-proof", NOW);
    // The shared headline (task-status.ts): a result missing its record waits on a person.
    expect(detail.split("\n")[4]).toBe("Needs you");
    expect(diagnoseTaskDispatch(store, "needs-proof", NOW)!.code).not.toBe("complete");
    expect(detail).not.toContain("verifying-proof");
    expect(detail).not.toContain("Pull request:");
  });

  test("operator acceptance preserves weak evidence and publication never means merge", () => {
    const { ref, run } = result("accepted", "short");
    store.acceptProof(run, "operator", "Reviewed the exception", NOW);
    const publication = store.createPublicationIntent({ run, taskRef: ref, githubRepo: "owner/repo", remote: "origin", base: "main", head: "standing-orders/accepted", headSha: "a".repeat(40), bodyHash: "b".repeat(64), draft: true }, NOW);
    store.markPublicationPushed(publication, NOW);
    store.markPublicationOpened(publication, 7, "https://github.com/owner/repo/pull/7", NOW);
    const detail = phoneTask(store, [REPO], "accepted", NOW);
    expect(detail.split("\n")[4]).toBe("Ready for review");
    expect(detail).not.toContain("Checks passed");
    expect(detail).toContain("Required saved material is missing");
    expect(detail).toContain("does not change its recorded checks");
    expect(detail).toContain("Pull request: #7 open.");
    expect(detail).not.toContain("merged");
    store.recordPublicationRemoteState(publication, "MERGED", NOW);
    expect(phoneTask(store, [REPO], "accepted", NOW)).toContain("Pull request: #7 merged.");
  });

  test("a historical pending model review does not queue finished work or request approval", () => {
    const { ref, run } = result("review-me");
    const status = phoneStatus(store, [REPO], NOW);
    const detail = phoneTask(store, [REPO], "review-me", NOW);
    const runs = store.runsFor(ref);
    expect(status).toContain("Finished · 1");
    store.raw().prepare("INSERT INTO review_request (run, requested_by, basis, requested_at) VALUES (?, 'operator', 'human', ?)").run(run, NOW.toISOString());
    expect(phoneStatus(store, [REPO], NOW)).toBe(status);
    expect(phoneTask(store, [REPO], "review-me", NOW)).toBe(detail);
    expect(detail).not.toMatch(/The review is already requested|approve its scope/i);
    expect(store.runsFor(ref)).toEqual(runs);
    expect(store.reviewRetryStateOf(run)?.state).toBe("queued"); // Historical request remains recorded.
  });

  test("known backoff is visible without claiming the task will definitely run then", () => {
    const ref = task();
    const until = new Date(NOW.getTime() + 60_000);
    store.holdOwned({ taskRef: ref, ownerKind: "backoff", ownerId: "attempt-1", reason: "temporary failure", until }, NOW);
    const detail = phoneTask(store, [REPO], "mobile-nav", NOW);
    expect(detail.split("\n")[4]).toBe("Queued");
    expect(detail).toContain(`Earliest recorded wake: ${until.toISOString()}`);
    expect(detail).toContain("a connected worker is still required");
  });

  test("a hidden dependency's ID is not disclosed by the shared diagnosis", () => {
    task(); task("sensitive-blocker", FOREIGN);
    store.addEdge("mobile-nav", "sensitive-blocker");
    const detail = phoneTask(store, [REPO], "mobile-nav", NOW);
    expect(detail).toContain("outside this phone view");
    expect(detail).not.toContain("sensitive-blocker");
  });

  test("long histories and hostile display text stay bounded and explicitly incomplete", () => {
    for (let n = 0; n < 65; n++) task(`task-${n}`, REPO, "😀".repeat(500));
    const text = phoneStatus(store, [REPO], NOW);
    expect(text.length).toBeLessThanOrEqual(3900);
    expect(text).toContain("Newest 60 tasks only — older work may still need attention");
    expect(text).toContain("+58 more in the console");
    expect(phoneTask(store, [REPO], "task-0", NOW)).toContain("task-0"); // direct reads bypass the snapshot window
    task("secret-title", REPO, "token sk-" + "X".repeat(40));
    expect(phoneTask(store, [REPO], "secret-title", NOW)).not.toContain("X".repeat(40));
    task("path-title", REPO, "Inspect C:\\Users\\private\\app and /Users/private/project\n\u202e fake status");
    const detail = phoneTask(store, [REPO], "path-title", NOW);
    expect(detail).not.toMatch(/C:\\Users|\/Users|\u202e/);
    expect(detail.length).toBeLessThanOrEqual(3900);
  });

  test("projection reads change zero SQLite rows", () => {
    task(); result("complete");
    const changes = () => store.raw().prepare("SELECT total_changes() AS n").get()!["n"];
    const before = changes();
    phoneStatus(store, [REPO], NOW); phoneTask(store, [REPO], "complete", NOW);
    expect(changes()).toBe(before);
  });

  test("authenticated phone commands reply without changing tasks or admitting any work", async () => {
    pair(); task();
    const s = scripted();
    const before = store.getTask("mobile-nav");
    s.updates.push([command(2, "/status"), command(3, "/task mobile-nav"), command(4, "/help")]);
    const got = await pass(s);
    expect(got).toMatchObject({ ok: true, report: { statusReplies: 3, sent: 0, answered: 0 } });
    expect(s.texts()).toHaveLength(3);
    expect(s.texts()[2]).toBe(PHONE_HELP);
    expect(s.calls.filter(c => c.method === "sendMessage").every(c => c.params["parse_mode"] === undefined && c.params["reply_markup"] === undefined)).toBe(true);
    expect(store.getTask("mobile-nav")).toEqual(before);
    for (const table of ["run", "claim", "mate_turn", "chat_turn", "lead_proposal", "chat_action", "publication"]) {
      expect(store.raw().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!["n"]).toBe(0);
    }
  });

  test.each([
    { from: { id: USER + 1 } }, { chat: { id: CHAT + 1, type: "private" } },
    { chat: { id: CHAT, type: "group" } }, { forward_origin: {} }, { forward_date: 1 },
    { via_bot: {} }, { sender_chat: {} }, { caption: "forwarded" },
  ])("untrusted command envelope %j stays silent before reading projects", async extra => {
    pair(); task();
    const s = scripted(); const readProjects = vi.fn(async () => [REPO]);
    s.updates.push([command(2, "/status", extra)]);
    expect(await pass(s, readProjects)).toMatchObject({ ok: true, report: { ignored: 1 } });
    expect(readProjects).not.toHaveBeenCalled(); expect(s.texts()).toEqual([]);
  });

  test("unpaired, rotated, and role-downgraded identities cannot read status", async () => {
    task(); const s = scripted();
    s.updates.push([command(2, "/status")]); await pass(s);
    pair(); store.raw().prepare("UPDATE approver SET generation = generation + 1 WHERE name = 'operator'").run();
    s.updates.push([command(3, "/status")]); await pass(s);
    store.raw().prepare("UPDATE approver SET generation = generation - 1, role = 'viewer' WHERE name = 'operator'").run();
    s.updates.push([command(4, "/status")]); await pass(s);
    expect(s.texts()).toEqual([]);
  });

  test("unpairing during async project loading prevents both the read and send", async () => {
    pair(); task(); const s = scripted();
    const snapshot = vi.spyOn(store, "chatSnapshot");
    s.updates.push([command(2, "/status")]);
    await pass(s, async () => { store.unpairTelegram(BOT, "operator", NOW); return [REPO]; });
    expect(snapshot).not.toHaveBeenCalled(); expect(s.texts()).toEqual([]);
  });

  test("read failures are sanitized, send failures are reported, and replays stay consumed after restart", async () => {
    pair(); task(); const s = scripted();
    s.updates.push([command(2, "/status")]);
    expect(await pass(s, async () => { throw new Error("secret /Users/private password=bad"); })).toMatchObject({ ok: true, report: { statusReplies: 1, problems: ["phone status could not read the current project records"] } });
    expect(s.texts()[0]).toContain("No tasks were changed");
    expect(s.texts()[0]).not.toContain("password");
    s.updates.push([command(3, "/status")]);
    const base = s.transport;
    s.transport = async (method, params) => method === "sendMessage" ? { ok: false, description: "secret" } : base(method, params);
    expect(await pass(s)).toMatchObject({ ok: true, report: { problems: ["phone status reply failed for update 3; send a new command to retry"] } });
    store.close(); store = openStore(db);
    const replay = scripted(); replay.updates.push([command(2, "/status"), command(3, "/status")]);
    await pass(replay); expect(replay.texts()).toEqual([]);
    replay.updates.push([command(4, "/status")]); await pass(replay);
    expect(replay.texts()).toHaveLength(1);
  });

  test("slash-prefixed decision replies are still notes, never status commands", async () => {
    pair(); const ref = task();
    const run = store.startRun({ taskRef: ref, runner: "worker", leaseId: "decision-lease", branch: "standing-orders/mobile-nav", worktree: REPO, route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: NOW });
    const decision = store.saveDecision({ run, urgency: "blocking", recap: "Pick a layout", question: "Which layout?", options: [{ id: "compact", label: "Compact", consequence: "Less spacing", reversible: true }, { id: "roomy", label: "Roomy", consequence: "More spacing", reversible: true }], recommendation: "compact" }, NOW);
    const binding = store.liveTelegramBinding(BOT)!;
    store.recordTelegramDecisionMessage(binding.id, binding.chatId, "123", decision, NOW);
    const s = scripted(); s.updates.push([command(2, "/status", { reply_to_message: { message_id: 123 } })]);
    expect(await pass(s)).toMatchObject({ ok: true, report: { noted: 1, answered: 0 } });
    expect(s.texts()[0]).toContain("| /status");
    expect(store.getDecision(decision)!.state).toBe("open");
  });

  test("follower reloads the read ceiling and counts replies without a new scheduler", async () => {
    pair(); task(); const s = scripted(); const controller = new AbortController();
    s.updates.push([command(2, "/status")], []);
    let cycles = 0;
    const report = await followBridge(store, { botId: BOT, transport: s.transport, signal: controller.signal, clock: () => NOW, deliver: false,
      readProjects: async () => cycles === 0 ? [REPO] : [],
      onCycle: () => { if (++cycles === 1) s.updates.push([command(3, "/status")], []); else controller.abort(); },
      sleep: async () => {},
    });
    expect(report.statusReplies).toBe(2);
    expect(s.texts()[0]).toContain("mobile-nav");
    expect(s.texts()[1]).toContain("No connected projects");
  });

  test("public CLI reads enrollment, not opened projects, and status-only activity is successful", async () => {
    vi.stubEnv(TOKEN_ENV, "");
    pair(); task(); task("foreign", FOREIGN, "private-foreign-title");
    store.upsertProject(FOREIGN, "opened-is-not-enrolled", NOW);
    await saveRepos(join(dir, "repos.json"), [REPO]);
    saveBotToken(join(dir, "telegram-token"), `${BOT}:${"x".repeat(25)}`);
    const s = scripted(); s.updates.push([command(2, "/status")]);
    const lines: string[] = [];
    const code = await runOperate("bridge", ["telegram", "--inbound-only", "--json"], line => lines.push(line), { databaseFile: db, now: NOW, telegramTransport: s.transport });
    expect(code).toBe(EXIT.ok);
    expect(lines.join("\n")).toContain('"statusReplies": 1');
    expect(s.texts()[0]).toContain("mobile-nav");
    expect(s.texts()[0]).not.toContain("private-foreign-title");
    writeFileSync(join(dir, "repos.json"), "malformed");
    s.updates.push([command(3, "/status")]);
    expect(await runOperate("bridge", ["telegram", "--inbound-only"], () => {}, { databaseFile: db, now: NOW, telegramTransport: s.transport })).toBe(EXIT.failed);
    expect(s.texts()[1]).toContain("couldn't read");
  });
});
