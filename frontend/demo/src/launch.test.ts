import type { InboxRow } from "@novadeck/core/inbox"
import { orderedTiles } from "@novadeck/core/roster"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { activeSession } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { answerMs, answeredMs } from "./chat"
import { demoHandle } from "./handles"
import { isDemoInbox } from "./inbox"
import { launch, launchCuesOf, launchIntroOf } from "./launch"
import { isDemoMessages } from "./messages"
import { demoTerminalId } from "./samples"
import { demoTurns } from "./turns"
import { createDemo } from "./variants"

const shop = { projectId: "northwind", workspaceSessionId: "initial" }
const key = (number: number) => ({ ...shop, terminalId: demoTerminalId(shop, number) })

// The launch demo, opened on the Canvas as its video shows it, its Inbox bound to the
// workspace, as the app binds it.
const open = () => {
  const backend = createDemo("launch", undefined, demoTurns())
  const store = createWorkspaceStore(
    workspaceFromSeed(backend.seed, { view: "canvas", windowedView: "canvas", now: 0 }),
    backend.commit,
  )
  backend.commit(store.getSnapshot(), [])
  backend.start!({ dispatch: (actions) => store.transact(actions as never), open: () => {} })
  const inbox = backend.inbox
  if (!isDemoInbox(inbox)) throw new Error("the launch demo has the demo's Inbox")
  inbox.bind!({ workspace: store })
  const cues = launchCuesOf(backend)!
  const terminals = () => activeSession(store.getSnapshot())!.state.roster.terminals
  const agent = (number: number) => {
    const found = terminals().find((each) => each.id === key(number).terminalId)
    return found?.state === "running" ? found.agent : undefined
  }
  const items = (): readonly InboxRow[] => inbox.state.getSnapshot().items
  return { backend, store, inbox, cues, terminals, agent, items }
}

