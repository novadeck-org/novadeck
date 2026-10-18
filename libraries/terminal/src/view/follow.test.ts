import { describe as context, describe, expect, it, vi } from "vitest"

import type { AttachStream } from "../contract.js"
import { exited, optionsOf, output, shell, snapshot, streamOf } from "./fakes.test-support.js"
import { followTerminal, type FollowOptions } from "./follow.js"

const key = "t"

// The screen a followed terminal draws on, recording what is drawn.
const drawing = (drawn: string[]) => ({
  write: async (data: string) => void drawn.push(data),
  reset: () => void drawn.push("reset"),
  resize: () => {},
  fit: () => undefined,
  exited: () => {},
  live: () => {},
})

// A mock attach, given its streams by each test.
const attaching = () => vi.fn<FollowOptions<string>["attach"]>()

describe("following a terminal", () => {
  it("reports an exit only after drawing the output that came before it", async () => {
    const drawn: string[] = []
    const exit = { code: null, signal: "SIGKILL", ranMs: 500 }
    const { attached } = streamOf([output("kill -9", 1), output(" $$\r\n", 2), exited(exit, 3)], {
      ends: true,
    })
    const followed = followTerminal(
      optionsOf({
        attach: async () => attached,
        waitsAfter: () => true,
        on: { exited: (_key, reported) => void drawn.push(`owner:${reported.signal}`) },
      }),
      key,
      {
        write: async (data) => void drawn.push(data),
        reset: () => {},
        resize: () => {},
        fit: () => undefined,
        exited: (waits) => drawn.push(`hint:${waits}`),
        live: () => {},
      },
    )
    await vi.waitFor(() => expect(drawn).toHaveLength(4))
    followed.stop()
    expect(drawn).toEqual(["kill -9", " $$\r\n", "owner:SIGKILL", "hint:true"])
  })

  context("parked out of sight", () => {
    it("lets go of the stream, and draws the runner's screen as it is once shown again", async () => {
      const first = streamOf([snapshot("$ before")])
      const second = streamOf([snapshot("$ after")])
      const attach = attaching()
        .mockResolvedValueOnce(first.attached)
        .mockResolvedValue(second.attached)
      const drawn: string[] = []
      const followed = followTerminal(optionsOf({ attach }), key, drawing(drawn))
      await vi.waitFor(() => expect(drawn).toEqual(["reset", "$ before"]))
      followed.park()
      expect(first.close).toHaveBeenCalled()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(attach).toHaveBeenCalledTimes(1)
      followed.unpark()
      await vi.waitFor(() => expect(drawn).toEqual(["reset", "$ before", "reset", "$ after"]))
      followed.stop()
    })

    it("attaches again when shown before the parked stream wound down", async () => {
      const first = streamOf([snapshot("$ before")])
      const second = streamOf([snapshot("$ after")])
      const attach = attaching()
        .mockResolvedValueOnce(first.attached)
        .mockResolvedValue(second.attached)
      const drawn: string[] = []
      const followed = followTerminal(optionsOf({ attach }), key, drawing(drawn))
      await vi.waitFor(() => expect(drawn).toEqual(["reset", "$ before"]))
      followed.park()
      followed.unpark()
      await vi.waitFor(() => expect(drawn).toEqual(["reset", "$ before", "reset", "$ after"]))
      followed.stop()
    })

    it("attaches once when shown again before its shell had started", async () => {
      let start: (ready: boolean) => void = () => {}
      const entry = shell({
        ready: new Promise<boolean>((resolve) => {
          start = resolve
        }),
      })
      const exit = { code: 1, signal: null, ranMs: 5_000 }
      const attach = attaching().mockResolvedValue(
        streamOf([snapshot("$ exit 1", exit)], { ends: true }).attached,
      )
      const drawn: string[] = []
      const followed = followTerminal(
        optionsOf({ attach, lifecycle: () => entry }),
        key,
        drawing(drawn),
      )
      followed.park()
      followed.unpark()
      start(true)
      await vi.waitFor(() => expect(drawn).toEqual(["reset", "$ exit 1"]))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(attach).toHaveBeenCalledTimes(1)
      followed.stop()
    })

    it("attaches again when parked while attaching, once shown", async () => {
      let land: (attached: AttachStream) => void = () => {}
      const first = streamOf([snapshot("$ before")])
      const second = streamOf([snapshot("$ after")])
      const attach = attaching()
        .mockReturnValueOnce(
          new Promise((resolve) => {
            land = resolve
          }),
        )
        .mockResolvedValue(second.attached)
      const drawn: string[] = []
      const followed = followTerminal(optionsOf({ attach }), key, drawing(drawn))
      await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(1))
      followed.park()
      land(first.attached)
      await vi.waitFor(() => expect(first.close).toHaveBeenCalled())
      followed.unpark()
      await vi.waitFor(() => expect(drawn).toEqual(["reset", "$ after"]))
      followed.stop()
    })

    it("attaches once to a shell restarted while parked, after it exits", async () => {
      let revive: () => void = () => {}
      const entry = shell({
        revived: new Promise<void>((resolve) => {
          revive = resolve
        }),
      })
      const exit = { code: 1, signal: null, ranMs: 5_000 }
      const first = streamOf([snapshot("$ before")])
      const attach = attaching()
        .mockResolvedValueOnce(first.attached)
        .mockResolvedValue(streamOf([snapshot("$ fresh exited", exit)], { ends: true }).attached)
      const drawn: string[] = []
      const followed = followTerminal(
        optionsOf({ attach, lifecycle: () => entry }),
        key,
        drawing(drawn),
      )
      await vi.waitFor(() => expect(drawn).toEqual(["reset", "$ before"]))
      followed.park()
      await new Promise((resolve) => setTimeout(resolve, 10))
      // A fresh shell while parked: its revival resolves and the next one takes its place.
      const revived = revive
      Object.assign(entry, {
        revived: new Promise<void>((resolve) => {
          revive = resolve
        }),
      })
      revived()
      await new Promise((resolve) => setTimeout(resolve, 10))
      followed.unpark()
      await vi.waitFor(() =>
        expect(drawn).toEqual(["reset", "$ before", "reset", "$ fresh exited"]),
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(attach).toHaveBeenCalledTimes(2)
      followed.stop()
    })

    it("holds a fresh shell started out of sight until shown", async () => {
      let revive: () => void = () => {}
      const entry = shell({
        revived: new Promise<void>((resolve) => {
          revive = resolve
        }),
      })
      const exit = { code: 1, signal: null, ranMs: 5_000 }
      const fresh = streamOf([snapshot("$ fresh")])
      const attach = attaching()
        .mockResolvedValueOnce(streamOf([snapshot("$ exit 1", exit)], { ends: true }).attached)
        .mockResolvedValue(fresh.attached)
      const drawn: string[] = []
      const followed = followTerminal(
        optionsOf({ attach, lifecycle: () => entry }),
        key,
        drawing(drawn),
      )
      await vi.waitFor(() => expect(drawn).toEqual(["reset", "$ exit 1"]))
      followed.park()
      Object.assign(entry, { revived: new Promise<void>(() => {}) })
      revive()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(attach).toHaveBeenCalledTimes(1)
      followed.unpark()
      await vi.waitFor(() => expect(drawn).toEqual(["reset", "$ exit 1", "reset", "$ fresh"]))
      followed.stop()
    })
  })
})

