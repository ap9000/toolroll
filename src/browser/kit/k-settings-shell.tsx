/** The Settings frame. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import type { ReactNode } from "react";
import { SETTINGS_GROUPS } from "../../design/kit.js";
import { KPhoneHeader } from "./k-page-header.js";

/** The Settings frame: Overview and the eight groups, a desk breadcrumb, a phone back header, one column. */
export function KSettingsShell({ group, title, lead, sub, back, flags = {}, children }: { group: string; title: string; lead?: string; sub?: boolean; back?: string; flags?: Readonly<Record<string, boolean>>; children: ReactNode }) {
  const own = SETTINGS_GROUPS.find(([, slug]) => slug === group);
  const hub = group === "hub" || own === undefined;
  const backTo = back ?? (hub ? undefined : sub ? own[2] : "/settings");
  return <>
    <KPhoneHeader title={hub ? "Settings" : title} {...(backTo ? { back: backTo } : {})} />
    <div className="k-tb"><h1>Settings</h1>{!hub && <nav className="k-tb-ctx k-crumbs" aria-label="Breadcrumb">{sub && <><a href={own[2]}>{own[0]}</a><span className="k-sep" aria-hidden="true">/</span></>}<b aria-current="page">{title}</b></nav>}</div>
    <div className="k-settings">
      <nav className="k-snav" aria-label="Settings">
        <a className="k-nav k-nav-top" href="/settings" aria-current={hub ? "page" : undefined}><span className="k-nav-l">Overview</span></a>
        {SETTINGS_GROUPS.map(([label, slug, href]) => <a key={slug} className="k-nav" href={href} aria-current={slug === group ? "page" : undefined}><span className="k-nav-l">{label}</span>{flags[slug] && <><span className="k-nav-flag" aria-hidden="true" /><span className="k-sr"> (needs you)</span></>}</a>)}
      </nav>
      <div className="k-sbody"><header><h2 className={hub ? "k-sr" : "k-same"}>{title}</h2>{lead && <p>{lead}</p>}</header>{children}</div>
    </div>
  </>;
}
