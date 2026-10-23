/**
 * The live peek's NATIVE reader (attended finding 7, CRITICAL): the whole
 * point of this module is what it does not do. No git invocation ever has
 * the agent's worktree as its working tree; nothing here consults
 * gitattributes, hooks, clean/process filters, or external diff drivers —
 * the mechanisms finding 7 proved can execute repository-configured
 * commands. Change detection is a git-blob sha1 computed IN PROCESS against
 * the frozen base tree.
 *
 * Two layers, deliberately separated: the PURE core (sha1, parsers,
 * aggregation — bytes in, structures out) and ONE I/O function,
 * observeWorktree — descriptor-DISCIPLINED, not descriptor-confined: Node
 * has no openat, so traversal is by pathname and a same-UID attacker
 * renaming ancestors mid-walk can misdirect it (round-3 finding 44 owns
 * the honest disclosure). What IS held: files open O_NOFOLLOW|O_NONBLOCK
 * and must fstat as regular files on the root's device before a byte is
 * read; reads go through that descriptor, bounded to the accepted size,
 * with growth re-checked after; directories must prove the root's device
 * before descent; symlinks are never followed; `.git` is never entered;
 * every cap is explicit; unreadable corners make the look PARTIAL rather
 * than silently narrower. Guarding, caching, and serving stay with their
 * owners (serve.ts).
 */

import { createHash } from "node:crypto";
import { open, opendir, readlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

/** git's own blob identity: sha1 over "blob <len>\0" + bytes. Computing it
 * here is what lets change detection never ask git about a working tree. */
export function gitBlobSha1(bytes: Buffer): string {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

/**
 * New-file readability WITHOUT suppression (round-1 finding 19: ignore
 * parsing is gone — a pattern match can HIDE a name, and patterns are
 * agent-influencable). Aggregation only: a first path segment holding more
 * than `groupAt` new files collapses to one row stating its exact count;
 * everything else lists; the row cap saturates with exact totals. No name
 * is ever dropped silently — the numbers always add up.
 */
export type NewFileRow = { label: string; count: number; collapsed: boolean };

export function aggregateNewNames(paths: readonly string[], groupAt = 10, rowCap = 200): {
  rows: NewFileRow[];
  total: number;
  renderedFiles: number;
} {
  const bySegment = new Map<string, string[]>();
  for (const path of paths) {
    const segment = path.includes("/") ? (path.split("/")[0] as string) : "";
    const bucket = bySegment.get(segment) ?? [];
    bucket.push(path);
    bySegment.set(segment, bucket);
  }
  // The HARD row cap covers grouped rows too (round-2 finding 31): many
  // eleven-file groups must saturate the cap exactly like loose names —
  // an agent choosing segment names cannot amplify the output. Largest
  // groups first, so saturation drops the least information.
  const grouped: NewFileRow[] = [];
  const loose: string[] = [];
  for (const [segment, bucket] of bySegment.entries()) {
    if (segment !== "" && bucket.length > groupAt) grouped.push({ label: `${segment}/`, count: bucket.length, collapsed: true });
    else loose.push(...bucket);
  }
  grouped.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  loose.sort();
  const rows: NewFileRow[] = [];
  let renderedFiles = 0;
  for (const row of grouped) {
    if (rows.length >= rowCap) break;
    rows.push(row);
    renderedFiles += row.count;
  }
  for (const path of loose) {
    if (rows.length >= rowCap) break;
    rows.push({ label: path, count: 1, collapsed: false });
    renderedFiles += 1;
  }
  return { rows, total: paths.length, renderedFiles };
}

/**
 * The base-tree snapshot parser (round-1 finding 15's demands, applied to
 * OUR OWN format anyway): every entry is proved shaped before use —
 * relative path with no dot-dot/backslash/control bytes, a known mode,
 * a 40-hex sha, a bounded non-negative size. Anything else refuses the
 * whole snapshot; a partial base is not a base.
 */
export type BaseTreeEntry = { path: string; mode: string; sha: string; size: number };

const KNOWN_MODES = new Set(["100644", "100755", "120000", "160000"]);
const SHA40 = /^[0-9a-f]{40}$/;

/**
 * The enveloped snapshot document (round-2 finding 26): entries alone are
 * not a snapshot — the envelope binds schema version, repository, run, and
 * the exact base OID, and the CONSUMER (not readVerifiedArtifact) proves
 * those against the run row plus capture_status/truncated before any walk.
 */
export type BaseTreeSnapshot = { repo: string; run: number; base: string; entries: BaseTreeEntry[] };

export function encodeBaseTreeSnapshot(snapshot: BaseTreeSnapshot): string {
  return JSON.stringify({
    v: "base-tree/1",
    repo: snapshot.repo,
    run: snapshot.run,
    base: snapshot.base,
    entries: snapshot.entries.map(entry => [entry.path, entry.mode, entry.sha, entry.size]),
  });
}

export function parseBaseTreeSnapshot(json: string, entryCap = 20_000): BaseTreeSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const document = parsed as Record<string, unknown>;
  if (document["v"] !== "base-tree/1") return null;
  const repo = document["repo"];
  const run = document["run"];
  const base = document["base"];
  if (typeof repo !== "string" || repo === "") return null;
  if (typeof run !== "number" || !Number.isInteger(run) || run <= 0) return null;
  if (typeof base !== "string" || !SHA40.test(base)) return null;
  const entries = parseBaseTree(JSON.stringify(document["entries"] ?? null), entryCap);
  if (entries === null) return null;
  return { repo, run, base, entries };
}

export function parseBaseTree(json: string, entryCap = 20_000): BaseTreeEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length > entryCap) return null;
  const entries: BaseTreeEntry[] = [];
  const seen = new Set<string>();
  for (const raw of parsed) {
    if (!Array.isArray(raw) || raw.length !== 4) return null;
    const [path, mode, sha, size] = raw as unknown[];
    if (typeof path !== "string" || typeof mode !== "string" || typeof sha !== "string" || typeof size !== "number") return null;
    if (
      path === "" ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some(part => part === "" || part === "." || part === "..") ||
      /[\u0000-\u001f\u007f\ufffd]/.test(path) ||
      seen.has(path)
    ) {
      return null;
    }
    if (!KNOWN_MODES.has(mode) || !SHA40.test(sha) || !Number.isInteger(size) || size < 0 || size > 8_589_934_592) return null;
    seen.add(path);
    entries.push({ path, mode, sha, size });
  }
  return entries;
}

