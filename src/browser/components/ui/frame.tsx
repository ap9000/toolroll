/** ReUI Frame (MIT, keenthemes/reui@067aa0d, registry-reui/bases/radix/reui/frame.tsx), cut to Signal: a raised
 * well with a hairline that holds paper panels (youiyoux's panel and well). One geometry, no style variants, and no
 * shadow on a panel (the Hairline First and One Sheet Shadow rules). Panels sit concentric in the well: the panel's
 * corner is the card corner less the well's 4px padding and 1px border. A Frame never nests in a Card or a Frame.
 * See THIRD_PARTY_NOTICES.md. */
import { Slot } from "@radix-ui/react-slot";
import type { ComponentProps } from "react";
import { cn } from "./utils.js";

export function Frame({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="frame" className={cn("flex flex-col gap-1 rounded-card border border-border bg-raised p-1", className)} {...props} />;
}

/** A paper panel in the well; `asChild` makes a link (a settings tile) the panel itself. */
export function FramePanel({ className, asChild = false, ...props }: ComponentProps<"div"> & { asChild?: boolean }) {
  const Component = asChild ? Slot : "div";
  return <Component data-slot="frame-panel" className={cn("relative rounded-[calc(var(--so-radius-card)-0.25rem-1px)] border border-border bg-card px-3.5 py-3", className)} {...props} />;
}

/** The well's own heading row, on the raised fill above the panels: a title, then a muted count or link at the right. */
export function FrameHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="frame-header" className={cn("flex min-h-8 items-center justify-between gap-2 px-2.5 py-1 text-body", className)} {...props} />;
}
