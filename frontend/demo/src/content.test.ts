import { itemIdOf } from "@novadeck/core/companion"
import type { ChatAnswer, ChatDialog } from "@novadeck/core/conversation"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { createWorkspaceStore } from "@novadeck/core/store"
import type { AgentStatus } from "@novadeck/core/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { answerMs, answeredMs } from "./chat"
import { demoTerminalId } from "./samples"
import { authAgent, studioAgent } from "./showcase/agents"
import { demoTurns, demoTurnMs } from "./turns"
import { createDemo } from "./variants"

const session = { projectId: "studio", workspaceSessionId: "initial" }
const key = (slot: number) => ({ ...session, terminalId: demoTerminalId(session, slot) })

const open = () => {
  const turns = demoTurns()
  const backend = createDemo("showcase", undefined, turns)
  const store = createWorkspaceStore(
    workspaceFromSeed(backend.seed, { view: "grid", windowedView: "grid", now: 0 }),
    backend.commit,
  )
  backend.commit(store.getSnapshot(), [])
  backend.start!({ dispatch: (actions) => store.transact(actions as never), open: () => {} })
  const agent = (at: ReturnType<typeof key>): AgentStatus | undefined => {
    const terminal = store
      .getSnapshot()
      .projects.find((project) => project.id === at.projectId)
      ?.history.find((each) => each.id === at.workspaceSessionId)
      ?.state.roster.terminals.find((each) => each.id === at.terminalId)
    return terminal?.state === "running" ? terminal.agent : undefined
  }
  const chat = backend.conversations!
  const requests = (at: ReturnType<typeof key>) => chat.conversation(at).getSnapshot().requests
  // Answers the request that waits, and lets the answer reach the agent. "last" is the
  // option that keeps planning.
  const answer = async (at: ReturnType<typeof key>, picked: string, text?: string) => {
    const request = requests(at)[0]!
    const options = (request.dialog as Extract<ChatDialog, { type: "choices" }>).options
    const option = picked === "last" ? options.at(-1)!.id : picked
    const dialog = request.dialog as { id: string }
    const answering = chat.answer(at, request.id, {
      type: "choice",
      dialog: dialog.id,
      option,
      ...(text ? { text } : {}),
    } satisfies ChatAnswer)
    await vi.advanceTimersByTimeAsync(answerMs + answeredMs)
    await answering
  }
  return { turns, backend, agent, chat, requests, answer }
}

const plans = [
  ["Build Studio", 1],
  ["Refactor auth", 3],
] as const

describe("the content demo", () => {
  it("is marked as the demo, though it has no Source to show", () => {
    const backend = createDemo("showcase", undefined, demoTurns())
    expect(backend.demo).toBe(true)
    expect(backend.source).toBeUndefined()
  })
})

