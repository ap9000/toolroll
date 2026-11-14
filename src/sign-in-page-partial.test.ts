/**
 * Eight k1: a sign-in page that can't be finished (the write fails after its folder was made) leaves nothing behind —
 * no folder, no half-written page. node:fs's writeFileSync is made to fail here only; everything else is real.
 */
import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real, writeFileSync: () => { throw Object.assign(Error("no space left on device"), { code: "ENOSPC" }); } };
});

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("a page whose write fails takes its folder with it, and nothing is opened", async () => {
  const { openSignInLink, writeSignInPage } = await import("./sign-in-page.js");
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "so-k1-partial-")));
  made.push(parent);
  expect(() => writeSignInPage(parent, "http://127.0.0.1:4471/login/once/x")).toThrow(/no space/);
  expect(readdirSync(parent)).toEqual([]);
  let started = 0, ended = 0;
  const page = await openSignInLink("http://127.0.0.1:4471/login/once/x", {
    parent, spent: () => false, expiresAt: Date.now() + 60_000, onEnd: () => { ended += 1; },
    opener: () => { started += 1; throw Error("never started"); },
  });
  expect(page.opened).toBe(false);
  expect(started).toBe(0);
  expect(ended).toBe(1);
  expect(readdirSync(parent)).toEqual([]);
});
