/**
 * The Agents page's installation parts (UI revamp wave B): the computers that build (what /fleet showed), which model
 * runs each phase and the rest of what /system showed. Saved facts only, filtered through the caller's `visible`, for
 * a person with access to the whole installation; nothing here grants an act (register, retire, move and note keep
 * their own handlers and checks).
 */
import { INSTALLATION_SCOPE, resolvePhaseAgent } from "../agentconfig.js";
import type { BrowserAgentPhase, BrowserAgentsSystem, BrowserComputers } from "../browser-workspace.js";
import { agentModelName } from "../model-names.js";
import { projectName } from "../project.js";
import { isAlive } from "../runner.js";
import type { Store, WorktreeRow } from "../store.js";
import { taskHref } from "./http.js";

/** Every registered computer that isn't retired, plus a retired one still holding reserved work, as Agents lists it. */
export function computersOf(store: Store, now: Date, visible: (repo: string | null) => boolean, manage: boolean): BrowserComputers {
  const queued = store.fleetQueue(now);
  const claims = store.liveClaims(null, now);
  const owned = new Set(queued.map(one => one.assignedRunner).filter((one): one is string => one !== null));
  const runners = store.listRunners().filter(one => one.retiredAt === null || owned.has(one.name));
  const list = runners.map(runner => {
    const live = claims.filter(claim => claim.runner === runner.name);
    const shown = live.filter(claim => visible(claim.repo ?? null));
    const alive = isAlive(runner, now);
    return {
      name: runner.name, host: runner.host, capacity: runner.capacity, retired: runner.retiredAt !== null,
      state: !alive ? "offline" as const : live.length > 0 ? "building" as const : "idle" as const,
      building: shown.map(claim => ({ taskId: claim.taskId, title: store.getTask(claim.taskId)?.title ?? claim.taskId, href: taskHref(claim.taskId),
        project: claim.repo == null ? null : projectName(claim.repo) })),
      hidden: live.length - shown.length,
      heardAt: runner.heartbeatAt, registeredAt: runner.registeredAt,
      projects: runner.repos.filter(repo => visible(repo)).map(repo => projectName(repo)),
      note: runner.queueNote ?? null,
      reserved: queued.filter(one => one.assignedRunner === runner.name && visible(one.repo))
        .map(one => ({ id: one.id, title: one.title, href: taskHref(one.id), project: one.repo === null ? null : projectName(one.repo), taken: one.taken })),
    };
  });
  return { list, manage, queueRevision: store.queueRevision(), shared: queued.filter(one => one.assignedRunner === null && visible(one.repo)).length };
}

const PHASES = ["plan", "build", "repair", "review"] as const;

/** Which provider and model runs each phase for the open project (or the installation), and where that choice comes from. */
export function phasesOf(store: Store, project: string | null): BrowserAgentPhase[] {
  return PHASES.map(phase => {
    const answer = resolvePhaseAgent(store, phase, project, {});
    const row = (project === null ? null : store.phaseConfig(project, phase)) ?? store.phaseConfig(INSTALLATION_SCOPE, phase);
    const by = row?.updatedBy == null ? "" : ` by ${row.updatedBy}`;
    if (!answer.ok) return { phase, model: null, problem: answer.problem, source: "", noDollars: false };
    const source = answer.source === "project" ? `Chosen for this project${by}`
      : answer.source === "installation" ? `Set for the whole installation${by}` : "The default: nothing chosen";
    return { phase, model: agentModelName(answer.spec.provider, answer.spec.model ?? null), problem: null, source, noDollars: answer.spec.provider !== "claude" };
  });
}

/** The rest of what /system showed: its workspaces, the background service on the open project, notifications waiting
 * to go out and external work. */
export function systemOf(store: Store, project: string | null, worktreeShown: (tree: WorktreeRow) => boolean, visible: (repo: string | null) => boolean): BrowserAgentsSystem {
  const workspaces = store.listWorktrees().filter(worktreeShown).map(tree => {
    const leased = tree.leasedAt !== null && tree.releasedAt === null;
    return { name: tree.path.split("/").pop() ?? tree.path, branch: tree.branch, state: leased ? "building" as const : tree.verified ? "free" as const : "needs review" as const };
  });
  const episode = project === null ? null : store.latestWatchEpisode(project);
  const service = episode === null ? null : { running: episode.endedAt === null, at: episode.endedAt ?? episode.startedAt, built: episode.built, broke: episode.broke };
  const external = store.listGrants()
    .filter(one => one.dispatch === true && one.remoteRepo != null && visible(one.repo))
    .map(one => {
      const open = store.listNotifications("all").find(n => n.kind === "sync-failed" && n.resolvedAt === null && n.dedupeKey.startsWith(`sync:${one.remoteRepo}:`))?.subject ?? null;
      return { repo: String(one.remoteRepo), state: one.dispatchBlocked != null ? "Dispatch blocked: the tracker connection needs repair (toolroll sync says why)" : open !== null ? `Sync failing: ${open}` : "Syncing normally" };
    });
  return { workspaces, service, outbox: store.pendingForAttention().length, external };
}
