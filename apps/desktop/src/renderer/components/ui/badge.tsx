import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-accent-muted text-accent",
        secondary:
          "border-transparent bg-surface-3 text-text-secondary",
        destructive:
          "border-transparent bg-danger text-white",
        success:
          "border-transparent bg-success/20 text-success",
        warning:
          "border-transparent bg-warning/20 text-warning",
        outline: "text-text-primary border-border-subtle",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
