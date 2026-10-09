/**
 * A subagent's desk (v96): what the lead asks it for its person (D5) becomes a
 * card on its own flow, and what it writes goes back to whoever asked; its
 * routines put a card there on a schedule, answered to its manager; and a code
 * change it can't make is filed as an ordinary task that still needs a
 * person's approval.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store, type SubagentRow } from "./store.js";
import { addApprover } from "./scope.js";
import { run as exec } from "./exec.js";
import { runFlowSteps, type StepIo } from "./flow-steps.js";
import { parseSchedule, nextFireAt } from "./flow-schedule.js";
import { addRoutine, askSubagent, deskOf, localZone, removeRoutine, routineSchedule, routinesOf, runRoutine } from "./subagent-desk.js";
import { setSubagentState } from "./subagent-admin.js";
import { SUBAGENT_TEMPLATES, type TurnRequest, type TurnRunner } from "./subagents.js";

const T0 = new Date("2026-09-25T10:00:00.000Z"); // a Friday
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
let dir: string, repo: string, store: Store, mate: SubagentRow;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-subagent-desk-")));
  repo = join(dir, "shop");
  store = openStore(join(dir, "orders.db"));
  if (!addApprover(store, "alex", T0).ok) throw new Error("bootstrap");
  store.admitRepo?.(repo, "alex", T0);
  store.createSubagent({ repo, handle: "maya", soul: SUBAGENT_TEMPLATES[0]!.soul, model: null, manager: "alex", by: "alex" }, T0);
  mate = store.subagentByHandle(repo, "maya")!;
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
const io = (subagent: TurnRunner): StepIo => ({ gh: exec, git: exec, shell: exec, fetch, dir, scratch: join(dir, "scratch"), base: "main", toolHome: dir, subagent });
const replies = () => store.handle.prepare("SELECT recipient, subject, body FROM notification WHERE dedupe_key LIKE '%teammate-reply:%' ORDER BY id").all();

test("what the lead asks a subagent lands on its desk, and its answer goes back to whoever asked", async () => {
  // Only someone who can use its project asks it; nothing to ask is nothing passed on.
  expect(askSubagent(store, mate, { who: "sam", via: "the lead" }, "where's order 2201?", T0)).toMatchObject({ ok: false, said: "Maya works in a project you can't use." });
  expect(askSubagent(store, mate, { who: "alex", via: "the lead" }, "  ", T0)).toMatchObject({ ok: false, said: "Say what to ask Maya." });
  const handed = askSubagent(store, mate, { who: "alex", via: "the lead" }, "where's order 2201?\nIt was due Tuesday.", T0);
  const desk = deskOf(store, store.getSubagent(mate.id)!)!;
  expect(desk).toMatchObject({ name: "Maya's desk", owner: "alex", repo });
  expect(handed).toMatchObject({ ok: true, said: "Maya has it. The answer comes to you when it's done.", link: { label: "Open the card" } });
  const [card] = store.flowCards(desk.id, false);
  expect(card).toMatchObject({ title: "where's order 2201?", description: "where's order 2201?\nIt was due Tuesday.", stage: "handle", createdBy: "alex", source: { kind: "message", label: "Asked through the lead" } });
  // A second ask reuses the same desk.
  askSubagent(store, mate, { who: "alex", via: "the lead" }, "is the Friday sale still on?", T0);
  expect(store.listFlows([repo]).filter(one => one.name === "Maya's desk")).toHaveLength(1);
  const maya = turns(
    { action: "route", answer: "Done", text: "Order 2201 shipped yesterday; it arrives Monday.", reason: "Answered from the order." },
    { action: "route", answer: "Done", text: "Yes, until Sunday night.", reason: "Answered." },
  );
  await runFlowSteps(store, repo, at(1), io(maya));
  // It works the card as itself: its own soul file and rules, then its answer to whoever asked.
  expect(maya.prompts[0]).toContain("You are Maya, Support on this team");
  expect(maya.prompts[0]).toContain(SUBAGENT_TEMPLATES[0]!.soul.trim().split("\n").find(line => line.startsWith("- Refunds and replacements up to $50"))!);
  expect(maya.prompts[0]).toContain("it goes back to whoever asked");
  expect(store.getFlowCard(card!.id)?.stage).toBe("done");
  expect(replies()).toEqual([
    { recipient: "alex", subject: "Maya · Support: where's order 2201?", body: "Order 2201 shipped yesterday; it arrives Monday." },
    { recipient: "alex", subject: "Maya · Support: is the Friday sale still on?", body: "Yes, until Sunday night." },
  ]);
  // Paused, it takes nothing on.
  setSubagentState(store, store.getSubagent(mate.id)!, "paused", "alex", at(2));
  expect(askSubagent(store, store.getSubagent(mate.id)!, { who: "alex", via: "the lead" }, "one more thing", at(2))).toMatchObject({ ok: false, said: "Maya is paused, so nothing was passed on. Resume Maya first." });
});

test("a code change it's asked for goes to the desk's Build zone, which files an ordinary task that still needs approving", async () => {
  askSubagent(store, mate, { who: "alex", via: "the lead" }, "the refund email has a typo: 'recieve'. Fix it?", T0);
  const desk = deskOf(store, store.getSubagent(mate.id)!)!;
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
  const fresh = store.getSubagent(mate.id)!;
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
