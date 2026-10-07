import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { workspaceFromSeed } from "../../model/seed"
import { activeSession } from "../../model/state"
import { createWorkspaceStore } from "../../model/store"
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
})
