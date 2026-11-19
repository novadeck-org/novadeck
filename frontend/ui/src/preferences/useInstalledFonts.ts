import { useEffect, useState } from "react"

import { installedFonts, noFonts, type InstalledFonts } from "./local-fonts"

// What the computer's fonts are, measured once per page: a person who opens Preferences twice
// pays for it once. Fonts installed meanwhile show after a reload.
let known: Promise<InstalledFonts> | undefined

// The installed fonts once `wanted` is first true (Preferences shows the terminal font), and
// none until they are known, or when the page can't list them.
export const useInstalledFonts = (wanted: boolean): { fonts: InstalledFonts; listed: boolean } => {
  const [state, setState] = useState<{ fonts: InstalledFonts; listed: boolean }>({
    fonts: noFonts,
    listed: false,
  })
  useEffect(() => {
    if (!wanted || state.listed) return
    let current = true
    known ??= installedFonts()
    void known.then((fonts) => {
      if (current) setState({ fonts, listed: true })
    })
    return () => {
      current = false
    }
  }, [wanted, state.listed])
  return state
}
