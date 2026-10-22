import type { InboxItem } from "@novadeck/core/inbox"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { activeSession } from "@novadeck/core/state"
import { createStore, createWorkspaceStore } from "@novadeck/core/store"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { babcia, babciaCuesOf, babciaIntroOf } from "./babcia"
import { answerMs, answeredMs } from "./chat"
import { demoHandle } from "./handles"
import { isDemoInbox } from "./inbox"
import { isDemoMessages, rungMs } from "./messages"
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
          ? { type: "choice" as const, dialog: item.request.dialog.id, option: "2" }
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
      lastTurn: { outcome: "failed", error: "stream disconnected" },
    })
    // The agent said nothing of its own: the error is the harness's, as Codex records it.
    expect(agent(babcia.failing)?.lastTurn?.reply).toBeUndefined()
    // The app marks a finish the person didn't see.
    unread.update(() => ({ "bar-mleczny/initial": { [key(babcia.failing).terminalId]: "failed" } }))
    expect(items()).toMatchObject([
      {
        kind: "trouble",
        source: { title: "Prices table" },
        trouble: { type: "failed", error: "stream disconnected" },
      },
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

  // What of the mail the helper and its lead wrote, in order, as (from, to, state, text).
  const mail = (backend: ReturnType<typeof open>["backend"]) => {
    const { messages } = backend
    if (!isDemoMessages(messages)) throw new Error("the Babcia demo has the demo's messages")
    const seen = new Map<string, { from: string; to: string; state: string; text: string }>()
    for (const each of Object.values(messages.state.getSnapshot().terminals))
      for (const thread of each.threads)
        for (const message of thread.messages)
          if (message.from !== "you" && message.to !== "you") seen.set(message.id, message)
    return [...seen.values()]
  }
  const typed = "How should I know? Ask your sister."
  const asking = demoHandle(babcia.asking)
  const lead = demoHandle(babcia.lead)

  it("has a helper ask what only its lead knows, as the helper's own agent", () => {
    const { cues, items, terminal } = open()
    cues.helpers()
    cues.helperAsks()
    const [ask] = items()
    expect(ask).toMatchObject({
      kind: "ask",
      source: { title: "Orders endpoint" },
      ask: { subject: "Which API does the site call?", shape: { type: "text" } },
    })
    expect(ask?.source.agent).toBe(terminal(babcia.asking)?.process)
  })

  it("has the helper write to its lead only once the person's answer has reached it, of what was typed", async () => {
    const { backend, cues, inbox, items, agent } = open()
    cues.helpers()
    cues.helperAsks()
    inbox.answer(items()[0]!.id, {
      kind: "ask",
      answer: { type: "reply", option: null, text: typed },
    })
    // The answer is on its way and not yet delivered: the helper has said nothing.
    await vi.advanceTimersByTimeAsync(800)
    expect(mail(backend)).toEqual([])
    expect(agent(babcia.lead)).toMatchObject({ working: false })
    // Delivered, the helper writes to its lead, which the doorbell then rings awake.
    await vi.advanceTimersByTimeAsync(2400)
    expect(mail(backend)[0]).toMatchObject({
      from: asking,
      to: lead,
      text: expect.stringContaining(typed),
    })
    await vi.advanceTimersByTimeAsync(rungMs + 50)
    expect(agent(babcia.lead)).toMatchObject({ working: true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(items()).toEqual([])
    expect(mail(backend).map(({ from, to, state }) => ({ from, to, state }))).toEqual([
      { from: asking, to: lead, state: "delivered" },
      { from: lead, to: asking, state: "delivered" },
    ])
    expect(agent(babcia.asking)).toMatchObject({ working: true })
  })

  it("sends nothing to the lead when the person's answer is not delivered", async () => {
    const { backend, cues, inbox, items } = open()
    cues.helpers()
    cues.helperAsks()
    inbox.dropReplyNext()
    inbox.answer(items()[0]!.id, {
      kind: "ask",
      answer: { type: "reply", option: null, text: typed },
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mail(backend)).toEqual([])
  })

  it("relays the helper's answer once, however often its mail changes after it", async () => {
    const { backend, cues, inbox, items } = open()
    cues.helpers()
    cues.helperAsks()
    inbox.answer(items()[0]!.id, {
      kind: "ask",
      answer: { type: "reply", option: null, text: typed },
    })
    await vi.advanceTimersByTimeAsync(10_000)
    const { messages } = backend
    if (!isDemoMessages(messages)) throw new Error("the demo's messages")
    // The mail changes again, as a pause or a release changes it: the delivered answer is still
    // there to be found, and must not be relayed again.
    messages.pause(true)
    await vi.advanceTimersByTimeAsync(300)
    messages.pause(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mail(backend).filter((each) => each.from === asking)).toHaveLength(1)
  })

  it("words the helper's message to its lead for an empty or unpunctuated reply", async () => {
    const texts: string[] = []
    for (const reply of ["", "ask the lead", "Who knows?"]) {
      const { backend, cues, inbox, items } = open()
      cues.helpers()
      cues.helperAsks()
      inbox.answer(items()[0]!.id, {
        kind: "ask",
        answer: { type: "reply", option: null, text: reply },
      })
      // eslint-disable-next-line no-await-in-loop -- Each demo runs on its own.
      await vi.advanceTimersByTimeAsync(5000)
      texts.push(mail(backend).find((each) => each.from === asking)!.text)
    }
    expect(texts).toEqual([
      "Nyx had nothing to add. Do you know which API the site calls? I need it for the orders route.",
      'Nyx\'s answer: "ask the lead". Do you know which API the site calls? I need it for the orders route.',
      'Nyx\'s answer: "Who knows?" Do you know which API the site calls? I need it for the orders route.',
    ])
  })

  it("sends nothing more once the person stops the helper's message to the lead", async () => {
    const { backend, cues, inbox, items, agent } = open()
    cues.helpers()
    cues.helperAsks()
    inbox.answer(items()[0]!.id, {
      kind: "ask",
      answer: { type: "reply", option: null, text: typed },
    })
    // The answer lands at about 2.6 s, then the message waits on the doorbell for 0.8 s.
    await vi.advanceTimersByTimeAsync(3000)
    const { messages } = backend
    if (!isDemoMessages(messages)) throw new Error("the demo's messages")
    const thread = Object.values(messages.state.getSnapshot().terminals)
      .flatMap((each) => each.threads)
      .find((each) => each.messages.some((one) => one.from === asking))!
    messages.stop!(thread.id)
    await vi.advanceTimersByTimeAsync(10_000)
    // The runner adds nothing to the thread, and none of it is the person's.
    const sent = Object.values(messages.state.getSnapshot().terminals)
      .flatMap((each) => each.threads)
      .flatMap((each) => each.messages)
      .filter((one) => one.id.startsWith("t-") && (one.from === "you" || one.to === "you"))
    expect(sent).toEqual([])
    expect(mail(backend).map(({ from, state }) => ({ from, state }))).toEqual([
      { from: asking, state: "gone" },
    ])
    expect(agent(babcia.lead)).toMatchObject({ working: false })
    // Nothing holds the pair any longer, and the thread takes no more.
    expect(
      messages.send(
        { projectId: bar.projectId, workspaceSessionId: bar.workspaceSessionId },
        lead,
        asking,
        "Hi",
        undefined,
        undefined,
      ),
    ).toBe(false)
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(5000)
    for (const number of [babcia.lead, babcia.asking])
      expect(agent(number)).toMatchObject({ lastTurn: { outcome: "completed" } })
  })

  it("does not answer its helper once the person interrupted the lead", async () => {
    const { backend, cues, inbox, items, agent } = open()
    cues.helpers()
    cues.helperAsks()
    inbox.answer(items()[0]!.id, {
      kind: "ask",
      answer: { type: "reply", option: null, text: typed },
    })
    // The lead is rung awake at about 3.4 s, and would answer 1.5 s later.
    await vi.advanceTimersByTimeAsync(3800)
    expect(agent(babcia.lead)).toMatchObject({ working: true })
    await backend.conversations!.interrupt(key(babcia.lead))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mail(backend).filter((each) => each.from === lead)).toEqual([])
    // Nothing holds the pair after it: cue 6 ends the helper's turn too.
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(5000)
    expect(agent(babcia.asking)).toMatchObject({ lastTurn: { outcome: "completed" } })
  })

  it("releases the helper when its ask closes without an answer reaching it", async () => {
    for (const how of ["dropped", "cleared"] as const) {
      const { cues, inbox, items, agent } = open()
      cues.helpers()
      cues.helperAsks()
      if (how === "dropped") {
        inbox.dropReplyNext()
        inbox.answer(items()[0]!.id, {
          kind: "ask",
          answer: { type: "reply", option: null, text: typed },
        })
      } else inbox.clear()
      // eslint-disable-next-line no-await-in-loop -- Each demo runs on its own.
      await vi.advanceTimersByTimeAsync(10_000)
      // It waits at its prompt, as an agent told no does, and cue 6 leaves it; its lead ends.
      expect(agent(babcia.asking)).toMatchObject({ working: false })
      cues.finishAll()
      // eslint-disable-next-line no-await-in-loop -- Each demo runs on its own.
      await vi.advanceTimersByTimeAsync(5000)
      expect(agent(babcia.asking)?.lastTurn).toBeUndefined()
      expect(agent(babcia.lead)).toMatchObject({ lastTurn: { outcome: "completed" } })
    }
  })

  it("leaves the lead alone while its helper's question is open", async () => {
    const { cues, agent } = open()
    cues.helpers()
    cues.helperAsks()
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(5000)
    expect(agent(babcia.lead)).toMatchObject({ working: false })
    expect(agent(babcia.lead)?.lastTurn).toBeUndefined()
    expect(agent(babcia.asking)?.lastTurn).toBeUndefined()
    // The others ended.
    expect(agent(babcia.shows)).toMatchObject({ lastTurn: { outcome: "completed" } })
  })

  it("does not end the turn of an agent the person told no, nor of a failed one", async () => {
    const { backend, cues, agent, items } = open()
    cues.asks()
    cues.fail()
    const chat = backend.conversations!
    const permission = String(babcia.permission).padStart(2, "0")
    const plan = String(babcia.plan).padStart(2, "0")
    const noPermission = chat.answer(key(babcia.permission), `${permission}:permission`, {
      type: "choice",
      dialog: `${permission}:d`,
      option: "3",
    })
    // The plan dialog takes no answer the real one refuses: words need option 3, which needs them.
    await expect(
      chat.answer(key(babcia.plan), `${plan}:plan`, {
        type: "choice",
        dialog: `${plan}:d`,
        option: "3",
      }),
    ).rejects.toThrow("Couldn't answer that here")
    await expect(
      chat.answer(key(babcia.plan), `${plan}:plan`, {
        type: "choice",
        dialog: `${plan}:d`,
        option: "1",
        text: "and add a rollback step",
      }),
    ).rejects.toThrow("Couldn't answer that here")
    await vi.advanceTimersByTimeAsync(answerMs + answeredMs + 500)
    await noPermission
    // The plan still waits, with its request, and cue 6 leaves it open.
    expect(items().filter((item) => item.kind === "request")).toHaveLength(2)
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(5000)
    // Told no, it waits at its prompt with nothing claimed; the failed one stays failed.
    expect(agent(babcia.permission)).toMatchObject({ working: false })
    expect(agent(babcia.permission)?.lastTurn).toBeUndefined()
    expect(agent(babcia.plan)).toMatchObject({ attention: { count: 1 } })
    expect(agent(babcia.plan)?.lastTurn).toBeUndefined()
    expect(agent(babcia.failing)).toMatchObject({ working: false, lastTurn: { outcome: "failed" } })
    const said = chat
      .conversation(key(babcia.permission))
      .getSnapshot()
      .items.map((each) => each.text)
      .join("\n")
    expect(said).not.toContain("tests pass")
    // Prompted again, the failed one is at work, and the next cue 6 ends its turn.
    await chat.send(key(babcia.failing), "Try again, kochanie.")
    await vi.advanceTimersByTimeAsync(10_000)
    expect(agent(babcia.failing)).toMatchObject({ working: true })
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(5000)
    expect(agent(babcia.failing)).toMatchObject({
      working: false,
      lastTurn: { outcome: "completed" },
    })
    expect(agent(babcia.permission)?.lastTurn).toBeUndefined()
  })

  it("lets cue 6 end the turns of agents answered after it was rung", async () => {
    const { backend, cues, agent } = open()
    cues.asks()
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(5000)
    expect(agent(babcia.permission)).toMatchObject({ attention: { count: 1 } })
    const id = String(babcia.permission).padStart(2, "0")
    const answering = backend.conversations!.answer(key(babcia.permission), `${id}:permission`, {
      type: "choice",
      dialog: `${id}:d`,
      option: "1",
    })
    await vi.advanceTimersByTimeAsync(answerMs + answeredMs + 500)
    await answering
    await vi.advanceTimersByTimeAsync(5000)
    expect(agent(babcia.permission)).toMatchObject({ working: true })
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(5000)
    expect(agent(babcia.permission)).toMatchObject({
      working: false,
      lastTurn: { outcome: "completed" },
    })
  })

  it("holds the helper and its lead while the helper's answer is on its way, and ends them after", async () => {
    const { cues, items, inbox, agent } = open()
    cues.helpers()
    cues.helperAsks()
    inbox.answer(items()[0]!.id, {
      kind: "ask",
      answer: { type: "reply", option: null, text: typed },
    })
    // The answer is in flight: neither end of the exchange ends its turn.
    await vi.advanceTimersByTimeAsync(1500)
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(1000)
    expect(agent(babcia.asking)?.lastTurn).toBeUndefined()
    expect(agent(babcia.lead)?.lastTurn).toBeUndefined()
    // The exchange runs out: the lead was rung and answered, the helper works on.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(agent(babcia.lead)).toMatchObject({ working: true })
    expect(agent(babcia.asking)).toMatchObject({ working: true })
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(5000)
    for (const number of [babcia.lead, babcia.asking])
      expect(agent(number)).toMatchObject({ working: false, lastTurn: { outcome: "completed" } })
  })

  it("marks a cue's kind used only when its agent is there to ask", () => {
    const { cues, items, store } = open()
    // No agent to ask yet: the workspace holds none of the demo's terminals.
    store.transact([
      { type: "terminal/close", target: bar, terminalId: key(babcia.permission).terminalId },
    ] as never)
    cues.permission()
    expect(items()).toEqual([])
    expect(activeSession(store.getSnapshot())!.state.roster.terminals).toHaveLength(11)
  })

  it("does nothing twice, nor before it can", async () => {
    const { cues, items, terminals, store, agent } = open()
    // The helper's ask waits for its helpers.
    cues.helperAsks()
    expect(items()).toEqual([])
    cues.helpers()
    cues.helpers()
    expect(terminals()).toHaveLength(15)
    cues.helperAsks()
    cues.helperAsks()
    expect(items()).toHaveLength(1)
    // A failed turn stays failed, however often it is rung, and a page shows once.
    cues.fail()
    await vi.advanceTimersByTimeAsync(500)
    const failed = agent(babcia.failing)
    cues.fail()
    await vi.advanceTimersByTimeAsync(500)
    expect(agent(babcia.failing)).toEqual(failed)
    cues.show()
    const shown = activeSession(store.getSnapshot())!.state.items
    cues.show()
    expect(activeSession(store.getSnapshot())!.state.items).toEqual(shown)
  })

  it("puts the helpers in the desk's frame, at its window size, whatever is selected", () => {
    let layoutOf = (): Record<string, { position: { x: number; y: number } }> => ({})
    const geometry = (select: number | undefined) => {
      const { cues, store, terminals } = open()
      if (select)
        store.transact([
          {
            type: "terminal/select",
            target: bar,
            terminalId: key(select).terminalId,
          },
        ])
      cues.helpers()
      const layout = activeSession(store.getSnapshot())!.state.layout.canvas.geometry
      layoutOf = () => layout
      return terminals()
        .slice(9)
        .map((each) => [each.id, layout[each.id]] as const)
    }
    const first = geometry(undefined)
    expect(geometry(3)).toEqual(first)
    expect(geometry(12)).toEqual(first)
    const [leadAt, ...helperAts] = [first[0], first[3], first[4], first[5]].map((each) => each![1]!)
    expect(helperAts).toHaveLength(3)
    for (const each of helperAts) {
      expect(each).toMatchObject({ width: 550, height: 380 })
      // Within the desk's four columns and rows, to the right of or under the lead.
      expect(each.position.x).toBeLessThan(4 * 610 + 50)
      expect(each.position.y).toBeLessThan(4 * 440 + 50)
      expect(each.position.x >= leadAt!.position.x || each.position.y >= leadAt!.position.y).toBe(
        true,
      )
    }
    // No two windows of the desk lie over each other.
    const all = Object.values(layoutOf())
    const overlaps = all.flatMap((one, at) =>
      all
        .slice(at + 1)
        .filter(
          (other) =>
            Math.abs(one.position.x - other.position.x) < 550 &&
            Math.abs(one.position.y - other.position.y) < 380,
        ),
    )
    expect(overlaps).toEqual([])
  })

  it("leaves the agents still waiting on the person waiting when everyone finishes", async () => {
    const { cues, items, agent } = open()
    cues.asks()
    cues.helpers()
    cues.helperAsks()
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(5000)
    // The three asked agents and the helper that asks hold: nothing ended their turns.
    for (const number of [babcia.permission, babcia.plan, babcia.question])
      expect(agent(number)).toMatchObject({ attention: { count: 1 } })
    expect(agent(babcia.asking)?.lastTurn).toBeUndefined()
    expect(items()).toHaveLength(4)
    // The others ended.
    expect(agent(babcia.shows)).toMatchObject({
      working: false,
      lastTurn: { outcome: "completed" },
    })
  })

  it("ends with the Inbox empty of asks once they are answered: nothing is left to answer", async () => {
    const { cues, items, inbox, agent } = open()
    cues.helpers()
    cues.helperAsks()
    inbox.answer(items()[0]!.id, {
      kind: "ask",
      answer: { type: "reply", option: null, text: typed },
    })
    await vi.advanceTimersByTimeAsync(10_000)
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(5000)
    expect(items().filter((item) => item.kind !== "update")).toEqual([])
    expect(agent(babcia.asking)).toMatchObject({
      working: false,
      lastTurn: { outcome: "completed" },
    })
  })

  it("takes the person's words on a question as the agent's next prompt, picking nothing", async () => {
    const { backend, cues, agent } = open()
    cues.question()
    const chat = backend.conversations!
    const id = String(babcia.question).padStart(2, "0")
    const dialog = chat
      .conversation(key(babcia.question))
      .getSnapshot()
      .requests.find((each) => each.id === `${id}:question`)!.dialog!
    if (dialog.type !== "questions") throw new Error("a question")
    const answering = chat.answer(key(babcia.question), `${id}:question`, {
      type: "chat",
      dialog: dialog.id,
      text: "What are the soups called?",
    })
    await vi.advanceTimersByTimeAsync(answerMs + answeredMs)
    await answering
    await vi.advanceTimersByTimeAsync(10_000)
    const said = chat
      .conversation(key(babcia.question))
      .getSnapshot()
      .items.map((each) => each.text)
      .join("\n")
    expect(said).not.toContain("Going with")
    expect(agent(babcia.question)).toMatchObject({ working: true })
  })

  it("asks Claude Code's own plan dialog, whose third option takes what to change", async () => {
    const { backend, cues, agent } = open()
    cues.plan()
    const chat = backend.conversations!
    const id = String(babcia.plan).padStart(2, "0")
    const [request] = chat.conversation(key(babcia.plan)).getSnapshot().requests
    expect(request?.dialog).toMatchObject({
      type: "choices",
      title: "Ready to code?",
      options: [
        { id: "1", label: "Yes, auto-accept edits", text: null },
        { id: "2", label: "Yes, manually approve edits", text: null },
        { id: "3", label: "Tell Claude what to change", text: "field" },
      ],
    })
    // Its words go on as the agent's next prompt, and it works on them.
    const answering = chat.answer(key(babcia.plan), `${id}:plan`, {
      type: "choice",
      dialog: `${id}:d`,
      option: "3",
      text: "Add a rollback step please",
    })
    await vi.advanceTimersByTimeAsync(answerMs + answeredMs + 500)
    await answering
    await vi.advanceTimersByTimeAsync(10_000)
    expect(agent(babcia.plan)).toMatchObject({ working: true })
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(5000)
    expect(agent(babcia.plan)).toMatchObject({ lastTurn: { outcome: "completed" } })
  })

  it("leaves a failing agent failed when cue 6 follows cue 2 within its pending turn", async () => {
    const { cues, agent } = open()
    cues.fail()
    cues.finishAll()
    await vi.advanceTimersByTimeAsync(5000)
    expect(agent(babcia.failing)).toMatchObject({
      working: false,
      lastTurn: { outcome: "failed", error: "stream disconnected" },
    })
  })

  it("never holds a message between a helper and its lead for release, as the runner does", async () => {
    const { backend, cues } = open()
    cues.helpers()
    const { messages } = backend
    if (!isDemoMessages(messages)) throw new Error("the demo's messages")
    const target = { projectId: bar.projectId, workspaceSessionId: bar.workspaceSessionId }
    // Twenty messages, past the twelve a thread delivers before its release.
    for (let index = 0; index < 20; index += 1) messages.send(target, asking, lead, `Hi ${index}`)
    await vi.advanceTimersByTimeAsync(rungMs + 50)
    expect(mail(backend).every((each) => each.state === "delivered")).toBe(true)
    // Two terminals no lead leads are held at the thirteenth.
    for (let index = 0; index < 14; index += 1)
      messages.send(target, demoHandle(1), demoHandle(2), `Hi ${index}`)
    await vi.advanceTimersByTimeAsync(rungMs + 50)
    expect(
      mail(backend).filter((each) => each.from === demoHandle(1) && each.state === "held"),
    ).toHaveLength(2)
  })

  it("keeps a stopped thread stopped for the length of a thread, or until it is released", async () => {
    const { backend, cues } = open()
    cues.helpers()
    const { messages } = backend
    if (!isDemoMessages(messages)) throw new Error("the demo's messages")
    const target = { projectId: bar.projectId, workspaceSessionId: bar.workspaceSessionId }
    messages.send(target, asking, lead, "Hi")
    const thread = Object.values(messages.state.getSnapshot().terminals)
      .flatMap((each) => each.threads)
      .find((each) => each.messages.some((one) => one.from === asking))!
    messages.stop!(thread.id)
    expect(messages.send(target, lead, asking, "Hello")).toBe(false)
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(messages.send(target, lead, asking, "Hello")).toBe(false)
    messages.release!(thread.id)
    expect(messages.send(target, lead, asking, "Hello")).toBe(true)
    // Left alone, a stop lapses ten minutes after the thread's latest message.
    messages.send(target, demoHandle(1), demoHandle(2), "Hi")
    const other = Object.values(messages.state.getSnapshot().terminals)
      .flatMap((each) => each.threads)
      .find((each) => each.messages.some((one) => one.from === demoHandle(1)))!
    messages.stop!(other.id)
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1000)
    expect(messages.send(target, demoHandle(1), demoHandle(2), "Hi again")).toBe(true)
  })

  it("handles a closed terminal as the runner does: gone if queued for it, refused after, delivered from it", async () => {
    const { backend, cues, store } = open()
    cues.helpers()
    const { messages } = backend
    if (!isDemoMessages(messages)) throw new Error("the demo's messages")
    const target = { projectId: bar.projectId, workspaceSessionId: bar.workspaceSessionId }
    const close = (number: number) =>
      store.transact([
        { type: "terminal/close", target: bar, terminalId: key(number).terminalId },
      ] as never)
    // Queued for the lead, which closes before the doorbell rang: gone at once, its sender told.
    const stopped = vi.fn<() => void>()
    const delivered = vi.fn<() => void>()
    expect(messages.send(target, asking, lead, "Hi", delivered, stopped)).toBe(true)
    close(babcia.lead)
    expect(mail(backend).map((each) => each.state)).toEqual(["gone"])
    expect(stopped).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(rungMs + 50)
    expect(delivered).not.toHaveBeenCalled()
    // A send to it now is refused, and leaves nothing in the thread.
    expect(messages.send(target, asking, lead, "Hello?")).toBe(false)
    expect(mail(backend)).toHaveLength(1)
    // What a closed sender wrote still reaches its recipient.
    const arrived = vi.fn<() => void>()
    expect(
      messages.send(target, demoHandle(babcia.asking + 0), demoHandle(1), "Bye", arrived),
    ).toBe(true)
    close(babcia.asking)
    await vi.advanceTimersByTimeAsync(rungMs + 50)
    expect(arrived).toHaveBeenCalledOnce()
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
