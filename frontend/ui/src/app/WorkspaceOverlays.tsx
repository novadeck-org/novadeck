import type { OfferedUninstall } from "@novadeck/core/desktop/uninstall"
import type { ForgeConnection, ForgeName } from "@novadeck/core/forges"
import type { AgentName } from "@novadeck/core/harnesses"
import type { Backend } from "@novadeck/core/port"
import { orderedTiles, tileOf } from "@novadeck/core/roster"
import { activeProject } from "@novadeck/core/state"
import type { SchemePreference, Tile } from "@novadeck/core/types"
import {
  memo,
  Suspense,
  type ComponentProps,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import { AskAgent } from "../feedback/AskAgent"
import { terminalElement } from "../interaction/dom"
import type { MurmurAddonValue } from "../preferences/MurmurAddon"
import { disconnectAgent, runUninstall } from "../preferences/uninstall"
import type { UninstallValue } from "../preferences/UninstallApp"
import type { VoiceAddon } from "../preferences/VoiceInput"
import { WelcomeDialog } from "../preferences/WelcomeDialog"
import { CrashLoopDialog } from "../shell/CrashLoopDialog"
import {
  ApprovalDialog,
  approvalView,
  sameApprovalView,
  type ApprovalView,
} from "../terminals/ApprovalDialog"
import { closeTeamTree, sameCloseTeamTree, type CloseTeamRow } from "../terminals/close-team"
import { CloseTerminalDialog } from "../terminals/CloseTerminalDialog"
import { MoveTeammateDialog } from "../terminals/MoveTeammateDialog"
import { visibleSwitcher } from "../terminals/recent"
import { TerminalSwitcher } from "../terminals/TerminalSwitcher"
import { schemeCountOfTheme } from "../theme/themes"
import { TourClosingCard } from "../tour/ClosingCard"
import { TourSpotlight } from "../tour/Spotlight"
import { TourConsentDialog } from "../tour/TourConsent"
import { CloseTeamRows } from "./CloseTeamRows"
import {
  useFeatureFlag,
  useUiState,
  useWorkspaceServices,
  useWorkspaceState,
} from "./controller/context"
import { useRouteDialog, type RouteDialog } from "./controller/useRouteDialog"
import { Preferences, TerminalSearch } from "./deferred-views"
import { dingOf } from "./ding"
import { moveQuestionOf, sameMoveQuestion } from "./move-question"
import { NameOffer } from "./NameOffer"
import {
  closeQuestion,
  crashLoopQuestion,
  currentContext,
  currentState,
  sameItems,
  shallowEqual,
} from "./selectors"
import { useTourOffer, useTourRun } from "./TourProvider"
import { chatViewOn, switchOffExperimental, type ExperimentalFeatures } from "./ui-store"
import { useForgeRuns } from "./useForgeRuns"
import { useInstalls } from "./useInstalls"

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

const closeTeamRows = (rows: readonly CloseTeamRow[]): React.JSX.Element => (
  <CloseTeamRows rows={rows} />
)

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

// The backend's idle-agent wait, for Preferences; undefined where it stops none.
const useHibernation = (
  hibernation: Backend["hibernation"],
):
  | { readonly minutes: number | null; readonly onChange: (minutes: number | null) => void }
  | undefined => {
  const minutes = useSyncExternalStore(
    hibernation?.after.subscribe ?? always,
    () => hibernation?.after.getSnapshot() ?? null,
  )
  return hibernation && { minutes, onChange: hibernation.set }
}

// Whether agents get worktrees, for Preferences; undefined where the backend has none.
const useWorktrees = (
  worktrees: Backend["worktrees"],
): { readonly enabled: boolean; readonly onChange: (enabled: boolean) => void } | undefined => {
  const enabled = useSyncExternalStore(
    worktrees?.enabled.subscribe ?? always,
    () => worktrees?.enabled.getSnapshot() ?? false,
  )
  return worktrees && { enabled, onChange: worktrees.set }
}

const noAsks: readonly never[] = []
// The first approval an agent asked for that waits on the person, with the terminals it names.
const useApproval = (approvals: Backend["approvals"]): ApprovalView | null => {
  const first = useSyncExternalStore(
    approvals?.pending.subscribe ?? always,
    () => approvals?.pending.getSnapshot() ?? noAsks,
  )[0]
  return useWorkspaceState(
    (workspace) => (first ? approvalView(first, workspace) : null),
    sameApprovalView,
  )
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

// The backend's forges and what each reads of its tool, for Preferences.
const useForges = (forges: Backend["forges"]): readonly ForgeConnection[] =>
  useSyncExternalStore(
    forges?.state.subscribe ?? always,
    () => forges?.state.getSnapshot() ?? noForges,
  )
const noForges: readonly never[] = []

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

// Preferences' Experimental switch: whether the desktop app follows experimental builds, which is
// the IS_EXPERIMENTAL flag, asked of it each time Preferences opens; undefined where the app
// offers no choice. The switch and the flag change at once, as the app remembers the choice.
// Turning it off turns agent worktrees and forge integrations off with it.
const useExperimental = (
  channel: NonNullable<Backend["updates"]>["channel"],
  features: ExperimentalFeatures,
  open: boolean,
): ExperimentalSetting | undefined => {
  const { setFeatureFlag } = useWorkspaceServices().commands
  const flag = useFeatureFlag("IS_EXPERIMENTAL")
  const [known, setKnown] = useState(false)
  // How many times the person flipped the switch: a read asked before the latest flip may
  // answer with the channel from before it, so it is not taken.
  const flips = useRef(0)
  useEffect(() => {
    if (!open || !channel) return undefined
    let current = true
    const asked = flips.current
    channel.get().then(
      (value) => {
        if (!current || flips.current !== asked) return
        setFeatureFlag("IS_EXPERIMENTAL", value === "experimental")
        if (value !== "experimental") switchOffExperimental(features)
        setKnown(true)
      },
      // A channel that can't be read counts as not experimental for worktrees.
      () => {
        if (current && flips.current === asked) switchOffExperimental(features)
      },
    )
    return () => {
      current = false
    }
  }, [open, channel, features, setFeatureFlag])
  return (
    channel && {
      on: known ? flag : undefined,
      onChange: (next) => {
        flips.current += 1
        setFeatureFlag("IS_EXPERIMENTAL", next)
        setKnown(true)
        channel.set(next ? "experimental" : "stable")
        if (!next) switchOffExperimental(features)
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

// What Preferences offers of uninstalling the app, asked of the desktop app each time Preferences
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

// The search dialog, which reads the terminals only while it is open, keeping the last it read
// for its way out: the overlays, which are mostly closed, never draw again for an agent's news.
const SearchHost = memo(
  ({
    open,
    ...props
  }: Omit<ComponentProps<typeof TerminalSearch>, "terminals">): React.JSX.Element => {
    const live = useWorkspaceState(
      (workspace) => (open ? orderedTiles(currentState(workspace).roster) : null),
      (a, b) => a === b || (a !== null && b !== null && sameItems(a, b)),
    )
    const [kept, setKept] = useState<readonly Tile[]>([])
    if (live !== null && live !== kept) setKept(live)
    return <TerminalSearch open={open} terminals={live ?? kept} {...props} />
  },
)

// The terminal switcher, which reads the terminals it lists itself, while it shows.
const SwitcherHost = ({
  ids,
  index,
  ...props
}: Omit<ComponentProps<typeof TerminalSwitcher>, "terminals" | "selected"> & {
  readonly ids: readonly string[]
  readonly index: number
}): React.JSX.Element => {
  const terminals = useWorkspaceState(
    (workspace) =>
      ids.flatMap((id) => {
        const tile = tileOf(currentState(workspace).roster, id)
        return tile ? [tile] : []
      }),
    sameItems,
  )
  return <TerminalSwitcher terminals={terminals} selected={ids[index]} {...props} />
}

// Dialogs and the terminal switcher, above the workspace.
export const WorkspaceOverlays = memo((): React.JSX.Element => {
  const { backend, commands, navigation, ui, workspace: workspaceStore } = useWorkspaceServices()
  const transcripts = useTranscripts(backend.transcripts)
  const hibernation = useHibernation(backend.hibernation)
  const worktrees = useWorktrees(backend.worktrees)
  const agents = useAgents(backend.agents)
  const installs = useInstalls(backend.agents)
  const driver = useTourRun()
  // Whether the project the tour ran in is still there, for its closing card to offer removing.
  const tourProjectId = driver.closing?.projectId ?? null
  const tourProjectThere = useWorkspaceState(
    // The workspace keeps one project at least: the last one isn't removed.
    (state) =>
      tourProjectId !== null &&
      state.projects.length > 1 &&
      state.projects.some(({ id }) => id === tourProjectId),
    Object.is,
  )
  const tour = useTourOffer()
  const forgeList = useForges(backend.forges)
  const forgeRuns = useForgeRuns(backend.forges)
  const approval = useApproval(backend.approvals)
  const voice = useVoice(backend.voice)
  const murmur = useMurmur(backend.murmur)
  const { go, closeDialog } = navigation
  const { chooseRecent, updatePreferences, openSearchResult, closeSwitcher } = commands
  const { confirmClose, cancelClose, retryAfterCrashLoop, dismissCrashLoop } = commands
  const { confirmMove, cancelMove } = commands
  const moveAsk = useUiState((state) => state.moveAsk)
  const moveQuestion = useWorkspaceState(
    (workspace) => moveQuestionOf(workspace, moveAsk),
    sameMoveQuestion,
  )
  const crashes = useUiState(crashLoopQuestion)
  const pending = useUiState((state) => state.closing)
  const closingTerminal = useWorkspaceState(
    (workspace) => closeQuestion({ closing: pending }, workspace) ?? null,
  )
  const closingTeam = useWorkspaceState(
    (workspace) => (closingTerminal ? closeTeamTree(workspace, closingTerminal.id) : null),
    (a, b) => a === b || (a !== null && b !== null && sameCloseTeamTree(a, b)),
  )
  const { projectName, context, view } = useWorkspaceState(
    (workspace) => ({
      projectName: activeProject(workspace)!.name,
      context: currentContext(workspace),
      view: currentState(workspace).view,
    }),
    shallowEqual,
  )
  const { dialog, section, preferences, switcher, agentFocus } = useUiState(
    (state) => ({
      dialog: state.location.route.dialog,
      section: state.location.route.section,
      preferences: state.preferences,
      agentFocus: state.agentFocus,
      switcher: visibleSwitcher(state.recent.switcher, context, state.location.route.dialog),
    }),
    shallowEqual,
  )
  const searchLabel = view === "canvas" ? "Canvas" : view === "grid" ? "Grid" : "Focus"
  const { searching, settings, onExitComplete, onLoaded } = useRouteDialog(dialog, context)
  const experimental = useExperimental(backend.updates?.channel, backend, settings)
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
  // As do the forges, whose tools and sign-ins may have changed while Preferences was shut.
  const refreshForges = backend.forges?.refresh
  useEffect(() => {
    if (settings) void refreshForges?.()
  }, [settings, refreshForges])
  // A forge's install or sign-in asked for in Preferences waits for it to close, as an agent's
  // install does.
  const queuedForgeRun = useRef<() => void>(undefined)
  useEffect(() => {
    const queued = queuedForgeRun.current
    if (!queued || settings) return
    queuedForgeRun.current = undefined
    queued()
  }, [settings])
  const afterClose = (run: () => void): void => {
    if (!settings) return run()
    queuedForgeRun.current = run
    closeDialog()
  }
  // An install asked for in Preferences, which starts once Preferences has closed: closing it
  // goes back in the history, which would undo the terminal's own step there were it taken first.
  const queuedInstall = useRef<{ agent: AgentName; command: string }>(undefined)
  const { install } = installs
  useEffect(() => {
    const queued = queuedInstall.current
    if (!queued || settings) return
    queuedInstall.current = undefined
    install(queued.agent, queued.command)
  }, [settings, install])
  return (
    <>
      {backend.agents && (
        <WelcomeDialog
          open={agents.welcome}
          agents={agents.list}
          onChange={backend.agents.set}
          onInstall={installs.install}
          installing={installs.installing}
          transcripts={transcripts}
          {...(schemeCountOfTheme(preferences.appearance.theme) > 1
            ? {
                scheme: {
                  value: preferences.appearance.scheme,
                  onChange: (scheme: SchemePreference) => {
                    const current = ui.getSnapshot().preferences
                    updatePreferences({
                      ...current,
                      appearance: { ...current.appearance, scheme },
                    })
                  },
                },
              }
            : {})}
          {...(backend.conversations
            ? {
                chatView: {
                  enabled: preferences.chatView,
                  onChange: (chatView: boolean) =>
                    updatePreferences(
                      { ...ui.getSnapshot().preferences, chatView },
                      { answersOffer: false },
                    ),
                },
              }
            : {})}
          onDone={() => {
            // The welcome dialog offers Agent Chat too. Starting has applied its choice already:
            // kept on, the offer is moot and answered; unticked on purpose, it is no answer, so
            // the offer only waits out this run and comes at a later launch.
            if (chatViewOn(ui.getSnapshot())) commands.declineChatOffer()
            else commands.holdChatOffer()
            backend.agents?.finishWelcome()
          }}
        />
      )}
      {driver.shown && (
        <TourSpotlight
          {...driver.shown}
          onPause={driver.pause}
          onResume={driver.resume}
          onSkip={driver.skip}
          onNext={driver.next}
          onEnd={driver.end}
          onBack={driver.back}
        />
      )}
      {driver.closing && (
        <TourClosingCard
          agent={driver.closing.agent}
          canRemove={tourProjectThere}
          {...(backend.pickDirectory && {
            onOpen: () => {
              const closing = driver.closing
              const before = workspaceStore.getSnapshot().activeProjectId
              commands.openFolder().then(
                () => {
                  const after = workspaceStore.getSnapshot().activeProjectId
                  // A folder picked, other than the tour's: its agent starts there, and the card
                  // goes.
                  if (!closing || after === before || after === closing.projectId) return
                  commands.add({ command: closing.agent })
                  driver.close()
                },
                // The card stays, for another try.
                (error: unknown) => console.error("Novadeck couldn't open that folder:", error),
              )
            },
          })}
          onRemove={() => {
            if (driver.closing?.projectId) commands.removeProject(driver.closing.projectId)
          }}
          onClose={driver.close}
        />
      )}
      {tour && (
        <TourConsentDialog
          consent={tour.consent}
          agents={tour.agents}
          connecting={tour.connecting}
          onAgent={tour.choose}
          onStart={tour.start}
          onStartAgent={tour.startAgent}
          onClose={tour.close}
        />
      )}
      <CrashLoopDialog
        crashes={crashes || null}
        onRetry={retryAfterCrashLoop}
        onDismiss={dismissCrashLoop}
      />
      <CloseTerminalDialog
        terminal={closingTerminal}
        keepsHistory={backend.history !== undefined}
        team={closingTeam}
        teamRows={closeTeamRows}
        onConfirm={confirmClose}
        onCancel={cancelClose}
        returnFocus={(id) =>
          terminalElement(id)?.querySelector<HTMLElement>("[data-terminal-input]") ?? null
        }
      />
      <MoveTeammateDialog
        question={moveQuestion}
        onConfirm={confirmMove}
        onCancel={cancelMove}
        returnFocus={(id) => terminalElement(id)?.querySelector<HTMLElement>("button") ?? null}
      />
      {backend.approvals && (
        <ApprovalDialog approval={approval} onAnswer={backend.approvals.answer} />
      )}
      <NameOffer />
      {backend.feedback?.ask && <AskAgent feedback={backend.feedback} />}
      {switcher && (
        <SwitcherHost
          mode={switcher.mode}
          project={projectName}
          onClose={closeSwitcher}
          onSelect={chooseRecent}
          ids={switcher.ids}
          index={switcher.index}
        />
      )}
      {/* Each dialog loads on its own; one opened before its chunk arrives appears once it does. */}
      <Suspense fallback={null}>
        <Loaded dialog="search" onLoaded={onLoaded} />
        <SearchHost
          onExitComplete={onExitComplete}
          open={searching}
          key={context}
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
          focusAgent={agentFocus}
          onFocusedAgent={() => ui.update((state) => ({ ...state, agentFocus: null }))}
          onTabChange={(next) => go({ section: next })}
          onChange={updatePreferences}
          onClose={closeDialog}
          {...(transcripts ? { transcripts } : {})}
          {...(hibernation ? { hibernation } : {})}
          {...(worktrees ? { worktrees } : {})}
          notices={backend.notices !== undefined}
          systemSounds={backend.notices?.sounds === true}
          hearSound={dingOf(backend, ui).preview}
          chat={backend.conversations !== undefined}
          {...(voice ? { voice } : {})}
          {...(murmur ? { murmur } : {})}
          {...(experimental ? { experimental } : {})}
          {...(version ? { version } : {})}
          {...(backend.openLogs ? { logs: backend.openLogs } : {})}
          {...(uninstall ? { uninstall } : {})}
          {...(backend.forges
            ? {
                forges: {
                  list: forgeList,
                  onChange: backend.forges.set,
                  onInstall: (forge: ForgeName, command: string) => {
                    afterClose(() => forgeRuns.install(forge, command))
                  },
                  installing: forgeRuns.installing,
                  onSignIn: (forge: ForgeName, host: string, command: string) => {
                    afterClose(() => forgeRuns.signIn(forge, host, command))
                  },
                  signingIn: forgeRuns.signingIn,
                },
              }
            : {})}
          {...(backend.agents
            ? {
                agents: {
                  list: agents.list,
                  onChange: backend.agents.set,
                  // Preferences closes, for the person to watch the installer in its terminal;
                  // pressed as it is already closing, the install starts at once.
                  onInstall: (agent: AgentName, command: string) => {
                    if (!settings) return install(agent, command)
                    queuedInstall.current = { agent, command }
                    closeDialog()
                  },
                  installing: installs.installing,
                },
              }
            : {})}
        />
      </Suspense>
    </>
  )
})
