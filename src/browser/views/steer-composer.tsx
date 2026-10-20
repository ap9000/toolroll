/**
 * The steering composer's shared parts (docs/plans/agents-cockpit.md §4), for every live view of a running attempt —
 * the Agents board, a task page, a flow card's task: one plain sentence for what the attempt takes, Pause / Resume and
 * Stop for the exact run each names, and a note box with its draft kept per attempt in this tab (a refused send loses
 * nothing; only that draft's own successful send — the page coming back with its key — clears it).
 */
import { useState } from "react";
import type { BrowserAgentControls } from "../../browser-workspace.js";
import { Button, Textarea } from "../components/ui/index.js";
import { PostForm } from "../ui/index.js";

export type SteerDraft = { text: string; key: string; submitted: boolean };
const draftStore = (run: number) => `toolroll:steer-draft:${run}`;
export function freshDraft(): SteerDraft {
  const key = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  return { text: "", key, submitted: false };
}
/** This run's saved draft, unless the page says that very draft was just sent. */
export function loadDraft(run: number): SteerDraft {
  try {
    const saved = JSON.parse(sessionStorage.getItem(draftStore(run)) ?? "null") as Partial<SteerDraft> | null;
    if (saved === null || typeof saved.text !== "string" || typeof saved.key !== "string") return freshDraft();
    if (new URLSearchParams(location.search).get("sent") === saved.key) { sessionStorage.removeItem(draftStore(run)); return freshDraft(); }
    return { text: saved.text, key: saved.key, submitted: saved.submitted === true };
  } catch { return freshDraft(); }
}
export function saveDraft(run: number, draft: SteerDraft): void {
  try { draft.text === "" && !draft.submitted ? sessionStorage.removeItem(draftStore(run)) : sessionStorage.setItem(draftStore(run), JSON.stringify(draft)); } catch { /* a convenience only */ }
}


/** Where a form goes back to: the Agents board, the task page, or a flow card ("flow:<flow>:<card>"). */
export type SteerBack = "agents" | "task" | `flow:${number}:${number}`;

/** What the attempt takes, said plainly, with Pause / Resume and Stop for the exact run each names. */
export function SteerControls({ controls, back }: { controls: BrowserAgentControls; back: SteerBack }) {
  const pause = controls.pause;
  return <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3 phone:px-4" data-agent-controls={controls.send ?? "none"}>
    <p className="min-w-0 flex-1 text-caption text-muted-foreground" data-agent-capability>{controls.words}</p>
    {pause !== null && (pause.state === "paused"
      ? <PostForm action={pause.action} data-agent-resume>
          <input type="hidden" name="run" value={String(pause.run)} /><input type="hidden" name="request" value={pause.requests[2]} />
          <input type="hidden" name="mode" value="resume" /><input type="hidden" name="return" value={back} />
          <Button type="submit" variant="outline" size="sm" className="h-9 phone:h-11">Resume</Button>
        </PostForm>
      : <PostForm action={pause.action} data-agent-pause>
          <input type="hidden" name="run" value={String(pause.run)} /><input type="hidden" name="request" value={pause.requests[0]} />
          <input type="hidden" name="return" value={back} />
          <Button type="submit" variant="outline" size="sm" className="h-9 phone:h-11" disabled={pause.state === "pausing"}>{pause.state === "pausing" ? "Pausing…" : "Pause"}</Button>
        </PostForm>)}
    {controls.stop !== null && <PostForm action={controls.stop.action} data-agent-stop={controls.stop.run}>
      <input type="hidden" name="run" value={String(controls.stop.run)} /><input type="hidden" name="return" value={back} />
      <Button type="submit" variant="outline" size="sm" className="h-9 phone:h-11">{controls.stop.label}</Button>
    </PostForm>}
  </div>;
}

/** The note box for a running attempt that takes notes (a task page, a flow card's task): Send, and Pause and send
 * when it takes live input and is not paused; the draft kept per attempt. */
export function SteerNote({ steer, controls, back }: { steer: { action: string; run: number }; controls: BrowserAgentControls; back: SteerBack }) {
  const [draft, setDraft] = useState<SteerDraft>(() => loadDraft(steer.run));
  const setText = (value: string) => setDraft(previous => {
    const next = previous.submitted ? { ...freshDraft(), text: value } : { ...previous, text: value };
    saveDraft(steer.run, next);
    return next;
  });
  const pauseAndSend = controls.pause !== null && controls.pause.state === null ? controls.pause : null;
  const id = `steer-note-${steer.run}`;
  return <PostForm action={steer.action} data-steer-note={steer.run}
    onSubmit={() => setDraft(previous => { const sent = { ...previous, submitted: true }; saveDraft(steer.run, sent); return sent; })}
    className="flex items-end gap-2 pt-2">
    <input type="hidden" name="return" value={back} /><input type="hidden" name="run" value={String(steer.run)} /><input type="hidden" name="key" value={draft.key} />
    {pauseAndSend !== null && <input type="hidden" name="request" value={pauseAndSend.requests[1]} />}
    <label className="sr-only" htmlFor={id}>A note for the agent</label>
    <Textarea id={id} name="note" rows={1} required maxLength={4000} value={draft.text} onChange={event => setText(event.target.value)}
      placeholder="Tell the agent something" className="min-h-11 min-w-0 flex-1 resize-none"
      onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit(); }} />
    {pauseAndSend !== null && <Button type="submit" formAction={pauseAndSend.action} variant="outline" className="h-11 w-auto shrink-0" disabled={draft.text.trim() === ""} data-steer-pause-send>Pause and send</Button>}
    <Button type="submit" className="h-11 w-auto shrink-0" disabled={draft.text.trim() === ""}>Send</Button>
  </PostForm>;
}
