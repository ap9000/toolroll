/** brandMarkHtml's markup in React: the same tile, logo or letter, styled by BRAND_MARK_CSS. */
import { BRAND_ICONS } from "../brand-icons.js";
import { brandIconFor, brandLetter } from "../brand-mark.js";

export function BrandMark({ name, label, connected }: { name: string; label: string; connected: boolean }) {
  const icon = brandIconFor(name);
  return <span className="brand-mark" data-connected={String(connected)} data-letter={icon === null ? "" : undefined} aria-hidden="true">
    {icon === null ? brandLetter(label) : <svg viewBox="0 0 24 24" focusable="false"><path fill="currentColor" d={BRAND_ICONS[icon].path} /></svg>}
  </span>;
}
