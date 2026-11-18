import { createContext, useContext } from "react"

import type { CompanionActions } from "./actions"

// What a body may do with its own item that only the place showing it can: close it. A pane
// provides it; where none does (a window, which has its own close), it is undefined.
export const ItemCommandsContext = createContext<Pick<CompanionActions, "closeItem"> | undefined>(
  undefined,
)

export const useItemCommands = (): Pick<CompanionActions, "closeItem"> | undefined =>
  useContext(ItemCommandsContext)
