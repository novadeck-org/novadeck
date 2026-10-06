import {
  arrowDirections,
  type Arrow,
  type CommandId,
  type KeyBinding,
  type KeyInput,
  type KeyPhase,
  type KeyState,
} from "../../interaction/keymap"
import { nearestInDirection } from "../../model/layout/spatial"
import { hasTile, isWindow, orderedTiles, tilesOf } from "../../model/roster"
import { viewModes } from "../../model/state"
import type { Tile } from "../../model/types"
import { sidebarVisible } from "../../shell/shell-state"
import { cycleRecent, moveRecent } from "../../terminals/recent"
import {
  activeTerminal,
  alertOpen,
  currentContext,
  currentState,
  windowedDestination,
} from "../selectors"
import type { CommandContext } from "./context"
import type { WorkspaceCommands } from "./workspace"

export type KeyCommand = {
  // False lets the key through unprevented and ends routing for this event.
  readonly available?: (input: KeyInput) => boolean
  // "next" hands the key to the next matching binding; "through" ends routing and lets
  // the key on, unprevented, to wherever the command moved focus.
  readonly run: (input: KeyInput, args?: number) => "handled" | "next" | "through"
}

// A command that always handles its key.
const handled = (run: () => void) => (): "handled" => {
  run()
  return "handled"
}

