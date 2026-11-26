import type { OfferedUninstall } from "@novadeck/core/desktop/uninstall"
import type { ForgeConnection, ForgeName } from "@novadeck/core/forges"
import type { AgentName } from "@novadeck/core/harnesses"
import { isOnBar } from "@novadeck/core/items"
import type { AgentMode, Backend, BundledPiFetchState } from "@novadeck/core/port"
import { orderedTiles, tileOf } from "@novadeck/core/roster"
import { activeProject } from "@novadeck/core/state"
import type { SchemePreference, Tile } from "@novadeck/core/types"
import { TourConsentDialog } from "@novadeck/tour/TourConsent"
import { useTourOffer, useTourRun } from "@novadeck/tour/TourProvider"
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
import { AskToastSample } from "../inbox/InboxToasts"
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
import { CloseTeamRows } from "./CloseTeamRows"
import {
  useFeatureFlag,
  useUiState,
  useWorkspaceServices,
  useWorkspaceState,
} from "./controller/context"
import { useRouteDialog, type RouteDialog } from "./controller/useRouteDialog"
import { Preferences, TerminalSearch, TourClosingCard, TourStage } from "./deferred-views"
import { dingOf } from "./ding"
import { moveQuestionOf, sameMoveQuestion } from "./move-question"
import { useShownMurmur } from "./murmur-shown"
import { NameOffer } from "./NameOffer"
import {
  closeQuestion,
  crashLoopQuestion,
  currentContext,
  currentState,
  sameItems,
  shallowEqual,
} from "./selectors"
import {
  chatViewOn,
  revealExperimental,
  switchOffExperimental,
  switchOffMurmur,
  type ExperimentalFeatures,
} from "./ui-store"
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

// How agents work with each other, for Preferences; undefined where the backend has no such setting.
const useAgentMode = (
  agentMode: Backend["agentMode"],
): { readonly mode: AgentMode; readonly onChange: (mode: AgentMode) => void } | undefined => {
  const mode = useSyncExternalStore(
    agentMode?.mode.subscribe ?? always,
    () => agentMode?.mode.getSnapshot() ?? "herd",
  )
  return agentMode && { mode, onChange: agentMode.set }
}

// Whether Solo and Swarm may be picked, for Preferences; undefined where the backend has none.
const useAgentModes = (
  agentModes: Backend["agentModes"],
): { readonly enabled: boolean; readonly onChange: (enabled: boolean) => void } | undefined => {
  const enabled = useSyncExternalStore(
    agentModes?.enabled.subscribe ?? always,
    () => agentModes?.enabled.getSnapshot() ?? false,
  )
  return agentModes && { enabled, onChange: agentModes.set }
}

// Whether Murmur shows and may run, for Preferences; undefined where the backend has no Murmur or
// no switch for it.
const useMurmurSwitch = (
  backend: Pick<Backend, "murmur" | "murmurSwitch">,
): { readonly enabled: boolean; readonly onChange: (enabled: boolean) => void } | undefined => {
  const { murmurSwitch } = backend
  const enabled = useSyncExternalStore(
    murmurSwitch?.enabled.subscribe ?? always,
    () => murmurSwitch?.enabled.getSnapshot() ?? false,
  )
  return backend.murmur && murmurSwitch && { enabled, onChange: murmurSwitch.set }
}

// Whether the shipping gate is on, for Preferences; undefined where the backend has none.
const useShippingGate = (
  shippingGate: Backend["shippingGate"],
): { readonly enabled: boolean; readonly onChange: (enabled: boolean) => void } | undefined => {
  const enabled = useSyncExternalStore(
    shippingGate?.enabled.subscribe ?? always,
    () => shippingGate?.enabled.getSnapshot() ?? false,
  )
  return shippingGate && { enabled, onChange: shippingGate.set }
}

// Whether Novadeck's own pi is on, and where its download stands, for Preferences; undefined
// where the backend has none, as a runner from before it.
const useBundledPi = (
  bundledPi: Backend["bundledPi"],
):
  | {
      readonly enabled: boolean
      readonly fetch: BundledPiFetchState
      readonly onChange: (enabled: boolean) => void
    }
  | undefined => {
  const enabled = useSyncExternalStore(
    bundledPi?.enabled.subscribe ?? always,
    () => bundledPi?.enabled.getSnapshot() ?? false,
  )
  const fetch = useSyncExternalStore(
    bundledPi?.fetch.subscribe ?? always,
    () => bundledPi?.fetch.getSnapshot() ?? offFetch,
  )
  return bundledPi && { enabled, fetch, onChange: bundledPi.set }
}
const offFetch: BundledPiFetchState = { state: "off" }

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
// The first approval an agent asked for that waits on the person, with the terminals it names;
// one the person put aside unanswered (a newer Novadeck's) waits, unshown, until they go to the
// terminal that asked.
const useApproval = (
  approvals: Backend["approvals"],
  setAside: ReadonlyMap<string, string>,
): ApprovalView | null => {
  const first = useSyncExternalStore(
    approvals?.pending.subscribe ?? always,
    () => approvals?.pending.getSnapshot() ?? noAsks,
  ).find((each) => !setAside.has(each.requestId))
  return useWorkspaceState(
    (workspace) => (first ? approvalView(first, workspace) : null),
    sameApprovalView,
  )
}

