/**
 * The console's project identities (project-identity.ts): authorization never trusts a path's spelling. A stored path
 * that resolves outside its root is outside, one not yet resolved is outside until it is, and a request's path is
 * accepted only when resolved or exactly a project the plane admitted.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizedProject, rowVisible } from "./project.js";
import { IDENTITY_LOOKS, projectIdentities } from "./project-identity.js";
import { folderLooksRunning, type FolderLookRunner } from "./folder-look.js";

let base: string;
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), "so-identity-"))); });
afterEach(() => rmSync(base, { recursive: true, force: true }));

test.each([
  ["a stored path that leads outside its root", "link/project", true, false],
  ["a stored path not yet resolved", "inside", false, false],
  ["a stored path resolved inside its root", "inside", true, true],
])("%s: visible %#", async (_, relative, resolveFirst, visible) => {
  const allowed = join(base, "allowed"), outside = join(base, "outside");
  mkdirSync(join(outside, "project"), { recursive: true });
  mkdirSync(join(allowed, "inside"), { recursive: true });
  symlinkSync(outside, join(allowed, "link"));
  const identities = projectIdentities();
  const path = join(allowed, relative);
  if (resolveFirst) await identities.refresh([path]);
  const ceiling = { repos: [], roots: [allowed], canon: identities.strict };
  expect(rowVisible(ceiling, path)).toBe(visible);
  expect(await authorizedProject(ceiling, path, async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, notFound: false }))).toBe(visible);
  // Display still shows it as saved; it never authorizes.
  expect(identities.hot(path)).toBe(resolveFirst && relative.startsWith("link") ? join(outside, "project") : path);
});

test("a request's path: only a resolved identity or exactly an admitted project", async () => {
  const project = join(base, "project");
  mkdirSync(project);
  symlinkSync(project, join(base, "alias"));
  const identities = projectIdentities();
  expect(identities.vouched(join(base, "alias"), () => [])).toBeUndefined();
  expect(identities.vouched(project, () => [project])).toBe(project);
  await identities.refresh([join(base, "alias")]);
  expect(identities.vouched(join(base, "alias"), () => [])).toBe(project);
});

test("a folder that never answers holds no other: the rest resolve a few at a time, and it stays unresolved", async () => {
  const folders = Array.from({ length: 9 }, (_, n) => join(base, `project-${n}`));
  for (const one of folders) mkdirSync(one);
  const hung = join(base, "icloud-held");
  const ends: (() => void)[] = [];
  let running = 0, most = 0;
  const runner: FolderLookRunner = request => {
    const paths = request.op === "identities" ? request.paths : [];
    // A hung look's process outlives the test until it is ended below.
    if (paths.includes(hung)) return { answer: new Promise(() => {}), ended: new Promise<void>(done => ends.push(done)) };
    running++; most = Math.max(most, running);
    const answer = new Promise(done => setTimeout(done, 5)).then(() => { running--; return { ok: true, value: { paths: paths.map(path => ({ path, real: realpathSync(path) })) } }; });
    return { answer, ended: answer.then(() => undefined) };
  };
  try {
    const identities = projectIdentities({ runner, deadlineMs: 100 });
    expect(await identities.refresh([...folders, hung])).toBe(false);
    for (const one of folders) expect(identities.strict(one)).toBe(one);
    expect(identities.strict(hung)).toBeNull();
    expect(identities.hot(hung)).toBe(hung);
    expect(most).toBeLessThanOrEqual(IDENTITY_LOOKS);
  } finally { for (const end of ends) end(); }
});

/** A look the test answers by hand: each call is kept with its paths and a way to answer it. */
function manualLooks(): { runner: FolderLookRunner; calls: { paths: readonly string[]; answer: (pairs: [string, string | null][]) => void }[] } {
  const calls: { paths: readonly string[]; answer: (pairs: [string, string | null][]) => void }[] = [];
  const runner: FolderLookRunner = request => {
    let answer!: (pairs: [string, string | null][]) => void;
    const answered = new Promise<unknown>(done => { answer = pairs => done({ ok: true, value: { paths: pairs.map(([path, real]) => ({ path, real })) } }); });
    calls.push({ paths: request.op === "identities" ? request.paths : [], answer });
    return { answer: answered, ended: answered.then(() => undefined) };
  };
  return { runner, calls };
}

test("an older lookup never overwrites a newer answer, nor brings back its real path's entry", async () => {
  const looks = manualLooks();
  const identities = projectIdentities({ runner: looks.runner, deadlineMs: 60_000 });
  const alias = join(base, "alias"), other = join(base, "other"), a = join(base, "a"), b = join(base, "b");
  const pass = identities.refresh([alias, other]);
  await vi.waitFor(() => expect(looks.calls).toHaveLength(1));
  // A direct look starts later and answers first: the alias now leads to b.
  const direct = identities.resolveNow(alias);
  await vi.waitFor(() => expect(looks.calls).toHaveLength(2));
  looks.calls[1]!.answer([[alias, b]]);
  expect(await direct).toBe(b);
  const generation = identities.generation();
  // The batch, started first, answers last with what the alias used to be.
  looks.calls[0]!.answer([[alias, a], [other, other]]);
  await pass;
  expect(identities.strict(alias)).toBe(b);
  expect(identities.known(a)).toBeUndefined();
  expect(identities.strict(other)).toBe(other);
  expect(identities.generation()).toBe(generation);
});

test("a known identity that changes moves the generation; one first learned doesn't", async () => {
  const looks = manualLooks();
  const identities = projectIdentities({ runner: looks.runner, deadlineMs: 60_000 });
  const alias = join(base, "alias");
  const first = identities.resolveNow(alias);
  await vi.waitFor(() => expect(looks.calls).toHaveLength(1));
  looks.calls[0]!.answer([[alias, join(base, "a")]]);
  await first;
  expect(identities.generation()).toBe(0);
  const moved = identities.resolveNow(alias);
  await vi.waitFor(() => expect(looks.calls).toHaveLength(2));
  looks.calls[1]!.answer([[alias, join(base, "b")]]);
  await moved;
  expect(identities.generation()).toBe(1);
});

test("one folder stuck for good holds one look, however the passes' path sets change", async () => {
  const hung = join(base, "icloud-held");
  const ends: (() => void)[] = [];
  const runner: FolderLookRunner = request => {
    const paths = request.op === "identities" ? request.paths : [];
    if (paths.includes(hung)) return { answer: new Promise(() => {}), ended: new Promise<void>(done => ends.push(done)) };
    const answer = Promise.resolve({ ok: true, value: { paths: paths.map(path => ({ path, real: path })) } });
    return { answer, ended: answer.then(() => undefined) };
  };
  try {
    const before = folderLooksRunning();
    const identities = projectIdentities({ runner, deadlineMs: 30 });
    const healthy: string[] = [];
    for (let pass = 0; pass < 6; pass++) {
      healthy.push(join(base, `project-${pass}`));
      // A different set every pass: before, each made a new batch with the stuck folder in it, a new child each time.
      expect(await identities.refresh([hung, ...healthy])).toBe(false);
      for (const one of healthy) expect(identities.strict(one)).toBe(one);
      expect(identities.strict(hung)).toBeNull();
    }
    // The first pass's batch and the stuck folder's own look; nothing more piles up.
    expect(folderLooksRunning() - before).toBeLessThanOrEqual(2);
  } finally { for (const end of ends) end(); }
});
