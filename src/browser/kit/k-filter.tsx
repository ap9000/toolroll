/** The text filter of a list. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import { KIcon } from "./k-icon.js";

/** A list's text filter: a search field with its icon, narrowing the rows already on the page as you type. */
export function KFilter({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <label className="k-filter"><KIcon name="search" small />
    <input type="search" value={value} placeholder={placeholder ?? label} aria-label={label} onChange={event => onChange(event.target.value)} /></label>;
}
