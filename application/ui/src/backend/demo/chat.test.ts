import { createElement, useContext } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Conversations } from "../../model/conversation"
import { workspaceFromSeed } from "../../model/seed"
import { activeSession } from "../../model/state"
import { createWorkspaceStore } from "../../model/store"
import { render } from "../../test/render"
import { DemoAgentContext, type DemoAgentLink } from "./agent-link"
import { answerMs, answeredMs } from "./chat"
import { createDemoEngine } from "./engine"
import { demoBackend, withConversations } from "./index"
import { demoSeed, demoTerminalId } from "./samples"
import { agentTranscripts } from "./transcripts"
import { demoTurns, demoTurnMs } from "./turns"

// A sample terminal by its number in the first session, as `"01"`.
const key = (slot: string, projectId = "storefront") => ({
  projectId,
  workspaceSessionId: "initial",
  terminalId: demoTerminalId({ projectId, workspaceSessionId: "initial" }, Number(slot)),
})

const open = (wrap?: (conversations: Conversations) => Conversations) => {
  const turns = demoTurns()
  // What the terminal surface's screens read of the agents, as it provides it.
  let link: DemoAgentLink | undefined
  const capture = (value: DemoAgentLink | undefined): void => {
    link = value
  }
  const Probe = () => {
    capture(useContext(DemoAgentContext))
    return null
  }
  const base = { ...demoBackend(createDemoEngine()), TerminalSurface: Probe }
  const backend = withConversations(
    { ...base, seed: demoSeed(Date.now(), true) },
    agentTranscripts(Date.now()),
    turns,
    wrap,
  )
  const store = createWorkspaceStore(
    workspaceFromSeed(backend.seed, {
      view: "grid",
      windowedView: "grid",
      now: 0,
    }),
    backend.commit,
  )
  render(createElement(backend.TerminalSurface, {} as never)).unmount()
  backend.commit(store.getSnapshot(), [])
  backend.start!({
    dispatch: (actions) => store.transact(actions as never),
    open: () => {},
  })
  const agent = (slot: string) =>
    activeSession(store.getSnapshot())!.state.roster.terminals.find(
      (terminal) => terminal.id === key(slot).terminalId,
    )
  // Sets a terminal's status as the runner would report it.
  const status = (
    slot: string,
    next: { state: "idle" } | { state: "running"; agent: { working: boolean } },
  ) =>
    store.transact([
      {
        type: "terminal/status",
        target: { projectId: "storefront", workspaceSessionId: "initial" },
        terminalId: key(slot).terminalId,
        status: next,
      },
    ] as never)
  const said = (slot: string) =>
    chat
      .conversation(key(slot))
      .getSnapshot()
      .items.filter((item) => item.role === "user")
      .map((item) => item.text)
  const chat = backend.conversations!
  return { chat, agent, status, said, opening: link!.opening, link: link!, turns }
}

