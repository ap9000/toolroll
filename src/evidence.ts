/**
 * Evidence: what actually happened, captured by the machine (§4, §7).
 *
 * The agent does not choose what counts as evidence — a diff the agent could
 * fabricate is a screenshot of a different crime scene. At park time the
 * builder captures the working state itself, relative to the base revision
 * stamped before the agent spent anything, and records how each capture was
 * made, whether it is complete, and what it hashes to. A truncated capture
 * says truncated; a failed capture stores the failure. Presenting either as
 * the whole story is the one dishonesty this module exists to rule out.
 *
 * Files live under the evidence root — outside every worktree, so an agent
 * cannot pre-write them — created exclusively (`wx`) with mode 0600. The
 * store holds keys relative to that root, never absolute paths.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { namedPath } from "./names.js";
import { LIMITS } from "./decision.js";
import { TEXT_LIMITS } from "./text-limits.js";
import { parseReport, REPORT_LIMITS, type ParsedReport, type ReportImage } from "./scout-report.js";
import { parseProof, PROOF_LIMITS, type ParsedProof } from "./proof.js";
import { HANDOFF_VERSION, readHandoffArtifact, type HandoffArtifact } from "./contracts/handoff.js";

export type { HandoffArtifact } from "./contracts/handoff.js";
import type { Artifact, Store } from "./store.js";
import type { ExecResult } from "./exec.js";
import { encodeBaseTreeSnapshot, parseBaseTreeSnapshot, type BaseTreeEntry } from "./peek.js";

/** The park mailbox pattern. Each run's actual name carries a nonce; see `mailboxName`. */
export const MAILBOX_PREFIX = "STANDING-ORDERS-PARK-";
/** The terminal handoff: how every non-parking attempt says how it ended. */
export const HANDOFF_PREFIX = "STANDING-ORDERS-DONE-";
/** The planner's terminal handoff: the proposed scope and the plan document. */
export const PLAN_PREFIX = "STANDING-ORDERS-PLAN-";
/** The reviewer's former comment mailbox (v29–evidence-review-v1): the
 * reviewer now replies in its final message and writes nothing, but the
 * pattern stays recognized so a sweep still cleans up a stray file this
 * name left by an older build. */
export const REVIEW_PREFIX = "STANDING-ORDERS-REVIEW-";
/** The scout's terminal handoff (v34): the report, its only deliverable. */
export const REPORT_PREFIX = "STANDING-ORDERS-REPORT-";
/** The build's proof manifest (Priority 2): optional, and read only after
 * the handoff — a completed attempt's proof, never a parking or failure
 * artifact. */
export const PROOF_PREFIX = "STANDING-ORDERS-PROOF-";
export const RUBRIC_PREFIX = "STANDING-ORDERS-RUBRIC-";
/** The running build's atomic milestone checkpoint (adaptive execution
 * plans): overwritten in place — a temp name, then a rename — rather than
 * created once and unlinked, since progress is reported many times across
 * one attempt. Read, never consumed, by the pulse and by settlement. */
export const PROGRESS_PREFIX = "STANDING-ORDERS-PROGRESS-";
/** The running build's bounded, evidence-linked plan-revision proposal
 * (adaptive execution plans): a terminal file like park or proof, written
 * at most once, read once at settlement. */
export const PROPOSAL_PREFIX = "STANDING-ORDERS-PROPOSAL-";
export const MAILBOX_SUFFIX = ".json";
/** v105: left in a run's evidence folder when the retention setting removed its files (retention.ts). */
export const RETENTION_NOTE = "REMOVED-BY-RETENTION";

/** Bounds on a claimed screenshot file's own bytes — independent of the
 * proof manifest's byte cap, since these are binary images, not JSON. */
export const SCREENSHOT_BYTE_CAP = 5 * 1024 * 1024;

/** Check evidence lives in the run's evidence, never on the branch: images a
 * build adds under this folder are left out of its commit. */
export const WORKTREE_EVIDENCE_DIR = "evidence/";
const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp|bmp|ico|tiff?|avif|heic)$/i;
const BINARY_PATH = /\.(?:pdf|zip|gz|tgz|tar|7z|woff2?|ttf|otf|eot|mp4|mov|webm|mp3|wav|sqlite3?|db|wasm|bin|jar|exe|dll|so|dylib)$/i;
export function isImagePath(path: string): boolean { return IMAGE_PATH.test(path); }
/** Images and other files that are never read as text, judged by name alone. */
export function isBinaryAssetPath(path: string): boolean { return IMAGE_PATH.test(path) || BINARY_PATH.test(path); }

/** Bytes each kind may store. Originals can be any size; the record says what was cut. */
/** Bound one captured stream to `cap` bytes keeping its beginning and, mostly,
 * its end: a test runner's summary and failure list come last, and that is
 * what a reviewer or a repair needs to read. */
export const SHORTENED_MARKER = "\n… output shortened; ending follows …\n";
export function boundStreamHeadTail(value: string, cap: number, headShare = 0.2): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= cap) return value;
  const marker = Buffer.from(SHORTENED_MARKER, "utf8");
  // A cut inside a multi-byte character decodes as U+FFFD (three bytes);
  // leave room for one at each edge so the result never exceeds the cap.
  const room = Math.max(0, cap - marker.length - 8);
  const head = Math.floor(room * headShare);
  const tail = room - head;
  return Buffer.concat([bytes.subarray(0, head), marker, bytes.subarray(bytes.length - tail)]).toString("utf8");
}

