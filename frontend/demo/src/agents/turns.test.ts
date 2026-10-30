import { workspaceFromSeed } from "@novadeck/core/seed"
import { createWorkspaceStore } from "@novadeck/core/store"
import type { AgentStatus } from "@novadeck/core/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { demoTerminalId } from "../samples"
import { createDemo, type DemoVariant } from "../variants"
import { answerMs, answeredMs } from "./chat"
import { demoTurns, demoTurnMs, type TurnEvent } from "./turns"

// A sample terminal by its number in a project's first session.
const key = (slot: string, projectId = "storefront", sessionId = "initial") => ({
  projectId,
  workspaceSessionId: sessionId,
  terminalId: demoTerminalId({ projectId, workspaceSessionId: sessionId }, Number(slot)),
})

// What the demo's telemetry holds of a sample terminal's agent.
const reported = (turns: ReturnType<typeof demoTurns>, slot: string) =>
  turns.telemetry.getSnapshot()["storefront/initial"]?.[key(slot).terminalId]

const open = (variant: DemoVariant = "agents") => {
  const turns = demoTurns()
  const events: TurnEvent[] = []
  turns.watch((event) => events.push(event))
  const backend = createDemo(variant, undefined, turns)
  const store = createWorkspaceStore(
    workspaceFromSeed(backend.seed, { view: "grid", windowedView: "grid", now: 0 }),
    backend.commit,
  )
  backend.commit(store.getSnapshot(), [])
  backend.start!({ dispatch: (actions) => store.transact(actions as never), open: () => {} })
  const held = (at: ReturnType<typeof key>) =>
    store
      .getSnapshot()
      .projects.find((project) => project.id === at.projectId)
      ?.history.find((session) => session.id === at.workspaceSessionId)
      ?.state.roster.terminals.find((terminal) => terminal.id === at.terminalId)
  const agent = (at: ReturnType<typeof key>): AgentStatus | undefined => {
    const terminal = held(at)
    return terminal?.state === "running" ? terminal.agent : undefined
  }
  const chat = backend.conversations!
  const requests = (at: ReturnType<typeof key>) => chat.conversation(at).getSnapshot().requests
  const answer = async (
    at: ReturnType<typeof key>,
    request: string,
    option: string,
    text?: string,
  ) => {
    const dialog = requests(at).find((each) => each.id === request)!.dialog!
    if (dialog.type === "raw" || dialog.type === "form") throw new Error("Not answerable here")
    const answering = chat.answer(
      at,
      request,
      dialog.type === "questions"
        ? {
            type: "questions",
            dialog: dialog.id,
            answers: [{ question: dialog.questions[0]!.id, options: [option] }],
          }
        : { type: "choice", dialog: dialog.id, option, ...(text ? { text } : {}) },
    )
    await vi.advanceTimersByTimeAsync(answerMs + answeredMs)
    await answering
  }
  return { turns, events, backend, store, held, agent, chat, requests, answer }
}

const usageOf = (model: string) => ({
  context: { occupied: 1, capacity: null },
  limits: [],
  model,
  effort: null,
})