describe("following over the terminal library's stream", () => {
  // A stream of its own: events, then open until closed, recording what is sent through it.
  const stream = (events: readonly string[]) => {
    const queue = events.map((data) => snapshot(data))
    const sent: string[] = []
    let end: (() => void) | undefined
    const closed = new Promise<void>((resolve) => (end = resolve))
    const attached: AttachStream = {
      mode: "control",
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (queue.length) return { value: queue.shift()!, done: false }
          await closed
          return { value: undefined, done: true }
        },
      }),
      write: async (data) => void sent.push(`write ${data}`),
      resize: async (cols, rows) => void sent.push(`resize ${cols}x${rows}`),
      close: () => {
        sent.push("close")
        end?.()
      },
    }
    return { attached, sent }
  }

  it("asks its owner for the stream by key, and tells it how the stream goes", async () => {
    const { attached, sent } = stream(["$ "])
    const told: string[] = []
    const options: FollowOptions<string> = {
      attach: async (name) => {
        told.push(`attach ${name}`)
        return attached
      },
      lifecycle: () => shell(),
      connection: { getSnapshot: () => "connected", subscribe: () => () => {} },
      reconnected: async () => {},
      classify: () => "fatal",
      waitsAfter: () => false,
      on: {
        attached: (name) => {
          told.push(`attached ${name}`)
          return () => void told.push(`released ${name}`)
        },
        stage: (name, stage) => void told.push(`${name} ${stage}`),
        resized: (name, size) => void told.push(`${name} ${size.cols}x${size.rows}`),
      },
    }
    const drawn: string[] = []
    const followed = followTerminal(options, "mine", {
      ...drawing(drawn),
      fit: () => ({ cols: 100, rows: 30 }),
    })
    await vi.waitFor(() => expect(sent).toEqual(["resize 100x30"]))
    followed.input("ls\r")
    expect(sent).toEqual(["resize 100x30", "write ls\r"])
    expect(drawn).toEqual(["reset", "$ "])
    followed.stop()
    expect(sent.at(-1)).toBe("close")
    await vi.waitFor(() => expect(told).toContain("released mine"))
    expect(told).toEqual([
      "attach mine",
      "attached mine",
      "mine shown",
      "mine 100x30",
      "released mine",
    ])
  })

  it("lets the owner's classification decide whether a failed attach waits, retries or is lost", async () => {
    const lost: unknown[] = []
    const failure = new Error("no such terminal")
    const followed = followTerminal<string>(
      {
        attach: async () => {
          throw failure
        },
        lifecycle: () => shell(),
        connection: { getSnapshot: () => "connected", subscribe: () => () => {} },
        reconnected: async () => {},
        classify: () => "fatal",
        waitsAfter: () => false,
        on: { lost: (_name, error) => void lost.push(error) },
      },
      "mine",
      drawing([]),
    )
    await vi.waitFor(() => expect(lost).toEqual([failure]))
    followed.stop()
  })
})
