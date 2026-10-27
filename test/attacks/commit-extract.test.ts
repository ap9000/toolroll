/**
 * Attack: change what the release extracts and runs, through the repository rather than the worktree — a filter
 * driver in the project's local Git config, export-subst or a filter named in `$GIT_DIR/info/attributes`, a symlink in
 * the commit that points out of the extracted tree — or through a hostile package name the deployment script would use
 * as a path. Guard: commit-extract.ts reads blobs byte for byte (ls-tree + cat-file, no conversion), refuses config
 * that names a command, and refuses symlinks, submodules and unnormalized paths; deploy-browser.mjs under the release
 * reads its package name from the extracted commit and accepts only a plain name.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { extractCommit, normalizedTreePath, verifiedRange } from "../../src/commit-extract.js";
import { git, marker, useScratch } from "./harness.js";

const ROOT = resolve(import.meta.dirname, "../..");

describe("attack: the repository changes what the release extracts", () => {
  const scratch = useScratch("commit-extract");
  /** A project whose commit holds `files`; returns its .git and head. */
  const project = (dir: string, files: Record<string, string>) => {
    const repo = join(dir, "project");
    for (const [path, text] of Object.entries(files)) { mkdirSync(join(repo, path, ".."), { recursive: true }); writeFileSync(join(repo, path), text); }
    git(repo, "init", "-q");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "approved");
    return { repo, gitDir: join(repo, ".git"), head: git(repo, "rev-parse", "HEAD") };
  };
  const into = (dir: string) => { const out = join(dir, "out"); mkdirSync(out); return out; };

  test("a filter driver in the project's local config refuses the extraction; nothing runs", () => {
    const dir = scratch(), ran = join(dir, "filter-ran");
    const p = project(dir, { "scripts/deploy-browser.mjs": "console.log('approved');\n", ".gitattributes": "*.mjs filter=evil\n" });
    git(p.repo, "config", "filter.evil.smudge", `sh -c 'touch ${ran}; cat'`);
    const out = into(dir);
    expect(extractCommit(p.gitDir, p.head, out)).toMatchObject({ ok: false, message: expect.stringContaining("filter.evil.smudge") });
    expect(existsSync(ran)).toBe(false);
    expect(readdirSync(out)).toEqual([]);
  });

  test("export-subst or a filter named in info/attributes changes no byte", () => {
    const dir = scratch();
    const text = "// built from $Format:%H$\nconsole.log('approved');\n";
    const p = project(dir, { "scripts/deploy-browser.mjs": text });
    writeFileSync(join(p.gitDir, "info", "attributes"), "* export-subst\n*.mjs filter=other\n");
    const out = into(dir);
    expect(extractCommit(p.gitDir, p.head, out)).toEqual({ ok: true, files: 1 });
    expect(readFileSync(join(out, "scripts", "deploy-browser.mjs"), "utf8")).toBe(text);
  });

  test("a symlink in the commit that points out of the tree refuses the extraction", () => {
    const dir = scratch(), secret = marker("symlink");
    writeFileSync(join(dir, "outside.mjs"), `console.log(${JSON.stringify(secret)});\n`);
    const repo = join(dir, "project");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    symlinkSync(join(dir, "outside.mjs"), join(repo, "scripts", "deploy-browser.mjs"));
    git(repo, "init", "-q");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "link");
    const out = into(dir);
    expect(extractCommit(join(repo, ".git"), git(repo, "rev-parse", "HEAD"), out)).toMatchObject({ ok: false, message: expect.stringContaining("symlink") });
    expect(readdirSync(out)).toEqual([]);
  });

  test("a loose object rewritten under the same id (a valid zlib wrapper, other bytes) refuses the extraction", () => {
    const dir = scratch();
    const p = project(dir, { "scripts/deploy-browser.mjs": "console.log('approved');\n" });
    const blob = git(p.repo, "rev-parse", "HEAD:scripts/deploy-browser.mjs");
    const loose = join(p.gitDir, "objects", blob.slice(0, 2), blob.slice(2));
    expect(inflateSync(readFileSync(loose)).toString("utf8")).toBe("blob 25\0console.log('approved');\n");
    const evil = Buffer.from("console.log('evil!!!!');\n");
    chmodSync(loose, 0o644);
    writeFileSync(loose, deflateSync(Buffer.concat([Buffer.from(`blob ${evil.length}\0`), evil])));
    const out = into(dir);
    expect(extractCommit(p.gitDir, p.head, out)).toMatchObject({ ok: false, message: expect.stringContaining("doesn't hash to its id") });
    expect(readdirSync(out)).toEqual([]);
  });

  test("a rewritten tree object refuses the extraction too", () => {
    const dir = scratch();
    const p = project(dir, { "scripts/deploy-browser.mjs": "console.log('approved');\n" });
    const tree = git(p.repo, "rev-parse", "HEAD^{tree}");
    const loose = join(p.gitDir, "objects", tree.slice(0, 2), tree.slice(2));
    const original = inflateSync(readFileSync(loose));
    chmodSync(loose, 0o644);
    writeFileSync(loose, deflateSync(Buffer.from(original.toString("latin1").replace("scripts", "scriptz"), "latin1")));
    const out = into(dir);
    expect(extractCommit(p.gitDir, p.head, out)).toMatchObject({ ok: false });
    expect(readdirSync(out)).toEqual([]);
  });

  test("every cap is checked before anything is written: bytes written (shared blobs counted per path), files, tree entries, depth", () => {
    const dir = scratch();
    const big = "x".repeat(1000);
    // One blob behind many paths, two levels deep: 6 files, 6000 bytes written, 8 tree entries (2 folders + 6 files).
    const p = project(dir, { "a/1.txt": big, "a/2.txt": big, "a/3.txt": big, "b/1.txt": big, "b/2.txt": big, "b/3.txt": big });
    const roomy = { bytes: 6000, files: 6, entries: 8, depth: 2 };
    const rows: [string, Partial<typeof roomy>, string | null][] = [
      ["all within the caps", {}, null],
      ["bytes written, a shared blob counted per path", { bytes: 5999 }, "more than 5999 bytes"],
      ["files", { files: 5 }, "more than 5 files"],
      ["tree entries", { entries: 7 }, "more than 7 entries"],
      ["tree depth", { depth: 1 }, "deeper than 1"],
    ];
    for (const [name, change, refusal] of rows) {
      const out = join(dir, `out-${name.replace(/\W+/g, "-")}`);
      mkdirSync(out);
      const result = extractCommit(p.gitDir, p.head, out, { ...roomy, ...change });
      if (refusal === null) expect(result, name).toEqual({ ok: true, files: 6 });
      else {
        expect(result, name).toMatchObject({ ok: false, message: expect.stringContaining(refusal) });
        expect(readdirSync(out), name).toEqual([]);
      }
    }
  });

  test("tree paths are normalized or refused", () => {
    for (const path of ["scripts/deploy-browser.mjs", "a/b.c", ".gitattributes"]) expect(normalizedTreePath(path), path).toBe(true);
    for (const path of ["", "/abs", "../up", "a/../b", "a//b", "./a", "a/.", "a\\b", "a\u0000b", "a\nb"]) expect(normalizedTreePath(path), JSON.stringify(path)).toBe(false);
  });

  test("under the release the package name comes from the extracted commit and must be a plain name", () => {
    const dir = scratch();
    const extraction = join(dir, "extraction"), worktree = join(dir, "worktree");
    mkdirSync(join(extraction, "scripts"), { recursive: true });
    for (const file of readdirSync(join(ROOT, "scripts")).filter(one => /^deploy-.*\.mjs$/.test(one))) cpSync(join(ROOT, "scripts", file), join(extraction, "scripts", file));
    mkdirSync(worktree);
    const runScript = () => spawnSync(process.execPath, [join(extraction, "scripts", "deploy-browser.mjs"), "--run", "1", "--source", worktree, "--git-dir", join(dir, "none"),
      "--head", "a".repeat(40), "--plist", join(dir, "no.plist")], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: dir } });
    // A hostile name in the worktree is never read: the extraction's plain name is, and the script goes on (to stop later).
    writeFileSync(join(worktree, "package.json"), JSON.stringify({ name: "../../../evil" }));
    writeFileSync(join(extraction, "package.json"), JSON.stringify({ name: "toolroll" }));
    const fine = runScript();
    expect(fine.stderr).not.toContain("isn't a plain package name");
    expect(fine.status).not.toBe(0);
    // A hostile name in the commit itself stops the script before it reads anything else.
    for (const name of ["../../evil", "@scope/../x", "a/b/c", "@a/b/c", "/abs", ""]) {
      writeFileSync(join(extraction, "package.json"), JSON.stringify({ name }));
      expect(runScript().stderr, name).toContain("isn't a plain package name");
    }
  });
});

