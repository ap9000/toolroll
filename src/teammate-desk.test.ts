/**
 * A teammate's desk (v96): a message to it by name becomes a card on its own
 * flow, and what it writes goes back to whoever asked; its routines put a card
 * there on a schedule, answered to its manager; and a code change it can't
 * make is filed as an ordinary task that still needs a person's approval.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store, type TeammateRow } from "./store.js";
import { addApprover } from "./scope.js";
import { run as exec } from "./exec.js";
import { runFlowSteps, type StepIo } from "./flow-steps.js";
import { parseSchedule, nextFireAt } from "./flow-schedule.js";
import { addressedTo, addRoutine, deskOf, localZone, messageTeammate, removeRoutine, routineSchedule, routinesOf, runRoutine } from "./teammate-desk.js";
import { setTeammateState } from "./teammate-admin.js";
import { TEAMMATE_TEMPLATES, type TurnRequest, type TurnRunner } from "./teammates.js";

const T0 = new Date("2026-09-25T10:00:00.000Z"); // a Friday
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
let dir: string, repo: string, store: Store, mate: TeammateRow;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-teammate-desk-")));
  repo = join(dir, "shop");
  store = openStore(join(dir, "orders.db"));
  if (!addApprover(store, "alex", T0).ok) throw new Error("bootstrap");
  store.admitRepo?.(repo, "alex", T0);
  store.createTeammate({ repo, handle: "maya", soul: TEAMMATE_TEMPLATES[0]!.soul, model: null, manager: "alex", by: "alex" }, T0);
  mate = store.teammateByHandle(repo, "maya")!;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const blank = { answer: "", text: "", note: "", question: "", options: [], reason: "", tool: "", input: "", remember: "" };
function turns(...answers: Record<string, unknown>[]): TurnRunner & { prompts: string[] } {
  const prompts: string[] = [];
  const runner = (async (request: TurnRequest) => {
    prompts.push(request.prompt);
    const next = answers.shift();
    if (next === undefined) throw new Error("no more turns scripted");
    return { ok: true as const, value: { ...blank, ...next }, ms: 10 };
  }) as TurnRunner & { prompts: string[] };
  runner.prompts = prompts;
  return runner;
}
const io = (teammate: TurnRunner): StepIo => ({ gh: exec, git: exec, shell: exec, fetch, dir, scratch: join(dir, "scratch"), base: "main", toolHome: dir, teammate });
const replies = () => store.handle.prepare("SELECT recipient, subject, body FROM notification WHERE dedupe_key LIKE '%teammate-reply:%' ORDER BY id").all();

test("who a message is addressed to: @name, or a name and a comma or colon, never a sentence that merely starts with one", () => {
  expect(addressedTo("@maya where's order 2201?")).toEqual({ name: "maya", said: "where's order 2201?" });
  expect(addressedTo("@Maya, where's order 2201?")).toEqual({ name: "Maya", said: "where's order 2201?" });
  expect(addressedTo("Maya: refund Sam's duplicate charge")).toEqual({ name: "Maya", said: "refund Sam's duplicate charge" });
  expect(addressedTo("Maya, thanks")).toEqual({ name: "Maya", said: "thanks" });
  expect(addressedTo("Maya can refund up to $100 now")).toBeNull();
  expect(addressedTo("@maya")).toBeNull();
  expect(addressedTo("what's new?")).toBeNull();
});

test("a message to a teammate by name lands on its desk, and its answer goes back to whoever asked", async () => {
  expect(messageTeammate(store, { who: "alex", repos: [repo], via: "Telegram" }, "@leo where's order 2201?", T0)).toBeNull();
  expect(messageTeammate(store, { who: "alex", repos: [], via: "Telegram" }, "@maya where's order 2201?", T0)).toBeNull();
  const handed = messageTeammate(store, { who: "alex", repos: [repo], via: "Telegram" }, "@maya where's order 2201?\nIt was due Tuesday.", T0)!;
  const desk = deskOf(store, store.getTeammate(mate.id)!)!;
  expect(desk).toMatchObject({ name: "Maya's desk", owner: "alex", repo });
  expect(handed).toMatchObject({ said: "Maya has it. The answer comes here when it's done.", link: { label: "Open the card" } });
  const [card] = store.flowCards(desk.id, false);
  expect(card).toMatchObject({ title: "where's order 2201?", description: "where's order 2201?\nIt was due Tuesday.", stage: "handle", createdBy: "alex", source: { kind: "message", label: "Telegram message" } });
  // A second message reuses the same desk.
  messageTeammate(store, { who: "alex", repos: [repo], via: "Slack" }, "Maya: is the Friday sale still on?", T0);
  expect(store.listFlows([repo]).filter(one => one.name === "Maya's desk")).toHaveLength(1);
  const maya = turns(
    { action: "route", answer: "Done", text: "Order 2201 shipped yesterday; it arrives Monday.", reason: "Answered from the order." },
    { action: "route", answer: "Done", text: "Yes, until Sunday night.", reason: "Answered." },
  );
  await runFlowSteps(store, repo, at(1), io(maya));
  expect(maya.prompts[0]).toContain("it goes back to whoever asked");
  expect(store.getFlowCard(card!.id)?.stage).toBe("done");
  expect(replies()).toEqual([
    { recipient: "alex", subject: "Maya · Support: where's order 2201?", body: "Order 2201 shipped yesterday; it arrives Monday." },
    { recipient: "alex", subject: "Maya · Support: is the Friday sale still on?", body: "Yes, until Sunday night." },
  ]);
  // Paused, it takes nothing on.
  setTeammateState(store, store.getTeammate(mate.id)!, "paused", "alex", at(2));
  expect(messageTeammate(store, { who: "alex", repos: [repo], via: "Telegram" }, "@maya one more thing", at(2))).toMatchObject({ said: "Maya is paused, so nothing was passed on. Resume Maya on its page, or ask the lead." });
});

test("a code change it's asked for goes to the desk's Build zone, which files an ordinary task that still needs approving", async () => {
  messageTeammate(store, { who: "alex", repos: [repo], via: "Discord" }, "@maya the refund email has a typo: 'recieve'. Fix it?", T0);
  const desk = deskOf(store, store.getTeammate(mate.id)!)!;
  await runFlowSteps(store, repo, at(1), io(turns({ action: "route", answer: "Needs a code change", text: "That's in the email template; I've asked for a fix.", reason: "It's a code change." })));
  const [card] = store.flowCards(desk.id, false);
  expect(card?.stage).toBe("build");
  expect(replies()).toHaveLength(1);
});

test("routines: on a schedule (weekdays too), a card on its desk; run one now, its answer goes to its manager; remove it", async () => {
  expect(addRoutine(store, mate, "sometimes", "Count refunds", "alex", T0, null)).toMatchObject({ ok: false });
  // With no zone named, a time is this computer's; a named one (UTC too) is kept.
  expect(routineSchedule("weekdays 09:00")).toBe(localZone() === "UTC" ? "weekdays:09:00" : `weekdays:09:00@${localZone()}`);
  expect(routineSchedule("daily 17:00 Europe/London")).toBe("daily:17:00@Europe/London");
  expect(routineSchedule("every 2 hours")).toBe("every:120");
  expect(addRoutine(store, mate, "weekdays 09:00 UTC", "Count yesterday's refunds and tell me the total", "alex", T0, null)).toMatchObject({ ok: true, said: "Maya will do that weekdays at 09:00 UTC. Its answer goes to alex." });
  const fresh = store.getTeammate(mate.id)!;
  const [routine] = routinesOf(store, fresh);
  expect(routine).toMatchObject({ schedule: "weekdays:09:00", text: "Count yesterday's refunds and tell me the total", state: "active", nextAt: "2026-09-28T09:00:00.000Z" });
  expect(nextFireAt(parseSchedule("weekdays:09:00")!, "2026-09-28T09:00:00.000Z", new Date("2026-09-28T09:00:00.000Z"))).toBe("2026-09-29T09:00:00.000Z");
  expect(runRoutine(store, fresh, routine!.id, "alex", at(1))).toMatchObject({ ok: true, said: "Maya is on it. The answer goes to alex." });
  const [card] = store.flowCards(deskOf(store, fresh)!.id, false);
  expect(card).toMatchObject({ title: "Count yesterday's refunds and tell me the total", stage: "handle" });
  await runFlowSteps(store, repo, at(2), io(turns({ action: "route", answer: "Done", text: "3 refunds yesterday, $120 in all.", reason: "Counted." })));
  expect(replies()).toEqual([{ recipient: "alex", subject: "Maya · Support: Count yesterday's refunds and tell me the total", body: "3 refunds yesterday, $120 in all." }]);
  expect(removeRoutine(store, fresh, routine!.id, at(3), null)).toMatchObject({ ok: true });
  expect(routinesOf(store, fresh)).toEqual([]);
});
