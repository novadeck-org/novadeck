import { flushSync } from "react-dom"

import {
  terminalElement,
  terminalSurface,
  workspaceArea,
  workspaceContent,
} from "../interaction/dom"

let active: ViewTransition | undefined
let revision = 0

export const cancelTerminalTransition = (): void => {
  revision += 1
  active?.skipTransition()
}

// Grid measures its container and Canvas restores its camera after mounting.
// View transitions suspend animation frames while waiting for this update.
const waitForLayout = (id?: string): Promise<void> =>
  new Promise((resolve) => {
    let previous = ""
    let stable = 0
    let frames = 0
    const measure = (): void => {
      const element = id ? terminalElement(id) : workspaceContent()
      const rect = element?.getBoundingClientRect()
      const current = rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : ""
      stable = current && current === previous ? stable + 1 : 0
      frames += 1
      if (stable >= 2 || frames >= 12) {
        resolve()
        return
      }
      previous = current
      setTimeout(measure, 16)
    }
    setTimeout(measure, 16)
  })

const transitionView = (update: () => void, id?: string, direction: 1 | -1 = 1): void => {
  const pending = active
  cancelTerminalTransition()
  if (
    pending ||
    !document.startViewTransition ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    update()
    return
  }

  if (!id) document.documentElement.style.setProperty("--workspace-direction", String(direction))
  const version = revision
  const marked: HTMLElement[] = []
  const mark = (element: HTMLElement | null, name: string): void => {
    if (!element) return
    element.style.viewTransitionName = name
    marked.push(element)
  }
  const markTerminal = (): void => {
    if (!id) return
    const element = terminalElement(id)
    const area = workspaceArea()?.getBoundingClientRect()
    const rect = element?.getBoundingClientRect()
    if (
      !element ||
      !rect ||
      !area ||
      rect.right <= area.left ||
      rect.left >= area.right ||
      rect.bottom <= area.top ||
      rect.top >= area.bottom
    )
      return
    mark(element, "terminal-focus")
    const content = terminalSurface(element)
    if (content && !content.hidden) mark(content, "terminal-content")
  }

  mark(workspaceArea(), id ? "terminal-workspace" : "workspace-mode")
  markTerminal()
  const transition = document.startViewTransition(async () => {
    if (version !== revision) return
    flushSync(update)
    await waitForLayout(id)
    if (version === revision) markTerminal()
  })
  active = transition
  // Skipping a transition is an expected outcome when navigating again.
  void transition.ready.catch(() => {})
  void transition.finished
    .finally(() => {
      for (const element of marked) element.style.removeProperty("view-transition-name")
      if (!id) document.documentElement.style.removeProperty("--workspace-direction")
      if (active === transition) active = undefined
    })
    .catch(() => {})
}

export const transitionTerminal = (id: string, update: () => void): void =>
  transitionView(update, id)

export const transitionWorkspace = (update: () => void, direction: 1 | -1): void =>
  transitionView(update, undefined, direction)
