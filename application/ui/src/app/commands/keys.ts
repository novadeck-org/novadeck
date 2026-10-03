import type { CommandId, KeyBinding, KeyInput, KeyPhase, KeyState } from "../../interaction/keymap"
import { hasTile, orderedTiles, tilesOf } from "../../model/roster"
import { viewModes } from "../../model/state"
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
  // "next" hands the key to the next matching binding.
  readonly run: (input: KeyInput, args?: number) => "handled" | "next"
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
    "selection.clear": {
      available: () =>
        Boolean(state().selected) || sidebarVisible(ui.getSnapshot().shell, effects.desktop()),
      run: handled(() => {
        const { selected, view } = state()
        if (!selected) {
          commands.hideSidebar()
          return
        }
        // Focus keeps showing the terminal as a preview.
        if (view === "focus")
          commands.setFocusPreview({
            context: currentContext(workspace.getSnapshot()),
            id: selected,
          })
        commands.setKeyboardFocus(null)
        commands.setSelected("")
        effects.focusWorkspaceViewport()
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
    "terminal.step": {
      run: (input, args) => {
        const { view, selected, roster } = state()
        const ordered = orderedTiles(roster)
        if (!ordered.length) return "handled"
        const step = direction(args)
        const index = ordered.findIndex((terminal) => terminal.id === selected)
        const next =
          index < 0
            ? step > 0
              ? 0
              : ordered.length - 1
            : (index + step + ordered.length) % ordered.length
        const terminal = ordered[next]!
        if (view === "canvas" && input.target.canvasNode) commands.requestCanvasFocus(terminal.id)
        commands.select(terminal.id)
        if ((input.target.viewSwitch || input.target.terminalTab) && terminalsPanelVisible())
          effects.focusTerminalTab(terminal.id)
        return "handled"
      },
    },
    "view.step": {
      run: (_input, args) => {
        const { view } = state()
        const modes = viewModes.filter((mode) =>
          ui.getSnapshot().preferences.enabledViews.includes(mode),
        )
        const next = modes[(modes.indexOf(view) + direction(args) + modes.length) % modes.length]
        if (next && next !== view) commands.changeView(next)
        return "handled"
      },
    },
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
  }
}

// Runs routed bindings in order until one handles the key. An unavailable command
// ends routing and lets the key through; a repeat of a `swallow` binding is handled
// without running. Keyup and blur are never reported as handled.
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
    if (command.run(input, binding.args) === "next") continue
    return keydown ? "handled" : "passed"
  }
  return "passed"
}
