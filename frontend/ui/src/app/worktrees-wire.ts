import { createStore, type MutableStore } from "@novadeck/core/store"
import { createContext } from "react"

import type { WorktreesWire } from "../sidebar/WorktreesPanel"

// What the Worktrees panel lends the team wire on the rail (App's WorktreesWireSection): its list's
// element and its teams of worktrees, as the Terminals list lends its element (tab-list.ts). The
// panel publishes it as it changes; none while no panel is mounted. The workspace provides one.
export type WorktreesWireStore = MutableStore<WorktreesWire | null>

export const createWorktreesWireStore = (): WorktreesWireStore =>
  createStore<WorktreesWire | null>(null)

export const WorktreesWireContext = createContext<WorktreesWireStore | undefined>(undefined)

// The context the Worktrees panel's folds are kept by in the ui store (folded leads are worktrees'
// roots), one per project, apart from the Terminals list's sessions.
export const worktreesFoldContext = (projectId: string): string => `worktrees:${projectId}`
