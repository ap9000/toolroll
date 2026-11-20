/**
 * Client-side live presence & task ownership hook (`GET /api/presence`).
 * Refreshes quietly on mount and whenever `WORKSPACE_NUDGE` fires; fails
 * silently in SSR, demo mode, or offline snapshots without disturbing the page.
 */
import { useEffect, useState } from "react";
import { WORKSPACE_NUDGE } from "./live-task.js";

export type TaskPresence = {
  viewers: string[];
  terminalController: string | null;
  terminalProgram: string | null;
  terminalViewers: number;
};

export type WorkspacePresence = {
  me: string;
  tasks: Record<string, TaskPresence>;
  owners: Record<string, string | null>;
  accounts: string[];
};

export type TeamFilter = "everyone" | "mine" | "team" | "unassigned";

const PROGRAM_LABEL: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  shell: "terminal",
};

export function presenceSummary(entry: TaskPresence | undefined): string | null {
  if (entry === undefined) return null;
  const parts: string[] = [];
  if (entry.terminalController !== null) {
    const prog = entry.terminalProgram ? (PROGRAM_LABEL[entry.terminalProgram] ?? entry.terminalProgram) : "terminal";
    parts.push(`${entry.terminalController} typing in ${prog}`);
  }
  if (entry.viewers.length === 1) {
    parts.push(`${entry.viewers[0]} viewing`);
  } else if (entry.viewers.length > 1) {
    parts.push(`${entry.viewers[0]} + ${entry.viewers.length - 1} viewing`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

export function matchesTeamFilter(
  taskId: string,
  filter: TeamFilter,
  presence: WorkspacePresence | null,
): boolean {
  if (filter === "everyone" || presence === null) return true;
  const owner = presence.owners[taskId] ?? null;
  if (filter === "mine") return owner === presence.me;
  if (filter === "unassigned") return owner === null;
  if (filter === "team") return owner !== null && owner !== presence.me;
  return true;
}

export function useWorkspacePresence(): WorkspacePresence | null {
  const [presence, setPresence] = useState<WorkspacePresence | null>(null);
  useEffect(() => {
    if (typeof window === "undefined" || typeof fetch !== "function") return;
    let alive = true;
    const load = () => {
      void fetch("/api/presence", { credentials: "same-origin", headers: { accept: "application/json" } })
        .then(res => res.ok ? res.json() : null)
        .then((data: unknown) => {
          if (!alive || data === null || typeof data !== "object") return;
          const obj = data as Partial<WorkspacePresence> & { ok?: boolean };
          if (obj.ok !== true || typeof obj.me !== "string") return;
          setPresence({
            me: obj.me,
            tasks: obj.tasks && typeof obj.tasks === "object" ? obj.tasks : {},
            owners: obj.owners && typeof obj.owners === "object" ? obj.owners : {},
            accounts: Array.isArray(obj.accounts) ? obj.accounts.filter((one): one is string => typeof one === "string") : [],
          });
        })
        .catch(() => { /* presence is observational only */ });
    };
    load();
    const onNudge = () => load();
    window.addEventListener(WORKSPACE_NUDGE, onNudge);
    return () => {
      alive = false;
      window.removeEventListener(WORKSPACE_NUDGE, onNudge);
    };
  }, []);
  return presence;
}
