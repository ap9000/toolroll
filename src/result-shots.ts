/**
 * Screenshots with results: a person can choose to get a result's saved
 * screenshots in their chat app right after its "ready" (or failed) message —
 * Off (the default), the first one, or up to four.
 *
 * The store records one row per result and person (`RESULT_SHOTS_KIND`) when
 * the result message is made; every transport asks here, at send time, what
 * that row may carry. The checks are the acceptance-evidence sender's: the
 * task is in the projects this chat may reach now, the result is still the
 * task's current one, and each file verifies against its recorded sha256
 * under the evidence root. A failure is one plain line and nothing else; a
 * result whose files retention already removed sends nothing and says
 * nothing. The choice is read again here, so turning it off stops what has
 * not gone yet, and never more than it allows is sent.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { imageDimensions, readVerifiedProofForRun, readVerifiedReport, RETENTION_NOTE } from "./evidence.js";
import { resultImageFileName, verifyResultImage } from "./chat-evidence.js";
import { publicChatText } from "./chat-display.js";
import { chatTitle } from "./chat-voice.js";
import { itemCaption, readFlowItems } from "./flow-items.js";
import { FLOW_SHOTS_KIND, RESULT_SHOTS_KIND, type Notification, type ResultScreenshots, type Store } from "./store.js";
import { savedChatPart, type ChatContent, type ChatState } from "./chat-delivery-state.js";

/** "Up to 4": the most screenshots one result ever sends. */
export const RESULT_SHOTS_MAX = 4;

/** The choices in the order Settings and the CLI show them. */
export const RESULT_SHOT_CHOICES: readonly (readonly [ResultScreenshots, string])[] = [["off", "Off"], ["first", "First one"], ["all", "Up to 4"]];

export function resultShotLimit(choice: ResultScreenshots): number {
  return choice === "first" ? 1 : choice === "all" ? RESULT_SHOTS_MAX : 0;
}

/** Telegram's own photo limits (Bot API sendPhoto, checked 2026-10-03): over them, a screenshot goes as a document. */
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const PHOTO_MAX_SIDES = 10_000;
const PHOTO_MAX_RATIO = 20;

export type ResultShot = {
  artifact: number;
  sha256: string;
  bytes: Buffer;
  format: "png" | "jpeg";
  fileName: string;
  /** Plain words: the first screenshot's carry the task ("Is the site current? · the home page on a phone"). */
  caption: string;
  /** Within Telegram's photo limits, so it shows an inline preview. */
  photo: boolean;
  /** Captioned with its item's number (flow-items.ts): an album shows it on this photo, not only on the first. */
  numbered?: true;
};

export type ResultShotsPlan =
  /** Nothing to send and nothing to say: off, pruned by retention, none saved, or all already sent. */
  | { kind: "none"; why: "off" | "pruned" | "none" | "sent" }
  /** One plain line instead of any screenshot. */
  | { kind: "line"; text: string }
  | { kind: "send"; taskId: string; run: number; shots: ResultShot[] };

const SCREENSHOT_CAPTURE = /^agent-claimed screenshot at (.+) \(validated (?:png|jpeg)\)/;

/** A screenshot's own caption from the result's proof, in plain words; null when it has none fit to show. */
function ownCaptions(store: Store, root: string, run: number): Map<string, string> {
  const proof = readVerifiedProofForRun(store, root, run);
  const captions = new Map<string, string>();
  if (proof === null || !proof.ok) return captions;
  for (const shot of proof.proof.screenshots) {
    const words = publicChatText(shot.caption, 200).trim();
    if (words !== "" && !words.includes("[sensitive text hidden]")) captions.set(shot.path, words);
  }
  return captions;
}

/** A scout's screenshots keep the captions its report gave them, by evidence id. */
function reportCaptions(store: Store, root: string, taskRef: number, run: number): Map<number, string> {
  const captions = new Map<number, string>();
  const view = readVerifiedReport(store, root, taskRef);
  if (view === null || !view.ok || view.run !== run) return captions;
  for (const image of view.report.images) {
    const words = publicChatText(image.caption, 200).trim();
    if (image.artifact !== undefined && words !== "" && !words.includes("[sensitive text hidden]")) captions.set(image.artifact, words);
  }
  return captions;
}