export const EVIDENCE_CAPS: Record<Artifact["kind"], number> = {
  diff: 256 * 1024,
  status: 64 * 1024,
  "park-payload": LIMITS.payload,
  plan: TEXT_LIMITS.planDocumentBytes,
  "terminal-diff": 256 * 1024,
  "diff-stat": 32 * 1024,
  // The enveloped base snapshot (live peek): 20k entries of path+sha+size.
  "base-tree": 4 * 1024 * 1024,
  handoff: 32 * 1024,
  "revision-brief": 64 * 1024,
  report: REPORT_LIMITS.payload,
  proof: PROOF_LIMITS.payload,
  // Six bounded streams (three attempts × stdout/stderr) plus the summary.
  "check-log": 160 * 1024,
  screenshot: SCREENSHOT_BYTE_CAP,
  "structured-output": 64 * 1024,
  // The planner's recorded source is bounded BEFORE it is written (the
  // planner-source cap IS this value), so a stored record is never a
  // truncated one: what the record holds is exactly what the planner read.
  "plan-contract": 128 * 1024,
  // The inherited review-context inventory (v51): structured JSON that is
  // never byte-truncated — the capture sheds whole items against its own
  // aggregate content limit (REVIEW_CONTEXT_LIMITS) and this cap only has
  // to hold the JSON-escaped form of that bounded content plus provenance.
  "review-context": 200 * 1024 * 1024,
};

export function evidenceRoot(home: string): string {
  // Same continuity rule as the database: evidence recorded under an older
  // name keeps verifying until a new-name root exists.
  return namedPath(home, ["evidence"], { dot: true });
}

/**
 * Unpredictable per attempt, so nothing on disk before this build can already
 * be the mailbox: a stale file, however it got there, simply has the wrong
 * name. The agent learns the name from its brief and nowhere else.
 */
export function mailboxName(): string {
  return `${MAILBOX_PREFIX}${randomBytes(8).toString("hex")}${MAILBOX_SUFFIX}`;
}

export function looksLikeMailbox(name: string): boolean {
  return name.startsWith(MAILBOX_PREFIX) && name.endsWith(MAILBOX_SUFFIX);
}

/** Every protocol file the sweep must never let an old attempt leave behind.
 * The pre-rename NIGHTORDERS- prefix stays recognized here — a worktree cut
 * down before 2026-08-13 may still hold one, and cleanup has no vintage. */
export function looksLikeProtocolFile(name: string): boolean {
  return (
    (name.startsWith(MAILBOX_PREFIX) ||
      name.startsWith(HANDOFF_PREFIX) ||
      name.startsWith(PLAN_PREFIX) ||
      name.startsWith(REVIEW_PREFIX) ||
      name.startsWith(REPORT_PREFIX) ||
      name.startsWith(PROOF_PREFIX) ||
      name.startsWith(RUBRIC_PREFIX) ||
      name === "STANDING-ORDERS-OBSERVATIONS.json" ||
      name.startsWith(PROGRESS_PREFIX) ||
      name.startsWith(PROPOSAL_PREFIX) ||
      name.startsWith("NIGHTORDERS-")) &&
    name.endsWith(MAILBOX_SUFFIX)
  );
}

export function handoffName(): string {
  return `${HANDOFF_PREFIX}${randomBytes(8).toString("hex")}${MAILBOX_SUFFIX}`;
}

export function planFileName(): string {
  return `${PLAN_PREFIX}${randomBytes(8).toString("hex")}${MAILBOX_SUFFIX}`;
}

/** The build's optional proof manifest (Priority 2), named exactly like
 * every other protocol file — a nonce the agent learns only from its brief. */
export function proofFileName(): string {
  return `${PROOF_PREFIX}${randomBytes(8).toString("hex")}${MAILBOX_SUFFIX}`;
}

export function rubricFileName(): string {
  return `${RUBRIC_PREFIX}${randomBytes(8).toString("hex")}${MAILBOX_SUFFIX}`;
}

export function reportFileName(): string {
  return `${REPORT_PREFIX}${randomBytes(8).toString("hex")}${MAILBOX_SUFFIX}`;
}

export function progressFileName(): string {
  return `${PROGRESS_PREFIX}${randomBytes(8).toString("hex")}${MAILBOX_SUFFIX}`;
}

export function proposalFileName(): string {
  return `${PROPOSAL_PREFIX}${randomBytes(8).toString("hex")}${MAILBOX_SUFFIX}`;
}

/**
 * Read a mailbox without following anything: the path must be a regular file,
 * opened O_NOFOLLOW and measured through its own descriptor — an agent that
 * made the pathname a symlink or FIFO gets a refusal, not a runner reading an
 * unrelated local file into web-visible evidence.
 */