// ---------------------------------------------------------------- the walk

export type PeekLimits = {
  /** Walk abandons past this many entries — a typed refusal, not a guess. */
  maxEntries: number;
  /** Combined cap across changed+deleted+unchecked rows (finding 38). */
  maxRows: number;
  /** Files larger than this are compared by size only, and say so. */
  maxFileBytes: number;
  /** Total bytes hashed per observation; past it, remaining files go unverified. */
  maxHashedBytes: number;
  /** Wall budget, checked between files — over it, a partial look, never a hang. */
  deadlineMs: number;
};

export const PEEK_LIMITS: PeekLimits = {
  maxEntries: 20_000,
  maxRows: 400,
  maxFileBytes: 1_048_576,
  maxHashedBytes: 64 * 1_048_576,
  deadlineMs: 3_000,
};

export type PeekRow = { kind: "changed" | "deleted" | "unchecked"; path: string; detail: string };

export type Observation =
  | {
      ok: true;
      rows: PeekRow[];
      newPaths: string[];
      /** Non-null when the look is partial, saying why in plain words. */
      partial: string | null;
      scanned: number;
    }
  | { ok: false; reason: string };

/** The lease marker every occupied checkout carries — ours, never news. */
const LEASE_MARKER = ".standing-orders-lease";

/**
 * One best-effort observation of a working tree against its frozen base
 * (v2 brief §2). Descriptor-confined throughout: directories via opendir
 * handles, files via O_NOFOLLOW descriptors, sizes from fstat on the OPEN
 * descriptor (never a path-racy stat), bytes hashed through the same
 * descriptor. Symlinks are typed by lstat-equivalent dirent info and never
 * opened. Nothing here writes, spawns, or evaluates anything.
 */
