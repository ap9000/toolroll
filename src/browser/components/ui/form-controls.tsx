/** shadcn/ui Label, Input, Textarea, Separator (MIT), drawn in the kit's field family (KIT.md "Fields"). */
import * as LabelPrimitive from "@radix-ui/react-label";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import type { ComponentProps } from "react";
import { cn } from "./utils.js";
import { KInput, KTextarea } from "../../kit/k-field.js";

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root data-slot="label" className={cn("flex items-center gap-2 text-sm font-medium leading-none", className)} {...props} />;
}
/** The kit's field family (KIT.md "Fields"): these are KInput and KTextarea under their shadcn names. */
export function Input({ className, ...props }: ComponentProps<"input">) {
  return <KInput data-slot="input" className={className} {...props} />;
}
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <KTextarea data-slot="textarea" className={className} {...props} />;
}
export function Separator({ className, orientation = "horizontal", ...props }: ComponentProps<typeof SeparatorPrimitive.Root>) {
  return <SeparatorPrimitive.Root data-slot="separator" orientation={orientation} className={cn("shrink-0 bg-border", orientation === "horizontal" ? "h-px w-full" : "h-full w-px", className)} {...props} />;
}
