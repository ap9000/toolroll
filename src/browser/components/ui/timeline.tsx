/** ReUI Timeline (MIT, keenthemes/reui@067aa0d, registry-reui/bases/radix/reui/timeline.tsx), cut to a read-only
 * vertical list: an <ol> of items, each an indicator (our StatusGlyph, never a coloured fill) on a hairline rail and
 * its content. No active-step state, no horizontal mode. A <time> shows only when the data carries one; a clock is a
 * machine fact, so it is mono. See THIRD_PARTY_NOTICES.md. */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./utils.js";

export function Timeline({ className, ...props }: ComponentProps<"ol">) {
  return <ol data-slot="timeline" className={cn("flex flex-col", className)} {...props} />;
}

/** One entry: the indicator column, the rail down to the next entry (none after the last), then the content. */
export function TimelineItem({ indicator, className, children, ...props }: ComponentProps<"li"> & { indicator: ReactNode }) {
  return <li data-slot="timeline-item" className={cn("group/timeline-item relative grid grid-cols-[14px_minmax(0,1fr)] gap-x-2.5 pb-3 last:pb-0", className)} {...props}>
    <span aria-hidden="true" data-slot="timeline-separator" className="absolute bottom-0 left-[6.5px] top-[19px] w-px bg-border group-last/timeline-item:hidden" />
    <span aria-hidden="true" data-slot="timeline-indicator" className="mt-[3px] flex size-3.5 items-center justify-center">{indicator}</span>
    <div data-slot="timeline-content" className="min-w-0">{children}</div>
  </li>;
}

export function TimelineDate({ className, ...props }: ComponentProps<"time">) {
  return <time data-slot="timeline-date" className={cn("font-mono text-mono tabular-nums text-muted-foreground", className)} {...props} />;
}
