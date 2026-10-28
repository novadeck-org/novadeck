import type { ProjectArrangement } from "./project-arrangement"

const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each) => typeof each === "string") : []

// Where the person's arrangement of the switcher's projects lived before the runner kept it:
// their order and the pinned ones. A client that finds it sends it to the runner once and
// forgets it.
export const projectArrangementStorageKey = "novadeck.project-arrangement"

export const readStoredProjectArrangement = (): ProjectArrangement | undefined => {
  try {
    const stored = JSON.parse(localStorage.getItem(projectArrangementStorageKey) ?? "null") as {
      order?: unknown
      pinned?: unknown
    } | null
    return stored && typeof stored === "object"
      ? { order: ids(stored.order), pinned: ids(stored.pinned) }
      : undefined
  } catch {
    return undefined
  }
}

export const forgetStoredProjectArrangement = (): void => {
  try {
    localStorage.removeItem(projectArrangementStorageKey)
  } catch {
    /* It is sent again at the next load. */
  }
}
