import { createStore, type MutableStore } from "../../../model/store"
import type { Workspace } from "../../../model/types"
import type { BootRehearsals } from "../../boot-rehearsal"
import type {
  Backend,
  BackendConnectionState,
  BackendSink,
  BootProgress,
  TerminalKey,
} from "../../port"
import { createDemo, type DemoVariant } from "../variants"
import { createDebugPanel } from "./DebugPanel"
import { createDemoStates } from "./states"
import type { DemoActionContext } from "./types"

// What one connection to the demo knows of the boot that made it, and how the panel
// asks for another.
export type DemoLaunch = {
  readonly rehearsals: BootRehearsals
  readonly variant: DemoVariant
  // The restored terminals attach one by one, for a few seconds.
  readonly slowAttach: boolean
  // Boots into another variant.
  readonly switchVariant: (variant: DemoVariant) => void
  // Boots again, with the next boot attaching slowly.
  readonly armSlowAttach: () => void
}

// What the panel's groups read and change of the shell around the demo.
export type DemoShell = {
  readonly connection: MutableStore<BackendConnectionState>
  readonly crashes: MutableStore<number>
  // Shows the connection as reconnecting for a while, then connected again.
  readonly reconnect: (ms: number) => void
  // Offline until toggled back.
  readonly toggleOffline: () => void
  // Counts the crash loop and fails the terminals of the session on screen.
  readonly tripCrashLoop: (context: DemoActionContext) => void
  readonly terminals: () => number
}

const crashLoopMessage = "Runner keeps crashing"
// More restarts than the runner's guard allows in a minute.
const crashCount = 4
const attachMs = 3_000

const terminalCount = (workspace: Workspace | undefined): number =>
  workspace?.projects
    .flatMap((project) => project.history)
    .reduce((count, session) => count + session.state.roster.terminals.length, 0) ?? 0

// Wraps a demo variant in the shell the runner's backend has around it: a connection
// that can drop, a crash loop that can trip, a boot that takes its time, and the states
// the runner's terminals, agents and desktop can be in, all driven by the debug panel.
export const createDebugDemo = (launch: DemoLaunch): Backend => {
  const connection = createStore<BackendConnectionState>("connected")
  const crashes = createStore(0)
  const states = createDemoStates()
  let sink: BackendSink | undefined
  let latest: Workspace | undefined
  let failed: readonly TerminalKey[] = []
  let outage: ReturnType<typeof setTimeout> | undefined
  const restart = (key: TerminalKey): void => {
    if (sink) states.restart(key, sink.dispatch)
  }
  const inner = createDemo(launch.variant, { connection, screens: states.screens, restart })
  const total = Math.max(
    1,
    inner.seed.projects.reduce(
      (count, project) =>
        count + project.sessions.reduce((sum, session) => sum + session.terminals.length, 0),
      0,
    ),
  )
  const boot = createStore<BootProgress>({ attached: 0, total, done: false })

  const shell: DemoShell = {
    connection,
    crashes,
    reconnect: (ms) => {
      clearTimeout(outage)
      connection.update(() => "reconnecting")
      outage = setTimeout(() => connection.update(() => "connected"), ms)
    },
    toggleOffline: () => {
      clearTimeout(outage)
      connection.update((state) => (state === "unavailable" ? "connected" : "unavailable"))
    },
    tripCrashLoop: ({ selected, workspace, dispatch, note }) => {
      const key = selected()
      const session = workspace()
        ?.projects.find((project) => project.id === key?.projectId)
        ?.history.find((each) => each.id === key?.workspaceSessionId)
      if (!key || !session || !dispatch) return note("Select a terminal first.")
      const target = { projectId: key.projectId, workspaceSessionId: key.workspaceSessionId }
      const terminals = session.state.roster.terminals
      dispatch(
        terminals.map((terminal) => ({
          type: "terminal/status",
          target,
          terminalId: terminal.id,
          status: { state: "failed", message: crashLoopMessage },
        })),
      )
      failed = terminals.map((terminal) => ({ ...target, terminalId: terminal.id }))
      crashes.update(() => crashCount)
    },
    terminals: () => terminalCount(latest),
  }

  const retry = (): void => {
    crashes.update(() => 0)
    failed.forEach(restart)
    failed = []
  }

  return {
    ...inner,
    commit: (workspace, actions) => {
      latest = workspace
      inner.commit(workspace, actions)
    },
    start: (next) => {
      sink = next
      const stopInner = inner.start?.(next)
      if (launch.variant === "welcome") states.openWelcome()
      // The terminals attach one after another until all are.
      const ticker = launch.slowAttach
        ? setInterval(() => {
            const { attached } = boot.getSnapshot()
            boot.update(() => ({ attached: attached + 1, total, done: attached + 1 >= total }))
            if (attached + 1 >= total) clearInterval(ticker)
          }, attachMs / total)
        : undefined
      return () => {
        clearInterval(ticker)
        clearTimeout(outage)
        stopInner?.()
        if (sink === next) sink = undefined
      }
    },
    connection,
    crashLoop: { crashes, retry },
    ...(launch.slowAttach ? { boot } : {}),
    agents: states.agents,
    notices: states.notices,
    pickDirectory: states.pickDirectory,
    DebugPanel: createDebugPanel({
      launch,
      shell,
      states,
      dispatch: () => sink?.dispatch,
      workspace: () => latest,
    }),
  }
}
