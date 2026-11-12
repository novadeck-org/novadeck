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
  context("sent a frame it can't read", () => {
    it("resumes after the last event it read, and takes input again", async () => {
      const terminalId = crypto.randomUUID()
      const resumed: (number | undefined)[] = []
      const written: string[] = []
      const { runner, send } = await fakeRunner({
        terminals: {
          attach: api.terminals.attach.handler(async function* ({ input }) {
            resumed.push(input.afterSequence)
            yield { terminalId, type: "attached", mode: "control" } as const
            const sequence = (input.afterSequence ?? 0) + 1
            yield { terminalId, type: "output", sequence, data: `event ${sequence}` } as const
            await never
          }),
          ack: api.terminals.ack.handler(() => {}),
          write: api.terminals.write.handler(({ input }) => {
            written.push(input.data)
          }),
        },
      })
      const terminal = await runner.terminals.attach(terminalId)
      onTestFinished(() => terminal.detach())
      expect((await terminal.next()).value).toMatchObject({ sequence: 1, data: "event 1" })

      send("not a message")
      expect((await terminal.next()).value).toMatchObject({ sequence: 2, data: "event 2" })
      expect(resumed).toEqual([undefined, 1])
      await terminal.write("x")
      expect(written).toEqual(["x"])
    })
  })

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

describe("History", () => {
  const row = {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    title: "Fix login",
    summary: null,
    handle: "moth",
    agent: "claude" as const,
    program: null,
    cwd: "/shop",
    closedAt: 1_000,
    closedBy: null,
    availability: { state: "ready" as const },
  }

  it("lists a project's closed terminals and follows them from a reset to synced", async () => {
    const { runner } = await fakeRunner({
      history: {
        list: api.history.list.handler(({ input }) =>
          input.projectId === row.projectId ? [row] : [],
        ),
        watch: api.history.watch.handler(async function* () {
          yield { type: "changed" as const, closed: row }
          yield { type: "synced" as const }
          yield { type: "removed" as const, id: row.id, projectId: row.projectId }
        }),
      },
    })
    expect(await runner.history.list({ projectId: row.projectId })).toEqual([row])
    expect(await runner.history.list({ projectId: row.id })).toEqual([])
    const watch = runner.history.watch()
    onTestFinished(() => void watch.return?.())
    const seen: string[] = []
    for (let step = 0; step < 4; step += 1) {
      // eslint-disable-next-line no-await-in-loop -- Events arrive in order.
      const { value } = await watch.next()
      seen.push(value!.type)
    }
    expect(seen).toEqual(["reset", "changed", "synced", "removed"])
  })
})

describe("Works", () => {
  const terminalId = "11111111-1111-4111-8111-111111111111"
  const projectId = "22222222-2222-4222-8222-222222222222"
  const root = "/home/me/.novadeck/worktrees/p/x/web"

  it("follows works from a reset to synced, and looks at, shows and closes one by its root", async () => {
    const looked: string[] = []
    const shown: unknown[] = []
    const closed: unknown[] = []
    const { runner } = await fakeRunner({
      works: {
        watch: api.works.watch.handler(async function* () {
          yield { type: "synced" as const }
          yield { type: "removed" as const, root, projectId }
        }),
        look: api.works.look.handler(({ input }) => {
          looked.push(input.root)
        }),
        show: api.works.show.handler(({ input }) => {
          shown.push(input)
          return { itemId: terminalId }
        }),
        close: api.works.close.handler(({ input }) => {
          closed.push(input)
          return { closed: true as const, kept: "refs/novadeck/kept/x", branchDeleted: false }
        }),
      },
    })
    const watch = runner.works.watch()
    onTestFinished(() => void watch.return?.())
    const seen: string[] = []
    for (let step = 0; step < 3; step += 1) {
      // eslint-disable-next-line no-await-in-loop -- Events arrive in order.
      const { value } = await watch.next()
      seen.push(value!.type)
    }
    expect(seen).toEqual(["reset", "synced", "removed"])
    await runner.works.look(root)
    expect(looked).toEqual([root])
    expect(await runner.works.show(root, terminalId)).toEqual({ itemId: terminalId })
    expect(shown).toEqual([{ root, terminalId }])
    expect(await runner.works.close(root, true)).toEqual({
      closed: true,
      kept: "refs/novadeck/kept/x",
      branchDeleted: false,
    })
    expect(closed).toEqual([{ root, force: true }])
  })
})

describe("Works made", () => {
  it("follows each worktree made, with no reset and no synced", async () => {
    const projectId = "22222222-2222-4222-8222-222222222222"
    const { runner } = await fakeRunner({
      works: {
        made: api.works.made.handler(async function* () {
          yield { root: "/w/a", projectId }
          yield { root: "/w/b", projectId }
        }),
      },
    })
    const made = runner.works.made()
    onTestFinished(() => void made.return?.())
    const first = await made.next()
    const second = await made.next()
    expect([first.value, second.value]).toEqual([
      { root: "/w/a", projectId },
      { root: "/w/b", projectId },
    ])
  })
})

describe("a prompt with images", () => {
  const sent = async (at: readonly number[]) => {
    const inputs: unknown[] = []
    const { runner } = await fakeRunner({
      agents: {
        prompt: api.agents.prompt.handler(({ input }) => {
          inputs.push(input)
          return { ref: "r1r1r1r1r1r1r1r1", tracked: true }
        }),
      },
    })
    await runner.agents.prompt(crypto.randomUUID(), "See this: and fix it", {
      images: ["/u/a.png"],
      at,
    })
    return inputs[0]
  }

  it("leaves out the places of images that all lead, as a runner from before them takes", async () => {
    expect(await sent([0])).not.toHaveProperty("at")
  })

  it("gives the places of an image among the words", async () => {
    expect(await sent([10])).toMatchObject({ images: ["/u/a.png"], at: [10] })
  })
})

describe("the person's Send or Stop over a question", () => {
  const inputs = async () => {
    const seen: unknown[] = []
    const { runner } = await fakeRunner({
      agents: {
        prompt: api.agents.prompt.handler(({ input }) => {
          seen.push(input)
          return { ref: "r1r1r1r1r1r1r1r1", tracked: true }
        }),
        interrupt: api.agents.interrupt.handler(({ input }) => {
          seen.push(input)
          return { returned: null }
        }),
      },
    })
    return { runner, seen }
  }

  it("asks the runner to set the question aside only where the caller says so", async () => {
    const { runner, seen } = await inputs()
    const terminalId = crypto.randomUUID()
    await runner.agents.prompt(terminalId, "Do this instead", { setAside: ["q1q1q1q1q1q1q1q1"] })
    await runner.agents.prompt(terminalId, "Continue")
    await runner.agents.interrupt(terminalId, { setAside: ["q1q1q1q1q1q1q1q1"] })
    await runner.agents.interrupt(terminalId)
    expect(seen[0]).toMatchObject({ setAside: ["q1q1q1q1q1q1q1q1"] })
    expect(seen[1]).not.toHaveProperty("setAside")
    expect(seen[2]).toMatchObject({ setAside: ["q1q1q1q1q1q1q1q1"] })
    expect(seen[3]).not.toHaveProperty("setAside")
  })
})
