import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { workspaceFromSeed } from "../../model/seed"
import { activeSession } from "../../model/state"
import { createWorkspaceStore } from "../../model/store"
import { answerMs, answeredMs } from "./chat"
import { createDemoEngine } from "./engine"
import { demoBackend, withConversations } from "./index"
import { demoSeed } from "./samples"
import { agentTranscripts } from "./transcripts"
import { demoTurns, demoTurnMs } from "./turns"

const key = (terminalId: string, projectId = "storefront") => ({
  projectId,
  workspaceSessionId: "initial",
  terminalId,
})

const open = () => {
  const turns = demoTurns()
  const base = demoBackend(createDemoEngine(turns.reply))
  const backend = withConversations(
    { ...base, seed: demoSeed(Date.now(), true) },
    agentTranscripts(Date.now()),
    turns,
  )
  const store = createWorkspaceStore(
    workspaceFromSeed(backend.seed, {
      view: "grid",
      windowedView: "grid",
      now: 0,
    }),
    backend.commit,
  )
  backend.commit(store.getSnapshot(), [])
  backend.start!({
    dispatch: (actions) => store.transact(actions as never),
    open: () => {},
  })
  const agent = (terminalId: string) =>
    activeSession(store.getSnapshot())!.state.roster.terminals.find(
      (terminal) => terminal.id === terminalId,
    )
  return { chat: backend.conversations!, agent }
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

  it("keeps each project's terminals apart though their ids repeat", async () => {
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
    await expect(chat.send(key("03"), "hello")).rejects.toThrow("still working")
    await chat.send(key("06"), "one")
    await expect(chat.send(key("06"), "two")).rejects.toThrow("still working")
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
    expect(conversation.requests).toEqual([])
    expect(conversation.items.at(-1)?.text).toBe(
      "User answered: Unit tests, Lint, Bundle size; notes/logging.md",
    )
  })

  it("refuses a request it has no dialog to answer, or that is gone", async () => {
    const { chat } = open()
    await expect(
      chat.answer(key("03"), "03:raw", { type: "choice", dialog: "04:d", option: "1" }),
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
    expect(await late).toBe("That request is already answered.")
  })

  it("shows a dialog the chat can't read as it is", () => {
    const { chat } = open()
    expect(chat.conversation(key("03")).getSnapshot().requests[0]?.dialog).toMatchObject({
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
    const answering = chat.answer(key("06"), "06:form", {
      type: "form",
      dialog: "06:d",
      action: "accept",
      values: { target: "api", environment: "production", replicas: 3, dryRun: false },
    })
    await vi.advanceTimersByTimeAsync(answerMs + answeredMs)
    await answering
    const conversation = chat.conversation(key("06")).getSnapshot()
    expect(conversation.requests).toEqual([])
    expect(conversation.items.at(-1)).toMatchObject({ kind: "tool-result", call: "toolu_06e" })
    expect(conversation.items.at(-1)?.text).toContain('"replicas":3')
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
})
