"use client"

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { cn } from "cn"

// One tooltip for the whole app. It is a small popover: the theme's popover
// surface, one hairline ring, one soft shadow. It waits a moment before it
// opens, so a pointer that only crosses a control shows nothing. After one
// tooltip is open, the next one opens at once (the provider's `timeout`).
const OPEN_DELAY = 300

function TooltipProvider({
  delay = OPEN_DELAY,
  closeDelay = 0,
  timeout = 400,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      closeDelay={closeDelay}
      timeout={timeout}
      {...props}
    />
  )
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

// The same delay with or without a provider above it.
function TooltipTrigger({ delay = OPEN_DELAY, ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" delay={delay} {...props} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 8,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={8}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md bg-popover px-2.5 py-1.5 text-xs leading-snug text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 has-data-[slot=kbd]:pr-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-instant:animate-none",
            className
          )}
          {...props}
        >
          {children}
          {/* A small square turned 45 degrees. It sits half out of the popup.
              Only its two outer edges carry the hairline, so the ring runs
              around the arrow without a seam. */}
          <TooltipPrimitive.Arrow className="size-2 rotate-45 rounded-[1px] border-foreground/10 bg-popover data-[side=bottom]:-top-1 data-[side=bottom]:border-t data-[side=bottom]:border-l data-[side=inline-end]:-left-1 data-[side=inline-end]:border-b data-[side=inline-end]:border-l data-[side=inline-start]:-right-1 data-[side=inline-start]:border-t data-[side=inline-start]:border-r data-[side=left]:-right-1 data-[side=left]:border-t data-[side=left]:border-r data-[side=right]:-left-1 data-[side=right]:border-b data-[side=right]:border-l data-[side=top]:-bottom-1 data-[side=top]:border-r data-[side=top]:border-b" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
