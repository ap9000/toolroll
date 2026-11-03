/** The board: a list's rows as columns. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import { Children, type ReactNode } from "react";
import { cn } from "./utils.js";

/** Columns side by side at a desk; on a phone one column at a time, chosen with the pager above (`KSeg`). */
export const KBoard = ({ label, children }: { label: string; children: ReactNode }) => <div className="k-board" role="region" aria-label={label}>{children}</div>;

/** One column: its heading and count (`needs` marks the column that waits on you), its cards, or one quiet line. */
export function KBoardCol({ label, count, needs, on, empty, children }: { label: string; count?: ReactNode; needs?: boolean; on?: boolean; empty: string; children?: ReactNode }) {
  const has = Children.toArray(children).length > 0;
  return <section className={cn("k-col", on && "on")} aria-label={label}><h2 className={cn("k-col-h", needs && "needs")}>{label}{count}</h2>
    {has ? children : <p className="k-col-e">{empty}</p>}</section>;
}

/** A card on the board: the title (the card is the link) and one meta line (chip · project · age). */
export const KCard = ({ href, title, meta }: { href: string; title: string; meta: ReactNode }) =>
  <a className="k-card" href={href}><span className="k-card-t">{title}</span><span className="k-card-m">{meta}</span></a>;
