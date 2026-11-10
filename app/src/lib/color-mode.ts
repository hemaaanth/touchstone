import { createContext, useContext } from "react"
import type { ColorMode } from "@graphical"

/*
 * Light or dark. AppTheme (app-theme.tsx) owns the state and saves it
 * in localStorage, so the mode survives a reload. This file holds only
 * the context and the hook, so app-theme.tsx exports only components.
 */

export type ColorModeState = {
  colorMode: ColorMode
  setColorMode: (mode: ColorMode) => void
  toggleColorMode: () => void
}

export const ColorModeContext = createContext<ColorModeState | null>(null)

export function useColorMode(): ColorModeState {
  const value = useContext(ColorModeContext)
  if (!value) throw new Error("useColorMode requires AppTheme")
  return value
}
