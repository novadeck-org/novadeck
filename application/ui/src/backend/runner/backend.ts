import type { TerminalExit, TerminalSummary } from "@novadeck/protocol"
import {
  hasCode,
  RunnerError,
  type AttachedTerminal,
  type Runner,
  type RunnerStatus,
  type TerminalWatchItem,
} from "@novadeck/protocol/client"

import { createStore } from "../../model/store"
import type { TerminalMetadata, TerminalStatus, Workspace } from "../../model/types"
import type {
  Backend,
  BackendAction,
  BackendConnectionState,
  BackendSink,
  TerminalKey,
} from "../port"
import { createTerminalRegistry } from "../registry"
import { exitStatus, restartable, terminalActivity } from "./activity"
import { createBootProgress } from "./boot-progress"
import type { RunnerDebug } from "./debug"
import { createDebugPanel } from "./DebugPanel"
import { pause } from "./pause"
import { createRunnerTerminal } from "./RunnerTerminal"
import { createSessionSaves } from "./saves"
import {
  cleanlyExited,
  lostTerminals,
  runnerSeed,
  startingTerminal,
  terminalRuns,
  type RunnerListing,
} from "./seed"

// The part of the runner client the adapter uses.
export type RunnerApi = Pick<Runner, "watch" | "projects" | "sessions" | "terminals">

export type RunnerBackendOptions = {
  readonly newId?: () => string
  // How long saving waits for more changes, in milliseconds.
  readonly saveDelay?: number
  readonly pickDirectory?: () => Promise<string | null>
  readonly now?: () => number
  // The debug panel's hooks, when this launch offers the panel.
  readonly debug?: RunnerDebug | undefined
}

export type TerminalSize = { readonly cols: number; readonly rows: number }

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

// Statuses that read the same; a terminal's metadata carries its status among its fields.
const sameStatus = (a: TerminalStatus, b: TerminalStatus): boolean => statusKey(a) === statusKey(b)
const statusKey = (status: TerminalStatus): string => {
  if (status.state === "exited") return `exited:${status.exitCode}:${status.signal}`
  if (status.state === "failed") return `failed:${status.message}`
  return status.state
}
const processKey = ({ process, kind }: { process: string; kind: string }): string =>
  `${kind}:${process}`

