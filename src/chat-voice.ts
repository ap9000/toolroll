/** How chat sounds: a teammate talking. One or two short sentences, outcome
 * first, plain words, one action at most. Every chat (Telegram, Slack,
 * Discord, Teams) takes its titles and its finished-work lines from here, so a
 * task id, a "— revision" suffix or a person's own act never reaches a chat.
 * The console keeps every exact name and fact. */
import { leadOnIt } from "./task-status.js";
import type { TelegramTransport } from "./telegram.js";
import { phoneText } from "./telegram-status.js";
import type { Store } from "./store.js";

/** The bot's display name in every chat app. */
export const BOT_NAME = "Toolroll";
/** Updates for one person landing within this window become one message, edited in place as it grows. */
export const BATCH_MS = 2 * 60_000;
export const SHORT_TITLE_MAX = 60;

/** A token that could be an id: letters and digits joined by `-` or `_`, or with a digit in it (`release-099b`,
 * `t42`). Words such as `node-20` and `utf-8` look the same, so a token goes only when it names a real task. */
const ID_SHAPED = /\(?(?<![\p{L}\p{N}._/-])[\p{L}\p{N}]+(?:[-_.][\p{L}\p{N}]+)*(?![\p{L}\p{N}_/-]|\.[\p{L}\p{N}])\)?/gu;
/** An id that could be mistaken for nothing else (`release-099b`, `fix_tax`, `t42`). A one-word id such as `tidy`
 * is also a word, and prose keeps its words. */
const idLike = (id: string): boolean => /[-_\d]/.test(id);
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A short human summary of a task's title, at most 60 characters: no "— revision", and no task ids. Only the
 * task's own id and tokens `isTaskId` names as real tasks are dropped; `node-20` and `utf-8` stay. */
