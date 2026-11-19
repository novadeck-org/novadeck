import { execFile } from "node:child_process"

import { every, type Every, type ReaderSource } from "./screen-reader.js"

// Linux has no word from Electron on assistive technology, but the desktop's accessibility bus
// (AT-SPI) keeps it: `org.a11y.Status` on `org.a11y.Bus`, at `/org/a11y/bus` on the session
// bus. Its `ScreenReaderEnabled` is GNOME's screen reader switch, and `IsEnabled` is set by
// Orca as it starts, however it was started (as it has since 3.10), and by other assistive
// technology; GNOME's switch turns it on too. Neither Orca nor the switch sets it back, and the
// bus keeps it in the `toolkit-accessibility` setting, so once a reader ran it stays true in
// later sessions until that setting is turned off: that keeps a reader's text, which only costs
// what it always did.

/** Runs a program and resolves with what it printed; rejects when it fails or runs too long. */
export type Run = (file: string, args: readonly string[], timeout: number) => Promise<string>

// The bus's status, as `gdbus call` prints it: ({'IsEnabled': <false>, 'ScreenReaderEnabled': <false>},)
const readStatus = [
  "call",
  "--session",
  "--dest",
  "org.a11y.Bus",
  "--object-path",
  "/org/a11y/bus",
  "--timeout",
  "1",
  "--method",
  "org.freedesktop.DBus.Properties.GetAll",
  "org.a11y.Status",
]

/** Whether the bus's status, as `gdbus call` prints it, says a screen reader may run. */
export const statusSaysReader = (out: string): boolean =>
  /'(?:IsEnabled|ScreenReaderEnabled)': <true>/.test(out)

// How often the app reads the bus. A read is one short `gdbus call`, and nothing runs between
// reads, so nothing can outlive the app or miss a change: the next read finds it.
export const atspiPollMs = 3_000

/**
 * The accessibility bus's word on Linux, read with `gdbus` every `atspiPollMs`. Until it
 * answers, and whenever it can't (no gdbus, no bus), it says a reader may run.
 */
export const atspiReaders = ({
  run,
  repeat = every,
}: {
  readonly run: Run
  readonly repeat?: Every
}): ReaderSource => {
  let running = true
  return {
    running: () => running,
    watch: (changed) => {
      let stopped = false
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
      read()
      const stopRepeating = repeat(read, atspiPollMs)
      return () => {
        stopped = true
        stopRepeating()
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
