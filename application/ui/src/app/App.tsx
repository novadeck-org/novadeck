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
import { BackendGate } from "./BackendGate"
import { BootReporter } from "./BootReporter"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { useKeyboard } from "./controller/useKeyboard"
import { useWorkspaceEffects } from "./controller/useWorkspaceEffects"
import { HeaderSection } from "./HeaderSection"
import { currentState, currentTarget, shallowEqual } from "./selectors"
import { SidebarSection } from "./SidebarSection"
import { WorkspaceFooter } from "./WorkspaceFooter"
import { WorkspaceOverlays } from "./WorkspaceOverlays"
import { WorkspaceProvider } from "./WorkspaceProvider"
import { WorkspaceStage } from "./WorkspaceStage"

export type AppProps = {
  // Read once when the app mounts; later changes are ignored. Defaults to app/backend.ts.
  readonly createBackend?: CreateBackend
}

export const App = ({ createBackend }: AppProps): React.JSX.Element => (
  <BackendGate
    selection={createBackend ? { createBackend } : selectBackend}
    render={(create, boot) => (
      <HashRouter useTransitions={false}>
        <WorkspaceProvider createBackend={create}>
          <BootReporter report={boot} />
          <WorkspaceApp />
        </WorkspaceProvider>
      </HashRouter>
    )}
  />
)

// The backend's debug panel, where this launch offers one.
const DebugSection = (): React.JSX.Element | null => {
  const { backend, commands, workspace } = useWorkspaceServices()
  const Panel = backend.DebugPanel
  if (!Panel) return null
  return (
    <Panel
      addTerminal={() => {
        const terminalId = commands.add({ beginRename: false })
        return { ...currentTarget(workspace.getSnapshot()), terminalId }
      }}
      startFresh={commands.startFresh}
      selected={() => {
        const snapshot = workspace.getSnapshot()
        const terminalId = currentState(snapshot).selected
        return terminalId ? { ...currentTarget(snapshot), terminalId } : undefined
      }}
    />
  )
}

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
      className="workspace flex h-dvh min-h-100 flex-col overflow-hidden"
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
      <DebugSection />
    </main>
  )
}
