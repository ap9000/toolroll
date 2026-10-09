/**
 * Budget alerts (v105): at 50, 80 and 100 % of a monthly budget, once each a
 * month, a notification goes out (to everyone's usual places; a person's
 * budget to that person) and the ledger keeps it. Only the highest mark newly
 * reached is sent: a budget that jumps past three marks at once says so once.
 * Budgets are dollars: only work billed to an API key counts (a subscription
 * costs nothing extra).
 */
import type { Store } from "./store.js";
import { budgetLabel, subagentNames, usd, type BudgetState } from "./spend.js";

const MARKS = [100, 80, 50] as const;

export function budgetAlertPass(store: Store, now: Date): { sent: { budget: number; mark: number }[] } {
  const { month, budgets } = store.monthSpend(now);
  const sent: { budget: number; mark: number }[] = [];
  const names = subagentNames(store.handle);
  for (const budget of budgets) {
    const mark = MARKS.find(one => budget.percent >= one);
    if (mark === undefined) continue;
    // Keyed by the limit too: a budget raised (or lowered) this month alerts afresh at its new marks.
    const key = (one: number) => `budget:${budget.id}:${budget.limitMicrousd}:${month}:${one}`;
    // A higher mark already sent this month covers this one.
    if (MARKS.filter(one => one >= mark).some(one => store.handle.prepare("SELECT 1 AS hit FROM notification WHERE dedupe_key = ?").get(key(one)) !== undefined)) continue;
    const label = budgetLabel(budget, budget.scope === "subagent" ? names.get(Number(budget.key)) : undefined);
    const fresh = store.enqueueNotification({
      dedupeKey: key(mark), kind: "budget-alert", pushClass: "attention", link: `/spend?month=${month}`,
      subject: `${label} budget: ${mark}% used`,
      body: `${usd(budget.spentMicrousd)} of ${usd(budget.limitMicrousd)} in ${month}.${mark >= 100 ? budget.hardStop ? " New API work waits until next month or a higher budget." : " It only alerts; work carries on." : ""}`,
      source: budget.scope === "project" ? { project: budget.key } : { installation: true },
      ...(budget.scope === "person" ? { recipient: budget.key } : {}),
    }, now);
    if (!fresh) continue;
    store.recordAction({ at: now.toISOString(), actor: "system", repo: budget.scope === "project" ? budget.key : null, taskId: null, runId: null,
      action: `budget ${mark}% used: ${label.replace(/'s$/, "")}`, outcome: mark >= 100 && budget.hardStop ? "stopped" : "alerted", source: "policy",
      detail: `${usd(budget.spentMicrousd)} of ${usd(budget.limitMicrousd)} in ${month}` });
    sent.push({ budget: budget.id, mark });
  }
  return { sent };
}

/** The loop beside the console: a pass a minute. */
export function startBudgetAlerts(store: Store, everyMs = 60_000): () => void {
  let stopped = false;
  const tick = () => { if (stopped) return; try { budgetAlertPass(store, new Date()); } catch { /* the next pass tries again */ } };
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  const first = setTimeout(tick, 5_000);
  first.unref?.();
  return () => { stopped = true; clearInterval(timer); clearTimeout(first); };
}

export type { BudgetState };
