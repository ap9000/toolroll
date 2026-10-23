/** Inline steering (chat Workbench, direction B): a pin on a line of the result's diff opens a small form under that
 * line, and what is written there goes to the lead as the conversation's next message, naming the run, the file and
 * the line, and quoting it. It is an ordinary chat message: the same POST, the same queue, the same receipt.
 *
 * The diff is server HTML placed once (GuardedHtml immutable). This listens on the panel in the capture phase, so a
 * pin here opens the inline form rather than the result page's "Request changes" form, and it places the form in a
 * slot of its own after the line, never rewriting the diff's markup. */
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Button } from "./components/ui/index.js";

/** Bounds on what a steer may carry; the message itself is bounded again by the conversation's own limit. */
export const STEER_LIMITS = { path: 300, code: 240, note: 1500 } as const;

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The chat message a steer sends: where, which run, the note, and the line it is about. */
export function steerMessage(input: { run: number; path: string; line: number; side: "new" | "old"; code: string; note: string }): string {
  const where = `${oneLine(input.path, STEER_LIMITS.path)}:${input.line}${input.side === "old" ? " (removed line)" : ""}`;
  const code = oneLine(input.code, STEER_LIMITS.code);
  const note = input.note.trim().slice(0, STEER_LIMITS.note);
  return `On ${where} (run #${input.run}): ${note}${code === "" ? "" : `\n\n> ${code}`}`;
}

type Target = { slot: HTMLElement; path: string; line: number; side: "new" | "old"; code: string };

/** The words of a diff row, without its +/− marker. */
function rowCode(row: Element | null): string {
  const code = row?.querySelector("code");
  if (!code) return "";
  const marker = code.querySelector("b");
  return (code.textContent ?? "").slice(marker?.textContent?.length ?? 0);
}

export function LineSteer({ host, run, maxChars, steer }: {
  host: RefObject<HTMLElement | null>;
  run: number;
  maxChars: number;
  /** Sends the message; resolves to null when it went (or was queued), else the reason in words. */
  steer: (text: string) => Promise<string | null>;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  const [note, setNote] = useState("");
  const [state, setState] = useState<"editing" | "sending" | "sent">("editing");
  const [problem, setProblem] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const noteId = useId();

  const close = (current: Target | null) => {
    current?.slot.remove();
    setTarget(null); setNote(""); setState("editing"); setProblem(null);
  };

  useEffect(() => {
    const panel = host.current;
    if (!panel) return;
    // Beside the chat, a line is there to be commented on: the diff opens with its pins showing.
    panel.querySelectorAll<HTMLElement>("[data-review-diff]").forEach(review => {
      review.setAttribute("data-mode", "annotate");
      review.querySelectorAll<HTMLButtonElement>("button[data-diff-mode]").forEach(one => one.setAttribute("aria-pressed", String(one.dataset.diffMode === "annotate")));
    });
    const onClick = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      // The diff's View / Annotate switch, kept working on markup React placed.
      const mode = element?.closest<HTMLButtonElement>("button[data-diff-mode]");
      if (mode && panel.contains(mode)) {
        const review = mode.closest<HTMLElement>("[data-review-diff]");
        const value = mode.dataset.diffMode === "annotate" ? "annotate" : "view";
        review?.setAttribute("data-mode", value);
        review?.querySelectorAll<HTMLButtonElement>("button[data-diff-mode]").forEach(one => one.setAttribute("aria-pressed", String(one === mode)));
        return;
      }
      const pin = element?.closest<HTMLButtonElement>("button.pick-line");
      if (!pin || !panel.contains(pin)) return;
      const line = Number(pin.dataset.line);
      const path = pin.dataset.path ?? "";
      if (!Number.isSafeInteger(line) || line < 1 || path === "") return;
      event.preventDefault();
      event.stopPropagation();
      const row = pin.closest(".diff-line");
      if (!row) return;
      setTarget(previous => {
        previous?.slot.remove();
        const slot = document.createElement("div");
        slot.className = "diff-steer-slot";
        row.after(slot);
        return { slot, path, line, side: pin.dataset.side === "old" ? "old" : "new", code: rowCode(row) };
      });
      setNote(""); setState("editing"); setProblem(null);
    };
    panel.addEventListener("click", onClick, true);
    return () => panel.removeEventListener("click", onClick, true);
  }, [host]);

  // A form that opens takes the cursor; one whose slot left the page (the result was replaced) closes.
  useEffect(() => { if (target && state === "editing") box.current?.focus(); }, [target, state]);
  useEffect(() => () => { target?.slot.remove(); }, [target]);
  if (target === null || !target.slot.isConnected) return null;

  const message = steerMessage({ run, path: target.path, line: target.line, side: target.side, code: target.code, note });
  const tooLong = message.length > maxChars;
  const submit = async () => {
    if (note.trim() === "" || tooLong || state !== "editing") return;
    setState("sending"); setProblem(null);
    const refused = await steer(message);
    if (refused === null) setState("sent");
    else { setState("editing"); setProblem(refused); }
  };

  return createPortal(state === "sent"
    ? <div className="diff-steer diff-steer--sent" role="status" data-steer-sent>
        <span>Sent to the lead as its next step.</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => close(target)}>Close</Button>
      </div>
    : <form className="diff-steer" data-diff-steer data-diff-file={target.path} data-diff-line={target.line}
        onSubmit={event => { event.preventDefault(); void submit(); }}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); close(target); } }}>
        <label htmlFor={noteId}>Comment on line {target.line} — the lead takes it as its next step</label>
        <textarea ref={box} id={noteId} rows={2} maxLength={STEER_LIMITS.note} value={note} onChange={event => setNote(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); } }} />
        {(problem !== null || tooLong) && <p className="diff-steer-problem" role="alert">{tooLong ? "That's longer than one message can be. Shorten the comment." : problem}</p>}
        <div className="diff-steer-actions">
          <Button type="submit" size="sm" disabled={note.trim() === "" || tooLong || state === "sending"}>{state === "sending" ? "Sending…" : "Send to the lead"}</Button>
          <Button type="button" variant="outline" size="sm" onClick={() => close(target)}>Cancel</Button>
        </div>
      </form>, target.slot);
}
