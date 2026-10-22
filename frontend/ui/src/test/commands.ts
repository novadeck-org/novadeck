import { createChat } from "@novadeck/chat/state"
import type { Rect } from "@novadeck/core/layout/spatial"
import type { Backend } from "@novadeck/core/port"
import { activeSession } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { appearance, workspaceFixture } from "@novadeck/core/testing"
import type { PreferencesValue, Workspace } from "@novadeck/core/types"

import type { CommandContext, CommandEffects } from "../app/commands/context"
import { createNavigator, type RouterNavigate } from "../app/commands/navigator"
import { createWorkspaceCommands } from "../app/commands/workspace"
import { availablePanels, resolveRoute } from "../app/routing"
import {
  createUiStore,
  initialUi,
  trackRecent,
  watchClosing,
  watchCrashLoop,
  watchPresentation,
  watchSwitcher,
} from "../app/ui-store"
import type { CanvasHandle } from "../layouts/canvas/types"

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
  // The backend's way to hand a name back, when it has one.
  readonly resetTitle?: Backend["resetTitle"]
  // The item store, when the backend has companions.
  readonly itemStore?: CommandContext["itemStore"]
  // The backend's companions, when it has them.
  readonly companions?: CommandContext["companions"]
  // The agents' conversations, when the backend reads them.
  readonly conversations?: CommandContext["conversations"]
  // Murmur, when the backend has it.
  readonly murmur?: CommandContext["murmur"]
}

// Real stores, navigator, commands and store subscriptions over a fixture workspace, with effects that
// record what they would do to the page. Frames and microtasks wait for `flush`;
// `after` uses the timer functions, so fake timers control it.
export const openCommands = ({
  workspace = workspaceFixture(),
  url = "/projects/project/sessions/initial/grid?terminal=01",
  preferences = {
    fontSize: 13,
    enabledViews: ["focus", "grid", "canvas"],
    appearance,
    notifyFinished: true,
    ligatures: false,
    chatView: false,
  },
  desktop = true,
  canvas,
  pickDirectory,
  crashLoop,
  resetTitle,
  itemStore,
  companions,
  conversations,
  murmur,
}: CommandsOptions = {}) => {
  const [pathname = "", query = ""] = url.split("?")
  const resolved = resolveRoute(
    workspace,
    { pathname, search: `?${query}` },
    preferences,
    0,
    availablePanels(true),
  )
  const store = createWorkspaceStore(resolved.workspace)
  const ui = createUiStore(
    initialUi({
      location: { route: resolved.route, dialogDepth: 0, navigationType: "POP" },
      preferences,
    }),
  )
  const chat = createChat()
  const effects: string[] = []
  const queued: (() => void)[] = []
  const screen: { desktop: boolean; tiles: { id: string; rect: Rect }[] } = {
    desktop,
    tiles: [],
  }
  let ids = 0
  const record: CommandEffects = {
    transitionTerminal: (id, update) => {
      effects.push(`transition ${id}`)
      update()
    },
    cancelTransition: () => effects.push("cancel transition"),
    focusSidebarToggle: (panel) => effects.push(`focus ${panel} toggle`),
    focusSidebarToggleStranded: (panel) => effects.push(`focus ${panel} toggle`),
    focusZenCreate: () => effects.push("focus zen create"),
    focusZenEnter: () => effects.push("focus zen enter"),
    focusWorkspaceViewport: () => effects.push("focus viewport"),
    focusTerminalTab: (id) => effects.push(`focus tab ${id}`),
    focusTerminalInput: (id) => (effects.push(`focus input ${id}`), true),
    tileRects: () => screen.tiles,
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
    panels: availablePanels(true),
  })
  const urls: (string | number)[] = []
  // What each new terminal was asked for, as the backend received it.
  const allocated: Parameters<Backend["newTerminal"]>[0][] = []
  const numbers = new Map<string, number>()
  bind(((to: string | number) => urls.push(to)) as RouterNavigate)
  const context: CommandContext = {
    workspace: store,
    ui,
    chat,
    navigation,
    newTerminal: (input) => {
      allocated.push(input)
      const { target, directory, title } = input
      // Standing in for the backend, it numbers each session's terminals itself.
      const count =
        store
          .getSnapshot()
          .projects.find((project) => project.id === target.projectId)
          ?.history.find((session) => session.id === target.workspaceSessionId)?.state.roster
          .terminals.length ?? 0
      const number = Math.max(numbers.get(target.workspaceSessionId) ?? count, count) + 1
      numbers.set(target.workspaceSessionId, number)
      return {
        id: `new-${number}`,
        name: title ?? "Terminal",
        directory,
        command: "zsh",
        process: "zsh",
        state: "idle",
      }
    },
    canvas: { current: canvas ?? null },
    effects: record,
    pickDirectory,
    crashLoop,
    resetTitle,
    itemStore,
    companions,
    conversations,
    murmur,
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
    chat,
    commands,
    navigation,
    // Effects in the order they ran, and the URLs the router was asked for.
    effects,
    urls,
    allocated,
    screen,
    flush: (): void => queued.splice(0).forEach((run) => run()),
    state: () => activeSession(store.getSnapshot())!.state,
    shell: () => ui.getSnapshot().shell,
  }
}
