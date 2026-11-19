import { execFile, spawn } from "node:child_process"
import { createInterface } from "node:readline"

import type { ReaderSource } from "./screen-reader.js"

// Linux has no word from Electron on assistive technology, but the desktop's accessibility bus
// (AT-SPI) keeps it: `org.a11y.Status` on `org.a11y.Bus`, at `/org/a11y/bus` on the session
// bus. Its `ScreenReaderEnabled` is GNOME's screen reader switch, and `IsEnabled` is set by
// Orca as it starts, however it was started, and by other assistive technology. Orca never
// sets it back, so it may stay true after Orca quits: that keeps a reader's text, which only
// costs what it always did.

/** Runs a program and resolves with what it printed; rejects when it fails or runs too long. */
export type Run = (file: string, args: readonly string[], timeout: number) => Promise<string>

/**
 * Starts a program that keeps running and calls `line` with each line it prints, and `exit`
 * once it has ended or failed to start; returns its stop.
 */
export type Follow = (
  file: string,
  args: readonly string[],
  on: { readonly line: (line: string) => void; readonly exit: () => void },
) => () => void

const bus = ["--session", "--dest", "org.a11y.Bus", "--object-path", "/org/a11y/bus"]

// The bus's status, as `gdbus call` prints it: ({'IsEnabled': <false>, 'ScreenReaderEnabled': <false>},)
const readStatus = [
  "call",
  ...bus,
  "--timeout",
  "1",
  "--method",
  "org.freedesktop.DBus.Properties.GetAll",
  "org.a11y.Status",
]

// Each change of the status, as `gdbus monitor` prints it: a PropertiesChanged line naming
// org.a11y.Status.
const watchStatus = ["monitor", ...bus]

/** Whether the bus's status, as `gdbus call` prints it, says a screen reader may run. */
export const statusSaysReader = (out: string): boolean =>
  /'(?:IsEnabled|ScreenReaderEnabled)': <true>/.test(out)

// How long the app waits to follow the bus again once its watcher ended, as when gdbus is
// missing or the bus went away.
export const followAgainMs = 30_000

/**
 * The accessibility bus's word on Linux, read with `gdbus` and followed with `gdbus monitor`.
 * Until it answers, and wherever it can't (no gdbus, no bus), it says a reader may run.
 */
export const atspiReaders = ({
  run,
  follow,
  later = (again, ms) => {
    const timer = setTimeout(again, ms)
    timer.unref?.()
    return () => clearTimeout(timer)
  },
}: {
  readonly run: Run
  readonly follow: Follow
  readonly later?: (again: () => void, ms: number) => () => void
}): ReaderSource => {
  let running = true
  return {
    running: () => running,
    watch: (changed) => {
      let stopped = false
      let stopFollowing: (() => void) | undefined
      let stopWaiting: (() => void) | undefined
      // The latest read wins, however their answers come back.
      let reads = 0
      const read = (): void => {
        const turn = (reads += 1)
        void run("gdbus", readStatus, 1500)
          .then(statusSaysReader, () => true)
          .then((now) => {
            if (stopped || turn !== reads || now === running) return
            running = now
            changed()
          })
      }
      const start = (): void => {
        read()
        stopFollowing = follow("gdbus", watchStatus, {
          line: (line) => {
            if (line.includes("org.a11y.Status")) read()
          },
          exit: () => {
            if (!stopped) stopWaiting = later(start, followAgainMs)
          },
        })
      }
      start()
      return () => {
        stopped = true
        stopFollowing?.()
        stopWaiting?.()
      }
    },
  }
}

/** Runs programs in `env`, as the system's own programs expect to be started. */
export const runIn =
  (env: NodeJS.ProcessEnv): Run =>
  (file, args, timeout) =>
    new Promise((resolve, reject) => {
      execFile(file, [...args], { env, timeout }, (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      )
    })

/** Follows programs in `env`, killing each at its stop. */
export const followIn =
  (env: NodeJS.ProcessEnv): Follow =>
  (file, args, { line, exit }) => {
    const child = spawn(file, [...args], { env, stdio: ["ignore", "pipe", "ignore"] })
    let ended = false
    const end = (): void => {
      if (ended) return
      ended = true
      exit()
    }
    child.on("error", end)
    child.on("exit", end)
    createInterface({ input: child.stdout }).on("line", line)
    return () => {
      ended = true
      child.kill()
    }
  }
