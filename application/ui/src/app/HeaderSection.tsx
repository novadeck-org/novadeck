import { memo } from "react"

import { transitionWorkspace } from "../layouts/transition"
import { viewModes } from "../model/state"
import type { Project } from "../model/types"
import { projectStatuses } from "../projects/project-status"
import { WorkspaceHeader } from "../shell/WorkspaceHeader"
import { unreadEnd } from "../terminals/unread-state"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { routeUrl } from "./routing"
import { currentState, shallowEqual } from "./selectors"

const sameProjects = (a: readonly Project[], b: readonly Project[]): boolean =>
  a.length === b.length && a.every((project, index) => shallowEqual(project, b[index]))

// The app header wired to the workspace: projects, views, search and preferences.
export const HeaderSection = memo((): React.JSX.Element => {
  const { backend, commands, navigation } = useWorkspaceServices()
  const {
    switchProject,
    openFolder,
    removeProject,
    moveProject,
    stepProject,
    toggleProjectPin,
    changeView,
    enterZen,
    setSwitcher,
  } = commands
  const projects = useWorkspaceState(
    (workspace) => workspace.projects.map(({ id, name, directory }) => ({ id, name, directory })),
    sameProjects,
  )
  const { activeProjectId, view } = useWorkspaceState(
    (workspace) => ({
      activeProjectId: workspace.activeProjectId,
      view: currentState(workspace).view,
    }),
    shallowEqual,
  )
  const unread = useUiState((state) => state.unread)
  const arrangement = useUiState((state) => state.projectArrangement)
  // The selector closes over `unread`, so a new one is a new selector and recomputes.
  const statuses = useWorkspaceState(
    (workspace) =>
      projectStatuses(workspace.projects, (context, id) => unreadEnd(unread, context, id)),
    shallowEqual,
  )
  const { zen, enabledViews, homeTo } = useUiState(
    (state) => ({
      zen: Boolean(state.shell.zen),
      enabledViews: state.preferences.enabledViews,
      homeTo: routeUrl({
        ...state.location.route,
        view: state.preferences.enabledViews[0]!,
        dialog: null,
      }),
    }),
    shallowEqual,
  )
  const project = projects.find((item) => item.id === activeProjectId)!
  return (
    <WorkspaceHeader
      hidden={zen}
      onZen={enterZen}
      view={view}
      enabledViews={enabledViews}
      projects={projects}
      project={project}
      statuses={statuses}
      arrangement={arrangement}
      onProjectMove={moveProject}
      onProjectStep={stepProject}
      onProjectTogglePin={toggleProjectPin}
      onProjectSelect={(id) => {
        const next = projects.find((item) => item.id === id)
        if (next) switchProject(next)
      }}
      onOpenFolder={backend.pickDirectory ? () => void openFolder() : undefined}
      onProjectRemove={removeProject}
      onViewChange={(id) => {
        if (view === id) return
        const direction = viewModes.indexOf(id) > viewModes.indexOf(view) ? 1 : -1
        transitionWorkspace(() => changeView(id), direction)
      }}
      homeTo={homeTo}
      onSearch={() => {
        setSwitcher(null)
        navigation.go({ dialog: "search" })
      }}
      onPreferences={() => {
        setSwitcher(null)
        navigation.go({ dialog: "preferences", section: "general" })
      }}
    />
  )
})
