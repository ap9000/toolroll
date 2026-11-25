import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import type { DirectChatProvider } from "./direct-chat.js";
import type { Store } from "./store.js";

export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const MAX_ARTIFACTS_PER_TURN = 20;

export const ALLOWED_IMAGE_MIMES = Object.freeze({
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
} as const);

export const ALLOWED_ATTACHMENT_TEXT_MIMES = Object.freeze({
  "text/plain": ".txt",
  "text/markdown": ".md",
  "application/json": ".json",
} as const);

export type SafeImageMime = keyof typeof ALLOWED_IMAGE_MIMES;
export type AllowedArtifactMime = SafeImageMime | keyof typeof ALLOWED_ATTACHMENT_TEXT_MIMES;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const SKIPPED_SCAN_DIRS = new Set([
  ".git",
  "node_modules",
  ".toolroll-attachments",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "dist",
  "build",
  "target",
]);

export type DirectChatArtifactRow = {
  id: string;
  threadId: string;
  turnId: string | null;
  kind: "output" | "attachment";
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  storagePath: string;
  sourcePath: string | null;
  createdAt: string;
};

/**
 * Validate real image file signatures (magic bytes). Never trusts file extensions
 * or client-supplied MIME types, and intentionally excludes SVG to prevent XSS.
 */
export function detectSafeImageMime(bytes: Buffer): SafeImageMime | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
    && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return "image/gif";
  }
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  return null;
}

export function sanitizeArtifactFilename(raw: string, fallbackExt: string): string {
  const base = basename(raw.replace(/\\/g, "/"))
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 96);
  if (base === "") return `artifact${fallbackExt}`;
  return extname(base) === "" ? `${base}${fallbackExt}` : base;
}

function ensureAttachmentsExcludedFromGit(clonePath: string): void {
  const excludePath = join(clonePath, ".git", "info", "exclude");
  try {
    mkdirSync(join(clonePath, ".git", "info"), { recursive: true });
    const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    if (!existing.split(/\r?\n/).includes(".toolroll-attachments/")) {
      const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
      appendFileSync(excludePath, `${prefix}.toolroll-attachments/\n`, "utf8");
    }
  } catch {
    // Best-effort: clone may not have a standard .git/info directory in synthetic tests.
  }
}

