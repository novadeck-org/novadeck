import type { Chat } from "@novadeck/chat/state"
import type { Backend } from "@novadeck/core/port"
import type { WorkspaceStore } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"
import type { DragSession } from "@novadeck/items/drag-session"
import type { ItemStore } from "@novadeck/items/state"
import { createContext, useContext, type RefObject } from "react"

import type { CanvasHandle } from "../../layouts/canvas/types"
import type { WorkspaceCommands } from "../commands/workspace"
import type { FeatureFlag } from "../feature-flags"
import type { Landing } from "../inbox-landing"
import type { WorkspaceNavigator } from "../routing"
import type { UiState, UiStore } from "../ui-store"
import { useStoreSelector } from "./useStoreSelector"

// What the provider creates once per App, stable for the App's lifetime: the backend, both stores, navigation and
// the commands over them.
export type WorkspaceServices = {
  readonly backend: Backend
  readonly workspace: WorkspaceStore
  readonly ui: UiStore
  // What the chat keeps: drafts, replies, sends and the terminals answered in.
  readonly chat: Chat
  readonly navigation: WorkspaceNavigator
  readonly commands: WorkspaceCommands
  // The mounted Canvas, for commands that move its camera.
  readonly canvas: RefObject<CanvasHandle | null>
  // The item store, where the backend has companions.
  readonly itemStore: ItemStore | undefined
  // The backend's Inbox as the landing rule lands it, shared by the list, the bell, the toasts
  // and the pings; the provider starts and stops it.
  readonly landing: Landing
  // Whatever is being dragged off a terminal's taskbar.
  readonly drag: DragSession
}

export const WorkspaceServicesContext = createContext<WorkspaceServices | null>(null)

export const useWorkspaceServices = (): WorkspaceServices => {
  const services = useContext(WorkspaceServicesContext)
  if (!services) throw new Error("useWorkspaceServices must be used inside a WorkspaceProvider")
  return services
}

// Subscribes a section to one derived value of the workspace model.
export const useWorkspaceState = <T>(
  select: (workspace: Workspace) => T,
  equal?: (a: T, b: T) => boolean,
): T => useStoreSelector(useWorkspaceServices().workspace, select, equal)

// Subscribes a section to one derived value of the UI store.
export const useUiState = <T>(select: (state: UiState) => T, equal?: (a: T, b: T) => boolean): T =>
  useStoreSelector(useWorkspaceServices().ui, select, equal)

// Whether a feature flag is on, as the UI store keeps it.
export const useFeatureFlag = (flag: FeatureFlag): boolean =>
  useUiState((state) => state.flags[flag])
