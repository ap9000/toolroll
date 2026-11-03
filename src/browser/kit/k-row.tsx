/** List rows between hairlines under group headings. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import type { ReactNode } from "react";
import { cn } from "./utils.js";

/** A group heading with its count; `right` puts one quiet tool at its end (an Add button, a window choice). */
export const KGroup = ({ label, count, right, id }: { label: ReactNode; count?: ReactNode; right?: ReactNode; id?: string }) =>
  <h2 className="k-grp" id={id}>{label}{count}{right !== undefined && <><span className="k-grow" />{right}</>}</h2>;

/** A list row: chip · title (the whole row is the link) · one muted line · meta · one action in one column. A row
 * with no `href` (a thing that has no page of its own, such as a computer) shows its title as text: its action is the
 * way in. */
export function KRow({ href, chip, title, desc, meta, action, wait, message }: { href?: string; chip: ReactNode; title: string; desc?: ReactNode; meta?: ReactNode; action?: ReactNode; wait?: boolean; message?: ReactNode }) {
  return <div className={cn("k-row", wait && "wait", href === undefined && "k-row-static")}>
    <span className="k-row-c">{chip}</span>{href === undefined ? <span className="k-row-t">{title}</span> : <a className="k-row-t" href={href}>{title}</a>}<span className="k-row-d">{desc}</span>
    <span className="k-row-m">{meta}</span><span className="k-row-a">{action}</span>{message && <div className="k-row-msg">{message}</div>}
  </div>;
}
