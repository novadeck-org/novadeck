import { createStore } from "@novadeck/core/store"
import type { TerminalKey } from "@novadeck/core/types"

import { terminalElement } from "../interaction/dom"

// Which agent window the "Ask @handle to write feedback…" card is open for, if any. A window's
// menu opens it and the card (`AskAgent`) shows it, so the two share this one store; the
// menus are in the sidebar and in every window's header, far from where the card is mounted.
export type AskTarget = { readonly key: TerminalKey; readonly handle: string }

export const askAgentStore = createStore<AskTarget | null>(null)

export const openAskAgent = (target: AskTarget): void => {
  askAgentStore.update(() => target)
}
export const closeAskAgent = (): void => {
  askAgentStore.update(() => null)
}

// What the card hangs from: that window's header, in Focus, Grid or Canvas alike. Null where
// the window isn't on screen, as from the sidebar's tab for a terminal another is selected
// over, or is parked (hidden, so its header measures nothing).
export const headerOf = (terminalId: string): HTMLElement | null => {
  const header = terminalElement(terminalId)?.querySelector<HTMLElement>(".terminal-header")
  if (!header) return null
  const { width, height } = header.getBoundingClientRect()
  return width > 0 && height > 0 ? header : null
}
