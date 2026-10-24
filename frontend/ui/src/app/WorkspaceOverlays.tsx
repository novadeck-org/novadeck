import type { AgentName } from "@novadeck/core/harnesses"
import type { Backend } from "@novadeck/core/port"
import { orderedTiles } from "@novadeck/core/roster"
import { activeProject } from "@novadeck/core/state"
import type { OfferedUninstall } from "@novadeck/core/uninstall"
import {
  memo,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"

import { terminalElement } from "../interaction/dom"
import type { MurmurAddonValue } from "../preferences/MurmurAddon"
import { disconnectAgent, runUninstall } from "../preferences/uninstall"
import type { UninstallValue } from "../preferences/UninstallApp"
import type { VoiceAddon } from "../preferences/VoiceInput"
import { WelcomeDialog } from "../preferences/WelcomeDialog"
import { CrashLoopDialog } from "../shell/CrashLoopDialog"
import { CloseTerminalDialog } from "../terminals/CloseTerminalDialog"
import { visibleSwitcher } from "../terminals/recent"
import { TerminalSwitcher } from "../terminals/TerminalSwitcher"
import {
  useFeatureFlag,
  useUiState,
  useWorkspaceServices,
  useWorkspaceState,
} from "./controller/context"
import { useRouteDialog, type RouteDialog } from "./controller/useRouteDialog"
import { Preferences, TerminalSearch } from "./deferred-views"
import { NameOffer } from "./NameOffer"
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
):
  | {
      readonly enabled: boolean
      readonly available: boolean
      readonly onChange: (enabled: boolean) => void
    }
  | undefined => {
  const enabled = useSyncExternalStore(
    transcripts?.enabled.subscribe ?? always,
    () => transcripts?.enabled.getSnapshot() ?? false,
  )
  return transcripts && { enabled, available: transcripts.available, onChange: transcripts.set }
}

const noAgents: readonly never[] = []
// The backend's connectable agents and whether to offer them at first run.
const useAgents = (agents: Backend["agents"]) => {
  const list = useSyncExternalStore(
    agents?.state.subscribe ?? always,
    () => agents?.state.getSnapshot() ?? noAgents,
  )
  const welcome = useSyncExternalStore(
    agents?.welcome.subscribe ?? always,
    () => agents?.welcome.getSnapshot() ?? false,
  )
  return { list, welcome }
}

// The backend's voice input addon for Preferences; undefined where it has none.
const useVoice = (voice: Backend["voice"]): VoiceAddon | undefined => {
  const state = useSyncExternalStore(voice?.state.subscribe ?? always, () =>
    voice?.state.getSnapshot(),
  )
  return voice && state && { state, actions: voice }
}

// The backend's murmur addon for Preferences; undefined where it has none.
const useMurmur = (murmur: Backend["murmur"]): MurmurAddonValue | undefined => {
  const state = useSyncExternalStore(murmur?.state.subscribe ?? always, () =>
    murmur?.state.getSnapshot(),
  )
  return murmur && state && { state, actions: murmur }
}

type ExperimentalSetting = {
  readonly on: boolean | undefined
  readonly onChange: (on: boolean) => void
}

// Preferences' Experimental switch: whether the desktop app follows early builds, which is
// the IS_EXPERIMENTAL flag, asked of it each time Preferences opens; undefined where the app
// offers no choice. The switch and the flag change at once, as the app remembers the choice.
const useExperimental = (
  channel: NonNullable<Backend["updates"]>["channel"],
  open: boolean,
): ExperimentalSetting | undefined => {
  const { setFeatureFlag } = useWorkspaceServices().commands
  const flag = useFeatureFlag("IS_EXPERIMENTAL")
  const [known, setKnown] = useState(false)
  useEffect(() => {
    if (!open || !channel) return undefined
    let current = true
    channel.get().then(
      (value) => {
        if (!current) return
        setFeatureFlag("IS_EXPERIMENTAL", value === "early")
        setKnown(true)
      },
      () => {},
    )
    return () => {
      current = false
    }
  }, [open, channel, setFeatureFlag])
  return (
    channel && {
      on: known ? flag : undefined,
      onChange: (next) => {
        setFeatureFlag("IS_EXPERIMENTAL", next)
        setKnown(true)
        channel.set(next ? "early" : "stable")
      },
    }
  )
}

