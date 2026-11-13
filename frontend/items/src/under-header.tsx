import { createContext, use, type ReactNode } from "react"

// What the place showing an item puts under the viewer's header, as a terminal's pane puts
// the tabs of the icon it shows: under whatever header the viewer draws, or at its top
// while it draws none, as while it loads or can't show. Nothing, where the place has nothing
// to put there.
export const UnderHeader = createContext<ReactNode>(null)

export const UnderHeaderSlot = (): ReactNode => use(UnderHeader)