export function readMailbox(
  path: string,
  cap: number = LIMITS.payload,
):
  | { ok: true; raw: Buffer }
  | { ok: false; problem: string; missing: boolean; raw?: Buffer; bytesOriginal?: number } {
  let fd: number;
  try {
    // O_NONBLOCK matters before the type check: opening a FIFO read-only can
    // otherwise wait forever for a writer, outside every provider timeout.
    // Once the descriptor is open we still accept regular files only.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      missing: code === "ENOENT",
      problem:
        code === "ELOOP"
          ? "the mailbox is a symlink, which is not a park — it is a pointer at somebody else's file"
          : `cannot open the mailbox: ${code ?? String(error)}`,
    };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { ok: false, missing: false, problem: "the mailbox is not a regular file" };
    }
    if (stat.size > cap) {
      // Oversize is invalid protocol, but it is still emitted evidence.
      // Capture only the bounded prefix from this already no-follow-opened
      // descriptor and carry the exact observed size so callers can retain
      // an honest, capped artifact without allocating attacker-sized input.
      const prefix = Buffer.alloc(cap);
      let offset = 0;
      while (offset < prefix.length) {
        const read = readSync(fd, prefix, offset, prefix.length - offset, offset);
        if (read <= 0) break;
        offset += read;
      }
      return {
        ok: false,
        missing: false,
        problem: `the mailbox is over ${cap} bytes`,
        raw: prefix.subarray(0, offset),
        bytesOriginal: Number(stat.size),
      };
    }
    const buffer = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    return { ok: true, raw: buffer.subarray(0, offset) };
  } finally {
    closeSync(fd);
  }
}

/** A scout's report as a surface reads it (mate arc §10): the newest
 * scout run's artifact, VERIFIED before a byte is parsed, then parsed with
 * the same 422 rule that admitted it. null = no report; a problem names
 * why an existing artifact cannot be shown rather than showing nothing. */
export type ReportView =
  | { ok: true; run: number; report: ParsedReport; shots: ReportShot[] }
  | { ok: false; run: number; problem: string };

/** A report's screenshot as a page shows it: its stored evidence, or why it can't be shown. The bytes are
 * verified again whenever the image itself is served. */
export type ReportShot = { file: string; caption: string; url: string; artifactId: number | null; problem: string | null };

/** Each image a report names, matched to the screenshot evidence its own run stored with the same sha256. */
export function reportShotsOf(artifacts: readonly Artifact[], root: string, run: number, images: readonly ReportImage[]): ReportShot[] {
  const pruned = existsSync(join(root, String(run), RETENTION_NOTE));
  return images.map(image => {
    const stored = artifacts.find(one => one.id === image.artifact && one.run === run && one.kind === "screenshot" && one.sha256 === image.sha256);
    const problem = pruned ? "removed by the retention setting" : stored === undefined ? "the saved screenshot is missing" : null;
    return { file: image.file, caption: image.caption, url: image.url, artifactId: problem === null ? stored!.id : null, problem };
  });
}

export function readVerifiedReport(store: Store, root: string, taskRef: number): ReportView | null {
  const artifact = store.latestReportArtifact(taskRef);
  if (artifact === null) return null;
  let verified: ReturnType<typeof readVerifiedArtifact>;
  try {
    verified = readVerifiedArtifact(root, artifact);
  } catch {
    return { ok: false, run: artifact.run, problem: "the report file could not be read" };
  }
  if (!verified.ok) return { ok: false, run: artifact.run, problem: `the report does not verify (${verified.problem})` };
  const parsed = parseReport(verified.content.toString("utf8"), { stored: true });
  if (!parsed.ok) return { ok: false, run: artifact.run, problem: "the stored report is not a report this build can read" };
  return { ok: true, run: artifact.run, report: parsed.report, shots: reportShotsOf(store.artifactsFor(artifact.run), root, artifact.run, parsed.report.images) };
}

/** A build's proof, read the same verified way as a scout's report — but
 * keyed by RUN, not task: unlike a scout's report (the task's one rolling
 * deliverable), a proof belongs to the one attempt whose page is showing
 * it. null = no proof artifact for this run; a problem names why an
 * existing one cannot be shown. */
export type ProofView =
  | { ok: true; run: number; proof: ParsedProof }
  | { ok: false; run: number; problem: string };

/** Verifies this run's proof bytes and format. A handoff that relies on a
 * revision's ancestors must also recheck its saved review-context custody. */
export function readVerifiedProofForRun(store: Store, root: string, runId: number): ProofView | null {
  const artifact = store.artifactsFor(runId).find(one => one.kind === "proof") ?? null;
  if (artifact === null) return null;
  let verified: ReturnType<typeof readVerifiedArtifact>;
  try {
    verified = readVerifiedArtifact(root, artifact);
  } catch {
    return { ok: false, run: runId, problem: "the proof file could not be read" };
  }
  if (!verified.ok) return { ok: false, run: runId, problem: `the proof does not verify (${verified.problem})` };
  const parsed = parseProof(verified.content.toString("utf8"));
  if (!parsed.ok) return { ok: false, run: runId, problem: "the stored proof is not a proof this build can read" };
  return { ok: true, run: runId, proof: parsed.proof };
}

/**
 * The PNG and JPEG magic bytes — the only two formats a screenshot may
 * claim to be (scope: "no arbitrary binary evidence beyond bounded
 * PNG/JPEG screenshots"). Sniffed from the bytes themselves, never from a
 * claimed extension: an extension is a string an agent chose, a signature
 * is not.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

export function sniffImageKind(bytes: Buffer): "png" | "jpeg" | null {
  if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return "png";
  if (bytes.length >= JPEG_SIGNATURE.length && bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) return "jpeg";
  return null;
}

/** Whether bytes claimed as a screenshot actually are a bounded PNG or
 * JPEG — the one check standing between a claimed path and stored,
 * immutable image evidence. */
