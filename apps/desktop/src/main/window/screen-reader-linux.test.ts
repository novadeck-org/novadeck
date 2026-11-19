import { describe, expect, it } from "../../test"
import { atspiPollMs, atspiReaders, statusSaysReader } from "./screen-reader-linux"

// What `gdbus call` prints for the bus's status.
const status = (isEnabled: boolean, screenReader: boolean): string =>
  `({'IsEnabled': <${isEnabled}>, 'ScreenReaderEnabled': <${screenReader}>},)\n`

// Lets the reads' promises settle.
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// A bus whose status a test sets, and a clock it ticks.
const desktop = (answer: string | Error = status(false, false)) => {
  let now: string | Error = answer
  let tick: (() => void) | undefined
  let tickMs = 0
  let stopped = 0
  let reads = 0
  const readers = atspiReaders({
    run: (file, args) => {
      expect(file).toBe("gdbus")
      expect(args).toContain("org.a11y.Status")
      reads += 1
      return now instanceof Error ? Promise.reject(now) : Promise.resolve(now)
    },
    repeat: (check, ms) => {
      tick = check
      tickMs = ms
      return () => {
        stopped += 1
      }
    },
  })
  return {
    readers,
    set: (next: string | Error) => {
      now = next
    },
    tick: () => tick?.(),
    tickMs: () => tickMs,
    stopped: () => stopped,
    reads: () => reads,
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
    await settled()

    expect(changes).toEqual([false])
  })

  it("reads the bus every few seconds, and tells only a change", async () => {
    const bus = desktop()
    const changes: boolean[] = []
    bus.readers.watch(() => changes.push(bus.readers.running()))
    await settled()
    expect(bus.tickMs()).toBe(atspiPollMs)

    bus.set(status(true, false))
    bus.tick()
    await settled()
    bus.tick()
    await settled()
    bus.set(status(false, false))
    bus.tick()
    await settled()

    expect(changes).toEqual([false, true, false])
    expect(bus.reads()).toBe(4)
  })

  it("says a reader may run whenever gdbus or the bus can't answer", async () => {
    const bus = desktop(new Error("gdbus: command not found"))
    const changes: boolean[] = []
    bus.readers.watch(() => changes.push(bus.readers.running()))
    await settled()
    expect(bus.readers.running()).toBe(true)

    bus.set(status(false, false))
    bus.tick()
    await settled()
    bus.set(new Error("The name org.a11y.Bus was not provided by any .service files"))
    bus.tick()
    await settled()

    expect(changes).toEqual([false, true])
  })

  it("lets the latest read win, however the answers come back", async () => {
    const answers: ((out: string) => void)[] = []
    const changes: boolean[] = []
    let tick: (() => void) | undefined
    const readers = atspiReaders({
      run: () => new Promise((resolve) => answers.push(resolve)),
      repeat: (check) => {
        tick = check
        return () => {}
      },
    })
    readers.watch(() => changes.push(readers.running()))
    tick?.()

    answers[1]?.(status(false, false))
    await settled()
    answers[0]?.(status(true, false))
    await settled()

    expect(changes).toEqual([false])
  })

  it("reads nothing more after the stop", async () => {
    const bus = desktop()
    const changes: boolean[] = []
    const stop = bus.readers.watch(() => changes.push(bus.readers.running()))
    await settled()

    stop()
    bus.set(status(true, true))
    bus.tick()
    await settled()

    expect(bus.stopped()).toBe(1)
    expect(changes).toEqual([false])
  })
})
