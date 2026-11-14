/** A disclosure for secondary detail. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import type { ReactNode } from "react";

/** `onToggle`: told whether it is open after the person (or the page) opened or closed it, so a page that opens it
 * itself (a link to something inside) can keep its own state in step. */
export function KDisclose({ summary, children, open, onToggle }: { summary: string; children: ReactNode; open?: boolean; onToggle?: (open: boolean) => void }) {
  return <details className="k-disclose" open={open} onToggle={onToggle === undefined ? undefined : event => onToggle(event.currentTarget.open)}><summary>{summary}</summary>{children}</details>;
}
