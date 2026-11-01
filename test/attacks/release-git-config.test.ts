/**
 * The release coordinator's Git (docs/plans/chat-management.md §0a.2). `toolroll release` used to run plain
 * `git -C <gate checkout>` with the inherited environment and take the repository from the checkout's `origin`. The gate
 * checkout is where the release check ran the build's own code, so its `.git/config` is build-written: an include, an
 * ssh command, an fsmonitor, a hooks folder, a transport-helper remote or a credential helper planted there would run as
 * the person, outside the fence, every time a release ran or resumed.
 *
 * Attack: each of those settings, pointing at a marker script, in the gate checkout; then release preflight (`begin`)
 * and a resumed release. The marker never runs, and the release stops naming the setting. Beside it: the repository and
 * the URL come from the plane's records (an `origin` pointing elsewhere changes nothing), a checkout the plane doesn't
 * record is refused, and a clean checkout passes the check and reads its objects through the hardened runner.
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { lockCheckout } from "../../src/git-views.js";
import { teardownGit, refusal } from "../../src/teardown-git.js";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { exec, recordedReleaseRepo, releaseAdapters, releaseConfigProblem, releaseRemote } from "../../src/release-adapters.js";
import { journalFile, runRelease, writeJournal, type ReleaseAdapters } from "../../src/release.js";
import { openStore } from "../../src/store.js";
import { git, repository, useScratch, write } from "./harness.js";

const scratch = useScratch("release-git");
const RECORDED = "https://github.com/example-invalid/gate.git";
const NOW = new Date("2026-10-25T12:00:00.000Z");

function fixture() {
  const root = scratch();
  const state = join(root, "toolroll");
  mkdirSync(state, { recursive: true });
  const gate = repository(join(root, "gate"), { "package.json": JSON.stringify({ name: "gate", version: "1.2.3" }), "CHANGELOG.md": "## 1.2.3\n" });
  const head = git(gate, "rev-parse", "HEAD");
  const ran = join(root, "marker-ran");
  // The marker: any execution leaves a file behind, whatever Git calls it as.
  const script = write(join(root, "marker.sh"), `#!/bin/sh\necho "$0 $*" >> ${JSON.stringify(ran)}\nexit 0\n`);
  chmodSync(script, 0o755);
  const database = join(state, "orders.db");
  const store = openStore(database);
  store.upsertProject(gate, "gate", NOW, { remoteUrl: RECORDED });
  store.close();
  return { root, state, gate, head, ran, script, database };
}

/** Every planted setting, each written into the gate checkout's own config. */
function poisons(at: ReturnType<typeof fixture>): Array<{ key: string; plant: () => void }> {
  const set = (key: string, value: string) => () => git(at.gate, "config", "--local", key, value);
  return [
    { key: "include.path", plant: () => { write(join(at.root, "evil.cfg"), `[core]\n\tfsmonitor = ${at.script}\n\tsshCommand = ${at.script}\n`); git(at.gate, "config", "--local", "include.path", join(at.root, "evil.cfg")); } },
    { key: "core.sshcommand", plant: set("core.sshCommand", at.script) },
    { key: "core.fsmonitor", plant: set("core.fsmonitor", at.script) },
    { key: "core.hookspath", plant: () => { const hooks = join(at.root, "hooks"); for (const hook of ["post-merge", "reference-transaction", "post-checkout", "pre-push"]) { write(join(hooks, hook), `#!/bin/sh\n${at.script}\n`); chmodSync(join(hooks, hook), 0o755); } git(at.gate, "config", "--local", "core.hooksPath", hooks); } },
    { key: "remote.origin.url", plant: set("remote.origin.url", `ext::${at.script} %S`) },
    { key: "remote.origin.vcs", plant: () => { git(at.gate, "config", "--local", "remote.origin.url", RECORDED); git(at.gate, "config", "--local", "remote.origin.vcs", "marker"); } },
    { key: "credential.helper", plant: set("credential.helper", `!${at.script}`) },
    // What could send the GitHub token elsewhere, or point a fetch or push at another repository.
    { key: "http.proxy", plant: set("http.proxy", "http://127.0.0.1:9") },
    { key: "http.sslverify", plant: set("http.sslVerify", "false") },
    { key: "http.extraheader", plant: set("http.extraHeader", "Authorization: bearer planted") },
    { key: "http.cookiefile", plant: set("http.cookieFile", join(at.root, "cookies")) },
    { key: "remote.origin.proxy", plant: set("remote.origin.proxy", "http://127.0.0.1:9") },
    { key: `remote.${RECORDED}.url`, plant: set(`remote.${RECORDED}.url`, "https://github.com/attacker/elsewhere.git") },
    { key: `remote.${RECORDED}.pushurl`, plant: set(`remote.${RECORDED}.pushurl`, "https://github.com/attacker/elsewhere.git") },
    { key: "remote.toolroll-release.url", plant: set("remote.toolroll-release.url", "https://github.com/attacker/elsewhere.git") },
    { key: "url.https://github.com/attacker/.insteadof", plant: set("url.https://github.com/attacker/.insteadOf", "https://github.com/example-invalid/") },
  ];
}

