import type { TerminalEvent, TerminalExit } from "@novadeck/protocol"
import type { AttachedTerminal } from "@novadeck/protocol/client"
import { vi } from "vitest"

import { context, describe, expect, it } from "../../test"
import type { SurfaceRuntime } from "./backend"
import { followTerminal } from "./follow"

const key = { projectId: "p", workspaceSessionId: "s", terminalId: "t" }
const envelope = { terminalId: "t" }

// An attachment that replays `events`, then ends as the runner ends it after an exit.
const replaying = (events: readonly TerminalEvent[]): AttachedTerminal => {
  const queue = [...events]
  const attached: AttachedTerminal = {
    id: "t",
    mode: "control",
    [Symbol.asyncIterator]: () => attached,
    next: async () =>
      queue.length ? { value: queue.shift()!, done: false } : { value: undefined, done: true },
    return: async () => ({ value: undefined, done: true }),
    write: async () => {},
    resize: async () => {},
    detach: async () => {},
  }
  return attached
}

// An attachment that replays `events`, then stays open until detached, as a live shell's.
const streaming = (events: readonly TerminalEvent[]) => {
  const queue = [...events]
  let detached = false
  let end: (() => void) | undefined
  const ended = new Promise<void>((resolve) => {
    end = resolve
  })
  const detach = vi.fn<() => Promise<void>>(async () => {
    detached = true
    end?.()
  })
  const attached: AttachedTerminal = {
    id: "t",
    mode: "control",
    [Symbol.asyncIterator]: () => attached,
    next: async () => {
      if (!detached && queue.length) return { value: queue.shift()!, done: false }
      await ended
      return { value: undefined, done: true }
    },
    return: async () => ({ value: undefined, done: true }),
    write: async () => {},
    resize: async () => {},
    detach,
  }
  return { attached, detach }
}

const snapshot = (data: string, exit: TerminalExit | null = null): TerminalEvent => ({
  ...envelope,
  sequence: 1,
  type: "snapshot",
  cols: 80,
  rows: 24,
  data,
  exit,
})

// A runtime whose terminal runs one shell, or the shells `entry` says; each attachment
// comes from `attach`.
const runtimeWith = (
  attach: SurfaceRuntime["attach"],
  entry: NonNullable<ReturnType<SurfaceRuntime["entry"]>> = {
    ready: Promise.resolve(true),
    revived: new Promise<void>(() => {}),
    closed: false,
    size: { cols: 80, rows: 24 },
  },
) => {
  return {
    entry: () => entry,
    attach,
    upload: async () => "",
    resized: () => {},
    attached: () => () => {},
    connected: async () => {},
    lost: () => {},
    restart: () => {},
    exited: () => {},
    connection: { getSnapshot: () => "connected", subscribe: () => () => {} },
    track: (work) => work,
    screen: () => {},
    shown: () => false,
  } satisfies SurfaceRuntime
}

const drawing = (drawn: string[]) => ({
  write: async (data: string) => void drawn.push(data),
  reset: () => void drawn.push("reset"),
  resize: () => {},
  fit: () => undefined,
  exited: () => {},
  live: () => {},
})