/** A flow visit's item screenshots from this run, in item order, each with its numbered caption (flow-items.ts). */
function itemCaptions(store: Store, dedupeKey: string | undefined, run: number): Map<number, string> {
  const captions = new Map<number, string>();
  const visit = /^flow-shots:([1-9][0-9]{0,14}):([1-9][0-9]{0,9})$/.exec(dedupeKey ?? "");
  const kept = visit === null ? null : store.flowSend(Number(visit[1]), Number(visit[2]));
  if (kept === null) return captions;
  let content: { shots?: { run?: unknown } | null; items?: unknown };
  try { content = JSON.parse(kept.contentJson) as typeof content; } catch { return captions; }
  if (content.shots?.run !== run) return captions;
  readFlowItems(content.items).forEach((item, index) => {
    if (item.shot !== null && !captions.has(item.shot)) captions.set(item.shot, publicChatText(itemCaption(index + 1, item), 200).trim());
  });
  return captions;
}

function isPhoto(bytes: Buffer, format: "png" | "jpeg"): boolean {
  const size = imageDimensions(bytes, format);
  if (size === null || size.width === 0 || size.height === 0) return false;
  return bytes.length <= PHOTO_MAX_BYTES && size.width + size.height <= PHOTO_MAX_SIDES
    && Math.max(size.width, size.height) / Math.min(size.width, size.height) <= PHOTO_MAX_RATIO;
}

/**
 * What one person's screenshots row may send now, to a chat that reaches
 * `repos`. `sent`: screenshots this destination already has, never sent again.
 * Every byte returned was verified this instant; a channel uploads them with
 * no wait in between, or asks again.
 */
export function resultShotsFor(store: Store, evidenceRoot: string | undefined, repos: readonly string[],
  row: Pick<Notification, "kind" | "recipient" | "taskId" | "taskRef" | "run"> & { dedupeKey?: string }, sent: ReadonlySet<number> = new Set()): ResultShotsPlan {
  if (!isShotsKind(row.kind) || row.recipient === null || row.taskId === null || row.taskRef === null || row.run === null) return { kind: "none", why: "none" };
  // A flow's "Send to me" or "Person chooses" asked for them: up to four, whatever the person chose for results.
  const limit = row.kind === FLOW_SHOTS_KIND ? RESULT_SHOTS_MAX : resultShotLimit(store.notificationPreference(row.recipient).screenshots);
  if (limit === 0) return { kind: "none", why: "off" };
  const title = chatTitle(store, row.taskId);
  const line = (why: string): ResultShotsPlan => ({ kind: "line", text: `Screenshots for ${title} weren't sent: ${why}.` });
  if (evidenceRoot === undefined) return line("saved files can't be read from here");
  // Retention removed this result's files: nothing to show, and nothing worth saying.
  if (existsSync(join(evidenceRoot, String(row.run), RETENTION_NOTE))) return { kind: "none", why: "pruned" };
  const ref = store.lookupRef(row.taskId);
  if (ref?.repo == null || !repos.includes(ref.repo)) return line("the result is outside your connected projects now");
  const family = store.taskFamilyOf(row.taskId, repos, false);
  const latest = store.runsFor(row.taskRef).find(one => one.finishedAt !== null && ["builder", "repair", "scout"].includes(one.role));
  if (family?.current.id !== row.taskId || latest?.id !== row.run) return line("a newer result replaced this one");
  // After research, a flow's message numbers the report's items (flow-items.ts): their screenshots go first, in that
  // order, each captioned with its item's number, so "2." here is item 2 in the text.
  const items = row.kind === FLOW_SHOTS_KIND ? itemCaptions(store, row.dedupeKey, row.run) : new Map<number, string>();
  const order = [...items.keys()];
  const rank = (id: number) => { const at = order.indexOf(id); return at < 0 ? order.length : at; };
  const chosen = store.artifactsFor(row.run).filter(one => one.kind === "screenshot")
    .map((one, at) => ({ one, at })).sort((a, b) => rank(a.one.id) - rank(b.one.id) || a.at - b.at).map(({ one }) => one).slice(0, limit);
  if (chosen.length === 0) return { kind: "none", why: "none" };
  const captions = ownCaptions(store, evidenceRoot, row.run);
  const reported = latest.role === "scout" ? reportCaptions(store, evidenceRoot, row.taskRef, row.run) : new Map<number, string>();
  const shots: ResultShot[] = [];
  for (const [index, artifact] of chosen.entries()) {
    const verified = verifyResultImage(store, evidenceRoot, repos, { taskId: row.taskId, run: row.run, artifact: artifact.id, sha256: artifact.sha256 });
    if (!verified.ok) {
      // Removed by retention between the check above and now: still nothing to say.
      if (existsSync(join(evidenceRoot, String(row.run), RETENTION_NOTE))) return { kind: "none", why: "pruned" };
      return line(verified.problem);
    }
    const own = captions.get(SCREENSHOT_CAPTURE.exec(artifact.capture)?.[1] ?? "") ?? reported.get(artifact.id) ?? null;
    const item = items.get(artifact.id);
    shots.push({
      artifact: artifact.id, sha256: artifact.sha256, bytes: verified.bytes, format: verified.format,
      fileName: resultImageFileName(row.taskId, row.run, artifact.id, verified.format),
      caption: item !== undefined ? item : index === 0 ? (own === null ? title : `${title} · ${own}`) : own ?? `${title} · screenshot ${index + 1}`,
      photo: isPhoto(verified.bytes, verified.format), ...(item === undefined ? {} : { numbered: true as const }),
    });
  }
  const remaining = shots.filter(one => !sent.has(one.artifact));
  return remaining.length === 0 ? { kind: "none", why: "sent" } : { kind: "send", taskId: row.taskId, run: row.run, shots: remaining };
}

