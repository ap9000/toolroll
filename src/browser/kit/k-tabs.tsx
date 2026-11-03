/** Underline tabs: sections of one object, as addresses or in-page tabs. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import type { ReactNode, KeyboardEvent as ReactKeyboardEvent } from "react";

export type KTabItem = { key: string; label: string; count?: ReactNode; href?: string };

/** Sections of one object as addresses (aria-current="page"). */
export function KLinkTabs({ label, current, items }: { label: string; current: string; items: readonly (KTabItem & { href: string })[] }) {
  return <nav className="k-tabs" aria-label={label}>{items.map(item => <a key={item.key} href={item.href} aria-current={item.key === current ? "page" : undefined}>{item.label}{item.count}</a>)}</nav>;
}

/** Tabs inside one page (role=tablist, arrow keys move between them). */
export function KTabs({ label, current, items, onChange }: { label: string; current: string; items: readonly KTabItem[]; onChange: (key: string) => void }) {
  const move = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const next = items[(index + (event.key === "ArrowRight" ? 1 : items.length - 1)) % items.length];
    if (next) { onChange(next.key); (event.currentTarget.parentElement?.querySelector(`[data-k-tab="${CSS.escape(next.key)}"]`) as HTMLElement | null)?.focus(); }
  };
  return <div className="k-tabs" role="tablist" aria-label={label}>{items.map((item, index) =>
    <button key={item.key} type="button" role="tab" data-k-tab={item.key} aria-selected={item.key === current} tabIndex={item.key === current ? 0 : -1}
      onClick={() => onChange(item.key)} onKeyDown={event => move(event, index)}>{item.label}{item.count}</button>)}</div>;
}
