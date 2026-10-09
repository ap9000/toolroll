import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitBlobSha1, looksBinary, diffLines, renderUnified } from "./peek.js";

describe("the native reader's pure core (attended finding 7)", () => {
  test("gitBlobSha1 agrees with git hash-object, byte for byte", () => {
    const dir = mkdtempSync(join(tmpdir(), "peek-sha-"));
    try {
      const cases = [Buffer.from(""), Buffer.from("hello\n"), Buffer.from([0, 1, 2, 255]), Buffer.from("no trailing newline")];
      for (const bytes of cases) {
        const file = join(dir, "blob");
        writeFileSync(file, bytes);
        const theirs = execFileSync("git", ["hash-object", file], { encoding: "utf8" }).trim();
        expect(gitBlobSha1(bytes)).toBe(theirs);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("binary detection: a NUL in the first 8 KiB, nothing else", () => {
    expect(looksBinary(Buffer.from("plain text\n"))).toBe(false);
    expect(looksBinary(Buffer.from([104, 105, 0, 33]))).toBe(true);
    // NUL beyond the sniff window does not reclassify the file.
    const tail = Buffer.concat([Buffer.alloc(8192, 97), Buffer.from([0])]);
    expect(looksBinary(tail)).toBe(false);
  });

  // The property that makes the differ trustworthy: replaying the hunks
  // onto the old text reconstructs the new text exactly.
  const replay = (aText: string, hunks: ReturnType<typeof diffLines>): string => {
    if (hunks === null) throw new Error("no hunks");
    const a = aText.split("\n");
    const out: string[] = [];
    let cursor = 0; // 0-based index into a
    for (const hunk of hunks) {
      const start = hunk.aStart - 1;
      while (cursor < start) out.push(a[cursor++] as string);
      for (const line of hunk.lines) {
        const tag = line[0];
        const body = line.slice(1);
        if (tag === " ") {
          expect(a[cursor]).toBe(body); // context must match the old text
          out.push(body);
          cursor++;
        } else if (tag === "-") {
          expect(a[cursor]).toBe(body);
          cursor++;
        } else {
          out.push(body);
        }
      }
    }
    while (cursor < a.length) out.push(a[cursor++] as string);
    return out.join("\n");
  };

  test("diffLines round-trips: edits, insertions, deletions, and no-ops reconstruct exactly", () => {
    const base = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", ""].join("\n");
    const edits = [
      base, // identical
      base.replace("charlie", "charlie-two"), // one edit
      ["alpha", "bravo", "delta", "echo", "foxtrot", "golf", "hotel", ""].join("\n"), // deletion
      ["alpha", "inserted", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", ""].join("\n"), // insertion
      ["zero", "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "changed", ""].join("\n"), // both ends
      "", // everything deleted
    ];
    for (const next of edits) {
      const hunks = diffLines(base, next);
      if (next === base) {
        expect(hunks).toEqual([]);
        continue;
      }
      expect(replay(base, hunks)).toBe(next);
    }
    // And the reverse direction.
    for (const next of edits) {
      if (next === base) continue;
      expect(replay(next, diffLines(next, base))).toBe(base);
    }
  });

  test("an edit distance past the bound returns null — a rewrite is named, not rendered", () => {
    const a = Array.from({ length: 300 }, (_, index) => `left-${index}`).join("\n");
    const b = Array.from({ length: 300 }, (_, index) => `right-${index}`).join("\n");
    expect(diffLines(a, b, 100)).toBeNull();
    expect(diffLines(a, b)).not.toBeNull(); // the default bound admits it
  });

  test("renderUnified caps in whole hunks and says truncated", () => {
    const base = Array.from({ length: 50 }, (_, index) => `line-${index}`).join("\n");
    const changed = base.replace("line-5", "five").replace("line-45", "forty-five");
    const hunks = diffLines(base, changed);
    if (hunks === null) throw new Error("hunks");
    expect(hunks.length).toBe(2);
    const full = renderUnified("src/x.ts", hunks, 64 * 1024);
    expect(full.truncated).toBe(false);
    expect(full.text).toContain("--- a/src/x.ts");
    expect(full.text).toContain("-line-5");
    expect(full.text).toContain("+forty-five");
    // A cap that fits the header and first hunk only: the second is dropped
    // whole — never a half-line (finding 9).
    const tight = renderUnified("src/x.ts", hunks, 150);
    expect(tight.truncated).toBe(true);
    expect(tight.text).toContain("-line-5");
    expect(tight.text).not.toContain("forty-five");
    expect(tight.text.endsWith("\n")).toBe(true);
  });

  test("new files aggregate without suppression: the numbers always add up", async () => {
    const { aggregateNewNames } = await import("./peek.js");
    const paths = [
      ...Array.from({ length: 25 }, (_, index) => `node_modules/pkg-${index}/index.js`),
      "src/new-feature.ts",
      "README-draft.md",
      ...Array.from({ length: 3 }, (_, index) => `docs/page-${index}.md`),
    ];
    const view = aggregateNewNames(paths, 10, 200);
    expect(view.total).toBe(30);
    const grouped = view.rows.find(row => row.label === "node_modules/");
    expect(grouped?.count).toBe(25); // collapsed, exact, never hidden
    expect(view.rows.some(row => row.label === "src/new-feature.ts")).toBe(true);
    expect(view.rows.some(row => row.label === "docs/page-0.md")).toBe(true); // 3 ≤ groupAt stays listed
    expect(view.renderedFiles).toBe(30); // everything accounted for
    // Saturation: a tiny row cap still states exact totals.
    const tight = aggregateNewNames(paths, 10, 2);
    expect(tight.rows.length).toBe(2);
    expect(tight.total).toBe(30);
    expect(tight.renderedFiles).toBeLessThan(30);
    // Round-2 finding 31: many small GROUPS cannot amplify past the cap.
    const hostile = Array.from({ length: 500 }, (_, group) =>
      Array.from({ length: 11 }, (_, index) => `g${group}/f${index}`),
    ).flat();
    const bounded = aggregateNewNames(hostile, 10, 200);
    expect(bounded.rows.length).toBe(200);
    expect(bounded.total).toBe(5500);
    expect(bounded.rows.every(row => row.collapsed)).toBe(true);
  });

  test("the base-tree parser refuses anything mis-shaped, whole", async () => {
    const { parseBaseTree } = await import("./peek.js");
    const good = JSON.stringify([
      ["src/main.ts", "100644", "a".repeat(40), 120],
      ["bin/run", "100755", "b".repeat(40), 64],
      ["vendored", "160000", "c".repeat(40), 0],
    ]);
    expect(parseBaseTree(good)).toHaveLength(3);
    const bad = [
      [["/etc/passwd", "100644", "a".repeat(40), 1]], // absolute
      [["a/../b", "100644", "a".repeat(40), 1]], // dot-dot
      [["a\u0000b", "100644", "a".repeat(40), 1]], // control byte
      [["a\ufffdb", "100644", "a".repeat(40), 1]], // replacement char — lossy decode refused (finding 43)
      [["x", "999999", "a".repeat(40), 1]], // unknown mode
      [["x", "100644", "nothex", 1]], // bad sha
      [["x", "100644", "a".repeat(40), -1]], // negative size
      [["x", "100644", "a".repeat(40), 1], ["x", "100644", "b".repeat(40), 2]], // duplicate path
    ];
    for (const case_ of bad) {
      expect(parseBaseTree(JSON.stringify(case_))).toBeNull();
    }
    expect(parseBaseTree("not json")).toBeNull();
    expect(parseBaseTree(JSON.stringify([["x", "100644", "a".repeat(40), 1]]), 0)).toBeNull(); // over cap
  });

  test("the snapshot envelope binds repo, run, and base — and round-trips exactly", async () => {
    const { encodeBaseTreeSnapshot, parseBaseTreeSnapshot } = await import("./peek.js");
    const snapshot = {
      repo: "/repos/thing",
      run: 42,
      base: "d".repeat(40),
      entries: [{ path: "src/x.ts", mode: "100644", sha: "a".repeat(40), size: 9 }],
    };
    expect(parseBaseTreeSnapshot(encodeBaseTreeSnapshot(snapshot))).toEqual(snapshot);
    // Envelope violations refuse whole.
    const good = JSON.parse(encodeBaseTreeSnapshot(snapshot));
    for (const broken of [
      { ...good, v: "base-tree/2" },
      { ...good, repo: "" },
      { ...good, run: 0 },
      { ...good, run: 4.5 },
      { ...good, base: "not-a-sha" },
      { ...good, entries: [["/abs", "100644", "a".repeat(40), 1]] },
      { ...good, entries: "nope" },
    ]) {
      expect(parseBaseTreeSnapshot(JSON.stringify(broken))).toBeNull();
    }
  });
});

describe("observeWorktree — the descriptor-confined walk", () => {
  const T = async () => {
    const { observeWorktree, gitBlobSha1 } = await import("./peek.js");
    const { mkdirSync, writeFileSync, symlinkSync, chmodSync } = await import("node:fs");
    return { observeWorktree, gitBlobSha1, mkdirSync, writeFileSync, symlinkSync, chmodSync };
  };
  const entry = (path: string, bytes: Buffer, mode = "100644") => ({
    path,
    mode,
    sha: "",
    size: bytes.length,
  });

  test("changed, new, deleted, exec-bit, and same-size edits all surface; .git and the lease marker never do", async () => {
    const { observeWorktree, gitBlobSha1, mkdirSync, writeFileSync, chmodSync } = await T();
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "peek-walk-"));
    try {
      mkdirSync(join(root, "src"));
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, ".git", "config"), "[core]\n");
      writeFileSync(join(root, ".standing-orders-lease"), "123 runner\n");
      const keep = Buffer.from("unchanged\n");
      const before = Buffer.from("original text\n");
      const after = Buffer.from("REWRITTEN tex\n"); // same byte length
      writeFileSync(join(root, "src", "keep.ts"), keep);
      writeFileSync(join(root, "src", "edited.ts"), after);
      writeFileSync(join(root, "src", "grew.ts"), Buffer.from("now much longer than before\n"));
      writeFileSync(join(root, "run.sh"), Buffer.from("#!/bin/sh\n"));
      chmodSync(join(root, "run.sh"), 0o755);
      writeFileSync(join(root, "brand-new.md"), Buffer.from("hello\n"));

      const base = [
        { ...entry("src/keep.ts", keep), sha: gitBlobSha1(keep) },
        { ...entry("src/edited.ts", before), sha: gitBlobSha1(before) },
        { ...entry("src/grew.ts", Buffer.from("short\n")), sha: gitBlobSha1(Buffer.from("short\n")) },
        { ...entry("run.sh", Buffer.from("#!/bin/sh\n")), sha: gitBlobSha1(Buffer.from("#!/bin/sh\n")) },
        { ...entry("src/removed.ts", Buffer.from("bye\n")), sha: gitBlobSha1(Buffer.from("bye\n")) },
      ];
      const seen = await observeWorktree(root, base);
      if (!seen.ok) throw new Error(seen.reason);
      const byPath = new Map(seen.rows.map(row => [row.path, row]));
      expect(byPath.get("src/edited.ts")?.detail).toBe("edited (same size)");
      expect(byPath.get("src/grew.ts")?.detail).toContain("bytes");
      expect(byPath.get("run.sh")?.detail).toBe("became executable");
      expect(byPath.get("src/removed.ts")?.kind).toBe("deleted");
      expect(byPath.has("src/keep.ts")).toBe(false); // verified unchanged by hash
      expect(seen.newPaths).toEqual(["brand-new.md"]);
      // The machine's own noise never renders as change.
      expect(seen.newPaths.some(path => path.startsWith(".git"))).toBe(false);
      expect(seen.partial).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("symlinks are typed, never followed — a link at a tracked path is a change, not a read", async () => {
    const { observeWorktree, gitBlobSha1, symlinkSync, writeFileSync } = await T();
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "peek-link-"));
    const outside = mkdtempSync(join(tmpdir(), "peek-outside-"));
    try {
      // A secret OUTSIDE the tree, pointed at from inside: the walk must
      // report the link and must never open what it points to.
      writeFileSync(join(outside, "secret.txt"), "hunter2\n");
      symlinkSync(join(outside, "secret.txt"), join(root, "config.ts"));
      symlinkSync(join(outside, "secret.txt"), join(root, "fresh-link"));
      const tracked = Buffer.from("export const x = 1\n");
      const base = [{ path: "config.ts", mode: "100644", sha: gitBlobSha1(tracked), size: tracked.length }];
      const seen = await observeWorktree(root, base);
      if (!seen.ok) throw new Error(seen.reason);
      expect(seen.rows.find(row => row.path === "config.ts")?.detail).toBe("became a link");
      expect(seen.newPaths).toContain("fresh-link");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a tracked symlink whose TARGET moved is a change; a FIFO at a tracked path is typed, never read", async () => {
    const { observeWorktree, gitBlobSha1, symlinkSync } = await T();
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "peek-link2-"));
    try {
      // Base tracked a symlink (mode 120000) whose blob content IS its
      // old target string. On disk it now points somewhere else.
      symlinkSync("lib/new-target.ts", join(root, "alias"));
      const oldTarget = Buffer.from("lib/old-target.ts");
      symlinkSync("same-place", join(root, "steady"));
      const steady = Buffer.from("same-place");
      execFileSync("mkfifo", [join(root, "pipe.ts")]);
      const tracked = Buffer.from("real bytes\n");
      const base = [
        { path: "alias", mode: "120000", sha: gitBlobSha1(oldTarget), size: oldTarget.length },
        { path: "steady", mode: "120000", sha: gitBlobSha1(steady), size: steady.length },
        { path: "pipe.ts", mode: "100644", sha: gitBlobSha1(tracked), size: tracked.length },
      ];
      const seen = await observeWorktree(root, base);
      if (!seen.ok) throw new Error(seen.reason);
      const byPath = new Map(seen.rows.map(row => [row.path, row]));
      expect(byPath.get("alias")?.detail).toBe("link points elsewhere");
      expect(byPath.has("steady")).toBe(false); // same target, verified by sha
      // The FIFO: the dirent types it before any open — reported as a
      // change, never opened; the walk returning at all is the proof
      // nothing blocked on it. (The O_NONBLOCK + fstat-isFile guard covers
      // the narrower race where a file is swapped AFTER enumeration.)
      expect(byPath.get("pipe.ts")?.detail).toBe("became something else");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("same-size files past the caps land as UNCHECKED rows, never as silent unchanged", async () => {
    const { observeWorktree, gitBlobSha1 } = await T();
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "peek-caps2-"));
    try {
      const big = Buffer.alloc(2048, 120);
      writeFileSync(join(root, "big.bin"), big);
      const small = Buffer.from("small\n");
      writeFileSync(join(root, "small.ts"), small);
      const base = [
        { path: "big.bin", mode: "100644", sha: gitBlobSha1(big), size: big.length },
        { path: "small.ts", mode: "100644", sha: gitBlobSha1(small), size: small.length },
      ];
      // maxFileBytes below big's size: same size, but too large to verify.
      const capped = await observeWorktree(root, base, { maxEntries: 100, maxRows: 400, maxFileBytes: 1024, maxHashedBytes: 1024 * 1024, deadlineMs: 3000 });
      if (!capped.ok) throw new Error(capped.reason);
      expect(capped.rows.find(row => row.path === "big.bin")).toMatchObject({ kind: "unchecked" });
      expect(capped.partial).toContain("large file");
      // Hashing budget of zero: even the small file is honestly unchecked.
      const broke = await observeWorktree(root, base, { maxEntries: 100, maxRows: 400, maxFileBytes: 1024, maxHashedBytes: 0, deadlineMs: 3000 });
      if (!broke.ok) throw new Error(broke.reason);
      expect(broke.rows.find(row => row.path === "small.ts")?.detail).toContain("budget");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the entry cap refuses whole; a zero deadline yields a partial look that never claims deletions", async () => {
    const { observeWorktree } = await T();
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "peek-caps-"));
    try {
      for (let index = 0; index < 12; index++) writeFileSync(join(root, `file-${index}.txt`), "x");
      const capped = await observeWorktree(root, [], { maxEntries: 5, maxRows: 400, maxFileBytes: 1024, maxHashedBytes: 1024, deadlineMs: 3000 });
      expect(capped).toMatchObject({ ok: false, reason: "this tree is too large to watch live" });
      const timed = await observeWorktree(
        root,
        [{ path: "never-checked.ts", mode: "100644", sha: "a".repeat(40), size: 4 }],
        { maxEntries: 20_000, maxRows: 400, maxFileBytes: 1024, maxHashedBytes: 1024 * 1024, deadlineMs: 0 },
      );
      if (!timed.ok) throw new Error(timed.reason);
      expect(timed.partial).toContain("ran out of time");
      // A file the walk never reached must NOT be called deleted.
      expect(timed.rows.some(row => row.kind === "deleted")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
