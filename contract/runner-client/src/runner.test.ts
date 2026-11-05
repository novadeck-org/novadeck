import { ORPCError } from "@orpc/server"
import { describe as context, describe, expect, it, onTestFinished, vi } from "vitest"

import { api, fakeRunner } from "./runner.test-support.js"

const never = new Promise<never>(() => {})

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

