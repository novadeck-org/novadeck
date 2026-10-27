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
import { isDemoMessages, rungMs } from "./messages"
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

  it("has three asks arrive one at a time, then makes the badge read three", () => {
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

  it("routes the person's reply to the lead, which wakes and answers", async () => {
    const { backend, cues, inbox, items, agent } = open()
    cues.teammates()
    cues.teammateAsks()
    inbox.answer(items()[0]!.id, {
      kind: "ask",
      answer: { type: "reply", option: null, text: "Ask the lead." },
    })
    const { messages } = backend
    if (!isDemoMessages(messages)) throw new Error("the demo's messages")
    const between = () => {
      const seen = new Map<string, { from: string; to: string; state: string; text: string }>()
      for (const each of Object.values(messages.state.getSnapshot().terminals))
        for (const thread of each.threads)
          for (const message of thread.messages)
            if (message.from !== "you" && message.to !== "you") seen.set(message.id, message)
      return [...seen.values()]
    }
    // Not delivered yet: the teammate has said nothing to its lead.
    await vi.advanceTimersByTimeAsync(800)
    expect(between()).toEqual([])
    await vi.advanceTimersByTimeAsync(2400)
    expect(between()[0]).toMatchObject({
      from: demoHandle(launch.asking),
      to: demoHandle(launch.lead),
      text: expect.stringContaining("Ask the lead."),
    })
    await vi.advanceTimersByTimeAsync(rungMs + 50)
    expect(agent(launch.lead)).toMatchObject({ working: true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(between().map(({ from, to, state }) => ({ from, to, state }))).toEqual([
      { from: demoHandle(launch.asking), to: demoHandle(launch.lead), state: "delivered" },
      { from: demoHandle(launch.lead), to: demoHandle(launch.asking), state: "delivered" },
    ])
    expect(items()).toEqual([])
  })

  it("has a teammate report done, which stands as its report", async () => {
    const { cues, agent, items } = open()
    cues.teammateDone()
    expect(agent(launch.reports)).toBeUndefined()
    cues.teammates()
    cues.teammateDone()
    await vi.advanceTimersByTimeAsync(500)
    expect(agent(launch.reports)).toMatchObject({
      working: false,
      reported: true,
      lastTurn: { outcome: "completed" },
    })
    expect(items()).toMatchObject([{ source: { title: "Pricing endpoint" } }])
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
