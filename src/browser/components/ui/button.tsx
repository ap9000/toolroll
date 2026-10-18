/** shadcn/ui Button (MIT), on the shared palette: the console's one Button. border-0, a transparent ghost and a
 * min-height equal to the size keep the server sheet's bare `button` rule from leaking in outside a rebuilt view. */
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./utils.js";

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 border-0 whitespace-nowrap rounded-md text-[13px] font-medium transition-[color,background-color,box-shadow,transform] duration-150 ease-out active:scale-[.985] motion-reduce:transition-colors motion-reduce:active:scale-100 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        attention: "bg-attention text-on-attention hover:bg-[var(--so-signal-hover)]",
        destructive: "bg-destructive-soft text-destructive hover:bg-destructive/15",
        outline: "bg-card text-foreground shadow-[var(--so-pill-shadow)] hover:bg-accent",
        secondary: "bg-secondary text-secondary-foreground hover:bg-accent",
        ghost: "bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
        link: "bg-transparent text-foreground underline underline-offset-4 decoration-border hover:decoration-muted-foreground",
      },
      size: {
        default: "h-8 min-h-8 px-3 phone:h-11 phone:px-4",
        sm: "h-7 min-h-7 px-2.5 text-[12.5px] phone:h-11 phone:px-3 phone:text-[13px]",
        lg: "h-10 min-h-10 px-5",
        icon: "size-8 min-h-8 phone:size-11",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({ className, variant, size, asChild = false, type, ...props }: ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : "button";
  return <Component data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...(asChild ? {} : { type: type ?? "button" })} {...props} />;
}
