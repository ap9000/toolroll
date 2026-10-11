/** shadcn/ui DropdownMenu (MIT) on Radix. */
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type { ComponentProps } from "react";
import { cn } from "./utils.js";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export function DropdownMenuContent({ className, sideOffset = 4, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return <DropdownMenuPrimitive.Portal><DropdownMenuPrimitive.Content data-slot="dropdown-menu-content" sideOffset={sideOffset}
    className={cn("z-[120] min-w-44 overflow-hidden rounded-card border-0 bg-popover p-1 text-popover-foreground shadow-overlay", className)} {...props} /></DropdownMenuPrimitive.Portal>;
}
export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return <DropdownMenuPrimitive.Item data-slot="dropdown-menu-item" className={cn("relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-body outline-none data-[highlighted]:bg-accent phone:min-h-11 [&_svg]:size-4", className)} {...props} />;
}
export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return <DropdownMenuPrimitive.Label className={cn("px-2 py-1.5 text-xs font-semibold text-muted-foreground", className)} {...props} />;
}
export const DropdownMenuSeparator = ({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Separator>) =>
  <DropdownMenuPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
