/** brandIconHtml's markup in React: the logo alone, sized and coloured like the icons beside it. */
import { BRAND_ICONS, type BrandIcon as Icon, type BrandIconId } from "../brand-icons.js";

export function BrandIcon({ id }: { id: BrandIconId }) {
  const icon: Icon = BRAND_ICONS[id];
  return <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path fill="currentColor" fillRule={icon.evenodd ? "evenodd" : undefined} d={icon.path} /></svg>;
}
