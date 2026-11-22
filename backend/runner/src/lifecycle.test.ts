import { EventEmitter } from "node:events"

import type { Log } from "@novadeck/log"
import { afterEach, beforeEach, vi } from "vitest"

import {
  endDeadlineMs,
  endingSignals,
  endOnSignals,
  repeatSignalMs,
  superviseRunner,
} from "./lifecycle.js"
import { describe, expect, it } from "./test.js"

const silent = new Proxy({} as Log, { get: () => () => {} })

/** A runner that says what it was asked, and closes when `finish` says. */
const fakeRunner = () => {
  const said: string[] = []
  let finish: (failed?: Error) => void = () => {}
  return {
    said,
    finish: (failed?: Error) => finish(failed),
    runner: {
      persist: () => said.push("persist"),
      close: () => {
        said.push("close")
        return new Promise<void>((resolve, reject) => {
          finish = (failed) => (failed ? reject(failed) : resolve())
        })
      },
    },
  }
}

describe("a runner's lifecycle", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("saves every terminal, stops the host's parts, then closes and exits 0", async () => {
    const { said, finish, runner } = fakeRunner()
    const exits: number[] = []
    const lifecycle = superviseRunner({
      runner,
      exit: (code) => exits.push(code),
      parts: [{ stop: () => said.push("watch stopped") }],
      log: silent,
    })

    const ended = lifecycle.end("SIGTERM")
    // All of it in the turn the request came in, before anything else can run.
    expect(said).toEqual(["watch stopped", "persist", "close"])
    expect(exits).toEqual([])

    finish()
    await ended
    expect(exits).toEqual([0])
  })

  it("ends once: a later request waits on the first, and saves nothing more", async () => {
    const { said, finish, runner } = fakeRunner()
    const exits: number[] = []
    const lifecycle = superviseRunner({ runner, exit: (code) => exits.push(code), log: silent })

    const first = lifecycle.end("host")
    const second = lifecycle.end("SIGINT")
    lifecycle.persist()
    expect(second).toBe(first)
    expect(said).toEqual(["persist", "close"])

    finish()
    await first
    expect(exits).toEqual([0])
  })

  it("saves on the host's word while it runs", () => {
    const { said, runner } = fakeRunner()
    const lifecycle = superviseRunner({ runner, exit: () => {}, log: silent })
    lifecycle.persist()
    expect(said).toEqual(["persist"])
  })

  it("exits 1 when closing fails", async () => {
    const { finish, runner } = fakeRunner()
    const exits: number[] = []
    const ended = superviseRunner({
      runner,
      exit: (code) => exits.push(code),
      log: silent,
    }).end("SIGTERM")
    finish(new Error("The store would not close."))
    await ended
    expect(exits).toEqual([1])
  })

  it("exits 1 once closing outlasts the deadline, inside Docker's grace", async () => {
    const { runner } = fakeRunner()
    const exits: number[] = []
    const ended = superviseRunner({
      runner,
      exit: (code) => exits.push(code),
      log: silent,
    }).end("SIGTERM")

    await vi.advanceTimersByTimeAsync(endDeadlineMs - 1)
    expect(exits).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await ended
    expect(exits).toEqual([1])
    expect(endDeadlineMs).toBeLessThan(10_000)
  })

  it("exits 1 at once when told again, whatever the close is doing", () => {
    const { said, runner } = fakeRunner()
    const exits: number[] = []
    const lifecycle = superviseRunner({ runner, exit: (code) => exits.push(code), log: silent })
    void lifecycle.end("SIGTERM")
    lifecycle.abort("SIGTERM")
    expect(said).toEqual(["persist", "close"])
    expect(exits).toEqual([1])
  })
})

describe("ending on signals", () => {
  const listen = (platform: NodeJS.Platform) => {
    const source = new EventEmitter()
    let at = 0
    const asked: string[] = []
    const stop = endOnSignals(
      {
        end: async (reason) => {
          asked.push(`end ${reason}`)
        },
        abort: (reason) => asked.push(`abort ${reason}`),
      },
      { platform, source, now: () => at },
    )
    return {
      asked,
      stop,
      send: (signal: NodeJS.Signals, ms = at) => {
        at = ms
        source.emit(signal, signal)
      },
      listening: (signal: NodeJS.Signals) => source.listenerCount(signal),
    }
  }

  it("listens for SIGTERM, SIGINT and SIGHUP on Linux and macOS", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const { listening } = listen(platform)
      expect(endingSignals(platform)).toEqual(["SIGTERM", "SIGINT", "SIGHUP"])
      for (const signal of endingSignals(platform)) expect(listening(signal)).toBe(1)
    }
  })

  it("listens for Ctrl+C, Ctrl+Break and the console closing on Windows, which has no SIGTERM", () => {
    const { listening } = listen("win32")
    expect(endingSignals("win32")).toEqual(["SIGINT", "SIGBREAK", "SIGHUP"])
    expect(listening("SIGBREAK")).toBe(1)
    expect(listening("SIGTERM")).toBe(0)
  })

  it("ends on the first signal, takes one forwarded with it as the same, and exits on a later one", () => {
    const { asked, send } = listen("linux")
    send("SIGTERM", 0)
    // A Ctrl+C that reached the runner both from the terminal and from the script above it.
    send("SIGINT", repeatSignalMs - 1)
    expect(asked).toEqual(["end SIGTERM"])
    send("SIGINT", repeatSignalMs)
    expect(asked).toEqual(["end SIGTERM", "abort SIGINT"])
  })

  it("stops listening when told", () => {
    const { listening, stop } = listen("linux")
    stop()
    expect(listening("SIGTERM")).toBe(0)
  })
})
