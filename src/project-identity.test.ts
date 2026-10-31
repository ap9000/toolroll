/**
 * The console's project identities (project-identity.ts): authorization never trusts a path's spelling. A stored path
 * that resolves outside its root is outside, one not yet resolved is outside until it is, and a request's path is
 * accepted only when resolved or exactly a project the plane admitted.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizedProject, rowVisible } from "./project.js";
import { IDENTITY_LOOKS, projectIdentities } from "./project-identity.js";
import type { FolderLookRunner } from "./folder-look.js";

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
