import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BrowserWorkspace } from "../browser-workspace.js";
import type { LeadLiveTool } from "../lead-progress.js";
import { replyPieces } from "../reply-shape.js";
import { KDisclose } from "./kit/index.js";
import { roomName, useLiveRoom } from "./live.js";
import { Message, MessageContent } from "./ui/conversation.js";

type LiveTool = LeadLiveTool | { id: string; label: string; state: "unknown" };
/** A running reply as the chat room says it (live-reply.ts on the server): its tools per step, one status line, and the
 * partial text, already settled, checked and shaped there. `ok` is the turn's outcome once `done`. */
export type LiveReply = { steps: { tools: LiveTool[] }[]; status: string; text: string; done: boolean; ok: boolean; disconnected?: boolean };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Old snapshots have labels only. Neither later text nor turn completion
 * establishes what happened to an individual call. */
export function readLiveReply(value: unknown): LiveReply | null {
  if (!record(value) || !Array.isArray(value.steps)) return null;
  const steps = value.steps.flatMap((step: unknown, index) => {
    if (!record(step) || !Array.isArray(step.tools)) return [];
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
    return [{ tools }];
  });
  const done = value.done === true;
  return { steps, done, ok: done && value.ok === true,
    status: typeof value.status === "string" ? value.status : "", text: typeof value.text === "string" ? value.text : "" };
}

/** The chat room previews the running reply; ordinary refresh reads its saved message. A lost stream never confirms an
 * unfinished call. A reply that ends failed drops its partial text at once (the saved failure shows in its place); one
 * that answered keeps its last words until the saved message replaces them, so the swap doesn't blank. */
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
    if (event === "lost") {
      setLive(previous => previous === null ? null : { ...previous, disconnected: true });
      // Reloading: the saved turn says what became of it.
      finished.current();
      return;
    }
    if (event !== "turn") return;
    const reply = readLiveReply(data);
    if (reply === null) return;
    setLive(previous => reply.done && reply.ok && reply.text === "" && previous !== null ? { ...reply, text: previous.text } : reply);
    if (reply.done) finished.current();
  });
  return watching ? live : null;
}

/** The lead's mark: three bars (the lead chat's avatar beside its name). */
export function ChatMark() {
  return <span className="lc-mark" aria-hidden="true"><i /><i /><i /></span>;
}

/** Shaped partial text through the same pieces a saved reply is drawn from (reply-shape.ts), as React text: bold
 * anchors, inline code and labelled links; fenced code stays as written. */
function LiveText({ text, writing }: { text: string; writing: boolean }) {
  const parts: ReactNode[] = replyPieces(text).map((piece, index) =>
    piece.kind === "bold" ? <strong key={index}>{piece.text}</strong>
      : piece.kind === "code" ? <code key={index}>{piece.text}</code>
        : piece.kind === "link" ? <a key={index} href={piece.url} rel="noopener noreferrer" target="_blank">{piece.label}</a>
          : piece.text);
  return <p className="so-live-text" data-live-text>{parts}{writing && <span className="so-live-caret" aria-hidden="true" />}</p>;
}

/** The reply being written: one live status line, the partial text, and the tool steps behind a "Steps" disclosure.
 * `look="lead"` (the lead chat): the lead's own style — mark and name, plain text, three-dot status (still under reduced
 * motion); the bubble look stays for the task thread. */
export function LiveReplyBubble({ live, leadName, look = "bubble" }: { live: LiveReply | null; leadName: string; look?: "bubble" | "lead" }) {
  const steps = live?.steps ?? [];
  const active = !live?.done && !live?.disconnected;
  const tools = steps.flatMap(step => step.tools);
  // A failed reply shows no partial words; a lost connection dims them and never presents them as the answer.
  const text = live?.done && !live.ok ? "" : live?.text ?? "";
  const status = live?.disconnected ? "Connection lost — reloading" : active ? live?.status || "Thinking…" : "";
  const writing = active && text !== "" && status === "Writing…";
  const toolList = tools.length > 0 && <KDisclose summary={`Steps (${tools.length})`}>
    <ul className="so-live-steps" aria-label="Tool steps">
      {tools.map(tool => {
        const state = tool.state === "running" && !active ? "unknown" : tool.state;
        const words = state === "succeeded" ? "Done" : state === "failed" ? "Failed" : state === "running" ? "Running" : "Outcome not reported";
        return <li key={tool.id} data-state={state} data-done={state === "succeeded" ? "true" : "false"}>
          <div><span>{tool.label}</span><span className="so-tool-status"> · {words}</span>
            {tool.state === "failed" && <p className="so-tool-reason">{tool.reason}</p>}
          </div>
        </li>;
      })}
    </ul>
  </KDisclose>;
  const lost = live?.disconnected === true ? "" : undefined;
  if (look === "lead") {
    const line = status !== "" && <span className="so-working lc-thinking" role="status" data-live-status><span className="lc-dots" aria-hidden="true"><i /><i /><i /></span>{status}</span>;
    const nothingYet = tools.length === 0 && text === "";
    return <article className="lc-msg lc-lead lc-live so-live-reply" data-live-reply data-live-lost={lost} aria-label={`${leadName} is replying`}>
      <header className="lc-who"><ChatMark /><b>{leadName}</b>{nothingYet && line}</header>
      {!nothingYet && <div className="lc-body">
        {text !== "" && <LiveText text={text} writing={writing} />}
        {line}
        {toolList}
      </div>}
    </article>;
  }
  return <Message from="assistant" className="so-live-reply" data-live-reply data-live-lost={lost}>
    <div className="so-message-label">{leadName}</div>
    <MessageContent>
      {text !== "" && <LiveText text={text} writing={writing} />}
      {status !== "" && <div className="so-working" role="status" data-live-status><span className="so-live-dot" />{status}</div>}
      {toolList}
    </MessageContent>
  </Message>;
}