const connectionState = (status: RunnerStatus): BackendConnectionState => {
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
  options: RunnerBackendOptions = {},
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
  const seed = runnerSeed(listing)
  const connection = createStore<BackendConnectionState>("connected")
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
  let sink: BackendSink | undefined
  let runnerId: string | undefined
  // The latest runner status; a simulated outage from the debug panel shows as
  // reconnecting over it.
  let lastStatus: RunnerStatus | undefined
  const showConnection = (): void => {
    const outage = options.debug?.outage.getSnapshot() ?? false
    connection.update(() =>
      outage ? "reconnecting" : lastStatus ? connectionState(lastStatus) : "connected",
    )
  }
  // Counts watch rounds: each `synced`, and each disconnection, starts a new one.
  let round = 0
  let latest: Workspace | undefined

  const dispatch = (actions: readonly BackendAction[]): void => {
    if (actions.length) sink?.dispatch(actions)
  }
  const statusAction = (entry: RunnerEntry, status: TerminalStatus): BackendAction[] => {
    if (sameStatus(entry.status, status)) return []
    entry.status = status
    const { terminalId } = entry.key
    return [{ type: "terminal/status", target: target(entry.key), terminalId, status }]
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
    const activity = terminalActivity(summary)
    const { terminalId } = entry.key
    // A shell that ended cleanly takes its terminal with it.
    if (activity.status === "clean")
      return [{ type: "terminal/close", target: target(entry.key), terminalId }]
    if (restartable(activity.status)) entry.settled = true
    const actions = statusAction(entry, activity.status)
    const { process } = activity
    if (!process || entry.process === processKey(process)) return actions
    entry.process = processKey(process)
    return [
      ...actions,
      { type: "terminal/process", target: target(entry.key), terminalId, process },
    ]
  }

  // Notes each new runner process, from whichever status watch sees it first.
  const noteRunner = (status: RunnerStatus): void => {
    if (status.state !== "connected") return
    if (runnerId !== undefined && runnerId !== status.runnerId) {
      restarts.push(now())
      // A new runner counts runs from 1 again.
      for (const entry of entries.values()) {
        entry.run = undefined
        entry.floor = 0
      }
      noteCrashLoop()
    }
    runnerId = status.runnerId
  }

  // The crashes behind the guard, for the footer and the crash-loop dialog: counted
  // while the guard holds, 0 once the restarts that tripped it fall out of the window.
  const crashLooping = createStore(0)
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
  }
  // Repeats `operation` until the runner answers: after each reconnection, and with a
  // growing pause while too many calls are in flight. It stops, rejecting with
  // Cancelled, once the work is no longer wanted or the backend stopped. Any other
  // error rejects.
  const untilAnswered = async <T>(
    operation: () => Promise<T>,
    { done = [], stillWanted = () => {}, cancelled = () => false }: Retry = {},
  ): Promise<T | undefined> => {
    const unwanted = (): boolean => halted || cancelled()
    for (let attempt = 0; ; attempt += 1) {
      if (unwanted()) throw new Cancelled()
      try {
        // eslint-disable-next-line no-await-in-loop -- One attempt at a time.
        return await operation()
      } catch (error) {
        if (done.length && hasCode(error, ...done)) return undefined
        if (hasCode(error, "RESOURCE_LIMIT")) {
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

  // Ends the shell, retrying while the runner is unreachable. A terminal already gone,
  // or one another window controls, is left as it is.
  const endShell = async (entry: RunnerEntry): Promise<void> => {
    if (!(await entry.ready) && !entry.requested) return
    await untilAnswered(() => runner.terminals.close(entry.key.terminalId), {
      done: ["TERMINAL_NOT_FOUND", "TERMINAL_EXITED", "NOT_FOUND"],
    }).catch(() => {})
  }

  // Starts the shell once its session exists; a failure shows on the terminal's tab.
  const createTerminal = (entry: RunnerEntry): Promise<boolean> => {
    const { terminalId, workspaceSessionId } = entry.key
    const session = sessions.get(workspaceSessionId) ?? created
    return track(
      session.then(async (ok) => {
        if (!ok) throw new Error("The runner could not create this session.")
        const { cwd, fail } = options.debug?.takeCreate() ?? {}
        if (fail) throw new RunnerError(fail, "Simulated by the debug panel.")
        const summary = await untilAnswered(
          () => {
            entry.requested = true
            return runner.terminals.create({
              id: terminalId,
              sessionId: workspaceSessionId,
              ...(cwd ? { cwd } : {}),
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
        return true
      }),
    ).catch((error: unknown) => {
      if (error instanceof Cancelled) return false
      settle(entry, error instanceof CrashLoop ? crashLoop : (lostStatus(error) ?? failedToCreate))
      return false
    })
  }

  // Starts a fresh shell for the terminal, keeping its id: a restart when the runner
  // still has the exited record, a create when it does not. Its surface attaches again.
  const freshShell = (entry: RunnerEntry): void => {
    if (entry.closed || entry.starting) return
    const { terminalId, workspaceSessionId } = entry.key
    const { cols, rows } = entry.size
    // A runner that keeps dying while this shell starts is a crash loop; stop waiting.
    const stillWanted = (): void => {
      if (restartingOften()) throw new CrashLoop()
    }
    const retry: Retry = { done: ["CONFLICT"], stillWanted, cancelled: () => entry.closed }
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
              return runner.terminals.restart(terminalId, { cols, rows })
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
  }

  // The runner no longer has the terminal: start a fresh shell in place once its
  // session is on screen, unless the runner keeps restarting.
  const markLost = (entry: RunnerEntry): void => {
    if (entry.closed || entry.starting) return
    entry.lost = true
    entry.confirmed = false
    if (entry.settled) return
    if (restartingOften()) return settle(entry, crashLoop)
    dispatch(statusAction(entry, { state: "starting" }))
    if (onScreen(entry)) freshShell(entry)
  }

  const onScreen = (entry: RunnerEntry): boolean => {
    const project = latest?.projects.find((item) => item.id === latest?.activeProjectId)
    return (
      project?.id === entry.key.projectId &&
      project.activeSessionId === entry.key.workspaceSessionId
    )
  }
  // Lost terminals of the session on screen get their fresh shells.
  const reviveOnScreen = (): void => {
    for (const entry of entries.values())
      if (entry.lost && !entry.settled && !entry.starting && onScreen(entry)) {
        if (restartingOften()) settle(entry, crashLoop)
        else freshShell(entry)
      }
  }

  const registry = createTerminalRegistry<RunnerEntry>({
    open: (key, terminal: TerminalMetadata, isNew) => {
      const lost = !isNew && lostAtStart.has(key.terminalId)
      const entry: RunnerEntry = {
        key,
        ready: Promise.resolve(!lost),
        lost,
        starting: false,
        run: isNew ? undefined : runs.get(key.terminalId),
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
        process: processKey(terminal),
      }
      if (isNew) entry.ready = createTerminal(entry)
      entries.set(key.terminalId, entry)
      return entry
    },
    close: (entry, key) => {
      entry.closed = true
      entries.delete(key.terminalId)
      void track(endShell(entry))
      checkBoot()
    },
  })

  // Every changed session is sent after a quiet spell, or at once on pagehide.
  const saves = createSessionSaves({
    save: (sessionId, state) => runner.sessions.save({ sessionId, state }),
    ready: (id) => sessions.get(id),
    latest: () => latest,
    track,
    halted: () => halted,
    delay: saveDelay,
    saved: listing.flatMap(({ sessions: listed }) =>
      listed.flatMap(({ session }) =>
        session.state === null ? [] : [[session.id, session.state] as const],
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
    registry.reconcile(workspace, actions)
    saves.note(workspace)
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
      const status = exitStatus(exit)
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
        // Evicted after exiting, or closed by another client: a restart must create it.
        const entry = entries.get(change.terminalId)
        if (entry && !entry.starting) markLost(entry)
        return
      }
      if (change.type === "changed") {
        const entry = entries.get(change.terminal.id)
        reported.add(change.terminal.id)
        if (!entry || entry.closed) return
        if (!entry.confirmed) entry.confirmedIn = round
        entry.confirmed = true
        dispatch(activityActions(entry, change.terminal))
        return
      }
      // Terminals confirmed during this round may have been created after the runner
      // listed its terminals for it, so only earlier ones can be missing.
      const ended = [...entries.values()].filter(
        (entry) =>
          entry.confirmed && entry.confirmedIn < round && !reported.has(entry.key.terminalId),
      )
      reported.clear()
      round += 1
      for (const entry of ended) markLost(entry)
    }
    const onStatus = (status: RunnerStatus): void => {
      if (!live) return
      lastStatus = status
      showConnection()
      noteRunner(status)
      if (status.state === "connected") saves.schedule()
    }
    const changes = runner.terminals.watch()
    const statuses = runner.watch()
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
    void consume(statuses, onStatus)
    window.addEventListener("pagehide", flush)
    const stopOutage = options.debug?.outage.subscribe(showConnection)
    return () => {
      live = false
      if (sink === next) sink = undefined
      void changes.return?.()
      void statuses.return?.()
      window.removeEventListener("pagehide", flush)
      stopOutage?.()
      // The last changes are saved; nothing retries after this.
      flush()
      halted = true
    }
  }

  const backend: Backend = {
    seed,
    newTerminal: ({ number, directory }) => startingTerminal(newId(), number, directory),
    commit,
    TerminalSurface: createRunnerTerminal(runtime),
    start,
    connection,
    crashLoop: { crashes: crashLooping, retry: retryAfterCrashLoop },
    boot: boot.store,
    ...(options.pickDirectory ? { pickDirectory: options.pickDirectory } : {}),
    ...(options.debug
      ? {
          DebugPanel: createDebugPanel(options.debug, {
            write: async (key, data) => {
              const attachment = entries.get(key.terminalId)?.attachment
              if (!attachment) return false
              await attachment.write(data)
              return true
            },
            info: () => ({
              runnerId,
              connection: connection.getSnapshot(),
              restarts: restarts.filter((time) => now() - time < restartWindowMs).length,
              terminals: entries.size,
            }),
          }),
        }
      : {}),
  }
  return {
    backend,
    holds: (key) => registry.get(key) !== undefined,
    restart: runtime.restart,
    idle: async () => {
      const busy = (): boolean => saves.busy() || pending.size > 0
      while (busy()) {
        flush()
        // eslint-disable-next-line no-await-in-loop -- Settled work may start more.
        await Promise.allSettled(pending)
      }
    },
  }
}
