/** Buttons: one ink primary per screen; outline and ghost for everything else; danger for an irreversible act. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import type { ComponentProps } from "react";
import { type KitIcon } from "../../design/kit.js";
import { cn } from "./utils.js";
import { KIcon } from "./k-icon.js";

export type KButtonProps = Omit<ComponentProps<"button">, "children"> & {
  variant?: "primary" | "outline" | "ghost" | "danger";
  sm?: boolean;
  iconOnly?: KitIcon;
  lead?: KitIcon;
  label: string;
  /** The screen's one primary that the phone dock also carries: hidden in its card on a phone. */
  docked?: boolean;
  /** The busy face ("Starting…") while the act runs; the label comes back after. */
  busy?: string | false;
};

export function KButton({ variant = "outline", sm, iconOnly, lead, label, docked, busy, className, type = "button", ...props }: KButtonProps) {
  return <button type={type} className={cn("k-btn", `k-btn-${variant}`, sm && "k-btn-sm", iconOnly && "k-btn-icon", docked && "k-docked", busy && "busy", className)}
    aria-label={iconOnly ? label : undefined} title={iconOnly ? label : undefined} aria-busy={busy ? true : undefined} {...props}>
    {iconOnly ? <KIcon name={iconOnly} /> : <span className="k-face">{busy ? <><span className="k-spin" aria-hidden="true" />{busy}</> : <>{lead && <KIcon name={lead} small />}{label}</>}</span>}
  </button>;
}

/** A link that looks like a button (navigation is never the screen's primary act). */
export function KLinkButton({ variant = "outline", sm, label, lead, className, ...props }: Omit<ComponentProps<"a">, "children"> & { variant?: "outline" | "ghost" | "primary"; sm?: boolean; label: string; lead?: KitIcon }) {
  return <a className={cn("k-btn", `k-btn-${variant}`, sm && "k-btn-sm", className)} {...props}><span className="k-face">{lead && <KIcon name={lead} small />}{label}</span></a>;
}
