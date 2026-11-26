/**
 * The outer fence a Direct Chat turn's Claude runs in (security review M3): the same agent fence and egress a build's
 * Claude gets (agent-fence.ts fenceFor "build", egress.ts), made for the chat's own clone. Toolroll's state (its
 * database, secrets, run folders, every checkout pool), the person's credentials and protected storage, the project's
 * own checkout and every other chat's clone and Git folder stay out of reach; Claude writes its clone and Git folder,
 * a temp folder of the turn's own and its own sign-in files, and reaches the network only through a proxy of the turn's
 * own that admits the project's network (its provider's hosts, its registries, the hosts the project added).
 *
 * The proxy lives as long as the turn: the host closes it when the turn settles, and when it closes. A console that
 * restarts mid-turn takes the proxy with it, so that turn loses its network (it fails; it never gains a wider one).
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fenceFor, FENCE_POLICY_CURRENT, linuxFenceAvailable, macosFenceAvailable, runFolders, taskBoundary, writeAllowlist, type LaunchFence } from "./agent-fence.js";
import { proxyEnv, repositoryEcosystems, resolveNetwork, startEgressProxy, type EgressProxy } from "./egress.js";
import { readDenyPath } from "./project-sandbox.js";
import { prepareProtectedStorage, storageRefusalOf } from "./protected-storage.js";
import type { Store } from "./store.js";
import { poolRootOf } from "./worktree.js";

/** One turn's fence: what its spawn runs in, the environment that points it at its proxy and temp folder, and how to
 * end both. */
export type DirectChatTurnFence = { launch: LaunchFence; temp: string; env: Record<string, string>; close: () => Promise<void> };
export type DirectChatFenceInput = { stateRoot: string; repo: string; clone: string; gitDir: string };
export type DirectChatFenceFn = (input: DirectChatFenceInput) => Promise<DirectChatTurnFence | { problem: string } | { unfenced: true }>;

const real = (path: string): string => { try { return realpathSync(path); } catch { return path; } };

export function directChatFence(store: Store, evidenceRoot: string | null = null): DirectChatFenceFn {
  return async input => {
    if (!macosFenceAvailable() && !linuxFenceAvailable()) {
      // As a build: unconfined only where an instance operator allowed unconfined agents.
      return store.unfencedAgentsAllowed() ? { unfenced: true }
        : { problem: "This computer can't confine the chat's agent (no macOS sandbox, no working bubblewrap), so nothing was started." };
    }
    const databaseFile = store.databaseFile();
    if (databaseFile === null || databaseFile === "" || databaseFile === ":memory:") return { problem: "Direct Chat has no state folder to fence, so nothing was started." };
    let clone: string, gitDir: string, repo: string;
    try { clone = realpathSync(input.clone); gitDir = realpathSync(input.gitDir); repo = realpathSync(input.repo); }
    catch { return { problem: "The chat's workspace couldn't be found, so nothing was started." }; }
    let storage: Awaited<ReturnType<typeof prepareProtectedStorage>>;
    try { storage = await prepareProtectedStorage(); }
    catch (error) { return { problem: storageRefusalOf(error)?.message ?? "Toolroll couldn't finish checking other apps' data, so nothing was started." }; }
    // The whole Direct Chat folder unread (every chat's clone and Git folder, now or made later, their turn logs, the
    // trash), this chat's own clone and Git folder read back inside it; nothing written but the write allowlist below.
    const chats = real(join(input.stateRoot, "direct-chat"));
    const policy = resolveNetwork("claude", store.projectNetwork(input.repo), repositoryEcosystems(input.repo));
    let proxy: EgressProxy;
    try { proxy = await startEgressProxy(policy.mode === "open" ? { hosts: [], open: true } : { hosts: policy.hosts }); }
    catch { return { problem: "The chat's network proxy couldn't be started, so nothing was started." }; }
    let temp: string | null = null;
    let closed: Promise<void> | null = null;
    // The proxy first (the agent loses its network at once), then the temp folder; each tried, and any failure said.
    const close = (): Promise<void> => closed ??= (async () => {
      const failures: string[] = [];
      try { await proxy.close(); } catch (error) { failures.push(`its network proxy didn't close (${error instanceof Error ? error.message : String(error)})`); }
      if (temp !== null) { try { rmSync(temp, { recursive: true, force: true }); } catch (error) { failures.push(`its temp folder wasn't removed (${error instanceof Error ? error.message : String(error)})`); } }
      if (failures.length > 0) throw new Error(failures.join("; "));
    })();
    try {
      temp = realpathSync(mkdtempSync(join(tmpdir(), "so-net-")));
      const home = homedir();
      const poolRoots = [join(dirname(databaseFile), "worktrees"), ...store.listWorktrees().map(record => poolRootOf(record.path, record.repo))];
      const boundary = taskBoundary({ worktree: clone, provider: "claude", binding: null, policy: FENCE_POLICY_CURRENT, storage });
      // Writes exactly as a workspace build's (writeAllowlist): the clone, the turn's own temp folder and the state
      // Claude's CLI must write; beside them the chat's own Git folder, but never its config, hooks or info.
      const allowed = writeAllowlist({ provider: "claude", home, worktree: clone, binding: null, launchFolder: temp, cache: null });
      const gitReadOnly = ["config", "hooks", "info"].map(name => join(gitDir, name));
      const made = fenceFor("build", {
        databaseFile, worktree: clone, boundary, binding: null, runFolders: runFolders(temp), poolRoots, storage, policy: FENCE_POLICY_CURRENT, provider: "claude",
        evidenceRoot,
        // The project's own checkout (the chat works on its clone), and the project's read denies, read live.
        extra: [repo, ...allowed.deny],
        readDeny: store.projectSandbox(input.repo).readDeny.map(one => readDenyPath(one, home)),
        writes: { writes: { subpaths: [...allowed.writes.subpaths, gitDir], prefixes: allowed.writes.prefixes }, readOnly: [...allowed.readOnly, ...gitReadOnly] },
        network: { mode: "allowlist", proxyPort: proxy.port, brokerPorts: [], loopback: policy.loopback, socketRoots: [clone, temp], token: proxy.secret },
      });
      const grants = { ...made.fenceGrants, readDenyOnly: [...made.fenceGrants.readDenyOnly ?? [], chats],
        readable: [...made.fenceGrants.readable, clone, gitDir], exactFiles: [...made.fenceGrants.exactFiles ?? [], clone, gitDir] };
      return { launch: { ...made, fenceGrants: grants }, temp, env: { ...proxyEnv(proxy, policy.loopback), TMPDIR: temp, TMP: temp, TEMP: temp, CLAUDE_CODE_TMPDIR: temp }, close };
    } catch (error) {
      try { await close(); } catch { /* said below: nothing was started either way */ }
      return { problem: `The chat's fence couldn't be made, so nothing was started: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
}
