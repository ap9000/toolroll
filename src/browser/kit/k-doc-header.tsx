/** A reading page: the 760px column and its header. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import type { ReactNode } from "react";
import { KIcon } from "./k-icon.js";

/** A reading page's header: back link, the one h1, a meta line; `same` when the phone header shows the title. */
export function KDocHeader({ title, back, meta, right, same }: { title: string; back?: readonly [href: string, label: string]; meta?: ReactNode; right?: ReactNode; same?: boolean }) {
  return <>{back && <a className="k-backlink" href={back[0]}><KIcon name="back" small />{back[1]}</a>}
    <header className="k-dh"><div><h1 className={same ? "k-same" : undefined}>{title}</h1>{meta && <p className="k-dh-meta">{meta}</p>}</div>{right}</header></>;
}

export const KDoc = ({ children }: { children: ReactNode }) => <div className="k-doc">{children}</div>;
