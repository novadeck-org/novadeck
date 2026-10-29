import { handleText } from "@novadeck/core/handle"
import type {
  AgentConnection,
  Backend,
  BackendAction,
  BackendConnectionState,
  BackendSink,
  Approval,
  TerminalKey,
  ThemeSource,
} from "@novadeck/core/port"
import { createTerminalRegistry } from "@novadeck/core/registry"
import { createStore } from "@novadeck/core/store"
import { createTelemetryStore, dropTerminal, setUsage } from "@novadeck/core/telemetry"
import { sameTitleSource } from "@novadeck/core/title-source"
import type {
  AgentUsage,
  TerminalMetadata,
  TerminalStatus,
  TitleSource,
  Workspace,
} from "@novadeck/core/types"
import type {
  AgentIntegration,
  Approval as RunnerApproval,
  TerminalExit,
  PageLook,
  TerminalRequest,
  TerminalRequestAnswer,
  TerminalSummary,
} from "@novadeck/protocol"
import {
  hasCode,
  type AttachedTerminal,
  type Runner,
  type TerminalWatchItem,
} from "@novadeck/runner-client"
import { createTerminalMount } from "@novadeck/terminal-views/mount"
import { createTerminalViews } from "@novadeck/terminal/view"
import type { WireStatus } from "@novadeck/wire/client"

import {
  defaultQuickExitMs,
  exitStatus,
  restartable,
  sameStatus,
  terminalActivity,
} from "./activity"
import { createBootProgress } from "./boot-progress"
import { createRunnerCompanions } from "./companions"
import { createRunnerConversations } from "./conversations"
import { runnerFeedback } from "./feedback"
import { createRunnerInbox } from "./inbox"
import { createRunnerItems } from "./items"
import { answerLook, type Looks } from "./looks"
import { createRunnerMessages } from "./messages"
import { createRunnerMurmur } from "./murmur"
import { resumableProgram } from "./resumable"
import { createSessionSaves } from "./saves"
import {
  cleanlyExited,
  lostTerminals,
  runnerSeed,
  runnerTelemetry,
  runnerTerminal,
  startingTerminal,
  terminalRuns,
  type RunnerListing,
} from "./seed"
import { createRunnerSource } from "./source"
import { viewOptions } from "./view-options"
import { createRunnerVoice } from "./voice"

/** Resolves after `ms` milliseconds. */
export const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

// The part of the runner client the adapter uses.
export type RunnerApi = Pick<
  Runner,
  | "watch"
  | "projects"
  | "sessions"
  | "terminals"
  | "agents"
  | "messages"
  | "inbox"
  | "feedback"
  | "voice"
  | "murmur"
  | "settings"
  | "companions"
>

export type RunnerBackendOptions = {
  readonly newId?: () => string
  // How long saving waits for more changes, in milliseconds.
  readonly saveDelay?: number
  // How long a close waits for the runner's answer before the terminal comes back, still
  // closing, in milliseconds.
  readonly closeAnswerMs?: number
  // A shell that exits sooner than this after starting counts as failing to start, in
  // milliseconds.
  readonly quickExitMs?: number
  readonly pickDirectory?: () => Promise<string | null>
  // Where the host's window follows the page's appearance.
  readonly showAppearance?: Backend["showAppearance"]
  // Where the host shows desktop notifications.
  readonly notices?: Backend["notices"]
  // Where the host shows the Inbox count on the app icon.
  readonly badge?: Backend["badge"]
  readonly windowFocus?: Backend["windowFocus"]
  // Where the host offers the update it has downloaded.
  readonly updates?: Backend["updates"]
  readonly version?: Backend["version"]
  readonly openLogs?: Backend["openLogs"]
  // Where the host sends the person's feedback notes.
  readonly feedback?: Backend["feedback"]
  readonly sandbox?: Backend["sandbox"]
  readonly whatsNew?: Backend["whatsNew"]
  readonly portable?: Backend["portable"]
  readonly uninstall?: Backend["uninstall"]
  // Where the host lets the page finish its saves before its window closes or the app
  // quits; returns the undo.
  readonly beforeQuit?: (save: () => Promise<void>) => () => void
  // Whether the host can load web pages in the pane, as the desktop app can, how it takes
  // a picture of one, for it to rest as, and how it makes one a phone's.
  readonly livePages?: boolean
  readonly pagePicture?: NonNullable<Backend["companions"]>["picture"]
  // Where the host loads a page afresh, out of sight, to picture it for an agent's look.
  readonly pageLook?: Looks["fresh"]
  readonly pagePhone?: NonNullable<Backend["companions"]>["phone"]
  readonly now?: () => number
  // Whether the runner keeps transcripts, as it said at startup; unknown when absent.
  readonly transcripts?: boolean
  // Whether it can keep them at all, as it said at startup: they are saved only
  // encrypted, and with nothing to keep the key safe it keeps none. Available when absent.
  readonly transcriptsAvailable?: boolean
  // The agents the runner can connect, and whether the person has seen the first-run
  // choice, as it said at startup; agents are not offered when absent.
  readonly agents?: readonly AgentIntegration[]
  readonly welcomed?: boolean
  // The order the person dragged the Inbox's rows into, as the runner said at startup; the
  // rows keep the Inbox's own order, and can't be dragged, when absent.
  readonly inboxOrder?: readonly string[]
  // The page's theme, which its terminals draw in; tests pass `noTheme`.
  readonly theme: ThemeSource
}

export type TerminalSize = { readonly cols: number; readonly rows: number }

// Where a terminal an agent asked for starts and what it runs, from `newTerminal` on, and
// why its creation failed, once it did.
type Launch = {
  readonly cwd: string
  readonly command?: string
  /** The agent's request it opens for, which names it as that agent asked. */
  readonly requestId?: string
  failure?: unknown
}

// What the agent hears when the terminal it asked for couldn't start.
const launchFailure = (launch: Launch | undefined): string => {
  const { failure } = launch ?? {}
  const why = failure instanceof Error && failure.message ? ` ${failure.message}` : ""
  return launch?.command === undefined
    ? `Novadeck couldn't open the terminal.${why}`
    : `Novadeck couldn't start the command in a new terminal.${why}`
}

// One terminal the workspace holds, whichever view shows it.
export type RunnerEntry = {
  readonly key: TerminalKey
  // True once the runner has the terminal; false when it could not be created or
  // started again. Replaced whenever a fresh shell starts.
  ready: Promise<boolean>
  // The runner does not have it, as after a runner restart; it needs a fresh shell.
  lost: boolean
  // A fresh shell is starting for it.
  starting: boolean
  // The run of its current shell (1 at creation, +1 per restart), so a late report
  // about an earlier run is ignored. Undefined when the UI does not know it.
  run: number | undefined
  // Reports about this run or earlier ones are stale, as while a restart replaces it.
  floor: number
  // The size its surface last fitted, which a fresh shell starts with.
  size: TerminalSize
  // Resolves when a fresh shell starts, so a surface attaches again.
  revived: Promise<void>
  revive: () => void
  // The runner has reported or created it, so its absence from a listing means it ended.
  confirmed: boolean
  // The watch round in which it was confirmed; a round only speaks for terminals
  // confirmed before it began. Seeded terminals count from before the first.
  confirmedIn: number
  // A create or restart was sent, so the runner may hold a shell even if its answer
  // never came; closing must then still end it.
  requested: boolean
  // Exited or failed, which later activity reports must not undo until it restarts.
  settled: boolean
  closed: boolean
  // The surface's attachment while one is mounted.
  attachment: AttachedTerminal | undefined
  // What the adapter last reported, so each change reaches the store once.
  status: TerminalStatus
  process: string
}

