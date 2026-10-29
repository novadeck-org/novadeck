import { agentContext } from "@novadeck/core/agent-steps"
import type { InboxRow } from "@novadeck/core/inbox"
import { orderedTiles } from "@novadeck/core/roster"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { activeSession } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { answerMs, answeredMs } from "./chat"
import { demoHandle } from "./handles"
import { isDemoInbox } from "./inbox"
import { createLaunch, launch, launchCuesOf, launchTranscripts } from "./launch"
import { isDemoMessages } from "./messages"
import { demoTerminalId } from "./samples"
import { demoTurns } from "./turns"
import { createDemo } from "./variants"

const shop = { projectId: "northwind", workspaceSessionId: "initial" }
const key = (number: number) => ({ ...shop, terminalId: demoTerminalId(shop, number) })

// The launch demo, opened on the Canvas as its video shows it, its Inbox bound to the
// workspace, as the app binds it.
const open = () => {
  const turns = demoTurns()
  const backend = createDemo("launch", undefined, turns)
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
  return { backend, store, inbox, cues, terminals, agent, items, turns }
}

describe("the launch demo", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("opens on the storefront's project, eight agents of all three harnesses at work, and a second project", () => {
    const { backend } = open()
    const [first, second] = backend.seed.projects
    expect(first?.id).toBe("northwind")
    expect(second?.id).toBe("northwind-docs")
    const terminals = first!.sessions[0]!.terminals
    expect(terminals).toHaveLength(8)
    // The two no cue acts on are left off the deck, and the cues' agents are all on it.
    for (const number of [3, 6])
      expect(terminals.map((terminal) => terminal.id)).not.toContain(key(number).terminalId)
    // (the teammates, 11 to 13, come when the lead opens them)
    for (const number of Object.values(launch).filter((each) => each <= 10))
      expect(terminals.map((terminal) => terminal.id)).toContain(key(number).terminalId)
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
    const { introOf } = createLaunch(demoTurns(), 0)
    const [mine, other] = backend.seed.projects
    const at = (project: typeof mine, number: number) => ({
      projectId: project!.id,
      workspaceSessionId: "initial",
      terminalId: project!.sessions[0]!.terminals[number - 1]!.id,
    })
    expect(introOf(mine!.sessions[0]!.terminals[0]!, at(mine, 1))).toBeDefined()
    expect(introOf(other!.sessions[0]!.terminals[0]!, at(other, 1))).toBeUndefined()
  })

  it("has the agents at work print more as it goes, and the ones that ended or ask stop", async () => {
    const launched = createLaunch(demoTurns(), 0)
    // The demo's own Backend is not needed: only what the launch wraps, its commit and start.
    const under = launched.under({
      commit: () => {},
      start: () => () => {},
    } as never)
    const workspace = workspaceFromSeed(under.seed, {
      view: "canvas",
      windowedView: "canvas",
      now: 0,
    })
    const commit = (agent: (number: number) => object) =>
      under.commit(
        {
          ...workspace,
          projects: workspace.projects.map((project) => ({
            ...project,
            history: project.history.map((each) => ({
              ...each,
              state: {
                ...each.state,
                roster: {
                  ...each.state.roster,
                  terminals: each.state.roster.terminals.map((terminal) => ({
                    ...terminal,
                    agent: agent(Number(terminal.id.slice(-2))),
                  })),
                },
              },
            })),
          })),
        } as never,
        [],
      )
    commit(() => ({ working: true }))
    const stop = under.start!({ dispatch: () => {}, open: () => {} })
    const terminal = (number: number) =>
      under.seed.projects[0]!.sessions[0]!.terminals.find(
        (each) => each.id === key(number).terminalId,
      )!
    const screen = (number: number): string => {
      const blocks = launched.introOf(terminal(number), key(number))!.getSnapshot()
      return blocks
        .flatMap((block) => block(80))
        .map((line) => line.map((part) => part.text).join(""))
        .join("\n")
    }
    const cart = screen(launch.question)
    const server = screen(launch.shows)
    await vi.advanceTimersByTimeAsync(3100)
    // A count climbs in place; a log grows by lines.
    expect(screen(launch.question)).not.toBe(cart)
    expect(screen(launch.question)).toContain("Built 18 of 96 routes")
    expect(screen(launch.shows).length).toBeGreaterThan(server.length)
    // One that waits on the person, or ended its turn, prints no more.
    commit((number) => (number === launch.question ? { working: false } : { working: true }))
    const held = screen(launch.question)
    await vi.advanceTimersByTimeAsync(3100)
    expect(screen(launch.question)).toBe(held)
    // Back at work after its question, it prints no more under it, while the others go on.
    commit(() => ({ working: true }))
    launchCuesOf(launched.over(under))!.question()
    const asked = screen(launch.question)
    const going = screen(launch.shows)
    await vi.advanceTimersByTimeAsync(3100)
    expect(screen(launch.question)).toBe(asked)
    expect(screen(launch.shows)).not.toBe(going)
    // Nothing ticks once the demo stops.
    stop()
    const stopped = screen(launch.shows)
    await vi.advanceTimersByTimeAsync(3100)
    expect(screen(launch.shows)).toBe(stopped)
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
    expect(terminals()).toHaveLength(11)
    const lead = terminals().find((each) => each.id === key(launch.lead).terminalId)!
    const teammates = terminals().slice(8)
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
    expect(terminals()).toHaveLength(11)
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
        for (const { id, from, to, state, text } of thread.messages)
          if (from.kind === "agent" && to.kind === "agent")
            seen.set(id, { from: from.handle, to: to.handle, state, text })
    return [...seen.values()]
  }
  const lead = demoHandle(launch.lead)
  const asking = demoHandle(launch.asking)

  it("has one agent ask another for a review, and the reviewer answer, by message", async () => {
    const { backend, cues } = open()
    cues.askReview()
    cues.askReview()
    await vi.advanceTimersByTimeAsync(10_000)
    const asks = demoHandle(launch.reviews)
    const reviews = demoHandle(launch.reviewer)
    expect(exchange(backend).map(({ from, to, state }) => ({ from, to, state }))).toEqual([
      { from: asks, to: reviews, state: "delivered" },
      { from: reviews, to: asks, state: "delivered" },
    ])
  })

  it("wakes no one with the review once everyone finished, and sends no answer then", async () => {
    const { backend, cues, agent } = open()
    cues.askReview()
    // The ask has landed; the ripple runs before the reviewer answers.
    await vi.advanceTimersByTimeAsync(1000)
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(exchange(backend)).toHaveLength(1)
    expect(agent(launch.reviews)).toMatchObject({ working: false })
    expect(agent(launch.reviewer)).toMatchObject({ working: false })
  })

  it("opens teammates its lead opened and briefed, on the doorbell's notice, not the person's words", async () => {
    const { backend, cues, terminals } = open()
    cues.teammates()
    const teammates = terminals().slice(8)
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
    // Still open while the lead has not answered, which the video holds on for a while: no answer
    // before about 8 s.
    expect(items()[0]).not.toHaveProperty("settled")
    await vi.advanceTimersByTimeAsync(4600)
    expect(items()[0]).not.toHaveProperty("settled")
    expect(
      exchange(backend).filter(
        (each) =>
          each.from === lead && each.to === asking && each.text.startsWith("The storefront"),
      ),
    ).toEqual([])
    await vi.advanceTimersByTimeAsync(2600)
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

  it("holds the teammate and its lead through finishAll, and ends both once the exchange settles", async () => {
    const { backend, cues, agent, items } = open()
    cues.teammates()
    cues.teammateAsks()
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(3000)
    expect(agent(launch.asking)).not.toHaveProperty("lastTurn")
    expect(agent(launch.lead)).not.toHaveProperty("lastTurn")
    // The others ended, the other teammates reporting to their lead.
    expect(agent(1)).toMatchObject({ lastTurn: { outcome: "completed" } })
    // The lead answers, the ask is withdrawn, and both end.
    await vi.advanceTimersByTimeAsync(8000)
    expect(items().find((item) => item.kind === "ask")).toMatchObject({
      settled: { how: "withdrawn" },
    })
    for (const number of [launch.asking, launch.lead])
      expect(agent(number)).toMatchObject({ working: false, lastTurn: { outcome: "completed" } })
    // The cart endpoint reported to its lead as it finished.
    expect(
      exchange(backend).filter(
        (each) => each.from === asking && each.to === lead && each.text.startsWith("Done."),
      ),
    ).toHaveLength(1)
  })

  it("ends the lead only after its teammates' reports reached it", async () => {
    const { backend, cues, agent } = open()
    cues.teammates()
    await vi.advanceTimersByTimeAsync(4000)
    cues.finishAll()
    const ended = (number: number) => agent(number)?.lastTurn !== undefined
    let steps = 0
    // What the teammates had done when the lead ended: all three, ahead of it.
    let before: boolean[] = []
    while (!ended(launch.lead) && steps++ < 100) {
      // eslint-disable-next-line no-await-in-loop -- Time moves on a little at a time.
      await vi.advanceTimersByTimeAsync(50)
      before = [11, 12, 13].map(ended)
    }
    expect(before).toEqual([true, true, true])
    expect(agent(launch.lead)).toMatchObject({ lastTurn: { outcome: "completed" } })
    const reports = exchange(backend).filter(
      (each) => each.to === lead && each.text.startsWith("Done."),
    )
    expect(reports).toHaveLength(3)
    expect(reports.every((each) => each.state === "delivered")).toBe(true)
  })

  it("has a teammate report done to the person and to its lead as a message, which rings the lead", async () => {
    const { backend, cues, agent, items } = open()
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
    // And the report is its `done` too: a done mark and an Update row.
    expect(agent(launch.reports)).toMatchObject({ reported: true })
    expect(items()).toMatchObject([{ kind: "update", source: { title: "Pricing endpoint" } }])
  })

  it("does nothing twice, nor before it can, nor after everyone finished", async () => {
    const { cues, items, terminals, store } = open()
    // Before the teammates are open.
    cues.teammateAsks()
    cues.teammateDone()
    expect(items()).toEqual([])
    expect(terminals()).toHaveLength(8)
    cues.teammates()
    cues.teammates()
    expect(terminals()).toHaveLength(11)
    cues.teammateAsks()
    cues.teammateAsks()
    expect(items()).toHaveLength(1)
    cues.show()
    cues.show()
    cues.showChanges()
    cues.showChanges()
    cues.showVariants()
    cues.showVariants()
    expect(activeSession(store.getSnapshot())!.state.items).toHaveLength(3)
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

  it("gives the asking agent the steps its Inbox sheet lists above the ask", () => {
    const transcript = launchTranscripts(0)[String(launch.permission).padStart(2, "0")]!
    expect(agentContext("claude", transcript.items)).toMatchObject({
      said: { text: "Cover the checkout with end-to-end tests." },
      steps: [
        { kind: "edit", tool: "Write", arg: "…/northwind/e2e/checkout.spec.ts", result: "+5" },
        {
          kind: "edit",
          tool: "Edit",
          arg: "…/projects/northwind/playwright.config.ts",
          result: "+1 −1",
        },
        { kind: "run", tool: "Bash", arg: "pnpm typecheck", result: "Done in 3.2s" },
      ],
    })
  })

  it("shows the plan's agent's plan, rendered, beside its window", () => {
    const { cues, store } = open()
    cues.showPlan()
    cues.showPlan()
    const { items } = activeSession(store.getSnapshot())!.state
    expect(items).toMatchObject([
      {
        kind: "plan",
        name: "Order emails",
        holder: { terminalId: key(launch.plan).terminalId },
        plan: { agent: "Claude Code", role: "root", source: "file" },
      },
    ])
  })

  it("shows no plan once its agent asks for the plan's approval instead", () => {
    const { cues, store } = open()
    cues.plan()
    cues.showPlan()
    expect(activeSession(store.getSnapshot())!.state.items).toEqual([])
  })

  it("takes the person to the plan's window first, so its plan opens there", () => {
    const { cues, store } = open()
    const went: string[] = []
    cues.showPlan((to) => {
      went.push(to.terminalId)
      store.transact([{ type: "terminal/select", target: shop, terminalId: to.terminalId }])
    })
    const planned = key(launch.plan).terminalId
    expect(went).toEqual([planned])
    const state = activeSession(store.getSnapshot())!.state
    expect(state.waiting).toEqual([])
    expect(state.bars[planned]).toMatchObject({ open: true })
  })

  it("takes the person to the order-status window first, so what it shows opens there", () => {
    const { cues, store } = open()
    const went: string[] = []
    const goThere = (to: ReturnType<typeof key>) => {
      went.push(to.terminalId)
      store.transact([{ type: "terminal/select", target: shop, terminalId: to.terminalId }])
    }
    cues.show(goThere)
    cues.showChanges(goThere)
    cues.showVariants(goThere)
    const shows = key(launch.shows).terminalId
    expect(went).toEqual([shows, shows, shows])
    const state = activeSession(store.getSnapshot())!.state
    expect(state.selected).toBe(shows)
    expect(state.waiting).toEqual([])
    expect(state.bars[shows]).toMatchObject({ open: true })
    // Shown once each: a cue pressed again goes nowhere.
    cues.show(goThere)
    expect(went).toHaveLength(3)
  })

  it("shows the page, then its button's variants, as a screenshot beside the order-status window", () => {
    const { cues, store } = open()
    cues.show()
    cues.showVariants()
    const { items } = activeSession(store.getSnapshot())!.state
    expect(items).toMatchObject([
      { kind: "page", holder: { terminalId: key(launch.shows).terminalId } },
      {
        kind: "image",
        name: "track-button.png",
        holder: { terminalId: key(launch.shows).terminalId },
      },
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

describe("the launch demo's teammates cue", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("opens nobody once the lead has ended its turn some other way", () => {
    const { cues, terminals, agent, turns } = open()
    turns.interrupt(key(launch.lead), agent(launch.lead)!)
    expect(agent(launch.lead)).toMatchObject({ working: false })
    cues.teammates()
    expect(terminals()).toHaveLength(8)
  })
})

describe("the launch demo's finishing", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const reportsOf = (backend: ReturnType<typeof open>["backend"]) => {
    const { messages } = backend
    if (!isDemoMessages(messages)) throw new Error("the demo's messages")
    const seen = new Map<string, { from: string; to: string }>()
    for (const each of Object.values(messages.state.getSnapshot().terminals))
      for (const thread of each.threads)
        for (const { id, from, to, text } of thread.messages)
          if (
            from.kind === "agent" &&
            to.kind === "agent" &&
            to.handle === demoHandle(launch.lead) &&
            text.startsWith("Done.")
          )
            seen.set(id, { from: from.handle, to: to.handle })
    const count: Record<string, number> = {}
    for (const each of seen.values()) count[each.from] = (count[each.from] ?? 0) + 1
    return count
  }
  const once = Object.fromEntries([11, 12, 13].map((number) => [demoHandle(number), 1]))

  it("ends the lead in its own place in the ripple when it has no teammates", async () => {
    const { cues, agent } = open()
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(300)
    expect(agent(1)).toMatchObject({ lastTurn: { outcome: "completed" } })
    // The tenth of ten, after nine others: not at the first one's moment.
    expect(agent(launch.lead)).not.toHaveProperty("lastTurn")
    await vi.advanceTimersByTimeAsync(700)
    expect(agent(launch.lead)).toMatchObject({ lastTurn: { outcome: "completed" } })
  })

  it("reports once for each teammate however often 7 is pressed", async () => {
    const { backend, cues } = open()
    cues.teammates()
    await vi.advanceTimersByTimeAsync(4000)
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(400)
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reportsOf(backend)).toEqual(once)
  })

  it("reports once for each teammate when 7 comes before the exchange settles", async () => {
    const { backend, cues, agent } = open()
    cues.teammates()
    await vi.advanceTimersByTimeAsync(4000)
    cues.teammateAsks()
    await vi.advanceTimersByTimeAsync(5500)
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reportsOf(backend)).toEqual(once)
    for (const number of [launch.asking, launch.lead])
      expect(agent(number)).toMatchObject({ working: false, lastTurn: { outcome: "completed" } })
  })

  it("does not take a finished teammate back to work with the lead's late answer", async () => {
    const { backend, cues, inbox, items, agent } = open()
    cues.teammates()
    await vi.advanceTimersByTimeAsync(4000)
    cues.teammateAsks()
    inbox.answer(items()[0]!.id, {
      kind: "ask",
      answer: { type: "reply", option: null, text: "v2" },
    })
    await vi.advanceTimersByTimeAsync(3500)
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(reportsOf(backend)).toEqual(once)
    for (const number of [launch.asking, launch.lead])
      expect(agent(number)).toMatchObject({ working: false, lastTurn: { outcome: "completed" } })
  })
})
