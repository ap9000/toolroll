/** shadcn/ui's class helper: conditional classes, later Tailwind classes win. */
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** Signal's own theme names (src/design/theme.css). tailwind-merge alone reads an
 * unknown `text-caption` as a colour, so a later `text-muted-foreground` would
 * drop the type role; registered, a role only gives way to another size. */
export const SIGNAL_THEME = {
  text: ["badge", "body", "body-reading", "caption", "display", "headline", "label", "mono", "mono-count", "title", "title-sm"],
  radius: ["badge", "card", "sheet"],
  shadow: ["overlay", "pill", "sheet"],
};
const twMerge = extendTailwindMerge({ extend: { theme: SIGNAL_THEME } });
export function cn(...inputs: ClassValue[]): string { return twMerge(clsx(inputs)); }
