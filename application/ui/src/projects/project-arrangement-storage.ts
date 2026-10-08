import { noArrangement, type ProjectArrangement } from "./project-arrangement"

const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each) => typeof each === "string") : []

// How the person arranged the switcher's projects: their order and the pinned ones.
export const projectArrangementStorageKey = "novadeck.project-arrangement"
export const readProjectArrangement = (): ProjectArrangement => {
  try {
    const stored = JSON.parse(localStorage.getItem(projectArrangementStorageKey) ?? "null") as {
      order?: unknown
      pinned?: unknown
    } | null
    return stored ? { order: ids(stored.order), pinned: ids(stored.pinned) } : noArrangement
  } catch {
    return noArrangement
  }
}

export const writeProjectArrangement = (arrangement: ProjectArrangement): void => {
  try {
    localStorage.setItem(projectArrangementStorageKey, JSON.stringify(arrangement))
  } catch {
    /* The arrangement holds for this session when storage is unavailable. */
  }
}
