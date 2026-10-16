import type { WindowedView } from "../model/types"

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
