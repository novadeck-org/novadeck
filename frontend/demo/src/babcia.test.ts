import type { InboxItem } from "@novadeck/core/inbox"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { activeSession } from "@novadeck/core/state"
import { createStore, createWorkspaceStore } from "@novadeck/core/store"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { babcia, babciaCuesOf, babciaIntroOf } from "./babcia"
import { answerMs, answeredMs } from "./chat"
import { demoHandle } from "./handles"
import { isDemoInbox } from "./inbox"
import { isDemoMessages } from "./messages"
import { demoTerminalId } from "./samples"
import { demoTurns } from "./turns"
import { createDemo } from "./variants"

const bar = { projectId: "bar-mleczny", workspaceSessionId: "initial" }
const key = (number: number) => ({ ...bar, terminalId: demoTerminalId(bar, number) })

// The Babcia demo, opened on the Canvas as its video shows it, its Inbox bound to the
// workspace and to what the person hasn't read, as the app binds it.
const open = () => {
  const backend = createDemo("babcia", undefined, demoTurns())
  const store = createWorkspaceStore(
    workspaceFromSeed(backend.seed, { view: "canvas", windowedView: "canvas", now: 0 }),
    backend.commit,
  )
  backend.commit(store.getSnapshot(), [])
  backend.start!({ dispatch: (actions) => store.transact(actions as never), open: () => {} })
  const unread = createStore<Record<string, Record<string, "done" | "failed">>>({})
  const inbox = backend.inbox
  if (!isDemoInbox(inbox)) throw new Error("the Babcia demo has the demo's Inbox")
  inbox.bind!({ workspace: store, unread, read: () => {} })
  const cues = babciaCuesOf(backend)!
  const terminals = () => activeSession(store.getSnapshot())!.state.roster.terminals
  const terminal = (number: number) =>
    terminals().find((each) => each.id === key(number).terminalId)
  const agent = (number: number) => {
    const found = terminal(number)
    return found?.state === "running" ? found.agent : undefined
  }
  const items = (): readonly InboxItem[] => inbox.state.getSnapshot().items
  return { backend, store, inbox, cues, terminals, terminal, agent, items, unread }
}

