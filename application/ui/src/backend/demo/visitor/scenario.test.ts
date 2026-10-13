import type { ReactElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"

import type { ChatDialog, Conversations } from "../../../model/conversation"
import { workspaceFromSeed } from "../../../model/seed"
import { createStore } from "../../../model/store"
import type { Workspace } from "../../../model/types"
import type { BackendSink } from "../../port"
import type { DemoAgentLink, DemoAgentVerbs } from "../agent-link"
import { answeredMs, answerMs } from "../chat"
import { demoSeed, demoTerminalId } from "../samples"
import { visitorBeats } from "./beats"
import { answersCheckoutReview, tickingAnswers, visitorDemo } from "./index"
import { playScenario, selectedKey, stillCheckMs, type Beat, type Stage } from "./scenario"

const workspace: Workspace = workspaceFromSeed(demoSeed(0, true), {
  view: "grid",
  windowedView: "grid",
  now: 0,
})
// Every sample project's terminals, by project and number.
const at = (projectId: string, slot: number) => {
  const target = { projectId, workspaceSessionId: "initial" }
  return { ...target, terminalId: demoTerminalId(target, slot) }
}
const selected = selectedKey(workspace)!

const verbs = () => {
  const finish = vi.fn<DemoAgentVerbs["finish"]>()
  return {
    finish,
    all: {
      work: vi.fn<DemoAgentVerbs["work"]>(),
      ask: vi.fn<DemoAgentVerbs["ask"]>(),
      finish,
      rest: vi.fn<DemoAgentVerbs["rest"]>(),
      usage: vi.fn<DemoAgentVerbs["usage"]>(),
      release: vi.fn<DemoAgentVerbs["release"]>(),
    },
  }
}
const finishing: Beat["play"] = (played, key, terminal) => played.finish(key, terminal, "completed")

const stageOf = (all: DemoAgentVerbs, change: Partial<Stage> = {}): Stage => ({
  verbs: all,
  workspace: () => workspace,
  working: () => false,
  still: () => true,
  ...change,
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("the visitor scenario", () => {
  it("plays each beat when it is due", () => {
    const played = verbs()
    playScenario(
      [
        { after: 1000, on: [at("infra", 1)], play: finishing },
        { after: 500, on: [at("docs-site", 1)], play: finishing },
      ],
      stageOf(played.all),
    )

    vi.advanceTimersByTime(999)
    expect(played.finish).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(played.finish).toHaveBeenCalledOnce()
    expect(played.finish.mock.calls[0]![0]).toEqual(at("infra", 1))
    vi.advanceTimersByTime(500)
    expect(played.finish).toHaveBeenCalledTimes(2)
  })

  describe("when a beat's terminal is the one selected", () => {
    it("acts on its next candidate instead", () => {
      const played = verbs()
      playScenario(
        [{ after: 100, on: [selected, at("infra", 1)], play: finishing }],
        stageOf(played.all),
      )

      vi.advanceTimersByTime(100)

      expect(played.finish).toHaveBeenCalledOnce()
      expect(played.finish.mock.calls[0]![0]).toEqual(at("infra", 1))
    })

    it("is skipped when it has no other, and the next beat still plays", () => {
      const played = verbs()
      playScenario(
        [
          { after: 100, on: [selected], play: finishing },
          { after: 100, on: [at("infra", 1)], play: finishing },
        ],
        stageOf(played.all),
      )

      vi.advanceTimersByTime(100)
      expect(played.finish).not.toHaveBeenCalled()
      vi.advanceTimersByTime(100)
      expect(played.finish).toHaveBeenCalledOnce()
    })
  })

  it("leaves a terminal whose turn the person started", () => {
    const played = verbs()
    playScenario(
      [{ after: 100, on: [at("infra", 1)], play: finishing }],
      stageOf(played.all, { working: (key) => key.projectId === "infra" }),
    )

    vi.advanceTimersByTime(100)

    expect(played.finish).not.toHaveBeenCalled()
  })

  it("leaves a terminal the workspace does not hold", () => {
    const played = verbs()
    playScenario([{ after: 100, on: [at("elsewhere", 1)], play: finishing }], stageOf(played.all))

    vi.advanceTimersByTime(100)

    expect(played.finish).not.toHaveBeenCalled()
  })

  describe("while the person interacts", () => {
    it("holds the beat until they are still, then plays it", () => {
      const played = verbs()
      let still = false
      playScenario(
        [{ after: 100, on: [at("infra", 1)], play: finishing }],
        stageOf(played.all, { still: () => still }),
      )

      vi.advanceTimersByTime(100 + 3 * stillCheckMs)
      expect(played.finish).not.toHaveBeenCalled()
      still = true
      vi.advanceTimersByTime(stillCheckMs)
      expect(played.finish).toHaveBeenCalledOnce()
    })
  })

  it("plays nothing once stopped", () => {
    const played = verbs()
    const stop = playScenario(
      [{ after: 100, on: [at("infra", 1)], play: finishing }],
      stageOf(played.all),
    )

    stop()
    vi.advanceTimersByTime(10_000)

    expect(played.finish).not.toHaveBeenCalled()
  })

  it("names only terminals the agents demo has, and stops in a couple of minutes", () => {
    const held = new Set(
      workspace.projects.flatMap((project) =>
        project.history[0]!.state.roster.terminals.map(
          (terminal) => `${project.id}/${terminal.id}`,
        ),
      ),
    )
    for (const beat of visitorBeats)
      for (const key of beat.on) expect(held.has(`${key.projectId}/${key.terminalId}`)).toBe(true)
    expect(visitorBeats.reduce((total, beat) => total + beat.after, 0)).toBeLessThan(180_000)
  })
})

describe("the visitor demo", () => {
  it("offers no chat, voice, agent connections or version", () => {
    const backend = visitorDemo()

    expect(backend.visitor).toBeDefined()
    expect(backend.conversations).toBeUndefined()
    expect(backend.voice).toBeUndefined()
    expect(backend.agents).toBeUndefined()
    expect(backend.version).toBeUndefined()
  })

  it("answers only Checkout review's permission request as the one the hints ask for", () => {
    const review = at("storefront", 4)

    expect(answersCheckoutReview(review, "04:permission")).toBe(true)
    expect(answersCheckoutReview(review, "04:other")).toBe(false)
    expect(answersCheckoutReview(at("storefront", 5), "05:raw")).toBe(false)
    expect(answersCheckoutReview(at("mobile-app", 4), "04:permission")).toBe(false)
  })

  it("ticks the hint for Checkout review's answer and no other", async () => {
    const answered = createStore(false)
    const answer = vi.fn<Conversations["answer"]>(async () => {})
    const reply = { type: "chat", dialog: "d", text: "y" } as const
    const conversations = tickingAnswers(answered)({ answer } as unknown as Conversations)

    await conversations.answer(at("storefront", 5), "05:raw", reply)
    expect(answer).toHaveBeenCalledTimes(1)
    expect(answered.getSnapshot()).toBe(false)
    await conversations.answer(at("storefront", 4), "04:permission", reply)
    expect(answer).toHaveBeenCalledTimes(2)
    expect(answered.getSnapshot()).toBe(true)
  })

  it("ticks the hint when the person answers through the terminal screens' conversations", async () => {
    const backend = visitorDemo()
    backend.commit(workspace, [])
    // The conversations the terminal screens read are the ones the demo composes.
    const element = (backend.TerminalSurface as (props: never) => unknown)(
      {} as never,
    ) as ReactElement<{
      value: DemoAgentLink
    }>
    const { conversations } = element.props.value
    const review = at("storefront", 4)
    const request = conversations
      .conversation(review)
      .getSnapshot()
      .requests.find((each) => each.id === "04:permission")
    expect(request?.dialog?.type).toBe("choices")
    const dialog = request!.dialog as Extract<ChatDialog, { type: "choices" }>

    expect(backend.visitor!.answered.getSnapshot()).toBe(false)
    const answering = conversations.answer(review, "04:permission", {
      type: "choice",
      dialog: dialog.id,
      option: dialog.options[0]!.id,
    })
    await vi.advanceTimersByTimeAsync(answerMs + answeredMs + 1000)
    await answering
    expect(backend.visitor!.answered.getSnapshot()).toBe(true)
  })
})

// The sink's statuses for a terminal: each time an agent verb reached it.
const statuses = (dispatch: Mock<BackendSink["dispatch"]>, key: ReturnType<typeof at>): number =>
  dispatch.mock.calls
    .flatMap(([actions]) => [...actions])
    .filter((action) => action.type === "terminal/status" && action.terminalId === key.terminalId)
    .length

describe("the visitor demo, started", () => {
  // A demo that knows the workspace, with a person on `selecting` if given.
  const started = (selecting?: ReturnType<typeof at>) => {
    const shown: Workspace = selecting
      ? {
          ...workspace,
          activeProjectId: selecting.projectId,
          projects: workspace.projects.map((project) =>
            project.id !== selecting.projectId
              ? project
              : {
                  ...project,
                  history: project.history.map((session) => ({
                    ...session,
                    state: { ...session.state, selected: selecting.terminalId },
                  })),
                },
          ),
        }
      : workspace
    const backend = visitorDemo()
    backend.commit(shown, [])
    const sink = { dispatch: vi.fn<BackendSink["dispatch"]>(), open: vi.fn<BackendSink["open"]>() }
    return { backend, sink, stop: backend.start!(sink) }
  }

  it("lands a beat when it is due", () => {
    const { sink, stop } = started()

    vi.advanceTimersByTime(5900)
    expect(statuses(sink.dispatch, at("design-system", 1))).toBe(0)
    vi.advanceTimersByTime(200)
    expect(statuses(sink.dispatch, at("design-system", 1))).toBeGreaterThan(0)
    stop()
  })

  it("skips the terminal the person has selected", () => {
    const { sink, stop } = started(at("design-system", 1))

    vi.advanceTimersByTime(7000)
    expect(statuses(sink.dispatch, at("design-system", 1))).toBe(0)
    stop()
  })

  it("waits for the person to be still, as the page's own events show it", () => {
    const { sink, stop } = started()

    vi.advanceTimersByTime(5000)
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }))
    vi.advanceTimersByTime(3500)
    expect(statuses(sink.dispatch, at("design-system", 1))).toBe(0)
    vi.advanceTimersByTime(1600)
    expect(statuses(sink.dispatch, at("design-system", 1))).toBeGreaterThan(0)
    stop()
  })

  it("stops listening when stopped", () => {
    const added = vi.spyOn(document, "addEventListener")
    const removed = vi.spyOn(document, "removeEventListener")
    const { stop } = started()
    const listening = added.mock.calls.filter(([type]) =>
      ["pointerdown", "keydown", "wheel"].includes(type),
    )

    stop()
    expect(listening).toHaveLength(3)
    for (const [type, listener] of listening)
      expect(removed.mock.calls.some(([t, l]) => t === type && l === listener)).toBe(true)
  })

  it("keeps one scenario when stopped and started again, as StrictMode does", () => {
    const { backend, sink, stop } = started()
    const one = vi.getTimerCount()

    stop()
    expect(vi.getTimerCount()).toBeLessThan(one)
    const stopAgain = backend.start!(sink)
    expect(vi.getTimerCount()).toBe(one)
    stopAgain()
  })
})