// What each key binding does, over the same commands the pointer UI uses.
export const createKeyCommands = (
  commands: WorkspaceCommands,
  { workspace, ui, navigation, canvas, effects }: CommandContext,
): Record<CommandId, KeyCommand> => {
  const state = () => currentState(workspace.getSnapshot())
  const panel = () => ui.getSnapshot().location.route.panel
  const terminalsPanelVisible = (): boolean =>
    panel() === "terminals" && sidebarVisible(ui.getSnapshot().shell, effects.desktop())
  // Where Focus toggles to: Focus itself, or back to the windowed view.
  const focusToggle = () => {
    const { view } = state()
    const next =
      view === "focus"
        ? windowedDestination(state().windowedView, ui.getSnapshot().preferences.enabledViews)
        : "focus"
    return next && ui.getSnapshot().preferences.enabledViews.includes(next) ? next : undefined
  }
  // Delete and F2 act on the selection, or in Focus on the terminal it shows.
  const targeted = () => {
    const snapshot = workspace.getSnapshot()
    const { roster, selected, view } = currentState(snapshot)
    const terminal = tilesOf(roster).find((item) => item.id === selected)
    if (terminal || view !== "focus") return terminal
    const { focusPreview } = ui.getSnapshot().shell
    return activeTerminal(tilesOf(roster), selected, currentContext(snapshot), focusPreview)
  }
  // The tile an arrow moves to from the current one: in Grid and Canvas the nearest on
  // its side, if any; in Focus or along the sidebar's list, the next in sidebar order.
  // With `typing`, only terminals: windows take no typing.
  const arrowTarget = (arrow: Arrow, inList: boolean, typing = false): string | undefined => {
    const { view, roster } = state()
    const current = targeted()?.id
    const ordered = orderedTiles(roster).filter(
      (tile) => !typing || !isWindow(tile) || tile.id === current,
    )
    if (!ordered.length) return undefined
    const tiles =
      view !== "focus" && !inList
        ? effects.tileRects().filter((tile) => ordered.some(({ id }) => id === tile.id))
        : []
    const from = tiles.find((tile) => tile.id === current)
    if (!from) return inOrder(ordered, current, arrow === "up" || arrow === "left" ? -1 : 1)
    const others = tiles.filter((tile) => tile.id !== current)
    const id = nearestInDirection(from.rect, others, arrow)
    return ordered.some((tile) => tile.id === id) ? id : undefined
  }
  const stepView = (step: 1 | -1): "handled" => {
    const { view } = state()
    const modes = viewModes.filter((mode) =>
      ui.getSnapshot().preferences.enabledViews.includes(mode),
    )
    const next = modes[(modes.indexOf(view) + step + modes.length) % modes.length]
    if (next && next !== view) commands.changeView(next)
    return "handled"
  }
  const recent = (direction: 1 | -1): KeyCommand => ({
    available: () => (commands.visibleSwitcher()?.ids ?? commands.recentIds()).length >= 2,
    run: (input) => {
      const next = cycleRecent(
        commands.visibleSwitcher(),
        {
          context: currentContext(workspace.getSnapshot()),
          ids: commands.recentIds(),
          selected: state().selected,
          fromInput: input.target.terminalInput,
        },
        direction,
      )
      if (next) commands.setSwitcher(next)
      return "handled"
    },
  })
  const sidebar = (next: "terminals" | "sessions"): KeyCommand => ({
    run: handled(() => {
      commands.setSwitcher(null)
      commands.toggleSidebar(next)
    }),
  })

  return {
    "search.open": {
      run: handled(() => {
        commands.setSwitcher(null)
        navigation.go({ dialog: "search" })
      }),
    },
    "preferences.open": {
      run: handled(() => {
        commands.setSwitcher(null)
        navigation.go({ dialog: "preferences", section: "general" })
      }),
    },
    "session.new": {
      run: handled(() => {
        commands.setSwitcher(null)
        commands.startFresh()
      }),
    },
    "sidebar.terminals": sidebar("terminals"),
    "sidebar.sessions": sidebar("sessions"),
    "recent.next": recent(1),
    "recent.previous": recent(-1),
    "view.toggleFocus": {
      available: () => Boolean(focusToggle()),
      run: (input, keepTyping) => {
        const next = focusToggle()!
        const { selected } = state()
        if (keepTyping && input.target.terminalInput && selected)
          commands.setKeyboardFocus({ id: selected, view: next })
        commands.changeView(next)
        return "handled"
      },
    },
    "terminal.new": { run: handled(() => void commands.add({ fromKeyboard: true })) },
    // Focus moves during keydown, so the character the key types follows it into the input.
    "terminal.type": {
      available: () => Boolean(state().selected),
      run: () => (effects.focusTerminalInput(state().selected) ? "through" : "next"),
    },
    "zen.toggle": {
      run: handled(() => {
        if (ui.getSnapshot().shell.zen) commands.exitZen()
        else commands.enterZen()
      }),
    },
    "terminal.rename": {
      available: () => Boolean(targeted()),
      run: handled(() =>
        commands.startRename(targeted()!, terminalsPanelVisible() ? "sidebar" : "header"),
      ),
    },
    "terminal.close": {
      available: () => Boolean(targeted()),
      run: handled(() => commands.close(targeted()!.id)),
    },
    "canvas.returnToOrigin": {
      run: (input) =>
        !input.repeat && state().view === "canvas" && canvas.current?.returnToOrigin()
          ? "handled"
          : "next",
    },
    // Keyboard focus leaves the terminal for the view, which keys then move around.
    "navigate.enter": {
      // With no terminals there is no view to move around.
      available: () => tilesOf(state().roster).length > 0,
      run: handled(() => {
        commands.setSwitcher(null)
        commands.setNavigate(true)
        effects.focusWorkspaceViewport()
      }),
    },
    // Back into the selected terminal, or the one Focus shows.
    // A window takes no typing, so Enter and Escape leave navigating only from a terminal.
    "navigate.exit": {
      available: () => {
        const tile = targeted()
        return ui.getSnapshot().shell.navigate && (!tile || !isWindow(tile))
      },
      run: handled(() => {
        commands.setNavigate(false)
        const terminal = targeted()
        if (!terminal) return
        commands.setKeyboardFocus({ id: terminal.id, view: state().view })
        if (state().selected !== terminal.id) commands.select(terminal.id)
      }),
    },
    "switcher.close": { run: handled(() => commands.closeSwitcher()) },
    "switcher.choose": {
      available: (input) => !input.target.switcherClose,
      run: handled(() => {
        const switcher = commands.visibleSwitcher()
        const id = switcher?.ids[switcher.index]
        commands.setSwitcher(null)
        if (!id) return
        commands.setKeyboardFocus({ id, view: state().view })
        commands.select(id)
      }),
    },
    "switcher.move": {
      run: (_input, args) => {
        const switcher = commands.visibleSwitcher()
        if (switcher) commands.setSwitcher(moveRecent(switcher, direction(args)))
        return "handled"
      },
    },
    // Grid and Canvas move to the nearest tile on the arrow's side and stop at the edge;
    // Focus and the sidebar's list step through sidebar order, wrapping at either end.
    "terminal.step": {
      run: (input, args) => {
        const arrow = arrowDirections[args ?? 0]!
        const inList = input.target.terminalTab
        const sideways = arrow === "left" || arrow === "right"
        // The view switch keeps Left and Right for its views; the sidebar's list runs up
        // and down only.
        if (input.target.viewSwitch && sideways) return stepView(arrow === "left" ? -1 : 1)
        if (inList && sideways) return "next"
        const id = arrowTarget(arrow, inList)
        if (!id) return "handled"
        if (state().view === "canvas" && input.target.canvasNode) commands.requestCanvasFocus(id)
        commands.select(id)
        if ((input.target.viewSwitch || input.target.terminalTab) && terminalsPanelVisible())
          effects.focusTerminalTab(id)
        return "handled"
      },
    },
    // As an arrow on the stage, then typing goes on in the terminal it reached.
    "terminal.jump": {
      run: (_input, args) => {
        const id = arrowTarget(arrowDirections[args ?? 0]!, false, true)
        if (!id || id === targeted()?.id) return "handled"
        commands.setKeyboardFocus({ id, view: state().view })
        commands.select(id)
        return "handled"
      },
    },
    "view.step": { run: (_input, args) => stepView(direction(args)) },
    "recent.commitHeld": {
      run: handled(() => {
        const switcher = commands.visibleSwitcher()
        commands.setSwitcher(null)
        const id = switcher?.ids[switcher.index]
        if (!switcher || !id || !hasTile(state().roster, id)) return
        if (switcher.fromInput) commands.setKeyboardFocus({ id, view: state().view })
        commands.select(id)
      }),
    },
    "recent.cancelHeld": { run: handled(() => commands.setSwitcher(null)) },
  }
}