describe("the Babcia demo", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("opens on the milk bar's project, a dozen agents of all three harnesses at work, and a second project", () => {
    const { backend } = open()
    const [first, second] = backend.seed.projects
    expect(first?.id).toBe("bar-mleczny")
    expect(second?.id).toBe("setlist")
    const terminals = first!.sessions[0]!.terminals
    expect(terminals).toHaveLength(12)
    expect(new Set(terminals.map((terminal) => terminal.process))).toEqual(
      new Set(["claude", "codex", "agy"]),
    )
    for (const project of backend.seed.projects)
      for (const terminal of project.sessions[0]!.terminals)
        expect(terminal).toMatchObject({ state: "running", agent: { working: true } })
    expect(first!.sessions[0]!.canvasLayout?.geometry).toBeDefined()
  })

  it("starts with the Inbox quiet, then three asks make the badge read three", () => {
    const { cues, items, agent } = open()
    expect(items()).toEqual([])
    cues.asks()
    expect(items().map((item) => item.kind)).toHaveLength(3)
    const byTitle = Object.fromEntries(items().map((item) => [item.source.title, item]))
    expect(byTitle["Order form"]).toMatchObject({
      kind: "request",
      source: { projectName: "bar-mleczny" },
      request: { kind: "permission", subject: "pnpm test" },
    })
    expect(byTitle["Accessibility"]).toMatchObject({ request: { kind: "plan" } })
    const question = byTitle["Menu page"]
    if (question?.kind !== "request" || question.request.dialog?.type !== "questions")
      throw new Error("a question")
    expect(question.request.dialog.questions[0]!.options[0]!.label).toMatch(/\(Recommended\)$/)
    expect(agent(babcia.permission)?.attention).toMatchObject({ kind: "permission", count: 1 })
    // Ringing them again asks nothing more.
    cues.asks()
    expect(items()).toHaveLength(3)
  })

  it("sends each agent back to work when its ask is answered, and keeps it working", async () => {
    const { cues, inbox, items, agent } = open()
    cues.asks()
    const answers = {
      "Order form": (item: InboxItem) =>
        item.kind === "request" && item.request.dialog?.type === "choices"
          ? { type: "choice" as const, dialog: item.request.dialog.id, option: "1" }
          : undefined,
      Accessibility: (item: InboxItem) =>
        item.kind === "request" && item.request.dialog?.type === "choices"
          ? { type: "choice" as const, dialog: item.request.dialog.id, option: "manual" }
          : undefined,
      "Menu page": (item: InboxItem) =>
        item.kind === "request" && item.request.dialog?.type === "questions"
          ? {
              type: "questions" as const,
              dialog: item.request.dialog.id,
              answers: [
                { question: "How should the menu list the daily soups?", options: ["line"] },
              ],
            }
          : undefined,
    }
    for (const item of items()) {
      const answer = answers[item.source.title as keyof typeof answers](item)
      if (!answer) throw new Error(`an answer for ${item.source.title}`)
      inbox.answer(item.id, { kind: "request", answer })
      // eslint-disable-next-line no-await-in-loop -- Each answer waits for the one before.
      await vi.advanceTimersByTimeAsync(answerMs + answeredMs + 1500)
    }
    await vi.advanceTimersByTimeAsync(10_000)
    expect(items()).toEqual([])
    for (const number of [babcia.permission, babcia.plan, babcia.question])
      expect(agent(number)).toMatchObject({ working: true })
    expect(agent(babcia.permission)?.attention).toBeUndefined()
  })

  it("fails one turn, which a typed reply sends back to work", async () => {
    const { backend, cues, items, agent, unread } = open()
    cues.fail()
    await vi.advanceTimersByTimeAsync(500)
    expect(agent(babcia.failing)).toMatchObject({
      working: false,
      lastTurn: { outcome: "failed" },
    })
    // The app marks a finish the person didn't see.
    unread.update(() => ({ "bar-mleczny/initial": { [key(babcia.failing).terminalId]: "failed" } }))
    expect(items()).toMatchObject([
      { kind: "trouble", source: { title: "Prices table" }, trouble: { type: "failed" } },
    ])
    await backend.conversations!.send(key(babcia.failing), "Try again, kochanie.")
    await vi.advanceTimersByTimeAsync(10_000)
    expect(agent(babcia.failing)).toMatchObject({ working: true })
  })

  it("has the lead open three helpers its team wire draws to, and rest", () => {
    const { cues, terminals, agent } = open()
    cues.helpers()
    expect(terminals()).toHaveLength(15)
    const lead = terminals().find((each) => each.id === key(babcia.lead).terminalId)!
    const helpers = terminals().slice(12)
    expect(helpers.map((each) => each.ledBy)).toEqual([lead.handle, lead.handle, lead.handle])
    expect(helpers.map((each) => each.process)).toEqual(["codex", "agy", "claude"])
    expect(agent(babcia.lead)).toMatchObject({ working: false })
    // Opening them twice opens no more.
    cues.helpers()
    expect(terminals()).toHaveLength(15)
  })

  it("has a helper ask what only its lead knows; the person's words reach the lead, who wakes", async () => {
    const { backend, cues, inbox, items, agent } = open()
    cues.helpers()
    cues.helperAsks()
    const [ask] = items()
    expect(ask).toMatchObject({
      kind: "ask",
      source: { title: "Orders endpoint" },
      ask: { subject: "Which API does the site call?", shape: { type: "text" } },
    })
    expect(agent(babcia.lead)).toMatchObject({ working: false })
    inbox.answer(ask!.id, {
      kind: "ask",
      answer: { type: "reply", option: null, text: "How should I know? Ask your sister." },
    })
    await vi.advanceTimersByTimeAsync(5000)
    expect(items()).toEqual([])
    // The idle lead was rung awake, and the helper still works.
    expect(agent(babcia.lead)).toMatchObject({ working: true })
    expect(agent(babcia.asking)).toMatchObject({ working: true })
    const { messages } = backend
    if (!isDemoMessages(messages)) throw new Error("the Babcia demo has the demo's messages")
    const sent = Object.values(messages.state.getSnapshot().terminals)
      .flatMap((mail) => mail.threads)
      .flatMap((thread) => thread.messages)
    // The helper wrote to its lead, which the doorbell delivered, and the lead wrote back.
    expect(sent.map(({ from, to, state }) => ({ from, to, state }))).toEqual(
      expect.arrayContaining([
        { from: demoHandle(babcia.asking), to: demoHandle(babcia.lead), state: "delivered" },
        { from: demoHandle(babcia.lead), to: demoHandle(babcia.asking), state: "delivered" },
      ]),
    )
  })

  it("shows a page in the pane beside the seasonal-specials window", () => {
    const { cues, store } = open()
    cues.show()
    const { items } = activeSession(store.getSnapshot())!.state
    expect(items).toMatchObject([
      {
        kind: "page",
        url: "http://localhost:4321/",
        asked: true,
        holder: { terminalId: key(babcia.shows).terminalId },
      },
    ])
  })

  it("ends with every agent of both projects done", async () => {
    const { backend, cues, store } = open()
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(3000)
    for (const project of store.getSnapshot().projects)
      for (const session of project.history)
        for (const terminal of session.state.roster.terminals)
          expect(terminal).toMatchObject({
            agent: { working: false, lastTurn: { outcome: "completed" } },
          })
    expect(backend.seed.projects).toHaveLength(2)
  })

  it("opens the milk bar's screens on their own work, and leaves the other project's to the demo", () => {
    const { backend } = open()
    const [mine, other] = backend.seed.projects
    const at = (project: typeof mine, number: number) => ({
      projectId: project!.id,
      workspaceSessionId: "initial",
      terminalId: project!.sessions[0]!.terminals[number - 1]!.id,
    })
    for (const number of [1, 2, 3])
      expect(
        babciaIntroOf(mine!.sessions[0]!.terminals[number - 1]!, at(mine, number)),
      ).toBeDefined()
    expect(babciaIntroOf(other!.sessions[0]!.terminals[0]!, at(other, 1))).toBeUndefined()
  })
})
