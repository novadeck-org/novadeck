import { closeSync, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs"
import { join } from "node:path"

export type LogFileOptions = {
  /** The folder the files are in, made when missing. */
  readonly folder: string
  /** The files' name: `runner` writes `runner.log`, then `runner.1.log` and on as they rotate. */
  readonly name: string
  /** How large a file grows before the next one starts, in bytes. */
  readonly maxBytes?: number
  /** How many files are kept, the one written included. */
  readonly keep?: number
  /** The line each new file starts with after a rotation, so it reads on its own. */
  readonly header?: () => string
  /** How long a file that could not be opened is left before trying again, in milliseconds. */
  readonly retryMs?: number
  readonly now?: () => number
}

/** A log file that rotates by size. */
export type LogFile = {
  /** The file being written. */
  readonly path: string
  /**
   * Appends a line at once, synchronously, so a crash right after loses nothing. A line that
   * can't be written is dropped: logging never fails what it logs.
   */
  write(line: string): void
  close(): void
}

/** The path of the `index`th file of `name` in `folder`: the one written at 0. */
export const logPath = (folder: string, name: string, index = 0): string =>
  join(folder, index === 0 ? `${name}.log` : `${name}.${index}.log`)

/**
 * Opens a log file: `name.log` in `folder`, appended to. Once a line would take it past
 * `maxBytes` it becomes `name.1.log`, the one before that `name.2.log`, and so on, and the
 * oldest past `keep` is removed, so the files never take more than about `keep` × `maxBytes`.
 */
export const openLogFile = (options: LogFileOptions): LogFile => {
  const { folder, name, maxBytes = 4 * 1024 * 1024, keep = 3, retryMs = 5_000 } = options
  const now = options.now ?? Date.now
  const path = logPath(folder, name)
  let fd: number | undefined
  let size = 0
  // When the file last failed to open: it is tried again only after `retryMs`.
  let openFailedAt: number | undefined
  // When a rotation last failed, as when another program holds the file open on Windows:
  // the file is written on, and rotation tried again only after `retryMs`.
  let rotateFailedAt: number | undefined

  const open = (): number | undefined => {
    if (fd !== undefined) return fd
    if (openFailedAt !== undefined && now() - openFailedAt < retryMs) return undefined
    try {
      mkdirSync(folder, { recursive: true })
      fd = openSync(path, "a")
      size = fstatSync(fd).size
      openFailedAt = undefined
      return fd
    } catch {
      openFailedAt = now()
      return undefined
    }
  }

  const close = (): void => {
    if (fd === undefined) return
    try {
      closeSync(fd)
    } catch {
      // Closed already.
    }
    fd = undefined
  }

  // Moves each file one along, the oldest out; false where the file written couldn't move.
  const rotate = (): boolean => {
    close()
    try {
      rmSync(logPath(folder, name, keep - 1), { force: true })
    } catch {
      // Held: renamed over below, or left.
    }
    let moved = true
    for (let index = keep - 2; index >= 0; index -= 1) {
      try {
        renameSync(logPath(folder, name, index), logPath(folder, name, index + 1))
      } catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT"
        if (index === 0 && !missing) moved = false
      }
    }
    return moved
  }

  const append = (handle: number, text: string): void => {
    const bytes = Buffer.from(text)
    writeSync(handle, bytes)
    size += bytes.length
  }

  return {
    path,
    write(line) {
      try {
        const text = `${line}\n`
        let handle = open()
        if (handle === undefined) return
        const full = size > 0 && size + Buffer.byteLength(text) > maxBytes && keep > 1
        if (full && (rotateFailedAt === undefined || now() - rotateFailedAt >= retryMs)) {
          const moved = rotate()
          rotateFailedAt = moved ? undefined : now()
          handle = open()
          if (handle === undefined) return
          if (moved && options.header) append(handle, `${options.header()}\n`)
        }
        append(handle, text)
      } catch {
        close()
        openFailedAt = now()
      }
    },
    close,
  }
}