export function validateScreenshotBytes(bytes: Buffer): { ok: true; kind: "png" | "jpeg" } | { ok: false; problem: string } {
  if (bytes.length === 0) return { ok: false, problem: "the file is empty" };
  if (bytes.length > SCREENSHOT_BYTE_CAP) {
    return { ok: false, problem: `the file is over ${SCREENSHOT_BYTE_CAP} bytes` };
  }
  const kind = sniffImageKind(bytes);
  if (kind === null) return { ok: false, problem: "the file is not a PNG or JPEG (checked by signature, not extension)" };
  return { ok: true, kind };
}

/**
 * Pixel dimensions read straight from the format's own header — never
 * decoded, never trusting a claimed size (v39, screenshot evidence:
 * "meaningful byte size and at least 320 by 200 dimensions"). `null` when
 * the bytes are a valid signature but the header could not be read (a
 * genuinely corrupt or truncated file) — the caller treats that the same
 * as failing the size floor, never as passing it.
 *
 * PNG: the IHDR chunk is fixed at bytes 8-25 for every valid PNG — width
 * and height are the two big-endian uint32s right after it starts.
 *
 * JPEG: scan markers from byte 2. Every marker except the two without a
 * payload (SOI 0xD8, EOI 0xD9) and the RST markers (0xD0-0xD7) carries a
 * two-byte big-endian length; the SOF markers (0xC0-0xCF, excluding the
 * DHT/JPG/DAC markers 0xC4/0xC8/0xCC, which share the range but are not
 * frame headers) hold precision(1) + height(2) + width(2) right after
 * that length field.
 */
export function imageDimensions(bytes: Buffer, kind: "png" | "jpeg"): { width: number; height: number } | null {
  if (kind === "png") {
    if (bytes.length < 26) return null;
    // Bytes 12-15 must literally spell IHDR, or this is not a PNG this
    // reader understands well enough to trust the offsets that follow.
    if (bytes.toString("ascii", 12, 16) !== "IHDR") return null;
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  }
  // JPEG: walk markers looking for a Start Of Frame.
  let offset = 2;
  const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return null; // not a marker boundary — malformed
    let marker = bytes[offset + 1] as number;
    offset += 2;
    // Fill bytes (0xFF padding) between markers.
    while (marker === 0xff && offset < bytes.length) {
      marker = bytes[offset] as number;
      offset += 1;
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no payload
    if (offset + 1 >= bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (SOF_MARKERS.has(marker)) {
      if (offset + 7 >= bytes.length) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }
    if (marker === 0xda) return null; // Start Of Scan — image data follows, no SOF was found first
    offset += length;
  }
  return null;
}

/**
 * Write one evidence file and record it. The row is written through the
 * store the caller passed — inside whatever transaction the caller holds.
 */
export function storeEvidence(
  store: Store,
  root: string,
  runId: number,
  kind: Artifact["kind"],
  name: string,
  content: Buffer,
  capture: string,
  now: Date,
  options: { redacted?: boolean; captureStatus?: "ok" | "failed"; sourceBytesOriginal?: number } = {},
): number {
  const cap = EVIDENCE_CAPS[kind];
  const stored = content.subarray(0, cap);
  // Some callers that deliberately summarize/bound a source before storage
  // may still report its true original size. This keeps `truncated` honest
  // even when the already-bounded representation fits beneath this layer's
  // cap (for example a three-attempt verification log).
  const bytesOriginal = Math.max(content.length, options.sourceBytesOriginal ?? content.length);
  const key = writeEvidenceFile(root, runId, name, stored);
  return store.saveArtifact(
    {
      run: runId,
      kind,
      key,
      bytesOriginal,
      bytesStored: stored.length,
      truncated: bytesOriginal > stored.length,
      sha256: createHash("sha256").update(stored).digest("hex"),
      capture,
      ...(options.redacted === true ? { redacted: true } : {}),
      ...(options.captureStatus === undefined ? {} : { captureStatus: options.captureStatus }),
    },
    now,
  );
}

/**
 * Read an artifact's bytes back, believing nothing until it is proved on the
 * descriptor actually read (§7's honesty, applied to serving). The record's
 * key must be a normalized relative path; the resolved path must live under
 * the root; the open refuses symlinks; the size and hash checks run against
 * the same descriptor the bytes come from — so a pathname swapped between a
 * check and the read buys an attacker nothing. Only a buffer whose SHA-256
 * matches the row is ever returned: unverified bytes never leave this
 * function, which is what lets a caller stream with a clear conscience.
 * Success proves stored-byte integrity only. Callers must independently
 * decide whether a shortened representation or failed capture is usable;
 * a verified failure log is still a failure, not successful evidence.
 */
// Recovery uses this read boundary for retained receipts and handoffs: inspecting
// bytes must never reseal a missing artifact or turn a saved failure into a pass.
export function readVerifiedArtifact(
  root: string,
  artifact: Artifact,
): { ok: true; content: Buffer } | { ok: false; problem: string } {
  const segments = artifact.key.split("/");
  const wellFormed =
    segments.length > 0 &&
    segments.every(
      segment =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.includes("\\") &&
        // eslint-disable-next-line no-control-regex
        !/[\u0000-\u001f\u007f:]/.test(segment),
    );
  if (!wellFormed) return { ok: false, problem: "the key is not a normalized relative path" };

  const cap = EVIDENCE_CAPS[artifact.kind];
  if (artifact.bytesStored > cap) {
    return { ok: false, problem: "the record claims more bytes than its kind may store" };
  }

  let resolved: string;
  try {
    resolved = realpathSync(join(root, ...segments));
    const rootReal = realpathSync(root);
    if (!resolved.startsWith(rootReal + sep)) {
      return { ok: false, problem: "the file resolves outside the evidence root" };
    }
  } catch {
    if (existsSync(join(root, segments[0]!, RETENTION_NOTE))) return { ok: false, problem: "the file was removed by the retention setting" };
    return { ok: false, problem: "the file is gone or unresolvable" };
  }

  let fd: number;
  try {
    fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { ok: false, problem: "cannot open the file without following a link" };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, problem: "not a regular file" };
    if (Number(stat.size) !== artifact.bytesStored) {
      return { ok: false, problem: "the file's size no longer matches its record" };
    }
    const buffer = Buffer.alloc(artifact.bytesStored);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    if (offset !== buffer.length) return { ok: false, problem: "the file ended early" };
    const digest = createHash("sha256").update(buffer).digest("hex");
    if (digest !== artifact.sha256) {
      return { ok: false, problem: "the file no longer hashes to its record" };
    }
    return { ok: true, content: buffer };
  } finally {
    closeSync(fd);
  }
}

