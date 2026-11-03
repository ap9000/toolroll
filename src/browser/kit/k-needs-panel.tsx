/** Waits that aren’t tasks, on their own page. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import type { ReactNode } from "react";
import { KCount } from "./k-count.js";

/** Waits that aren't tasks, on their own page: one amber outline, a count, one action per item. */
export function KNeedsPanel({ items, label = "Needs you" }: { items: ReadonlyArray<{ title: string; text?: string; action?: ReactNode }>; label?: string }) {
  if (items.length === 0) return null;
  return <section className="k-needs" aria-label={label}><h2 className="k-needs-h">{label} <KCount n={items.length} ink /></h2>
    {items.map(item => <div key={item.title} className="k-needs-item"><div><b>{item.title}</b>{item.text && <p>{item.text}</p>}</div>{item.action && <div className="k-acts">{item.action}</div>}</div>)}
  </section>;
}
