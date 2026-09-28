import type { CommandContext, CommandEffects } from "../app/commands/context"
import { createNavigator, type RouterNavigate } from "../app/commands/navigator"
import { createWorkspaceCommands } from "../app/commands/workspace"
import { resolveRoute } from "../app/routing"
import {
  createUiStore,
  initialUi,
  trackRecent,
  watchClosing,
  watchCrashLoop,
  watchPresentation,
  watchSwitcher,
} from "../app/ui-store"
import type { Backend } from "../backend/port"
import type { CanvasHandle } from "../layouts/canvas/types"
import { activeSession } from "../model/state"
import { createWorkspaceStore } from "../model/store"
import type { PreferencesValue, Workspace } from "../model/types"
import { workspaceFixture } from "./fixtures"

export type CommandsOptions = {
  readonly workspace?: Workspace
  // Where the app opens, e.g. `/projects/project/sessions/initial/grid?terminal=01`.
  readonly url?: string
  readonly preferences?: PreferencesValue
  readonly desktop?: boolean
  readonly canvas?: CanvasHandle
  // The backend's folder picker, when it offers one.
  readonly pickDirectory?: () => Promise<string | null>
  // The backend's crash count and restart, when it reports crash loops.
  readonly crashLoop?: Backend["crashLoop"]
}

// Real stores, navigator, commands and store subscriptions over a fixture workspace, with effects that
// record what they would do to the page. Frames and microtasks wait for `flush`;
// `after` uses the timer functions, so fake timers control it.
export const openCommands = ({
  workspace = workspaceFixture(),
  url = "/projects/project/sessions/initial/grid?terminal=01",
  preferences = { fontSize: 13, enabledViews: ["focus", "grid", "canvas"] },
  desktop = true,
  canvas,
  pickDirectory,
  crashLoop,
}: CommandsOptions = {}) => {
  const [pathname = "", query = ""] = url.split("?")
  const resolved = resolveRoute(workspace, { pathname, search: `?${query}` }, preferences, 0)
  const store = createWorkspaceStore(resolved.workspace)
  const ui = createUiStore(
    initialUi({
      location: { route: resolved.route, dialogDepth: 0, navigationType: "POP" },
      preferences,
    }),
  )
  const effects: string[] = []
  const queued: (() => void)[] = []
  const screen = { desktop }
  let ids = 0
  const record: CommandEffects = {
    transitionTerminal: (id, update) => {
      effects.push(`transition ${id}`)
      update()
    },
    cancelTransition: () => effects.push("cancel transition"),
    focusSidebarToggle: (panel) => effects.push(`focus ${panel} toggle`),
    focusZenCreate: () => effects.push("focus zen create"),
    focusZenEnter: () => effects.push("focus zen enter"),
    focusWorkspaceViewport: () => effects.push("focus viewport"),
    focusTerminalTab: (id) => effects.push(`focus tab ${id}`),
    refocus: (element) => {
      effects.push("refocus")
      if (element.isConnected) element.focus({ preventScroll: true })
    },
    afterFrame: (run) => queued.push(run),
    afterMicrotask: (run) => queued.push(run),
    after: (ms, run) => {
      const timeout = setTimeout(run, ms)
      return () => clearTimeout(timeout)
    },
    desktop: () => screen.desktop,
    now: () => Date.UTC(2026, 8, 26, 14, 5),
    newId: () => `session-${++ids}`,
  }
  const {
    bind,
    settle: _settle,
    ...navigation
  } = createNavigator({
    workspace: store,
    ui,
    now: () => 1,
  })
  const urls: (string | number)[] = []
  bind(((to: string | number) => urls.push(to)) as RouterNavigate)
  const context: CommandContext = {
    workspace: store,
    ui,
    navigation,
    newTerminal: ({ number, directory }) => ({
      id: `new-${number}`,
      name: `Terminal ${String(number).padStart(2, "0")}`,
      directory,
      command: "zsh",
      process: "zsh",
      state: "idle",
    }),
    canvas: { current: canvas ?? null },
    effects: record,
    pickDirectory,
    crashLoop,
  }
  const commands = createWorkspaceCommands(context)
  // The subscriptions the provider attaches; nothing persists to storage here.
  for (const watch of [trackRecent, watchPresentation, watchSwitcher, watchClosing])
    watch(store, ui)
  watchCrashLoop(crashLoop?.crashes, ui)
  return {
    context,
    workspace: store,
    ui,
    commands,
    navigation,
    // Effects in the order they ran, and the URLs the router was asked for.
    effects,
    urls,
    screen,
    flush: (): void => queued.splice(0).forEach((run) => run()),
    state: () => activeSession(store.getSnapshot())!.state,
    shell: () => ui.getSnapshot().shell,
  }
}
