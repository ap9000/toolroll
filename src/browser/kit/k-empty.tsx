/** The one empty state: a sentence and one action. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import type { ReactNode } from "react";

export function KEmpty({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return <div className="k-empty"><p className="k-empty-t">{title}</p>{text && <p className="k-empty-x">{text}</p>}{action}</div>;
}
