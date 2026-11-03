/** The segmented track: filters or views of one list. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import type { ReactNode } from "react";
import { cn } from "./utils.js";
import { type KTabItem } from "./k-tabs.js";

/** Filters or views of a list: the segmented track (aria-pressed). */
export function KSeg({ label, current, items, onChange }: { label: string; current: string; items: readonly KTabItem[]; onChange: (key: string) => void }) {
  return <div className="k-seg" role="group" aria-label={label}>{items.map(item =>
    <button key={item.key} type="button" aria-pressed={item.key === current} onClick={() => onChange(item.key)}>{item.label}{item.count}</button>)}</div>;
}

/** Filters or views of a list as addresses (aria-current="page"), so Back and bookmarks keep them. `icons`: each item
 * is an icon with its label read aloud (List / Board). */
export function KLinkSeg({ label, current, items, icons }: { label: string; current: string; items: readonly (KTabItem & { href: string; icon?: ReactNode })[]; icons?: boolean }) {
  return <nav className={cn("k-seg", icons && "k-seg-icons")} aria-label={label}>{items.map(item =>
    <a key={item.key} href={item.href} aria-current={item.key === current ? "page" : undefined} {...(icons ? { "aria-label": item.label, title: item.label } : {})}>
      {icons && item.icon ? item.icon : item.label}{item.count}</a>)}</nav>;
}