/** The file alone, no row — quarantines use this; they belong to no live run. */
export function writeEvidenceFile(root: string, runId: number, name: string, content: Buffer): string {
  const dir = join(root, String(runId));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, name), content, { flag: "wx", mode: 0o600 });
  return `${runId}/${name}`;
}

/**
 * Sweep every park-shaped file out of a worktree before the agent runs.
 *
 * A mailbox left by a cut-down attempt is never ingested as a decision — the
 * lease that could have vouched for it is gone — but its bytes may still say
 * what the agent meant, so what can be read safely is kept under quarantine
 * in the current run's evidence directory. What cannot be read safely (a
 * symlink, a FIFO, something oversized) is removed unread.
 */
export function quarantineMailboxes(
  worktree: string,
  root: string | null,
  runId: number | null,
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(worktree);
  } catch {
    return [];
  }

  const swept: string[] = [];
  for (const name of entries) {
    if (!looksLikeProtocolFile(name)) continue;
    const path = join(worktree, name);
    if (root !== null && runId !== null) {
      const read = readMailbox(path);
      if (read.ok) {
        try {
          writeEvidenceFile(root, runId, `quarantine-${randomBytes(4).toString("hex")}-${name}`, read.raw);
        } catch {
          // Quarantine is best-effort; removal below is not.
        }
      }
    }
    try {
      unlinkSync(path);
      swept.push(name);
    } catch {
      // A mailbox that cannot be removed will fail the freshness check at
      // ingestion anyway: it does not carry this attempt's nonce.
    }
  }
  return swept;
}

/**
 * Capture the park's evidence: the complete working state against the base
 * revision, and the porcelain inventory that names what the diff cannot —
 * untracked and staged files included. External diff drivers and textconv
 * are disabled by name: both run repository-configured commands, and this
 * capture must not execute anything the agent may have just written.
 */
export async function captureParkEvidence(
  store: Store,
  git: (file: string, args: readonly string[], options?: { cwd?: string }) => Promise<ExecResult>,
  worktree: string,
  baseRevision: string | null,
  root: string,
  runId: number,
  now: Date,
): Promise<number[]> {
  const captures: { kind: Artifact["kind"]; name: string; args: string[] }[] = [
    {
      kind: "diff",
      name: "diff.patch",
      args:
        baseRevision === null
          ? ["--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv", "--no-color"]
          : ["--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv", "--no-color", baseRevision, "--", "."],
    },
    {
      kind: "status",
      name: "status.txt",
      args: ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"],
    },
  ];

  const ids: number[] = [];
  for (const { kind, name, args } of captures) {
    const result = await git("git", args, { cwd: worktree });
    const command = `git ${args.filter(a => a !== "--no-optional-locks").join(" ")} (exit ${result.code})`;
    // A failed capture is stored as the failure it is — stderr under the
    // same key, labeled by its exit code — never silently skipped, because
    // "no diff shown" and "diff capture failed" read very differently at 7am.
    const content = Buffer.from(result.code === 0 ? result.stdout : result.stderr, "utf8");
    ids.push(storeEvidence(store, root, runId, kind, name, content, command, now));
  }
  return ids;
}

/** One file's row in the terminal diff-stat. null adds/dels = binary. */
export type DiffStatFile = {
  path: string;
  additions: number | null;
  deletions: number | null;
  renamedFrom?: string;
};

export type DiffStat = {
  schema: 1;
  base: string;
  head: string;
  fileCount: number;
  additions: number;
  deletions: number;
  binaryCount: number;
  files: DiffStatFile[];
  /** True when the file list was cut to fit the cap — counts stay complete. */
  filesTruncated: boolean;
};

