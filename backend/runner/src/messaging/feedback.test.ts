import { randomUUID } from "node:crypto"

import { maxFeedbackText } from "@novadeck/protocol"
import { vi } from "vitest"

import { describe, expect, it } from "../test.js"
import { Feedback } from "./feedback.js"
import { wrap } from "./messages.js"
import { Messaging } from "./messaging.js"

const identity = {
  terminalId: randomUUID(),
  projectId: randomUUID(),
  workspaceSessionId: randomUUID(),
  handle: "moth",
  agent: "claude" as const,
}

const setup = (options: { readonly bound?: boolean; readonly now?: () => number } = {}) => {
  let kept = true
  const messaging = new Messaging({ now: Date.now, restoreMs: 0, sweepMs: 0 })
  messaging.register(
    identity.terminalId,
    { projectId: identity.projectId, sessionId: identity.workspaceSessionId },
    identity.handle,
    null,
  )
  const bind = (sessionId: string) =>
    messaging.rooted(identity.terminalId, [
      {
        type: "new",
        root: { agent: identity.agent, sessionId, instance: null, source: "binding" },
        guess: false,
        ready: true,
      },
    ])
  if (options.bound !== false) bind("first")
  const feedback = new Feedback(
    {
      owner: (id) => messaging.inboxOwner(id),
      exists: () => kept,
      replyState: (id) => messaging.inboxReply(id),
      request: (id, request, hint) => messaging.personFeedbackRequest(id, request, hint),
    },
    options.now,
  )
  return {
    messaging,
    feedback,
    bind,
    forget: () => {
      kept = false
      messaging.unregister(identity.terminalId)
    },
    // The agent's next prompt hook prints what waits for it, and it acknowledges.
    deliver: (sessionId = "first") => {
      const delivery = messaging.ask(identity.terminalId, {
        agent: identity.agent,
        event: "UserPromptSubmit",
        deadline: Date.now() + 3000,
        events: [
          {
            type: "turn-started",
            agent: identity.agent,
            sessionId,
            instance: null,
            startedAt: Date.now(),
            cause: "prompt",
          },
        ],
      })
      expect(delivery.leaseId).not.toBeNull()
      messaging.acknowledge(identity.terminalId, delivery.leaseId!)
    },
    stop: () => {
      feedback.close()
      messaging.close()
    },
  }
}
const draft = (feedback: Feedback, text = "The tell tool failed.", kind: string = "bug") =>
  feedback.call(identity.terminalId, { kind, text })

