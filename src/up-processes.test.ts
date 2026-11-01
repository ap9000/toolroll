import { describe, expect, test } from "vitest";
import { buildIdentity, memoryChannel, parentMessage, RoleGenerations, ROLE_NOT_READY_REPLACEMENTS, roleMessage, startMessage, type RoleToParent } from "./up-processes.js";
import { fakePid } from "../test/fake-pid.js";

const consoleConfig = { host: "127.0.0.1", port: 4180, allowedHosts: null, publicUrl: null, localRunner: "mac", poolRoot: "/s/worktrees", repos: ["/r"], projectRoots: [], registryPath: "/s/repos.json", editor: false };
const workerConfig = { runner: "mac", token: "runner-token", repos: ["/r"], pinnedRepos: [], projectRoots: [], registryPath: "/s/repos.json", pool: "/s/worktrees",
  forMs: null, publicUrl: null, stopGraceMs: 30_000, verbose: false, terminal: false, leaseWaitMs: 105_000 };
const start = (role: string, config: unknown) => ({ type: "start", role, databaseFile: "/s/orders.db", containment: null, build: "1.0.0+abc", config });

describe("the messages between up and its two roles", () => {
  test("a start is exactly one role's config: a console is never handed the runner token", () => {
    expect(startMessage(start("console", consoleConfig))?.role).toBe("console");
    expect(startMessage(start("worker", workerConfig))?.role).toBe("worker");
    for (const bad of [
      start("console", { ...consoleConfig, token: "runner-token" }),
      start("console", workerConfig),
      start("worker", { ...workerConfig, token: "" }),
      start("worker", { ...workerConfig, port: 4180 }),
      start("lead", consoleConfig),
      { ...start("console", consoleConfig), databaseFile: "" },
      { ...start("console", consoleConfig), build: 7 },
      start("console", { ...consoleConfig, repos: ["/r", 3] }),
      start("console", { ...consoleConfig, port: 70_000 }),
      null, "start", [],
    ]) expect(startMessage(bad), JSON.stringify(bad)).toBeNull();
  });

  test("a role speaks only its own part: the worker names no address and no sign-in link, the console no projects", () => {
    expect(roleMessage({ type: "ready", role: "worker", build: "b", pid: fakePid(9), url: null, port: null }, "worker")).not.toBeNull();
    expect(roleMessage({ type: "ready", role: "worker", build: "b", pid: fakePid(9), url: "http://x/", port: 1 }, "worker")).toBeNull();
    expect(roleMessage({ type: "ready", role: "console", build: "b", pid: fakePid(9), url: null, port: null }, "console")).toBeNull();
    expect(roleMessage({ type: "ready", role: "console", build: "b", pid: fakePid(9), url: "http://x/", port: 1 }, "worker")).toBeNull();
    expect(roleMessage({ type: "sign-in-link", id: 1, link: "/login/once/x" }, "worker")).toBeNull();
    expect(roleMessage({ type: "repos", repos: ["/r"] }, "console")).toBeNull();
    expect(roleMessage({ type: "log", line: "x".repeat(20_000) }, "worker")).toBeNull();
    expect(parentMessage({ type: "repos", repos: ["/r"] })).toEqual({ type: "repos", repos: ["/r"] });
    expect(parentMessage({ type: "run-builds" })).toBeNull();
    expect(parentMessage({ type: "sign-in-link", id: -1, account: "a" })).toBeNull();
  });

  test("in one process the same checks apply, delivered on a later turn", async () => {
    const channel = memoryChannel("worker");
    const got: RoleToParent[] = [];
    channel.parent.onMessage(message => got.push(message));
    channel.port.send({ type: "repos", repos: ["/r"] });
    channel.port.send({ type: "ready", role: "worker", build: "b", pid: 1, url: "http://x/", port: 1 } as RoleToParent);
    expect(got).toEqual([]);
    await Promise.resolve();
    expect(got).toEqual([{ type: "repos", repos: ["/r"] }]);
  });

  test("a build identity is the version and the exact module code; an unreadable one matches nothing", () => {
    const here = new URL(import.meta.url).pathname;
    expect(buildIdentity("1.2.3", here)).toBe(buildIdentity("1.2.3", here));
    expect(buildIdentity("1.2.3", here)).not.toBe(buildIdentity("1.2.4", here));
    expect(buildIdentity("1.2.3", "/nonexistent")).not.toBe(buildIdentity("1.2.3", "/nonexistent"));
  });
});

describe("a supervised role's generations (Codex review round 1, finding 5)", () => {
  test("readiness is per generation: a replacement's refusal stops `up`; a crash after readiness restarts", () => {
    // The reproduction: ready once, then a replacement refuses (another build). It used to restart forever.
    const refused = new RoleGenerations();
    refused.spawned(); expect(refused.ready()).toBe(true); expect(refused.ended()).toBe("restart");
    refused.spawned(); refused.refused("the worker is a different build"); expect(refused.ended()).toBe("end");
    expect(refused.refusedWith()).toBe("the worker is a different build");
    // Never ready: the start fails as one, as before the split.
    const never = new RoleGenerations();
    never.spawned(); expect(never.ended()).toBe("fail-start");
    // A crash after each readiness keeps restarting.
    const crashy = new RoleGenerations();
    for (let at = 0; at < 10; at++) { crashy.spawned(); expect(crashy.ready()).toBe(at === 0); expect(crashy.ended()).toBe("restart"); }
    // Replacements that keep ending before readiness, with nothing said, stop `up` after a bounded number.
    const silent = new RoleGenerations();
    silent.spawned(); silent.ready(); silent.ended();
    const verdicts: string[] = [];
    for (let at = 0; at < ROLE_NOT_READY_REPLACEMENTS; at++) { silent.spawned(); verdicts.push(silent.ended()); }
    expect(verdicts).toEqual([...Array(ROLE_NOT_READY_REPLACEMENTS - 1).fill("restart"), "end"]);
    // A refusal belongs to its generation: the next spawn starts clean.
    const clean = new RoleGenerations();
    clean.spawned(); clean.ready(); clean.refused("x"); clean.spawned();
    expect(clean.refusedWith()).toBeNull();
  });
});
