/**
 * The sample project from the terminal (public-release 3a): `toolroll welcome sample` and the terminal UI's `s`, through
 * the real runOperate on a temporary laptop database, and the one operation every surface shares (sample-project.ts
 * addSampleProject). It adds a folder agents will work in, as this computer's password-free owner, so it is refused to a
 * remote API token, a lead token, anything not a person at a terminal (an agent, a pipe, --json), an install with
 * passwords and the demo; it never touches a folder by that name it didn't make, never widens the projects folders this
 * install serves, adds one sample only, and re-checks the person's standing and the served folder after its waits.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { createElement } from "react";
import { runOperate, runOperateAs, type OperateOptions, type Principal } from "../../src/operate.js";
import { runAsLocalOwner } from "../../src/local-owner.js";
import { mintApiToken } from "../../src/api-tokens.js";
import { updateProjectRegistry } from "../../src/repos.js";
import { addSampleProject } from "../../src/sample-project.js";
import { COMMAND_GUIDE, LOCAL_POLICY } from "../../src/surface.js";
import { initLocalMode, openStore, setLocalModeOff, type Store } from "../../src/store.js";
import { App } from "../../src/tui/app.js";
import { createTuiSource } from "../../src/tui-source.js";
import type { TuiSession } from "../../src/tui-contract.js";

const now = new Date("2026-11-13T09:00:00Z");
let root: string, file: string, projects: string, registry: string;
const sample = () => join(projects, "toolroll-sample");
const check = async () => ({ state: "connected" as const, mode: "subscription" as const, checkedAt: now.toISOString() });

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-sample-cli-")));
  file = join(root, "state.db");
  projects = join(root, "Projects");
  mkdirSync(projects);
  registry = join(root, "repos.json");
  // What a laptop start outside any repository saves: one projects folder, no repository yet.
  await updateProjectRegistry(registry, () => ({ repos: [], roots: [projects] }));
  const store = openStore(file, { createdBy: "laptop" });
  try {
    if (!initLocalMode(store, { owner: "alex", fenceAvailable: true, now }).ok) throw Error("local mode");
  } finally { store.close(); }
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

async function run(args: string[], easySeams: NonNullable<OperateOptions["easySeams"]> = { terminal: true }): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await runOperate("welcome", ["sample", ...args, "--db", file], text => { out += `${text}\n`; }, { now, easySeams: { check, ...easySeams } });
  return { code, out };
}
async function viaScreen(extra: string[] = []): Promise<Record<string, unknown>> {
  let out = "";
  await runAsLocalOwner(() => runOperate("welcome", ["sample", ...extra, "--json", "--db", file], text => { out += text; }, { now }));
  return JSON.parse(out.trim()) as Record<string, unknown>;
}
const withStore = <T>(body: (store: Store) => T): T => { const store = openStore(file); try { return body(store); } finally { store.close(); } };
const withStoreAsync = async <T>(body: (store: Store) => Promise<T>): Promise<T> => { const store = openStore(file); try { return await body(store); } finally { store.close(); } };
const listed = () => JSON.parse(readFileSync(registry, "utf8")) as { repos: string[]; roots: string[] };
const added = () => withStore(store => ({
  projects: store.listProjects().map(one => one.path),
  checks: Number(store.handle.prepare("SELECT COUNT(*) AS n FROM verify_command").get()!["n"]),
  check: store.liveVerifyCommand(sample()),
  ledger: store.actionLedger({ repos: [sample()], instance: true, limit: 20 }).map(one => `${one.actor} ${one.action}`),
}));
/** Nothing was made or added: no sample folder, the registry as the start saved it, no project row, no check. */
function nothingChanged(): void {
  expect(existsSync(sample())).toBe(false);
  expect(listed()).toMatchObject({ repos: [], roots: [projects] });
  expect(added()).toMatchObject({ projects: [], checks: 0 });
}

