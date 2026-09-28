import { memo, Suspense, useEffect, useLayoutEffect, useSyncExternalStore } from "react"

import type { Backend } from "../backend/port"
import { terminalElement } from "../interaction/dom"
import { orderedTerminals } from "../model/roster"
import { activeProject } from "../model/state"
import type { TerminalMetadata } from "../model/types"
import { OnboardingDialog } from "../preferences/OnboardingDialog"
import { CrashLoopDialog } from "../shell/CrashLoopDialog"
import { CloseTerminalDialog } from "../terminals/CloseTerminalDialog"
import { visibleSwitcher } from "../terminals/recent"
import { TerminalSwitcher } from "../terminals/TerminalSwitcher"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { useRouteDialog, type RouteDialog } from "./controller/useRouteDialog"
import { Preferences, TerminalSearch } from "./deferred-views"
import {
  closeQuestion,
  crashLoopQuestion,
  currentContext,
  currentState,
  sameItems,
  shallowEqual,
} from "./selectors"

// Rendered beside a deferred dialog, so it mounts only once the dialog's view has loaded.
const Loaded = ({
  dialog,
  onLoaded,
}: {
  readonly dialog: RouteDialog
  readonly onLoaded: (dialog: RouteDialog) => void
}): null => {
  useLayoutEffect(() => onLoaded(dialog), [dialog, onLoaded])
  return null
}

const always = (): (() => void) => () => {}
// The backend's transcript setting, for Preferences; undefined where it keeps none.
const useTranscripts = (
  transcripts: Backend["transcripts"],
): { readonly enabled: boolean; readonly onChange: (enabled: boolean) => void } | undefined => {
  const enabled = useSyncExternalStore(
    transcripts?.enabled.subscribe ?? always,
    () => transcripts?.enabled.getSnapshot() ?? false,
  )
  return transcripts && { enabled, onChange: transcripts.set }
}

const noAgents: readonly never[] = []
// The backend's connectable agents and whether to offer them at first run.
const useAgents = (agents: Backend["agents"]) => {
  const list = useSyncExternalStore(
    agents?.state.subscribe ?? always,
    () => agents?.state.getSnapshot() ?? noAgents,
  )
  const onboarding = useSyncExternalStore(
    agents?.onboarding.subscribe ?? always,
    () => agents?.onboarding.getSnapshot() ?? false,
  )
  return { list, onboarding }
}

// Dialogs and the terminal switcher, above the workspace.
export const WorkspaceOverlays = memo((): React.JSX.Element => {
  const { backend, commands, navigation } = useWorkspaceServices()
  const transcripts = useTranscripts(backend.transcripts)
  const agents = useAgents(backend.agents)
  const { go, closeDialog } = navigation
  const { chooseRecent, updatePreferences, openSearchResult, closeSwitcher } = commands
  const { confirmClose, cancelClose, retryAfterCrashLoop, dismissCrashLoop } = commands
  const crashes = useUiState(crashLoopQuestion)
  const pending = useUiState((state) => state.closing)
  const closingTerminal = useWorkspaceState(
    (workspace) => closeQuestion({ closing: pending }, workspace) ?? null,
  )
  const { projectName, context, view } = useWorkspaceState(
    (workspace) => ({
      projectName: activeProject(workspace)!.name,
      context: currentContext(workspace),
      view: currentState(workspace).view,
    }),
    shallowEqual,
  )
  const ordered = useWorkspaceState(
    (workspace): TerminalMetadata[] => orderedTerminals(currentState(workspace).roster),
    sameItems,
  )
  const { dialog, section, preferences, switcher } = useUiState(
    (state) => ({
      dialog: state.location.route.dialog,
      section: state.location.route.section,
      preferences: state.preferences,
      switcher: visibleSwitcher(state.recent.switcher, context, state.location.route.dialog),
    }),
    shallowEqual,
  )
  const searchLabel = view === "canvas" ? "Canvas" : view === "grid" ? "Grid" : "Focus"
  const { searching, settings, onExitComplete, onLoaded } = useRouteDialog(dialog, context)
  // Preferences shows what is installed and connected now.
  const refreshAgents = backend.agents?.refresh
  useEffect(() => {
    if (settings) refreshAgents?.()
  }, [settings, refreshAgents])
  return (
    <>
      {backend.agents && (
        <OnboardingDialog
          open={agents.onboarding}
          agents={agents.list}
          onChange={backend.agents.set}
          onDone={backend.agents.finishOnboarding}
        />
      )}
      <CrashLoopDialog
        crashes={crashes || null}
        onRetry={retryAfterCrashLoop}
        onDismiss={dismissCrashLoop}
      />
      <CloseTerminalDialog
        terminal={closingTerminal}
        onConfirm={confirmClose}
        onCancel={cancelClose}
        returnFocus={(id) =>
          terminalElement(id)?.querySelector<HTMLElement>("[data-terminal-input]") ?? null
        }
      />
      {switcher && (
        <TerminalSwitcher
          mode={switcher.mode}
          project={projectName}
          onClose={closeSwitcher}
          onSelect={chooseRecent}
          terminals={switcher.ids.flatMap((id) => {
            const terminal = ordered.find((item) => item.id === id)
            return terminal ? [terminal] : []
          })}
          selected={switcher.ids[switcher.index]}
        />
      )}
      {/* Each dialog loads on its own; one opened before its chunk arrives appears once it does. */}
      <Suspense fallback={null}>
        <Loaded dialog="search" onLoaded={onLoaded} />
        <TerminalSearch
          onExitComplete={onExitComplete}
          open={searching}
          key={context}
          terminals={ordered}
          destination={searchLabel}
          onSelect={openSearchResult}
          onClose={closeDialog}
        />
      </Suspense>
      <Suspense fallback={null}>
        <Loaded dialog="preferences" onLoaded={onLoaded} />
        <Preferences
          key={`preferences/${context}`}
          onExitComplete={onExitComplete}
          open={settings}
          value={preferences}
          tab={section}
          onTabChange={(next) => go({ section: next })}
          onChange={updatePreferences}
          onClose={closeDialog}
          {...(transcripts ? { transcripts } : {})}
          {...(backend.agents
            ? { agents: { list: agents.list, onChange: backend.agents.set } }
            : {})}
        />
      </Suspense>
    </>
  )
})
