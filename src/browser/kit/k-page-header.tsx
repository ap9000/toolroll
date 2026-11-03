/** A list page’s header: the phone header and the desk top bar. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import type { ReactNode } from "react";
import { KIcon } from "./k-icon.js";

export function KPhoneHeader({ title, back, trailing }: { title: string; back?: string; trailing?: ReactNode }) {
  return <header className="k-ph">{back && <a className="k-btn k-btn-ghost k-btn-icon" href={back} aria-label="Back" title="Back"><KIcon name="back" /></a>}<p className="k-ph-t">{title}</p>{trailing}</header>;
}

/** A list page's header: the phone header and the desk top bar (title · muted context · spacer · tools). */
export function KPageHeader({ title, ctx, right, back, phoneTitle, trailing }: { title: string; ctx?: ReactNode; right?: ReactNode; back?: string; phoneTitle?: string; trailing?: ReactNode }) {
  return <><KPhoneHeader title={phoneTitle ?? title} {...(back ? { back } : {})} trailing={trailing} />
    <div className="k-tb"><h1>{title}</h1>{ctx && <span className="k-tb-ctx">{ctx}</span>}{right && <><span className="k-grow" />{right}</>}</div></>;
}
