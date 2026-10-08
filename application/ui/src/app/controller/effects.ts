import {
  focusSidebarToggle,
  focusTerminalInput,
  focusTerminalTab,
  tileRects,
  workspaceArea,
  focusWorkspaceViewport,
  focusZenCreate,
  focusZenEnter,
} from "../../interaction/dom"
import { cancelTerminalTransition, transitionTerminal } from "../../layouts/transition"
import { isDesktop } from "../../shell/desktop"
import type { CommandEffects } from "../commands/context"

// What commands do to the page: focus, view transitions, timers and the clock.
export const domEffects: CommandEffects = {
  transitionTerminal,
  cancelTransition: cancelTerminalTransition,
  focusSidebarToggle,
  focusZenCreate,
  focusZenEnter,
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
  stageSize: () => {
    const rect = workspaceArea()?.getBoundingClientRect()
    return rect && rect.width > 0 && rect.height > 0
      ? { width: rect.width, height: rect.height }
      : undefined
  },
}
