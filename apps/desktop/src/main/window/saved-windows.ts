import { randomUUID } from "node:crypto"
import { readFile, rename, rm, writeFile } from "node:fs/promises"

import { windowIdOf, windowKeyOf } from "@novadeck/protocol/bridge"

/** Where a window was and how large, in the screen's own pixels. */
export type Bounds = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * A window the app reopens: its key, the project it showed, and where it stood. The key tells
 * windows apart, which the project can't, as two windows may show one project.
 */
export type SavedWindow = {
  readonly key: string
  readonly projectId: string
  readonly bounds: Bounds
  readonly maximized: boolean
}

/** What the app keeps of its windows between launches. */
export type SavedWindows = {
  /** Whether the person had project windows on when the app last said. */
  readonly on: boolean
  readonly windows: readonly SavedWindow[]
}

/** Nothing kept: project windows off. */
export const noSavedWindows: SavedWindows = { on: false, windows: [] }

// More than a person has screens for; a file that lists more is not trusted.
const mostWindows = 16
// The smallest and largest a window's side may be saved at, and how far from the origin.
const smallestSide = 200
const largestSide = 20_000
const farthest = 100_000

const whole = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? Math.round(value)
    : undefined

const boundsOf = (value: unknown): Bounds | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const { x, y, width, height } = value as Record<string, unknown>
  const bounds = {
    x: whole(x, -farthest, farthest),
    y: whole(y, -farthest, farthest),
    width: whole(width, smallestSide, largestSide),
    height: whole(height, smallestSide, largestSide),
  }
  return bounds.x === undefined ||
    bounds.y === undefined ||
    bounds.width === undefined ||
    bounds.height === undefined
    ? undefined
    : (bounds as Bounds)
}

/**
 * The saved windows a file holds: the ones that are well formed, at most `mostWindows`, each
 * with a key of its own (an older entry gets one here), and
 * nothing at all (`noSavedWindows`) for a file that isn't an object. Never throws.
 */
export const savedWindowsOf = (value: unknown): SavedWindows => {
  if (typeof value !== "object" || value === null) return noSavedWindows
  const { on, windows } = value as Record<string, unknown>
  const listed = Array.isArray(windows) ? (windows as unknown[]) : []
  const taken = new Set<string>()
  return {
    on: on === true,
    windows: listed.slice(0, mostWindows).flatMap((entry): SavedWindow[] => {
      if (typeof entry !== "object" || entry === null) return []
      const { key, projectId, bounds, maximized } = entry as Record<string, unknown>
      const project = windowIdOf(projectId)
      const box = boundsOf(bounds)
      if (project === undefined || !box) return []
      // An entry from before keys, or one whose key another window has, gets a new one.
      let own = windowKeyOf(key)
      if (own === undefined || taken.has(own)) own = randomUUID()
      taken.add(own)
      return [{ key: own, projectId: project, bounds: box, maximized: maximized === true }]
    }),
  }
}

/** A screen's usable area, as Electron reports a display's work area. */
export type Area = Bounds

const overlaps = (a: Bounds, b: Bounds): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/**
 * Where a saved window opens: where it stood if a good part of it is on a screen that is
 * still there, else only its size, which leaves its place to the system, so a window saved on
 * a monitor that has gone does not open out of reach.
 */
export const boundsToOpen = (
  saved: Bounds,
  areas: readonly Area[],
): {
  readonly width: number
  readonly height: number
  readonly x?: number
  readonly y?: number
} => {
  const margin = 80
  const grip = { x: saved.x, y: saved.y, width: Math.min(saved.width, margin), height: margin }
  return areas.some((area) => overlaps(area, grip))
    ? saved
    : { width: saved.width, height: saved.height }
}

type Files = {
  readFile(path: string, encoding: "utf8"): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(path: string, options: { force: true }): Promise<void>
}

/**
 * The windows the app reopens at the next launch, kept in `file`: the open windows' projects
 * and bounds, and whether the person has project windows on, which decides whether any are
 * reopened. Saves run one after another and each writes a temporary file and renames it over,
 * so a failed write leaves the last whole file.
 */
export const keepWindows = (file: string, files: Files = { readFile, writeFile, rename, rm }) => {
  let current: SavedWindows = noSavedWindows
  let saving: Promise<void> = Promise.resolve()
  const write = async (value: SavedWindows): Promise<void> => {
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await files.writeFile(temporary, JSON.stringify(value))
      await files.rename(temporary, file)
    } catch (error) {
      await files.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }
  const save = (next: SavedWindows): Promise<void> => {
    if (JSON.stringify(next) === JSON.stringify(current)) return saving
    current = next
    saving = saving.then(async () => {
      try {
        await write(next)
      } catch {
        // The next launch opens the windows kept before, or the app's ordinary one.
      }
    })
    return saving
  }
  return {
    /**
     * Reads what the last launch kept; nothing when it kept nothing usable. Keys given to
     * older entries are written back at once, so a window keeps its key across launches.
     */
    load: async (): Promise<SavedWindows> => {
      try {
        const text = await files.readFile(file, "utf8")
        const loaded = savedWindowsOf(JSON.parse(text))
        current = loaded
        if (loaded.windows.some(({ key }) => !text.includes(key))) {
          current = noSavedWindows
          void save(loaded)
        }
      } catch {
        current = noSavedWindows
      }
      return current
    },
    current: (): SavedWindows => current,
    /** Keeps whether project windows are on; with them off no window is kept. */
    use: (on: boolean): Promise<void> => save({ on, windows: on ? current.windows : [] }),
    /** Keeps the open windows, while project windows are on. Resolves once written. */
    remember: (windows: readonly SavedWindow[]): Promise<void> =>
      current.on ? save({ on: true, windows }) : saving,
  }
}
