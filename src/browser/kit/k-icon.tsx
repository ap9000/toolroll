/** One 24×24 stroke icon from the kit set (src/design/kit.ts KIT_ICONS). Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import { createElement } from "react";
import { KIT_ICONS, type IconShape, type KitIcon } from "../../design/kit.js";
import { cn } from "./utils.js";

export function KIcon({ name, small = false }: { name: KitIcon; small?: boolean }) {
  return <svg className={cn("k-i", small && "k-i-sm")} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    {(KIT_ICONS[name] as readonly IconShape[]).map((shape, index) => createElement(shape[0], { key: index, ...shape[1] }))}
  </svg>;
}
