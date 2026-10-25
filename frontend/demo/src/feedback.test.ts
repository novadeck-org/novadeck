import type { InboxItem } from "@novadeck/core/inbox"
import type { TerminalKey } from "@novadeck/core/port"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { createWorkspaceStore } from "@novadeck/core/store"
import type { TerminalMetadata } from "@novadeck/core/types"
import { afterEach, beforeEach, vi } from "vitest"

import {
  demoFeedbackVersion,
  describeOs,
  draftKindOf,
  draftTextOf,
  feedbackSendMs,
  isDemoFeedback,
} from "./feedback"
import { plainDemo } from "./index"
import { chatAgent } from "./samples"
import { context, describe, expect, it } from "./test"
import { demoTurns } from "./turns"
import { visitorDemo } from "./visitor"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// The demo's turn, three of which the agent takes to write a draft.
const writeMs = 3 * 1500 + 100

describe("describeOs", () => {
  const linux = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15"
  const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126"

  it("reads the platform and architecture the browser gives", () => {
    expect(describeOs({ platform: "macOS", architecture: "arm", userAgent: mac })).toBe(
      "macOS arm64",
    )
    expect(describeOs({ platform: "Windows", architecture: "x86", userAgent: windows })).toBe(
      "Windows x64",
    )
    expect(describeOs({ platform: "Linux", architecture: "arm", userAgent: linux })).toBe(
      "Linux arm64",
    )
  })

  it("falls back to the user agent, and to the usual architecture of the OS", () => {
    expect(describeOs({ userAgent: linux })).toBe("Linux x64")
    expect(describeOs({ userAgent: windows })).toBe("Windows x64")
    // A Mac's user agent says Intel whatever it runs on.
    expect(describeOs({ userAgent: mac })).toBe("macOS arm64")
    expect(describeOs({ userAgent: "Mozilla/5.0 (X11; Linux aarch64) Firefox/127" })).toBe(
      "Linux arm64",
    )
  })

  it("says so when it can't place the OS", () => {
    expect(describeOs({ userAgent: "" })).toBe("Unknown OS")
    expect(describeOs({ userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/126" })).toBe(
      "Unknown OS",
    )
  })
})

describe("the agent's draft", () => {
  it("is a bug unless the hint is about an idea or something else", () => {
    expect(draftKindOf("")).toBe("bug")
    expect(draftKindOf("the terminal froze")).toBe("bug")
    expect(draftKindOf("an idea for the sidebar")).toBe("idea")
    expect(draftKindOf("I wish it had a shortcut")).toBe("idea")
    expect(draftKindOf("general thoughts")).toBe("other")
  })

  it("names the window, one path under the home folder, and the hint", () => {
    for (const kind of ["bug", "idea", "other"] as const) {
      const text = draftTextOf(kind, "Checkout flow", "storefront", "the cart")
      expect(text).toContain("Checkout flow")
      expect(text.match(/~\/Workspace\/storefront\/src/g)).toHaveLength(1)
      expect(text).toContain("You asked me to cover: the cart")
    }
    expect(draftTextOf("bug", "Checkout flow", "storefront", " ")).not.toContain("You asked me")
  })
})

// An agents demo the app has opened, its workspace kept as the app keeps it.
const boot = () => {
  const turns = demoTurns()
  const backend = plainDemo("agents", undefined, undefined, turns)
  const store = createWorkspaceStore(
    workspaceFromSeed(backend.seed, { view: "grid", windowedView: "grid", now: 0 }),
    backend.commit,
  )
  backend.commit(store.getSnapshot(), [])
  backend.start!({ dispatch: (actions) => store.transact(actions as never), open: () => {} })
  const { feedback, inbox } = backend
  if (!isDemoFeedback(feedback) || !inbox) throw new Error("the agents demo has feedback")
  const terminals = store.getSnapshot().projects.flatMap((project) =>
    (project.history[0]?.state.roster.terminals ?? []).map((terminal) => ({
      terminal,
      key: {
        projectId: project.id,
        workspaceSessionId: "initial",
        terminalId: terminal.id,
      } satisfies TerminalKey,
    })),
  )
  const resting = (each: { terminal: TerminalMetadata }) =>
    each.terminal.state === "running" &&
    !each.terminal.agent?.working &&
    !each.terminal.agent?.attention &&
    chatAgent(each.terminal)
  const feedbackItems = (): InboxItem[] =>
    inbox.state.getSnapshot().items.filter((each) => each.kind === "feedback")
  return { turns, backend, feedback, inbox, store, terminals, resting, feedbackItems }
}

describe("the demo's feedback", () => {
  it("says the demo's version and the browser's OS", async () => {
    const { feedback } = boot()
    const about = await feedback.about()
    expect(about.version).toBe(demoFeedbackVersion)
    expect(about.os).toMatch(/^(Linux|macOS|Windows) (x64|arm64)$|^Unknown OS$/)
  })

  context("when a note is sent", () => {
    it("goes after a moment and sends nothing anywhere", async () => {
      const { feedback } = boot()
      const sent = vi.fn<() => void>()
      void feedback.send({ kind: "bug", text: "hello" }).then(sent)
      await vi.advanceTimersByTimeAsync(feedbackSendMs - 1)
      expect(sent).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(sent).toHaveBeenCalledOnce()
    })

    it("fails once when armed, as if offline, then goes again", async () => {
      const { feedback } = boot()
      feedback.failNext()
      const first = feedback.send({ kind: null, text: "a" })
      const caught = first.catch((error: Error) => error.message)
      await vi.advanceTimersByTimeAsync(feedbackSendMs)
      expect(await caught).toMatch(/network/)
      const second = feedback.send({ kind: null, text: "a" })
      await vi.advanceTimersByTimeAsync(feedbackSendMs)
      await expect(second).resolves.toBeUndefined()
    })
  })

  context("when an agent is asked to write feedback", () => {
    it("refuses a window with no agent", async () => {
      const { feedback, terminals, resting } = boot()
      const shell = terminals.find((each) => !resting(each) && !chatAgent(each.terminal))
      expect(shell).toBeDefined()
      await expect(feedback.ask(shell!.key, "")).rejects.toThrow(/No agent/)
      await expect(
        feedback.ask({ projectId: "nowhere", workspaceSessionId: "x", terminalId: "y" }, ""),
      ).rejects.toThrow(/No agent/)
    })

    it("has the agent work, then puts its draft in the Inbox as its own item", async () => {
      const { feedback, terminals, resting, store, feedbackItems } = boot()
      const found = terminals.find(resting)!
      await feedback.ask(found.key, "an idea for the sidebar")
      await vi.advanceTimersByTimeAsync(10)
      const during = store.getSnapshot().projects.find((each) => each.id === found.key.projectId)
      const terminal = during?.history[0]?.state.roster.terminals.find(
        (each) => each.id === found.key.terminalId,
      )
      expect(terminal?.state === "running" && terminal.agent?.working).toBe(true)
      expect(feedbackItems()).toEqual([])

      await vi.advanceTimersByTimeAsync(3000)
      expect(feedbackItems()).toEqual([])
      await vi.advanceTimersByTimeAsync(writeMs)
      const [item] = feedbackItems()
      expect(item).toMatchObject({
        kind: "feedback",
        draft: { kind: "idea" },
        source: { terminalId: found.key.terminalId, projectId: found.key.projectId },
      })
      expect(item?.kind === "feedback" && item.draft.text).toMatch(/~\/Workspace\//)
      expect(item?.source.handle).toMatch(/^[a-z]+$/)
    })

    it("waits for an agent mid-turn to end its turn first", async () => {
      const { feedback, terminals, resting, turns, feedbackItems } = boot()
      const found = terminals.find(resting)!
      turns.prompt("keep going", found.terminal, found.key)
      await vi.advanceTimersByTimeAsync(10)
      await feedback.ask(found.key, "")
      await vi.advanceTimersByTimeAsync(1000)
      expect(feedbackItems()).toEqual([])
      // The turn ends, and only then the agent takes its own to write the feedback.
      await vi.advanceTimersByTimeAsync(600)
      expect(feedbackItems()).toEqual([])
      await vi.advanceTimersByTimeAsync(writeMs)
      expect(feedbackItems()).toHaveLength(1)
    })

    it("writes for an agent seeded as working, which has no turn to wait for", async () => {
      const { feedback, terminals, feedbackItems } = boot()
      const found = terminals.find(
        ({ terminal }) =>
          terminal.state === "running" &&
          terminal.agent?.working &&
          !terminal.agent.attention &&
          chatAgent(terminal),
      )!
      expect(found).toBeDefined()
      await feedback.ask(found.key, "")
      await feedback.ask(found.key, "")
      await vi.advanceTimersByTimeAsync(2 * writeMs + 100)
      expect(feedbackItems()).toHaveLength(2)
    })

    it("writes one draft for each request, in order, and none for a later turn", async () => {
      const { feedback, terminals, resting, turns, feedbackItems } = boot()
      const found = terminals.find(resting)!
      await feedback.ask(found.key, "")
      await vi.advanceTimersByTimeAsync(10)
      await feedback.ask(found.key, "an idea for the sidebar")
      await vi.advanceTimersByTimeAsync(writeMs)
      expect(feedbackItems()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(writeMs)
      const kinds = feedbackItems().map((each) => each.kind === "feedback" && each.draft.kind)
      expect(kinds.toSorted()).toEqual(["bug", "idea"])
      turns.work(found.key, found.terminal)
      turns.rest(found.key, found.terminal)
      await vi.advanceTimersByTimeAsync(5000)
      expect(feedbackItems()).toHaveLength(2)
    })

    it("starts a request queued behind a dialog once the person answers it", async () => {
      const { feedback, terminals, resting, turns, feedbackItems } = boot()
      const found = terminals.find(resting)!
      turns.ask(found.key, found.terminal, "permission", 1)
      await vi.advanceTimersByTimeAsync(10)
      await feedback.ask(found.key, "")
      await vi.advanceTimersByTimeAsync(10_000)
      expect(feedbackItems()).toEqual([])
      // Answered, the agent waits at its prompt with no turn event.
      turns.resume(found.key, found.terminal, { waits: true })
      await vi.advanceTimersByTimeAsync(writeMs)
      expect(feedbackItems()).toHaveLength(1)
    })

    it("rejects once when armed, as if no agent ran there", async () => {
      const { feedback, terminals, resting, feedbackItems } = boot()
      const found = terminals.find(resting)!
      feedback.failNextAsk()
      await expect(feedback.ask(found.key, "")).rejects.toThrow(/No agent/)
      await feedback.ask(found.key, "")
      await vi.advanceTimersByTimeAsync(writeMs)
      expect(feedbackItems()).toHaveLength(1)
    })

    it("writes nothing when something else takes the agent meanwhile", async () => {
      const { feedback, terminals, resting, turns, feedbackItems } = boot()
      const found = terminals.find(resting)!
      await feedback.ask(found.key, "")
      await vi.advanceTimersByTimeAsync(10)
      turns.work(found.key, found.terminal)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(feedbackItems()).toEqual([])
    })
  })
})

describe("the demos with feedback", () => {
  it("are the plain ones, which build full backends", () => {
    for (const variant of [
      "plain",
      "agents",
      "messages",
      "inbox",
      "welcome",
      "chirp",
      "babcia",
    ] as const)
      expect(isDemoFeedback(plainDemo(variant).feedback)).toBe(true)
  })

  it("leave the visitor's demo without it", () => {
    expect(visitorDemo().feedback).toBeUndefined()
    expect("feedback" in visitorDemo()).toBe(false)
  })
})
