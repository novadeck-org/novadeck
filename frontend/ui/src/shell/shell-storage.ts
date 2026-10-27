import type { SidebarPanel, WindowedView } from "@novadeck/core/types"

import { railOrder } from "./rail-order"

export const collapsedStorageKey = "novadeck.sidebar-collapsed"
export const readSidebarCollapsed = (): boolean => {
  try {
    return localStorage.getItem(collapsedStorageKey) === "true"
  } catch {
    return false
  }
}
export const windowedStorageKey = "novadeck.windowed-view"
export const readWindowedView = (): WindowedView => {
  try {
    return localStorage.getItem(windowedStorageKey) === "canvas" ? "canvas" : "grid"
  } catch {
    return "grid"
  }
}

// The order the person left the footer's subscriptions in, by program.
export const subscriptionOrderStorageKey = "novadeck.subscription-order"
export const readSubscriptionOrder = (): readonly string[] => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(subscriptionOrderStorageKey) ?? "[]")
    return Array.isArray(stored) ? stored.filter((each) => typeof each === "string") : []
  } catch {
    return []
  }
}

// The order the person left the rail's panels in.
export const sidebarOrderStorageKey = "novadeck.sidebar-order"
export const readSidebarOrder = (): readonly SidebarPanel[] => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(sidebarOrderStorageKey) ?? "[]")
    return railOrder(Array.isArray(stored) ? stored.filter((each) => typeof each === "string") : [])
  } catch {
    return railOrder([])
  }
}

// The release whose footer update chip the person folded to its icon, by closing its card
// or opening its page; "install" for a portable copy's chip with no release. A newer release
// brings the word back.
export const foldedChipStorageKey = "novadeck.update-chip-folded"
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

export const writeSubscriptionOrder = (order: readonly string[]): void => {
  try {
    localStorage.setItem(subscriptionOrderStorageKey, JSON.stringify(order))
  } catch {
    /* The order holds for this session when storage is unavailable. */
  }
}

export const writeSidebarOrder = (order: readonly SidebarPanel[]): void => {
  try {
    localStorage.setItem(sidebarOrderStorageKey, JSON.stringify(order))
  } catch {
    /* The order holds for this session when storage is unavailable. */
  }
}

export const writeFoldedChip = (subject: string): void => {
  try {
    localStorage.setItem(foldedChipStorageKey, subject)
  } catch {
    /* The chip folds for this session when storage is unavailable. */
  }
}