const DIFF_STAT_FILE_LIMIT = 400;

/**
 * Parse `git diff --numstat -z` output. NUL-delimited, so filenames are never
 * guessed out of patch headers (Codex roadmap review, scope cut A.3): plain
 * entries are one token "adds\tdels\tpath"; renames are "adds\tdels\t" with
 * the two paths as the following tokens. Binary files carry "-" counts,
 * recorded as null — never coerced to zero.
 */
export function parseNumstat(raw: string, base: string, head: string): DiffStat {
  const tokens = raw.split("\u0000").filter(token => token.length > 0);
  const files: DiffStatFile[] = [];
  let additions = 0;
  let deletions = 0;
  let binaryCount = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    const parts = token.split("\t");
    if (parts.length < 3) continue; // not a numstat entry this parser knows
    const adds = parts[0] === "-" ? null : Number(parts[0]);
    const dels = parts[1] === "-" ? null : Number(parts[1]);
    if ((adds !== null && !Number.isFinite(adds)) || (dels !== null && !Number.isFinite(dels))) continue;
    let path = parts.slice(2).join("\t");
    let renamedFrom: string | undefined;
    if (path === "") {
      // Rename: the next two tokens are the old and new paths.
      renamedFrom = tokens[i + 1];
      path = tokens[i + 2] ?? "";
      i += 2;
      if (path === "") continue;
    }
    if (adds === null || dels === null) binaryCount += 1;
    additions += adds ?? 0;
    deletions += dels ?? 0;
    files.push({ path, additions: adds, deletions: dels, ...(renamedFrom === undefined ? {} : { renamedFrom }) });
  }
  const kept = files.slice(0, DIFF_STAT_FILE_LIMIT);
  return {
    schema: 1,
    base,
    head,
    fileCount: files.length,
    additions,
    deletions,
    binaryCount,
    files: kept,
    filesTruncated: kept.length < files.length,
  };
}

/**
 * Write the handoff artifact (M6.10): the machine's own statement of where
 * a finished run left the world — workspace identity, exact base and head,
 * which answered decisions the brief carried, and a freshness stamp a
 * successor can PROVE against the branch before spending a token on stale
 * context. This is what makes a cold takeover context-bearing rather than
 * repo-only; a provider session is memory, not a freshness proof.
 */
export function storeHandoffArtifact(
  store: Store,
  root: string,
  payload: Omit<HandoffArtifact, "version">,
  now: Date,
): number {
  const read = readHandoffArtifact({ version: HANDOFF_VERSION, ...payload });
  if (!read.ok) throw new Error(`The handoff does not match its contract: ${read.issues.map(issue => issue.line).join("; ")}`);
  return storeEvidence(
    store,
    root,
    payload.runId,
    "handoff",
    "handoff.json",
    Buffer.from(JSON.stringify(read.value, null, 2), "utf8"),
    "machine-authored handoff (exit 0)",
    now,
  );
}

/**
 * High-confidence secret shapes ONLY (audit IV-7): a detector that cries
 * wolf trains people to approve wolves. Each pattern is a format no
 * ordinary source line matches by accident; generic "password=" shapes
 * are deliberately absent — test fixtures would drown the signal.
 */
export const SECRET_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|github_pat_[A-Za-z0-9_]{22,}/ },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "npm-auth-token", pattern: /_authToken\s*=\s*[^\s$][^\s]*/ },
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{32,}\b/ },
  // v99: the other keys a team pastes most.
  { name: "stripe-key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b|\bwhsec_[A-Za-z0-9]{24,}\b/ },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { name: "telegram-bot-token", pattern: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/ },
  { name: "discord-bot-token", pattern: /\b[MN][A-Za-z\d]{23,25}\.[\w-]{6}\.[\w-]{27,}\b/ },
  { name: "password-in-url", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]{3,}@[^\s/]/i },
];

export type SecretHit = { name: string; line: number };

/** Scan text line by line; every hit names its pattern and line. */
export function scanForSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(lines[index] as string)) {
        hits.push({ name, line: index + 1 });
        break;
      }
    }
  }
  return hits;
}

/** Hosts the DNS standards reserve for examples and loopback (RFC 2606,
 * RFC 6761): a URL with a password on one of these reaches nothing real. */
function reservedHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (name === "127.0.0.1" || name === "::1") return true;
  if (/(?:^|\.)example\.(?:com|net|org)$/.test(name)) return true;
  return /(?:^|\.)(?:example|test|invalid|localhost)$/.test(name);
}

/** Mostly one character, e.g. "sk-" and forty a's: a fixture, not a key. */
function repeatedFiller(value: string): boolean {
  const longest = value.split(/[^A-Za-z0-9]+/).reduce((best, part) => (part.length > best.length ? part : best), "");
  if (longest.length < 8) return false;
  const counts = new Map<string, number>();
  for (const char of longest) counts.set(char, (counts.get(char) ?? 0) + 1);
  return Math.max(...counts.values()) * 2 > longest.length;
}

/**
 * Whether one matched secret shape is a documented or reserved placeholder:
 * anything spelling EXAMPLE (AWS's own AKIAIOSFODNN7EXAMPLE), a password on
 * a reserved example host, or a value that is mostly one repeated character.
 */