describe("demo conversations", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("opens a transcript for each agent and an empty one for any other terminal", () => {
    const { chat } = open()
    expect(chat.conversation(key("01")).getSnapshot()).toMatchObject({
      agent: "claude",
      loaded: true,
    })
    expect(chat.conversation(key("04")).getSnapshot().agent).toBe("codex")
    expect(chat.conversation(key("02")).getSnapshot().agent).toBeNull()
    expect(chat.conversation(key("05")).getSnapshot().agent).toBe("agy")
  })

  it("tells how many items a terminal's conversation opened with", async () => {
    const { chat, opening } = open()
    const items = chat.conversation(key("01")).getSnapshot().items.length
    expect(items).toBeGreaterThan(0)
    expect(opening(key("01"))).toBe(items)
    // A turn adds to the conversation, not to what it opened with.
    await chat.send(key("06"), "More")
    expect(opening(key("06"))).toBe(chat.conversation(key("06")).getSnapshot().items.length - 1)
    // Another project's agents open empty, and a terminal with no agent has none.
    expect(opening(key("01", "api-service"))).toBe(0)
    expect(opening(key("02"))).toBe(0)
  })

  it("keeps each project's terminals apart", async () => {
    const { chat } = open()
    await chat.send(key("06"), "Only here")
    expect(
      chat
        .conversation(key("06"))
        .getSnapshot()
        .items.some((item) => item.text === "Only here"),
    ).toBe(true)
    const other = chat.conversation(key("06", "api-service")).getSnapshot()
    expect(other.items.some((item) => item.text === "Only here")).toBe(false)
    expect(other.session).not.toBe(chat.conversation(key("06")).getSnapshot().session)
  })

  it("holds the kinds of records the chat shows", () => {
    const { chat } = open()
    const items = ["01", "03", "04", "06"].flatMap(
      (id) => chat.conversation(key(id)).getSnapshot().items,
    )
    expect(items.some((item) => item.truncated)).toBe(true)
    expect(items.some((item) => item.role === "agent" && item.author)).toBe(true)
    expect(items.some((item) => item.text.startsWith("Exit code 1"))).toBe(true)
    // Each result pairs with a call.
    for (const item of items.filter((each) => each.kind === "tool-result"))
      expect(items.some((each) => each.kind === "tool-call" && each.call === item.call)).toBe(true)
    expect(chat.conversation(key("04")).getSnapshot().requests[0]).toMatchObject({
      kind: "permission",
      subject: "pnpm test --filter checkout",
    })
  })

  it("answers a prompt with a tool call and a reply as the turn ends", async () => {
    const { chat, agent } = open()
    const conversation = chat.conversation(key("06"))
    const before = conversation.getSnapshot().items.length
    await chat.send(key("06"), "Run the linter")
    const items = () => conversation.getSnapshot().items.slice(before)
    expect(items().map((item) => [item.role, item.text])).toEqual([["user", "Run the linter"]])
    await vi.advanceTimersByTimeAsync(0)
    expect(agent("06")).toMatchObject({ agent: { working: true } })
    await vi.advanceTimersByTimeAsync(demoTurnMs / 2)
    expect(items().map((item) => item.kind)).toEqual(["text", "tool-call", "tool-result"])
    await vi.advanceTimersByTimeAsync(demoTurnMs / 2)
    expect(items().at(-1)).toMatchObject({
      role: "assistant",
      text: "Done: Run the linter. Nothing else changed.",
    })
    expect(agent("06")).toMatchObject({
      agent: {
        working: false,
        background: { agents: 0, tasks: 1 },
        lastTurn: { outcome: "completed" },
      },
    })
  })

  it("takes a prompt for Antigravity as it does for the others", async () => {
    const { chat } = open()
    await chat.send(key("05"), "Run the linter")
    await vi.advanceTimersByTimeAsync(demoTurnMs)
    const items = chat.conversation(key("05")).getSnapshot().items
    expect(items.some((item) => item.tool === "run_command" && item.kind === "tool-call")).toBe(
      true,
    )
    expect(items.at(-1)?.text).toBe("Done: Run the linter. Nothing else changed.")
  })

  it("stops a turn without a reply", async () => {
    const { chat, agent } = open()
    await chat.send(key("06"), "Run the linter")
    await vi.advanceTimersByTimeAsync(0)
    await chat.interrupt(key("06"))
    await vi.advanceTimersByTimeAsync(demoTurnMs * 2)
    expect(agent("06")).toMatchObject({
      agent: { working: false, lastTurn: { outcome: "interrupted" } },
    })
    expect(chat.conversation(key("06")).getSnapshot().items.at(-1)?.role).toBe("user")
  })

  it("clears a pending request when the agent is stopped", async () => {
    const { chat, agent } = open()
    await chat.interrupt(key("04"))
    expect(chat.conversation(key("04")).getSnapshot().requests).toEqual([])
    expect(agent("04")).toMatchObject({
      agent: { working: false, lastTurn: { outcome: "interrupted" } },
    })
  })

  it("tells the person why a prompt can't go", async () => {
    const { chat } = open()
    await expect(chat.send(key("02"), "hello")).rejects.toThrow("No agent is running")
    await expect(chat.send(key("04"), "hello")).rejects.toThrow("waiting for your answer")
  })

  it("queues what is sent while the agent works, and takes it once the turn ends", async () => {
    const { chat, agent } = open()
    const conversation = chat.conversation(key("06"))
    const before = conversation.getSnapshot().items.length
    await chat.send(key("06"), "one")
    await vi.advanceTimersByTimeAsync(0)
    await chat.send(key("06"), "two")
    await chat.send(key("06"), "!git status")
    await chat.send(key("06"), "three")
    const said = () =>
      conversation
        .getSnapshot()
        .items.slice(before)
        .filter((item) => item.role === "user")
        .map((item) => item.text)
    expect(said()).toEqual(["one"])
    // "two" starts the next turn; the shell command and "three" wait behind it.
    await vi.advanceTimersByTimeAsync(demoTurnMs)
    expect(said()).toEqual(["one", "two"])
    expect(agent("06")).toMatchObject({ agent: { working: true } })
    // The shell command runs, and "three" starts the turn after.
    await vi.advanceTimersByTimeAsync(demoTurnMs)
    expect(said()).toEqual(["one", "two", "!git status", "three"])
    await vi.advanceTimersByTimeAsync(demoTurnMs)
    expect(conversation.getSnapshot().items.at(-1)?.text).toBe("Done: three. Nothing else changed.")
  })

  it("takes what waits, in order, once a turn ends however it ends", async () => {
    const { chat, status, said } = open()
    const before = said("03").length
    await chat.send(key("03"), "first")
    // The turn ends without the demo's turns, as the debug panel ends one.
    status("03", { state: "running", agent: { working: false } })
    await chat.send(key("03"), "second")
    await vi.advanceTimersByTimeAsync(0)
    expect(said("03").slice(before)).toEqual(["first"])
    await vi.advanceTimersByTimeAsync(demoTurnMs)
    expect(said("03").slice(before)).toEqual(["first", "second"])
  })

  it("drops what waited for an agent that ended, never giving it to the next", async () => {
    const { chat, status, said } = open()
    await chat.send(key("03"), "stale for the old agent")
    // The agent ends and another starts at once, with no moment between.
    status("03", { state: "idle" })
    status("03", { state: "running", agent: { working: false } })
    await chat.send(key("03"), "fresh")
    await vi.advanceTimersByTimeAsync(demoTurnMs * 3)
    expect(said("03")).not.toContain("stale for the old agent")
    expect(said("03")).toContain("fresh")
  })

  it("gives back what waited behind a turn when it is stopped", async () => {
    const { chat } = open()
    await chat.send(key("03"), "first")
    await chat.send(key("03"), "second")
    expect(await chat.interrupt(key("03"))).toBe("first\nsecond")
    expect(await chat.interrupt(key("03"))).toBeNull()
  })

  it("answers a permission: the request goes, its tool result lands, the turn ends", async () => {
    const { chat, agent } = open()
    const conversation = chat.conversation(key("04"))
    const answering = chat.answer(key("04"), "04:permission", {
      type: "choice",
      dialog: "04:d",
      option: "1",
    })
    await vi.advanceTimersByTimeAsync(answerMs + answeredMs)
    await answering
    expect(conversation.getSnapshot().requests).toEqual([])
    expect(conversation.getSnapshot().items.at(-1)).toMatchObject({
      kind: "tool-result",
      call: "call_04d",
    })
    expect(agent("04")).toMatchObject({ agent: { working: true } })
    await vi.advanceTimersByTimeAsync(demoTurnMs)
    expect(conversation.getSnapshot().items.at(-1)?.role).toBe("assistant")
    expect(agent("04")).toMatchObject({
      agent: { working: false, lastTurn: { outcome: "completed" } },
    })
  })

  it("sends the words of a denial as the agent's next prompt", async () => {
    const { chat } = open()
    const answering = chat.answer(key("04"), "04:permission", {
      type: "choice",
      dialog: "04:d",
      option: "3",
      text: "Use the unit tests only",
    })
    await vi.advanceTimersByTimeAsync(answerMs + answeredMs)
    await answering
    await vi.advanceTimersByTimeAsync(demoTurnMs)
    const items = chat.conversation(key("04")).getSnapshot().items
    expect(
      items.some((item) => item.role === "user" && item.text === "Use the unit tests only"),
    ).toBe(true)
    expect(items.at(-1)?.text).toBe("Done: Use the unit tests only. Nothing else changed.")
  })

  it("answers questions with the labels the person chose", async () => {
    const { chat } = open()
    const answering = chat.answer(key("05"), "05:question", {
      type: "questions",
      dialog: "05:d",
      answers: [
        { question: "checks", options: ["unit", "lint"], text: "Bundle size" },
        { question: "note", options: ["file"] },
      ],
    })
    await vi.advanceTimersByTimeAsync(answerMs + answeredMs)
    await answering
    const conversation = chat.conversation(key("05")).getSnapshot()
    // The others its screen shows stay.
    expect(conversation.requests.map((request) => request.id)).toEqual(["05:form", "05:raw"])
    expect(conversation.items.at(-2)?.text).toBe(
      "User answered: Unit tests, Lint, Bundle size; notes/logging.md",
    )
    // What it says is there too, with no turn behind it.
    expect(conversation.items.at(-1)).toMatchObject({ role: "assistant" })
  })

  it("never reports a status for an agent that reports none", async () => {
    const { chat, agent } = open()
    const before = agent("05")
    const answering = chat.answer(key("05"), "05:question", {
      type: "chat",
      dialog: "05:d",
      text: "What does each check cost?",
    })
    await vi.advanceTimersByTimeAsync(answerMs + answeredMs + demoTurnMs * 2)
    await answering
    expect(agent("05")).toBe(before)
    expect(
      chat
        .conversation(key("05"))
        .getSnapshot()
        .items.some((item) => item.text === "What does each check cost?"),
    ).toBe(false)
  })

  it("refuses a request it has no dialog to answer, or that is gone", async () => {
    const { chat } = open()
    await expect(
      chat.answer(key("05"), "05:raw", { type: "choice", dialog: "04:d", option: "1" }),
    ).rejects.toThrow("Couldn't answer that here")
    await expect(
      chat.answer(key("06"), "nothing", { type: "choice", dialog: "04:d", option: "1" }),
    ).rejects.toThrow("already answered")
    const late = chat
      .answer(key("04"), "04:permission", { type: "choice", dialog: "04:d", option: "1" })
      .then(
        () => "answered",
        (error: Error) => error.message,
      )
    await chat.interrupt(key("04"))
    await vi.advanceTimersByTimeAsync(answerMs + answeredMs)
    expect(await late).toBe("The agent moved on before your answer reached it.")
  })

  it("shows a dialog the chat can't read as it is", () => {
    const { chat } = open()
    const requests = chat.conversation(key("05")).getSnapshot().requests
    expect(requests.find((request) => request.id === "05:raw")?.dialog).toMatchObject({
      type: "raw",
      reason: "unrecognized",
    })
  })

  it("refuses an answer to a dialog that has changed", async () => {
    const { chat } = open()
    await expect(
      chat.answer(key("04"), "04:permission", { type: "choice", dialog: "old", option: "1" }),
    ).rejects.toThrow("The dialog changed")
  })

  it("answers a form with the values it was given", async () => {
    const { chat } = open()
    const answering = chat.answer(key("05"), "05:form", {
      type: "form",
      dialog: "05:f",
      action: "accept",
      values: { target: "api", environment: "production", replicas: 3, dryRun: false },
    })
    await vi.advanceTimersByTimeAsync(answerMs + answeredMs)
    await answering
    const conversation = chat.conversation(key("05")).getSnapshot()
    expect(conversation.requests.map((request) => request.id)).toEqual(["05:question", "05:raw"])
    expect(conversation.items.at(-2)).toMatchObject({ kind: "tool-result", call: "step:9" })
    expect(conversation.items.at(-2)?.text).toContain('"replicas":3')
  })

  it("refuses a message the agent would read as a command or a file pick", async () => {
    const { chat } = open()
    await expect(chat.send(key("06"), "/tmp is full")).rejects.toThrow("can't start with / or !")
    await expect(chat.send(key("06"), "look at @src")).rejects.toThrow("end in an @ or $ mention")
  })

  it("refuses an answer whose words a prompt would read as a command, taking nothing", async () => {
    const { chat } = open()
    await expect(
      chat.answer(key("04"), "04:permission", {
        type: "choice",
        dialog: "04:d",
        option: "3",
        text: "/etc is wrong",
      }),
    ).rejects.toThrow("can't start with / or !")
    expect(chat.conversation(key("04")).getSnapshot().requests).toHaveLength(1)
  })

  describe("an answer on its way", () => {
    // The first and only request 04 holds, answered with "1".
    const answerFirst = (chat: ReturnType<typeof open>["chat"]) =>
      chat
        .answer(key("04"), "04:permission", { type: "choice", dialog: "04:d", option: "1" })
        .catch((error: Error) => error)

    it.each([
      ["Stop", ({ chat }: ReturnType<typeof open>) => chat.interrupt(key("04"))],
      ["Rest", ({ turns, agent }: ReturnType<typeof open>) => turns.rest(key("04"), agent("04"))],
      [
        "Work with planning",
        ({ turns, agent }: ReturnType<typeof open>) =>
          turns.work(key("04"), agent("04"), { planning: true }),
      ],
    ])("is called off by %s while the request shows as answered", async (_name, move) => {
      const view = open()
      const answering = answerFirst(view.chat)
      await vi.advanceTimersByTimeAsync(answerMs + 10)
      await move(view)
      const after = view.agent("04")
      const items = view.chat.conversation(key("04")).getSnapshot().items.length
      await vi.advanceTimersByTimeAsync(answeredMs + demoTurnMs * 2)
      await answering
      // Nothing the answer would do ran: the agent is as the move left it.
      expect(view.agent("04")).toEqual(after)
      expect(view.chat.conversation(key("04")).getSnapshot().items).toHaveLength(items)
    })

    it("is called off by Stop before it reached the agent", async () => {
      const view = open()
      const answering = answerFirst(view.chat)
      await view.chat.interrupt(key("04"))
      await vi.advanceTimersByTimeAsync(answerMs + answeredMs)
      expect(await answering).toMatchObject({
        message: "The agent moved on before your answer reached it.",
      })
    })

    it("is called off by a release, which leaves the request to ask again", async () => {
      const view = open()
      const answering = answerFirst(view.chat)
      await vi.advanceTimersByTimeAsync(answerMs + 10)
      view.turns.release(key("04"))
      const after = view.agent("04")
      await vi.advanceTimersByTimeAsync(answeredMs + demoTurnMs * 2)
      await answering
      expect(view.agent("04")).toBe(after)
      expect(view.chat.conversation(key("04")).getSnapshot().requests).toMatchObject([
        { id: "04:permission", answered: false },
      ])
    })

    it("refuses a second answer to the request, however soon", async () => {
      const { chat } = open()
      const first = answerFirst(chat)
      await expect(answerFirst(chat)).resolves.toMatchObject({
        message: "That request is already answered.",
      })
      await vi.advanceTimersByTimeAsync(answerMs + 10)
      // Marked answered, the agent not yet told.
      await expect(answerFirst(chat)).resolves.toMatchObject({
        message: "That request is already answered.",
      })
      await vi.advanceTimersByTimeAsync(answeredMs)
      expect(await first).toBeUndefined()
      expect(chat.conversation(key("04")).getSnapshot().requests).toEqual([])
    })

    it("lowers the count of several requests and changes nothing else about the agent", async () => {
      const { chat, status, agent } = open()
      const working = {
        working: true,
        planning: true,
        background: { agents: 1, tasks: 2 },
        subagents: [{ id: "sub-1", type: "Explore" }],
        attention: { kind: "permission", count: 2 },
      }
      status("06", { state: "running", agent: working } as never)
      const requests = chat.conversation(key("06")).getSnapshot().requests
      expect(requests).toHaveLength(2)
      const dialog = requests[0]!.dialog!
      const answering = chat.answer(key("06"), requests[0]!.id, {
        type: "choice",
        dialog: dialog.type === "choices" ? dialog.id : "",
        option: "1",
      })
      await vi.advanceTimersByTimeAsync(answerMs + answeredMs)
      await answering
      expect(agent("06")).toMatchObject({
        agent: { ...working, attention: { kind: "permission", count: 1 } },
      })
      expect(chat.conversation(key("06")).getSnapshot().requests).toEqual([requests[1]])
    })

    it("makes each request of several a different one", async () => {
      const { chat, turns, agent } = open()
      turns.ask(key("06"), agent("06"), "permission", 3)
      const requests = chat.conversation(key("06")).getSnapshot().requests
      expect(requests).toHaveLength(3)
      const dialogs = requests.map((request) => request.dialog)
      expect(new Set(requests.map((request) => request.id)).size).toBe(3)
      expect(new Set(requests.map((request) => request.subject)).size).toBe(3)
      expect(
        new Set(dialogs.map((dialog) => (dialog && "id" in dialog ? dialog.id : ""))).size,
      ).toBe(3)
      expect(new Set(dialogs.map((dialog) => JSON.stringify(dialog))).size).toBe(3)
    })
  })

  describe("what waits on the person", () => {
    it("is what a heard agent says it waits on, and nothing for one that says nothing", () => {
      const { chat, agent } = open()
      for (const slot of ["01", "02", "03", "04", "06"]) {
        const attention = (agent(slot) as { agent?: { attention?: { count: number } } })?.agent
          ?.attention
        expect(chat.conversation(key(slot)).getSnapshot().requests, slot).toHaveLength(
          attention?.count ?? 0,
        )
      }
      // Antigravity reports nothing, so its screen shows what it shows.
      expect(
        chat
          .conversation(key("05"))
          .getSnapshot()
          .requests.map((request) => request.id),
      ).toEqual(["05:question", "05:form", "05:raw"])
    })

    it("goes once the agent is cleared of what it asked", () => {
      const { chat, turns, agent } = open()
      turns.rest(key("04"), agent("04"))
      expect(chat.conversation(key("04")).getSnapshot().requests).toEqual([])
    })
  })

  it("drops what was sent to a working agent when it rests", async () => {
    const { chat, turns, agent, said } = open()
    turns.work(key("06"), agent("06"))
    await chat.send(key("06"), "later")
    turns.rest(key("06"), agent("06"))
    await vi.advanceTimersByTimeAsync(demoTurnMs * 3)
    expect(said("06")).not.toContain("later")
    expect(agent("06")).toMatchObject({ agent: { working: false } })
    expect(agent("06")).not.toHaveProperty("agent.lastTurn")
  })

  it("gives the screen the conversations the demo wraps, as the chat has them", async () => {
    const sent: string[] = []
    const { chat, link } = open((conversations) => ({
      ...conversations,
      send: async (at, prompt) => {
        sent.push(prompt)
        await conversations.send(at, prompt)
      },
    }))
    expect(link.conversations).toBe(chat)
    await link.conversations.send(key("06"), "hello")
    expect(sent).toEqual(["hello"])
  })
})
