import { registerPerson, storedPerson } from "@novadeck/core/person"
import type { SidebarPanel, WindowedView } from "@novadeck/core/types"

import { railOrder } from "./rail-order"

const collapsedStorageKey = "novadeck.sidebar-collapsed"
export const readSidebarCollapsed = (): boolean => {
  try {
    return localStorage.getItem(collapsedStorageKey) === "true"
  } catch {
    return false
  }
}
const windowedStorageKey = "novadeck.windowed-view"
export const readWindowedView = (): WindowedView => {
  try {
    return localStorage.getItem(windowedStorageKey) === "canvas" ? "canvas" : "grid"
  } catch {
    return "grid"
  }
}

const storedNames = (text: string | undefined): string[] => {
  try {
    const stored: unknown = JSON.parse(text ?? "[]")
    return Array.isArray(stored) ? stored.filter((each) => typeof each === "string") : []
  } catch {
    return []
  }
}

// The order the person left the footer's subscriptions in, by program: theirs on every
// device (core's person.ts).
export const subscriptionOrder = storedPerson("subscription-order", "novadeck.subscription-order")
registerPerson(subscriptionOrder)
export const readSubscriptionOrder = (): readonly string[] => storedNames(subscriptionOrder.read())

// The order the person left the rail's panels in: theirs on every device.
export const sidebarOrder = storedPerson("sidebar-order", "novadeck.sidebar-order")
registerPerson(sidebarOrder)
export const readSidebarOrder = (): readonly SidebarPanel[] =>
  railOrder(storedNames(sidebarOrder.read()))

// The release whose footer update chip the person folded to its icon, by closing its card
// or opening its page. Any other release brings the word back.
const foldedChipStorageKey = "novadeck.update-chip-folded"
export const readFoldedChip = (): string | null => {
  try {
    return localStorage.getItem(foldedChipStorageKey)
  } catch {
    return null
  }
}

export const writeSidebarCollapsed = (collapsed: boolean): void => {
  try {
    localStorage.setItem(collapsedStorageKey, String(collapsed))
  } catch {
    /* Collapsing still works when storage is unavailable. */
  }
}

export const writeWindowedView = (view: WindowedView): void => {
  try {
    localStorage.setItem(windowedStorageKey, view)
  } catch {
    /* Remains available for this session when storage is unavailable. */
  }
}

export const writeSubscriptionOrder = (order: readonly string[]): void =>
  subscriptionOrder.save(JSON.stringify(order))

export const writeSidebarOrder = (order: readonly SidebarPanel[]): void =>
  sidebarOrder.save(JSON.stringify(order))

export const writeFoldedChip = (subject: string): void => {
  try {
    localStorage.setItem(foldedChipStorageKey, subject)
  } catch {
    /* The chip folds for this session when storage is unavailable. */
  }
}

// The release whose "Restart to update" chip the person folded to its icon, by closing its
// card: its own, so folding the "Update available" chip of the same release leaves this one.
const foldedRestartStorageKey = "novadeck.restart-chip-folded"
export const readFoldedRestart = (): string | null => {
  try {
    return localStorage.getItem(foldedRestartStorageKey)
  } catch {
    return null
  }
}

export const writeFoldedRestart = (version: string): void => {
  try {
    localStorage.setItem(foldedRestartStorageKey, version)
  } catch {
    /* The chip folds for this session when storage is unavailable. */
  }
}