/**
 * Attack (Codex review of 0.9.73, finding 4): shorten what a release card says changed by rewriting history in the
 * checkout's .git after filing — a shallow boundary at the candidate, grafts, a replacement ref, or the candidate's
 * commit object rewritten under its id to name the last release as its parent. Guard: verifiedRange hashes every
 * commit it lists and refuses each of these, so the card refuses rather than showing a shorter list.
 */
describe("attack: rewritten history hides a release's commits", () => {
  const scratch = useScratch("release-range");
  const history = () => {
    const repo = join(scratch(), "project");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q");
    const commit = (name: string) => { writeFileSync(join(repo, name), `${name}\n`); git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", name); return git(repo, "rev-parse", "HEAD"); };
    const baseline = commit("released"), hidden = commit("hidden"), candidate = commit("candidate");
    return { repo, gitDir: join(repo, ".git"), baseline, hidden, candidate };
  };

  test("untouched: both commits are listed", () => {
    const h = history();
    const range = verifiedRange(h.gitDir, h.baseline, h.candidate);
    expect(range.ok && range.value.map(one => one.id)).toEqual([h.candidate, h.hidden]);
  });

  test.each(["shallow", "grafts", "replace"] as const)("%s: the range refuses", how => {
    const h = history();
    if (how === "shallow") writeFileSync(join(h.gitDir, "shallow"), `${h.candidate}\n`);
    if (how === "grafts") { mkdirSync(join(h.gitDir, "info"), { recursive: true }); writeFileSync(join(h.gitDir, "info", "grafts"), `${h.candidate} ${h.baseline}\n`); }
    if (how === "replace") git(h.repo, "replace", "--graft", h.candidate, h.baseline);
    expect(verifiedRange(h.gitDir, h.baseline, h.candidate)).toMatchObject({ ok: false });
  });

  test("a commit-graph rewritten to skip the hidden commit: the range still lists it, from the objects", () => {
    const h = history();
    // One more commit on top, so the rewritten parent link is one Git reads from the graph (a tip it reads from its object).
    writeFileSync(join(h.repo, "top"), "top\n"); git(h.repo, "add", "-A"); git(h.repo, "commit", "-q", "-m", "top");
    const top = git(h.repo, "rev-parse", "HEAD");
    git(h.repo, "commit-graph", "write", "--reachable");
    const file = join(h.gitDir, "objects", "info", "commit-graph");
    const graph = readFileSync(file);
    // The chunk table: 12-byte entries (id, offset) after the 8-byte header; OIDL lists the ids in order, CDAT their parents.
    const chunk = (id: string) => { for (let at = 8; ; at += 12) { if (graph.toString("latin1", at, at + 4) === id) return Number(graph.readBigUInt64BE(at + 4)); } };
    const ids = [h.baseline, h.hidden, h.candidate, top].sort();
    chmodSync(file, 0o644);
    graph.writeUInt32BE(ids.indexOf(h.baseline), chunk("CDAT") + ids.indexOf(h.candidate) * 36 + 20);
    writeFileSync(file, graph);
    // Git reading the graph believes it: the hidden commit drops out of its own listing.
    expect(git(h.repo, "rev-list", `${h.baseline}..${top}`).split("\n")).toEqual([top, h.candidate]);
    const range = verifiedRange(h.gitDir, h.baseline, top);
    expect(range.ok && range.value.map(one => one.id)).toEqual([top, h.candidate, h.hidden]);
  });

  test("an empty range is proved too: `to` must be the last release or its verified ancestor", () => {
    const h = history();
    expect(verifiedRange(h.gitDir, h.candidate, h.candidate)).toMatchObject({ ok: true, value: [] });
    expect(verifiedRange(h.gitDir, h.candidate, h.baseline)).toMatchObject({ ok: true, value: [] });
    // Two commits back, past a reach of one: not proved, refused (Git's empty listing alone is never taken).
    expect(verifiedRange(h.gitDir, h.candidate, h.baseline, { reach: 1 })).toMatchObject({ ok: false });
  });

  test("the candidate's commit object rewritten under its id to skip the hidden commit: the range refuses", () => {
    const h = history();
    const loose = join(h.gitDir, "objects", h.candidate.slice(0, 2), h.candidate.slice(2));
    const original = inflateSync(readFileSync(loose)).toString("latin1");
    chmodSync(loose, 0o644);
    writeFileSync(loose, deflateSync(Buffer.from(original.replace(h.hidden, h.baseline), "latin1")));
    expect(verifiedRange(h.gitDir, h.baseline, h.candidate)).toMatchObject({ ok: false });
  });
});
