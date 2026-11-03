/** Switches: an on/off setting that says its state. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import type { ComponentProps } from "react";
import { cn } from "./utils.js";

/** An on/off setting that acts at once: a button[role=switch] that says its state in words. */
export function KSwitch({ label, on, onChange, words = ["On", "Off"], disabled }: { label: string; on: boolean; onChange: (on: boolean) => void; words?: readonly [string, string]; disabled?: boolean }) {
  return <button type="button" className="k-switch" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}>
    <span className="k-trk" aria-hidden="true" /><span>{on ? words[0] : words[1]}</span>
  </button>;
}

/** An on/off field in a form: a checkbox with role=switch and a visible label. */
export function KSwitchInput({ label, className, ...props }: Omit<ComponentProps<"input">, "type" | "role"> & { label: string }) {
  return <label className={cn("k-switch", className)}><input className="k-switch-input" type="checkbox" role="switch" {...props} /><span className="k-trk" aria-hidden="true" /><span>{label}</span></label>;
}
