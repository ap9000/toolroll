/** Server-rendered fragments inside the React workspace. Native forms keep
 * their exact markup, nonces and page scripts; React only places them. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert } from "./ui/index.js";
import { localizeTimes } from "../when-html.js";

let renderNoticeQueued = false;
export function notifyWorkspaceRendered() {
  if (renderNoticeQueued) return;
  renderNoticeQueued = true;
  // Native controls initialize only after the entire React commit has placed
  // every guarded fragment, including the selected result, in the document.
  queueMicrotask(() => {
    renderNoticeQueued = false;
    // Every time on the page in the viewer's own zone, by the one formatter (when-html.ts).
    localizeTimes(document);
    window.dispatchEvent(new CustomEvent("standing-orders:workspace-rendered"));
  });
}

export function regionIsEditing(region: HTMLElement): boolean {
  return region.contains(document.activeElement) && document.activeElement?.matches("input, textarea, select, [contenteditable=true]") === true
    || region.querySelector("form.approve-form, details[open] form") !== null;
}

/** Native forms own their exact nonces and feedback. React never recreates a
 * result for the same run, nor overwrites a form being edited during a read. */
export function GuardedHtml({ html, immutable = false, className = "" }: { html: string; immutable?: boolean; className?: string }) {
  const region = useRef<HTMLDivElement>(null);
  const installed = useRef<string | null>(null);
  const dirty = useRef(false);
  const [revision, setRevision] = useState(0);
  const [staleApproval, setStaleApproval] = useState(false);
  const [deferred, setDeferred] = useState(false);

  useEffect(() => {
    const node = region.current;
    const toggled = () => setRevision(value => value + 1);
    node?.addEventListener("toggle", toggled, true);
    return () => node?.removeEventListener("toggle", toggled, true);
  }, []);

  useLayoutEffect(() => {
    const node = region.current;
    if (!node || installed.current === html || (immutable && installed.current !== null)) return;
    if (installed.current !== null && (dirty.current || regionIsEditing(node))) {
      const approval = node.querySelector<HTMLElement>("[data-approval]");
      const next = new DOMParser().parseFromString(html, "text/html").querySelector<HTMLElement>("[data-approval]");
      const changed = !!node.querySelector("form.approve-form") && approval?.dataset.approval !== next?.dataset.approval;
      if (changed) {
        setStaleApproval(true);
        node.querySelectorAll<HTMLButtonElement>('form.approve-form button[type="submit"], form.approve-form input[type="submit"]').forEach(button => { button.disabled = true; });
      } else if (!node.querySelector("form.approve-form")) setDeferred(true);
      return;
    }
    const first = installed.current === null;
    node.innerHTML = html;
    installed.current = html;
    // Markup placed by innerHTML never autofocuses: on first placement, focus what asks for it (a failed Connect's alert).
    const asked = first ? node.querySelector<HTMLElement>("[autofocus]") : null;
    if (asked !== null && (document.activeElement === null || document.activeElement === document.body)) asked.focus();
    setDeferred(false);
    notifyWorkspaceRendered();
  }, [html, immutable, revision]);

  return <div className={`so-native-region ${className}`} data-workspace-native>
    {staleApproval && <Alert tone="error">The plan changed. <a href={window.location.href}>Review the current plan</a> before approving.</Alert>}
    {deferred && <p className="so-deferred" role="status">Updates are available. Your form is preserved. <a href={window.location.href}>Reload</a></p>}
    <div ref={region} onInput={() => { dirty.current = true; }} onChange={() => { dirty.current = true; }}
      onBlur={() => setRevision(value => value + 1)} />
  </div>;
}

