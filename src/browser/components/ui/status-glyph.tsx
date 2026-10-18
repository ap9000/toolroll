/** A 14px status glyph (after Linear's issue states): state as shape, so a list stays quiet.
 * decide: a ring with a dot · review: a ring three-quarters full · building: half full ·
 * unblock / failed: a filled disc with a cross · done: a filled disc with a check · anything else: a dashed ring.
 * Colour comes from the shared tokens through currentColor; the word always sits beside it. */
import type { ComponentProps } from "react";
import { cn } from "./utils.js";

export type GlyphKind = "decide" | "review" | "building" | "unblock" | "failed" | "done" | "idle";

const COLOUR: Record<GlyphKind, string> = {
  decide: "text-attention", review: "text-attention", building: "text-info",
  unblock: "text-destructive", failed: "text-destructive", done: "text-success", idle: "text-muted-foreground",
};

export function StatusGlyph({ kind, className, ...props }: { kind: GlyphKind } & ComponentProps<"svg">) {
  const ring = <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" {...(kind === "idle" ? { strokeDasharray: "2 2" } : {})} />;
  const mark = { fill: "none", stroke: "var(--so-paper)", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" data-glyph={kind} className={cn("size-3.5 shrink-0", COLOUR[kind], className)} {...props}>
    {kind === "done" ? <><circle cx="7" cy="7" r="7" fill="currentColor" /><path d="M4.2 7.2 6.1 9 9.8 5.1" {...mark} /></>
      : kind === "unblock" || kind === "failed" ? <><circle cx="7" cy="7" r="7" fill="currentColor" /><path d="M4.9 4.9l4.2 4.2M9.1 4.9 4.9 9.1" {...mark} /></>
      : <>{ring}
        {kind === "decide" && <circle cx="7" cy="7" r="2.5" fill="currentColor" />}
        {kind === "review" && <path d="M7 7V2.5A4.5 4.5 0 1 1 2.5 7Z" fill="currentColor" />}
        {kind === "building" && <path d="M7 7V2.5A4.5 4.5 0 0 1 7 11.5Z" fill="currentColor" />}
      </>}
  </svg>;
}