export function shortTitle(title: string | null | undefined, taskId?: string | null, isTaskId?: (token: string) => boolean): string {
  let text = phoneText(title ?? "", 400);
  // "— revision", "- revision 2", "(revision)": a revision is the same work to a person.
  text = text.replace(/(?:(?:\s*[—–]+|\s+-+)\s*revision\b(?:\s*#?\d+)?|\s*[([]\s*revision(?:\s*#?\d+)?\s*[)\]])/giu, "");
  text = text.replace(ID_SHAPED, token => {
    const bare = token.replace(/^\(|\)$/g, "");
    return idLike(bare) && (bare === taskId || isTaskId?.(bare) === true) ? " " : token;
  });
  text = text.replace(/\(\s*\)/g, " ").replace(/\s+/g, " ").replace(/^[\s·:,;—–-]+|[\s·:,;—–-]+$/gu, "").trim();
  if (text === "") {
    // A task filed with only its id as a title: the words, never the slug.
    const words = (taskId ?? "").replace(/[-_]+/g, " ").trim();
    return words === "" ? "A task" : shortTitle(words[0]!.toUpperCase() + words.slice(1));
  }
  if (text.length <= SHORT_TITLE_MAX) return text;
  const cut = text.slice(0, SHORT_TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 20 ? cut.slice(0, space) : cut).replace(/[\s·:,;—–-]+$/u, "")}…`;
}

/** A task's title as every chat says it: short, with its own id and any other real task's id dropped. */
export function chatTitle(store: Pick<Store, "getTask">, taskId: string): string {
  return shortTitle(store.getTask(taskId)?.title, taskId, token => token !== taskId && store.getTask(token) !== null);
}

/** A title inside a sentence or list: "faster tests", but "API keys" and "iOS" keep their capitals. */
export function inSentence(summary: string): string {
  return /^\p{Lu}\p{Ll}/u.test(summary) ? summary[0]!.toLowerCase() + summary.slice(1) : summary;
}

/** The facts one line of a chat update is made of, read from the shared task status. */
export type FinishedFact = {
  summary: string;
  headline: string;
  checks: "passed" | "failed" | "not-run" | "off" | null;
  report: boolean;
  completedBy: string | null;
  /** An open pull request carries this result: the ask is "Merge it?" rather than "Accept and finish it?". */
  pullRequest?: boolean;
  /** The lead did this (built it, or marked it complete), so the lead says "I". */
  lead?: boolean;
  /** Not a finished result but another update about the task: its own words when it stands alone, and a few
   * words for a list ("has a plan to review"). */
  update?: { words: string; phrase: string } | null;
  /** The person's lead took it on (lead-voice.ts): "<name> is on it", never "It waits for you". */
  leadOnIt?: boolean;
  /** What the person calls their lead (Settings → Lead); "Lead" when unnamed. */
  leadName?: string;
};

/** The two buttons under a result ready for a person: the real next step, then a look first. */
export const READY_ACTIONS = { merge: "Merge", complete: "Accept and finish", look: "Look first" } as const;

/** Whether this line asks for the result's next step, so it carries [Merge] or [Accept and finish] and [Look first]. */
export function asksToFinish(fact: FinishedFact): boolean {
  return fact.update == null && fact.headline === "Ready for review" && !fact.report;
}

/** One update, said plainly: what happened, then what happens next. The lead says "I" for what it did. */
export function finishedLine(fact: FinishedFact): string {
  if (fact.update != null) return fact.update.words;
  const name = fact.summary, lower = inSentence(fact.summary);
  const ready = fact.lead === true ? `I finished ${lower}` : `${name} is ready`;
  // What waited on the person and the lead has taken on (Needs you reads Waiting then).
  if (fact.leadOnIt === true && (fact.headline === "Needs you" || fact.headline === "Waiting" || fact.headline === "Stopped")) return `${name}: ${leadOnIt(fact.leadName)}`;
  switch (fact.headline) {
    case "Ready for review":
      if (fact.report) return fact.lead === true ? `I wrote up ${lower}. The report is ready to read.` : `${name}: the report is ready to read.`;
      if (fact.checks === "passed") return `${ready}. Your tests passed. ${fact.pullRequest === true ? "Merge it?" : "Accept and finish it?"}`;
      if (fact.checks === "off") return `${ready}. Its checks run at release, so look it over first.`;
      return `${ready}, but no tests ran. Look it over first.`;
    case "Failed":
      if (fact.leadOnIt === true) return fact.checks === "failed" ? `${name} is built, but its tests failed. ${leadOnIt(fact.leadName)}` : `${name} stopped before it finished. ${leadOnIt(fact.leadName)}`;
      if (fact.checks === "failed") return fact.lead === true
        ? `I built ${lower}, but its tests failed. It waits for you: retry or ask for changes.`
        : `${name} is built, but its tests failed. It waits for you: retry or ask for changes.`;
      return fact.lead === true
        ? `I couldn't finish ${lower}. The work so far is kept; retry when you're ready.`
        : `${name} stopped before it finished. The work so far is kept; retry when you're ready.`;
    case "Complete":
      if (fact.lead === true && fact.completedBy) return `I marked ${lower} complete.`;
      return fact.completedBy ? `${name} is done. ${fact.completedBy} marked it complete.` : `${name} is done.`;
    case "Needs you":
      return fact.lead === true ? `I need your decision on ${lower} before I can go on.` : `${name} needs your decision before it can continue.`;
    default:
      return `${name}: ${fact.headline.toLowerCase()}.`;
  }
}

/** One task in a list of updates: "faster tests is ready", "cleanup failed". */
function phraseOf(fact: FinishedFact): string {
  const name = inSentence(fact.summary);
  if (fact.update != null) return `${name} ${fact.update.phrase}`;
  switch (fact.headline) {
    case "Ready for review": return `${name} is ready`;
    case "Failed": return `${name} failed`;
    case "Complete": return `${name} is done`;
    case "Needs you": return `${name} needs you`;
    default: return `${name}: ${fact.headline.toLowerCase()}`;
  }
}

/** Several updates in one message: "4 tasks finished: faster tests, cleanup, …" (or "3 updates: …" when not all of
 * them are finished work), then what broke and what happens next. */
export function batchLine(facts: readonly FinishedFact[]): string {
  if (facts.length === 1) return finishedLine(facts[0]!);
  const finishedOnly = facts.every(one => one.update == null);
  const names = finishedOnly ? facts.map(one => inSentence(one.summary)) : facts.map(phraseOf);
  const shown = names.slice(0, 3).join(", ");
  const first = `${facts.length} ${finishedOnly ? "tasks finished" : "updates"}: ${shown}${names.length > 3 ? ", …" : "."}`;
  // What happens next: anything that broke or needs a decision waits for the person.
  // What the lead is on waits for nobody.
  const failed = facts.filter(one => one.headline === "Failed" && one.leadOnIt !== true);
  const needs = facts.filter(one => one.headline === "Needs you" && one.leadOnIt !== true).length;
  const broke = failed.length !== 1 ? `${failed.length} failed`
    : failed[0]!.checks === "failed" ? `tests failed on ${inSentence(failed[0]!.summary)}` : `${inSentence(failed[0]!.summary)} stopped before it finished`;
  const waits = [
    ...(failed.length === 0 ? [] : [broke]),
    ...(needs === 0 ? [] : [needs === facts.length ? "each needs your decision" : `${needs} ${needs === 1 ? "needs" : "need"} your decision`]),
  ];
  if (waits.length === 0) return first;
  const said = waits.join(", and ");
  return `${first}\n${said[0]!.toUpperCase()}${said.slice(1)}; ${failed.length + needs === 1 ? "it waits" : "they wait"} for you.`;
}

/** The old product name a bot may still wear from before the rename. */
const OLD_NAME = /standing\s*-?\s*orders/i;

/**
 * Name the Telegram bot Toolroll. On pairing it always becomes Toolroll; on upgrade only a bot still called
 * StandingOrders is renamed, so a name a person chose later is kept. Best effort: a refused or failed call
 * leaves the old name and never blocks pairing or delivery. Returns whether a rename was sent and accepted.
 */
export async function nameTelegramBot(transport: TelegramTransport, when: "pairing" | "upgrade", signal?: AbortSignal): Promise<boolean> {
  try {
    const current = await transport("getMyName", {}, signal);
    const name = current.ok ? (current.result as { name?: unknown } | undefined)?.name : undefined;
    const shown = typeof name === "string" ? name : null;
    if (shown === BOT_NAME) return false;
    if (when === "upgrade" && (shown === null || !OLD_NAME.test(shown))) return false;
    if (signal?.aborted) return false;
    const set = await transport("setMyName", { name: BOT_NAME }, signal);
    return set.ok;
  } catch {
    return false;
  }
}

/** The last word on any pushed chat text: a task's own id (bare or in brackets), a "— revision" suffix and a
 * "Replaced by <id>" never reach a chat, whatever words the fact was recorded with. A bare id reads as the
 * task's short title when one is given, else "this task". */
export function chatText(text: string, tasks: readonly (string | null | undefined | { id: string; title?: string })[] = []): string {
  let out = text.replace(/(?:(?:[ \t]*[—–]+|[ \t]+-+)[ \t]*revision\b(?:[ \t]*#?\d+)?|[ \t]*[([][ \t]*revision(?:[ \t]*#?\d+)?[ \t]*[)\]])/giu, "");
  out = out.replace(/\bReplaced by (?!a newer task)[^\s.,;:!?)]+/gu, "Replaced by a newer task");
  for (const task of tasks) {
    const id = typeof task === "string" ? task : task?.id;
    if (!id || !idLike(id)) continue;
    const title = typeof task === "object" && task !== null ? task.title : undefined;
    out = out.replace(new RegExp(`[ \\t]*\\(${escape(id)}\\)|(?<![\\p{L}\\p{N}_/=-])${escape(id)}(?![\\p{L}\\p{N}_-])`, "gu"),
      match => match.trimStart().startsWith("(") ? "" : title ?? "this task");
  }
  return out;
}

/** The one button a plain fact may carry: its label names where its machine-minted console path goes; nothing in
 * it comes from the fact's text. */
export function factLinkLabel(path: string): string {
  if (/^\/review\?result=[^&]+&run=\d+&tab=checks$/.test(path)) return "Inspect result";
  if (/^\/t\/[^?#]+#merge$/.test(path)) return "Merge";
  if (/^\/chat\?task=[^&]+&result=/.test(path)) return "Open result";
  if (/^\/(?:chat\?task=|t\/)/.test(path)) return "Open task";
  if (/^\/d\//.test(path)) return "Open decision";
  return "Open console";
}

/** Whether the words already name this title as a whole phrase (so it need not be said twice). */
export function mentions(text: string, title: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${escape(title)}(?![\\p{L}\\p{N}_-])`, "u").test(text);
}
