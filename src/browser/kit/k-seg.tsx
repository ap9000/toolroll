/** The segmented track: filters or views of one list. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import { type KTabItem } from "./k-tabs.js";

/** Filters or views of a list: the segmented track (aria-pressed). */
export function KSeg({ label, current, items, onChange }: { label: string; current: string; items: readonly KTabItem[]; onChange: (key: string) => void }) {
  return <div className="k-seg" role="group" aria-label={label}>{items.map(item =>
    <button key={item.key} type="button" aria-pressed={item.key === current} onClick={() => onChange(item.key)}>{item.label}{item.count}</button>)}</div>;
}
