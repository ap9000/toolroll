/** Count pills: ink only for a Needs-you count. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import { cn } from "./utils.js";

export function KCount({ n, ink = false }: { n: number; ink?: boolean }) {
  return <span className={cn("k-count", ink && n > 0 && "ink", n === 0 && "zero")}>{n}</span>;
}
