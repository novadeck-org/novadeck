import { workspaceFromSeed } from "@novadeck/core/seed"
import type { CloseAsk, CloseAskAnswer } from "@novadeck/protocol"
import { noTheme } from "@novadeck/terminal-views/theme"
import { WireError } from "@novadeck/wire"
import type { WireStatus } from "@novadeck/wire/client"
import { afterAll, vi } from "vitest"

import { runnerBackend, type RunnerApi } from "./backend"
import { context, describe, expect, it } from "./test"
import { startTestRunner } from "./testing"

vi.setConfig({ testTimeout: 20_000 })

const runner = await startTestRunner()
afterAll(() => runner.close())

// Asks pushed by the test, as the runner would send them.
const asks = () => {
  const queued: CloseAsk[] = []
  let wake: (() => void) | undefined
  const iterator: AsyncIterableIterator<CloseAsk, undefined> = {
    [Symbol.asyncIterator]: () => iterator,
    next: async () => {
      // eslint-disable-next-line no-await-in-loop -- Waits for the next pushed ask.
      while (!queued.length) await new Promise<void>((resolve) => (wake = resolve))
      return { value: queued.shift()!, done: false }
    },
    return: async () => ({ value: undefined, done: true }),
  }
  return {
    iterator,
    push: (ask: CloseAsk) => {
      queued.push(ask)
      wake?.()
    },
  }
}

const open = (failAnswer = false) => {
  const sent = asks()
  const answers: CloseAskAnswer[] = []
  // The link's status, which the test changes as a dropped connection would.
  const link: WireStatus[] = [{ state: "connected", epoch: "r1" }]
  let wakeLink: (() => void) | undefined
  const api: RunnerApi = {
    ...runner.client,
    watch: async function* () {
      for (let seen = 0; ; seen += 1) {
        // eslint-disable-next-line no-await-in-loop -- Waits for the next status.
        while (seen >= link.length) await new Promise<void>((resolve) => (wakeLink = resolve))
        yield link[seen]!
      }
    },
    terminals: {
      ...runner.client.terminals,
      closeAsks: () => sent.iterator,
      answerCloseAsk: async (answer) => {
        answers.push(answer)
        if (failAnswer) throw Object.assign(new Error("gone"), { code: "NOT_FOUND" })
      },
    },
  }
  const { backend, idle } = runnerBackend(api, runner.listing, { theme: noTheme, saveDelay: 10 })
  backend.commit(
    workspaceFromSeed(backend.seed, { view: "grid", windowedView: "grid", now: 1 }),
    [],
  )
  const stop = backend.start!({ dispatch: () => {}, open: () => {} })
  const ask = (fields: Partial<Extract<CloseAsk, { type: "ask" }>> = {}) => {
    const made: Extract<CloseAsk, { type: "ask" }> = {
      type: "ask",
      requestId: crypto.randomUUID(),
      from: crypto.randomUUID(),
      terminalId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      ...fields,
    }
    sent.push(made)
    return made
  }
  const pending = () => backend.closeAsks!.pending.getSnapshot()
  // Lets the pushed asks reach the store.
  const settled = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    await idle()
  }
  const drop = () => {
    link.push({ state: "reconnecting", error: new WireError("DISCONNECTED") })
    wakeLink?.()
  }
  const reconnect = () => {
    link.push({ state: "connected", epoch: "r2" })
    wakeLink?.()
  }
  return { backend, drop, reconnect, answers, ask, pending, push: sent.push, settled, stop }
}

describe("asks to close a terminal through the runner backend", () => {
  context("when the runner sends asks", () => {
    it("lists them in order, with the terminals they name", async () => {
      const app = open()
      const first = app.ask()
      const second = app.ask()
      await app.settled()
      expect(app.pending()).toEqual([
        { requestId: first.requestId, from: first.from, terminalId: first.terminalId },
        { requestId: second.requestId, from: second.from, terminalId: second.terminalId },
      ])
      app.stop()
    })
  })

  context("when the runner withdraws an ask", () => {
    it("drops that ask and keeps the rest", async () => {
      const app = open()
      const first = app.ask()
      const second = app.ask()
      app.push({ type: "withdrawn", requestId: first.requestId })
      await app.settled()
      expect(app.pending().map((each) => each.requestId)).toEqual([second.requestId])
      app.stop()
    })
  })

  context("when the person answers", () => {
    it("sends the answer to the runner and drops the ask", async () => {
      const app = open()
      const first = app.ask()
      await app.settled()
      app.backend.closeAsks!.answer(first.requestId, true)
      expect(app.answers).toEqual([{ requestId: first.requestId, close: true }])
      expect(app.pending()).toEqual([])
      app.stop()
    })

    it("ignores a runner that no longer waits for it", async () => {
      const app = open(true)
      const first = app.ask()
      await app.settled()
      app.backend.closeAsks!.answer(first.requestId, false)
      await app.settled()
      expect(app.answers).toEqual([{ requestId: first.requestId, close: false }])
      expect(app.pending()).toEqual([])
      app.stop()
    })
  })

  context("when the link to the runner drops", () => {
    it("forgets the asks, which the runner settled, and lists the ones sent once it reconnects", async () => {
      const app = open()
      app.ask()
      await app.settled()
      app.drop()
      await app.settled()
      expect(app.pending()).toEqual([])
      // One still on its way as the link dropped was settled too: it never shows.
      app.ask()
      await app.settled()
      expect(app.pending()).toEqual([])
      app.reconnect()
      await app.settled()
      const later = app.ask()
      await app.settled()
      expect(app.pending().map((each) => each.requestId)).toEqual([later.requestId])
      app.stop()
    })
  })

  context("when the backend stops", () => {
    it("forgets the asks", async () => {
      const app = open()
      app.ask()
      await app.settled()
      app.stop()
      expect(app.pending()).toEqual([])
    })
  })
})
