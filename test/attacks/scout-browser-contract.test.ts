/**
 * Attack: starting the scout's browser — which runs outside Toolroll's fence, under Chrome's own sandbox — from
 * something a build could have written, or with Chrome's sandbox or the scout's proxy switched off (docs/plans/
 * sandbox-parity.md C4, owner Q-A). The launch is held to a contract (scout-browser.ts browserContractProblem) and
 * refused when any part fails; the legitimate launch beside the attacks passes it.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { SCOUT_BROWSER_LOCK } from "../../src/scout-browser-lock.js";
import { browserContractProblem, helperNpm, lockDrift, ownNpm, scoutBrowserHelper, scoutBrowserTool, startContractedBrowser, type BrowserLaunch, type BrowserOptions } from "../../src/scout-browser.js";
import { scoutBrowserLaunch } from "../../src/scout.js";
import { useScratch, write } from "./harness.js";

const scratch = useScratch("scout-contract");
const PROXY = "http://127.0.0.1:41999";
let helpers: string, folder: string, good: BrowserLaunch, options: BrowserOptions;
beforeEach(() => {
  const root = scratch();
  helpers = join(root, "toolroll", "helpers");
  mkdirSync(helpers, { recursive: true, mode: 0o700 });
  write(scoutBrowserHelper(helpers).cli, "// the pinned helper\n");
  folder = join(root, "images");
  mkdirSync(folder);
  good = scoutBrowserLaunch(scoutBrowserTool(helpers), folder, PROXY)!;
  options = { env: { PATH: "/usr/bin:/bin", HOME: root, HTTP_PROXY: PROXY, HTTPS_PROXY: PROXY, http_proxy: PROXY, https_proxy: PROXY }, folder, contract: { helpers, proxy: PROXY } };
});

describe("attack: the scout's browser launched outside its contract", () => {
  test("the pinned helper, run by Toolroll's own Node with the expected arguments and environment, passes", () => {
    expect(browserContractProblem(good, options)).toBeNull();
  });

  test("an executable a build could write (a copy of Node in a project folder) is refused", () => {
    const copy = join(scratch(), "project", "node");
    mkdirSync(join(scratch(), "project"));
    copyFileSync(process.execPath, copy);
    expect(browserContractProblem({ ...good, command: copy }, options)).toMatch(/Toolroll's own Node/);
  });

  test("a script outside the helpers folder, or a helpers folder that is a link, is refused", () => {
    const planted = write(join(scratch(), "project", "cli.js"), "// planted\n");
    expect(browserContractProblem({ ...good, args: [planted, ...good.args.slice(1)] }, options)).toMatch(/pinned one/);
    const linked = join(scratch(), "linked-helpers");
    symlinkSync(helpers, linked);
    expect(browserContractProblem(scoutBrowserLaunch(scoutBrowserTool(linked), folder, PROXY)!, { ...options, contract: { helpers: linked, proxy: PROXY } })).toMatch(/private folder/);
  });

  test("Chrome's sandbox off, another browser, or the proxy dropped is refused", () => {
    expect(browserContractProblem({ ...good, args: [...good.args, "--no-sandbox"] }, options)).toMatch(/arguments/);
    expect(browserContractProblem({ ...good, args: good.args.map(one => one === "chromium" ? "chrome" : one) }, options)).toMatch(/arguments/);
    expect(browserContractProblem({ ...good, args: good.args.map(one => one === PROXY ? "http://127.0.0.1:1" : one) }, options)).toMatch(/arguments/);
    expect(browserContractProblem(good, { ...options, env: { ...options.env, HTTPS_PROXY: undefined } })).toMatch(/proxy/);
  });

  test("an environment beyond the allowlist is refused", () => {
    expect(browserContractProblem(good, { ...options, env: { ...options.env, NODE_OPTIONS: "--require /tmp/planted.js" } })).toMatch(/allowlist/);
  });

  test("with no contract, nothing starts", async () => {
    const { contract: _none, ...bare } = options;
    expect(await startContractedBrowser(good, bare)).toEqual({ ok: false, reason: "the browser has no launch contract" });
  });

  test("the unfenced installer's npm takes nothing a build could have planted: no ~/.npmrc, no registry or Node option from its environment", ctx => {
    const npm = ownNpm();
    ctx.skip(npm === null, "this Node has no npm beside it");
    const root = scratch();
    // What a build under writes: anywhere could plant: the user's npmrc, pointing npm elsewhere and loading code.
    const home = join(root, "home");
    write(join(home, ".npmrc"), "registry=http://127.0.0.1:9/planted/\nnode-options=--require /tmp/planted.js\n");
    // Positive control: npm as the user's shell runs it takes the planted registry.
    const planted = spawnSync(process.execPath, [npm!, "config", "get", "registry"], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: home } });
    expect(planted.stdout.trim()).toBe("http://127.0.0.1:9/planted/");
    // The installer's npm: its own empty configuration and the pinned registry, whatever HOME and the environment say.
    const staging = join(root, "staging");
    mkdirSync(staging);
    const { env, args } = helperNpm(staging, npm!);
    const pinned = spawnSync(process.execPath, [...args, "config", "get", "registry"], { encoding: "utf8", env: { ...env } });
    expect(pinned.stdout.trim()).toBe("https://registry.npmjs.org/");
    expect(env.HOME).toBe(staging);
    expect(Object.keys(env).sort()).toEqual(["HOME", "NPM_CONFIG_GLOBALCONFIG", "NPM_CONFIG_USERCONFIG", "PATH", "PLAYWRIGHT_BROWSERS_PATH", "npm_config_globalconfig", "npm_config_userconfig"]);
    expect(args[0]).toBe(npm);
  });

  test("an installed tree that isn't the pinned lockfile's is refused", () => {
    const tree = join(scratch(), "tree");
    for (const [path, entry] of Object.entries(SCOUT_BROWSER_LOCK.packages as Record<string, { version?: string }>)) {
      if (path !== "") write(join(tree, path, "package.json"), JSON.stringify({ version: entry.version }));
    }
    expect(lockDrift(tree)).toBeNull();
    write(join(tree, "node_modules", "playwright-core", "package.json"), JSON.stringify({ version: "9.9.9" }));
    expect(lockDrift(tree)).toMatch(/playwright-core is 9.9.9/);
  });
});
