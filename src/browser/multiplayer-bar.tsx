/**
 * Task-level multiplayer collaboration bar:
 * 1. "Hand off to teammate" control (shown only on multi-user workspaces) calling
 *    `POST /api/handoff/task/:task/assign-person` with CSRF + mutation key.
 * 2. Local code handoff candidate banner (shown only when `toolroll handoff push`
 *    candidates exist for the task) with a 1-click "Queue central check" promotion action.
 */
import { useEffect, useState } from "react";
import { KButton, KChip } from "./kit/index.js";
import { WORKSPACE_NUDGE } from "./live-task.js";
import { keyed } from "./mutation-key.js";
import type { WorkspacePresence } from "./presence.js";

type Candidate = {
  id: string;
  author: string;
  createdAt: string;
  baseCommit?: string | null;
  stale?: boolean;
  files: string[];
  note: string;
  patchSha256: string;
  trust: "unverified";
  promotedAt: string | null;
  promotedBy: string | null;
};

export function TaskMultiplayerBar({
  taskId,
  csrf,
  presence,
}: {
  taskId: string;
  csrf: string;
  presence: WorkspacePresence | null;
}) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [assignee, setAssignee] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || typeof fetch !== "function") return;
    let alive = true;
    const load = () => {
      void fetch(`/api/handoff/task/${encodeURIComponent(taskId)}/candidates`, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      })
        .then(res => (res.ok ? res.json() : null))
        .then((data: unknown) => {
          if (!alive || !data || typeof data !== "object") return;
          const obj = data as { ok?: boolean; candidates?: Candidate[] };
          if (obj.ok === true && Array.isArray(obj.candidates)) setCandidates(obj.candidates);
        })
        .catch(() => { /* observational */ });
    };
    load();
    window.addEventListener(WORKSPACE_NUDGE, load);
    return () => {
      alive = false;
      window.removeEventListener(WORKSPACE_NUDGE, load);
    };
  }, [taskId]);

  const teammates = presence ? presence.accounts.filter(name => name !== presence.me) : [];
  const currentOwner = presence?.owners[taskId] ?? null;

  useEffect(() => {
    if (assignee === "" && teammates.length > 0) setAssignee(teammates[0]!);
  }, [teammates.join(",")]);

  if (teammates.length === 0 && candidates.length === 0) return null;

  const handOff = async () => {
    if (busy !== null || assignee === "") return;
    setBusy("handoff");
    setNotice(null);
    try {
      const res = await fetch(`/api/handoff/task/${encodeURIComponent(taskId)}/assign-person`, {
        method: "POST",
        credentials: "same-origin",
        headers: keyed({
          "content-type": "application/json",
          "x-csrf-token": csrf,
          accept: "application/json",
        }),
        body: JSON.stringify({ person: assignee }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; message?: string; warning?: string } | null;
      if (!res.ok || !json?.ok) {
        setNotice(json?.message ?? "Could not hand off this task.");
      } else {
        setNotice(json.warning ? `Handed off to ${assignee}. Note: ${json.warning}` : `Handed off to ${assignee}.`);
        window.dispatchEvent(new CustomEvent(WORKSPACE_NUDGE));
      }
    } catch {
      setNotice("Could not reach Toolroll.");
    } finally {
      setBusy(null);
    }
  };

  const promote = async (candidateId: string) => {
    if (busy !== null) return;
    setBusy(candidateId);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/handoff/task/${encodeURIComponent(taskId)}/candidate/${encodeURIComponent(candidateId)}/promote`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: keyed({
            "content-type": "application/json",
            "x-csrf-token": csrf,
            accept: "application/json",
          }),
          body: "{}",
        },
      );
      const json = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
      if (!res.ok || !json?.ok) {
        setNotice(json?.message ?? "Could not promote local candidate.");
      } else {
        setNotice(`Queued central checks for local candidate ${candidateId}.`);
        window.dispatchEvent(new CustomEvent(WORKSPACE_NUDGE));
      }
    } catch {
      setNotice("Could not reach Toolroll.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="so-task-multiplayer"
      data-task-multiplayer=""
      style={{ display: "flex", flexDirection: "column", gap: "8px", margin: "8px 0 12px" }}
    >
      {teammates.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px",
            fontSize: "13px",
          }}
        >
          <span>
            Owner: <strong>{currentOwner ?? "Unassigned"}</strong>
          </span>
          <label htmlFor={`handoff-${taskId}`} style={{ marginLeft: "4px" }}>
            Hand off to:
          </label>
          <select
            id={`handoff-${taskId}`}
            value={assignee}
            onChange={e => setAssignee(e.target.value)}
            disabled={busy !== null}
            style={{
              padding: "3px 8px",
              borderRadius: "6px",
              border: "1px solid var(--so-line)",
              background: "transparent",
              color: "inherit",
              fontSize: "13px",
            }}
          >
            {teammates.map(name => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <KButton
            sm
            variant="ghost"
            label="Hand off"
            busy={busy === "handoff" ? "Handing off…" : false}
            onClick={() => {
              void handOff();
            }}
          />
        </div>
      )}
      {candidates.map(cand => (
        <div
          key={cand.id}
          data-handoff-candidate={cand.id}
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px",
            padding: "8px 10px",
            borderRadius: "8px",
            border: "1px solid var(--so-line)",
            fontSize: "13px",
          }}
        >
          <KChip
            word={cand.promotedAt ? "Promoted for central Run" : cand.stale ? "Stale — re-pull & rebase" : "Unverified Candidate"}
            tone={cand.promotedAt ? "live" : "needs"}
          />
          <span>
            <strong>{cand.author}</strong> submitted <code>{cand.id}</code> ({cand.files.length} file
            {cand.files.length === 1 ? "" : "s"}
            {cand.note ? ` · ${cand.note}` : ""})
          </span>
          {!cand.promotedAt && !cand.stale && (
            <KButton
              sm
              variant="primary"
              label="Promote to central Run"
              busy={busy === cand.id ? "Promoting…" : false}
              onClick={() => {
                void promote(cand.id);
              }}
            />
          )}
        </div>
      ))}
      {notice && (
        <p role="status" style={{ margin: 0, fontSize: "13px", opacity: 0.9 }}>
          {notice}
        </p>
      )}
    </div>
  );
}
