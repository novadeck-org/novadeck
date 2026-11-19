import { useEffect, useState } from "react"

import { themeChangeEvent } from "../theme/apply"

// The family a name list starts with, without its quotes: `"Share Tech Mono", monospace` is
// Share Tech Mono.
export const firstFamily = (chain: string): string =>
  /^\s*(?:"([^"]+)"|'([^']+)'|([^,]+))/.exec(chain)?.slice(1).find(Boolean)?.trim() ?? ""

// The family a terminal draws in when none is chosen: the first of the theme's `--font-mono`,
// as the root shows it. The bundled one is "JetBrains Mono Variable".
export const themeMonoFamily = (root: HTMLElement = document.documentElement): string =>
  firstFamily(getComputedStyle(root).getPropertyValue("--font-mono"))

// `themeMonoFamily`, read again whenever a theme is applied.
export const useThemeMonoFamily = (): string => {
  const [family, setFamily] = useState(() => themeMonoFamily())
  useEffect(() => {
    const read = (): void => setFamily(themeMonoFamily())
    read()
    window.addEventListener(themeChangeEvent, read)
    return () => window.removeEventListener(themeChangeEvent, read)
  }, [])
  return family
}
