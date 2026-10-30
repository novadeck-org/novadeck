import { workspaceFromSeed } from "@novadeck/core/seed"
import type { Approval, ApprovalAnswer } from "@novadeck/protocol"
import { noTheme } from "@novadeck/terminal-views/theme"
import { WireError } from "@novadeck/wire"
import type { WireStatus } from "@novadeck/wire/client"
import { afterAll, vi } from "vitest"

import { runnerBackend, type RunnerApi } from "./backend"
import { context, describe, expect, it } from "./test"
import { startTestRunner } from "./testing/runner"

vi.setConfig({ testTimeout: 20_000 })

const runner = await startTestRunner()
afterAll(() => runner.close())

// Asks pushed by the test, as the runner would send them.
const asks = () => {
  const queued: Approval[] = []
  let wake: (() => void) | undefined
  const iterator: AsyncIterableIterator<Approval, undefined> = {
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
    push: (ask: Approval) => {
      queued.push(ask)
      wake?.()
    },
  }
}

const open = (failAnswer = false) => {
  const sent = asks()
  const answers: ApprovalAnswer[] = []
  const released: string[] = []
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
      approvals: () => sent.iterator,
      release: async (terminalId) => {
        released.push(terminalId)
      },
      answerApproval: async (answer) => {
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
  const ask = (fields: Partial<Extract<Approval, { type: "request" }>> = {}) => {
    const made: Extract<Approval, { type: "request" }> = {
      type: "request",
      requestId: crypto.randomUUID(),
      from: crypto.randomUUID(),
      terminalId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      action: { type: "close" },
      ...fields,
    }
    sent.push(made)
    return made
  }
  const pending = () => backend.approvals!.pending.getSnapshot()
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
  return {
    backend,
    drop,
    reconnect,
    answers,
    released,
    ask,
    pending,
    push: sent.push,
    settled,
    stop,
  }
}

describe("approvals through the runner backend", () => {
  context("when the runner sends asks", () => {
    it("lists them in order, with the terminals they name", async () => {
      const app = open()
      const first = app.ask()
      const second = app.ask()
      await app.settled()
      expect(app.pending()).toEqual([
        {
          requestId: first.requestId,
          from: first.from,
          terminalId: first.terminalId,
          action: first.action,
        },
        {
          requestId: second.requestId,
          from: second.from,
          terminalId: second.terminalId,
          action: second.action,
        },
      ])
      app.stop()
    })
  })

  context("when an agent asks to lead a terminal", () => {
    it("lists the ask with its brief", async () => {
      const app = open()
      const lead = app.ask({ action: { type: "lead", brief: "Review the diff." } })
      await app.settled()
      expect(app.pending()).toEqual([
        {
          requestId: lead.requestId,
          from: lead.from,
          terminalId: lead.terminalId,
          action: { type: "lead", brief: "Review the diff." },
        },
      ])
      app.stop()
    })
  })

  context("when the person releases a terminal from its lead", () => {
    it("tells the runner", async () => {
      const app = open()
      app.backend.releaseLead!({ projectId: "p", workspaceSessionId: "s", terminalId: "t1" })
      await app.settled()
      expect(app.released).toEqual(["t1"])
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
      app.backend.approvals!.answer(first.requestId, true)
      expect(app.answers).toEqual([{ requestId: first.requestId, approved: true }])
      expect(app.pending()).toEqual([])
      app.stop()
    })

    it("ignores a runner that no longer waits for it", async () => {
      const app = open(true)
      const first = app.ask()
      await app.settled()
      app.backend.approvals!.answer(first.requestId, false)
      await app.settled()
      expect(app.answers).toEqual([{ requestId: first.requestId, approved: false }])
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