export function isPlaceholderSecret(name: string, line: string, match: RegExpExecArray): boolean {
  if (name === "private-key") return false;
  if (/example/i.test(match[0])) return true;
  if (name !== "password-in-url") return repeatedFiller(match[0]);
  const host = /^(\[[^\]\s]*\]|[^\s/:?#'"`]+)/.exec(line.slice(match.index + match[0].length - 1))?.[1] ?? "";
  const password = /:([^\s:@/]+)@[^@]*$/.exec(match[0])?.[1] ?? "";
  return reservedHost(host) || repeatedFiller(password);
}

/** The first secret shape on a line that is not a placeholder, if any. */
function realSecretShape(line: string): string | null {
  for (const { name, pattern } of SECRET_PATTERNS) {
    for (const match of line.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
      if (!isPlaceholderSecret(name, line, match)) return name;
    }
  }
  return null;
}

/** A secret shape the diff ADDS, with the patch line (for redaction) and
 * the file and line it lands on at the new head (for the alert). */
export type PatchSecretHit = SecretHit & { file: string; fileLine: number };

/**
 * Scan a unified diff for secrets it commits: only added lines count —
 * removing a line cannot commit a secret, and context lines were already
 * there — and documented or reserved placeholders are not secrets.
 */
export function scanPatchForSecrets(patch: string): PatchSecretHit[] {
  const hits: PatchSecretHit[] = [];
  const lines = patch.split("\n");
  let file = "";
  let inHunk = false;
  let next = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      file = /^diff --git a\/.* b\/(.*)$/.exec(line)?.[1] ?? "";
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) {
      inHunk = true;
      next = Number(hunk[1]);
      continue;
    }
    if (!inHunk) {
      if (line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("+")) {
      const name = realSecretShape(line.slice(1));
      if (name !== null) hits.push({ name, line: index + 1, file, fileLine: next });
      next += 1;
    } else if (line.startsWith(" ")) next += 1;
  }
  return hits;
}

/** The alert for a candidate head with a flagged added line: where each
 * hit is and what to do, without repeating the value. */
export function secretAlert(hits: readonly PatchSecretHit[], runId: number): { subject: string; body: string } {
  const shown = hits.slice(0, 5).map(hit => `${hit.file}:${hit.fileLine} (${hit.name})`);
  const more = hits.length > shown.length ? `, and ${hits.length - shown.length} more` : "";
  return {
    subject: `Run #${runId} adds what looks like a key`,
    body:
      `${hits.length === 1 ? "An added line looks" : `${hits.length} added lines look`} like a real key: ${shown.join(", ")}${more}. ` +
      `This run won't be published and the saved diff hides ${hits.length === 1 ? "that line" : "those lines"}. ` +
      `If this is a real key, rotate it and rewrite the branch. If it's a test value, assemble it at run time.`,
  };
}

/** Replace every hit line with a marker naming what was found — the display copy holds no secret. */
export function redactSecretLines(text: string, hits: readonly SecretHit[]): string {
  const flagged = new Map(hits.map(hit => [hit.line, hit.name]));
  return text
    .split("\n")
    .map((line, index) => {
      const name = flagged.get(index + 1);
      return name === undefined ? line : `[redacted: ${name} detected on this line]`;
    })
    .join("\n");
}

/**
 * Fit a DiffStat under its cap by shedding FILES, never bytes (audit C-4):
 * a structured artifact cut mid-token is not a smaller stat, it is no stat.
 * Aggregate counts always survive; the file list shrinks until the encoded
 * JSON fits, and filesTruncated says so.
 */
export function budgetedStatJson(stat: DiffStat): Buffer {
  const cap = EVIDENCE_CAPS["diff-stat"];
  let files = stat.files;
  for (;;) {
    const candidate: DiffStat = {
      ...stat,
      files,
      filesTruncated: stat.filesTruncated || files.length < stat.files.length,
    };
    const encoded = Buffer.from(JSON.stringify(candidate), "utf8");
    if (encoded.length <= cap || files.length === 0) return encoded;
    files = files.slice(0, Math.floor(files.length / 2));
  }
}

/**
 * Capture the TERMINAL diff — the immutable base→head patch of a run that
 * committed, taken before its worktree is released (M5.3; the Codex scope
 * cut is the spec). Two artifacts: the bounded plain patch, and a
 * machine-parsed stat whose filenames came NUL-delimited from git, never
 * from patch headers. Same execution posture as the park capture: external
 * diff drivers and textconv disabled by name, because this must not run
 * anything the agent may have just written. A no-change run stores the
 * explicit zero-stat rather than storing nothing — "no diff" and "capture
 * failed" have to read differently.
 */
