/**
 * npm 11 refuses to load one file as both its user and its global config ("double-loading config … as global"), and
 * release 0.9.72's first deploy stopped on exactly that: deploy-browser.mjs pointed both at /dev/null. Whatever turns
 * off the person's npm config must name two different files.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

const root = resolve(import.meta.dirname, "..");
const sources = ["scripts", "src"].flatMap(dir => readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
  .filter(name => /\.(m?js|ts)$/.test(name) && !/\.test\.ts$/.test(name)).map(name => join(dir, name)));

test("no source points npm's user and global config at the same literal file", () => {
  const same: string[] = [];
  for (const file of sources) {
    for (const line of readFileSync(join(root, file), "utf8").split("\n")) {
      const user = /npm_config_userconfig:\s*"([^"]+)"/i.exec(line)?.[1];
      const global = /npm_config_globalconfig:\s*"([^"]+)"/i.exec(line)?.[1];
      if (user !== undefined && user === global) same.push(`${file}: ${user}`);
    }
  }
  expect(same).toEqual([]);
});

test("npm runs with its user config at /dev/null and its global config an empty file of its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "so-npmrc-test-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "npmrc-probe", version: "1.0.0" }));
  const global = join(dir, "global-npmrc");
  writeFileSync(global, "");
  const env = { ...process.env, npm_config_userconfig: "/dev/null", npm_config_globalconfig: global };
  const packed = spawnSync("npm", ["pack", "--dry-run", "--silent"], { cwd: dir, env, encoding: "utf8" });
  expect(packed.status, packed.stderr).toBe(0);
});