describe("toolroll welcome sample", () => {
  test("typed by a person at a terminal: made, added as the local owner, its own fixed check set; once only", async () => {
    const first = await run([]);
    expect(first.code, first.out).toBe(0);
    expect(first.out).toContain(`Added the sample project: ${sample()}`);
    expect(existsSync(join(sample(), ".git", "toolroll-sample"))).toBe(true);
    // Added inside the projects folder already served; the projects folders themselves never change.
    expect(listed()).toEqual({ version: expect.anything(), repos: [sample()], roots: [projects] });
    const after = added();
    expect(after.projects).toEqual([sample()]);
    expect(after.check).toMatchObject({ command: "node --test", approvedBy: "toolroll" });
    expect(after.ledger).toEqual(expect.arrayContaining(["alex project added", "toolroll check approved"]));
    // Again: the same one sample, found (never made twice, never a second check, never a second line).
    const again = await run([]);
    expect(again.out).toContain(`The sample project is already added: ${sample()}`);
    expect(readdirSync(projects)).toEqual(["toolroll-sample"]);
    expect(listed().repos).toEqual([sample()]);
    expect(added().checks).toBe(1);
  }, 30_000);

  test("the terminal UI's door: the local owner's own act (add-project), with its envelope; the read-only welcome stays a read", async () => {
    expect(LOCAL_POLICY.get("welcome sample")).toEqual({ local: "allow", act: "add-project" });
    expect(LOCAL_POLICY.get("welcome")).toEqual({ local: "allow", act: "read" });
    expect(COMMAND_GUIDE.find(row => row.invocation === "welcome sample")).toMatchObject({ remote: "no", agentMayInvoke: false });
    expect(await viaScreen()).toMatchObject({ ok: true, command: "welcome sample", repo: sample(), created: true, added: true, checkSet: true });
    expect(await viaScreen()).toMatchObject({ ok: true, repo: sample(), created: false, added: false, checkSet: false });
    // The screen's door takes no credential.
    expect(await viaScreen(["--token", "so_x"])).toMatchObject({ ok: false, reason: "refused" });
  }, 30_000);

  test("refused, with nothing made: --json or no terminal (an agent, a pipe), a folder or flag named, a lead token, a remote API token", async () => {
    const refusals: [string[], NonNullable<OperateOptions["easySeams"]>, string][] = [
      [["--json"], { terminal: true }, "not-a-terminal"],
      [["--json"], { terminal: false }, "not-a-terminal"],
      [[], { terminal: false }, "Add the sample project yourself at a terminal"],
      [[projects], { terminal: true }, "it takes no folder or name"],
      [["--project-root", root], { terminal: true }, "--project-root is not a welcome sample option"],
      [["--token", "so_x"], { terminal: true }, "is not a welcome sample option"],
    ];
    for (const [args, seams, words] of refusals) {
      const { code, out } = await run(args, seams);
      expect(code, args.join(" ")).not.toBe(0);
      expect(out, args.join(" ")).toContain(words);
    }
    // A lead token in the environment: a lead never adds the sample, even at a terminal.
    vi.stubEnv("TOOLROLL_LEAD_TOKEN", "lead_x");
    expect((await run([])).out).toContain("A lead token can't add the sample project");
    vi.unstubAllEnvs();
    // A person's API token on a central server: not a remote command at all.
    const minted = mintApiToken();
    const principal = withStore(store => {
      store.createApiToken({ id: minted.id, account: "alex", name: "script", secretHash: minted.hash, access: "act", expiresAt: "2027-06-01T00:00:00.000Z", by: "alex" }, now);
      return { kind: "person", account: "alex", generation: store.accountOf("alex")!.generation, scope: "act", tokenId: minted.id, projects: null } satisfies Principal;
    });
    let remote = "";
    const store = openStore(file);
    try { await runOperateAs(["welcome", "sample", "--json"], { principal, store, write: line => { remote += line; }, options: { now } }); } finally { store.close(); }
    expect(JSON.parse(remote)).toMatchObject({ ok: false, reason: "not-remote" });
    nothingChanged();
  }, 30_000);

  test("an install with passwords, and the demo, refuse; the browser's sample is theirs", async () => {
    withStore(store => expect(setLocalModeOff(store, { name: "alex", authority: "full" }, now)).toMatchObject({ ok: true }));
    expect((await run([])).out).toContain("This Toolroll signs in with a password");
    nothingChanged();
    withStore(store => store.recordInstallationFact("demo", "1", now));
    expect((await run([])).out).toContain("The sandbox never makes projects");
    nothingChanged();
  });

  test("a folder named toolroll-sample that Toolroll didn't make: refused, and nothing in it or the lists changes", async () => {
    mkdirSync(sample());
    writeFileSync(join(sample(), "notes.txt"), "mine\n");
    const { code, out } = await run([]);
    expect(code).toBe(3);
    expect(out).toContain("wasn't made by Toolroll, so nothing was changed");
    expect(readdirSync(sample())).toEqual(["notes.txt"]);
    expect(listed()).toMatchObject({ repos: [], roots: [projects] });
    expect(added()).toMatchObject({ projects: [], checks: 0 });
  });

  test("never widens what is served: no projects folder (only repositories, or nothing configured) adds nothing anywhere", async () => {
    const other = join(root, "shop");
    mkdirSync(join(other, ".git"), { recursive: true });
    await updateProjectRegistry(registry, () => ({ repos: [other], roots: [] }));
    const only = await run([]);
    expect(only.code).toBe(3);
    expect(only.out).toContain("There's no projects folder to put the sample in");
    expect(listed()).toMatchObject({ repos: [other], roots: [] });
    // Nothing configured at all would be the legacy serve-everything mode: still never a place to make a project.
    rmSync(registry);
    expect((await run([])).out).toContain("There's no projects folder");
    expect(existsSync(registry)).toBe(false);
    expect(existsSync(sample())).toBe(false);
    expect(readdirSync(root).filter(one => one.includes("toolroll-sample"))).toEqual([]);
  });
});

