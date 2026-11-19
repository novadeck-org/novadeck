import { createContext, useContext } from "react"

import type { CompanionActions } from "./actions"

// What a body may do with its own item, or one beside it, that only the place showing it can:
// close it, bring another item of the session forward (open it on its bar, or raise its window).
// A pane provides it; where none does (a window, which has its own close), it is undefined.
export type BodyCommands = Pick<CompanionActions, "closeItem" | "openBarTab" | "undock">

export const ItemCommandsContext = createContext<BodyCommands | undefined>(undefined)

export const useItemCommands = (): BodyCommands | undefined => useContext(ItemCommandsContext)