export async function captureTerminalDiff(
  store: Store,
  git: (file: string, args: readonly string[], options?: { cwd?: string }) => Promise<ExecResult>,
  worktree: string,
  base: string,
  head: string,
  root: string,
  runId: number,
  now: Date,
): Promise<{ diffId: number; statId: number }> {
  const patchArgs = ["--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv", "--no-color", base, head];
  const patch = await git("git", patchArgs, { cwd: worktree });
  const patchCommand = `git ${patchArgs.filter(a => a !== "--no-optional-locks").join(" ")} (exit ${patch.code})`;
  // The secret scan (audit IV-7): a committed credential must not gain a
  // SECOND durable, console-served copy. Hit lines are redacted in the
  // stored artifact, the row says redacted, a page names the branch — and
  // the publication gate refuses to push a redacted run's branch anywhere.
  // Only lines the diff adds count, and the alert is one per candidate head:
  // every gate over the same head would otherwise repeat it.
  const rawPatch = patch.code === 0 ? patch.stdout : patch.stderr;
  const hits = patch.code === 0 ? scanPatchForSecrets(rawPatch) : [];
  const patchContent = Buffer.from(hits.length > 0 ? redactSecretLines(rawPatch, hits) : rawPatch, "utf8");
  const diffId = storeEvidence(store, root, runId, "terminal-diff", "terminal-diff.patch", patchContent, patchCommand, now, {
    redacted: hits.length > 0,
    captureStatus: patch.code === 0 ? "ok" : "failed",
  });
  if (hits.length > 0) {
    store.enqueueNotification(
      {
        source: { run: runId },
        dedupeKey: `secret:${head}`,
        kind: "secret-detected",
        pushClass: "attention",
        link: `/r/${runId}`,
        ...secretAlert(hits, runId),
      },
      now,
    );
  }

  const statArgs = ["--no-optional-locks", "diff", "--numstat", "-z", base, head];
  const stat = await git("git", statArgs, { cwd: worktree });
  const statCommand = `git ${statArgs.filter(a => a !== "--no-optional-locks").join(" ")} (exit ${stat.code})`;
  const statContent =
    stat.code === 0
      ? budgetedStatJson(parseNumstat(stat.stdout, base, head))
      : Buffer.from(stat.stderr, "utf8");
  const statId = storeEvidence(store, root, runId, "diff-stat", "terminal-diff-stat.json", statContent, statCommand, now, {
    captureStatus: stat.code === 0 ? "ok" : "failed",
  });

  return { diffId, statId };
}

/**
 * The live peek's base snapshot (live-peek v3 §1), captured in the same
 * pre-spawn window that computed `base` itself — one `ls-tree` against the
 * project clone (NEVER a worktree), lazy-fetch and replace-refs disabled
 * on argv, the child's environment reduced to an allowlist that contains
 * no GIT_* at all. The parsed listing is round-tripped through the strict
 * snapshot codec: any entry the codec refuses — including paths the UTF-8
 * decode mangled into U+FFFD — refuses the WHOLE snapshot, recorded as a
 * failed capture. Integrity class: the database's own, claimed as nothing
 * more (round-3 finding 42).
 */
export async function captureBaseTree(
  store: Store,
  git: (file: string, args: readonly string[], options?: { cwd?: string; envAllowlist?: readonly string[] }) => Promise<ExecResult>,
  repoRoot: string,
  repo: string,
  base: string,
  root: string,
  runId: number,
  now: Date,
): Promise<{ ok: boolean }> {
  // Fail-soft throughout: a snapshot that cannot capture disables the live
  // peek for this run and NOTHING else — the build must proceed untouched,
  // and an invalid run refuses later at the invocation gateway, typed.
  try {
    return await captureBaseTreeInner(store, git, repoRoot, repo, base, root, runId, now);
  } catch {
    return { ok: false };
  }
}

async function captureBaseTreeInner(
  store: Store,
  git: (file: string, args: readonly string[], options?: { cwd?: string; envAllowlist?: readonly string[] }) => Promise<ExecResult>,
  repoRoot: string,
  repo: string,
  base: string,
  root: string,
  runId: number,
  now: Date,
): Promise<{ ok: boolean }> {
  const args = ["--no-lazy-fetch", "--no-replace-objects", "--no-optional-locks", "ls-tree", "-r", "-l", "-z", base];
  const listed = await git("git", args, { cwd: repoRoot, envAllowlist: ["PATH", "HOME"] });
  const command = `git ls-tree -r -l -z ${base} (exit ${listed.code})`;
  const refuse = (): { ok: false } => {
    storeEvidence(store, root, runId, "base-tree", "base-tree.json", Buffer.alloc(0), command, now, {
      captureStatus: "failed",
    });
    return { ok: false };
  };
  if (listed.code !== 0) return refuse();
  const entries: BaseTreeEntry[] = [];
  for (const record of listed.stdout.split("\u0000")) {
    if (record === "") continue;
    // "<mode> <type> <sha> <size>\t<path>" — size is "-" for gitlinks.
    const tab = record.indexOf("\t");
    if (tab < 0) return refuse();
    const head = record.slice(0, tab).trim().split(/\s+/);
    const path = record.slice(tab + 1);
    const [mode, , sha, sizeText] = head;
    if (head.length !== 4 || mode === undefined || sha === undefined || sizeText === undefined) return refuse();
    const size = sizeText === "-" ? 0 : Number(sizeText);
    entries.push({ path, mode, sha, size });
    if (entries.length > 20_000) return refuse();
  }
  const encoded = encodeBaseTreeSnapshot({ repo, run: runId, base, entries });
  // The strict codec is the gate: what it cannot re-read, nothing stores.
  if (parseBaseTreeSnapshot(encoded) === null) return refuse();
  storeEvidence(store, root, runId, "base-tree", "base-tree.json", Buffer.from(encoded, "utf8"), command, now, {
    captureStatus: "ok",
  });
  return { ok: true };
}
