/** The approve control: password, one click or nothing, by the rules. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import { useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { approvalAsk, approvalHow, termsOf, type ApprovalFacts, type ApprovalKind } from "../../design/kit.js";
import { KActs } from "./k-acts.js";
import { KButton } from "./k-button.js";
import { KInput } from "./k-field.js";
import { KNotice } from "./k-notice.js";
import { KOverlay } from "./k-overlay.js";

/**
 * The button that approves one act. It asks for the password only when the rules say so (src/design/kit.ts
 * approvalAsk): a password popover anchored to the button, one click, or no button at all when a rule approves
 * automatically. `onApprove` gets the password typed (or null) and resolves to a refusal to show, or null.
 * The approval covers exactly what was shown: pass `terms` from the snapshot you will submit, never live fields.
 * The server proves the person again when the act arrives.
 */
export function KApprove({ kind, facts, label, terms, text, primary = true, docked, onApprove, check }: {
  kind: ApprovalKind; facts: ApprovalFacts; label: string; terms: ReactNode; text?: ReactNode; primary?: boolean; docked?: boolean;
  onApprove: (password: string | null, how: ReturnType<typeof approvalHow>) => Promise<string | null>;
  /** Runs first on a press: take and validate the snapshot the approval will cover. False opens nothing and posts
   * nothing (the page says why next to its fields). */
  check?: () => boolean;
}) {
  const ask = approvalAsk(kind, facts);
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const pending = useRef(false);
  const fieldId = useId();
  const run = async (password: string | null): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setRefusal(null);
    try {
      const refused = await onApprove(password, approvalHow(kind, facts));
      setRefusal(refused);
      if (refused === null) setTrigger(null);
    } finally { pending.current = false; setBusy(false); }
  };
  if (ask === "automatic") return null;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("token");
    void run(typeof value === "string" ? value : "");
  };
  return <>
    <KButton variant={primary ? "primary" : "outline"} label={label} docked={docked === true} busy={busy && trigger === null ? "Starting…" : false}
      aria-haspopup={ask === "password" ? "dialog" : undefined}
      onClick={event => { if (pending.current || (check !== undefined && !check())) return; if (ask === "password") setTrigger(event.currentTarget); else void run(null); }} />
    {ask === "click" && refusal && <KNotice>{refusal}</KNotice>}
    {trigger && <KOverlay kind="popover" title="Confirm with your password" trigger={trigger} onClose={() => { setTrigger(null); setRefusal(null); }}>
      {text && <p>{text}</p>}
      <p className="k-pop-terms">{terms}</p>
      <form className="k-field" onSubmit={submit}>
        <label className="k-label" htmlFor={fieldId}>Your password</label>
        <KInput id={fieldId} type="password" name="token" autoComplete="current-password" required autoFocus aria-describedby={`${fieldId}-err`} aria-invalid={refusal ? true : undefined} />
        <span className="k-err" id={`${fieldId}-err`} role="alert">{refusal ?? ""}</span>
        <KActs><KButton type="submit" variant="primary" label={label} busy={busy ? "Starting…" : false} /><KButton variant="ghost" label="Cancel" data-k-close="" /></KActs>
      </form>
      <p className="k-pop-foot k-note">{termsOf(kind, { ...facts, remembered: false, passwordless: false }) === "Asks for your password." && kind === "standard"
        ? "After this, standard approvals on this computer need no password for 15 minutes." : termsOf(kind, facts)}</p>
    </KOverlay>}
  </>;
}