const noAgents: readonly never[] = []
// The backend's connectable agents and whether to offer them at first run.
// The welcome is the app's first window's: a window that is not the first never offers it.
const useAgents = (agents: Backend["agents"], extraWindow: boolean) => {
  const list = useSyncExternalStore(
    agents?.state.subscribe ?? always,
    () => agents?.state.getSnapshot() ?? noAgents,
  )
  const welcome = useSyncExternalStore(
    agents?.welcome.subscribe ?? always,
    () => agents?.welcome.getSnapshot() ?? false,
  )
  return { list, welcome: welcome && !extraWindow }
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
  readonly revealed: boolean
  readonly onReveal: () => void
}

// Preferences' Experimental switch: whether the desktop app follows experimental builds, which is
// the IS_EXPERIMENTAL flag, asked of it each time Preferences opens; undefined where the app
// offers no choice. The switch and the flag change at once, as the app remembers the choice.
// Turning it off turns agent modes, the shipping gate and Novadeck's own pi off with it, and
// Murmur too, though only on the person's flip (`switchOffMurmur`).
// The switch is hidden while off until the person taps the version ten times; once revealed, or
// on at any time in this run, it stays until the next launch (`experimentalRevealed`).
const useExperimental = (
  channel: NonNullable<Backend["updates"]>["channel"],
  features: ExperimentalFeatures & Pick<Backend, "murmurSwitch">,
  open: boolean,
): ExperimentalSetting | undefined => {
  const { commands, ui } = useWorkspaceServices()
  const { setFeatureFlag } = commands
  const flag = useFeatureFlag("IS_EXPERIMENTAL")
  const revealed = useUiState((state) => state.experimentalRevealed)
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
      // A channel that can't be read counts as not experimental for these features.
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
      revealed,
      onReveal: () => revealExperimental(ui),
      onChange: (next) => {
        flips.current += 1
        setFeatureFlag("IS_EXPERIMENTAL", next)
        setKnown(true)
        channel.set(next ? "experimental" : "stable")
        if (!next) {
          switchOffExperimental(features)
          switchOffMurmur(features.murmurSwitch)
        }
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
  const agentModes = useAgentModes(backend.agentModes)
  const agentMode = useAgentMode(backend.agentMode)
  const shippingGate = useShippingGate(backend.shippingGate)
  const bundledPi = useBundledPi(backend.bundledPi)
  const murmurSwitch = useMurmurSwitch(backend)
  const worktrees = useWorktrees(backend.worktrees)
  const agents = useAgents(backend.agents, backend.projectWindows?.extra === true)
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
  // Approvals put aside unanswered, as this build can't answer them, by the terminal that asked:
  // going to that terminal brings its approval back.
  const [setAside, setSetAside] = useState<ReadonlyMap<string, string>>(new Map())
  const selectedTerminal = useWorkspaceState((workspace) => currentState(workspace).selected)
  // Going to a terminal, as the selection moves there, brings back what it asked.
  const [passed, setPassed] = useState(selectedTerminal)
  if (passed !== selectedTerminal) {
    setPassed(selectedTerminal)
    if ([...setAside.values()].includes(selectedTerminal))
      setSetAside(new Map([...setAside].filter(([, asker]) => asker !== selectedTerminal)))
  }
  const approval = useApproval(backend.approvals, setAside)
  const voice = useVoice(backend.voice)
  const murmur = useMurmur(useShownMurmur(backend))
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
        <Suspense fallback={null}>
          <TourStage
            {...driver.shown}
            onCaption={driver.captioned}
            onTouch={driver.touched}
            onShow={driver.show}
            onEnd={driver.end}
            onBack={driver.back}
          />
        </Suspense>
      )}
      {driver.closing && (
        <Suspense fallback={null}>
          <TourClosingCard
            canRemove={tourProjectThere}
            keepError={driver.closing.keepError}
            onRetryKeep={driver.retryKeep}
            onKeep={() => {
              const closing = driver.closing
              driver.close()
              if (!closing) return
              // Focus puts the agent's terminal and the live game side by side, where Canvas lays
              // the page's pane over the terminal. Ignored where Focus isn't enabled.
              commands.changeView("focus")
              if (closing.projectId) commands.revealTerminal(closing.terminalId, closing.projectId)
              else commands.reveal(closing.terminalId)
              const page = workspaceStore
                .getSnapshot()
                .projects.flatMap((project) => project.history)
                .flatMap(({ state }) => state.items)
                .find((item) => item.kind === "page" && isOnBar(item, closing.terminalId))
              if (page) commands.openBarTab(closing.terminalId, page.id)
            }}
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
        </Suspense>
      )}
      {tour && (
        <TourConsentDialog
          consent={tour.consent}
          agent={tour.agent}
          onRetry={tour.retry}
          onStart={tour.start}
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
        <ApprovalDialog
          approval={approval}
          onAnswer={backend.approvals.answer}
          onSetAside={(requestId) =>
            setSetAside((held) => new Map(held).set(requestId, approval?.asker?.id ?? ""))
          }
        />
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
          askToast={<AskToastSample />}
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
          {...(agentModes ? { agentModes } : {})}
          {...(agentMode ? { agentMode } : {})}
          {...(shippingGate ? { shippingGate } : {})}
          {...(bundledPi ? { bundledPi } : {})}
          {...(murmurSwitch ? { murmurSwitch } : {})}
          {...(worktrees ? { worktrees } : {})}
          tour={tour !== undefined}
          notices={backend.notices !== undefined}
          screenReaderKnown={backend.screenReader !== undefined}
          scalable={backend.showScale !== undefined}
          awake={backend.keepAwake !== undefined}
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
