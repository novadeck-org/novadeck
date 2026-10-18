import { useEffect, useRef, type ComponentProps } from "react"
import { HashRouter, MemoryRouter } from "react-router"

import type { CreateBackend } from "../backend/port"
import { sidebarToggle } from "../interaction/dom"
import { dictationKeys } from "../interaction/shortcuts"
import { cancelTerminalTransition } from "../layouts/transition"
import { useDesktop } from "../shell/desktop"
import { panelLabels, shownPanel } from "../shell/panels"
import { sidebarVisible } from "../shell/shell-state"
import { SidebarRail } from "../shell/SidebarRail"
import { WorkspacePanels } from "../shell/WorkspacePanels"
import { ZenDock } from "../shell/ZenDock"
import { DictationOverlay } from "../voice/DictationOverlay"
import { debugPanelFor, selectBackend } from "./backend"
import { BackendGate } from "./BackendGate"
import { BootReporter } from "./BootReporter"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { DictationContext, useDictationController } from "./controller/dictation"
import { useKeyboard } from "./controller/useKeyboard"
import { useWorkspaceEffects } from "./controller/useWorkspaceEffects"
import { announceShown, EmbeddedContext, heldInput, holdInputUntilEngaged } from "./embedded"
import { HeaderSection } from "./HeaderSection"
import { InboxHost } from "./InboxHost"
import { currentState, currentTarget, shallowEqual } from "./selectors"
import { SidebarSection } from "./SidebarSection"
import { useNotificationBadge } from "./useNotifications"
import { VisitorBar, VisitorCover } from "./Visitor"
import { WorkspaceFooter } from "./WorkspaceFooter"
import { WorkspaceOverlays } from "./WorkspaceOverlays"
import { WorkspaceProvider } from "./WorkspaceProvider"
import { WorkspaceStage } from "./WorkspaceStage"

export type AppProps = {
  // Read once when the app mounts; later changes are ignored. Defaults to app/backend.ts.
  readonly createBackend?: CreateBackend
  // True when another page frames the app (see app/embedded.ts). Its address then stays in
  // memory, so moving around the app adds nothing to the framing page's Back button.
  readonly embedded?: boolean
}

export const App = ({ createBackend, embedded = false }: AppProps): React.JSX.Element => {
  const Router = embedded ? MemoryRouter : HashRouter
  // Framed, the app tells the page around it once it is in view, once per page load:
  // StrictMode's second effect run, or a reboot, finds this set.
  const announced = useRef(false)
  const held = useRef(heldInput())
  const shown = (): void => {
    if (!embedded || announced.current) return
    announced.current = true
    announceShown()
  }
  // Framed, the wheel is the framing page's until the visitor engages the app there.
  useEffect(() => (embedded ? holdInputUntilEngaged(held.current) : undefined), [embedded])
  return (
    <EmbeddedContext value={embedded}>
      <BackendGate
        onShown={shown}
        selection={createBackend ? { createBackend } : selectBackend}
        render={(create, boot) => (
          <Router useTransitions={false}>
            <WorkspaceProvider createBackend={create}>
              <BootReporter report={boot} />
              <VisitorCover>
                <WorkspaceApp />
              </VisitorCover>
            </WorkspaceProvider>
          </Router>
        )}
      />
    </EmbeddedContext>
  )
}

// The debug panel the backend selection made with this backend, where it made one.
const DebugSection = (): React.JSX.Element | null => {
  const { backend, commands, workspace } = useWorkspaceServices()
  const Panel = debugPanelFor(backend)
  if (!Panel) return null
  return (
    // oxlint-disable-next-line react/static-components -- Made once with its backend, not here: the same panel each render.
    <Panel
      addTerminal={() => {
        const terminalId = commands.add()
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

// The rail and the Zen dock read the bell's badge themselves, so an unread change that leaves
// the badge as it was re-renders neither them nor the app around them.
const RailWithBadge = (
  props: Omit<ComponentProps<typeof SidebarRail>, "badge">,
): React.JSX.Element => <SidebarRail {...props} badge={useNotificationBadge()} />

const ZenDockWithBadge = (
  props: Omit<ComponentProps<typeof ZenDock>, "badge">,
): React.JSX.Element => <ZenDock {...props} badge={useNotificationBadge()} />

export const WorkspaceApp = (): React.JSX.Element => {
  const services = useWorkspaceServices()
  const { commands, canvas } = services
  const { hideSidebar, toggleSidebar, exitZen, changeView, add } = commands
  const desktop = useDesktop()
  const shell = useUiState((state) => {
    const { zen, sidebar, sidebarCollapsed } = state.shell
    return {
      zen: Boolean(zen),
      sidebar,
      sidebarCollapsed,
      sidebarVisible: sidebarVisible(state.shell, desktop),
      sidebarPanel: shownPanel(state.location.route.panel, services.backend.inbox !== undefined),
      fontSize: state.preferences.fontSize,
      enabledViews: state.preferences.enabledViews,
    }
  }, shallowEqual)
  const { zen, sidebar, sidebarCollapsed, sidebarPanel, fontSize, enabledViews } = shell
  const view = useWorkspaceState((workspace) => currentState(workspace).view)
  const voice = useDictationController(services)
  useKeyboard(voice?.dictation)
  const { backend } = services
  // The terminals' font follows Preferences.
  useEffect(() => {
    if ("setFont" in backend) backend.setFont({ size: fontSize })
  }, [backend, fontSize])
  const sidebarRail = (mobile = false): React.JSX.Element => (
    <RailWithBadge
      mobile={mobile}
      sidebarVisible={shell.sidebarVisible}
      sidebarPanel={sidebarPanel}
      zen={zen}
      toggleSidebar={toggleSidebar}
      hideSidebar={hideSidebar}
      inbox={services.backend.inbox !== undefined}
    />
  )
  return (
    <DictationContext.Provider value={voice}>
      <InboxHost active={sidebarPanel === "inbox" && shell.sidebarVisible}>
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
          <VisitorBar />
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
              mobileLabel={panelLabels[sidebarPanel]}
              mobileWide={sidebarPanel === "inbox"}
              mobileFinalFocusEl={() => sidebarToggle(sidebarPanel)}
              sidebar={<SidebarSection />}
            >
              <WorkspaceStage canvas={canvas} />
            </WorkspacePanels>
            {zen && (
              <ZenDockWithBadge
                view={view}
                enabledViews={enabledViews}
                inbox={services.backend.inbox !== undefined}
                onCreate={() => add()}
                onViewChange={(next) => {
                  if (next !== view) changeView(next)
                }}
                onNotifications={() =>
                  toggleSidebar(services.backend.inbox ? "inbox" : "notifications")
                }
                onExit={exitZen}
              />
            )}
          </div>
          <WorkspaceFooter />
          <WorkspaceOverlays />
          {voice && <DictationOverlay controller={voice} keys={dictationKeys()} />}
          <DebugSection />
        </main>
      </InboxHost>
    </DictationContext.Provider>
  )
}
