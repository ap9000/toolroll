/** shadcn/ui Select (MIT) on Radix Select; `name` submits with the form. */
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "./utils.js";

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export function SelectTrigger({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return <SelectPrimitive.Trigger data-slot="select-trigger" className={cn("flex h-8 w-full items-center justify-between gap-2 rounded-md border border-input bg-card px-2.5 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring phone:h-11 phone:text-base [&>span]:truncate", className)} {...props}>
    {children}<SelectPrimitive.Icon asChild><ChevronDown className="size-4 opacity-60" /></SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>;
}
export function SelectContent({ className, children, position = "popper", ...props }: ComponentProps<typeof SelectPrimitive.Content>) {
  return <SelectPrimitive.Portal><SelectPrimitive.Content data-slot="select-content" position={position} sideOffset={4}
    className={cn("relative z-[120] max-h-[min(22rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg", className)} {...props}>
    <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
  </SelectPrimitive.Content></SelectPrimitive.Portal>;
}
export function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return <SelectPrimitive.Item data-slot="select-item" className={cn("relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pr-8 pl-2 text-body outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50 phone:min-h-11", className)} {...props}>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <span className="absolute right-2 flex size-4 items-center justify-center"><SelectPrimitive.ItemIndicator><Check className="size-4" /></SelectPrimitive.ItemIndicator></span>
  </SelectPrimitive.Item>;
}
