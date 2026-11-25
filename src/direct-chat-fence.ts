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
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fenceFor, FENCE_POLICY_CURRENT, linuxFenceAvailable, macosFenceAvailable, runFolders, taskBoundary, type LaunchFence } from "./agent-fence.js";
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

/** Every entry of `folder` but `own`, as real paths (another chat's clone or Git folder). */
function others(folder: string, own: string): string[] {
  let names: string[] = [];
  try { names = readdirSync(folder); } catch { return []; }
  return names.map(name => join(folder, name)).flatMap(path => { try { const real = realpathSync(path); return real === own ? [] : [real]; } catch { return []; } });
}

export function directChatFence(store: Store): DirectChatFenceFn {
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
    const chats = join(input.stateRoot, "direct-chat");
    let chatEntries: string[] = [];
    try { chatEntries = readdirSync(chats); } catch { chatEntries = []; }
    // Everything of Direct Chat's but this chat's clone and Git folder: other chats', their turn logs, the trash.
    const chatDenies = [
      ...others(join(chats, "clones"), clone), ...others(join(chats, "gitdirs"), gitDir),
      ...chatEntries.filter(name => name !== "clones" && name !== "gitdirs").map(name => join(chats, name)),
    ];
    const policy = resolveNetwork("claude", store.projectNetwork(input.repo), repositoryEcosystems(input.repo));
    let proxy: EgressProxy;
    try { proxy = await startEgressProxy(policy.mode === "open" ? { hosts: [], open: true } : { hosts: policy.hosts }); }
    catch { return { problem: "The chat's network proxy couldn't be started, so nothing was started." }; }
    const temp = realpathSync(mkdtempSync(join(tmpdir(), "so-net-")));
    let closed: Promise<void> | null = null;
    const close = (): Promise<void> => closed ??= (async () => { rmSync(temp, { recursive: true, force: true }); await proxy.close(); })();
    try {
      const poolRoots = [join(dirname(databaseFile), "worktrees"), ...store.listWorktrees().map(record => poolRootOf(record.path, record.repo))];
      const boundary = taskBoundary({ worktree: clone, provider: "claude", binding: null, policy: FENCE_POLICY_CURRENT, storage });
      const launch = fenceFor("build", {
        databaseFile, worktree: clone, boundary, binding: null, runFolders: runFolders(temp), poolRoots, storage, policy: FENCE_POLICY_CURRENT, provider: "claude",
        // The project's own checkout (the chat works on its clone), and the project's read denies, read live.
        extra: [repo, ...chatDenies],
        readDeny: store.projectSandbox(input.repo).readDeny.map(one => readDenyPath(one, homedir())),
        network: { mode: "allowlist", proxyPort: proxy.port, brokerPorts: [], loopback: policy.loopback, socketRoots: [clone, temp], token: proxy.secret },
      });
      return { launch, temp, env: { ...proxyEnv(proxy, policy.loopback), TMPDIR: temp, TMP: temp, TEMP: temp, CLAUDE_CODE_TMPDIR: temp }, close };
    } catch (error) {
      await close();
      return { problem: `The chat's fence couldn't be made, so nothing was started: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
}
