// A Codex build inside the macOS sandbox (docs/plans/codex-os-fence.md), against the real sandbox-exec: its own run
// home and the operator's sign-in and sessions are reached, nothing else of the Codex folder is written or read, other
// launches' folders stay out of reach, and the project's local-services setting decides a loopback listen.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { codexOwnState, homeWriteDenies, macosFenceAvailable, sandboxedSpawn, serverGrantsOf, type FenceGrants } from "./agent-fence.js";
import { startEgressProxy, type EgressProxy } from "./egress.js";
import { isolatedCodexHome } from "./provider-home.js";

const LISTEN = 'require("net").createServer().listen(0,"::1",function(){console.log("LISTEN OK");this.close()}).on("error",e=>{console.log("LISTEN "+e.code);process.exit(3)})';

describe.runIf(macosFenceAvailable())("a Codex build inside the macOS sandbox", () => {
  let dir: string;
  let home: string;
  let codex: string;
  let runs: string;
  let other: string;
  let run: { dir: string; cleanup: () => void };
  let proxy: EgressProxy;
  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "codex-os-fence-")));
    home = join(dir, "home");
    codex = join(home, ".codex");
    runs = join(dir, "runs");
    mkdirSync(join(codex, "sessions"), { recursive: true });
    mkdirSync(runs);
    writeFileSync(join(codex, "auth.json"), '{"synthetic":"sign-in"}');
    writeFileSync(join(codex, "config.toml"), "# synthetic operator config\n");
    other = join(runs, "so-codex-other");
    mkdirSync(other);
    writeFileSync(join(other, "secret.txt"), "synthetic-other-run");
    run = isolatedCodexHome(codex, runs);
    proxy = await startEgressProxy({ hosts: [] });
  });
  afterAll(async () => { await proxy.close(); run.cleanup(); rmSync(dir, { recursive: true, force: true }); });

  const grants = (loopback: "any" | "proxy-only", own = true): FenceGrants => ({
    readOnly: [], readable: [], lookup: [],
    runFolders: { root: runs, own: null, ...(own ? { alsoOwn: [realpathSync(run.dir)] } : {}) },
    homeNames: [codex], writeDenies: homeWriteDenies(home, null, "codex"),
    ...(own ? { codexState: codexOwnState(codex)! } : {}),
    network: { mode: "allowlist", proxyPort: proxy.port, brokerPorts: [], loopback, socketRoots: [], token: proxy.secret },
  });
  const inside = (script: string, given: FenceGrants, file = "/bin/sh", args = ["-c", script]) => {
    const launch = sandboxedSpawn(file, args, [], given, dir);
    return spawnSync(launch.file, launch.args, { cwd: dir, env: { ...process.env, ...launch.env }, encoding: "utf8", timeout: 30_000 });
  };

  test("its own run home, sign-in and sessions are read and written", () => {
    const given = grants("proxy-only");
    expect(inside(`cat "${run.dir}/auth.json"`, given).stdout).toContain("synthetic");
    expect(inside(`printf ' ' >> "${run.dir}/auth.json"`, given).status).toBe(0);
    expect(inside(`touch "${run.dir}/sessions/rollout.jsonl" "${run.dir}/models_cache.json"`, given).status).toBe(0);
  });

  test("nothing else of the operator's Codex folder is written or read, nor another launch's folder", () => {
    const given = grants("proxy-only");
    // Positive control first: the same shell writes its own sessions.
    expect(inside(`touch "${codex}/sessions/control.jsonl"`, given).status).toBe(0);
    for (const name of ["config.toml", "hooks", "AGENTS.md", "rules"]) expect(inside(`touch "${codex}/${name}"`, given).status).not.toBe(0);
    expect(inside(`cat "${codex}/config.toml"`, given).status).not.toBe(0);
    expect(inside(`cat "${other}/secret.txt"`, given).status).not.toBe(0);
  });

  test("without its own grants the run home stays denied like any other launch's", () => {
    expect(inside(`cat "${run.dir}/auth.json"`, grants("proxy-only", false)).status).not.toBe(0);
  });

  test("a tool server started for the build keeps none of its Codex state", () => {
    const server = serverGrantsOf(grants("proxy-only"));
    expect(server.codexState).toBeUndefined();
    expect(server.runFolders).toEqual({ root: runs, own: null });
    // Positive control: the agent's own terms reach the sign-in and the run home; the server's don't.
    expect(inside(`cat "${codex}/auth.json"`, grants("proxy-only")).status).toBe(0);
    for (const path of [join(codex, "auth.json"), join(run.dir, "auth.json")]) expect(inside(`cat "${path}"`, server).status).not.toBe(0);
    for (const path of [join(codex, "sessions", "server.jsonl"), join(codex, "hooks.json")]) expect(inside(`touch "${path}"`, server).status).not.toBe(0);
  });

  test("an OpenRouter build gets the sessions, never the ChatGPT sign-in", () => {
    const given: FenceGrants = { ...grants("proxy-only"), codexState: codexOwnState(codex, { signIn: false })! };
    expect(inside(`touch "${codex}/sessions/openrouter.jsonl"`, given).status).toBe(0);
    expect(inside(`cat "${codex}/auth.json"`, given).status).not.toBe(0);
    expect(inside(`printf ' ' >> "${codex}/auth.json"`, given).status).not.toBe(0);
  });

  test("the project's local-services setting decides a loopback listen", () => {
    expect(inside("", grants("any"), process.execPath, ["-e", LISTEN]).stdout).toContain("LISTEN OK");
    const refused = inside("", grants("proxy-only"), process.execPath, ["-e", LISTEN]);
    expect(refused.stdout).toContain("LISTEN EPERM");
  });
});