describe("following a runner terminal", () => {
  it("reports an exit only after drawing the output that came before it", async () => {
    const drawn: string[] = []
    const exit = { code: null, signal: "SIGKILL", ranMs: 500 }
    const entry = {
      ready: Promise.resolve(true),
      revived: new Promise<void>(() => {}),
      closed: false,
      size: { cols: 80, rows: 24 },
    }
    const runtime = {
      entry: () => entry,
      attach: async () =>
        replaying([
          { ...envelope, sequence: 1, type: "output", data: "kill -9" },
          { ...envelope, sequence: 2, type: "output", data: " $$\r\n" },
          { ...envelope, sequence: 3, type: "exited", exit },
        ]),
      upload: async () => "",
      resized: () => {},
      attached: () => () => {},
      connected: async () => {},
      lost: () => {},
      restart: () => {},
      exited: (_key, reported) => drawn.push(`runtime:${reported?.signal}`),
      connection: { getSnapshot: () => "connected", subscribe: () => () => {} },
      track: (work) => work,
      screen: () => {},
      shown: () => false,
    } satisfies SurfaceRuntime
    const followed = followTerminal(runtime, key, {
      write: async (data) => void drawn.push(data),
      reset: () => {},
      resize: () => {},
      fit: () => undefined,
      exited: (waits) => drawn.push(`hint:${waits}`),
      live: () => {},
    })
    await vi.waitFor(() => expect(drawn).toHaveLength(4))
    followed.stop()
    expect(drawn).toEqual(["kill -9", " $$\r\n", "runtime:SIGKILL", "hint:true"])
  })

  context("parked out of sight", () => {
    it("lets go of the stream, and draws the runner's screen as it is once shown again", async () => {
      const first = streaming([snapshot("$ before")])
      const second = streaming([snapshot("$ after")])
      const attach = vi
        .fn<SurfaceRuntime["attach"]>()
        .mockResolvedValueOnce(first.attached)
        .mockResolvedValue(second.attached)
      const drawn: string[] = []
      const followed = followTerminal(runtimeWith(attach), key, drawing(drawn))
      await vi.waitFor(() => expect(drawn).toEqual(["reset", "$ before"]))
      followed.park()
      expect(first.detach).toHaveBeenCalled()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(attach).toHaveBeenCalledTimes(1)
      followed.unpark()
      await vi.waitFor(() => expect(drawn).toEqual(["reset", "$ before", "reset", "$ after"]))
      followed.stop()
    })

    it("attaches again when shown before the parked stream wound down", async () => {
      const first = streaming([snapshot("$ before")])
      const second = streaming([snapshot("$ after")])
      const attach = vi
        .fn<SurfaceRuntime["attach"]>()
        .mockResolvedValueOnce(first.attached)
        .mockResolvedValue(second.attached)
      const drawn: string[] = []
      const followed = followTerminal(runtimeWith(attach), key, drawing(drawn))
      await vi.waitFor(() => expect(drawn).toEqual(["reset", "$ before"]))
      followed.park()
      followed.unpark()
      await vi.waitFor(() => expect(drawn).toEqual(["reset", "$ before", "reset", "$ after"]))
      followed.stop()
    })

    it("attaches once when shown again before its shell had started", async () => {
      let start: (ready: boolean) => void = () => {}
      const entry = {
        ready: new Promise<boolean>((resolve) => {
          start = resolve
        }),
        revived: new Promise<void>(() => {}),
        closed: false,
        size: { cols: 80, rows: 24 },
      }
      const exit = { code: 1, signal: null, ranMs: 5_000 }
      const attach = vi
        .fn<SurfaceRuntime["attach"]>()
        .mockResolvedValue(replaying([snapshot("$ exit 1", exit)]))
      const drawn: string[] = []
      const followed = followTerminal(runtimeWith(attach, entry), key, drawing(drawn))
      followed.park()
      followed.unpark()
      start(true)
      await vi.waitFor(() => expect(drawn).toEqual(["reset", "$ exit 1"]))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(attach).toHaveBeenCalledTimes(1)
      followed.stop()
    })

    it("attaches again when parked while attaching, once shown", async () => {
      let land: (attached: AttachedTerminal) => void = () => {}
      const first = streaming([snapshot("$ before")])
      const second = streaming([snapshot("$ after")])
      const attach = vi
        .fn<SurfaceRuntime["attach"]>()
        .mockReturnValueOnce(
          new Promise((resolve) => {
            land = resolve
          }),
        )
        .mockResolvedValue(second.attached)
      const drawn: string[] = []
      const followed = followTerminal(runtimeWith(attach), key, drawing(drawn))
      await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(1))
      followed.park()
      land(first.attached)
      await vi.waitFor(() => expect(first.detach).toHaveBeenCalled())
      followed.unpark()
      await vi.waitFor(() => expect(drawn).toEqual(["reset", "$ after"]))
      followed.stop()
    })

    it("attaches once to a shell restarted while parked, after it exits", async () => {
      let revive: () => void = () => {}
      const entry = {
        ready: Promise.resolve(true),
        revived: new Promise<void>((resolve) => {
          revive = resolve
        }),
        closed: false,
        size: { cols: 80, rows: 24 },
      }
      const exit = { code: 1, signal: null, ranMs: 5_000 }
      const first = streaming([snapshot("$ before")])
      const attach = vi
        .fn<SurfaceRuntime["attach"]>()
        .mockResolvedValueOnce(first.attached)
        .mockResolvedValue(replaying([snapshot("$ fresh exited", exit)]))
      const drawn: string[] = []
      const followed = followTerminal(runtimeWith(attach, entry), key, drawing(drawn))
      await vi.waitFor(() => expect(drawn).toEqual(["reset", "$ before"]))
      followed.park()
      await new Promise((resolve) => setTimeout(resolve, 10))
      // A fresh shell while parked: its revival resolves and the next one takes its place.
      const revived = revive
      entry.revived = new Promise<void>((resolve) => {
        revive = resolve
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
      const entry = {
        ready: Promise.resolve(true),
        revived: new Promise<void>((resolve) => {
          revive = resolve
        }),
        closed: false,
        size: { cols: 80, rows: 24 },
      }
      const exit = { code: 1, signal: null, ranMs: 5_000 }
      const fresh = streaming([snapshot("$ fresh")])
      const attach = vi
        .fn<SurfaceRuntime["attach"]>()
        .mockResolvedValueOnce(replaying([snapshot("$ exit 1", exit)]))
        .mockResolvedValue(fresh.attached)
      const drawn: string[] = []
      const followed = followTerminal(runtimeWith(attach, entry), key, drawing(drawn))
      await vi.waitFor(() => expect(drawn).toEqual(["reset", "$ exit 1"]))
      followed.park()
      entry.revived = new Promise<void>(() => {})
      revive()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(attach).toHaveBeenCalledTimes(1)
      followed.unpark()
      await vi.waitFor(() => expect(drawn).toEqual(["reset", "$ exit 1", "reset", "$ fresh"]))
      followed.stop()
    })
  })
})
