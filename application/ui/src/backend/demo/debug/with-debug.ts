import type { SandboxState } from "#core/sandbox"
import { createStore, type MutableStore } from "#core/store"
import type { Workspace } from "#core/types"

import type {
  Backend,
  BackendConnectionState,
  BackendSink,
  BootProgress,
  TerminalKey,
  ThemeSource,
} from "../../port"
import { isDemoInbox } from "../inbox"
import { isDemoMurmur } from "../murmur"
import { demoTurns } from "../turns"
import { createDemo, type DemoVariant } from "../variants"
import { isDemoVoice } from "../voice"
import type { BootRehearsals } from "./boot-rehearsal"
import { createDebugPanel, type DebugPanel } from "./DebugPanel"
import { doorbellGroups } from "./doorbell"
import { inboxGroups } from "./inbox"
import { murmurGroups } from "./murmur"
import { planGroups } from "./plans"
import { createDemoPortable, type DemoPortable } from "./portable"
import { createDemoSandbox } from "./sandbox"
import { createDemoStates } from "./states"
import type { DemoActionContext } from "./types"
import { createDemoUninstall, type DemoUninstall } from "./uninstall"
import { updatesGroup, type DemoUpdates } from "./updates"
import { voiceGroups } from "./voice"

// What one connection to the demo knows of the boot that made it, and how the panel
// asks for another.
export type DemoLaunch = {
  readonly rehearsals: BootRehearsals
  // The page's theme, which the terminals draw in.
  readonly theme: ThemeSource
  readonly variant: DemoVariant
  // The restored terminals attach one by one, for a few seconds.
  readonly slowAttach: boolean
  // Boots into another variant.
  readonly switchVariant: (variant: DemoVariant) => void
  // Boots again, with the next boot attaching slowly.
  readonly armSlowAttach: () => void
  // What the host says of its sandbox; undefined where it says nothing, as in a browser.
  readonly sandbox: SandboxState | undefined
  // Boots again with the host saying this of its sandbox (or nothing).
  readonly setSandbox: (sandbox: SandboxState | undefined) => void
  // The portable copy the host plays; undefined for an installed one.
  readonly portable: DemoPortable | undefined
  // Boots again as this portable copy (or an installed one).
  readonly setPortable: (portable: DemoPortable | undefined) => void
  // Boots again as an installed copy, then plays this on its updates: the Updates group's
  // way out of a portable copy, whose install entry would stand in for them.
  readonly bootInstalled: (play: (updates: DemoUpdates) => void) => void
  // What to play on this boot's updates, as `bootInstalled` armed it.
  readonly play: ((updates: DemoUpdates) => void) | undefined
  // The uninstall the host offers; undefined for a host that offers none.
  readonly uninstall: DemoUninstall | undefined
  // Boots again with the host offering this uninstall (or none).
  readonly setUninstall: (uninstall: DemoUninstall | undefined) => void
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

// Each debug demo's panel, by its backend: the content preview's entry hands it to the app
// (see src/entries/previews.tsx), as a panel isn't part of what a backend offers.
const panels = new WeakMap<Backend, DebugPanel>()

/** The debug panel for a backend `createDebugDemo` made. */
export const debugPanelOf = (backend: Backend): DebugPanel | undefined => panels.get(backend)

// Wraps a demo variant in the shell the runner's backend has around it: a connection
// that can drop, a crash loop that can trip, a boot that takes its time, and the states
// the runner's terminals, agents and desktop can be in, all driven by the debug panel.
export const createDebugDemo = (launch: DemoLaunch): Backend => {
  const connection = createStore<BackendConnectionState>("connected")
  const crashes = createStore(0)
  const turns = demoTurns()
  const states = createDemoStates(turns)
  if (launch.portable?.offer) states.offer(launch.portable.offer)
  launch.play?.(states.updateControls)
  let sink: BackendSink | undefined
  let latest: Workspace | undefined
  let failed: readonly TerminalKey[] = []
  let outage: ReturnType<typeof setTimeout> | undefined
  const restart = (key: TerminalKey): void => {
    if (sink) states.restart(key, sink.dispatch)
  }
  const inner = createDemo(
    launch.variant,
    {
      theme: launch.theme,
      runtime: { connection, screens: states.screens, restart, failPaste: states.failPaste },
    },
    turns,
  )
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
      for (const terminal of terminals) turns.release({ ...key, terminalId: terminal.id })
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

  const backend: Backend = {
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
    updates: states.updates,
    ...(launch.sandbox ? { sandbox: createDemoSandbox(launch.sandbox) } : {}),
    ...(launch.portable ? { portable: createDemoPortable(launch.portable).portable } : {}),
    ...(launch.uninstall ? { uninstall: createDemoUninstall(launch.uninstall).uninstall } : {}),
    pickDirectory: states.pickDirectory,
    ...(inner.conversations ? { conversations: states.chat(inner.conversations) } : {}),
  }
  panels.set(
    backend,
    createDebugPanel({
      launch,
      shell,
      states: {
        ...states,
        groups: [
          ...states.groups,
          updatesGroup(launch, states.updateControls),
          ...inboxGroups(isDemoInbox(inner.inbox) ? inner.inbox : undefined),
          ...planGroups(inner.companions),
          ...doorbellGroups(inner.messages),
          ...murmurGroups(isDemoMurmur(inner.murmur) ? inner.murmur : undefined),
          ...voiceGroups(isDemoVoice(inner.voice) ? inner.voice : undefined),
        ],
      },
      dispatch: () => sink?.dispatch,
      workspace: () => latest,
      addInBackground: (to) => {
        const target = { projectId: to.projectId, workspaceSessionId: to.workspaceSessionId }
        const directory = latest?.projects.find((each) => each.id === to.projectId)?.directory
        const terminal = inner.newTerminal({ target, directory: directory ?? "~" })
        sink?.dispatch([{ type: "terminal/add", target, terminal, select: false }])
        return { ...target, terminalId: terminal.id }
      },
    }),
  )
  return backend
}