describe("demo turns", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  describe("work", () => {
    it("starts a turn that runs until another verb ends it", () => {
      const { turns, held, agent } = open()
      turns.work(key("06"), held(key("06")))
      expect(agent(key("06"))).toEqual({ working: true })
      turns.work(key("06"), held(key("06")), { planning: true })
      expect(agent(key("06"))).toEqual({ working: true, planning: true })
      turns.work(key("06"), held(key("06")), { subagents: true })
      expect(agent(key("06"))?.subagents).toHaveLength(3)
      vi.advanceTimersByTime(demoTurnMs * 5)
      expect(agent(key("06"))).toMatchObject({ working: true })
    })

    it("makes a terminal that runs no agent Claude Code first, and keeps usage", () => {
      const { turns, held, agent } = open()
      expect(held(key("02"))?.process).toBe("vite")
      turns.work(key("02"), held(key("02")))
      expect(held(key("02"))?.process).toBe("claude")
      expect(agent(key("02"))).toEqual({ working: true })
      const usage = reported(turns, "01")
      expect(usage).toBeDefined()
      turns.work(key("01"), held(key("01")), { planning: true })
      expect(reported(turns, "01")).toBe(usage)
    })
  })

  describe("finish", () => {
    it("works, then ends the way asked with its reply and when", async () => {
      const { turns, held, agent, chat } = open()
      vi.setSystemTime(1_000_000)
      turns.finish(key("06"), held(key("06")), "completed")
      expect(agent(key("06"))).toMatchObject({ working: true })
      await vi.advanceTimersByTimeAsync(demoTurnMs)
      expect(agent(key("06"))).toMatchObject({
        working: false,
        lastTurn: {
          outcome: "completed",
          at: 1_000_000 + demoTurnMs,
        },
      })
      expect(agent(key("06"))?.lastTurn?.reply).toBeTruthy()
      expect(chat.conversation(key("06")).getSnapshot().items.at(-1)).toMatchObject({
        role: "assistant",
        text: agent(key("06"))?.lastTurn?.reply,
      })
    })

    it("says the reply it is given, rather than the outcome's own", async () => {
      const { turns, held, agent, chat } = open()
      turns.finish(key("06"), held(key("06")), "failed", {
        after: 10,
        reply: "The prices table fails to compile.",
      })
      await vi.advanceTimersByTimeAsync(10)
      expect(agent(key("06"))?.lastTurn).toMatchObject({
        outcome: "failed",
        reply: "The prices table fails to compile.",
      })
      expect(chat.conversation(key("06")).getSnapshot().items.at(-1)?.text).toBe(
        "The prices table fails to compile.",
      )
    })

    it("ends a failed turn in the harness's error, with no reply of the agent's", async () => {
      const { turns, held, agent } = open()
      turns.finish(key("06"), held(key("06")), "failed", {
        after: 10,
        error: "stream disconnected",
      })
      await vi.advanceTimersByTimeAsync(10)
      const lastTurn = agent(key("06"))?.lastTurn
      expect(lastTurn).toMatchObject({ outcome: "failed", error: "stream disconnected" })
      expect(lastTurn?.reply).toBeUndefined()
    })

    it("gives each outcome the reply it has, and unknown none", async () => {
      const { turns, held, agent } = open()
      for (const outcome of ["failed", "interrupted", "unknown"] as const) {
        turns.finish(key("06"), held(key("06")), outcome, { after: 10 })
        // eslint-disable-next-line no-await-in-loop -- Each step waits for the one before.
        await vi.advanceTimersByTimeAsync(10)
        const lastTurn = agent(key("06"))?.lastTurn
        expect(lastTurn?.outcome).toBe(outcome)
        expect(lastTurn?.reply === undefined).toBe(outcome === "unknown")
      }
    })

    it("ends after the time asked", async () => {
      const { turns, held, agent } = open()
      turns.finish(key("06"), held(key("06")), "completed", { after: 100 })
      await vi.advanceTimersByTimeAsync(99)
      expect(agent(key("06"))?.working).toBe(true)
      await vi.advanceTimersByTimeAsync(1)
      expect(agent(key("06"))?.working).toBe(false)
    })

    it("keeps what the ended turn left running, and works on while subagents run", async () => {
      const { turns, held, agent } = open()
      turns.finish(key("04", "api-service"), held(key("04", "api-service")), "completed", {
        after: 100,
        background: { agents: 2, tasks: 1 },
      })
      await vi.advanceTimersByTimeAsync(100)
      expect(agent(key("04", "api-service"))).toMatchObject({
        working: true,
        background: { agents: 2, tasks: 1 },
        lastTurn: { outcome: "completed" },
      })
      const { lastTurn } = agent(key("04", "api-service"))!
      await vi.advanceTimersByTimeAsync(100)
      const done = agent(key("04", "api-service"))!
      expect(done.working).toBe(false)
      expect(done.background).toBeUndefined()
      expect(done.lastTurn).toEqual(lastTurn)
    })

    it("keeps its done report standing once it ends, until the agent is taken some other way", async () => {
      const { turns, held, agent } = open()
      const done = { subject: "Shipped", body: "All of it." }
      turns.finish(key("06"), held(key("06")), "completed", { after: 100, done })
      await vi.advanceTimersByTimeAsync(99)
      expect(agent(key("06"))?.reported).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(agent(key("06"))?.reported).toBe(true)
      // Taking the agent some other way (a rest, as a prompt would) ends it.
      turns.rest(key("06"), held(key("06")))
      expect(agent(key("06"))?.reported).toBeUndefined()
      turns.finish(key("06"), held(key("06")), "completed", { after: 100, done })
      await vi.advanceTimersByTimeAsync(100)
      expect(agent(key("06"))?.reported).toBe(true)
      turns.finish(key("06"), held(key("06")), "completed", { after: 100 })
      expect(agent(key("06"))?.reported).toBeUndefined()
    })

    it("rests waiting on a job it left running, or a wake-up it set", async () => {
      const { turns, held, agent } = open()
      turns.finish(key("06"), held(key("06")), "completed", {
        after: 100,
        waiting: { job: { description: "Watch CI", command: "gh pr checks --watch" }, minutes: 4 },
      })
      await vi.advanceTimersByTimeAsync(100)
      const { lastTurn } = agent(key("06"))!
      expect(agent(key("06"))).toMatchObject({
        working: false,
        waiting: {
          jobs: [{ description: "Watch CI", since: lastTurn!.at - 4 * 60_000, until: null }],
          wake: null,
        },
      })
      turns.finish(key("06"), held(key("06")), "completed", {
        after: 100,
        waiting: { wake: { reason: "Check the deploy" }, inMinutes: 8 },
      })
      await vi.advanceTimersByTimeAsync(100)
      const ended = agent(key("06"))!.lastTurn!.at
      expect(agent(key("06"))?.waiting).toEqual({
        jobs: [],
        wake: { at: ended + 8 * 60_000, reason: "Check the deploy" },
      })
    })

    it("rests at once with commands, which no subagent wakes it for", async () => {
      const { turns, held, agent } = open()
      turns.finish(key("06"), held(key("06")), "completed", {
        after: 100,
        background: { agents: 0, tasks: 2 },
      })
      await vi.advanceTimersByTimeAsync(100)
      expect(agent(key("06"))).toMatchObject({
        working: false,
        background: { agents: 0, tasks: 2 },
      })
      await vi.advanceTimersByTimeAsync(1000)
      expect(agent(key("06"))?.background).toEqual({ agents: 0, tasks: 2 })
    })
  })

  describe("rest", () => {
    it("leaves nothing working, waiting or unread, and keeps usage", async () => {
      const { turns, held, agent } = open()
      const usage = reported(turns, "01")
      turns.finish(key("01"), held(key("01")), "completed", { after: 10 })
      await vi.advanceTimersByTimeAsync(10)
      turns.rest(key("01"), held(key("01")))
      expect(agent(key("01"))).toEqual({ working: false })
      expect(reported(turns, "01")).toBe(usage)
      turns.ask(key("01"), held(key("01")), "plan", 1)
      turns.rest(key("01"), held(key("01")))
      expect(agent(key("01"))).toEqual({ working: false })
      expect(reported(turns, "01")).toBe(usage)
    })
  })

  describe("timers", () => {
    it("are cancelled by the next verb", async () => {
      const { turns, held, agent } = open()
      turns.finish(key("06"), held(key("06")), "completed", { after: 100 })
      turns.rest(key("06"), held(key("06")))
      await vi.advanceTimersByTimeAsync(500)
      expect(agent(key("06"))).toEqual({ working: false })
      turns.finish(key("06"), held(key("06")), "failed", { after: 100 })
      turns.work(key("06"), held(key("06")))
      await vi.advanceTimersByTimeAsync(500)
      expect(agent(key("06"))).toEqual({ working: true })
      turns.finish(key("06"), held(key("06")), "completed", {
        after: 100,
        background: { agents: 1, tasks: 0 },
      })
      await vi.advanceTimersByTimeAsync(100)
      turns.ask(key("06"), held(key("06")), "question", 1)
      await vi.advanceTimersByTimeAsync(500)
      expect(agent(key("06"))).toMatchObject({ working: true, attention: { kind: "question" } })
    })

    it("are cancelled by a release, which reports nothing", async () => {
      const { turns, held, agent } = open()
      turns.finish(key("06"), held(key("06")), "completed", { after: 100 })
      turns.release(key("06"))
      await vi.advanceTimersByTimeAsync(500)
      expect(agent(key("06"))).toEqual({ working: true })
      expect(turns.working(key("06"))).toBe(false)
    })

    it("are cancelled for a turn a prompt started", async () => {
      const { turns, held, agent, chat } = open()
      turns.rest(key("06"), held(key("06")))
      await chat.send(key("06"), "Run the linter")
      await vi.advanceTimersByTimeAsync(0)
      turns.work(key("06"), held(key("06")))
      await vi.advanceTimersByTimeAsync(demoTurnMs * 2)
      expect(agent(key("06"))).toEqual({ working: true })
    })
  })

  describe("requests", () => {
    it("follow what the agent waits on, a made-up one for each of its count", () => {
      const { turns, held, requests } = open()
      turns.ask(key("06"), held(key("06")), "permission", 3)
      expect(requests(key("06")).map((request) => request.kind)).toEqual([
        "permission",
        "permission",
        "permission",
      ])
      turns.ask(key("06"), held(key("06")), "question", 1)
      expect(requests(key("06"))).toHaveLength(1)
      expect(requests(key("06"))[0]?.dialog).toMatchObject({
        type: "questions",
        chat: null,
        questions: [
          {
            multiSelect: false,
            options: [{ id: "1" }, { id: "2" }, { id: "3" }],
          },
        ],
      })
    })

    it("count the transcript's own toward the number", () => {
      const { turns, held, requests } = open()
      expect(requests(key("04")).map((request) => request.id)).toEqual(["04:permission"])
      turns.ask(key("04"), held(key("04")), "permission", 2)
      expect(requests(key("04")).map((request) => request.id)).toHaveLength(2)
      expect(requests(key("04"))[0]?.id).toBe("04:permission")
    })

    it("hold for agents in every project, and for the seed's question", () => {
      const { requests, agent } = open()
      expect(agent(key("01", "docs-site"))?.attention).toMatchObject({ kind: "question", count: 1 })
      expect(requests(key("01", "docs-site"))).toHaveLength(1)
    })

    it("are made when the store is first read after the agent asked", () => {
      const { turns, held, requests } = open()
      turns.ask(key("06", "api-service"), held(key("06", "api-service")), "plan", 2)
      expect(requests(key("06", "api-service"))).toHaveLength(2)
    })

    it("go when the agent rests, is interrupted or finishes", async () => {
      const { turns, held, requests, chat } = open()
      for (const end of [
        () => turns.rest(key("06"), held(key("06"))),
        () => void chat.interrupt(key("06")),
        () => turns.finish(key("06"), held(key("06")), "completed", { after: 10 }),
        () => turns.work(key("06"), held(key("06"))),
      ]) {
        turns.ask(key("06"), held(key("06")), "permission", 2)
        expect(requests(key("06"))).toHaveLength(2)
        end()
        // eslint-disable-next-line no-await-in-loop -- Each step waits for the one before.
        await vi.advanceTimersByTimeAsync(10)
        expect(requests(key("06"))).toEqual([])
      }
    })

    it("lower the count as one of several is answered, resuming with the last", async () => {
      const { turns, held, requests, agent, answer } = open()
      turns.ask(key("06"), held(key("06")), "permission", 2)
      const [first, second] = requests(key("06"))
      await answer(key("06"), first!.id, "1")
      expect(requests(key("06")).map((request) => request.id)).toEqual([second!.id])
      expect(agent(key("06"))).toMatchObject({ working: true, attention: { count: 1 } })
      await answer(key("06"), second!.id, "1")
      expect(requests(key("06"))).toEqual([])
      expect(agent(key("06"))?.attention).toBeUndefined()
      await vi.advanceTimersByTimeAsync(demoTurnMs)
      expect(agent(key("06"))).toMatchObject({
        working: false,
        lastTurn: { outcome: "completed" },
      })
      expect(agent(key("06"))?.lastTurn?.reply).toBeTruthy()
    })

    it("take a permission's words as the next prompt", async () => {
      const { turns, held, requests, answer, chat } = open()
      turns.ask(key("02", "mobile-app"), held(key("02", "mobile-app")), "permission", 1)
      const [request] = requests(key("02", "mobile-app"))
      await answer(key("02", "mobile-app"), request!.id, "2", "Use the unit tests")
      await vi.advanceTimersByTimeAsync(demoTurnMs)
      expect(chat.conversation(key("02", "mobile-app")).getSnapshot().items.at(-1)?.text).toBe(
        "Done: Use the unit tests. Nothing else changed.",
      )
    })

    it("wait at the prompt when a plan is kept", async () => {
      const { turns, held, requests, answer, agent } = open()
      turns.ask(key("06"), held(key("06")), "plan", 1)
      const [request] = requests(key("06"))
      await answer(key("06"), request!.id, "3")
      await vi.advanceTimersByTimeAsync(demoTurnMs * 2)
      expect(agent(key("06"))).toEqual({ working: false })
    })

    it("go on to completion after a question's pick", async () => {
      const { turns, held, requests, answer, agent } = open()
      turns.ask(key("06"), held(key("06")), "question", 1)
      const [request] = requests(key("06"))
      await answer(key("06"), request!.id, "2")
      await vi.advanceTimersByTimeAsync(demoTurnMs)
      expect(agent(key("06"))).toMatchObject({ lastTurn: { outcome: "completed" } })
    })

    it("can be answered whatever the kind and the agent", async () => {
      const { turns, held, requests, answer, chat } = open()
      for (const kind of ["permission", "question", "plan"] as const)
        for (const project of ["storefront", "design-system"]) {
          const at = key("01", project)
          turns.rest(at, held(at))
          turns.ask(at, held(at), kind, 1)
          const [request] = requests(at)
          // eslint-disable-next-line no-await-in-loop -- Each step waits for the one before.
          await expect(answer(at, request!.id, "1")).resolves.toBeUndefined()
          // eslint-disable-next-line no-await-in-loop -- Each step waits for the one before.
          await vi.advanceTimersByTimeAsync(demoTurnMs)
          expect(chat.conversation(at).getSnapshot().requests).toEqual([])
        }
    })
  })

  describe("the showcase", () => {
    it("has each agent wait at its plan, a request to answer, and go on once approved", async () => {
      const { requests, answer, agent } = open("showcase")
      for (const [slot, approve] of [
        ["01", "1"],
        ["03", "2"],
      ] as const) {
        const at = key(slot, "studio")
        expect(agent(at)?.attention).toEqual({ kind: "plan", count: 1 })
        expect(requests(at)).toHaveLength(1)
        // eslint-disable-next-line no-await-in-loop -- Each agent's answer takes its time.
        await answer(at, requests(at)[0]!.id, approve)
        // eslint-disable-next-line no-await-in-loop -- Each agent's answer takes its time.
        await vi.advanceTimersByTimeAsync(demoTurnMs)
        expect(agent(at)).toMatchObject({ working: false, lastTurn: { outcome: "completed" } })
      }
    })
  })

  describe("the agents demo", () => {
    it("has its agents in other projects finish through the turns", async () => {
      const { agent } = open()
      expect(agent(key("01", "design-system"))).toMatchObject({ working: true })
      await vi.advanceTimersByTimeAsync(2500)
      expect(agent(key("01", "design-system"))).toMatchObject({
        working: false,
        lastTurn: { outcome: "completed" },
      })
      expect(agent(key("01", "infra"))).toMatchObject({ lastTurn: { outcome: "failed" } })
    })
  })

  describe("an agent Novadeck hears nothing from", () => {
    it("takes a prompt as a line and a reply, with no turn to report", async () => {
      const { agent, chat, requests, held } = open()
      const terminal = held(key("05"))
      expect(agent(key("05"))).toBeUndefined()
      expect(requests(key("05")).length).toBeGreaterThan(0)
      const before = chat.conversation(key("05")).getSnapshot().items.length
      await chat.send(key("05"), "hello agy")
      await vi.advanceTimersByTimeAsync(demoTurnMs * 2)
      expect(held(key("05"))).toBe(terminal)
      expect(agent(key("05"))).toBeUndefined()
      // What its screen showed is moved past by the line.
      expect(requests(key("05"))).toEqual([])
      expect(
        chat
          .conversation(key("05"))
          .getSnapshot()
          .items.slice(before)
          .map((item) => [item.role, item.text]),
      ).toEqual([
        ["user", "hello agy"],
        ["assistant", "Done: hello agy. Nothing else changed."],
      ])
    })
  })

  describe("usage", () => {
    it("sets usage in a working turn, which a queued prompt leaves working", async () => {
      const { turns, held, agent, chat } = open()
      turns.work(key("06"), held(key("06")))
      await chat.send(key("06"), "queued words")
      const usage = {
        context: { occupied: 1, capacity: null },
        limits: [],
        model: "m",
        effort: null,
      }
      turns.usage(key("06"), held(key("06")), usage)
      expect(agent(key("06"))).toEqual({ working: true })
      expect(reported(turns, "06")).toEqual(usage)
      // The queued prompt still waits for the turn that works on.
      await vi.advanceTimersByTimeAsync(demoTurnMs * 2)
      expect(agent(key("06"))).toEqual({ working: true })
      expect(reported(turns, "06")).toEqual(usage)
      expect(chat.conversation(key("06")).getSnapshot().items.at(-1)?.text).not.toContain("queued")
    })

    it("lives through the end of a turn it was set in", async () => {
      const { turns, held, agent, chat } = open()
      turns.rest(key("06"), held(key("06")))
      await chat.send(key("06"), "go")
      await vi.advanceTimersByTimeAsync(0)
      const usage = {
        context: { occupied: 1, capacity: null },
        limits: [],
        model: "m",
        effort: null,
      }
      turns.usage(key("06"), held(key("06")), usage)
      await vi.advanceTimersByTimeAsync(demoTurnMs)
      expect(agent(key("06"))).toMatchObject({ working: false, lastTurn: {} })
      expect(reported(turns, "06")).toEqual(usage)
    })
  })

  describe("usage over several turns", () => {
    it("is the last one set, not one set in a turn that ended", async () => {
      const { turns, held, agent, chat } = open()
      turns.rest(key("06"), held(key("06")))
      await chat.send(key("06"), "first")
      await vi.advanceTimersByTimeAsync(0)
      turns.usage(key("06"), held(key("06")), usageOf("u1"))
      await vi.advanceTimersByTimeAsync(demoTurnMs)
      expect(reported(turns, "06")?.model).toBe("u1")
      turns.usage(key("06"), held(key("06")), usageOf("u2"))
      await chat.send(key("06"), "second")
      await vi.advanceTimersByTimeAsync(demoTurnMs)
      expect(agent(key("06"))).toMatchObject({ working: false })
      expect(reported(turns, "06")?.model).toBe("u2")
    })

    it("is not kept by a turn that was stopped", async () => {
      const { turns, held, chat } = open()
      turns.rest(key("06"), held(key("06")))
      await chat.send(key("06"), "first")
      await vi.advanceTimersByTimeAsync(0)
      turns.usage(key("06"), held(key("06")), usageOf("u1"))
      await chat.interrupt(key("06"))
      turns.usage(key("06"), held(key("06")), usageOf("u2"))
      await chat.send(key("06"), "second")
      await vi.advanceTimersByTimeAsync(demoTurnMs)
      expect(reported(turns, "06")?.model).toBe("u2")
    })

    it("leaves an agent that is not heard unheard", async () => {
      const { turns, held, agent } = open()
      turns.usage(key("05"), held(key("05")), usageOf("u1"))
      expect(agent(key("05"))).toBeUndefined()
      expect(reported(turns, "05")).toBeUndefined()
    })

    it("is forgotten when the terminal is released", () => {
      const { turns, held } = open()
      turns.usage(key("06"), held(key("06")), usageOf("u1"))
      turns.release(key("06"))
      expect(reported(turns, "06")).toBeUndefined()
    })

    it("shows an agent that ended as running again", () => {
      const { turns, held, agent } = open()
      const ended = { ...held(key("06"))!, state: "exited" as const, exitCode: 1, signal: null }
      turns.usage(key("06"), ended, usageOf("u1"))
      expect(agent(key("06"))).toEqual({ working: false })
      expect(held(key("06"))?.state).toBe("running")
    })

    it("changes the agent's status only to make a shell Claude Code", () => {
      const { turns, held, agent } = open()
      turns.usage(key("02"), held(key("02")), usageOf("u1"))
      expect(held(key("02"))?.process).toBe("claude")
      expect(agent(key("02"))).toEqual({ working: false })
    })
  })

  describe("an answer the agent moved on from", () => {
    it.each([
      ["released while it was on its way", answerMs - 100, "release"],
      ["stopped before it landed", answerMs - 100, "stop"],
      ["stopped while it showed as answered", answerMs + answeredMs - 100, "stop"],
    ] as const)("is refused when the agent is %s", async (_, wait, how) => {
      const { turns, held, agent, chat, requests } = open()
      turns.ask(key("06"), held(key("06")), "permission", 2)
      const [first] = requests(key("06"))
      const dialog = first!.dialog as { id: string }
      const answering = chat.answer(key("06"), first!.id, {
        type: "choice",
        dialog: dialog.id,
        option: "1",
      })
      const outcome = answering.then(
        () => "went through",
        (error: Error) => error.message,
      )
      await vi.advanceTimersByTimeAsync(wait)
      if (how === "release") turns.release(key("06"))
      else await chat.interrupt(key("06"))
      await vi.advanceTimersByTimeAsync(answerMs + answeredMs)
      expect(await outcome).toBe("The agent moved on before your answer reached it.")
      expect(agent(key("06"))?.lastTurn?.outcome).toBe(how === "stop" ? "interrupted" : undefined)
      // Nothing is left half-answered.
      expect(requests(key("06")).every((request) => !request.answered)).toBe(true)
    })
  })

  describe.each<DemoVariant>(["plain", "agents", "messages", "showcase"])("in %s", (variant) => {
    it("runs a prompt to an idle agent through a tool to a completed reply", async () => {
      const { turns, held, agent, chat, requests } = open(variant)
      // The showcase's Refactor auth, else a sample terminal.
      const keyed = variant === "showcase" ? key("03", "studio") : key("06")
      turns.rest(keyed, held(keyed))
      expect(requests(keyed)).toEqual([])
      const before = chat.conversation(keyed).getSnapshot().items.length
      await chat.send(keyed, "Run the linter")
      await vi.advanceTimersByTimeAsync(0)
      expect(agent(keyed)?.working).toBe(true)
      await vi.advanceTimersByTimeAsync(demoTurnMs)
      expect(agent(keyed)).toMatchObject({ working: false, lastTurn: { outcome: "completed" } })
      const items = chat.conversation(keyed).getSnapshot().items.slice(before)
      expect(items.map((item) => item.kind)).toEqual(["text", "tool-call", "tool-result", "text"])
      expect(items.at(-1)?.text).toBe("Done: Run the linter. Nothing else changed.")
    })
  })
})