describe("the launch demo", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("opens on the storefront's project, ten agents of all three harnesses at work, and a second project", () => {
    const { backend } = open()
    const [first, second] = backend.seed.projects
    expect(first?.id).toBe("northwind")
    expect(second?.id).toBe("northwind-docs")
    const terminals = first!.sessions[0]!.terminals
    expect(terminals).toHaveLength(10)
    expect(new Set(terminals.map((terminal) => terminal.process))).toEqual(
      new Set(["claude", "codex", "agy"]),
    )
    for (const project of backend.seed.projects)
      for (const terminal of project.sessions[0]!.terminals)
        expect(terminal).toMatchObject({ state: "running", agent: { working: true } })
    expect(first!.sessions[0]!.canvasLayout?.geometry).toBeDefined()
  })

  it("opens the storefront's screens on their own work, and leaves the other project's to the demo", () => {
    const { backend } = open()
    const [mine, other] = backend.seed.projects
    const at = (project: typeof mine, number: number) => ({
      projectId: project!.id,
      workspaceSessionId: "initial",
      terminalId: project!.sessions[0]!.terminals[number - 1]!.id,
    })
    expect(launchIntroOf(mine!.sessions[0]!.terminals[0]!, at(mine, 1))).toBeDefined()
    expect(launchIntroOf(other!.sessions[0]!.terminals[0]!, at(other, 1))).toBeUndefined()
  })

  it("shows a spread of states: one agent asking, one failed, one done, the rest working", async () => {
    const { cues, agent, items } = open()
    cues.states()
    await vi.advanceTimersByTimeAsync(500)
    expect(agent(launch.permission)?.attention).toMatchObject({ kind: "permission" })
    expect(agent(launch.failing)).toMatchObject({
      working: false,
      lastTurn: { outcome: "failed", error: "stream disconnected" },
    })
    expect(agent(launch.finishes)).toMatchObject({
      working: false,
      reported: true,
      lastTurn: { outcome: "completed" },
    })
    expect(agent(1)).toMatchObject({ working: true })
    expect(items().map((item) => item.kind)).toEqual(expect.arrayContaining(["request", "trouble"]))
  })

  it("raises three asks one at a time, and all at once, so the Inbox waits on three", () => {
    const { cues, items } = open()
    expect(items()).toEqual([])
    cues.permission()
    expect(items()).toHaveLength(1)
    cues.plan()
    cues.question()
    const byTitle = Object.fromEntries(items().map((item) => [item.source.title, item]))
    expect(byTitle["Checkout tests"]).toMatchObject({
      request: { kind: "permission", subject: "pnpm test:e2e --filter checkout" },
    })
    expect(byTitle["Order emails"]).toMatchObject({ request: { kind: "plan" } })
    const question = byTitle["Cart drawer"]
    if (question?.kind !== "request" || question.request.dialog?.type !== "questions")
      throw new Error("a question")
    expect(question.request.dialog.questions[0]!.options[0]!.label).toMatch(/\(Recommended\)$/)
    // Ringing them again asks nothing more.
    cues.asks()
    expect(items()).toHaveLength(3)
    expect(items().filter((item) => !("settled" in item && item.settled))).toHaveLength(3)
  })

  it("sends each agent back to work when its ask is answered", async () => {
    const { cues, inbox, items, agent } = open()
    cues.asks()
    for (const item of items()) {
      if (item.kind !== "request" || !item.request.dialog || item.request.dialog.type === "raw")
        throw new Error("a request")
      const { dialog } = item.request
      const answer =
        dialog.type === "questions"
          ? {
              type: "questions" as const,
              dialog: dialog.id,
              answers: [{ question: dialog.questions[0]!.question, options: ["account"] }],
            }
          : { type: "choice" as const, dialog: dialog.id, option: "1" }
      inbox.answer(item.id, { kind: "request", answer })
      // eslint-disable-next-line no-await-in-loop -- Each answer waits for the one before.
      await vi.advanceTimersByTimeAsync(answerMs + answeredMs + 1500)
    }
    await vi.advanceTimersByTimeAsync(10_000)
    expect(items()).toEqual([])
    for (const number of [launch.permission, launch.plan, launch.question])
      expect(agent(number)).toMatchObject({ working: true })
  })

  it("has the lead open three teammates its team wire draws to, and rest", () => {
    const { cues, terminals, agent, store } = open()
    cues.teammates()
    expect(terminals()).toHaveLength(13)
    const lead = terminals().find((each) => each.id === key(launch.lead).terminalId)!
    const teammates = terminals().slice(10)
    expect(teammates.map((each) => each.ledBy)).toEqual([lead.handle, lead.handle, lead.handle])
    expect(new Set(teammates.map((each) => each.process))).toEqual(
      new Set(["codex", "agy", "claude"]),
    )
    const listed = orderedTiles(activeSession(store.getSnapshot())!.state.roster).map(
      (each) => each.id,
    )
    const below = listed.indexOf(lead.id) + 1
    expect(listed.slice(below, below + 3)).toEqual(teammates.map((each) => each.id))
    expect(agent(launch.lead)).toMatchObject({ working: false })
    cues.teammates()
    expect(terminals()).toHaveLength(13)
  })

  it("has a teammate ask what only its lead knows, and ask nothing before the teammates open", () => {
    const { cues, items, terminals } = open()
    cues.teammateAsks()
    expect(items()).toEqual([])
    cues.teammates()
    cues.teammateAsks()
    expect(items()).toMatchObject([
      {
        kind: "ask",
        source: { title: "Cart endpoint" },
        ask: { shape: { type: "text" } },
      },
    ])
    expect(items()[0]!.source.agent).toBe(
      terminals().find((each) => each.id === key(launch.asking).terminalId)?.process,
    )
  })

  // The messages between agents, in order, as (from, to, state, text).
  const exchange = (backend: ReturnType<typeof open>["backend"]) => {
    const { messages } = backend
    if (!isDemoMessages(messages)) throw new Error("the demo's messages")
    const seen = new Map<string, { from: string; to: string; state: string; text: string }>()
    for (const each of Object.values(messages.state.getSnapshot().terminals))
      for (const thread of each.threads)
        for (const message of thread.messages)
          if (message.from !== "you" && message.to !== "you") seen.set(message.id, message)
    return [...seen.values()]
  }
  const lead = demoHandle(launch.lead)
  const asking = demoHandle(launch.asking)

  it("opens teammates its lead opened and briefed, on the doorbell's notice, not the person's words", async () => {
    const { backend, cues, terminals } = open()
    cues.teammates()
    const teammates = terminals().slice(10)
    for (const each of teammates) expect(each).toMatchObject({ ledBy: lead, openedBy: lead })
    await vi.advanceTimersByTimeAsync(4000)
    expect(exchange(backend).map(({ from, to, text }) => ({ from, to, text }))).toEqual([
      { from: lead, to: demoHandle(11), text: "Serve prices from the API." },
      { from: lead, to: demoHandle(12), text: "Serve stock levels from the API." },
      { from: lead, to: demoHandle(13), text: "Keep the cart in the API." },
    ])
    // The conversation opens on the notice, so the sheet shows no other agent's words as the
    // person's.
    const first = await backend.conversations!.conversation(key(launch.asking)).getSnapshot()
    expect(first.items[0]).toMatchObject({
      role: "user",
      text: expect.stringContaining("[Novadeck: automatic notice"),
    })
  })

  it("has a teammate ask the person and its lead at once; the lead answers first and the ask is withdrawn", async () => {
    const { backend, cues, items, agent } = open()
    cues.teammates()
    cues.teammateAsks()
    expect(items()).toMatchObject([
      { kind: "ask", source: { title: "Cart endpoint" }, ask: { shape: { type: "text" } } },
    ])
    expect(items()[0]).not.toHaveProperty("settled")
    // The question reached the lead as a message too; the person types nothing.
    await vi.advanceTimersByTimeAsync(3000)
    expect(
      exchange(backend).find((each) => each.to === lead && each.from === asking),
    ).toMatchObject({ text: expect.stringContaining("Which API version") })
    expect(agent(launch.lead)).toMatchObject({ working: true })
    // Still open while the lead has not answered.
    expect(items()[0]).not.toHaveProperty("settled")
    await vi.advanceTimersByTimeAsync(6000)
    expect(
      exchange(backend)
        .filter(
          (each) =>
            each.from === lead && each.to === asking && each.text.startsWith("The storefront"),
        )
        .map((each) => ({ state: each.state, text: each.text })),
    ).toEqual([
      { state: "delivered", text: "The storefront calls v2, on port 8787. v1 is retired." },
    ])
    expect(items()).toMatchObject([{ kind: "ask", settled: { how: "withdrawn" } }])
    expect(agent(launch.asking)).toMatchObject({ working: true })
  })

  it("holds the teammate and its lead through finishAll until the exchange is out", async () => {
    const { cues, agent } = open()
    cues.teammates()
    cues.teammateAsks()
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(3000)
    expect(agent(launch.asking)).not.toHaveProperty("lastTurn")
    expect(agent(launch.lead)).not.toHaveProperty("lastTurn")
  })

  it("has a teammate report done to its lead as a message, which rings the lead", async () => {
    const { backend, cues, agent } = open()
    cues.teammateDone()
    expect(agent(launch.reports)).toBeUndefined()
    cues.teammates()
    cues.teammateDone()
    await vi.advanceTimersByTimeAsync(500)
    expect(agent(launch.reports)).toMatchObject({
      working: false,
      lastTurn: { outcome: "completed" },
    })
    await vi.advanceTimersByTimeAsync(4000)
    expect(
      exchange(backend).find(
        (each) => each.from === demoHandle(launch.reports) && each.to === lead,
      ),
    ).toMatchObject({
      state: "delivered",
      text: expect.stringContaining("pricing endpoint answers"),
    })
    expect(agent(launch.lead)).toMatchObject({ working: true })
  })

  it("does nothing twice, nor before it can, nor after everyone finished", async () => {
    const { cues, items, terminals, store } = open()
    // Before the teammates are open.
    cues.teammateAsks()
    cues.teammateDone()
    expect(items()).toEqual([])
    expect(terminals()).toHaveLength(10)
    cues.teammates()
    cues.teammates()
    expect(terminals()).toHaveLength(13)
    cues.teammateAsks()
    cues.teammateAsks()
    expect(items()).toHaveLength(1)
    cues.show()
    cues.show()
    cues.showChanges()
    cues.showChanges()
    expect(activeSession(store.getSnapshot())!.state.items).toHaveLength(2)
    cues.fail()
    cues.fail()
    cues.finishOne()
    cues.finishOne()
    cues.teammateDone()
    cues.teammateDone()
    await vi.advanceTimersByTimeAsync(10_000)
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(3000)
    // Cues after everyone finished start nobody's turn again.
    const before = items().length
    cues.permission()
    cues.plan()
    cues.question()
    cues.fail()
    cues.finishOne()
    cues.teammateDone()
    await vi.advanceTimersByTimeAsync(3000)
    expect(items()).toHaveLength(before)
    for (const each of terminals())
      expect(each).toMatchObject({ agent: { working: false, lastTurn: expect.anything() } })
  })

  it("shows the page, then the changes, in the pane beside the order-status window", () => {
    const { cues, store } = open()
    cues.show()
    cues.showChanges()
    const { items } = activeSession(store.getSnapshot())!.state
    expect(items).toMatchObject([
      {
        kind: "page",
        url: "http://localhost:3000/orders/1042",
        holder: { terminalId: key(launch.shows).terminalId },
      },
      { kind: "changes", openAsked: true, holder: { terminalId: key(launch.shows).terminalId } },
    ])
  })

  it("ends with every agent of both projects done, leaving what waits on the person waiting", async () => {
    const { cues, store } = open()
    cues.permission()
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(3000)
    for (const project of store.getSnapshot().projects)
      for (const session of project.history)
        for (const terminal of session.state.roster.terminals)
          expect(terminal).toMatchObject({
            agent:
              terminal.id === key(launch.permission).terminalId
                ? { attention: { kind: "permission" } }
                : { working: false, lastTurn: { outcome: "completed" } },
          })
  })

  it("ends with the Inbox empty of asks once everything is answered or finished", async () => {
    const { cues, items } = open()
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(3000)
    expect(items().every((item) => item.kind === "update")).toBe(true)
  })
})
