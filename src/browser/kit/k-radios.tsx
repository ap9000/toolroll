/** Radio cards: one choice from a few. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import type { ReactNode } from "react";


export function KRadios({ name, legend, current, items, onChange }: { name: string; legend: string; current: string; items: ReadonlyArray<{ value: string; label: string; text?: string; tag?: ReactNode }>; onChange: (value: string) => void }) {
  return <fieldset className="k-radios"><legend className="k-sr">{legend}</legend>{items.map(item =>
    <label key={item.value} className="k-opt"><input type="radio" name={name} value={item.value} checked={item.value === current} onChange={() => onChange(item.value)} />
      <span><b>{item.label}</b>{item.text && <span>{item.text}</span>}</span>{item.tag}</label>)}</fieldset>;
}