// The desktop app's version, for Preferences, asked of it each time Preferences opens;
// undefined until it has said, and where it never does.
const useVersion = (version: Backend["version"], open: boolean): string | undefined => {
  const [value, setValue] = useState<string>()
  useEffect(() => {
    if (!open || !version) return undefined
    let current = true
    version().then(
      (known) => {
        if (current) setValue(known)
      },
      () => {},
    )
    return () => {
      current = false
    }
  }, [open, version])
  return value
}

// What Preferences offers of uninstalling the app, asked of the host each time Preferences
// opens; undefined until it has said, and where it offers nothing. Running it disconnects
// the connected agents first, one by one.
const useUninstall = (
  backend: Pick<Backend, "uninstall" | "agents">,
  connected: readonly AgentName[],
  open: boolean,
): UninstallValue | undefined => {
  const { uninstall, agents } = backend
  const [plan, setPlan] = useState<OfferedUninstall>()
  useEffect(() => {
    if (!open || !uninstall) return undefined
    let current = true
    uninstall.plan().then(
      (known) => {
        if (current) setPlan(known.kind === "unavailable" ? undefined : known)
      },
      () => {
        if (current) setPlan(undefined)
      },
    )
    return () => {
      current = false
    }
  }, [open, uninstall])
  if (!uninstall || !plan) return undefined
  return {
    plan,
    connected,
    quit: uninstall.quit,
    run: ({ keepData, onDisconnected }) =>
      runUninstall({
        connected,
        disconnect: (agent) =>
          agents
            ? disconnectAgent(agents, agent)
            : Promise.resolve("It can't be disconnected here."),
        uninstall: uninstall.run,
        keepData,
        onDisconnected,
      }),
  }
}

// Dialogs and the terminal switcher, above the workspace.
export const WorkspaceOverlays = memo((): React.JSX.Element => {
  const { backend, commands, navigation } = useWorkspaceServices()
  const transcripts = useTranscripts(backend.transcripts)
  const agents = useAgents(backend.agents)
  const voice = useVoice(backend.voice)
  const murmur = useMurmur(backend.murmur)
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
    (workspace) => orderedTiles(currentState(workspace).roster),
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
  const experimental = useExperimental(backend.updates?.channel, settings)
  const version = useVersion(backend.version, settings)
  const connectedAgents = useMemo(
    () => agents.list.filter((agent) => agent.connected).map((agent) => agent.agent),
    [agents.list],
  )
  const uninstall = useUninstall(backend, connectedAgents, settings)
  // Preferences shows what is installed and connected now.
  const refreshAgents = backend.agents?.refresh
  useEffect(() => {
    if (settings) refreshAgents?.()
  }, [settings, refreshAgents])
  return (
    <>
      {backend.agents && (
        <WelcomeDialog
          open={agents.welcome}
          agents={agents.list}
          onChange={backend.agents.set}
          transcripts={transcripts}
          onDone={backend.agents.finishWelcome}
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
      <NameOffer />
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
          notices={backend.notices !== undefined}
          chat={backend.conversations !== undefined}
          {...(voice ? { voice } : {})}
          {...(murmur ? { murmur } : {})}
          {...(experimental ? { experimental } : {})}
          {...(version ? { version } : {})}
          {...(backend.openLogs ? { logs: backend.openLogs } : {})}
          {...(uninstall ? { uninstall } : {})}
          {...(backend.agents
            ? { agents: { list: agents.list, onChange: backend.agents.set } }
            : {})}
        />
      </Suspense>
    </>
  )
})
