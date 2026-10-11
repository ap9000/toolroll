/** shadcn/ui RadioGroup (MIT) on Radix: a native value is submitted with the form. */
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { Circle } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "./utils.js";

export function RadioGroup({ className, ...props }: ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root data-slot="radio-group" className={cn("grid gap-2", className)} {...props} />;
}
export function RadioGroupItem({ className, ...props }: ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return <RadioGroupPrimitive.Item data-slot="radio-group-item" className={cn("mt-0.5 aspect-square size-4 shrink-0 rounded-full border border-input text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:border-primary", className)} {...props}>
    <RadioGroupPrimitive.Indicator className="flex items-center justify-center"><Circle className="size-2 fill-current" /></RadioGroupPrimitive.Indicator>
  </RadioGroupPrimitive.Item>;
}
/** A whole-card choice: the card is the label, so the full area is the target. */
export function RadioCard({ value, id, title, description, className }: { value: string; id: string; title: string; description?: string; className?: string }) {
  return <label htmlFor={id} className={cn("flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card p-3.5 transition-colors phone:min-h-11 phone:px-3 phone:py-2.5 hover:bg-accent has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent", className)}>
    <RadioGroupItem value={value} id={id} />
    <span className="grid gap-0.5"><span className="text-sm font-semibold">{title}</span>{description && <span className="text-body text-muted-foreground phone:leading-[1.35]">{description}</span>}</span>
  </label>;
}
