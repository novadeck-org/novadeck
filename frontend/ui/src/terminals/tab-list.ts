import { createStore, type MutableStore } from "@novadeck/core/store"
import { createContext } from "react"

// The Terminals list's element, as the sidebar mounts it: the list is a new element in each
// session, and in the drawer or the side pane as the window's width puts the sidebar, and
// what draws over it (TeamWire.tsx) follows the one on screen. The workspace provides one.
export type TabListStore = MutableStore<HTMLElement | null>

export const createTabListStore = (): TabListStore => createStore<HTMLElement | null>(null)

export const TabListContext = createContext<TabListStore | undefined>(undefined)
