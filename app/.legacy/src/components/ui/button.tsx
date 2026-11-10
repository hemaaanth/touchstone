import type { ComponentProps } from "react"
import { Button as GraphicalButton, type ButtonVariant } from "@graphical"
import { cn } from "cn"

/*
 * shadcn Button, converted to the Graphical Untitled button.
 * The shadcn props stay. The theme owns geometry, type, colour, focus and
 * motion, so the old cva classes are gone.
 * - default -> primary, destructive -> danger, link -> ghost.
 * - The theme has one control size. xs/sm/lg keep the theme size.
 *   icon sizes make the button square.
 */
type ShadcnVariant =
  | "default"
  | "outline"
  | "secondary"
  | "ghost"
  | "destructive"
  | "link"

type ShadcnSize =
  | "default"
  | "xs"
  | "sm"
  | "lg"
  | "icon"
  | "icon-xs"
  | "icon-sm"
  | "icon-lg"

const VARIANT: Record<ShadcnVariant, ButtonVariant> = {
  default: "primary",
  outline: "outline",
  secondary: "secondary",
  ghost: "ghost",
  destructive: "danger",
  link: "ghost",
}

type ButtonProps = Omit<ComponentProps<typeof GraphicalButton>, "variant"> & {
  variant?: ShadcnVariant
  size?: ShadcnSize
}

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonProps) {
  const base = size.startsWith("icon") ? "aspect-square justify-center" : ""
  return (
    <GraphicalButton
      data-slot="button"
      data-size={size}
      variant={VARIANT[variant]}
      className={
        typeof className === "function"
          ? (state) => cn(base, className(state))
          : cn(base, className)
      }
      {...props}
    />
  )
}

export { Button }
export type { ButtonProps }
