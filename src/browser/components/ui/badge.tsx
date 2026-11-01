/** shadcn/ui Badge (MIT), with ReUI's light badge and status dot (MIT, keenthemes/reui@067aa0d,
 * registry-reui/bases/radix/reui/badge.tsx and example c-badge-22), cut to Signal's tones.
 * `fact` is the 18px badge for any fact; `chip` is the 20px status chip (youiyoux's spec, the Agents → Live chip).
 * `needs` is "Needs you": the amber warning wash with its text mixed toward ink (`text-needs`) so it reads at 4.5:1.
 * A chip's words are ink and its dot carries the tone, so every chip reads at 4.5:1 whatever its hue.
 * The dot is decoration; the word carries the meaning. See THIRD_PARTY_NOTICES.md. */
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./utils.js";

export const badgeVariants = cva("inline-flex w-fit shrink-0 items-center whitespace-nowrap font-medium [&_svg]:size-3", {
  variants: {
    tone: {
      neutral: "bg-neutral-soft text-neutral-ink",
      success: "bg-success-soft text-success",
      warning: "bg-warning-soft text-warning",
      attention: "bg-attention-soft text-attention",
      needs: "bg-warning-soft text-needs",
      danger: "bg-destructive-soft text-destructive",
      info: "bg-info-soft text-info",
    },
    size: {
      fact: "gap-1 rounded-badge px-1.5 py-px text-[11.5px] leading-[18px]",
      chip: "h-5 gap-1.5 rounded-sm px-1.5 text-[11.5px] leading-none",
    },
  },
  // The chip (the Agents → Live spec): ink words on the tone's wash, the tone in the dot; Needs you keeps its amber words.
  compoundVariants: [
    { size: "chip", tone: ["neutral", "success", "warning", "attention", "danger", "info"], className: "text-foreground" },
  ],
  defaultVariants: { tone: "neutral", size: "fact" },
});
const DOT: Record<NonNullable<VariantProps<typeof badgeVariants>["tone"]>, string> = {
  neutral: "text-neutral-ink", success: "text-success", warning: "text-warning", attention: "text-attention", needs: "text-warning", danger: "text-danger", info: "text-info",
};

export type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { dot?: boolean };

export function Badge({ className, tone, size, dot = false, children, ...props }: BadgeProps) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone, size }), className)} {...props}>
    {dot && <span aria-hidden="true" data-badge-dot className={cn("size-1.5 shrink-0 rounded-full bg-current", DOT[tone ?? "neutral"])} />}
    {children}
  </span>;
}
