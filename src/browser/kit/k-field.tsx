/** Fields: label, control, one hint line, the error tied to the control. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import { useId } from "react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./utils.js";

/** A field: label, the control (rendered with the ids it is given), one hint line, the error tied to the control. */
export function KField({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: (ids: { id: string; describedBy: string; invalid: boolean }) => ReactNode }) {
  const id = useId();
  const describedBy = cn(hint && `${id}-hint`, `${id}-err`);
  return <div className="k-field">
    <label className="k-label" htmlFor={id}>{label}</label>
    {children({ id, describedBy, invalid: !!error })}
    {hint && <p className="k-hint" id={`${id}-hint`}>{hint}</p>}
    <span className="k-err" id={`${id}-err`} role="alert">{error ?? ""}</span>
  </div>;
}

export const KInput = ({ className, ...props }: ComponentProps<"input">) => <input className={cn("k-input", className)} {...props} />;

export const KTextarea = ({ className, ...props }: ComponentProps<"textarea">) => <textarea className={cn("k-textarea", className)} {...props} />;
