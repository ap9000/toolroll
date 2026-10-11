/**
 * The verified artifact reader: every proof runs against the descriptor the
 * bytes actually come from, and nothing unverified ever leaves the function.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksLikeProtocolFile, parseNumstat, quarantineMailboxes, readMailbox, readVerifiedArtifact, redactSecretLines, scanForSecrets, scanPatchForSecrets, secretAlert, steerFolderName, writeEvidenceFile, sniffImageKind, validateScreenshotBytes, SCREENSHOT_BYTE_CAP } from "./evidence.js";
import { existsSync, mkdirSync } from "node:fs";
import type { Artifact } from "./store.js";

describe("reading evidence back, believing nothing", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "standing-orders-evidence-"));
    outside = mkdtempSync(join(tmpdir(), "standing-orders-outside-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const record = (key: string, content: Buffer, overrides: Partial<Artifact> = {}): Artifact => ({
    id: 1,
    run: 1,
    kind: "diff",
    key,
    bytesOriginal: content.length,
    bytesStored: content.length,
    truncated: false,
    sha256: createHash("sha256").update(content).digest("hex"),
    capture: "git diff (exit 0)",
    createdAt: "2026-08-12T00:00:00.000Z",
    redacted: false,
    ...overrides,
  });

  test("a file that is exactly its record comes back whole", () => {
    const content = Buffer.from("diff --git a/x b/x\n");
    const key = writeEvidenceFile(root, 1, "diff.patch", content);

    const read = readVerifiedArtifact(root, record(key, content));

    expect(read).toMatchObject({ ok: true });
    if (read.ok) expect(read.content.equals(content)).toBe(true);
  });

  test("stored-byte integrity is independent of shortened or failed capture status", () => {
    const content = Buffer.from("exit 0\n[output shortened]\n");
    const key = writeEvidenceFile(root, 1, "check-log.txt", content);
    const log = record(key, content, { kind: "check-log", bytesOriginal: 100000, truncated: true, captureStatus: "ok" });
    expect(readVerifiedArtifact(root, log)).toEqual({ ok: true, content });
    expect(readVerifiedArtifact(root, { ...log, captureStatus: "failed" })).toEqual({ ok: true, content });
    writeFileSync(join(root, key), Buffer.from(content.toString().replace("exit 0", "exit 1")));
    expect(readVerifiedArtifact(root, log)).toMatchObject({ ok: false, problem: expect.stringMatching(/hash/) });
  });

  test("a traversal key never reaches the filesystem", () => {
    // The interesting failure is a *record* gone wrong — a row whose key
    // points outside the root must die on shape alone.
    writeFileSync(join(outside, "loot"), "secret");
    for (const key of ["../loot", "1/../../loot", "/etc/hosts", "1//x", "1/.", "a\\b"]) {
      const read = readVerifiedArtifact(root, record(key, Buffer.from("secret")));
      expect(read).toMatchObject({ ok: false, problem: expect.stringContaining("not a normalized") });
    }
  });

  test("a symlink out of the root is refused even though the key looks clean", () => {
    writeFileSync(join(outside, "loot"), "secret");
    const content = Buffer.from("secret");
    writeEvidenceFile(root, 1, "anchor", Buffer.from("x")); // creates root/1/
    symlinkSync(join(outside, "loot"), join(root, "1", "link"));

    const read = readVerifiedArtifact(root, record("1/link", content));

    expect(read).toMatchObject({ ok: false, problem: expect.stringContaining("outside the evidence root") });
  });

  test("tampered bytes are refused — the hash check is not decorative", () => {
    const content = Buffer.from("original");
    const key = writeEvidenceFile(root, 1, "diff.patch", content);
    writeFileSync(join(root, key), "originaX"); // same length, different bytes

    const read = readVerifiedArtifact(root, record(key, content));

    expect(read).toMatchObject({ ok: false, problem: expect.stringContaining("no longer hashes") });
  });

  test("a grown file is refused before hashing — the read is bounded by the record", () => {
    const content = Buffer.from("original");
    const key = writeEvidenceFile(root, 1, "diff.patch", content);
    appendFileSync(join(root, key), ".".repeat(1024));

    const read = readVerifiedArtifact(root, record(key, content));

    expect(read).toMatchObject({ ok: false, problem: expect.stringContaining("size no longer matches") });
  });

  test("a record claiming more than its kind may store is refused unread", () => {
    const content = Buffer.from("x");
    const key = writeEvidenceFile(root, 1, "status.txt", content);

    const read = readVerifiedArtifact(
      root,
      record(key, content, { kind: "status", bytesStored: 10 * 1024 * 1024 }),
    );

    expect(read).toMatchObject({ ok: false, problem: expect.stringContaining("more bytes than its kind") });
  });

  test("a missing file is a calm refusal, not a throw", () => {
    const read = readVerifiedArtifact(root, record("1/never-written", Buffer.from("x")));
    expect(read).toMatchObject({ ok: false, problem: expect.stringContaining("gone or unresolvable") });
  });
});

describe("reading protocol mailboxes", () => {
  test("refuses a FIFO without waiting for a writer", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "standing-orders-mailbox-"));
    try {
      const fifo = join(root, "reply.json");
      try {
        execFileSync("mkfifo", [fifo]);
      } catch {
        return; // This host cannot create the POSIX fixture.
      }

      const started = Date.now();
      expect(readMailbox(fifo)).toMatchObject({
        ok: false,
        missing: false,
        problem: "the mailbox is not a regular file",
      });
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the steering folder is protocol, never work (v120)", () => {
  test("the folder, git status's untracked-folder line and every file in it read as protocol; look-alikes do not", () => {
    const folder = steerFolderName();
    expect(folder).toMatch(/^STANDING-ORDERS-STEER-[0-9a-f]{16}$/);
    expect(looksLikeProtocolFile(folder)).toBe(true);
    expect(looksLikeProtocolFile(`${folder}/`)).toBe(true);
    // A repository that shows every untracked file lists them one by one.
    expect(looksLikeProtocolFile(`${folder}/handled/001.json`)).toBe(true);
    expect(looksLikeProtocolFile("STANDING-ORDERS-STEER-notes/")).toBe(false);
    expect(looksLikeProtocolFile(`src/${folder}/001.json`)).toBe(false);
  });

  test("an earlier attempt's folder is swept whole before a new attempt starts", () => {
    const worktree = mkdtempSync(join(tmpdir(), "so-steer-sweep-"));
    try {
      const folder = steerFolderName();
      mkdirSync(join(worktree, folder, "handled"), { recursive: true });
      writeFileSync(join(worktree, folder, "handled", "001.json"), "{}");
      expect(quarantineMailboxes(worktree, null, null)).toEqual([folder]);
      expect(existsSync(join(worktree, folder))).toBe(false);
    } finally { rmSync(worktree, { recursive: true, force: true }); }
  });
});

describe("parseNumstat — filenames come NUL-delimited from git, never from patch headers", () => {
  const NUL = "\u0000";

  test("plain, binary, and rename entries", () => {
    const raw =
      ["3\t1\tsrc/a.ts", "-\t-\tassets/logo.png", "2\t0\t"].join(NUL) +
      NUL + "old/name.ts" + NUL + "new/name.ts" + NUL;
    const stat = parseNumstat(raw, "base1234", "head5678");
    expect(stat.base).toBe("base1234");
    expect(stat.head).toBe("head5678");
    expect(stat.fileCount).toBe(3);
    expect(stat.additions).toBe(5);
    expect(stat.deletions).toBe(1);
    expect(stat.binaryCount).toBe(1);
    expect(stat.files[0]).toMatchObject({ path: "src/a.ts", additions: 3, deletions: 1 });
    // Binary counts are null, never coerced to zero — unmeasured is unmeasured.
    expect(stat.files[1]).toMatchObject({ path: "assets/logo.png", additions: null, deletions: null });
    expect(stat.files[2]).toMatchObject({ path: "new/name.ts", renamedFrom: "old/name.ts" });
  });

  test("empty output is the explicit zero, not an error", () => {
    const stat = parseNumstat("", "base1234", "base1234");
    expect(stat.fileCount).toBe(0);
    expect(stat.additions).toBe(0);
    expect(stat.filesTruncated).toBe(false);
  });

  test("a filename containing a tab survives — the path is everything after the second tab", () => {
    const stat = parseNumstat(`1\t1\tweird\tname.txt${NUL}`, "b", "h");
    expect(stat.files[0]?.path).toBe("weird\tname.txt");
  });

  test("the file list is bounded; the counts stay complete", () => {
    const raw = Array.from({ length: 500 }, (_, i) => `1\t0\tfile-${i}.ts`).join(NUL) + NUL;
    const stat = parseNumstat(raw, "b", "h");
    expect(stat.fileCount).toBe(500);
    expect(stat.additions).toBe(500);
    expect(stat.files.length).toBe(400);
    expect(stat.filesTruncated).toBe(true);
  });
});

describe("the secret scan (audit IV-7) — high confidence only", () => {
  test("known credential shapes hit; ordinary source lines do not", () => {
    const patch = [
      "diff --git a/.env b/.env",
      "+AWS_KEY=AKIAIOSFODNN7EXAMPLE",
      "+github = ghp_" + "a".repeat(36),
      "+-----BEGIN RSA PRIVATE KEY-----",
      '+const password = process.env.PASSWORD; // fine',
      "+// slack docs mention xoxb-tokens generically",
    ].join("\n");
    const hits = scanForSecrets(patch);
    expect(hits.map(one => one.name).sort()).toEqual(["aws-access-key", "github-token", "private-key"]);

    const redacted = redactSecretLines(patch, hits);
    expect(redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redacted).not.toContain("ghp_");
    expect(redacted).toContain("[redacted: aws-access-key detected on this line]");
    // The innocent lines survive untouched.
    expect(redacted).toContain("process.env.PASSWORD");
  });

  test("clean text produces no hits and no changes", () => {
    const clean = "diff --git a/x b/x\n+export const guarded = true;\n";
    expect(scanForSecrets(clean)).toEqual([]);
  });
});

describe("the diff secret scan: only real secrets on added lines", () => {
  // Key-shaped values are assembled here, never written out whole.
  const awsDocs = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");
  const awsFake = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
  const awsReal = ["AKIA", "Q7ZC4M2XWB9KT3LP"].join("");
  const anthropicFiller = ["sk-ant-api03-", "A".repeat(58)].join("");
  const openaiReal = ["sk-", "proj-", "p3Xq9LmZ2vR7tY4wK8sN1bH6cF0jD5gU"].join("");
  const url = (user: string, pass: string, host: string) => ["https://", user, ":", pass, "@", host].join("");
  const patchOf = (file: string, body: string[], start = 10) => [
    `diff --git a/${file} b/${file}`,
    `index 1111111..2222222 100644`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${start},${body.length} +${start},${body.length} @@`,
    ...body,
  ].join("\n");

  test("the 2026-09-30 false alarms produce no hit", () => {
    // Most sat on removed lines of a stale-base diff; the rest were
    // documented examples, reserved hosts and repeated-character fixtures.
    const patch = [
      patchOf("src/review-context.test.ts", [
        ` const unchanged = "${awsFake}";`,
        `-    guardSource: \`// token: ${awsFake}\\n\`,`,
        `-      stdout: JSON.stringify({ result: "${anthropicFiller}" }),`,
        `-  put("src/secret.ts", 'const key = "${["AKIA", "1234567890ABCDEF"].join("")}";');`,
        `-  const db = "${url("app", "s3cret-pw", "db.internal/app")}";`,
      ]),
      patchOf("src/scout.test.ts", [
        `+      "+AWS_KEY=${awsDocs}",`,
        `+    stdout: JSON.stringify({ result: "${anthropicFiller}" }),`,
        `+  it.each(["${url("alex", "secret", "console.example.test")}"])`,
        `+  test.each(["${url("alice", "password", "example.test")}", "${url("u", "hunter22", "[::1]:8080")}"])`,
      ]),
    ].join("\n");
    expect(scanForSecrets(patch).length).toBeGreaterThanOrEqual(8);
    expect(scanPatchForSecrets(patch)).toEqual([]);
  });

  test.each([
    ["example.com", "api.example.org", "svc.example", "db.test", "x.invalid", "localhost", "127.0.0.1:5432"],
  ])("a password on reserved host %s is a placeholder", (...hosts) => {
    for (const host of hosts) expect(scanPatchForSecrets(patchOf("a.ts", [`+const u = "${url("u", "Zq8vN3pL", host)}";`]))).toEqual([]);
  });

  test("a realistic added key in a source file is flagged with its file and line", () => {
    const patch = [
      patchOf("src/removed.ts", [`-const old = "${awsReal}";`]),
      patchOf("src/pay.ts", [" const a = 1;", `-const key = process.env.KEY;`, `+const key = "${awsReal}";`, `+const ai = "${openaiReal}";`, `+const db = "${url("app", "Zq8vN3pL", "db.prod.internal")}";`], 40),
    ].join("\n");
    const hits = scanPatchForSecrets(patch);
    expect(hits).toEqual([
      { name: "aws-access-key", line: 14, file: "src/pay.ts", fileLine: 41 },
      { name: "openai-key", line: 15, file: "src/pay.ts", fileLine: 42 },
      { name: "password-in-url", line: 16, file: "src/pay.ts", fileLine: 43 },
    ]);
    const redacted = redactSecretLines(patch, hits);
    expect(redacted).not.toContain(`+const key = "${awsReal}";`);
    expect(redacted).not.toContain(openaiReal);
    expect(redacted).toContain("[redacted: aws-access-key detected on this line]");
    // The removed line is not a new commit of anything: left as it was.
    expect(redacted).toContain(`-const old = "${awsReal}";`);
  });

  test("a placeholder on a line does not hide a real key beside it", () => {
    expect(scanPatchForSecrets(patchOf("a.ts", [`+const both = ["${awsDocs}", "${awsReal}"];`]))).toMatchObject([{ name: "aws-access-key", file: "a.ts", fileLine: 10 }]);
  });

  test("the alert names file and line and says what to do, without the value", () => {
    const hits = scanPatchForSecrets(patchOf("src/pay.ts", [" a", `+const key = "${awsReal}";`], 7));
    const alert = secretAlert(hits, 42);
    expect(alert.subject).toBe("Run #42 adds what looks like a key");
    expect(alert.body).toContain("src/pay.ts:8 (aws-access-key)");
    expect(alert.body).toContain("If this is a real key, rotate it and rewrite the branch.");
    expect(alert.body).not.toContain(awsReal);
  });
});

describe("screenshot evidence: signature, not extension (Priority 2)", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest of a png")]);
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("rest of a jpeg")]);

  test("sniffs PNG and JPEG by their magic bytes", () => {
    expect(sniffImageKind(PNG)).toBe("png");
    expect(sniffImageKind(JPEG)).toBe("jpeg");
  });

  test("a claimed .png that is not one is refused — the extension is not the check", () => {
    expect(sniffImageKind(Buffer.from("not an image at all"))).toBeNull();
  });

  test("validateScreenshotBytes accepts a sound PNG or JPEG", () => {
    expect(validateScreenshotBytes(PNG)).toEqual({ ok: true, kind: "png" });
    expect(validateScreenshotBytes(JPEG)).toEqual({ ok: true, kind: "jpeg" });
  });

  test("refuses an empty file", () => {
    const result = validateScreenshotBytes(Buffer.alloc(0));
    expect(result).toMatchObject({ ok: false });
  });

  test("refuses a file over the byte cap even with a good signature", () => {
    const oversized = Buffer.concat([PNG, Buffer.alloc(SCREENSHOT_BYTE_CAP)]);
    const result = validateScreenshotBytes(oversized);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.problem).toContain("bytes");
  });

  test("refuses bytes that are neither PNG nor JPEG", () => {
    const result = validateScreenshotBytes(Buffer.from("<svg></svg>"));
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.problem).toMatch(/PNG or JPEG/);
  });
});

describe("boundStreamHeadTail", () => {
  test("keeps the ending, where a test runner prints its summary", async () => {
    const { boundStreamHeadTail, SHORTENED_MARKER } = await import("./evidence.js");
    const dots = "·".repeat(20_000);
    const summary = "\n Test Files  1 failed | 190 passed (191)\n      Tests  2 failed | 3520 passed (3522)\n";
    const bounded = boundStreamHeadTail(`RUN v4\n${dots}${summary}`, 4096);
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(4096);
    expect(bounded.startsWith("RUN v4\n")).toBe(true);
    expect(bounded).toContain(SHORTENED_MARKER);
    expect(bounded.endsWith(summary)).toBe(true);
    expect(boundStreamHeadTail("short", 4096)).toBe("short");
  });
});
