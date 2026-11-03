/** A disclosure for secondary detail. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import type { ReactNode } from "react";

export function KDisclose({ summary, children, open }: { summary: string; children: ReactNode; open?: boolean }) {
  return <details className="k-disclose" open={open}><summary>{summary}</summary>{children}</details>;
}