// What a mounted surface needs from the adapter. The surface only reads the entry;
// what it learns goes back through `resized` and `attached`.
export type SurfaceRuntime = {
  readonly entry: (
    key: TerminalKey,
  ) => Readonly<Pick<RunnerEntry, "ready" | "revived" | "closed" | "size">> | undefined
  // The size the surface fitted, which a fresh shell starts with.
  readonly resized: (key: TerminalKey, size: TerminalSize) => void
  // The surface's attachment, until the returned release; releasing leaves one that
  // took its place, as another surface's, alone.
  readonly attached: (key: TerminalKey, attachment: AttachedTerminal) => () => void
  readonly attach: (terminalId: string) => Promise<AttachedTerminal>
  // Saves a file pasted into a terminal on the runner's machine; resolves with its path.
  readonly upload: Runner["terminals"]["upload"]
  // Resolves once the runner is reachable again, or closed for good.
  readonly connected: () => Promise<void>
  // Reports why the surface could not follow its terminal.
  readonly lost: (key: TerminalKey, error: unknown) => void
  // Starts a fresh shell in an exited or failed terminal, as Enter asks for.
  readonly restart: (key: TerminalKey) => void
  // The attached stream saw the shell exit, in order with its output.
  readonly exited: (key: TerminalKey, exit: TerminalExit) => void
  // How the link is doing; surfaces lock their input while it is down.
  readonly connection: Backend["connection"] & {}
  // Counts the promise as outstanding I/O until it settles.
  readonly track: <T>(work: Promise<T>) => Promise<T>
  // The surface's screen for boot progress: mounted, first screen drawn, or gone.
  readonly screen: (key: TerminalKey, state: "mounted" | "shown" | "gone") => void
  // Whether the terminal still exists and its session is the one on screen, so a screen
  // no view shows right now is kept for the next; one off screen is kept for a while.
  readonly shown: (key: TerminalKey) => boolean
}

export type RunnerBackend = {
  readonly backend: Backend
  // For tests: whether the adapter holds the terminal, and a wait for its I/O to land
  // (pending saves are sent at once).
  readonly holds: (key: TerminalKey) => boolean
  readonly idle: () => Promise<void>
  // What Enter does in an exited or failed terminal.
  readonly restart: (key: TerminalKey) => void
}

const connectionState = (status: WireStatus): BackendConnectionState => {
  if (status.state === "connected") return "connected"
  return status.state === "reconnecting" ? "reconnecting" : "unavailable"
}

// Failures of the whole link, which the footer reports; they say nothing about a terminal.
const linkFailures = ["DISCONNECTED", "CLOSED", "UNAUTHORIZED", "INCOMPATIBLE_PROTOCOL"] as const

// Why a terminal could not start, short enough for its end-of-session bar; an error
// the adapter does not know keeps the runner's own words.
const reasons = {
  TERMINAL_LIMIT: "Terminal limit reached",
  CONTROL_IN_USE: "Another window controls it",
  INVALID_DIRECTORY: "Folder not found",
  SPAWN_FAILED: "Shell could not start",
} as const

const lostStatus = (error: unknown): TerminalStatus | undefined => {
  if (hasCode(error, ...linkFailures)) return undefined
  for (const [code, message] of Object.entries(reasons))
    if (hasCode(error, code as keyof typeof reasons)) return { state: "failed", message }
  return { state: "failed", message: error instanceof Error ? error.message : String(error) }
}

const consume = async <T>(
  changes: AsyncIterable<T>,
  handle: (change: T) => void,
): Promise<void> => {
  try {
    for await (const change of changes) handle(change)
  } catch {
    // The runner closed for good; the connection store already says so.
  }
}

const target = ({ projectId, workspaceSessionId }: TerminalKey) => ({
  projectId,
  workspaceSessionId,
})

const defaultSaveDelay = 800
// A runner that takes a close answers within this, but for a shell slow to end; one that
// stays silent this long is taken not to have it.
const defaultCloseAnswerMs = 15_000
const failedToCreate: TerminalStatus = { state: "failed", message: "Could not create the terminal" }
const defaultSize: TerminalSize = { cols: 80, rows: 24 }
// More runner restarts than this within the window stop fresh shells from starting on
// their own; each terminal then waits for Enter.
const restartLimit = 3
const restartWindowMs = 60_000
// Whether the runner restarted too often lately to keep starting shells on its own.
export const restartingTooOften = (restarts: readonly number[], now: number): boolean =>
  restarts.filter((time) => now - time < restartWindowMs).length > restartLimit
const crashLoop: TerminalStatus = {
  state: "failed",
  message: "Runner keeps crashing",
}

class CrashLoop extends Error {}
// The work is no longer wanted: its terminal closed or the backend stopped.
class Cancelled extends Error {}

const revival = (): Pick<RunnerEntry, "revived" | "revive"> => {
  let resolve: (() => void) | undefined
  const revived = new Promise<void>((done) => {
    resolve = done
  })
  return { revived, revive: () => resolve?.() }
}

