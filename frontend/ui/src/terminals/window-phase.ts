import type { WindowPhase } from "@novadeck/chat/mark-phase"
import { createContext, useContext } from "react"

// The phase a window draws as the line under its header, which what it holds can read: the
// chat's current prompt wears it. The window works it out once (`terminalNote`); nothing else does.
const WindowPhaseContext = createContext<WindowPhase | undefined>(undefined)

export const WindowPhaseProvider = WindowPhaseContext.Provider
export const useWindowPhase = (): WindowPhase | undefined => useContext(WindowPhaseContext)