/** The coordinator's adapters as `toolroll release` builds them, with only the installed-runtime and GitHub sign-in
 * looks stood in (they read this machine's services, not the checkout). */
function adapters(at: ReturnType<typeof fixture>, said: string[]): ReleaseAdapters {
  const real = releaseAdapters({ checkout: at.gate, database: at.database, say: line => said.push(line), now: () => NOW, sleep: async () => {} });
  const { release: _release, ...rest } = real;
  return {
    ...rest,
    toolroll: { ...real.toolroll, installed: async () => ({ services: ["/r/dist"], clis: [{ name: "toolroll", runtime: "/r/dist" }] }) },
    github: { ...real.github, authenticated: async () => true },
  };
}

describe("the release coordinator's Git: a poisoned gate checkout runs nothing", () => {
  test("the repository, its owner/name and the URL come from the plane's records, never the checkout's origin", async () => {
    const at = fixture();
    git(at.gate, "remote", "add", "origin", "https://github.com/attacker/elsewhere.git");
    const repo = recordedReleaseRepo(at.database, at.gate);
    expect(repo).toMatchObject({ remote: RECORDED, slug: "example-invalid/gate", ssh: false, gitDir: join(at.gate, ".git") });
    const made = adapters(at, []);
    expect(await made.repo.github()).toBe("example-invalid/gate");
    // A clean checkout passes the check, and the hardened runner reads its objects.
    expect(await made.repo.tree(at.head)).toMatch(/^[0-9a-f]{40}$/);
    expect(await made.repo.fileAt(at.head, "package.json")).toContain("1.2.3");
    // A checkout the plane doesn't record is refused, naming why.
    const other = repository(join(at.root, "other"));
    expect(() => recordedReleaseRepo(at.database, other)).toThrow(/isn't one of the projects Toolroll records/);
    await expect(releaseAdapters({ checkout: other, database: at.database }).repo.tree(at.head)).rejects.toThrow(/isn't one of the projects Toolroll records/);
  });

  test("a recorded remote is read strictly: GitHub over https or ssh, nothing else", () => {
    expect(releaseRemote("https://github.com/ap9000/toolroll.git")).toEqual({ slug: "ap9000/toolroll", ssh: false });
    expect(releaseRemote("git@github.com:ap9000/toolroll.git")).toEqual({ slug: "ap9000/toolroll", ssh: true });
    for (const url of ["ext::sh -c touch% /tmp/x github.com/a/b", "file:///tmp/x", "https://github.com.evil.example/a/b", "https://user:secret@github.com/a/b", "https://github.com/../b"]) expect(releaseRemote(url), url).toBeNull();
  });

  test.each(["include.path", "core.sshcommand", "core.fsmonitor", "core.hookspath", "remote.origin.url", "remote.origin.vcs", "credential.helper",
    "http.proxy", "http.sslverify", "http.extraheader", "http.cookiefile", "remote.origin.proxy", `remote.${RECORDED}.url`, `remote.${RECORDED}.pushurl`,
    "remote.toolroll-release.url", "url.https://github.com/attacker/.insteadof"])("%s: preflight and resume stop naming it, and the marker never runs", async key => {
    const at = fixture();
    poisons(at).find(one => one.key === key)!.plant();
    // Preflight (begin): the first Git command refuses.
    const first = await runRelease({ branch: "release-1.2.3", checkout: at.gate, stateDir: at.state }, adapters(at, []));
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.message).toContain(key === "include.path" ? "includes another file" : key);
    // Resume: a journal already past preflight; every Git look the coordinator makes refuses the same way.
    const journal = join(at.state, "resume");
    mkdirSync(join(journal, "releases"), { recursive: true });
    writeJournal(journalFile(journal, "release-1.2.3"), {
      version: 1, id: "00000000-0000-4000-8000-000000000000", github: "example-invalid/gate", checkout: at.gate, branch: "release-1.2.3", candidate: { sha: at.head, tree: at.head },
      packageName: "gate", packageVersion: "1.2.3", tag: "v1.2.3", pr: 7, step: "gate", task: { id: "release-1.2.3", scopeDigest: null }, approval: null, check: null, completion: null,
      deploy: null, ci: null, merge: null, tagged: null, published: null, homebrew: null, intents: {}, stopped: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    } as Parameters<typeof writeJournal>[1]);
    const made = adapters(at, []);
    const resumed = await runRelease({ branch: "release-1.2.3", checkout: at.gate, stateDir: journal }, made);
    expect(resumed.ok).toBe(false);
    if (!resumed.ok) expect(resumed.message).toMatch(/won't run Git/);
    for (const look of [() => made.repo.remoteHead("release-1.2.3"), () => made.repo.sync("release-1.2.3"), () => made.repo.tree(at.head), () => made.repo.deleteBranch("release-1.2.3", at.head)]) {
      await expect(look()).rejects.toThrow(/won't run Git/);
    }
    expect(existsSync(at.ran), `the marker ran for ${key}`).toBe(false);
  });

  test.each(["after-audit", "during-backoff"])("a config planted %s cannot change a retried Git command", async when => {
    const at = fixture();
    let poisoned = false, looks = 0;
    let destination: string | null = null;
    const plant = () => {
      if (poisoned) return;
      poisoned = true;
      git(at.gate, "config", "--local", "url.https://github.com/attacker/other.git.insteadOf", RECORDED);
    };
    const made = releaseAdapters({ checkout: at.gate, database: at.database, say: () => {}, now: () => NOW,
      sleep: async () => { if (when === "during-backoff") plant(); },
      run: async (command, args, options) => {
        if (args.includes("config")) {
          const out = await exec(command, args, options);
          if (when === "after-audit") plant();
          return out;
        }
        if (args.includes("ls-remote")) {
          looks++;
          if (when === "during-backoff" && looks === 1) return { code: 128, stdout: "", stderr: "Connection reset" };
          // Real Git resolves the destination, without contacting any remote or using credentials.
          const out = await exec(command, args.flatMap(arg => arg === "ls-remote" ? [arg, "--get-url"] : [arg]), options);
          if (out.code !== 0) return out;
          destination = out.stdout.trim();
          return { code: 128, stdout: "", stderr: "offline test read ended" };
        }
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    });
    await expect(made.repo.remoteHead("release-1.2.3")).rejects.toThrow();
    expect(poisoned).toBe(true);
    expect(destination).toBe(when === "after-audit" ? RECORDED : null);
    expect(looks).toBe(1);
  });

  test("the private view's config parser also uses the pinned Git executable", async () => {
    const at = fixture();
    const bin = join(at.root, "bin");
    const fakeGit = write(join(bin, "git"), `#!/bin/sh\necho ran > '${at.ran}'\nexit 0\n`);
    chmodSync(fakeGit, 0o755);
    vi.stubEnv("PATH", bin);
    try {
      const made = releaseAdapters({ checkout: at.gate, database: at.database,
        tools: { git: "/usr/bin/git", gh: "/bin/false", ssh: "/usr/bin/ssh" } });
      expect(await made.repo.tree(at.head)).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(at.ran)).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });

  test("waiting for the shared Git view respects the caller's lock budget", async () => {
    const at = fixture();
    const unlock = await lockCheckout(homedir(), at.gate);
    vi.useFakeTimers();
    let spawned = false;
    try {
      const pending = teardownGit(async () => {
        spawned = true;
        return { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
      }, { repo: at.gate }, 1)(at.gate, ["ls-remote", RECORDED]);
      await vi.advanceTimersByTimeAsync(25);
      expect(refusal(await pending)).toMatch(/still running/);
      expect(spawned).toBe(false);
    } finally { unlock(); vi.useRealTimers(); }
  });

  test("the setting check is an allowlist: only local and worktree scope count, and anything else is named", () => {
    const listing = (scope: string, key: string, value: string) => `${scope}\0${key}\n${value}\0`;
    expect(releaseConfigProblem(listing("local", "remote.origin.url", RECORDED))).toBeNull();
    expect(releaseConfigProblem(listing("local", "core.hookspath", "/x"))).toBe("core.hookspath");
    expect(releaseConfigProblem(listing("local", "url.https://evil.example/.insteadof", "https://github.com/"))).toBe("url.https://evil.example/.insteadof");
    expect(releaseConfigProblem(listing("local", "remote.origin.pushurl", "fd::3"))).toBe("remote.origin.pushurl");
    expect(releaseConfigProblem(listing("worktree", "core.sshcommand", "x"))).toBe("core.sshcommand");
    expect(releaseConfigProblem(listing("global", "core.sshcommand", "x"))).toBeNull();
    expect(releaseConfigProblem(listing("local", "branch.main.remote", "origin") + listing("local", "core.bare", "false") + listing("worktree", "core.fsmonitor", "false"))).toBeNull();
    expect(releaseConfigProblem(listing("local", "gc.something-new", "x"))).toBe("gc.something-new");
  });
});

