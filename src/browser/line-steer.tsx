/** Inline steering (chat Workbench, direction B): a pin on a line of the result's diff opens a small form under that
 * line, and what is written there goes to the lead as the conversation's next message, naming the run, the file and
 * the line, and quoting it. It is an ordinary chat message: the same POST, the same queue, the same receipt.
 *
 * The diff is server HTML placed once (GuardedHtml immutable). This listens on the panel in the capture phase, so a
 * pin here opens the inline form rather than the result page's "Request changes" form, and it places the form in a
 * slot of its own after the line, never rewriting the diff's markup. */
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

/** Bounds on what a steer may carry; the message itself is bounded again by the conversation's own limit. */
export const STEER_LIMITS = { path: 300, code: 240, note: 1500 } as const;

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The chat message a steer sends: where, which run, the note, and the line it is about. The file name is written as a
 * JSON string and the quoted line always closes the message (empty when the line is blank), so a reader (the thread's
 * steerCommentHtml) can take the reference and the quote back without guessing where a file name or a note ends. */
export function steerMessage(input: { run: number; path: string; line: number; side: "new" | "old"; code: string; note: string }): string {
  const where = `${JSON.stringify(oneLine(input.path, STEER_LIMITS.path))}:${input.line}${input.side === "old" ? " (removed line)" : ""}`;
  const code = oneLine(input.code, STEER_LIMITS.code);
  const note = input.note.trim().slice(0, STEER_LIMITS.note);
  return `On ${where} (run #${input.run}): ${note}\n\n> ${code}`;
}

type Target = { slot: HTMLElement; pin: HTMLButtonElement; path: string; line: number; side: "new" | "old"; code: string };

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
  // One comment travels at a time: while it is on its way, its form holds still and the other pins wait.
  const inFlight = useRef(false);

  /** Close the form; the cursor goes back to the pin it came from. */
  const close = (current: Target | null) => {
    if (inFlight.current) return;
    current?.slot.remove();
    setTarget(null); setNote(""); setState("editing"); setProblem(null);
    if (current?.pin.isConnected) current.pin.focus();
  };

  useEffect(() => {
    const panel = host.current;
    if (!panel) return;
    // The pane's lighter diff (workspace.css: no switch, no per-file buttons) belongs only where this is installed.
    panel.setAttribute("data-line-steer", "");
    // Beside the chat, a line is there to be commented on: the diff's pins are always there (no View / Annotate switch;
    // workspace.css hides it). The result page's own script, loaded with the page, sets View on any diff it finds, so
    // Annotate is put back whenever anything changes it.
    const apply = () => panel.querySelectorAll<HTMLElement>("[data-review-diff]").forEach(review => {
      if (review.getAttribute("data-mode") !== "annotate") review.setAttribute("data-mode", "annotate");
    });
    apply();
    const keep = new MutationObserver(apply);
    keep.observe(panel, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-mode"] });
    const onClick = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      const pin = element?.closest<HTMLButtonElement>("button.pick-line");
      if (!pin || !panel.contains(pin)) return;
      const line = Number(pin.dataset.line);
      const path = pin.dataset.path ?? "";
      if (!Number.isSafeInteger(line) || line < 1 || path === "") return;
      event.preventDefault();
      event.stopPropagation();
      const row = pin.closest(".diff-line");
      if (!row || inFlight.current) return;
      setTarget(previous => {
        previous?.slot.remove();
        const slot = document.createElement("div");
        slot.className = "diff-steer-slot";
        row.after(slot);
        return { slot, pin, path, line, side: pin.dataset.side === "old" ? "old" : "new", code: rowCode(row) };
      });
      setNote(""); setState("editing"); setProblem(null);
    };
    panel.addEventListener("click", onClick, true);
    return () => { panel.removeEventListener("click", onClick, true); keep.disconnect(); panel.removeAttribute("data-line-steer"); };
  }, [host]);

  // A form that opens takes the cursor; one whose slot left the page (the result was replaced) closes.
  useEffect(() => { if (target && state === "editing") box.current?.focus(); }, [target, state]);
  // One line that grows with the words, up to about four, measured again when its width changes (a phone turning, the
  // pane resizing), so wrapped words are never cut off.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => { el.style.height = "0px"; el.style.height = `${Math.min(88, Math.max(22, el.scrollHeight))}px`; };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const watch = new ResizeObserver(() => { if (el.clientWidth !== width) { width = el.clientWidth; fit(); } });
    watch.observe(el);
    return () => watch.disconnect();
  }, [note, target, state]);
  useEffect(() => () => { target?.slot.remove(); }, [target]);
  if (target === null || !target.slot.isConnected) return null;

  const message = steerMessage({ run, path: target.path, line: target.line, side: target.side, code: target.code, note });
  const tooLong = message.length > maxChars;
  const submit = async () => {
    if (note.trim() === "" || tooLong || state !== "editing" || inFlight.current) return;
    inFlight.current = true;
    setState("sending"); setProblem(null);
    try {
      const refused = await steer(message);
      if (refused === null) {
        // The editor gives way to a one-line note; the cursor goes back to the pin it came from, not to the page.
        const hadFocus = target.slot.contains(document.activeElement);
        setState("sent");
        if (hadFocus && target.pin.isConnected) target.pin.focus();
      } else { setState("editing"); setProblem(refused); }
    } finally {
      inFlight.current = false;
    }
  };

  const empty = note.trim() === "";
  const firstWords = (text: string) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat; };
  return createPortal(state === "sent"
    // Sent: one quiet line where the comment was, until another pin opens a new one.
    ? <p className="diff-steer-sent" role="status" data-steer-sent>
        <svg aria-hidden="true" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg>
        <span>Sent to the lead · {firstWords(note)}</span>
      </p>
    : <form className="diff-steer" data-diff-steer data-diff-file={target.path} data-diff-line={target.line}
        onSubmit={event => { event.preventDefault(); void submit(); }}
        onKeyDown={event => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); close(target); } }}>
        <label htmlFor={noteId} className="so-sr-only">Comment on line {target.line} of {target.path}, for the lead. Enter sends; Escape cancels.</label>
        <div className="diff-steer-row">
          <textarea ref={box} id={noteId} rows={1} maxLength={STEER_LIMITS.note} value={note} readOnly={state === "sending"} placeholder="Comment for the lead…"
            onChange={event => setNote(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
          <button type="submit" className="diff-steer-send" disabled={empty || tooLong || state === "sending"} aria-label={state === "sending" ? "Sending to the lead" : "Send to the lead"} title="Send to the lead">
            <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
          </button>
        </div>
        {(problem !== null || tooLong) && <p className="diff-steer-problem" role="alert">{tooLong ? "That's longer than one message can be. Shorten the comment." : problem}</p>}
      </form>, target.slot);
}
