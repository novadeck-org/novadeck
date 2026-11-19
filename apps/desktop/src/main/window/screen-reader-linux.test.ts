import { describe, expect, it } from "../../test"
import { atspiReaders, followAgainMs, statusSaysReader } from "./screen-reader-linux"

// What `gdbus call` prints for the bus's status.
const status = (isEnabled: boolean, screenReader: boolean): string =>
  `({'IsEnabled': <${isEnabled}>, 'ScreenReaderEnabled': <${screenReader}>},)\n`

// Lets the reads' promises settle.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// A bus whose status a test sets, a gdbus monitor it can print to or end, and a clock it runs.
const desktop = ({ answer = status(false, false) }: { answer?: string | Error } = {}) => {
  let now: string | Error = answer
  let print: ((line: string) => void) | undefined
  let end: (() => void) | undefined
  let follows = 0
  let killed = 0
  let waiting: { again: () => void; ms: number } | undefined
  const readers = atspiReaders({
    run: (file, args) => {
      expect(file).toBe("gdbus")
      expect(args).toContain("org.a11y.Status")
      return now instanceof Error ? Promise.reject(now) : Promise.resolve(now)
    },
    follow: (file, args, on) => {
      expect([file, args[0]]).toEqual(["gdbus", "monitor"])
      follows += 1
      print = on.line
      end = on.exit
      return () => {
        killed += 1
      }
    },
    later: (again, ms) => {
      waiting = { again, ms }
      return () => {
        waiting = undefined
      }
    },
  })
  return {
    readers,
    set: (next: string | Error) => {
      now = next
    },
    print: (line: string) => print?.(line),
    end: () => end?.(),
    follows: () => follows,
    killed: () => killed,
    waiting: () => waiting,
  }
}

describe("statusSaysReader", () => {
  it("says a reader may run when Orca or GNOME's screen reader switch set the bus", () => {
    expect(statusSaysReader(status(false, false))).toBe(false)
    expect(statusSaysReader(status(true, false))).toBe(true)
    expect(statusSaysReader(status(false, true))).toBe(true)
  })

  it("says none for output it can't read", () => {
    expect(statusSaysReader("")).toBe(false)
  })
})

describe("the accessibility bus's word on Linux", () => {
  it("says a reader may run until the bus answers, then what it answers", async () => {
    const bus = desktop()
    const changes: boolean[] = []
    expect(bus.readers.running()).toBe(true)

    bus.readers.watch(() => changes.push(bus.readers.running()))
    await flush()

    expect(changes).toEqual([false])
  })

  it("reads the bus again on each change it announces, and tells only a change", async () => {
    const bus = desktop()
    const changes: boolean[] = []
    bus.readers.watch(() => changes.push(bus.readers.running()))
    await flush()

    bus.set(status(true, false))
    bus.print(
      "/org/a11y/bus: org.freedesktop.DBus.Properties.PropertiesChanged ('org.a11y.Status', {'IsEnabled': <true>}, @as [])",
    )
    await flush()
    bus.print("The name org.a11y.Bus is owned by :1.0")
    await flush()
    bus.set(status(false, false))
    bus.print(
      "/org/a11y/bus: org.freedesktop.DBus.Properties.PropertiesChanged ('org.a11y.Status', {'IsEnabled': <false>}, @as [])",
    )
    await flush()

    expect(changes).toEqual([false, true, false])
  })

  it("says a reader may run where gdbus or the bus can't answer", async () => {
    const bus = desktop({ answer: new Error("gdbus: command not found") })
    const changes: boolean[] = []
    bus.readers.watch(() => changes.push(bus.readers.running()))
    await flush()

    expect(bus.readers.running()).toBe(true)
    expect(changes).toEqual([])
  })

  it("follows the bus again a while after its watcher ends", async () => {
    const bus = desktop()
    bus.readers.watch(() => {})
    await flush()

    bus.end()

    expect(bus.waiting()?.ms).toBe(followAgainMs)
    bus.waiting()?.again()
    expect(bus.follows()).toBe(2)
  })

  it("ends its watcher at the stop, and follows nothing more", async () => {
    const bus = desktop()
    const changes: boolean[] = []
    const stop = bus.readers.watch(() => changes.push(bus.readers.running()))
    await flush()

    stop()
    bus.set(status(true, true))
    bus.print(
      "/org/a11y/bus: org.freedesktop.DBus.Properties.PropertiesChanged ('org.a11y.Status', {'IsEnabled': <true>}, @as [])",
    )
    bus.end()
    await flush()

    expect(bus.killed()).toBe(1)
    expect(bus.waiting()).toBeUndefined()
    expect(changes).toEqual([false])
  })
})
