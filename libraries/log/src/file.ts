import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs"
import { join } from "node:path"

export type LogFileOptions = {
  /** The folder the files are in, made when missing. */
  readonly folder: string
  /** The files' name: `runner` writes `runner.log`, then `runner.1.log` and on as they rotate. */
  readonly name: string
  /** How large a file grows before the next one starts, in bytes. */
  readonly maxBytes?: number
  /** How many files are kept, the one written included: a whole number, 1 or more. */
  readonly keep?: number
  /** The line each new file starts with after a rotation, so it reads on its own. */
  readonly header?: () => string
  /**
   * The line that says `count` lines before it could not be written, written before the next
   * line that can be.
   */
  readonly dropped?: (count: number) => string
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
   * can't be written is dropped, and counted (see `dropped`): logging never fails what it logs.
   */
  write(line: string): void
  close(): void
}

/** The path of the `index`th file of `name` in `folder`: the one written at 0. */
export const logPath = (folder: string, name: string, index = 0): string =>
  join(folder, index === 0 ? `${name}.log` : `${name}.${index}.log`)

/** Where the file written is moved first when it rotates, before the others move along. */
const rotatingPath = (folder: string, name: string): string => join(folder, `${name}.rotating.log`)

/** How many files to keep: a whole number, 1 or more; 3 for anything else. */
const keepOf = (keep: number | undefined): number =>
  keep !== undefined && Number.isInteger(keep) && keep >= 1 ? keep : 3

/**
 * Makes the folder readable by its owner only, and the log files too, those made before
 * this as well: the modes given when creating leave an existing one as it was. Windows
 * has no such modes, and a failure leaves the log as it is.
 */
const tighten = (folder: string, paths: readonly string[]): void => {
  if (process.platform === "win32") return
  const targets: (readonly [string, number])[] = [
    [folder, 0o700],
    ...paths.map((path): readonly [string, number] => [path, 0o600]),
  ]
  for (const [target, mode] of targets) {
    try {
      chmodSync(target, mode)
    } catch {
      // Not ours to change: logging goes on.
    }
  }
}

/** Whether the file open at `handle`, `size` bytes long, ends with a whole line. */
const endsWithLine = (handle: number, size: number): boolean => {
  if (size === 0) return true
  const last = Buffer.alloc(1)
  readSync(handle, last, 0, 1, size - 1)
  return last[0] === 0x0a
}

/** Writes all of `bytes`, however many calls that takes. */
const writeAll = (handle: number, bytes: Buffer): void => {
  let written = 0
  while (written < bytes.length) written += writeSync(handle, bytes, written)
}

/**
 * Opens a log file: `name.log` in `folder`, appended to. Once a line would take it past
 * `maxBytes` it becomes `name.1.log`, the one before that `name.2.log`, and so on, and the
 * oldest past `keep` is removed, so the files never take more than about `keep` × `maxBytes`.
 * With `keep` 1, the file starts again empty instead.
 *
 * Where the file written can't be moved, as when another program holds it open on Windows,
 * nothing else moves either: it is written on, up to twice `maxBytes`, and rotation tried again
 * after `retryMs`. Past that, lines are dropped until it can rotate.
 */
export const openLogFile = (options: LogFileOptions): LogFile => {
  const { folder, name, maxBytes = 4 * 1024 * 1024, retryMs = 5_000 } = options
  const keep = keepOf(options.keep)
  const now = options.now ?? Date.now
  const path = logPath(folder, name)
  let fd: number | undefined
  let size = 0
  // When the file last failed to open: it is tried again only after `retryMs`.
  let openFailedAt: number | undefined
  // When a rotation last failed: the file is written on, and rotation tried again only after
  // `retryMs`.
  let rotateFailedAt: number | undefined
  // Lines dropped since the last one written.
  let dropped = 0

  const open = (): number | undefined => {
    if (fd !== undefined) return fd
    if (openFailedAt !== undefined && now() - openFailedAt < retryMs) return undefined
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 })
      fd = openSync(path, "a+", 0o600)
      size = fstatSync(fd).size
      tighten(
        folder,
        Array.from({ length: keep }, (_, index) => logPath(folder, name, index)),
      )
      // A line cut short, as by a full disk, ends here, so the next starts on its own.
      if (!endsWithLine(fd, size)) append(fd, "\n")
      openFailedAt = undefined
      return fd
    } catch {
      close()
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

  /**
   * Moves the file written aside first, and only once that worked each older one along, the
   * oldest out: so a file that can't be moved leaves every one as it was. False where the file
   * written couldn't move.
   */
  const rotate = (): boolean => {
    close()
    const aside = rotatingPath(folder, name)
    try {
      renameSync(path, aside)
    } catch (error) {
      // Nothing to move is a rotation done.
      return (error as NodeJS.ErrnoException).code === "ENOENT"
    }
    if (keep === 1) {
      rmSync(aside, { force: true })
      return true
    }
    try {
      rmSync(logPath(folder, name, keep - 1), { force: true })
    } catch {
      // Held: renamed over below, or left.
    }
    for (let index = keep - 2; index >= 1; index -= 1) {
      try {
        renameSync(logPath(folder, name, index), logPath(folder, name, index + 1))
      } catch {
        // Missing, or held: the next move goes over it, or fails and is put back.
      }
    }
    try {
      renameSync(aside, logPath(folder, name, 1))
      return true
    } catch {
      // Put back, to be written on and moved again later.
      renameSync(aside, path)
      return false
    }
  }

  const append = (handle: number, text: string): void => {
    const bytes = Buffer.from(text)
    writeAll(handle, bytes)
    size += bytes.length
  }

  const drop = (): void => {
    dropped += 1
  }

  return {
    path,
    write(line) {
      try {
        const text = `${line}\n`
        let handle = open()
        if (handle === undefined) return drop()
        const bytes = Buffer.byteLength(text)
        const full = size > 0 && size + bytes > maxBytes
        if (full && (rotateFailedAt === undefined || now() - rotateFailedAt >= retryMs)) {
          const moved = rotate()
          rotateFailedAt = moved ? undefined : now()
          handle = open()
          if (handle === undefined) return drop()
          if (moved && options.header) append(handle, `${options.header()}\n`)
        }
        // While it can't rotate, the file grows to twice its size, and no further.
        if (size > 0 && size + bytes > 2 * maxBytes) return drop()
        if (dropped > 0 && options.dropped) append(handle, `${options.dropped(dropped)}\n`)
        dropped = 0
        append(handle, text)
      } catch {
        drop()
        close()
        openFailedAt = now()
      }
    },
    close,
  }
}
