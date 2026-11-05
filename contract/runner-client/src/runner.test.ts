import { maxVoicePartLength } from "@novadeck/protocol"
import { WireError } from "@novadeck/wire"
import { ORPCError } from "@orpc/server"
import { describe as context, describe, expect, it, onTestFinished, vi } from "vitest"

import { hasCode } from "./errors.js"
import { api, fakeRunner } from "./runner.test-support.js"

const never = new Promise<never>(() => {})

/** What a promise rejects with. */
const failure = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("It resolved.")
}

describe("a stream of something the runner always has", () => {
  context("ended by the runner on a live session", () => {
    it("waits for the next session instead of opening again", async () => {
      // As the runner's Inbox does once it closes for a shutdown: each new watch ends at once.
      let closing = false
      let close = () => {}
      const closed = new Promise<void>((resolve) => {
        close = resolve
      })
      let opened = 0
      const { runner, drop } = await fakeRunner({
        inbox: {
          watch: api.inbox.watch.handler(async function* () {
            opened += 1
            // A client that spins would never stop; stop it here, so the count says so.
            if (opened > 20) await never
            if (closing) return
            yield []
            await closed
          }),
        },
      })
      vi.useFakeTimers()
      onTestFinished(() => void vi.useRealTimers())
      const watch = runner.inbox.watch()
      onTestFinished(() => void watch.return?.())
      expect(await watch.next()).toEqual({ value: [], done: false })

      const next = watch.next()
      closing = true
      close()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(opened).toBe(1)

      // The runner is back, on a new session.
      closing = false
      drop()
      await vi.advanceTimersByTimeAsync(100)
      expect(await next).toEqual({ value: [], done: false })
      expect(opened).toBe(2)
    })
  })

  context("refused as not found", () => {
    it("tries again later instead of ending", async () => {
      let opened = 0
      const { runner } = await fakeRunner({
        feedback: {
          watch: api.feedback.watch.handler(async function* () {
            opened += 1
            if (opened === 1) throw new ORPCError("NOT_FOUND", { status: 404 })
            yield []
          }),
        },
      })
      const watch = runner.feedback.watch()
      onTestFinished(() => void watch.return?.())
      expect(await watch.next()).toEqual({ value: [], done: false })
      expect(opened).toBe(2)
    })
  })
})

describe("a call", () => {
  context("whose reply the client can't read", () => {
    it("rejects with a coded wire error", async () => {
      const { runner, send } = await fakeRunner({
        projects: { list: api.projects.list.handler(() => never) },
      })
      const listing = runner.projects.list()
      send("not a message")
      const error = await failure(listing)
      // INTERNAL_SERVER_ERROR while the wire leaves the channel open after an unreadable
      // frame; DISCONNECTED once it closes the channel, as it is to.
      expect(error).toBeInstanceOf(WireError)
      expect(hasCode(error, "DISCONNECTED", "INTERNAL_SERVER_ERROR")).toBe(true)
    })
  })

  context("refused by the runner", () => {
    it("rejects with the runner's code", async () => {
      const { runner } = await fakeRunner({
        projects: {
          list: api.projects.list.handler(() => {
            throw new ORPCError("CLOSING", { status: 503 })
          }),
        },
      })
      expect(hasCode(await failure(runner.projects.list()), "CLOSING")).toBe(true)
    })
  })
})

describe("voice.record", () => {
  context("with more audio than one part holds", () => {
    it("sends each part at its offset into the clip", async () => {
      const parts: { offset: number; length: number }[] = []
      const { runner } = await fakeRunner({
        voice: {
          record: api.voice.record.handler(({ input }) => {
            parts.push({ offset: input.offset, length: atob(input.data).length })
          }),
        },
      })
      const part = (maxVoicePartLength / 4) * 3
      await runner.voice.record(crypto.randomUUID(), 100, new Uint8Array(part * 2 + 5))
      expect(parts).toEqual([
        { offset: 100, length: part },
        { offset: 100 + part, length: part },
        { offset: 100 + part * 2, length: 5 },
      ])
    })
  })
})

describe("an attached terminal", () => {
  context("whose reattachment is refused", () => {
    it("ends, and its input rejects with why", async () => {
      const terminalId = crypto.randomUUID()
      let attached = 0
      const { runner, drop } = await fakeRunner({
        terminals: {
          attach: api.terminals.attach.handler(async function* () {
            attached += 1
            // Another client took control while this one was away.
            if (attached > 1) throw new ORPCError("CONTROL_IN_USE", { status: 409 })
            yield { terminalId, type: "attached", mode: "control" } as const
            yield { terminalId, type: "output", sequence: 1, data: "hi" } as const
            await never
          }),
          ack: api.terminals.ack.handler(() => {}),
        },
      })
      const terminal = await runner.terminals.attach(terminalId)
      onTestFinished(() => terminal.detach())
      expect((await terminal.next()).value).toMatchObject({ type: "output", data: "hi" })

      drop()
      const ended = await failure(terminal.next())
      expect(hasCode(ended, "CONTROL_IN_USE")).toBe(true)
      expect(hasCode(await failure(terminal.write("x")), "CONTROL_IN_USE")).toBe(true)
      expect(
        hasCode(await failure(terminal.resize({ cols: 80, rows: 24 })), "CONTROL_IN_USE"),
      ).toBe(true)
    })
  })
})
