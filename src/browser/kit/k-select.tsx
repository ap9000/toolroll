/** A native select with the kit chevron. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import type { ComponentProps } from "react";
import { cn } from "./utils.js";

/** A native select with the chevron: 32px, sm 28px in a toolbar, 44px and 16px on a phone. */
export function KSelect({ items, sm, wide, className, ...props }: ComponentProps<"select"> & { items: ReadonlyArray<readonly [value: string, label: string] | string>; sm?: boolean; wide?: boolean }) {
  return <span className={cn("k-selw", sm && "sm", wide && "wide", className)}>
    <select className="k-sel" {...props}>{items.map(item => { const [value, text] = typeof item === "string" ? [item, item] : item; return <option key={value} value={value}>{text}</option>; })}</select>
  </span>;
}
