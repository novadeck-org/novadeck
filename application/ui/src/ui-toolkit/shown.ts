import { createContext, useContext } from "react"

// Whether what's inside is on screen. A view that keeps something mounted out of sight,
// as Focus keeps the terminals it last displayed, says so here, so what shows status,
// opens over the page or plays sound leaves that to what is on screen.
export const Shown = createContext(true)

export const useShown = (): boolean => useContext(Shown)
