import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { workspaceFromSeed } from "#core/seed"
import { createWorkspaceStore } from "#core/store"

import { answerMs, answeredMs } from "../chat"
import { createDemoEngine } from "../engine"
import { demoBackend, withConversations } from "../index"
import { demoTerminalId } from "../samples"
import { agentTranscripts } from "../transcripts"
import { demoTurns } from "../turns"
import { visitorSeed } from "./seed"
import { visitorStory } from "./story"

const turnMs = 1000
const nudgeMs = 2000
const session = { projectId: "storefront", workspaceSessionId: "initial" }
const claude = { ...session, terminalId: demoTerminalId(session, 1) }
const codex = { ...session, terminalId: demoTerminalId(session, 4) }

// The visitor's desk running against a workspace store, as the app runs it (see
// `visitorDemo`), with its agents' turns to hand.
const open = (readingMs = 0) => {
  const turns = demoTurns(turnMs)
  const story = visitorStory(agentTranscripts(Date.now()), turns, nudgeMs, readingMs)
  const base = demoBackend(createDemoEngine(), { seed: visitorSeed(Date.now(), readingMs > 0) })
  const backend = story.wrap(withConversations(base, story.transcripts, turns))
  const store = createWorkspaceStore(
    workspaceFromSeed(backend.seed, { view: "focus", windowedView: "grid", now: 0 }),
    backend.commit,
  )
  backend.commit(store.getSnapshot(), [])
  backend.start!({ dispatch: (actions) => store.transact(actions as never), open: () => {} })
  const state = () =>
    store.getSnapshot().projects.find((project) => project.id === "storefront")!.history[0]!.state
  const terminal = (terminalId: string) =>
    state().roster.terminals.find((each) => each.id === terminalId)
  const asks = (terminalId: string) => {
    const found = terminal(terminalId)
    return found?.state === "running" ? found.agent?.attention : undefined
  }
  const chat = backend.conversations!
  // Answers what the agent asks with an option of its dialog, as its screen does.
  const answer = async (key: typeof claude, option: string): Promise<void> => {
    const [request] = chat.conversation(key).getSnapshot().requests
    const dialog = request!.dialog!
    const answering = chat.answer(key, request!.id, {
      type: "choice",
      dialog: "id" in dialog ? dialog.id : "",
      option,
    })
    await vi.advanceTimersByTimeAsync(answerMs + answeredMs)
    await answering
  }
  return { chat, turns, terminal, asks, answer, items: () => state().items }
}

describe("the visitor's story", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("waits on the plan, then shows the page and has Codex ask, then goes quiet", async () => {
    const { asks, answer, items } = open()
    expect(asks(claude.terminalId)).toMatchObject({ kind: "plan" })
    await vi.advanceTimersByTimeAsync(nudgeMs * 3)
    expect(asks(codex.terminalId)).toBeUndefined()

    await answer(claude, "1")
    await vi.advanceTimersByTimeAsync(turnMs)
    expect(items().map((item) => item.name)).toEqual(["order-summary.png"])
    expect(asks(codex.terminalId)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(nudgeMs)
    expect(asks(codex.terminalId)).toMatchObject({ kind: "permission", count: 1 })

    await answer(codex, "1")
    await vi.advanceTimersByTimeAsync(turnMs + nudgeMs * 3)
    expect(asks(claude.terminalId)).toBeUndefined()
    expect(asks(codex.terminalId)).toBeUndefined()
  })

  it("has Claude Code read for a while before it asks for its plan, when the desk opens so", async () => {
    const { asks, terminal } = open(3000)
    expect(asks(claude.terminalId)).toBeUndefined()
    expect(terminal(claude.terminalId)).toMatchObject({ agent: { working: true, planning: true } })
    await vi.advanceTimersByTimeAsync(2900)
    expect(asks(claude.terminalId)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(100)
    expect(asks(claude.terminalId)).toMatchObject({ kind: "plan", count: 1 })
  })

  it("asks no plan of a Claude Code the visitor stopped while it read, and still goes on", async () => {
    const { chat, asks } = open(3000)
    await chat.interrupt(claude)
    await vi.advanceTimersByTimeAsync(3000 + nudgeMs)
    expect(asks(claude.terminalId)).toBeUndefined()
    expect(asks(codex.terminalId)).toMatchObject({ kind: "permission" })
  })

  it("shows no page when the visitor stops the build, and still goes on", async () => {
    const { chat, asks, answer, items } = open()
    await answer(claude, "1")
    await chat.interrupt(claude)
    await vi.advanceTimersByTimeAsync(turnMs + nudgeMs)
    expect(items()).toEqual([])
    expect(asks(codex.terminalId)).toMatchObject({ kind: "permission" })
  })

  it("holds Codex back while another agent asks, and asks once that is dealt with", async () => {
    const { turns, terminal, asks, answer } = open()
    await answer(claude, "1")
    await vi.advanceTimersByTimeAsync(turnMs)
    turns.ask(claude, terminal(claude.terminalId), "question", 1)
    await vi.advanceTimersByTimeAsync(nudgeMs * 2)
    expect(asks(codex.terminalId)).toBeUndefined()
    turns.rest(claude, terminal(claude.terminalId))
    await vi.advanceTimersByTimeAsync(0)
    expect(asks(codex.terminalId)).toMatchObject({ kind: "permission" })
  })
})
