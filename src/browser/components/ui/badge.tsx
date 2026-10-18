/** shadcn/ui Badge (MIT): status tones from the shared palette. */
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./utils.js";

export const badgeVariants = cva("inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-badge px-1.5 py-px text-[11.5px] font-medium leading-[18px] [&_svg]:size-3", {
  variants: {
    tone: {
      neutral: "bg-neutral-soft text-neutral-ink",
      success: "bg-success-soft text-success",
      warning: "bg-warning-soft text-warning",
      attention: "bg-attention-soft text-attention",
      danger: "bg-destructive-soft text-destructive",
      info: "bg-info-soft text-info",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({ className, tone, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props} />;
}
