import { themeChangeEvent } from "./apply"
import { tokenColors } from "./probe"

// The page's theme as a backend reads it for what it paints outside CSS (the port's
// `ThemeSource`): its colour tokens where an element draws, and each theme applied. The
// app's entries hand it to their backend.
export const pageTheme = {
  tokens: (element: Element, names: readonly string[]): Partial<Record<string, string>> =>
    tokenColors(element, names),
  onChange: (listener: () => void): (() => void) => {
    window.addEventListener(themeChangeEvent, listener)
    return () => window.removeEventListener(themeChangeEvent, listener)
  },
}
