/** List rows between hairlines under group headings. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import type { ReactNode } from "react";
import { cn } from "./utils.js";

export const KGroup = ({ label, count }: { label: string; count?: ReactNode }) => <h2 className="k-grp">{label}{count}</h2>;

/** A list row: chip · title (the whole row is the link) · one muted line · meta · one action in one column. */
export function KRow({ href, chip, title, desc, meta, action, wait, message }: { href: string; chip: ReactNode; title: string; desc?: ReactNode; meta?: ReactNode; action?: ReactNode; wait?: boolean; message?: ReactNode }) {
  return <div className={cn("k-row", wait && "wait")}>
    <span className="k-row-c">{chip}</span><a className="k-row-t" href={href}>{title}</a><span className="k-row-d">{desc}</span>
    <span className="k-row-m">{meta}</span><span className="k-row-a">{action}</span>{message && <div className="k-row-msg">{message}</div>}
  </div>;
}
