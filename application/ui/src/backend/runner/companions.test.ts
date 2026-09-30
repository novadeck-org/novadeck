import type { AgentDetail, PlanContent } from "@novadeck/protocol"

import type { CompanionEvent, CompanionKey } from "../../model/companion"
import { context, describe, expect, it } from "../../test"
import { createRunnerCompanions, revisionOf } from "./companions"

// A stream the test feeds, as the runner's subscriptions would.
const channel = <T>() => {
  const queued: T[] = []
  let wake: (() => void) | undefined
  let ended = false
  const iterator: AsyncIterableIterator<T, undefined> = {
    [Symbol.asyncIterator]: () => iterator,
    next: async () => {
      if (queued.length) return { done: false, value: queued.shift()! }
      if (ended) return { done: true, value: undefined }
      await new Promise<void>((resolve) => (wake = resolve))
      return iterator.next()
    },
    return: async () => {
      ended = true
      wake?.()
      return { done: true, value: undefined }
    },
  }
  return {
    iterator,
    push: (value: T) => {
      queued.push(value)
      wake?.()
    },
    end: () => {
      ended = true
      wake?.()
    },
    get ended() {
      return ended
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const key: CompanionKey = { projectId: "p", workspaceSessionId: "s", terminalId: "t1" }
const root = "rootActor000000a"
const helper = "helperActor0000b"

const detail = (plans: AgentDetail["plans"]): AgentDetail => ({
  terminalId: "t1",
  agent: "claude",
  sessionId: null,
  activity: null,
  telemetry: null,
  actors: [
    { ref: root, role: "root", parent: null, type: null },
    { ref: helper, role: "subagent", parent: root, type: "planner" },
  ],
  requests: [],
  plans,
  coverage: null,
})

const content = (ref: string, text: string): PlanContent => ({
  ref,
  text,
  truncated: false,
  changedAt: null,
})

const running = () => {
  let details = channel<AgentDetail>()
  const plans = new Map<string, ReturnType<typeof channel<PlanContent>>>()
  const companions = createRunnerCompanions({
    // A fresh subscription once the last one ended, as following starts over.
    detail: () => {
      if (details.ended) details = channel<AgentDetail>()
      return details.iterator
    },
    plan: (_terminalId, ref) => {
      const stream = channel<PlanContent>()
      plans.set(ref, stream)
      return stream.iterator
    },
  })
  const events: CompanionEvent[] = []
  companions.subscribe((event) => events.push(event))
  return {
    companions,
    get details() {
      return details
    },
    plans,
    events,
  }
}

describe("runner companions", () => {
  it("report a terminal's plan once its text arrives, read-only", async () => {
    const { companions, details, plans, events } = running()
    companions.follow(key)
    details.push(
      detail([{ ref: "planAAAAAAAAAAAA", actor: root, source: "file", name: "plan.md" }]),
    )
    await settle()
    plans.get("planAAAAAAAAAAAA")!.push(content("planAAAAAAAAAAAA", "# Fix logins\n"))
    await settle()
    expect(events).toEqual([
      {
        type: "plan/changed",
        key,
        plan: {
          ref: "planAAAAAAAAAAAA",
          role: "root",
          path: "plan.md",
          agent: "Claude Code",
          skill: false,
          writable: false,
          text: "# Fix logins\n",
          revision: revisionOf("# Fix logins\n"),
        },
      },
    ])
    expect(companions.snapshot()).toMatchObject([{ key, plans: [{ ref: "planAAAAAAAAAAAA" }] }])
  })

  it("tell a subagent's plan from the agent's own", async () => {
    const { companions, details, plans, events } = running()
    companions.follow(key)
    details.push(detail([{ ref: "planBBBBBBBBBBBB", actor: helper, source: "text", name: null }]))
    await settle()
    plans.get("planBBBBBBBBBBBB")!.push(content("planBBBBBBBBBBBB", "Steps"))
    await settle()
    expect(events).toMatchObject([
      { type: "plan/changed", plan: { role: "subagent", path: "Claude Code plan" } },
    ])
  })

  context("as a plan changes and goes", () => {
    it("reports each new text with a new revision, then its removal", async () => {
      const { companions, details, plans, events } = running()
      const listed = {
        ref: "planAAAAAAAAAAAA",
        actor: root,
        source: "file",
        name: "plan.md",
      } as const
      companions.follow(key)
      details.push(detail([listed]))
      await settle()
      const stream = plans.get(listed.ref)!
      stream.push(content(listed.ref, "v1"))
      stream.push(content(listed.ref, "v2"))
      await settle()
      details.push(detail([]))
      await settle()
      expect(events.map((event) => event.type)).toEqual([
        "plan/changed",
        "plan/changed",
        "plan/removed",
      ])
      expect(revisionOf("v1")).not.toBe(revisionOf("v2"))
      expect(stream.ended).toBe(true)
    })
  })

  it("close a terminal's companion and its streams when it's unfollowed", async () => {
    const { companions, details, plans, events } = running()
    companions.follow(key)
    details.push(
      detail([{ ref: "planAAAAAAAAAAAA", actor: root, source: "file", name: "plan.md" }]),
    )
    await settle()
    companions.unfollow(key)
    expect(events).toEqual([{ type: "companion/closed", key }])
    expect(details.ended).toBe(true)
    expect(plans.get("planAAAAAAAAAAAA")!.ended).toBe(true)
    expect(companions.snapshot()).toEqual([])
  })

  it("refuse to save or load, having nothing to write or show yet", async () => {
    const { companions } = running()
    await expect(companions.save(key, "planAAAAAAAAAAAA", "x", "r")).rejects.toThrow()
    await expect(companions.load(key, "image")).rejects.toThrow()
  })

  context("when the runner loses the terminal", () => {
    it("drops its plans, and follows it again once asked after a fresh shell", async () => {
      const runner = running()
      const listed = {
        ref: "planAAAAAAAAAAAA",
        actor: root,
        source: "file",
        name: "plan.md",
      } as const
      runner.companions.follow(key)
      runner.details.push(detail([listed]))
      await settle()
      runner.plans.get(listed.ref)!.push(content(listed.ref, "v1"))
      await settle()
      // Its detail ends, as on "not found".
      runner.details.end()
      await settle()
      expect(runner.events.map((event) => event.type)).toEqual(["plan/changed", "plan/removed"])
      runner.companions.follow(key)
      runner.details.push(detail([listed]))
      await settle()
      runner.plans.get(listed.ref)!.push(content(listed.ref, "v1"))
      await settle()
      expect(runner.events.map((event) => event.type)).toEqual([
        "plan/changed",
        "plan/removed",
        "plan/changed",
      ])
    })
  })

  it("reports nothing more about a terminal once it's closed", async () => {
    const runner = running()
    runner.companions.follow(key)
    runner.details.push(
      detail([{ ref: "planAAAAAAAAAAAA", actor: root, source: "file", name: "plan.md" }]),
    )
    await settle()
    runner.plans.get("planAAAAAAAAAAAA")!.push(content("planAAAAAAAAAAAA", "v1"))
    await settle()
    runner.companions.unfollow(key)
    await settle()
    expect(runner.events.map((event) => event.type)).toEqual(["plan/changed", "companion/closed"])
  })

  it("names a plan by what the latest detail says of it", async () => {
    const runner = running()
    const listed = {
      ref: "planAAAAAAAAAAAA",
      actor: root,
      source: "file",
      name: "plan.md",
    } as const
    runner.companions.follow(key)
    runner.details.push(detail([listed]))
    await settle()
    runner.details.push({ ...detail([{ ...listed, name: "renamed.md" }]), agent: "codex" })
    await settle()
    runner.plans.get(listed.ref)!.push({ ...content(listed.ref, "long"), truncated: true })
    await settle()
    expect(runner.events).toMatchObject([
      { plan: { path: "renamed.md", agent: "Codex", truncated: true } },
    ])
  })
})