const direction = (args: number | undefined): 1 | -1 => (args !== undefined && args < 0 ? -1 : 1)

// The tile `step` places from `current` in sidebar order, wrapping; with none current,
// the first going forward or the last going back.
const inOrder = (ordered: readonly Tile[], current: string | undefined, step: 1 | -1): string => {
  const index = ordered.findIndex((tile) => tile.id === current)
  const next =
    index < 0
      ? step > 0
        ? 0
        : ordered.length - 1
      : (index + step + ordered.length) % ordered.length
  return ordered[next]!.id
}

// What routing needs to know about the stores right now.
export const keyState = (
  { ui, workspace }: Pick<CommandContext, "ui" | "workspace">,
  commands: Pick<WorkspaceCommands, "visibleSwitcher">,
): KeyState => {
  const alert = alertOpen(ui.getSnapshot(), workspace.getSnapshot())
  return {
    dialog: ui.getSnapshot().location.route.dialog !== null || alert,
    alert,
    switcher: commands.visibleSwitcher()?.mode ?? null,
    held: ui.getSnapshot().recent.switcher?.mode === "held",
    navigate: ui.getSnapshot().shell.navigate,
  }
}

// Runs routed bindings in order until one handles the key. An unavailable command, or
// one that moved focus for the key, ends routing and lets the key through; a repeat of a
// `swallow` binding is handled without running. Keyup and blur are never reported as handled.
export const runKey = (
  keys: Record<CommandId, KeyCommand>,
  candidates: readonly KeyBinding[],
  phase: KeyPhase,
  input: KeyInput,
): "handled" | "passed" => {
  const keydown = phase === "capture" || phase === "bubble"
  for (const binding of candidates) {
    const command = keys[binding.command]
    if (command.available && !command.available(input)) return "passed"
    if (keydown && input.repeat && binding.repeat === "swallow") return "handled"
    const result = command.run(input, binding.args)
    if (result === "next") continue
    if (result === "through") return "passed"
    return keydown ? "handled" : "passed"
  }
  return "passed"
}
