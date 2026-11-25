/**
 * Attack: from inside a Direct Chat turn's Claude, read Toolroll's database, another chat's clone or the project's own
 * checkout, or reach the network directly. Claude in Direct Chat used to start with no outer fence at all. Guard: each
 * Claude turn runs inside the build fence and a proxy of its own (direct-chat-fence.ts directChatFence, applied by
 * direct-chat.ts defaultSpawnTurn through exec.ts confined), its clone its own to read and write.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { fakePid } from "../fake-pid.js";
import { DirectChatHost, type DirectChatThreadRow } from "../../src/direct-chat.js";
import { directChatFence, type DirectChatTurnFence } from "../../src/direct-chat-fence.js";
import type { CustodyIO, ProcessWitness, ProcRow } from "../../src/flexible-custody.js";
import { openStore, type Store } from "../../src/store.js";
import { lines, needs, osFence, underSandbox } from "./harness.js";

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

async function world(): Promise<{ root: string; store: Store; repo: string; host: DirectChatHost; seen: Array<{ provider: string; fence: DirectChatTurnFence | undefined }>; chats: DirectChatThreadRow[] }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dc-fence-")));
  dirs.push(root);
  const repo = join(root, "project");
  mkdirSync(repo);
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  writeFileSync(join(repo, "README.md"), "# Project\n");
  execFileSync("git", ["-C", repo, "add", "README.md"], { env: gitEnv });
  execFileSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "initial"], { env: gitEnv });
  const stateRoot = join(root, "state");
  const store = openStore(join(stateRoot, "orders.db"));
  const custody = new FakeCustody();
  const seen: Array<{ provider: string; fence: DirectChatTurnFence | undefined }> = [];
  let next = 400;
  const host = new DirectChatHost(store, {
    stateRoot, custody, bootId: () => "boot-1", locateBinary: provider => `/fake/${provider}`, fenceTurn: directChatFence(store),
    spawnTurn: input => { seen.push({ provider: input.binary.split("/").pop()!, fence: input.fence }); const pid = fakePid(next++); custody.add(pid); return { pid, pgid: pid, startIdentity: "s1" }; },
  });
  const chats: DirectChatThreadRow[] = [];
  for (const [index, provider] of (["claude", "codex"] as const).entries()) {
    const made = await host.createThread({ owner: "alex", localGeneration: 1, accountGeneration: 1, requestId: String(index + 1).repeat(32), repo, provider, modelId: "", prompt: "Look around" });
    if (!made.ok) throw new Error(made.error);
    chats.push(made.thread);
  }
  return { root, store, repo, host, seen, chats };
}

describe("attack: a Direct Chat Claude turn reaching outside its chat", () => {
  test("a Claude turn starts inside its own fence and proxy; they end with the host", async () => {
    const { store, host, seen } = await world();
    try {
      expect(seen.map(one => one.provider)).toEqual(["claude", "codex"]);
      const fence = seen[0]!.fence!;
      expect(fence.launch.confinement).toBe("required");
      expect(fence.launch.fenceGrants.network).toMatchObject({ mode: "allowlist" });
      expect(fence.env["HTTPS_PROXY"]).toMatch(/^http:\/\/.*127\.0\.0\.1:\d+/);
      expect(seen[1]!.fence).toBeUndefined();
      expect(existsSync(fence.temp)).toBe(true);
      host.close();
      await host.drainPendingCleanups();
      expect(existsSync(fence.temp)).toBe(false);
    } finally { store.close(); }
  });

  test("inside the real sandbox: its clone is its own; the database, another chat's clone, the project and the open network are not", async ctx => {
    needs(ctx, osFence());
    const { root, store, repo, host, chats } = await world();
    try {
      const [mine, other] = chats as [DirectChatThreadRow, DirectChatThreadRow];
      writeFileSync(join(other.clonePath, "other-secret.txt"), "other chat secret\n");
      const made = await directChatFence(store)({ stateRoot: join(root, "state"), repo, clone: mine.clonePath, gitDir: mine.gitDir! });
      if (!("launch" in made)) throw new Error(JSON.stringify(made));
      try {
        const result = underSandbox([
          `cat README.md`,
          `touch made-by-chat.txt && echo clone-written`,
          `cat "${join(root, "state", "orders.db")}" >/dev/null 2>&1 || echo database-refused`,
          `cat "${join(other.clonePath, "other-secret.txt")}" 2>/dev/null || echo other-chat-refused`,
          `cat "${join(repo, "README.md")}" 2>/dev/null || echo project-refused`,
          `curl -s -m 5 --noproxy '*' https://1.1.1.1/ >/dev/null 2>&1 || echo direct-network-refused`,
        ].join("\n"), made.launch.fence, made.launch.fenceGrants, { cwd: mine.clonePath, env: { ...process.env, ...made.env, NODE_OPTIONS: undefined } as NodeJS.ProcessEnv });
        expect(lines(result), result.stderr).toEqual(["# Project", "clone-written", "database-refused", "other-chat-refused", "project-refused", "direct-network-refused"]);
      } finally { await made.close(); }
    } finally { host.close(); store.close(); }
  });
});
