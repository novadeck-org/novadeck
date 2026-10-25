import {
  focusSidebarToggle,
  focusSidebarToggleStranded,
  focusTerminalInput,
  focusTerminalTab,
  tileRects,
  focusWorkspaceViewport,
  focusZenCreate,
  focusZenEnter,
  focusTerminalsCreate,
} from "../../interaction/dom"
import { cancelTerminalTransition, transitionTerminal } from "../../layouts/transition"
import { isDesktop } from "../../shell/desktop"
import type { CommandEffects } from "../commands/context"

// What commands do to the page: focus, view transitions, timers and the clock.
export const domEffects: CommandEffects = {
  transitionTerminal,
  cancelTransition: cancelTerminalTransition,
  focusSidebarToggle,
  focusSidebarToggleStranded,
  focusZenCreate,
  focusZenEnter,
  focusTerminalsCreate,
  focusWorkspaceViewport,
  focusTerminalTab,
  focusTerminalInput,
  tileRects,
  refocus: (element) => {
    if (element.isConnected) element.focus({ preventScroll: true })
  },
  afterFrame: (run) => void requestAnimationFrame(() => run()),
  afterMicrotask: (run) => queueMicrotask(run),
  after: (ms, run) => {
    const timeout = window.setTimeout(run, ms)
    return () => window.clearTimeout(timeout)
  },
  desktop: isDesktop,
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
}