// A backend over a connected runner and what it listed at startup. Creating it starts
// nothing: I/O begins with the first commit that changes the workspace, or `start`.
export const runnerBackend = (
  runner: RunnerApi,
  listing: RunnerListing,
  options: RunnerBackendOptions,
): RunnerBackend => {
  const newId = options.newId ?? (() => crypto.randomUUID())
  const now = options.now ?? Date.now
  const lostAtStart = lostTerminals(listing)
  const runs = terminalRuns(listing)
  const leftovers = [...cleanlyExited(listing)]
  // When the runner came back as a new process, to spot one that keeps crashing.
  const restarts: number[] = []
  const restartingOften = (): boolean => restartingTooOften(restarts, now())
  const saveDelay = options.saveDelay ?? defaultSaveDelay
  const closeAnswerMs = options.closeAnswerMs ?? defaultCloseAnswerMs
  const quickExitMs = options.quickExitMs ?? defaultQuickExitMs
  const seed = runnerSeed(listing, quickExitMs)
  const telemetry = createTelemetryStore(runnerTelemetry(listing, quickExitMs))
  const connection = createStore<BackendConnectionState>("connected")
  const transcripts = createStore(options.transcripts ?? true)
  const agents = createStore<readonly AgentConnection[]>(
    (options.agents ?? []).map((agent) => ({ ...agent, busy: false })),
  )
  const welcome = createStore(options.welcomed === false)
  // Replaces one agent's entry, keeping the others.
  const updateAgent = (
    agent: AgentConnection["agent"],
    next: (current: AgentConnection) => AgentConnection,
  ) => agents.update((list) => list.map((item) => (item.agent === agent ? next(item) : item)))
  const connectAgent = (agent: AgentConnection["agent"], connected: boolean): void => {
    updateAgent(agent, ({ available, connected: was }) => ({
      agent,
      available,
      connected: was,
      busy: true,
    }))
    void track(runner.agents.set(agent, connected)).then(
      (result) => updateAgent(agent, () => ({ ...result, busy: false })),
      (error: unknown) =>
        updateAgent(agent, ({ available, connected: was }) => ({
          agent,
          available,
          connected: was,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
        })),
    )
  }
  const refreshAgents = (): void => {
    void track(runner.agents.list()).then(
      (list) =>
        agents.update((current) =>
          list.map((found) => {
            const shown = current.find((item) => item.agent === found.agent)
            // A change under way reports its own result.
            return shown?.busy ? shown : { ...found, busy: false }
          }),
        ),
      () => {},
    )
  }
  // Created before anything can settle a terminal, since settling checks it.
  const boot = createBootProgress({ entry: (id) => entries.get(id), now })
  const checkBoot = boot.check
  const pending = new Set<Promise<unknown>>()
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work)
    const settled = (): void => void pending.delete(work)
    work.then(settled, settled)
    return work
  }
  const created = Promise.resolve(true)
  // Whether each project and session exists on the runner yet; seeded ones already do.
  const projects = new Map(seed.projects.map((project) => [project.id, created]))
  const sessions = new Map(
    seed.projects.flatMap((project) => project.sessions.map((session) => [session.id, created])),
  )
  const entries = new Map<string, RunnerEntry>()
  const launches = new Map<string, Launch>()
  // Terminals the runner reported that this window didn't ask for, as another window's or
  // an agent's, on their way into the workspace: they exist, so nothing creates them.
  const adopted = new Map<string, TerminalSummary>()
  // Terminals closed here, which nothing the runner still says of them brings back.
  const closedHere = new Set<string>()
  // Names the person gave terminals, until the runner reports them as theirs.
  const renamed = new Map<string, string>()
  // Titles the person gave terminals, which a terminal is created with; the runner names
  // the others, as one an agent asked for.
  const titles = new Map<string, string>()
  // The agent's request being opened, while the app adds its terminal.
  let opening: string | undefined
  // Each terminal's title, and who it is from, as the runner last reported them.
  const runnerTitles = new Map<string, string>()
  const runnerSources = new Map<string, TitleSource>()
  // Every terminal the runner holds, as it last reported it, until it reports it removed.
  const runnerSummaries = new Map(
    listing.flatMap(({ sessions: listed }) =>
      listed.flatMap(({ terminals }) => terminals.map((each) => [each.id, each] as const)),
    ),
  )
  let sink: BackendSink | undefined
  let epoch: string | undefined
  // The latest runner status.
  let lastStatus: WireStatus | undefined
  const showConnection = (): void => {
    connection.update(() => (lastStatus ? connectionState(lastStatus) : "connected"))
  }
  // Counts watch rounds: each `synced`, and each disconnection, starts a new one.
  let round = 0
  let latest: Workspace | undefined

  const dispatch = (actions: readonly BackendAction[]): void => {
    if (actions.length) sink?.dispatch(actions)
  }
  // Keeps what the terminal's agent says of its tokens and quotas, or, with none, forgets
  // it. A report of the same usage changes nothing, so a status line's tick that moves
  // nothing leaves the roster and everything reading the telemetry alone.
  const noteUsage = ({ key }: RunnerEntry, usage: AgentUsage | undefined): void => {
    const context = `${key.projectId}/${key.workspaceSessionId}`
    telemetry.update((held) =>
      usage
        ? setUsage(held, context, key.terminalId, usage)
        : dropTerminal(held, context, key.terminalId),
    )
  }
  const statusAction = (entry: RunnerEntry, status: TerminalStatus): BackendAction[] => {
    // Only a running terminal has an agent.
    if (status.state !== "running") noteUsage(entry, undefined)
    if (sameStatus(entry.status, status)) return []
    entry.status = status
    const { terminalId } = entry.key
    return [{ type: "terminal/status", target: target(entry.key), terminalId, status }]
  }
  // The runner refuses to start a terminal closed for good, as by another window while
  // this one was away: it goes here too, rather than linger as failed.
  const closedElsewhere = (entry: RunnerEntry): false => {
    if (!entry.closed)
      dispatch([
        { type: "terminal/close", target: target(entry.key), terminalId: entry.key.terminalId },
      ])
    return false
  }
  const settle = (entry: RunnerEntry, status: TerminalStatus): void => {
    if (entry.closed) return
    entry.settled = true
    dispatch(statusAction(entry, status))
    checkBoot()
  }
  // Lets a mounted surface attach again, as to a shell it has no stream for.
  const reviveSurface = (entry: RunnerEntry): void => {
    const { revive } = entry
    Object.assign(entry, revival())
    revive()
  }
  const activityActions = (entry: RunnerEntry, summary: TerminalSummary): BackendAction[] => {
    // A report about an earlier run is stale; a later run, as another client's
    // restart, starts over.
    if (summary.run <= entry.floor) return []
    if (entry.run !== undefined && summary.run < entry.run) return []
    if (summary.run !== entry.run) {
      entry.run = summary.run
      if (!entry.starting) {
        entry.settled = false
        if (!entry.attachment) reviveSurface(entry)
      }
    }
    if (entry.settled) return []
    const activity = terminalActivity(summary, quickExitMs)
    const { terminalId } = entry.key
    // A shell that ended cleanly takes its terminal with it.
    if (activity.status === "clean")
      return [{ type: "terminal/close", target: target(entry.key), terminalId }]
    if (restartable(activity.status)) entry.settled = true
    const actions = statusAction(entry, activity.status)
    if (activity.status.state === "running") noteUsage(entry, activity.usage)
    const { process } = activity
    if (process === undefined || entry.process === process) return actions
    entry.process = process
    return [
      ...actions,
      { type: "terminal/process", target: target(entry.key), terminalId, process },
    ]
  }

  // Notes each new runner process, from whichever status watch sees it first.
  const noteRunner = (status: WireStatus): void => {
    if (status.state !== "connected") return
    if (epoch !== undefined && epoch !== status.epoch) {
      restarts.push(now())
      // A new runner counts runs from 1 again.
      for (const entry of entries.values()) {
        entry.run = undefined
        entry.floor = 0
      }
      noteCrashLoop()
    }
    epoch = status.epoch
  }

  // The crashes behind the guard, for the footer and the crash-loop dialog: counted
  // while the guard holds, 0 once the restarts that tripped it fall out of the window.
  const crashLooping = createStore(0)
  const approvals = createStore<readonly Approval[]>([])
  let crashLoopTimer: ReturnType<typeof setTimeout> | undefined
  const noteCrashLoop = (): void => {
    clearTimeout(crashLoopTimer)
    const recent = restarts.filter((time) => now() - time < restartWindowMs)
    const tripped = restartingOften()
    crashLooping.update(() => (tripped ? recent.length : 0))
    if (!tripped) return
    crashLoopTimer = setTimeout(noteCrashLoop, Math.min(...recent) + restartWindowMs - now() + 50)
  }
  // "Try again" after a crash loop: forget the crashes and start fresh shells for the
  // lost or failed terminals on screen, a few at a time like any burst.
  const retryAfterCrashLoop = (): void => {
    restarts.length = 0
    noteCrashLoop()
    for (const entry of entries.values()) {
      if (!onScreen(entry)) {
        // Off screen, a tile the crash loop stopped waits again for its session.
        if (entry.lost && sameStatus(entry.status, crashLoop)) {
          entry.settled = false
          dispatch(statusAction(entry, { state: "starting" }))
        }
        continue
      }
      if (entry.lost || entry.status.state === "failed") freshShell(entry)
    }
  }

  // Resolves once the runner is reachable again, or closed for good.
  const connected = async (): Promise<void> => {
    // The status can still say connected for a moment after the link dropped.
    await pause(250)
    for await (const status of runner.watch()) {
      noteRunner(status)
      if (status.state !== "reconnecting") return
    }
  }

  // Stopped between `start`s, so retries end with the app instead of outliving it.
  let halted = false
  // Waits for the runner to come back, in short slices so a cancelled wait ends soon.
  const reconnected = async (cancelled: () => boolean): Promise<void> => {
    const back = connected().then(() => true)
    // eslint-disable-next-line no-await-in-loop -- Each slice checks for cancellation.
    while (!(await Promise.race([back, pause(500).then(() => false)])))
      if (cancelled()) throw new Cancelled()
  }

  type Retry = {
    // Errors that mean it already happened, such as CONFLICT for a create whose
    // response was lost; the call then resolves undefined.
    readonly done?: readonly Parameters<typeof hasCode>[1][]
    // May give up after a reconnection by throwing.
    readonly stillWanted?: () => void
    // Whether the work is still wanted; checked before every attempt.
    readonly cancelled?: () => boolean
    // Errors that pass, such as CLOSING from a runner on its way to a restart;
    // the call is tried again after a pause, as while too many calls are in flight.
    readonly again?: readonly Parameters<typeof hasCode>[1][]
  }
  // Repeats `operation` until the runner answers: after each reconnection, and with a
  // growing pause while too many calls are in flight. It stops, rejecting with
  // Cancelled, once the work is no longer wanted or the backend stopped. Any other
  // error rejects.
  const untilAnswered = async <T>(
    operation: () => Promise<T>,
    { done = [], stillWanted = () => {}, cancelled = () => false, again = [] }: Retry = {},
  ): Promise<T | undefined> => {
    const unwanted = (): boolean => halted || cancelled()
    for (let attempt = 0; ; attempt += 1) {
      if (unwanted()) throw new Cancelled()
      try {
        // eslint-disable-next-line no-await-in-loop -- One attempt at a time.
        return await operation()
      } catch (error) {
        if (done.length && hasCode(error, ...done)) return undefined
        if (hasCode(error, "RESOURCE_LIMIT", ...again)) {
          // eslint-disable-next-line no-await-in-loop -- Back off before trying again.
          await pause(Math.min(200 * 2 ** Math.min(attempt, 4), 3_000))
          continue
        }
        if (!hasCode(error, "DISCONNECTED")) throw error
        // eslint-disable-next-line no-await-in-loop -- Wait for the runner to come back.
        await reconnected(unwanted)
        stillWanted()
      }
    }
  }

  // Starting shells shares the runner with everything else, so a session with many
  // lost terminals starts them a few at a time.
  const startLimit = 8
  let starting = 0
  const queued: (() => void)[] = []
  const throttled = async <T>(work: () => Promise<T>): Promise<T> => {
    // A finishing call hands its slot straight to the next in line, so the count
    // never passes the limit.
    if (starting < startLimit) starting += 1
    else await new Promise<void>((resolve) => queued.push(resolve))
    try {
      return await work()
    } finally {
      const next = queued.shift()
      if (next) next()
      else starting -= 1
    }
  }

  // Runs `operation` once `ready` settles well; resolves whether both succeeded.
  const after = (ready: Promise<boolean>, operation: () => Promise<unknown>): Promise<boolean> =>
    track(
      ready.then((ok) =>
        ok
          ? untilAnswered(operation, { done: ["CONFLICT"] }).then(
              () => true,
              () => false,
            )
          : false,
      ),
    )

  // Projects the person removed, whose terminals the runner closes as it removes them.
  const removedProjects = new Set<string>()
  // Removals on their way to the runner, which a quit waits for, as it does for saves.
  const removals = new Set<Promise<void>>()
  // Removes the project on the runner once it has it, retrying while the runner is
  // unreachable or restarting. One already gone, as removed from another window, is left
  // as it is. Retries end with the backend: a reload or quit before the runner answers
  // leaves the project there, and it comes back with the next listing.
  const removeOnRunner = (projectId: string): Promise<void> => {
    const removal = (async () => {
      if (!(await (projects.get(projectId) ?? created))) return
      await untilAnswered(() => runner.projects.remove({ projectId }), {
        done: ["NOT_FOUND"],
        again: ["CLOSING"],
      }).catch((error: unknown) => {
        // Cancelled only as the backend stops; anything else was the runner refusing it.
        if (!(error instanceof Cancelled))
          console.error("Novadeck could not remove the project on the runner:", error)
      })
    })()
    removals.add(removal)
    void removal.finally(() => removals.delete(removal))
    return track(removal)
  }
  // Shells being ended on the runner, which a quit waits for too: it stops the runner
  // right after, and a close it hasn't heard of by then leaves the terminal saved, to
  // come back with the next listing.
  const closes = new Set<Promise<void>>()
  // What a quit waits for: the last saves, and the removals and closes under way,
  // including those the person starts while it waits.
  const beforeQuit = async (): Promise<void> => {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- Settled work may start more.
      await saves.settle()
      if (removals.size === 0 && closes.size === 0) return
      // eslint-disable-next-line no-await-in-loop -- Settled work may start more.
      await Promise.allSettled([...removals, ...closes])
    }
  }

  // Terminals closed here that the runner has yet to confirm gone, by answering the close
  // or reporting them removed, and whether a close for each is under way. One the runner
  // still reports with none under way, as one a stop cancelled, is closed again; one its
  // listing no longer has needs no close.
  // `back` once the terminal came back as the runner was slow to answer.
  const closedPending = new Map<
    string,
    { readonly entry: RunnerEntry; closing: boolean; back: boolean }
  >()
  // Ends the shell, retrying while the runner is unreachable or restarting, whatever
  // window controls it: a closed terminal is gone for good. One already gone is left as it is.
  // A lost terminal is closed too, so the runner forgets what would restore it, at once:
  // a restore still queued is cancelled, one under way the runner refuses, and waiting
  // behind the queue could let a quit come first. One the runner refuses comes back, as
  // does one it hasn't answered for `closeAnswerMs`, while that close waits on: a runner
  // that takes a close tells its watchers the terminal is gone at once.
  const endShell = (entry: RunnerEntry): Promise<void> => {
    const { terminalId } = entry.key
    const close = { entry, closing: true, back: false }
    closedPending.set(terminalId, close)
    // Whether this is still the terminal's latest close: one the person started since, as
    // after this one brought it back, decides what happens to it.
    const current = (): boolean => closedPending.get(terminalId) === close
    const confirm = (): void => {
      if (current()) closedPending.delete(terminalId)
    }
    // However long it waits, for the shell's creation, the link or the runner's answer.
    const late = setTimeout(() => {
      if (!current()) return
      close.back = true
      void keepRunning(entry, "The runner didn't answer.")
    }, closeAnswerMs)
    const closing = (async () => {
      const waits = !entry.lost
      if (waits && !(await entry.ready) && !entry.requested && !entry.lost) {
        // Never created on the runner: there is nothing there to end.
        confirm()
        return
      }
      try {
        await untilAnswered(() => runner.terminals.close(terminalId), {
          done: ["TERMINAL_NOT_FOUND", "TERMINAL_EXITED", "NOT_FOUND"],
          again: ["CLOSING"],
        })
        confirm()
        // Back here while the runner was slow, and gone there after all, whether or not its
        // report that it went arrives: it goes here too.
        const back = close.back ? entries.get(terminalId) : undefined
        if (back && !back.closed)
          dispatch([{ type: "terminal/close", target: target(back.key), terminalId }])
      } catch (error) {
        // Cancelled only as the backend stops; the close is tried again once it starts.
        if (error instanceof Cancelled) return
        console.error("Novadeck could not close the terminal on the runner:", error)
        if (!current()) return
        closedPending.delete(terminalId)
        await keepRunning(entry, error instanceof Error ? error.message : "")
      }
    })().finally(() => {
      clearTimeout(late)
      close.closing = false
    })
    closes.add(closing)
    void closing.finally(() => closes.delete(closing))
    return closing
  }
  // The runner refused to close the terminal, or hasn't answered, so it still runs there:
  // it comes back to its session here, where it can be closed again, and the person hears
  // why. One back already says nothing more. A stopped backend says nothing, and the
  // runner's next listing brings the terminal back.
  const keepRunning = async (entry: RunnerEntry, why: string): Promise<void> => {
    const { terminalId, workspaceSessionId } = entry.key
    if (entries.has(terminalId)) return
    if (!sink) return void closedHere.delete(terminalId)
    // As the runner last reported it, should it be unable to list it now: it said it keeps it.
    let summary = runnerSummaries.get(terminalId)
    try {
      const listed = await runner.terminals.list({ sessionId: workspaceSessionId })
      summary = listed.find((each) => each.id === terminalId)
      // Gone after all, as closed meanwhile from another window.
      if (!summary) return
    } catch {
      // Brought back from its last report.
    }
    if (!summary || entries.has(terminalId)) return
    closedHere.delete(terminalId)
    // Stopped meanwhile: the next listing brings it back.
    if (!adopt(summary)) return
    const named = `${summary.handle ? `${handleText(summary.handle)} · ` : ""}“${summary.title}”`
    options.notices?.show({
      id: terminalId,
      title: `Novadeck couldn't close ${named}`,
      body: `It's still running, so it stays in its session.${why ? ` ${why}` : ""}`,
    })
  }

  // The terminal as the workspace last committed it.
  const terminalOf = (key: TerminalKey): TerminalMetadata | undefined =>
    latest?.projects
      .find((project) => project.id === key.projectId)
      ?.history.find((session) => session.id === key.workspaceSessionId)
      ?.state.roster.terminals.find((terminal) => terminal.id === key.terminalId)
  // The title a terminal is created with: the one the person gave it; the runner names
  // the others.
  const titled = (key: TerminalKey): { title?: string } => {
    const title = titles.get(key.terminalId)
    return title === undefined ? {} : { title }
  }
  // What the runner says of a terminal that the workspace shows otherwise: its title,
  // unless the person renamed it since and the runner has yet to hear, and its directory.
  const factActions = (entry: RunnerEntry, summary: TerminalSummary): BackendAction[] => {
    const current = terminalOf(entry.key)
    if (!current) return []
    const { terminalId } = entry.key
    runnerTitles.set(terminalId, summary.title)
    runnerSources.set(terminalId, summary.titleSource)
    const unconfirmed = renamed.get(terminalId)
    if (unconfirmed === summary.title) renamed.delete(terminalId)
    // The person's title was taken away, as by a reset: it is never given again.
    if (summary.titleSource.kind !== "person" && !renamed.has(terminalId)) titles.delete(terminalId)
    const name =
      unconfirmed === undefined && current.name !== summary.title ? summary.title : undefined
    const directory = current.directory !== summary.cwd ? summary.cwd : undefined
    const handle = current.handle !== summary.handle ? summary.handle : undefined
    const ledBy = (current.ledBy ?? null) !== summary.ledBy ? summary.ledBy : undefined
    const openedBy = (current.openedBy ?? null) !== summary.openedBy ? summary.openedBy : undefined
    const agentRan = (current.agentRan ?? false) !== summary.agentRan ? summary.agentRan : undefined
    // While the person's name is on its way, it is theirs, whatever the runner said before.
    const titleSource =
      unconfirmed === undefined && !sameTitleSource(current.titleSource, summary.titleSource)
        ? summary.titleSource
        : undefined
    if (
      [name, directory, handle, ledBy, openedBy, agentRan, titleSource].every(
        (fact) => fact === undefined,
      )
    )
      return []
    return [
      {
        type: "terminal/update",
        target: target(entry.key),
        terminalId,
        ...(name !== undefined && { name }),
        ...(directory !== undefined && { directory }),
        ...(handle !== undefined && { handle }),
        ...(ledBy !== undefined && { ledBy }),
        ...(openedBy !== undefined && { openedBy }),
        ...(agentRan !== undefined && { agentRan }),
        ...(titleSource !== undefined && { titleSource }),
      },
    ]
  }
  // Tells the runner the name the person gave a terminal, whether or not it has a
  // shell. One the runner doesn't have yet, as while it is created, gets it once it does.
  // The pending name goes once the runner took it, or refused it; refused for any reason
  // but not having the terminal, the terminal shows the runner's title again.
  const renameOnRunner = async (key: TerminalKey, name: string): Promise<void> => {
    const { terminalId } = key
    renamed.set(terminalId, name)
    titles.set(terminalId, name)
    const rename = () =>
      untilAnswered(() => runner.terminals.rename(terminalId, name), {
        cancelled: () => renamed.get(terminalId) !== name,
      })
    let refused = false
    try {
      await rename()
    } catch (error) {
      const entry = entries.get(terminalId)
      if (!hasCode(error, "TERMINAL_NOT_FOUND")) refused = !(error instanceof Cancelled)
      else if (entry && (await entry.ready))
        await rename().catch((again: unknown) => {
          refused = !hasCode(again, "TERMINAL_NOT_FOUND") && !(again instanceof Cancelled)
        })
    }
    if (renamed.get(terminalId) !== name) return
    renamed.delete(terminalId)
    const title = runnerTitles.get(terminalId)
    const titleSource = runnerSources.get(terminalId)
    if (refused && title !== undefined)
      dispatch([
        {
          type: "terminal/update",
          target: target(key),
          terminalId,
          name: title,
          ...(titleSource && { titleSource }),
        },
      ])
  }
  // A terminal the runner has that this window didn't ask for joins its session, unless
  // the workspace doesn't hold that session or its shell already ended cleanly, or the
  // backend is stopped, when the runner's next listing brings it. Says whether it joined.
  const adopt = (summary: TerminalSummary): boolean => {
    const project = latest?.projects.find((each) =>
      each.history.some((session) => session.id === summary.sessionId),
    )
    const terminal = runnerTerminal(summary, quickExitMs)
    if (!sink || !project || !terminal || adopted.has(summary.id) || closedHere.has(summary.id))
      return false
    adopted.set(summary.id, summary)
    dispatch([
      {
        type: "terminal/add",
        target: { projectId: project.id, workspaceSessionId: summary.sessionId },
        terminal,
        select: false,
      },
    ])
    return true
  }

  // Starts the shell once its session exists; a failure shows on the terminal's tab.
  const createTerminal = (entry: RunnerEntry): Promise<boolean> => {
    const { terminalId, workspaceSessionId } = entry.key
    const session = sessions.get(workspaceSessionId) ?? created
    const launch = launches.get(terminalId)
    const started = launch
      ? {
          cwd: launch.cwd,
          ...(launch.command !== undefined && { command: launch.command }),
          ...(launch.requestId !== undefined && { requestId: launch.requestId }),
        }
      : {}
    return track(
      session.then(async (ok) => {
        if (!ok) throw new Error("The runner could not create this session.")
        const summary = await untilAnswered(
          () => {
            entry.requested = true
            return runner.terminals.create({
              id: terminalId,
              sessionId: workspaceSessionId,
              ...started,
              ...titled(entry.key),
              cols: 80,
              rows: 24,
            })
          },
          {
            done: ["CONFLICT"],
            // A runner that keeps dying is a crash loop; stop creating into it.
            stillWanted: () => {
              if (restartingOften()) throw new CrashLoop()
            },
            cancelled: () => entry.closed,
          },
        )
        entry.run = summary?.run
        entry.confirmed = true
        entry.confirmedIn = round
        if (summary) dispatch(factActions(entry, summary))
        return true
      }),
    ).catch((error: unknown) => {
      if (launch) launch.failure = error
      if (error instanceof Cancelled) return false
      if (hasCode(error, "TERMINAL_NOT_FOUND")) return closedElsewhere(entry)
      settle(entry, error instanceof CrashLoop ? crashLoop : (lostStatus(error) ?? failedToCreate))
      return false
    })
  }

  const reply = (answer: TerminalRequestAnswer) =>
    runner.terminals.answerRequest(answer).catch(() => {})

  // Tells the runner how an agent's request went: the terminal the app added, once the
  // runner started it, or why not. One that couldn't start closes again, as the agent
  // hears why. A runner that no longer waits for the answer needs none.
  const answerRequest = async (
    request: TerminalRequest,
    result: { readonly terminalId: string } | { readonly reason: string },
  ): Promise<void> => {
    const { requestId } = request
    if ("reason" in result) return reply({ requestId, reason: result.reason })
    const { terminalId } = result
    const entry = entries.get(terminalId)
    const ok = entry ? await entry.ready : false
    const launch = launches.get(terminalId)
    launches.delete(terminalId)
    if (ok) return reply({ requestId, terminalId })
    if (entry && !entry.closed)
      dispatch([{ type: "terminal/close", target: target(entry.key), terminalId }])
    return reply({ requestId, reason: launchFailure(launch) })
  }

  // A runner that keeps dying while a shell starts is a crash loop; stop waiting.
  const stillWanted = (): void => {
    if (restartingOften()) throw new CrashLoop()
  }

  // Starts a fresh shell for the terminal, keeping its id: a restart when the runner
  // still has the exited record, a create that restores the runner's saved record when
  // it does not, in the terminal's last directory. Its surface attaches again.
  //
  // Every replacement shell starts here, while the terminal's `restoredProcess` still
  // names the program it lost, which resumes when the runner knows its agent session.
  // The program is read first, as the fresh shell's first idle report drops it from the
  // store. It goes with the create or restart as `resume`, and the runner resumes the
  // session that agent last reported there, from the fresh shell's own startup, so the
  // agent simply comes back: nothing is typed, and it can never land in a live process.
  // A CONFLICT, as while the old shell lives on (a failed attach, "Another window
  // controls it", captures a restore without losing the shell), refuses the call and
  // the resume with it. Without a session, or with the agent disconnected, the runner
  // starts a plain shell with the terminal's transcript above it instead.
  const freshShell = (entry: RunnerEntry): void => {
    if (entry.closed || entry.starting) return
    const { terminalId, workspaceSessionId } = entry.key
    const { cols, rows } = entry.size
    const agent = resumableProgram(restoredOf(entry))
    const retry: Retry = { done: ["CONFLICT"], stillWanted, cancelled: () => entry.closed }
    const resume = agent ? { resume: agent } : {}
    const create = () => {
      // A new record counts runs afresh.
      entry.floor = 0
      entry.run = undefined
      return untilAnswered(() => {
        entry.requested = true
        return runner.terminals.create({
          id: terminalId,
          sessionId: workspaceSessionId,
          cols,
          rows,
          restore: true,
          ...resume,
        })
      }, retry)
    }
    entry.starting = true
    entry.settled = false
    // Until the restart answers, reports about the run it replaces are stale.
    entry.floor = Math.max(entry.floor, entry.run ?? 0)
    dispatch(statusAction(entry, { state: "starting" }))
    const wasLost = entry.lost
    entry.ready = track(
      throttled(async () => {
        const summary = wasLost
          ? await create()
          : await untilAnswered(() => {
              entry.requested = true
              return runner.terminals.restart(terminalId, { cols, rows, ...resume })
            }, retry).catch((error: unknown) => {
              // Never created, or evicted since it exited: start it anew.
              if (hasCode(error, "TERMINAL_NOT_FOUND", "NOT_FOUND")) return create()
              throw error
            })
        // Unknown when the create or restart had already landed; the floor still holds.
        entry.run = summary?.run
        entry.lost = false
        entry.confirmed = true
        entry.confirmedIn = round
        return true
      }),
    )
      .then((ok) => {
        // A shell that was already there has no fresh screen coming on its own.
        if (ok) reviveSurface(entry)
        return ok
      })
      .catch((error: unknown) => {
        entry.starting = false
        if (error instanceof Cancelled) return false
        if (hasCode(error, "TERMINAL_NOT_FOUND")) return closedElsewhere(entry)
        settle(
          entry,
          error instanceof CrashLoop ? crashLoop : (lostStatus(error) ?? failedToCreate),
        )
        return false
      })
      .then((ok) => {
        entry.starting = false
        return ok
      })
    const { revive } = entry
    Object.assign(entry, revival())
    revive()
    followWhenReady(entry)
  }

  // The runner no longer has the terminal: start a fresh shell in place once its
  // session is on screen, or at once when it has a program to resume, unless the runner
  // keeps restarting.
  const markLost = (entry: RunnerEntry): void => {
    if (entry.closed || entry.starting) return
    entry.lost = true
    entry.confirmed = false
    if (entry.settled) return
    if (restartingOften()) return settle(entry, crashLoop)
    dispatch(statusAction(entry, { state: "starting" }))
    if (wanted(entry)) freshShell(entry)
  }

  const onScreen = (entry: RunnerEntry): boolean => {
    const project = latest?.projects.find((item) => item.id === latest?.activeProjectId)
    return (
      project?.id === entry.key.projectId &&
      project.activeSessionId === entry.key.workspaceSessionId
    )
  }
  // The program the terminal waits to restore, as the workspace last committed it.
  const restoredOf = ({ key }: RunnerEntry): string | undefined =>
    latest?.projects
      .find((project) => project.id === key.projectId)
      ?.history.find((session) => session.id === key.workspaceSessionId)
      ?.state.roster.terminals.find((terminal) => terminal.id === key.terminalId)?.restoredProcess
  // A lost terminal gets its fresh shell once its session shows, but one whose program
  // resumes starts at once, in any session and hidden or not, so the agent is back
  // when the person looks; the runner spaces their launches out.
  const wanted = (entry: RunnerEntry): boolean =>
    onScreen(entry) || resumableProgram(restoredOf(entry)) !== undefined
  // Lost terminals of the session on screen, and those with a program to resume, get
  // their fresh shells.
  const reviveOnScreen = (): void => {
    // The session on screen goes first; the start throttle and the runner's launch gaps
    // then hold back only the others.
    const ordered = [...entries.values()].toSorted(
      (a, b) => Number(onScreen(b)) - Number(onScreen(a)),
    )
    for (const entry of ordered)
      if (entry.lost && !entry.settled && !entry.starting && wanted(entry)) {
        if (restartingOften()) settle(entry, crashLoop)
        else freshShell(entry)
      }
  }

  // What agents show and the person attaches, and the windows undocked from them: kept in
  // step with the runner, each change the person makes sent once its session exists there.
  const items = createRunnerItems({
    runner: runner.companions,
    listing,
    latest: () => latest,
    ready: (sessionId) => sessions.get(sessionId) ?? created,
    // A terminal this window created exists on the runner once its create answered.
    terminalReady: (terminalId) => entries.get(terminalId)?.ready ?? created,
    call: (operation, done) => track(untilAnswered(operation, { done })),
    dispatch: (actions) => dispatch(actions),
    consume,
  })
  // The messages between their agents, followed once each terminal's shell is there.
  const messages = createRunnerMessages(
    {
      watch: (terminalId) => runner.messages.watch(terminalId),
      pause: (paused) => runner.messages.pause(paused),
      release: (thread) => runner.messages.release(thread),
      stop: (thread) => runner.messages.stop(thread),
    },
    track,
  )
  const conversations = createRunnerConversations(
    {
      detail: (terminalId) => runner.agents.detail(terminalId),
      transcript: (terminalId, actor) => runner.agents.transcript(terminalId, actor),
      prompt: (terminalId, text, automatic) => runner.agents.prompt(terminalId, text, automatic),
      interrupt: (terminalId) => runner.agents.interrupt(terminalId),
      answer: (terminalId, request, answer) => runner.agents.answer(terminalId, request, answer),
    },
    track,
  )
  // The Inbox: built from the terminals' statuses, the messages and the requests of the
  // agents that ask, once the app binds it to its workspace. Every runner backend has it.
  const inbox = createRunnerInbox(
    {
      inbox: runner.inbox,
      detail: (terminalId) => runner.agents.detail(terminalId),
      answer: (key, request, answer) => conversations.answer(key, request, answer),
      send: (key, text, sending) => conversations.send(key, text, sending),
      interrupt: (key) => conversations.interrupt(key),
      release: messages.release,
      stop: messages.stop,
    },
    messages.state,
    { track },
  )
  // The person's order of the Inbox's rows: shown at once, kept by the runner.
  const inboxOrder = options.inboxOrder && createStore(options.inboxOrder)
  // The voice input addon, followed from `start` like the messages.
  const voice = createRunnerVoice(runner.voice, track)
  // Murmur, followed the same way.
  const murmur = createRunnerMurmur(runner.murmur, track)
  let following = false
  // Follows a terminal's messages once the runner has it: it answers "not found" before
  // then. Called whenever a shell is created or started afresh.
  const followWhenReady = (entry: RunnerEntry): void => {
    const { ready } = entry
    void ready.then((ok) => {
      if (!ok || !following || entry.closed || entry.ready !== ready) return
      messages.follow(entry.key)
    })
  }

  const registry = createTerminalRegistry<RunnerEntry>({
    open: (key, terminal: TerminalMetadata, added) => {
      // One the runner reported first already exists there.
      const reported = adopted.get(key.terminalId)
      adopted.delete(key.terminalId)
      const isNew = added && !reported
      const lost = reported ? !reported.started : !isNew && lostAtStart.has(key.terminalId)
      const entry: RunnerEntry = {
        key,
        ready: Promise.resolve(!lost),
        lost,
        starting: false,
        run: reported ? reported.run : isNew ? undefined : runs.get(key.terminalId),
        floor: 0,
        size: defaultSize,
        ...revival(),
        confirmed: !isNew && !lost,
        confirmedIn: -1,
        requested: false,
        settled: restartable(terminal),
        closed: false,
        attachment: undefined,
        status: terminal,
        process: terminal.process,
      }
      if (isNew) entry.ready = createTerminal(entry)
      entries.set(key.terminalId, entry)
      // What the runner reported of its agent comes with it; it says nothing again until
      // it changes.
      if (reported) noteUsage(entry, terminalActivity(reported, quickExitMs).usage)
      followWhenReady(entry)
      return entry
    },
    close: (entry, key) => {
      entry.closed = true
      closedHere.add(key.terminalId)
      entries.delete(key.terminalId)
      // A removed project's terminals are closed by the runner, as it removes the project.
      if (!removedProjects.has(key.projectId)) void track(endShell(entry))
      // After the shell's end is under way, and once this commit is done: what it tells
      // its stores' readers, who may start a transaction of their own, as the companion's
      // messages do, must never stand between a close and the runner.
      queueMicrotask(() => {
        noteUsage(entry, undefined)
        messages.unfollow(key)
      })
      checkBoot()
    },
  })

  // Every changed session is sent after a quiet spell, or at once on pagehide.
  const saves = createSessionSaves({
    save: (sessionId, state, visitedAt) => runner.sessions.save({ sessionId, state, visitedAt }),
    ready: (id) => sessions.get(id),
    latest: () => latest,
    track,
    halted: () => halted,
    delay: saveDelay,
    saved: listing.flatMap(({ sessions: listed }) =>
      listed.flatMap(({ session }) =>
        session.state === null
          ? []
          : [[session.id, { state: session.state, visitedAt: session.visitedAt }] as const],
      ),
    ),
  })
  const { flush } = saves
  // Whether the first commit, which renders the page, has happened.
  let initialized = false

  const commit: Backend["commit"] = (workspace, actions) => {
    const initial = !initialized
    initialized = true
    latest = workspace
    for (const project of workspace.projects) {
      if (!projects.has(project.id))
        projects.set(
          project.id,
          after(created, () =>
            runner.projects.create({ id: project.id, name: project.name, cwd: project.directory }),
          ),
        )
      for (const session of project.history)
        if (!sessions.has(session.id))
          sessions.set(
            session.id,
            after(projects.get(project.id)!, () =>
              runner.sessions.create({ id: session.id, projectId: project.id, name: session.name }),
            ),
          )
    }
    // The reducer keeps the last project, so only one gone from the workspace is removed.
    const removed = actions.flatMap((action) =>
      action.type === "project/remove" &&
      !workspace.projects.some((project) => project.id === action.projectId)
        ? [action.projectId]
        : [],
    )
    for (const projectId of removed) removedProjects.add(projectId)
    registry.reconcile(workspace, actions)
    for (const projectId of removed) void removeOnRunner(projectId)
    saves.note(workspace)
    // What the person did to items and windows, renames of windows among it.
    items.commit(actions)
    for (const action of actions) {
      // The person's renames go to the runner, which owns every terminal's title.
      if (action.type === "terminal/rename" && !items.holdsWindow(action.target, action.terminalId))
        void track(renameOnRunner({ ...action.target, terminalId: action.terminalId }, action.name))
    }
    // The first commit renders the page and must start nothing; `start` covers it.
    // Reviving reports to the store, which cannot take a transaction inside its
    // commit, so it runs once the commit is done.
    if (!initial) queueMicrotask(reviveOnScreen)
  }

  const runtime: SurfaceRuntime = {
    entry: (key) => registry.get(key)?.entry,
    resized: (key, size) => {
      const entry = registry.get(key)?.entry
      if (entry) entry.size = size
    },
    attached: (key, attachment) => {
      const entry = registry.get(key)?.entry
      if (entry) entry.attachment = attachment
      return () => {
        if (entry?.attachment === attachment) entry.attachment = undefined
      }
    },
    attach: (terminalId) => runner.terminals.attach(terminalId),
    upload: (terminalId, file) => track(runner.terminals.upload(terminalId, file)),
    connected,
    lost: (key, error) => {
      const entry = registry.get(key)?.entry
      if (!entry) return
      if (hasCode(error, "TERMINAL_NOT_FOUND")) return markLost(entry)
      const status = lostStatus(error)
      if (status) settle(entry, status)
    },
    exited: (key, exit) => {
      const entry = registry.get(key)?.entry
      if (!entry || entry.closed || entry.settled || entry.starting) return
      const status = exitStatus(exit, quickExitMs)
      if (status === "clean")
        return dispatch([
          { type: "terminal/close", target: target(key), terminalId: key.terminalId },
        ])
      settle(entry, status)
    },
    restart: (key) => {
      const entry = registry.get(key)?.entry
      if (entry?.settled) freshShell(entry)
    },
    connection,
    track,
    screen: boot.screen,
    shown: (key) => {
      const entry = registry.get(key)?.entry
      return entry !== undefined && !entry.closed && onScreen(entry)
    },
  }

  const start: NonNullable<Backend["start"]> = (next) => {
    sink = next
    halted = false
    let live = true
    // Terminals the runner reported since its last `synced`, which lists them all.
    const reported = new Set<string>()
    const onChange = (change: TerminalWatchItem): void => {
      if (!live) return
      // A fresh sequence lists every terminal again before its `synced`: start a round.
      if (change.type === "reset") {
        reported.clear()
        round += 1
        return
      }
      if (change.type === "removed") {
        closedPending.delete(change.terminalId)
        runnerSummaries.delete(change.terminalId)
        // Closed, as by another window: it is gone from its session here too.
        const entry = entries.get(change.terminalId)
        if (entry && !entry.closed)
          dispatch([
            { type: "terminal/close", target: target(entry.key), terminalId: change.terminalId },
          ])
        return
      }
      if (change.type === "changed") {
        const summary = change.terminal
        const entry = entries.get(summary.id)
        reported.add(summary.id)
        runnerSummaries.set(summary.id, summary)
        // Closed here, and still running there with no close on its way: closed again.
        const closed = closedPending.get(summary.id)
        if (!entry && closed && !closed.closing) return void track(endShell(closed.entry))
        if (!entry) return void adopt(summary)
        if (entry.closed) return
        if (!entry.confirmed) entry.confirmedIn = round
        entry.confirmed = true
        dispatch([
          ...factActions(entry, summary),
          ...(summary.started ? activityActions(entry, summary) : []),
        ])
        // Kept without a shell, as once its exited record was let go: it needs a fresh one.
        if (!summary.started && !entry.starting && !entry.lost) markLost(entry)
        return
      }
      // Terminals confirmed during this round may have been created after the runner
      // listed its terminals for it, so only earlier ones can be missing.
      const ended = [...entries.values()].filter(
        (entry) =>
          entry.confirmed && entry.confirmedIn < round && !reported.has(entry.key.terminalId),
      )
      for (const [terminalId, close] of closedPending)
        if (!close.closing && !reported.has(terminalId)) closedPending.delete(terminalId)
      for (const terminalId of runnerSummaries.keys())
        if (!reported.has(terminalId)) runnerSummaries.delete(terminalId)
      reported.clear()
      round += 1
      for (const entry of ended) markLost(entry)
    }
    const onStatus = (status: WireStatus): void => {
      if (!live) return
      lastStatus = status
      // The runner settles a client's asks once its link drops and sends none again, so
      // none of them can still be answered.
      if (status.state !== "connected")
        approvals.update((waiting) => (waiting.length ? [] : waiting))
      showConnection()
      noteRunner(status)
      if (status.state === "connected") saves.schedule()
    }
    const changes = runner.terminals.watch()
    const statuses = runner.watch()
    const requests = runner.terminals.requests()
    const asked = runner.terminals.approvals()
    const looks = runner.companions.looks()
    // Each request goes to the app, which adds the terminal and answers once.
    const onRequest = (request: TerminalRequest): void => {
      if (!live) return
      let answered = false
      // The app adds the terminal as it is asked to, so it is created for this request.
      opening = request.requestId
      try {
        next.open({
          from: request.from,
          directory: request.cwd,
          ...(request.command !== undefined && { command: request.command }),
          focus: request.focus,
          answer: (result) => {
            if (answered) return
            answered = true
            void track(answerRequest(request, result))
          },
        })
      } finally {
        opening = undefined
      }
    }
    // An agent's look at a page is answered with a picture of it, or why there is none; one the
    // runner no longer waits for needs no answer.
    const onLook = (look: PageLook): void => {
      if (!live) return
      void track(
        answerLook(look, { fresh: options.pageLook })
          .then((answer) => runner.companions.answerLook(answer))
          .catch(() => {}),
      )
    }
    // A request waits on the person until they answer or the runner takes it back.
    const onApproval = (item: RunnerApproval): void => {
      if (!live) return
      // One still on its way as the link dropped was settled with the rest: never show it.
      if (item.type === "request" && lastStatus && lastStatus.state !== "connected") return
      approvals.update((waiting) =>
        item.type === "withdrawn"
          ? waiting.filter((each) => each.requestId !== item.requestId)
          : waiting.some((each) => each.requestId === item.requestId)
            ? waiting
            : [
                ...waiting,
                {
                  requestId: item.requestId,
                  from: item.from,
                  terminalId: item.terminalId,
                  action: item.action,
                },
              ],
      )
    }
    reviveOnScreen()
    boot.begin([...entries.values()].filter(onScreen).map((entry) => entry.key.terminalId))
    // What the runner keeps of shells that exited cleanly while the app was away.
    for (const terminalId of leftovers.splice(0))
      void track(
        untilAnswered(() => runner.terminals.close(terminalId), {
          done: ["TERMINAL_NOT_FOUND", "NOT_FOUND"],
        }).catch(() => {}),
      )
    void consume(changes, onChange)
    const stopItems = items.watch()
    void consume(statuses, onStatus)
    void consume(requests, onRequest)
    void consume(asked, onApproval)
    void consume(looks, onLook)
    following = true
    for (const entry of entries.values()) if (!entry.closed) followWhenReady(entry)
    voice.follow()
    murmur.follow()
    window.addEventListener("pagehide", flush)
    // The host waits for these saves, removals and closes before a close or quit can end
    // the shells, so they name what still runs.
    const stopQuit = options.beforeQuit?.(beforeQuit)
    return () => {
      live = false
      if (sink === next) sink = undefined
      void changes.return?.()
      void statuses.return?.()
      void requests.return?.()
      void asked.return?.()
      void looks.return?.()
      approvals.update(() => [])
      window.removeEventListener("pagehide", flush)
      stopQuit?.()
      following = false
      stopItems()
      messages.end()
      conversations.stop()
      inbox.end()
      voice.stop()
      murmur.stop()
      // The last changes are saved; nothing retries after this.
      flush()
      halted = true
    }
  }

  const screens = createTerminalViews(viewOptions(runtime, { theme: options.theme }))
  const backend: Backend = {
    seed,
    newTerminal: ({ directory, launch, title }) => {
      const terminal = startingTerminal(newId(), directory, title)
      if (title !== undefined) titles.set(terminal.id, title)
      if (launch)
        launches.set(terminal.id, {
          cwd: directory,
          ...(launch.command !== undefined && { command: launch.command }),
          ...(opening !== undefined && { requestId: opening }),
        })
      return terminal
    },
    commit,
    mountTerminal: createTerminalMount(screens),
    setFont: screens.setFont,
    telemetry,
    voice: voice.voice,
    murmur: murmur.murmur,
    typeInto: screens.typeInto,
    start,
    companions: createRunnerCompanions(runner.companions, {
      livePages: options.livePages === true,
      ...(options.pagePicture ? { picture: options.pagePicture } : {}),
      ...(options.pagePhone ? { phone: options.pagePhone } : {}),
      inOrder: items.inOrder,
    }),
    messages,
    conversations,
    inbox: inboxOrder
      ? {
          ...inbox,
          order: inboxOrder,
          arrange: (ids) => {
            inboxOrder.update(() => ids)
            void track(runner.settings.set({ inboxOrder: [...ids] })).catch(() => {})
          },
        }
      : inbox,
    approvals: {
      pending: approvals,
      answer: (requestId, approved) => {
        approvals.update((waiting) => waiting.filter((each) => each.requestId !== requestId))
        // A runner that no longer waits for the answer needs none.
        runner.terminals.answerApproval({ requestId, approved }).catch(() => {})
      },
    },
    releaseLead: ({ terminalId }) => {
      void track(
        untilAnswered(() => runner.terminals.release(terminalId), {
          done: ["TERMINAL_NOT_FOUND", "NOT_FOUND"],
        }),
      ).catch(() => {})
    },
    // After the projects the person just added exist on the runner, or the arrangement
    // would name ones it doesn't have yet.
    arrange: (arrangement) =>
      track(
        Promise.allSettled(projects.values()).then(async () => {
          await untilAnswered(() => runner.projects.arrange(arrangement))
        }),
      ),
    source: createRunnerSource(runner.projects),
    resetTitle: (key) => {
      const { terminalId } = key
      if (items.holdsWindow(target(key), terminalId))
        return items.resetWindow(target(key), terminalId)
      // The person's name goes here too, so nothing sends it to the runner again, and a
      // rename still on its way is called off.
      titles.delete(terminalId)
      renamed.delete(terminalId)
      void track(
        untilAnswered(() => runner.terminals.resetTitle(terminalId), {
          done: ["TERMINAL_NOT_FOUND"],
        }),
      ).catch(() => {})
    },
    connection,
    crashLoop: { crashes: crashLooping, retry: retryAfterCrashLoop },
    boot: boot.store,
    ...(options.transcripts !== undefined
      ? {
          transcripts: {
            enabled: transcripts,
            available: options.transcriptsAvailable ?? true,
            set: (enabled) => {
              const before = transcripts.getSnapshot()
              transcripts.update(() => enabled)
              // Unsaved, the switch shows what the runner still does.
              void track(runner.settings.set({ transcripts: enabled })).catch(() =>
                transcripts.update(() => before),
              )
            },
          },
        }
      : {}),
    ...(options.agents !== undefined
      ? {
          agents: {
            state: agents,
            set: connectAgent,
            refresh: refreshAgents,
            welcome,
            finishWelcome: () => {
              welcome.update(() => false)
              void track(runner.settings.set({ welcomed: true })).catch(() => {})
            },
          },
        }
      : {}),
    ...(options.pickDirectory ? { pickDirectory: options.pickDirectory } : {}),
    ...(options.showAppearance ? { showAppearance: options.showAppearance } : {}),
    ...(options.notices ? { notices: options.notices } : {}),
    ...(options.badge ? { badge: options.badge } : {}),
    ...(options.windowFocus ? { windowFocus: options.windowFocus } : {}),
    ...(options.updates ? { updates: options.updates } : {}),
    ...(options.version ? { version: options.version } : {}),
    ...(options.openLogs ? { openLogs: options.openLogs } : {}),
    // The host's sender with the runner's routes: asking and the drafts exist only where a
    // draft could then be sent.
    ...(options.feedback
      ? { feedback: runnerFeedback(options.feedback, runner.feedback, track) }
      : {}),
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    ...(options.whatsNew ? { whatsNew: options.whatsNew } : {}),
    ...(options.portable ? { portable: options.portable } : {}),
    ...(options.uninstall ? { uninstall: options.uninstall } : {}),
  }
  const busy = (): boolean => saves.busy() || pending.size > 0
  return {
    backend,
    holds: (key) => registry.get(key) !== undefined,
    restart: runtime.restart,
    idle: async () => {
      while (busy()) {
        flush()
        // eslint-disable-next-line no-await-in-loop -- Settled work may start more.
        await Promise.allSettled(pending)
      }
    },
  }
}
