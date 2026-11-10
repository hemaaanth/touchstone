import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  GraphicalProvider,
  IconRendererProvider,
  theme,
  type ColorMode,
} from "@graphical"
import { ColorModeContext } from "@/lib/color-mode"
import { renderThemeIcon } from "@/lib/icons"

const STORAGE_KEY = "rth.color-mode"

function readSavedMode(): ColorMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === "light" || saved === "dark") return saved
  } catch {
    // Storage can be blocked. Fall back to light.
  }
  return "light"
}

/** The app's one theme scope: colour mode state, Graphical theme, icons. */
export function AppTheme({ children }: { children: ReactNode }) {
  const [colorMode, setColorMode] = useState<ColorMode>(readSavedMode)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, colorMode)
    } catch {
      // Ignore blocked storage.
    }
    document.documentElement.style.colorScheme = colorMode
  }, [colorMode])

  const toggleColorMode = useCallback(
    () => setColorMode((mode) => (mode === "dark" ? "light" : "dark")),
    [],
  )
  const value = useMemo(
    () => ({ colorMode, setColorMode, toggleColorMode }),
    [colorMode, toggleColorMode],
  )

  return (
    <ColorModeContext value={value}>
      <IconRendererProvider renderIcon={renderThemeIcon}>
        <GraphicalProvider document={theme} colorMode={colorMode}>
          {children}
        </GraphicalProvider>
      </IconRendererProvider>
    </ColorModeContext>
  )
}
