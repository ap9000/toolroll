/**
 * Screenshots a project's own check writes (docs/plans/checks-screenshots.md v1). Builds never start a browser; a
 * project check (its Playwright test, say) runs in the check fence, where Chromium may start, and saves images to
 * `evidence/checks/`. Right after the check, before its checkout goes, Toolroll reads them without following anything,
 * validates each by signature and keeps them as the run's evidence of the exact commit the check tested.
 *
 * They are reviewer evidence only: their capture never matches the agent's (result-evidence-readers.ts
 * SCREENSHOT_CAPTURE), so they never stand in for an approved acceptance criterion.
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readMailbox, SCREENSHOT_BYTE_CAP, storeEvidence, validateScreenshotBytes } from "./evidence.js";
import type { Store } from "./store.js";

/** Where a check saves its screenshots, inside the checkout it ran in. */
export const CHECK_SHOTS_DIR = "evidence/checks";
/** At most this many are kept per check; the rest are named. */
export const CHECK_SHOTS_MAX = 8;
const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(?:png|jpe?g)$/i;
const FOLDER_PROBLEM = "the folder isn't a plain folder inside the checkout";

export type CheckShot = { path: string; raw: Buffer; kind: "png" | "jpeg" };
export type CheckShots = { files: CheckShot[]; problems: { path: string; problem: string }[] };

/** A check's image of one tested commit, in the words the result page reads (CHECK_SCREENSHOT_CAPTURE). */
export const checkScreenshotCapture = (path: string, commit: string, kind: "png" | "jpeg"): string =>
  `check screenshot at ${path} of ${commit} (validated ${kind})`;
export const CHECK_SCREENSHOT_CAPTURE = /^check screenshot at (evidence\/checks\/[^ ]+) of ([a-f0-9]{40}) \(validated (?:png|jpeg)\)$/;

/** The screenshots in a checkout's `evidence/checks/`: each folder on the way a real folder whose real path is exactly
 * where it should be (no link anywhere), each file read O_NOFOLLOW as a regular file and validated by signature. */
export function collectCheckScreenshots(checkout: string): CheckShots {
  let root: string;
  try { root = realpathSync(checkout); } catch { return { files: [], problems: [] }; }
  const folder = join(root, CHECK_SHOTS_DIR);
  for (const at of [join(root, "evidence"), folder]) {
    let held;
    try { held = lstatSync(at); } catch { return { files: [], problems: [] }; }
    if (!held.isDirectory() || held.isSymbolicLink()) return { files: [], problems: [{ path: CHECK_SHOTS_DIR, problem: FOLDER_PROBLEM }] };
  }
  let real: string;
  try { real = realpathSync(folder); } catch { return { files: [], problems: [{ path: CHECK_SHOTS_DIR, problem: FOLDER_PROBLEM }] }; }
  if (real !== folder) return { files: [], problems: [{ path: CHECK_SHOTS_DIR, problem: FOLDER_PROBLEM }] };
  let names: string[];
  try { names = readdirSync(folder).filter(name => IMAGE_NAME.test(name)).sort(); } catch { return { files: [], problems: [{ path: CHECK_SHOTS_DIR, problem: "the folder couldn't be listed" }] }; }
  const out: CheckShots = { files: [], problems: [] };
  for (const name of names) {
    const path = `${CHECK_SHOTS_DIR}/${name}`;
    if (out.files.length >= CHECK_SHOTS_MAX) { out.problems.push({ path, problem: `only the first ${CHECK_SHOTS_MAX} screenshots are kept` }); continue; }
    const read = readMailbox(join(folder, name), SCREENSHOT_BYTE_CAP);
    if (!read.ok) { out.problems.push({ path, problem: read.problem }); continue; }
    const valid = validateScreenshotBytes(read.raw);
    if (!valid.ok) { out.problems.push({ path, problem: valid.problem }); continue; }
    out.files.push({ path, raw: read.raw, kind: valid.kind });
  }
  return out;
}

/** Keep a check's screenshots as one run's evidence of the commit it tested (`commit` from Toolroll's own reading of the
 * checkout's HEAD, never the check's words). Returns the lines its log says. */
export function keepCheckScreenshots(store: Store, root: string, runId: number, checkout: string, commit: string, now: Date): string[] {
  if (!/^[a-f0-9]{40}$/.test(commit)) return [];
  const shots = collectCheckScreenshots(checkout);
  // Never the check's own outcome: a screenshot that can't be kept is said in its log, and the check stands as it ran.
  try {
    shots.files.forEach((one, at) => {
      storeEvidence(store, root, runId, "screenshot", `check-shot-${at + 1}.${one.kind === "png" ? "png" : "jpg"}`, one.raw, checkScreenshotCapture(one.path, commit, one.kind), now, { captureStatus: "ok" });
    });
  } catch (error) {
    return [`The screenshots in ${CHECK_SHOTS_DIR} couldn't be kept: ${error instanceof Error ? error.message : String(error)}.`];
  }
  return [
    ...(shots.files.length === 0 ? [] : [`Kept ${shots.files.length} screenshot${shots.files.length === 1 ? "" : "s"} from ${CHECK_SHOTS_DIR}.`]),
    ...shots.problems.map(one => `Not kept: ${one.path}: ${one.problem}.`),
  ];
}
