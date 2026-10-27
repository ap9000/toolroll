/** ReUI Alert (MIT, keenthemes/reui@067aa0d, registry-reui/bases/radix/reui/alert.tsx), cut to Signal's two:
 * `neutral` (a raised fill, ink words, a muted icon) for anything worth a look in a card that has not failed, and
 * `destructive` (the vermilion wash) only when it has. No info, warning or success alerts, no border stripe, and never
 * a coloured banner in the main column. An icon as the first child sits in its own column. See THIRD_PARTY_NOTICES.md. */
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./utils.js";

export const alertVariants = cva(
  "grid w-full grid-cols-[minmax(0,1fr)] items-start gap-y-0.5 rounded-md px-3 py-2.5 text-body has-[>svg]:grid-cols-[14px_minmax(0,1fr)] has-[>svg]:gap-x-2.5 [&>svg]:mt-0.5 [&>svg]:size-3.5",
  {
    variants: {
      tone: {
        neutral: "bg-raised text-foreground [&>svg]:text-muted-foreground",
        destructive: "bg-destructive-soft text-foreground [&>svg]:text-destructive",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export function Alert({ className, tone, ...props }: ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" className={cn(alertVariants({ tone }), className)} {...props} />;
}