describe("addSampleProject: the one operation, re-checked after its waits", () => {
  const actor = { label: "alex", origin: "cli" as const };
  test("authority that lapses while the folder is made: nothing is added (the folder made stays ours, unlisted)", async () => {
    let standing = true;
    const result = await withStoreAsync(store => addSampleProject({
      store, registryFile: registry, now, ceiling: () => ({ repos: [], roots: [projects] }),
      authority: { actor, stands: () => standing },
      refreshCeiling: async () => { standing = false; },
    }));
    expect(result).toEqual({ ok: false, reason: "refused" });
    expect(listed().repos).toEqual([]);
    expect(added()).toMatchObject({ projects: [], checks: 0 });
  });

  test("a projects folder that moved while the folder was made: nothing is added", async () => {
    let roots = [projects];
    const result = await withStoreAsync(store => addSampleProject({
      store, registryFile: registry, now, ceiling: () => ({ repos: [], roots }),
      authority: { actor, stands: () => true },
      refreshCeiling: async () => { roots = [join(root, "Elsewhere")]; },
    }));
    expect(result).toEqual({ ok: false, reason: "not-added" });
    expect(listed().repos).toEqual([]);
    expect(added()).toMatchObject({ projects: [], checks: 0 });
  });

  test("authority asked inside the admission's own writes: refused there, the registry line it took is given back", async () => {
    // Stands until the admission's locked registry update has written the sample's line, then not: the refusal comes
    // from inside admitProject's database transaction.
    const lineWritten = () => existsSync(registry) && readFileSync(registry, "utf8").includes("toolroll-sample");
    const result = await withStoreAsync(store => addSampleProject({
      store, registryFile: registry, now, ceiling: () => ({ repos: [], roots: [projects] }),
      authority: { actor, stands: () => !lineWritten() },
    }));
    expect(result.ok).toBe(false);
    expect(listed().repos).toEqual([]);
    expect(added()).toMatchObject({ projects: [], checks: 0 });
  });
});

describe("the terminal UI: s on Setup", () => {
  test("no project: Setup offers the sample on s; one key adds it as the local owner, and n files a first task in it", async () => {
    const session: TuiSession = { owned: () => false, openBrowser: async () => "", shouldAskBackground: () => false, answerBackground: async () => "" };
    const source = createTuiSource({ databaseFile: file, operate: { now }, check });
    const app = render(createElement(App, { source, session, pollMs: 50 }));
    const shows = (text: string) => vi.waitFor(() => expect(app.lastFrame()).toContain(text), { timeout: 20_000 });
    try {
      await shows("s  Try the sample project");
      await shows("s sample project · n new task");
      app.stdin.write("s");
      await shows("Added the sample project. Press n to write a first task.");
      // The sample's own ideas, and the key is no longer offered.
      await shows("Idea: Round priceWithDiscount's result to whole cents");
      expect(app.lastFrame()).not.toContain("s  Try the sample project");
      expect(added().projects).toEqual([sample()]);
      app.stdin.write("n");
      await shows("New task");
      // Filed in the sample (the line wraps at this width).
      expect(app.lastFrame()!.replace(/[│\s]/g, "")).toContain(`In${sample()}`.replace(/\s/g, ""));
    } finally { source.close(); }
  }, 40_000);

  test("an install with passwords: nothing offers s, and s adds nothing", async () => {
    withStore(store => expect(setLocalModeOff(store, { name: "alex", authority: "full" }, now)).toMatchObject({ ok: true }));
    const source = createTuiSource({ databaseFile: file, operate: { now }, check });
    try {
      const setup = await source.setup();
      expect(setup?.sample).toBe(false);
      expect(setup?.lines.join("\n")).not.toContain("sample");
      expect(await source.act({ kind: "sample" })).toMatchObject({ ok: false });
    } finally { source.close(); }
    nothingChanged();
  });
});
