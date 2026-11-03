/** The message box: auto-grow, + menu, project chip, send and Stop. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import { useEffect, useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import { composerSync, composerWorking, installKitBehavior, isPhone, openMenu } from "./behavior.js";
import { cn } from "./utils.js";
import { KIcon } from "./k-icon.js";

/**
 * The message box (KIT.md "Composer and chat"): one soft rounded box, the textarea grows rows → maxRows then
 * scrolls, one bottom row inside (+ menu, project chip, small controls, the round send ↔ Stop). `gate` marks the
 * send aria-disabled while empty (a message box); a form's send stays pressable so an empty press can say what's
 * missing. A refused send keeps the words; show the reason with `error`.
 */
export function KComposer({ id, label, placeholder, value, onChange, onSend, onStop, working = false, rows = 1, maxRows = 8, project, onProject, attach, mentions, before, note, error, disabled, line, gate = true, sendLabel = "Send", stopLabel = "Stop" }: {
  id: string; label: string; placeholder?: string; value: string; onChange: (value: string) => void; onSend: () => void; onStop?: () => void; working?: boolean;
  rows?: number; maxRows?: number; project?: { current: string; items: readonly string[] }; onProject?: (name: string) => void;
  attach?: (file: File) => void; mentions?: ReadonlyArray<{ label: string; text: string }>; before?: ReactNode; note?: ReactNode; error?: string | null;
  disabled?: boolean; line?: boolean; gate?: boolean; sendLabel?: string; stopLabel?: string;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const empty = value.trim() === "";
  useEffect(() => { installKitBehavior(); }, []);
  useLayoutEffect(() => { if (textarea.current) composerSync(textarea.current); }, [value]);
  useEffect(() => { composerWorking(id, working); }, [id, working]);
  const insert = (text: string) => {
    const node = textarea.current;
    const at = node?.selectionStart ?? value.length;
    const pad = at > 0 && !/\s$/.test(value.slice(0, at)) ? " " : "";
    onChange(value.slice(0, at) + pad + text + " " + value.slice(at));
    node?.focus();
  };
  const chooseProject = (trigger: HTMLElement) => {
    if (!project) return;
    openMenu(trigger, "Project", project.items.map(name => ({ label: name, current: name === project.current, act: () => onProject?.(name) })));
  };
  const plusItems = [
    ...(attach ? [{ label: "Attach a file", act: () => file.current?.click() }] : []),
    ...(mentions && mentions.length > 0 ? [{ label: "Mention a task", act: () => {
      const node = chip.current ?? textarea.current;
      if (node) openMenu(node, "Mention a task", mentions.map(item => ({ label: item.label, act: () => insert(item.text) })));
    } }] : []),
    ...(project ? [{ label: "Choose project", act: () => { const node = chip.current; if (node) chooseProject(node); } }] : []),
  ];
  const send = () => { if (gate && empty) return; onSend(); };
  return <div className={cn("k-composer", line && "line", disabled && "off", !empty && "has-text", working && "working")} data-k-composer={id}>
    <label className="k-sr" htmlFor={`${id}-text`}>{label}</label>
    <div className="k-composer-files" data-k-files={id} />
    <textarea ref={textarea} className="k-composer-ta" id={`${id}-text`} rows={rows} data-min={rows} data-max={maxRows} placeholder={placeholder} value={value} disabled={disabled}
      aria-invalid={error ? true : undefined} aria-describedby={`${id}-err`} onChange={event => onChange(event.target.value)}
      onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !isPhone()) { event.preventDefault(); send(); } }} />
    <div className="k-composer-bar">
      {plusItems.length > 0 && <button type="button" className="k-composer-plus" aria-haspopup="dialog" aria-label="Add to your message" disabled={disabled}
        onClick={event => openMenu(event.currentTarget, "Add to your message", plusItems)}><KIcon name="plus" /></button>}
      {attach && <input ref={file} type="file" className="k-sr" tabIndex={-1} aria-hidden="true" onChange={event => { const one = event.target.files?.[0]; if (one) attach(one); event.target.value = ""; }} />}
      {project && <button ref={chip} type="button" className="k-composer-chip" aria-haspopup="dialog" aria-label={`Project: ${project.current}. Change`} disabled={disabled}
        onClick={event => chooseProject(event.currentTarget)}><span>{project.current}</span><KIcon name="chevron" small /></button>}
      {before}
      <span className="k-grow" />
      <span className="k-send-slot">
        <button type="button" className="k-send" aria-label={sendLabel} title={sendLabel} data-gate={gate ? "1" : undefined} aria-disabled={gate && empty ? true : undefined} disabled={disabled} onClick={send}><KIcon name="send" /></button>
        {onStop && <button type="button" className="k-send k-stop" aria-label={stopLabel} title={stopLabel} onClick={onStop}><KIcon name="stop" /></button>}
      </span>
    </div>
    {note && <p className="k-note k-composer-note">{note}</p>}
    <div className="k-composer-err k-err" id={`${id}-err`} role="alert">{error ?? ""}</div>
  </div>;
}