export async function observeWorktree(
  root: string,
  base: readonly BaseTreeEntry[],
  limits: PeekLimits = PEEK_LIMITS,
): Promise<Observation> {
  const started = Date.now();
  // Device pinning (round-2 finding 27 mitigation): the root's filesystem
  // is the only one this walk will ever read from — a symlinked or
  // bind-mounted escape onto another device is reported, never read.
  let rootDevice: number | bigint;
  try {
    const rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      rootDevice = (await rootHandle.stat()).dev;
    } finally {
      await rootHandle.close();
    }
  } catch {
    return { ok: false, reason: "the checkout could not be opened" };
  }
  const baseByPath = new Map(base.map(entry => [entry.path, entry]));
  const gitlinks = new Set(base.filter(entry => entry.mode === "160000").map(entry => entry.path));
  const seen = new Set<string>();
  const rows: PeekRow[] = [];
  let rowOverflow = 0;
  // ONE combined bound over every row kind (finding 38): past it, rows are
  // counted, not collected — the fragment states the exact overflow.
  const push = (row: PeekRow) => {
    if (rows.length >= limits.maxRows) rowOverflow += 1;
    else rows.push(row);
  };
  const newPaths: string[] = [];
  let scanned = 0;
  let hashedBytes = 0;
  let sizeOnly = 0;
  let unverified = 0;
  let partialDirs = 0;
  let partial: string | null = null;

  const overdue = () => Date.now() - started >= limits.deadlineMs;
  const stack: string[] = [""];
  while (stack.length > 0) {
    if (overdue()) {
      partial = "the look ran out of time — showing what was seen";
      break;
    }
    const relative = stack.pop() as string;
    if (gitlinks.has(relative)) continue; // a vendored repo is opaque, like git treats it
    // Directories prove the root's device BEFORE descent (finding 44): a
    // swapped ancestor pointing cross-device is typed, never enumerated.
    if (relative !== "") {
      try {
        const gate = await open(join(root, relative), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          if ((await gate.stat()).dev !== rootDevice) {
            push({ kind: "unchecked", path: relative, detail: "directory on a different filesystem — not entered" });
            partialDirs += 1;
            continue;
          }
        } finally {
          await gate.close();
        }
      } catch {
        push({ kind: "unchecked", path: relative, detail: "directory could not be opened" });
        partialDirs += 1;
        continue;
      }
    }
    let dir;
    try {
      dir = await opendir(relative === "" ? root : join(root, relative));
    } catch {
      push({ kind: "unchecked", path: relative, detail: "directory could not be read" });
      partialDirs += 1;
      continue;
    }
    try {
      for await (const entry of dir) {
        if (overdue()) {
          partial = "the look ran out of time — showing what was seen";
          break;
        }
        const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
        if (path === ".git" || path === LEASE_MARKER) continue;
        scanned += 1;
        if (scanned > limits.maxEntries) {
          return { ok: false, reason: "this tree is too large to watch live" };
        }
        const inBase = baseByPath.get(path);
        if (entry.isDirectory()) {
          stack.push(path);
          continue;
        }
        if (entry.isSymbolicLink()) {
          seen.add(path);
          if (inBase === undefined) newPaths.push(path);
          else if (inBase.mode !== "120000") push({ kind: "changed", path, detail: "became a link" });
          else {
            // The link's TARGET is the tracked content: readlink never
            // follows, and a 120000 blob's bytes are exactly the target
            // string — so the in-process sha decides (finding 34).
            try {
              const target = await readlink(join(root, path));
              if (gitBlobSha1(Buffer.from(target, "utf8")) !== inBase.sha) {
                push({ kind: "changed", path, detail: "link points elsewhere" });
              }
            } catch {
              push({ kind: "unchecked", path, detail: "link target could not be read" });
            }
          }
          continue; // never opened, never followed
        }
        if (!entry.isFile()) {
          seen.add(path);
          if (inBase !== undefined) push({ kind: "changed", path, detail: "became something else" });
          continue;
        }
        seen.add(path);
        if (inBase === undefined) {
          newPaths.push(path);
          continue;
        }
        if (inBase.mode === "120000") {
          push({ kind: "changed", path, detail: "was a link, now a file" });
          continue;
        }
        // The file: O_NOFOLLOW descriptor; size and mode from fstat ON that
        // descriptor; bytes through it. A path swapped underneath yields a
        // typed miss, never a follow.
        let handle;
        try {
          handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        } catch {
          push({ kind: "changed", path, detail: "could not be read just now" });
          continue;
        }
        try {
          const stat = await handle.stat();
          if (stat.dev !== rootDevice) {
            push({ kind: "unchecked", path, detail: "lives on a different filesystem — not read" });
            continue;
          }
          if (!stat.isFile()) {
            // A FIFO or device node planted at a tracked path: opened
            // non-blocking, typed, and never read (finding 44).
            push({ kind: "unchecked", path, detail: "not a regular file — not read" });
            continue;
          }
          const executable = (stat.mode & 0o100) !== 0;
          const baseExecutable = inBase.mode === "100755";
          if (stat.size !== inBase.size) {
            push({ kind: "changed", path, detail: `${inBase.size} → ${stat.size} bytes` });
            continue;
          }
          if (executable !== baseExecutable) {
            push({ kind: "changed", path, detail: executable ? "became executable" : "lost its executable bit" });
            continue;
          }
          if (stat.size > limits.maxFileBytes) {
            // Same size, too big to hash: SAID, never silently "unchanged".
            push({ kind: "unchecked", path, detail: "same size, too large to verify live" });
            sizeOnly += 1;
            continue;
          }
          if (hashedBytes + stat.size > limits.maxHashedBytes) {
            push({ kind: "unchecked", path, detail: "the verification budget ran out before this file" });
            unverified += 1;
            continue;
          }
          // Read AT MOST the size fstat accepted (finding 33): a file
          // growing underneath is a change, not an unbounded read.
          const hash = createHash("sha1").update(`blob ${stat.size}\0`);
          const buffer = Buffer.alloc(65_536);
          let position = 0;
          let grew = false;
          while (position < stat.size) {
            if (overdue()) {
              partial = "the look ran out of time — showing what was seen";
              break;
            }
            const want = Math.min(buffer.length, stat.size - position);
            const { bytesRead } = await handle.read(buffer, 0, want, position);
            if (bytesRead <= 0) break;
            hash.update(buffer.subarray(0, bytesRead));
            position += bytesRead;
          }
          hashedBytes += position;
          const after = await handle.stat();
          if (position < stat.size || after.size !== stat.size) {
            push({ kind: "unchecked", path, detail: "changed underneath the look" });
            grew = true;
          }
          if (!grew && hash.digest("hex") !== inBase.sha) {
            push({ kind: "changed", path, detail: "edited (same size)" });
          }
        } catch {
          push({ kind: "changed", path, detail: "could not be read just now" });
        } finally {
          await handle.close();
        }
      }
    } catch {
      // Iteration died mid-stream: this corner was not fully seen, so the
      // look is partial and the deleted sweep must not run (finding 44).
      push({ kind: "unchecked", path: relative, detail: "directory could not be fully read" });
      partialDirs += 1;
    }
  }

  if (partial === null && stack.length === 0 && partialDirs === 0) {
    for (const entry of base) {
      if (!seen.has(entry.path) && entry.mode !== "160000" && !isUnder(entry.path, gitlinks)) {
        push({ kind: "deleted", path: entry.path, detail: "gone" });
      }
    }
  } else {
    // A timed-out walk cannot distinguish "deleted" from "not reached".
  }
  const notes: string[] = [];
  if (partial !== null) notes.push(partial);
  if (partialDirs > 0) notes.push(`${partialDirs} folder(s) could not be fully seen — deletions are not reported`);
  if (rowOverflow > 0) notes.push(`${rowOverflow} more change(s) than the live view will render`);
  if (sizeOnly > 0) notes.push(`${sizeOnly} large file(s) compared by size only`);
  if (unverified > 0) notes.push(`${unverified} file(s) unverified — the hashing budget ran out`);
  return { ok: true, rows, newPaths, partial: notes.length === 0 ? null : notes.join("; "), scanned };
}

function isUnder(path: string, roots: ReadonlySet<string>): boolean {
  for (const root of roots) {
    if (path.startsWith(`${root}/`)) return true;
  }
  return false;
}
