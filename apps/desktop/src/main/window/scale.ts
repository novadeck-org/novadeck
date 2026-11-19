import { randomUUID } from "node:crypto"
import { readFile, rename, rm, writeFile } from "node:fs/promises"

import type { IpcMainEvent } from "electron"

import { scaleChannel } from "../../bridge.js"

/** The smallest and largest scale of the app, as fractions of its normal size. */
export const smallestScale = 0.8
export const largestScale = 2
export const normalScale = 1

/**
 * The scale the app's windows show for one a page or a file gave: within the range the
 * Preferences offer, and normal for anything that is not a number, which is not trusted.
 */
export const scaleOf = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(largestScale, Math.max(smallestScale, value))
    : normalScale

type Files = {
  readFile(path: string, encoding: "utf8"): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(path: string, options: { force: true }): Promise<void>
}

/** A window's page, as the scale needs it. */
export type ScaledPage = {
  setZoomFactor(factor: number): void
  isDestroyed(): boolean
}

/**
 * The app's scale, as the page's Preferences set it, kept in `file` so a window opened by
 * the next launch starts at it, not at normal until its page says. One value for every
 * window: a change reaches each page `pages` lists, and a window opened later takes it with
 * `apply`; `after` hears of each page zoomed, to put right what the zoom took from the views it
 * hosts. Saves run one after another and each writes a temporary file and renames it
 * over, so a failed write leaves the last kept scale whole.
 */
export const keepScale = <Page extends ScaledPage = ScaledPage>(
  file: string,
  pages: () => readonly Page[],
  after: (page: Page) => void = () => {},
  files: Files = { readFile, writeFile, rename, rm },
) => {
  let current = normalScale
  let written = normalScale
  let saving: Promise<void> = Promise.resolve()
  const apply = (page: Page): void => {
    if (page.isDestroyed()) return
    page.setZoomFactor(current)
    after(page)
  }
  const write = async (value: number): Promise<void> => {
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await files.writeFile(temporary, JSON.stringify({ scale: value }))
      await files.rename(temporary, file)
    } catch (error) {
      await files.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }
  return {
    /** Reads what the last launch kept; normal when it kept nothing usable. */
    load: async (): Promise<number> => {
      try {
        const kept = JSON.parse(await files.readFile(file, "utf8")) as { scale?: unknown }
        current = scaleOf(kept.scale)
      } catch {
        current = normalScale
      }
      written = current
      return current
    },
    current: (): number => current,
    /** Shows the scale in a page, as a window opens or its page loads again. */
    apply,
    /** Takes a new scale, shows it in every window and keeps it. */
    set: (value: unknown): Promise<void> => {
      const next = scaleOf(value)
      current = next
      pages().forEach(apply)
      saving = saving.then(async () => {
        if (written === next) return
        try {
          await write(next)
          written = next
        } catch {
          // The windows still show it; the next launch starts at the scale kept before.
        }
      })
      return saving
    },
  }
}

type ScaleIpc = {
  on(channel: string, listener: (event: IpcMainEvent, value: unknown) => void): unknown
}

/**
 * Follows the page's scale reports. `fromApp` tells a report of the app's own page from any
 * other's, which is dropped.
 */
export const registerScaleIpc = (
  ipc: ScaleIpc,
  fromApp: (event: IpcMainEvent) => boolean,
  set: (value: unknown) => void,
): void => {
  ipc.on(scaleChannel, (event, value) => {
    if (fromApp(event)) set(value)
  })
}
