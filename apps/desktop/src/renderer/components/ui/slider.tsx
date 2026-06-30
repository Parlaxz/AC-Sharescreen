import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";

const Slider = React.forwardRef<
  React.ComponentRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & {
    /** When set, wraps the thumb in a tooltip showing this value */
    thumbTooltip?: string;
  }
>(({ className, thumbTooltip, ...props }, ref) => {
  const thumb = (
    <SliderPrimitive.Thumb className="block h-4 w-4 rounded-full border border-border-strong bg-accent shadow transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50" />
  );

  return (
    <SliderPrimitive.Root
      ref={ref}
      className={cn(
        "relative flex w-full touch-none select-none items-center",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-surface-3">
        <SliderPrimitive.Range className="absolute h-full bg-accent" />
      </SliderPrimitive.Track>
      {thumbTooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>{thumb}</TooltipTrigger>
          <TooltipContent side="top" className="text-xs px-1.5 py-0.5">
            {thumbTooltip}
          </TooltipContent>
        </Tooltip>
      ) : (
        thumb
      )}
    </SliderPrimitive.Root>
  );
});
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
