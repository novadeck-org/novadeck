import { memo } from "react"
import { HashRouter } from "react-router"

import type { CreateBackend } from "../backend/port"
import { sidebarToggle } from "../interaction/dom"
import { cancelTerminalTransition } from "../layouts/transition"
import { useDesktop } from "../shell/desktop"
import { sidebarVisible } from "../shell/shell-state"
import { SidebarRail } from "../shell/SidebarRail"
import { WorkspacePanels } from "../shell/WorkspacePanels"
import { ZenDock } from "../shell/ZenDock"
import { selectBackend } from "./backend"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { useKeyboard } from "./controller/useKeyboard"
import { useWorkspaceEffects } from "./controller/useWorkspaceEffects"
import { HeaderSection } from "./HeaderSection"
import { currentState, shallowEqual } from "./selectors"
import { SidebarSection } from "./SidebarSection"
import { WorkspaceOverlays } from "./WorkspaceOverlays"
import { WorkspaceProvider } from "./WorkspaceProvider"
import { WorkspaceStage } from "./WorkspaceStage"

export type AppProps = {
  // Read once when the app mounts; later changes are ignored. Defaults to app/backend.ts.
  readonly createBackend?: CreateBackend
}

export const App = ({ createBackend = selectBackend }: AppProps): React.JSX.Element => (
  <HashRouter useTransitions={false}>
    <WorkspaceProvider createBackend={createBackend}>
      <WorkspaceApp />
    </WorkspaceProvider>
  </HashRouter>
)

// The terminal counts under the workspace.
const WorkspaceFooter = memo((): React.JSX.Element => {
  const zen = useUiState((state) => Boolean(state.shell.zen))
  const { count, running } = useWorkspaceState((workspace) => {
    const { terminals } = currentState(workspace).roster
    return {
      count: terminals.length,
      running: terminals.filter((terminal) => terminal.state === "running").length,
    }
  }, shallowEqual)
  return (
    <footer
      hidden={zen}
      className="app-footer max-[701px]:px-3 max-[701px]:text-[8px] flex h-7 shrink-0 items-center justify-between border-t border-line bg-paper px-4 text-[10px] text-muted"
    >
      <span className="flex items-center gap-2">
        <span>
          {count} {count === 1 ? "terminal" : "terminals"}
        </span>
        <span className="footer-running max-[701px]:hidden ml-2 border-l border-line pl-3">
          {running} running
        </span>
      </span>
    </footer>
  )
})

// Hosts the effects that follow store changes; it renders nothing.
const WorkspaceEffects = (): null => {
  useWorkspaceEffects()
  return null
}

export const WorkspaceApp = (): React.JSX.Element => {
  const { commands, canvas } = useWorkspaceServices()
  const { hideSidebar, toggleSidebar, exitZen, changeView, add } = commands
  const desktop = useDesktop()
  const shell = useUiState((state) => {
    const { zen, sidebar, sidebarCollapsed } = state.shell
    return {
      zen: Boolean(zen),
      sidebar,
      sidebarCollapsed,
      sidebarVisible: sidebarVisible(state.shell, desktop),
      sidebarPanel: state.location.route.panel,
      fontSize: state.preferences.fontSize,
      enabledViews: state.preferences.enabledViews,
    }
  }, shallowEqual)
  const { zen, sidebar, sidebarCollapsed, sidebarPanel, fontSize, enabledViews } = shell
  const view = useWorkspaceState((workspace) => currentState(workspace).view)
  useKeyboard()
  const sidebarRail = (mobile = false): React.JSX.Element => (
    <SidebarRail
      mobile={mobile}
      sidebarVisible={shell.sidebarVisible}
      sidebarPanel={sidebarPanel}
      zen={zen}
      toggleSidebar={toggleSidebar}
      hideSidebar={hideSidebar}
    />
  )
  return (
    <main
      className="workspace flex h-dvh min-h-100 flex-col overflow-hidden bg-paper"
      data-zen={zen}
      onPointerDownCapture={cancelTerminalTransition}
      onKeyDownCapture={cancelTerminalTransition}
      style={
        {
          "--terminal-font-size": `${fontSize}px`,
        } as React.CSSProperties
      }
    >
      <WorkspaceEffects />
      <HeaderSection />
      <div className="workspace-body relative flex min-h-0 flex-1">
        {sidebarRail()}
        <WorkspacePanels
          collapsed={zen || sidebarCollapsed}
          mobileOpen={!zen && sidebar}
          onMobileOpenChange={(open) => {
            if (!open) hideSidebar()
          }}
          mobileRail={sidebarRail(true)}
          mobileLabel={sidebarPanel === "sessions" ? "Workspace sessions" : "Terminal sessions"}
          mobileFinalFocusEl={() => sidebarToggle(sidebarPanel)}
          sidebar={<SidebarSection />}
        >
          <WorkspaceStage canvas={canvas} />
        </WorkspacePanels>
        {zen && (
          <ZenDock
            view={view}
            enabledViews={enabledViews}
            onCreate={() => add()}
            onViewChange={(next) => {
              if (next !== view) changeView(next)
            }}
            onExit={exitZen}
          />
        )}
      </div>
      <WorkspaceFooter />
      <WorkspaceOverlays />
    </main>
  )
}