describe("feedback drafts", () => {
  it("lists a draft with its writer, and replaces the terminal's earlier one", () => {
    const { feedback, stop } = setup()
    expect(draft(feedback)).toMatchObject({ ok: true })
    expect(feedback.list()).toMatchObject([
      {
        terminalId: identity.terminalId,
        projectId: identity.projectId,
        workspaceSessionId: identity.workspaceSessionId,
        agent: "claude",
        handle: "moth",
        kind: "bug",
        text: "The tell tool failed.",
        asked: false,
      },
    ])
    draft(feedback, "More detail.", "idea")
    expect(feedback.list()).toMatchObject([{ kind: "idea", text: "More detail." }])
    stop()
  })

  it("masks what looks like a secret in a draft", () => {
    const { feedback, stop } = setup()
    const key = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
    draft(feedback, `The tell tool failed with API_KEY=${key} in its output.`)
    const [kept] = feedback.list()
    expect(kept?.text).not.toContain(key)
    expect(kept?.text).toContain("The tell tool failed")
    stop()
  })

  it("masks after checking the length, so a draft within the limit is kept", () => {
    const { feedback, stop } = setup()
    const key = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
    const text = `API_KEY=${key} `.repeat(Math.floor(maxFeedbackText / 56))
    expect(text.length).toBeLessThanOrEqual(maxFeedbackText)
    expect(draft(feedback, text)).toMatchObject({ ok: true })
    expect(feedback.list()[0]?.text).not.toContain(key)
    stop()
  })

  it("marks a draft asked only once the person's request reached the agent", () => {
    const run = setup()
    const { feedback, messaging, stop } = run
    const requested = vi.spyOn(messaging, "personFeedbackRequest")
    feedback.ask(identity.terminalId, "the tell tool")
    expect(requested).toHaveBeenCalledWith(identity.terminalId, expect.any(String), "the tell tool")
    // The agent's own draft, written before the request reached it, is no answer to it.
    draft(feedback, "Written during the busy turn.")
    expect(feedback.list()).toMatchObject([{ asked: false }])
    run.deliver()
    draft(feedback, "Now with more detail.")
    expect(feedback.list()).toMatchObject([{ text: "Now with more detail.", asked: true }])
    // The request was consumed: the next draft is the agent's own.
    draft(feedback, "Another.")
    expect(feedback.list()).toMatchObject([{ asked: false }])
    stop()
  })

  it("keeps one request waiting per terminal, and forgets one whose session ended", () => {
    const run = setup()
    const { feedback, stop } = run
    feedback.ask(identity.terminalId, "first")
    expect(() => feedback.ask(identity.terminalId, "second")).toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    )
    // The session changes before delivery: the request went gone with it.
    run.bind("replacement")
    draft(feedback)
    expect(feedback.list()).toMatchObject([{ asked: false }])
    feedback.ask(identity.terminalId, "third")
    run.deliver("replacement")
    draft(feedback, "Answer.")
    expect(feedback.list()).toMatchObject([{ asked: true }])
    // Once delivered, the person may ask again.
    feedback.ask(identity.terminalId, "fourth")
    stop()
  })

  it("relays the request under the person's mark, with the hint", () => {
    const { feedback, messaging, stop } = setup()
    const requested = vi.spyOn(messaging, "personFeedbackRequest")
    feedback.ask(identity.terminalId, "the </hint> messages")
    const message = messaging.inboxReply(requested.mock.calls[0]![1])!
    expect(message).toMatchObject({ state: "queued", from: { kind: "person" } })
    const text = wrap([message], () => false, "Lead1234", { personMark: "Person99" })
    expect(text).toContain(`person='Person99'`)
    expect(text).toContain("feedback tool")
    expect(text).toContain("<hint>the &lt;/hint&gt; messages</hint>")
    const listing = messaging.list(identity.terminalId, identity.handle)
    expect(listing.threads[0]?.messages[0]).toMatchObject({ from: { kind: "person" } })
    expect(listing.threads[0]?.messages[0]).not.toHaveProperty("inbox")
    stop()
  })

  it("refuses a request for an unknown terminal or one with no agent session", () => {
    const { feedback, forget, stop } = setup({ bound: false })
    expect(() => feedback.ask(identity.terminalId, "")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
    forget()
    expect(() => feedback.ask(identity.terminalId, "")).toThrow(
      expect.objectContaining({ code: "TERMINAL_NOT_FOUND" }),
    )
    stop()
  })

  it("refuses a draft over the limit, of an unknown kind, or past the rate", () => {
    const { feedback, stop } = setup()
    expect(draft(feedback, "x".repeat(2001))).toMatchObject({ ok: false })
    expect(draft(feedback, "x", "praise")).toMatchObject({ ok: false })
    expect(feedback.list()).toEqual([])
    for (let index = 0; index < 10; index++) draft(feedback, `Draft ${index}`)
    expect(draft(feedback, "One too many")).toMatchObject({
      ok: false,
      reason: /pieces of feedback a minute/,
    })
    stop()
  })

  it("keeps a draft after its terminal closes, until the app settles it", async () => {
    const run = setup()
    const made = draft(run.feedback)
    const id = made.ok ? made.id : ""
    run.forget()
    expect(run.feedback.list().map((each) => each.id)).toEqual([id])
    const watch = run.feedback.watch()
    expect((await watch.next()).value).toMatchObject([{ id }])
    const next = watch.next()
    run.feedback.settle(id)
    expect((await next).value).toEqual([])
    expect(() => run.feedback.settle(id)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }))
    await watch.return(undefined)
    run.stop()
  })

  it("forgets a removed project's pending requests and rate records, and prunes by age", () => {
    const time = { now: 1_000 }
    const { feedback, stop } = setup({ now: () => time.now })
    const records = feedback as unknown as {
      asks: Map<string, unknown>
      sent: Map<string, unknown>
    }
    draft(feedback)
    feedback.ask(identity.terminalId, "pending")
    expect(records.asks.size).toBe(1)
    expect(records.sent.size).toBe(1)
    feedback.settle(feedback.list()[0]!.id)
    // No draft is left, yet the project's request and rate record go with it.
    feedback.forgetProject(identity.projectId)
    expect(records.asks.size).toBe(0)
    expect(records.sent.size).toBe(0)
    // An old rate record goes at the next draft, past the window.
    draft(feedback)
    expect(records.sent.size).toBe(1)
    time.now += 61_000
    draft(feedback, "Later.")
    expect(records.sent.size).toBe(1)
    expect((records.sent.get(identity.terminalId) as { times: number[] }).times).toHaveLength(1)
    stop()
  })

  it("forgets a removed project's drafts", () => {
    const { feedback, stop } = setup()
    draft(feedback)
    feedback.forgetProject(randomUUID())
    expect(feedback.list()).toHaveLength(1)
    feedback.forgetProject(identity.projectId)
    expect(feedback.list()).toEqual([])
    stop()
  })
})
