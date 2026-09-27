import { createContext, useContext, type RefObject } from "react"

import type { Backend } from "../../backend/port"
import type { CanvasHandle } from "../../layouts/canvas/types"
import type { WorkspaceStore } from "../../model/store"
import type { Workspace } from "../../model/types"
import type { WorkspaceCommands } from "../commands/workspace"
import type { WorkspaceNavigator } from "../routing"
import type { UiState, UiStore } from "../ui-store"
import { useStoreSelector } from "./useStoreSelector"

// What the provider creates once per App, stable for the App's lifetime: the backend, both stores, navigation and
// the commands over them.
export type WorkspaceServices = {
  readonly backend: Backend
  readonly workspace: WorkspaceStore
  readonly ui: UiStore
  readonly navigation: WorkspaceNavigator
  readonly commands: WorkspaceCommands
  // The mounted Canvas, for commands that move its camera.
  readonly canvas: RefObject<CanvasHandle | null>
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
