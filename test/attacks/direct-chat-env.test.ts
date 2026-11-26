/**
 * Attack: read the server's secrets from inside a Direct Chat. The chat's agent (and every command it runs) used to
 * start with Toolroll's whole environment minus a short denylist, so a provider API key, a database URL or any token
 * the server was started with reached it. Guard: an allowlisted environment (direct-chat.ts buildSanitizedChildEnv,
 * over the plain settings every agent launch keeps, agent-fence.ts plainAgentEnv): home and temp, and where the
 * provider's own CLI keeps its sign-in; nothing else.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { fakePid } from "../fake-pid.js";
import { buildSanitizedChildEnv, DIRECT_CHAT_PROVIDERS, DirectChatHost, type DirectChatProvider } from "../../src/direct-chat.js";
import type { CustodyIO, ProcessWitness, ProcRow } from "../../src/flexible-custody.js";
import { openStore } from "../../src/store.js";

/** Secrets a server is commonly started with: provider keys, tokens, Toolroll's own settings, a database address. */
const SECRETS: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-planted", OPENAI_API_KEY: "sk-planted", GEMINI_API_KEY: "gem-planted", OPENROUTER_API_KEY: "or-planted",
  GH_TOKEN: "ghp_planted", GITHUB_TOKEN: "gho_planted", AWS_SECRET_ACCESS_KEY: "aws-planted", DATABASE_URL: "postgres://u:p@db/x",
  TOOLROLL_SESSION_SECRET: "tr-planted", STRIPE_SECRET_KEY: "sk_live_planted", SSH_AUTH_SOCK: "/tmp/agent.sock", NODE_OPTIONS: "--require /tmp/x.js",
  GIT_CONFIG_PARAMETERS: "'core.hookspath'='/tmp/hooks'", SOME_CUSTOM_SECRET: "custom-planted",
};
const ALLOWED = new Set(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TERM", "TZ", "USER", "LOGNAME", "SHELL", "COLORTERM",
  "HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GIT_TERMINAL_PROMPT"]);
/** What a launched turn adds: its commit identity (git-identity.ts), never a secret. */
const TURN_ADDS = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];

class FakeCustody implements CustodyIO {
  readonly platform: NodeJS.Platform = "darwin";
  readonly self = 1;
  readonly rows = new Map<number, ProcRow>();
  add(pid: number): void { this.rows.set(pid, { pid, ppid: 1, pgid: pid, uid: 501, start: "s1", zombie: false }); }
  table(): ProcRow[] { return [...this.rows.values()]; }
  namespaceOf(): string | null { return null; }
  holdersOf(): number[] { return []; }
  signal(targets: readonly ProcessWitness[]) { for (const one of targets) this.rows.delete(one.pid); return { sent: [...targets], gone: [], mismatched: [], refused: [], unsupported: false, bestEffort: true }; }
}

const dirs: string[] = [];
afterEach(() => { for (const one of dirs.splice(0)) rmSync(one, { recursive: true, force: true }); });

describe("attack: the server's secrets reaching a Direct Chat agent", () => {
  test.each(DIRECT_CHAT_PROVIDERS)("%s: only the allowlist, whatever the server was started with", provider => {
    const env = buildSanitizedChildEnv(provider, { PATH: "/usr/bin", HOME: "/home/someone", TMPDIR: "/tmp/x", LANG: "C", CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x", ...SECRETS });
    for (const name of Object.keys(env)) expect(ALLOWED.has(name), name).toBe(true);
    for (const [name, value] of Object.entries(SECRETS)) {
      expect(env[name], name).toBeUndefined();
      expect(Object.values(env).join("\n")).not.toContain(value);
    }
    // Each CLI's own sign-in location, and only its own.
    expect(env["CLAUDE_CONFIG_DIR"]).toBe(provider === "claude" ? "/c" : undefined);
    expect(env["CODEX_HOME"]).toBe(provider === "codex" ? "/x" : undefined);
  });

  test("a launched turn gets that environment, with secrets planted in the server's own", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "dc-env-")));
    dirs.push(root);
    const repo = join(root, "project");
    mkdirSync(repo);
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
    writeFileSync(join(repo, "README.md"), "# Project\n");
    execFileSync("git", ["-C", repo, "add", "README.md"], { env: gitEnv });
    execFileSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "initial"], { env: gitEnv });
    const planted = Object.keys(SECRETS).filter(name => process.env[name] === undefined);
    for (const name of planted) process.env[name] = SECRETS[name];
    const store = openStore(join(root, "state.db"));
    const custody = new FakeCustody();
    const seen: Array<{ provider: DirectChatProvider; env: NodeJS.ProcessEnv }> = [];
    let next = 300;
    try {
      for (const provider of DIRECT_CHAT_PROVIDERS) {
        const host = new DirectChatHost(store, {
          stateRoot: join(root, `state-${provider}`), custody, bootId: () => "boot-1", locateBinary: () => `/fake/${provider}`,
          spawnTurn: input => { seen.push({ provider, env: input.env }); const pid = fakePid(next++); custody.add(pid); return { pid, pgid: pid, startIdentity: "s1" }; },
        });
        const made = await host.createThread({ owner: "alex", localGeneration: 1, accountGeneration: 1, requestId: String(DIRECT_CHAT_PROVIDERS.indexOf(provider) + 1).repeat(32), repo, provider, modelId: "", prompt: "Look around" });
        expect(made.ok, `${provider}: ${made.ok ? "" : JSON.stringify(made)}`).toBe(true);
      }
    } finally {
      for (const name of planted) delete process.env[name];
      store.close();
    }
    expect(seen.map(one => one.provider)).toEqual([...DIRECT_CHAT_PROVIDERS]);
    for (const { provider, env } of seen) {
      for (const name of Object.keys(env)) expect(ALLOWED.has(name) || TURN_ADDS.includes(name), `${provider}: ${name}`).toBe(true);
      for (const value of Object.values(SECRETS)) expect(Object.values(env).join("\n"), provider).not.toContain(value);
      // The project names no identity: the neutral one, for author and committer alike.
      expect([env["GIT_AUTHOR_EMAIL"], env["GIT_COMMITTER_EMAIL"]], provider).toEqual(["direct-chat@toolroll.local", "direct-chat@toolroll.local"]);
    }
  });
});