/** A row that carries a result's screenshots: one a person asked for with results, or one a flow sends them. */
export function isShotsKind(kind: string): boolean {
  return kind === RESULT_SHOTS_KIND || kind === FLOW_SHOTS_KIND;
}

/** A screenshot whose result message is not posted yet waits for that message's own next try (at least a second). */
export function shotWaitsUntil(resultNextAt: unknown, now: Date): string {
  const soonest = new Date(now.getTime() + 1_000).toISOString();
  return typeof resultNextAt === "string" && resultNextAt > soonest ? resultNextAt : soonest;
}

/** Retention removed this result's files: its screenshots go quietly, never as a complaint. */
export function resultShotsPruned(evidenceRoot: string, run: number): boolean {
  return existsSync(join(evidenceRoot, String(run), RETENTION_NOTE));
}

/**
 * The chat app refused the upload (no file permission there): this part becomes one plain line and the result's
 * other screenshots in the same message are dropped, so the person reads one line, not one per screenshot.
 */
export function refuseResultShots(state: Pick<ChatState, "prepare">, store: Store, part: { id: number; event: string }, content: ChatContent, app: string, now: Date): void {
  const title = chatTitle(store, content.image?.taskId ?? content.task ?? "");
  const line: ChatContent = { text: `Screenshots for ${title} weren't sent: the ${app} app isn't allowed to upload files here.`,
    ...(content.task === undefined ? {} : { task: content.task }), ...(content.run === undefined ? {} : { run: content.run }) };
  state.prepare("UPDATE chat_part SET payload=?,state='pending',next_at=NULL,problem=NULL,file=NULL,uploaded=0,uncertain=0,created=? WHERE provider=:provider AND id=?").run(savedChatPart(line), now.toISOString(), part.id);
  state.prepare("UPDATE chat_part SET state='dropped',problem='Uploads are not allowed here' WHERE provider=:provider AND event=? AND id<>? AND state='pending'").run(part.event, part.id);
}
