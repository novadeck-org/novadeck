import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { workspaceFromSeed } from "../../../model/seed"
import { createWorkspaceStore } from "../../../model/store"
import { createDemoEngine } from "../engine"
import { demoBackend, withConversations } from "../index"
import { demoTerminalId } from "../samples"
import { agentTranscripts } from "../transcripts"
import { demoTurns } from "../turns"
import {
  reviewBusyMs,
  reviewLullMs,
  reviewRestMs,
  serverEveryMs,
  testsEveryMs,
  visitorAmbient,
} from "./ambient"
import { visitorSeed } from "./seed"
import { visitorStory } from "./story"

const session = { projectId: "storefront", workspaceSessionId: "initial" }
const codex = { ...session, terminalId: demoTerminalId(session, 4) }

// The visitor's desk with what goes on by itself, running against a workspace store.
const open = () => {
  const turns = demoTurns(1000)
  const story = visitorStory(agentTranscripts(Date.now()), turns, 2000)
  const life = visitorAmbient(turns)
  const base = demoBackend(
    createDemoEngine(),
    false,
    life.introOf,
    undefined,
    visitorSeed(Date.now()),
  )
  const backend = life.wrap(story.wrap(withConversations(base, story.transcripts, turns)))
  const store = createWorkspaceStore(
    workspaceFromSeed(backend.seed, { view: "focus", windowedView: "grid", now: 0 }),
    backend.commit,
  )
  backend.commit(store.getSnapshot(), [])
  const stop = backend.start!({
    dispatch: (actions) => store.transact(actions as never),
    open: () => {},
  })
  const agent = () => {
    const state = store.getSnapshot().projects.find((project) => project.id === "storefront")!
      .history[0]!.state
    const found = state.roster.terminals.find((each) => each.id === codex.terminalId)
    return found?.state === "running" ? found.agent : undefined
  }
  return { agent, stop, turns, store }
}

const hide = (hidden: boolean): void => {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden })
}

describe("what goes on at the visitor's desk by itself", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    hide(false)
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("has Codex's subagents look into something, finish and come back, asking nothing", async () => {
    const { agent } = open()
    expect(agent()).toEqual({ working: true })
    await vi.advanceTimersByTimeAsync(reviewRestMs)
    expect(agent()?.subagents?.length).toBeGreaterThan(0)
    expect(agent()?.attention).toBeUndefined()
    await vi.advanceTimersByTimeAsync(reviewBusyMs)
    expect(agent()).toEqual({ working: true })
    await vi.advanceTimersByTimeAsync(reviewLullMs)
    expect(agent()?.subagents?.length).toBeGreaterThan(0)
  })

  it("leaves Codex alone once it asks or ends", async () => {
    const { agent, turns, store } = open()
    const terminal = store
      .getSnapshot()
      .projects.find((project) => project.id === "storefront")!
      .history[0]!.state.roster.terminals.find((each) => each.id === codex.terminalId)
    turns.ask(codex, terminal, "permission", 1)
    await vi.advanceTimersByTimeAsync(reviewRestMs + reviewBusyMs + reviewLullMs)
    expect(agent()?.attention).toMatchObject({ kind: "permission" })
    expect(agent()?.subagents).toBeUndefined()
  })

  it("waits while the page is hidden", async () => {
    const { agent } = open()
    hide(true)
    await vi.advanceTimersByTimeAsync(reviewRestMs * 4)
    expect(agent()).toEqual({ working: true })
    hide(false)
    await vi.advanceTimersByTimeAsync(reviewRestMs)
    expect(agent()?.subagents?.length).toBeGreaterThan(0)
  })

  it("stops with the backend", async () => {
    const { agent, stop } = open()
    stop()
    await vi.advanceTimersByTimeAsync(reviewRestMs + serverEveryMs + testsEveryMs)
    expect(agent()).toEqual({ working: true })
  })

  it("does nothing where the visitor asked for less motion", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") }))
    const { agent } = open()
    await vi.advanceTimersByTimeAsync(reviewRestMs * 3)
    expect(agent()).toEqual({ working: true })
  })
})