export function saveDirectChatArtifact(
  store: Store,
  input: {
    stateRoot: string;
    threadId: string;
    turnId: string | null;
    kind: "output" | "attachment";
    filename: string;
    mimeType?: string | undefined;
    bytes: Buffer;
    sourcePath?: string | null | undefined;
    clonePath?: string | null | undefined;
    now?: Date | undefined;
  },
): { ok: true; artifact: DirectChatArtifactRow; cloneRelativePath: string | null } | { ok: false; status: number; error: string } {
  if (input.bytes.length === 0) {
    return { ok: false, status: 400, error: "Empty artifact or attachment." };
  }
  if (input.bytes.length > MAX_ARTIFACT_BYTES) {
    return { ok: false, status: 413, error: "Attachment exceeds the 10 MB limit." };
  }

  let resolvedMime: AllowedArtifactMime | null = detectSafeImageMime(input.bytes);
  if (resolvedMime === null && input.kind === "attachment") {
    const requested = (input.mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (requested in ALLOWED_ATTACHMENT_TEXT_MIMES) {
      if (input.bytes.includes(0)) {
        return { ok: false, status: 400, error: "Text attachments cannot contain binary NUL bytes." };
      }
      resolvedMime = requested as keyof typeof ALLOWED_ATTACHMENT_TEXT_MIMES;
    }
  }
  if (resolvedMime === null) {
    return { ok: false, status: 415, error: "Unsupported file type. Allowed: PNG, JPEG, WebP, GIF (and plain text, Markdown, JSON for attachments)." };
  }

  if (input.turnId !== null) {
    const countRow = store.handle
      .prepare("SELECT COUNT(*) AS n FROM direct_chat_artifact WHERE turn_id = ?")
      .get(input.turnId) as Record<string, unknown> | undefined;
    if (Number(countRow?.["n"] ?? 0) >= MAX_ARTIFACTS_PER_TURN) {
      return { ok: false, status: 429, error: "Artifact cap reached for this turn." };
    }
  }

  const ext = resolvedMime in ALLOWED_IMAGE_MIMES
    ? ALLOWED_IMAGE_MIMES[resolvedMime as SafeImageMime]
    : ALLOWED_ATTACHMENT_TEXT_MIMES[resolvedMime as keyof typeof ALLOWED_ATTACHMENT_TEXT_MIMES];
  const id = randomBytes(16).toString("hex");
  const safeName = sanitizeArtifactFilename(input.filename, ext);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const subdir = input.kind === "attachment" ? "attachments" : "artifacts";
  const storageRel = join(subdir, input.threadId, `${id}${ext}`);
  const storageAbs = join(input.stateRoot, "direct-chat", storageRel);

  mkdirSync(join(input.stateRoot, "direct-chat", subdir, input.threadId), { recursive: true, mode: 0o700 });
  writeFileSync(storageAbs, input.bytes, { mode: 0o600 });

  let cloneRelativePath: string | null = null;
  if (input.kind === "attachment" && input.clonePath && existsSync(input.clonePath)) {
    ensureAttachmentsExcludedFromGit(input.clonePath);
    const attDir = join(input.clonePath, ".toolroll-attachments");
    mkdirSync(attDir, { recursive: true, mode: 0o700 });
    const cloneFilename = `${id.slice(0, 8)}-${safeName}`;
    writeFileSync(join(attDir, cloneFilename), input.bytes, { mode: 0o600 });
    cloneRelativePath = `.toolroll-attachments/${cloneFilename}`;
  }

  const createdAt = (input.now ?? new Date()).toISOString();
  store.handle.prepare(`
    INSERT INTO direct_chat_artifact (
      id, thread_id, turn_id, kind, filename, mime_type, byte_size, sha256, storage_path, source_path, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.threadId,
    input.turnId,
    input.kind,
    safeName,
    resolvedMime,
    input.bytes.length,
    sha256,
    storageRel,
    input.sourcePath ?? cloneRelativePath,
    createdAt,
  );

  return {
    ok: true,
    cloneRelativePath,
    artifact: {
      id,
      threadId: input.threadId,
      turnId: input.turnId,
      kind: input.kind,
      filename: safeName,
      mimeType: resolvedMime,
      byteSize: input.bytes.length,
      sha256,
      storagePath: storageRel,
      sourcePath: input.sourcePath ?? cloneRelativePath,
      createdAt,
    },
  };
}

export function listArtifactsForThread(store: Store, threadId: string): DirectChatArtifactRow[] {
  const rows = store.handle
    .prepare("SELECT * FROM direct_chat_artifact WHERE thread_id = ? ORDER BY created_at ASC")
    .all(threadId) as Record<string, unknown>[];
  return rows.map(mapArtifactRow);
}

export function getDirectChatArtifact(
  store: Store,
  stateRoot: string,
  threadId: string,
  artifactId: string,
): { row: DirectChatArtifactRow; bytes: Buffer } | null {
  if (!/^[0-9a-f]{32}$/.test(threadId) || !/^[0-9a-f]{32}$/.test(artifactId)) return null;
  const raw = store.handle
    .prepare("SELECT * FROM direct_chat_artifact WHERE id = ? AND thread_id = ?")
    .get(artifactId, threadId) as Record<string, unknown> | undefined;
  if (!raw) return null;
  const row = mapArtifactRow(raw);
  const root = join(stateRoot, "direct-chat");
  const abs = join(root, row.storagePath);
  try {
    const realRoot = realpathSync(root);
    const realFile = realpathSync(abs);
    const rel = relative(realRoot, realFile);
    if (rel === ".." || rel.startsWith(`..${"/"}`) || isAbsolute(rel)) return null;
    return { row, bytes: readFileSync(realFile) };
  } catch {
    return null;
  }
}

function mapArtifactRow(raw: Record<string, unknown>): DirectChatArtifactRow {
  return {
    id: String(raw["id"]),
    threadId: String(raw["thread_id"]),
    turnId: typeof raw["turn_id"] === "string" ? raw["turn_id"] : null,
    kind: raw["kind"] === "attachment" ? "attachment" : "output",
    filename: String(raw["filename"]),
    mimeType: String(raw["mime_type"]),
    byteSize: Number(raw["byte_size"]),
    sha256: String(raw["sha256"]),
    storagePath: String(raw["storage_path"]),
    sourcePath: typeof raw["source_path"] === "string" ? raw["source_path"] : null,
    createdAt: String(raw["created_at"]),
  };
}

export type WorkspaceImageSnapshot = Map<string, { size: number; mtimeMs: number }>;

export function snapshotWorkspaceImages(clonePath: string, maxFiles = 20_000): WorkspaceImageSnapshot {
  const snap: WorkspaceImageSnapshot = new Map();
  if (!existsSync(clonePath)) return snap;
  let rootReal: string;
  try {
    rootReal = realpathSync(clonePath);
  } catch {
    return snap;
  }
  let visited = 0;
  const stack = [rootReal];
  while (stack.length > 0 && visited < maxFiles) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      visited += 1;
      if (visited > maxFiles) break;
      if (SKIPPED_SCAN_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile() && IMAGE_EXTENSIONS.has(extname(name).toLowerCase()) && st.size > 0 && st.size <= MAX_ARTIFACT_BYTES) {
        const rel = relative(rootReal, full).replace(/\\/g, "/");
        snap.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  }
  return snap;
}

export function captureNewWorkspaceArtifacts(
  store: Store,
  input: {
    stateRoot: string;
    threadId: string;
    turnId: string;
    clonePath: string;
    before: WorkspaceImageSnapshot;
    now?: Date;
  },
): DirectChatArtifactRow[] {
  const after = snapshotWorkspaceImages(input.clonePath);
  const captured: DirectChatArtifactRow[] = [];
  let rootReal: string;
  try {
    rootReal = realpathSync(input.clonePath);
  } catch {
    return captured;
  }

  for (const [relPath, meta] of after) {
    if (captured.length >= MAX_ARTIFACTS_PER_TURN) break;
    const prev = input.before.get(relPath);
    if (prev && prev.size === meta.size && prev.mtimeMs === meta.mtimeMs) continue;
    const full = join(rootReal, relPath);
    try {
      const st = lstatSync(full);
      if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_ARTIFACT_BYTES) continue;
      const bytes = readFileSync(full);
      if (detectSafeImageMime(bytes) === null) continue;
      const saved = saveDirectChatArtifact(store, {
        stateRoot: input.stateRoot,
        threadId: input.threadId,
        turnId: input.turnId,
        kind: "output",
        filename: basename(relPath),
        bytes,
        sourcePath: relPath,
        now: input.now,
      });
      if (saved.ok) captured.push(saved.artifact);
    } catch {
      continue;
    }
  }
  return captured;
}

/**
 * Extract base64 image blocks embedded directly in Claude / Gemini stream JSONL
 * (e.g. screenshots returned by Playwright / Mobbin / browser MCP tools).
 */
export function extractBase64ImagesFromLine(line: string, _provider: DirectChatProvider): Array<{ filename: string; bytes: Buffer }> {
  const trimmed = line.trim();
  if (trimmed === "" || !trimmed.includes("base64")) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const out: Array<{ filename: string; bytes: Buffer }> = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 8 || out.length >= MAX_ARTIFACTS_PER_TURN || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj["type"] === "image" && obj["source"] && typeof obj["source"] === "object") {
      const src = obj["source"] as Record<string, unknown>;
      if (src["type"] === "base64" && typeof src["data"] === "string" && src["data"].length > 16) {
        try {
          const bytes = Buffer.from(src["data"], "base64");
          const mime = detectSafeImageMime(bytes);
          if (mime !== null && bytes.length <= MAX_ARTIFACT_BYTES) {
            const ext = ALLOWED_IMAGE_MIMES[mime];
            out.push({ filename: `tool-capture-${out.length + 1}${ext}`, bytes });
          }
        } catch {
          // Ignore malformed base64.
        }
      }
      return;
    }
    for (const val of Object.values(obj)) walk(val, depth + 1);
  };
  walk(parsed, 0);
  return out;
}

export function imageContentHeaders(row: DirectChatArtifactRow): Record<string, string> {
  return {
    "content-type": row.mimeType,
    "content-disposition": `inline; filename="${row.filename.replace(/"/g, "")}"`,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    "content-security-policy": "sandbox; default-src 'none'; img-src 'self'",
  };
}