describe("the content demo's plans", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  describe.each(plans)("%s", (_, slot) => {
    it("comes back to a plan to approve once the revision ends, whatever the words", async () => {
      const { agent, requests, answer } = open()
      expect(agent(key(slot))).toMatchObject({ attention: { kind: "plan" } })
      // "y" with the declining option is notes, not an approval.
      await answer(key(slot), "last", "y")
      await vi.advanceTimersByTimeAsync(demoTurnMs + 2000)
      expect(agent(key(slot))).toMatchObject({
        working: true,
        planning: true,
        attention: { kind: "plan", count: 1 },
      })
      expect(requests(key(slot))).toHaveLength(1)
      expect(requests(key(slot))[0]!.kind).toBe("plan")
      // Declining again with words brings it back again; approving it ends the asking.
      await answer(key(slot), "last", "make it shorter")
      await vi.advanceTimersByTimeAsync(demoTurnMs + 2000)
      expect(agent(key(slot))).toMatchObject({ attention: { kind: "plan" } })
      await answer(key(slot), "1")
      expect(agent(key(slot))?.attention).toBeUndefined()
    })

    it.each(["make it shorter", "show me the plan again"])(
      "asks again with a dialog that takes words, after notes such as %j",
      async (words) => {
        const { agent, requests, answer, chat } = open()
        await answer(key(slot), "last", "tighten it")
        await vi.advanceTimersByTimeAsync(demoTurnMs + 2000)
        const again = requests(key(slot))[0]!
        const options = (again.dialog as Extract<ChatDialog, { type: "choices" }>).options
        // The dialog is the agent's own: its declining option takes words.
        expect(options.at(-1)?.text).not.toBeNull()
        await answer(key(slot), "last", words)
        await vi.advanceTimersByTimeAsync(demoTurnMs + 2000)
        expect(agent(key(slot))).toMatchObject({ attention: { kind: "plan" } })
        expect(
          chat
            .conversation(key(slot))
            .getSnapshot()
            .items.some((item) => item.role === "user" && item.text === words),
        ).toBe(true)
      },
    )

    it("is not told yes after a Stop while its answer showed as answered", async () => {
      const { backend, chat, requests, agent } = open()
      const sample = slot === 1 ? studioAgent : authAgent
      const stamps: string[] = []
      backend.companions!.follow(
        session,
        itemIdOf(sample.plan.id),
        { reveal: false },
        (content) => content.state === "ready" && stamps.push(content.stamp),
      )
      const request = requests(key(slot))[0]!
      const answering = chat.answer(key(slot), request.id, {
        type: "choice",
        dialog: (request.dialog as { id: string }).id,
        option: "1",
      })
      const outcome = answering.then(
        () => "went through",
        (error: Error) => error.message,
      )
      await vi.advanceTimersByTimeAsync(answerMs + 100)
      await chat.interrupt(key(slot))
      await vi.advanceTimersByTimeAsync(answeredMs)
      expect(await outcome).toContain("moved on")
      expect(agent(key(slot))).toMatchObject({ lastTurn: { outcome: "interrupted" } })
      // Still at its plan prompt, so words from the person still have it revise the plan.
      const before = stamps.length
      await chat.send(key(slot), "tighten the first step")
      await vi.advanceTimersByTimeAsync(demoTurnMs + 2000)
      expect(stamps.length).toBeGreaterThan(before)
    })

    it("is not told yes to a plan by an answer to some other request", async () => {
      const { turns, backend, chat, requests } = open()
      const sample = slot === 1 ? studioAgent : authAgent
      const stamps: string[] = []
      backend.companions!.follow(
        session,
        itemIdOf(sample.plan.id),
        { reveal: false },
        (content) => content.state === "ready" && stamps.push(content.stamp),
      )
      turns.ask(key(slot), undefined, "permission", 1)
      const request = requests(key(slot))[0]!
      expect(request.kind).toBe("permission")
      const answering = chat.answer(key(slot), request.id, {
        type: "choice",
        dialog: (request.dialog as { id: string }).id,
        option: "1",
      })
      await vi.advanceTimersByTimeAsync(answerMs + answeredMs)
      await answering
      await vi.advanceTimersByTimeAsync(demoTurnMs)
      const before = stamps.length
      await chat.send(key(slot), "tighten the first step")
      await vi.advanceTimersByTimeAsync(demoTurnMs + 2000)
      expect(stamps.length).toBeGreaterThan(before)
    })
  })

  // Refactor auth's agent has no skill: it applies the notes left in its plan only when
  // asked to re-read it, which a decline is the one way to ask while its plan waits.
  it("applies the notes once a decline asks Refactor auth to re-read its plan", async () => {
    const { backend, agent, answer } = open()
    const note = "<!-- novadeck: Keep the session cookie. -->"
    let text = ""
    let stamp = ""
    backend.companions!.follow(
      session,
      itemIdOf(authAgent.plan.id),
      { reveal: false },
      (content) => {
        if (content.state !== "ready") return
        text = (content.content as { text: string }).text
        stamp = content.stamp
      },
    )
    await vi.advanceTimersByTimeAsync(10)
    await backend.companions!.save(session, itemIdOf(authAgent.plan.id), text + note, stamp)
    expect(text).toContain(note)
    await answer(key(3), "last", "please re-read the plan")
    await vi.advanceTimersByTimeAsync(demoTurnMs + 3000)
    expect(text).not.toContain(note)
    // And the plan, with the notes applied, waits on the person again.
    expect(agent(key(3))?.attention).toMatchObject({ kind: "plan", count: 1 })
  })
})
