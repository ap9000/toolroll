import { useEffect, useRef, useState } from "react";
import type { BrowserWorkspace } from "../browser-workspace.js";
import type { LeadLiveTool } from "../lead-progress.js";
import { roomName, useLiveRoom } from "./live.js";
import { Message, MessageContent } from "./ui/conversation.js";

type LiveTool = LeadLiveTool | { id: string; label: string; state: "unknown" };
export type LiveReply = { steps: { tools: LiveTool[]; text: string }[]; done: boolean; disconnected?: boolean };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Old snapshots have labels only. Neither later text nor turn completion
 * establishes what happened to an individual call. */
export function readLiveReply(value: unknown): LiveReply | null {
  if (!record(value) || !Array.isArray(value.steps)) return null;
  const steps = value.steps.flatMap((step: unknown, index) => {
    if (!record(step) || !Array.isArray(step.tools) || typeof step.text !== "string") return [];
    const tools = step.tools.flatMap((label: unknown, toolIndex): LiveTool[] => {
      if (typeof label !== "string") return [];
      const call: unknown = Array.isArray(step.toolCalls) ? step.toolCalls[toolIndex] : null;
      // The extension must identify this label and a valid, explicit state.
      if (record(call) && typeof call.id === "string" && call.label === label) {
        if (call.state === "succeeded" || call.state === "running") return [{ id: call.id, label, state: call.state }];
        if (call.state === "failed" && typeof call.reason === "string" && call.reason.trim() !== "") {
          return [{ id: call.id, label, state: "failed", reason: call.reason }];
        }
      }
      return [{ id: `unknown:${index}:${toolIndex}`, label, state: "unknown" }];
    });
    return [{ tools, text: step.text }];
  });
  return { steps, done: value.done === true };
}

/** The chat room previews the running reply; ordinary refresh reads its saved
 * message. A lost stream never confirms an unfinished call. */
export function useLiveReply(chat: BrowserWorkspace["conversation"], watching: boolean, done: () => void): LiveReply | null {
  const [live, setLive] = useState<LiveReply | null>(null);
  const finished = useRef(done);
  finished.current = done;
  const following = useRef(watching);
  following.current = watching;
  useEffect(() => { setLive(null); }, [chat?.sessionId, chat?.taskId, chat?.project, watching]);
  // The conversation's room stays joined while it shows; only a reply being watched is previewed.
  useLiveRoom(chat === null ? null : roomName("chat", null, chat.taskId ? { task: chat.taskId } : { project: chat.project ?? null }), (event, data) => {
    if (!following.current) return;
    if (event === "lost") { setLive(previous => previous === null ? null : { ...previous, disconnected: true }); return; }
    if (event !== "turn") return;
    const reply = readLiveReply(data);
    if (reply === null) return;
    setLive(reply);
    if (reply.done) finished.current();
  });
  return watching ? live : null;
}

export function LiveReplyBubble({ live, leadName }: { live: LiveReply | null; leadName: string }) {
  const steps = live?.steps ?? [];
  const active = !live?.done && !live?.disconnected;
  const tools = steps.flatMap(step => step.tools);
  const text = [...steps].reverse().find(step => step.text.trim() !== "")?.text ?? "";
  const writing = active && steps.length > 0 && steps.at(-1)!.text.trim() !== "";
  return <Message from="assistant" className="so-live-reply" data-live-reply>
    <div className="so-message-label">{leadName}</div>
    <MessageContent>
      {tools.length > 0 && <ul className="so-live-steps" aria-label="Tool steps">
        {tools.map(tool => {
          const state = tool.state === "running" && !active ? "unknown" : tool.state;
          const status = state === "succeeded" ? "Done" : state === "failed" ? "Failed" : state === "running" ? "Running" : "Outcome not reported";
          return <li key={tool.id} data-state={state} data-done={state === "succeeded" ? "true" : "false"}>
            <div><span>{tool.label}</span><span className="so-tool-status"> · {status}</span>
              {tool.state === "failed" && <p className="so-tool-reason">{tool.reason}</p>}
            </div>
          </li>;
        })}
      </ul>}
      {text !== "" && <p className="so-live-text">{text}{writing && <span className="so-live-caret" aria-hidden="true" />}</p>}
      {active && (writing || !tools.some(tool => tool.state === "running")) && <div className="so-working" role="status"><span className="so-live-dot" />{writing ? "Writing…" : "Thinking…"}</div>}
    </MessageContent>
  </Message>;
}
