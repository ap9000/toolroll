/**
 * Flow passes that don't wait for builds. The worker's pass used to move
 * cards only between builds, so a card whose research finished sat still
 * while another build ran (Oct 4: five minutes). Now the worker runs these
 * passes on their own cadence beside its builds, and a finished build,
 * research or check moves its card at once.
 *
 * Model-free and cheap: nothing here starts a build. Cards entering a build
 * zone file their task, which waits for a free slot like any other.
 */
import { advanceFlows, type FlowAdvance } from "./flow-engine.js";
import { runFlowTriggers, type TriggerIo, type TriggerPass } from "./flow-triggers.js";
import { watchFlowReplies, type ReplyWatch, type ReplyWatchIo } from "./flow-replies.js";
import { runFlowSteps, type StepIo, type StepPass } from "./flow-steps.js";
import type { Store } from "./store.js";

/** How often the worker moves cards, checks triggers, reads replies and runs steps, builds or not. */
export const FLOW_EVERY_MS = 15_000;

const running = new Set<string>();

/** One pass of a kind for a project at a time in this process: a second one asked for while it runs is skipped
 * (`idle`), and the next cadence takes up whatever it would have done. Cards are also claimed in the database,
 * so passes in other processes can't act twice either. */
export async function alone<T>(kind: string, project: string, idle: T, run: () => Promise<T>): Promise<T> {
  const key = `${kind}\u0000${project}`;
  if (running.has(key)) return idle;
  running.add(key);
  try { return await run(); } finally { running.delete(key); }
}

export type FlowIo = { triggers: TriggerIo; replies: ReplyWatchIo; steps: StepIo; evidenceRoot?: string };
export type FlowHousekeeping = { triggers: TriggerPass; replies: ReplyWatch; steps: StepPass; flows: FlowAdvance };

/** One project's flow pass: triggers (which may start cards), replies (which move waiting cards), steps, then moves.
 * `halted` (a stop or paused admission) skips everything that reaches outside; moves still run. */
export async function flowHousekeeping(store: Store, repo: string, clock: () => Date, io: FlowIo, halted: () => boolean): Promise<FlowHousekeeping> {
  const triggers = halted() ? { added: 0, checked: 0, problems: [] }
    : await alone<TriggerPass>("triggers", repo, { added: 0, checked: 0, problems: [] }, () => runFlowTriggers(store, repo, clock(), io.triggers));
  // One mailbox serves every project, so its reads are one at a time across them all.
  const replies = halted() ? { read: 0, taken: 0, problem: null }
    : await alone<ReplyWatch>("replies", "*", { read: 0, taken: 0, problem: null }, () => watchFlowReplies(store, clock(), io.replies));
  const steps = halted() ? { ran: 0, problems: [] }
    : await alone<StepPass>("steps", repo, { ran: 0, problems: [] }, () => runFlowSteps(store, repo, clock(), io.steps));
  // Last, so a step that just finished, or a card a trigger just added, moves now.
  const flows = moveCards(store, repo, clock(), io.evidenceRoot);
  return { triggers, replies, steps, flows };
}

/** Move one project's cards. Synchronous, so two can't overlap in a process; each move is checked against the
 * card's visit in its own transaction, so a pass in another process can't move a card twice. */
export function moveCards(store: Store, repo: string, now: Date, evidenceRoot: string | undefined): FlowAdvance {
  try { return advanceFlows(store, repo, now, evidenceRoot === undefined ? {} : { evidenceRoot }); }
  catch (error) { return { moved: 0, filed: [], problems: [`flows: ${error instanceof Error ? error.message : "could not move cards"}`] }; }
}

/** A build, research or check just finished: move the cards in this project, and in the project of any flow whose
 * card that task belongs to (a build zone may build in another project), now rather than on the next pass. */
export function moveCardsAfter(store: Store, repo: string, tasks: readonly string[], now: Date, evidenceRoot: string | undefined): FlowAdvance {
  const projects = new Set([repo]);
  for (const task of tasks) {
    try {
      const card = store.flowCardByTask(task) ?? store.flowCardByTask(store.taskFamilyOf(task, null, true)?.root.id ?? task);
      const flow = card === null ? null : store.getFlow(card.flow);
      if (flow !== null) projects.add(flow.repo);
    } catch { /* not a task with a card */ }
  }
  const outcome: FlowAdvance = { moved: 0, filed: [], problems: [] };
  for (const project of projects) {
    const moved = moveCards(store, project, now, evidenceRoot);
    outcome.moved += moved.moved;
    outcome.filed.push(...moved.filed);
    outcome.problems.push(...moved.problems);
  }
  return outcome;
}
