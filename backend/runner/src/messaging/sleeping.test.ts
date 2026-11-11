import { vi } from "vitest"

import { describe, expect, it } from "../test.js"
import { Inbox, memoryInbox, type InboxRecords } from "./inbox.js"
import { MessageStore } from "./message-store.js"
import { Messaging } from "./messaging.js"
import { memoryMessages, type MessageRecords } from "./records.js"
import type { SendAnswer } from "./sending.js"

const here = { projectId: "p", sessionId: "s" }
const saved = { agent: "claude", sessionId: "saved-1" } as const

type Run = ReturnType<typeof setup>

// A runner with a sender bound at `A` and, by default, a sleeper `B` resting on `saved`.
const setup = (
  records: MessageRecords = memoryMessages(),
  options: {
    readonly sleeper?: boolean
    readonly now?: { at: number }
    readonly restoreMs?: number
  } = {},
) => {
  const time = options.now ?? { at: 1_000_000 }
  const wakes: string[] = []
  const messaging = new Messaging({
    records,
    now: () => time.at,
    sweepMs: 0,
    restoreMs: options.restoreMs ?? 0,
    waitsMs: 0,
    platform: "linux",
    onWake: (terminalId) => wakes.push(terminalId),
  })
  messaging.register("A", here, "moth", null)
  bind(messaging, "A", "claude", "s-a")
  if (options.sleeper !== false) messaging.rest("B", here, "fox", null, saved)
  const send = (text = "hello", to = "fox"): Extract<SendAnswer, { ok: true }> => {
    const answer = messaging.send("A", { to, text })
    if (!answer.ok) throw new Error(answer.reason)
    return answer
  }
  const messages = (terminalId: string) =>
    messaging.list(terminalId, "x").threads.flatMap((thread) => thread.messages)
  return { messaging, wakes, send, messages, time }
}

const bind = (
  messaging: Messaging,
  terminalId: string,
  agent: "claude" | "codex" | "agy",
  sessionId: string,
  guess = false,
) =>
  messaging.rooted(terminalId, [
    {
      type: "new",
      root: { agent, sessionId, instance: null, source: "binding" },
      guess,
      ready: true,
    },
  ])

const closing = (run: Run) => () => run.messaging.close()

describe("a message to a sleeping terminal", () => {
  it("says the recipient is asleep and that the message wakes it, and asks for the wake", ({
    resources,
  }) => {
    const run = setup()
    resources.defer(closing(run))
    const answer = run.send("are you there?")
    expect(answer).toMatchObject({ state: "queued", asleep: true })
    expect(answer.route).toMatch(/asleep.*wakes it/)
    expect(run.wakes).toEqual(["B"])
    expect(run.messaging.wakeWanted("B")).toBe(true)
    expect(run.messaging.resting("B")).toEqual(saved)
    expect(run.messaging.holder("claude", "saved-1")).toBe("B")
  })

  it("lists the sleeper with a state word, without a ringable agent", ({ resources }) => {
    const run = setup()
    resources.defer(closing(run))
    const listed = run.messaging.agents("A")
    expect(listed.ok && listed.text).toContain("- @fox: Claude Code, asleep")
    expect(run.messaging.ringable("B")).toBe(false)
    expect(run.messaging.delivery("B")?.state).toBe("unbound")
  })

  it("survives the end of the restore window, though no agent runs there", ({ resources }) => {
    vi.useFakeTimers()
    resources.defer(() => void vi.useRealTimers())
    const run = setup(memoryMessages(), { restoreMs: 60_000 })
    resources.defer(closing(run))
    const message = run.send("for the sleeper")
    vi.advanceTimersByTime(60_000)
    expect(run.messaging.stateOf(message.id)).toBe("queued")
    run.messaging.register("B", here, "fox", null)
    bind(run.messaging, "B", "claude", saved.sessionId)
    expect(run.messaging.stateOf(message.id)).toBe("queued")
  })

  it("does not wake it while messaging is paused, until it is resumed", ({ resources }) => {
    const run = setup()
    resources.defer(closing(run))
    run.messaging.pause(true)
    const held = run.send("wait")
    expect(held).toMatchObject({ state: "held", held: "paused" })
    expect(run.wakes).toEqual([])
    expect(run.messaging.wakeWanted("B")).toBe(false)
    expect(run.messaging.wakesWanted().has("B")).toBe(false)
    run.messaging.pause(false)
    expect(run.wakes).toEqual(["B"])
    expect(run.messaging.wakeWanted("B")).toBe(true)
  })

  it("asks for a wake once for each time it rests, not for each change", ({ resources }) => {
    const run = setup()
    resources.defer(closing(run))
    run.send("one")
    run.send("two", "fox")
    expect(run.wakes).toEqual(["B"])
    run.messaging.rest("B", here, "fox", null, saved)
    expect(run.wakes).toEqual(["B", "B"])
  })
})

describe("a sleeper that starts", () => {
  it("keeps its messages queued, never gone, and rests until a session binds", ({ resources }) => {
    const run = setup()
    resources.defer(closing(run))
    const before = run.send("wake up")
    run.messaging.register("B", here, "fox", null)
    expect(run.messaging.stateOf(before.id)).toBe("queued")
    expect(run.messaging.resting("B")).toEqual(saved)
    expect(run.messaging.delivery("B")?.state).toBe("unbound")
    // It is no sleeper now, so a message is no longer told so, and no wake is asked again.
    expect(run.send("again")).not.toHaveProperty("asleep")
    expect(run.wakes).toEqual(["B"])
    bind(run.messaging, "B", "claude", "saved-1")
    expect(run.messaging.resting("B")).toBeUndefined()
    expect(run.messaging.stateOf(before.id)).toBe("queued")
    expect(run.messaging.holder("claude", "saved-1")).toBeUndefined()
  })

  it("is the same record, so what holds it by identity keeps it", ({ resources }) => {
    const run = setup()
    resources.defer(closing(run))
    const delivery = run.messaging.delivery("B")
    run.messaging.register("B", here, "fox", "moth")
    expect(run.messaging.agents("B").ok).toBe(true)
    expect(run.messaging.leadOf("B")).toBe("moth")
    expect(delivery).toBeDefined()
  })

  it("makes a message to the session it rested on gone if another session binds", ({
    resources,
  }) => {
    const run = setup()
    resources.defer(closing(run))
    const message = run.send("for the saved one")
    run.messaging.register("B", here, "fox", null)
    bind(run.messaging, "B", "claude", "somewhere-else")
    expect(run.messaging.stateOf(message.id)).toBe("gone")
  })

  it("waits for Codex's prompt before it binds, and rings it there", ({ resources }) => {
    const run = setup(memoryMessages(), { sleeper: false })
    resources.defer(closing(run))
    run.messaging.rest("B", here, "fox", null, { agent: "codex", sessionId: "rollout-1" })
    const message = run.send("hello codex")
    run.messaging.register("B", here, "fox", null)
    expect(run.messaging.ringable("B")).toBe(false)
    run.messaging.shown("B", "codex", null)
    expect(run.messaging.stateOf(message.id)).toBe("queued")
    expect(run.messaging.ringable("B")).toBe(true)
    // The first prompt binds the session it rested on; nothing was lost on the way.
    bind(run.messaging, "B", "codex", "rollout-1")
    expect(run.messaging.resting("B")).toBeUndefined()
    expect(run.messaging.stateOf(message.id)).toBe("queued")
  })

  it("lets a message follow Antigravity's guess at the session until its status line names it", ({
    resources,
  }) => {
    const run = setup(memoryMessages(), { sleeper: false })
    resources.defer(closing(run))
    run.messaging.rest("B", here, "fox", null, { agent: "agy", sessionId: "conv-1" })
    const message = run.send("hello agy")
    run.messaging.register("B", here, "fox", null)
    bind(run.messaging, "B", "agy", "conv-guess", true)
    expect(run.messaging.stateOf(message.id)).toBe("queued")
    run.messaging.rooted("B", [
      {
        type: "corrected",
        from: "conv-guess",
        root: { agent: "agy", sessionId: "conv-1", instance: null, source: "binding" },
        confirmed: true,
      },
    ])
    expect(run.messaging.stateOf(message.id)).toBe("queued")
    expect(run.messaging.resting("B")).toBeUndefined()
  })
})

describe("a sleeper's wake that fails", () => {
  it("makes the messages that asked for it gone, tells their sender, and rests as before", ({
    resources,
  }) => {
    const run = setup()
    resources.defer(closing(run))
    const sent = run.send("please")
    run.messaging.wakeFailed("B", "wake-failed")
    expect(run.messaging.stateOf(sent.id)).toBe("gone")
    expect(run.messaging.goneFrom("A")).toEqual([{ id: sent.id, to: "fox" }])
    expect(run.messaging.resting("B")).toEqual(saved)
    expect(run.messaging.wakeWanted("B")).toBe(false)
    // A message sent after is a wake of its own.
    run.send("again")
    expect(run.wakes).toEqual(["B", "B"])
  })

  it("leaves a message held by a pause waiting", ({ resources }) => {
    const run = setup()
    resources.defer(closing(run))
    run.messaging.pause(true)
    const held = run.send("later")
    run.messaging.wakeFailed("B", "wake-failed")
    expect(run.messaging.stateOf(held.id)).toBe("held")
  })
})

const inboxFor = (messaging: Messaging, records: InboxRecords, now: () => number) =>
  new Inbox(
    {
      owner: (id) => messaging.inboxOwner(id),
      reply: (id, ask, subject, text, commit, choice) =>
        messaging.personReply(id, ask, subject, text, commit, choice),
      replyState: (id) => messaging.inboxReply(id),
      forgetReplies: (ids) => messaging.forgetResponses(ids),
      changed: () => {},
      exists: () => true,
    },
    records,
    now,
    { sweepMs: 0, resumeGraceMs: 1_000 },
  )

describe("a wake that ended with a shell and no agent", () => {
  it("refuses new messages, lapses its ask, and reopens it if that session binds later", ({
    resources,
  }) => {
    const inboxRecords = memoryInbox()
    const messageRecords = memoryMessages()
    const first = setup(messageRecords, { sleeper: false })
    first.messaging.register("B", here, "fox", null)
    bind(first.messaging, "B", "claude", saved.sessionId)
    const before = inboxFor(first.messaging, inboxRecords, () => first.time.at)
    const created = before.call("B", "ask", {
      subject: "Pick one",
      body: "Which?",
      shape: { type: "text" },
    })
    if (!created.ok) throw new Error(created.reason)
    before.close()
    first.messaging.close()
    const run = setup(messageRecords)
    const inbox = inboxFor(run.messaging, inboxRecords, () => run.time.at)
    resources.defer(() => {
      inbox.close()
      run.messaging.close()
    })
    const waiting = run.send("wake up")
    run.messaging.register("B", here, "fox", null)
    run.messaging.wakeEnded("B", "wake-failed")
    expect(run.messaging.stateOf(waiting.id)).toBe("gone")
    expect(run.messaging.resting("B")).toBeUndefined()
    expect(run.messaging.inboxOwner("B")).toBeUndefined()
    const refused = run.messaging.send("A", { to: "fox", text: "again" })
    expect(refused).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no agent running"),
    })
    run.time.at += 2_000
    inbox.prune()
    expect(inbox.list()).toEqual([])
    bind(run.messaging, "B", "claude", saved.sessionId)
    inbox.reconcile("B")
    expect(inbox.list().map((entry) => entry.id)).toEqual([created.id])
  })

  it("leaves a sleeper that stays asleep resting", ({ resources }) => {
    const run = setup()
    resources.defer(closing(run))
    run.messaging.wakeEnded("B", "wake-failed")
    expect(run.messaging.resting("B")).toEqual(saved)
  })
})

describe("a sleeper's Inbox", () => {
  const identity = { ...here, terminalId: "B", handle: "fox", ...saved }

  const ask = { subject: "Pick one", body: "Which?", shape: { type: "text" } }

  // An agent asks while bound, the runner restarts, and its terminal rests on that session.
  const restarted = (resources: { defer: (cleanup: () => void) => void }) => {
    const inboxRecords = memoryInbox()
    const messageRecords = memoryMessages()
    const first = setup(messageRecords, { sleeper: false })
    first.messaging.register("B", here, "fox", null)
    bind(first.messaging, "B", "claude", saved.sessionId)
    const firstInbox = inboxFor(first.messaging, inboxRecords, () => first.time.at)
    const created = firstInbox.call("B", "ask", ask)
    if (!created.ok) throw new Error(created.reason)
    firstInbox.close()
    first.messaging.close()
    const run = setup(messageRecords)
    const inbox = inboxFor(run.messaging, inboxRecords, () => run.time.at)
    resources.defer(() => {
      inbox.close()
      run.messaging.close()
    })
    return { run, inbox, id: created.id }
  }

  it("keeps an ask listed and answerable, past the grace a restored terminal has", ({
    resources,
  }) => {
    const { run, inbox, id } = restarted(resources)
    run.time.at += 60_000
    inbox.prune()
    expect(inbox.list().map((entry) => entry.id)).toEqual([id])
    expect(identity.terminalId).toBe("B")
  })

  it("queues the person's answer for the session and wakes the sleeper", ({ resources }) => {
    const { run, inbox, id } = restarted(resources)
    inbox.answer(id, { type: "reply", option: null, text: "the blue one" })
    expect(run.wakes).toEqual(["B"])
    const reply = run.messages("B").find((message) => message.inbox === "answer")
    expect(reply).toMatchObject({ state: "queued", text: "the blue one" })
    // It waits for the agent to be back, and is lost on the way to nothing.
    expect(run.messages("B").find((message) => message.inbox === "answer")?.state).toBe("queued")
    run.messaging.register("B", here, "fox", null)
    bind(run.messaging, "B", "claude", saved.sessionId)
    expect(run.messages("B").find((message) => message.inbox === "answer")?.state).toBe("queued")
  })

  it("reports what the sleeper's agent told the person, so a done mark stands", ({ resources }) => {
    const { inbox } = restarted(resources)
    expect(inbox.call("B", "done", { subject: "All done", body: "Body" }).ok).toBe(true)
    expect(inbox.reports("B").done?.subject).toBe("All done")
  })

  it("still reports the standing done once the resume binds the same session", ({ resources }) => {
    const { run, inbox } = restarted(resources)
    expect(inbox.call("B", "done", { subject: "All done", body: "Body" }).ok).toBe(true)
    const before = inbox.reports("B").done
    expect(before?.subject).toBe("All done")
    // The shell resumes the saved session: the wake binds it again, with no word to the agent.
    run.messaging.register("B", here, "fox", null)
    bind(run.messaging, "B", "claude", saved.sessionId)
    expect(run.messaging.resting("B")).toBeUndefined()
    expect(inbox.reports("B").done).toEqual(before)
    expect(run.messaging.deliveredAt().get("B")).toBeUndefined()
  })

  it("keeps the turn an agent ended before the restart, so its tab reads unread while it sleeps", ({
    resources,
  }) => {
    const { run, inbox } = restarted(resources)
    const owner = run.messaging.inboxOwner("B")
    expect(owner).toMatchObject({ terminalId: "B", agent: "claude", sessionId: saved.sessionId })
    inbox.recordTurn(owner!, 5, { outcome: "failed", reply: null, error: "Boom", files: [] })
    inbox.reconcile("B")
    inbox.prune()
    expect(inbox.list().filter((entry) => entry.content.kind === "turn")).toMatchObject([
      { terminalId: "B", content: { outcome: "failed" } },
    ])
  })

  it("keeps a completed turn too, and says when the newest ended", ({ resources }) => {
    const { run, inbox } = restarted(resources)
    const owner = run.messaging.inboxOwner("B")
    expect(inbox.lastTurnAt("B")).toBeNull()
    inbox.recordTurn(owner!, 5, { outcome: "completed", reply: "Done.", error: null, files: [] })
    inbox.recordTurn(owner!, 9, { outcome: "completed", reply: "More.", error: null, files: [] })
    inbox.reconcile("B")
    inbox.prune()
    expect(inbox.list().filter((entry) => entry.content.kind === "turn")).toHaveLength(2)
    expect(inbox.lastTurnAt("B")).toBe(9)
  })

  it("lapses an ask once its terminal stops resting on the session", ({ resources }) => {
    const { run, inbox, id } = restarted(resources)
    run.messaging.rest("B", here, "fox", null, { agent: "claude", sessionId: "another" })
    inbox.reconcile("B")
    expect(inbox.list().map((entry) => entry.id)).not.toContain(id)
  })
})

describe("finding the sleepers that want a wake", () => {
  it("answers for 170 rows in one pass over the messages", ({ resources }) => {
    const run = setup(memoryMessages(), { sleeper: false })
    resources.defer(closing(run))
    for (let at = 0; at < 170; at++)
      run.messaging.rest(`T${at}`, here, `h${at}`, null, { agent: "claude", sessionId: `s${at}` })
    for (let at = 0; at < 170; at += 10) {
      run.time.at += 61_000
      run.send("wake", `h${at}`)
    }
    const passes = vi.spyOn(MessageStore.prototype, "messages")
    resources.defer(() => passes.mockRestore())
    const wanted = run.messaging.wakesWanted()
    expect(passes).toHaveBeenCalledTimes(1)
    expect([...wanted].toSorted()).toEqual(
      Array.from({ length: 17 }, (_, at) => `T${at * 10}`).toSorted(),
    )
  })
})

describe("a sleeper that stops being one for a reason", () => {
  it("makes its waiting messages gone and frees its session", ({ resources }) => {
    const run = setup()
    resources.defer(closing(run))
    const sent = run.send("never read")
    run.messaging.unregister("B", false, "Novadeck was disconnected from Claude.")
    expect(run.messaging.stateOf(sent.id)).toBe("gone")
    expect(run.messaging.resting("B")).toBeUndefined()
  })
})

describe("a sleeper that closes", () => {
  it("makes its waiting messages gone and frees its session", ({ resources }) => {
    const run = setup()
    resources.defer(closing(run))
    const sent = run.send("never read")
    run.messaging.unregister("B", true)
    expect(run.messaging.stateOf(sent.id)).toBe("gone")
    expect(run.messaging.holder("claude", "saved-1")).toBeUndefined()
    expect(run.messaging.resting("B")).toBeUndefined()
  })
})

describe("an agent stopped to rest while it ran", () => {
  it("rests where it was bound, keeping its messages, and wakes for the next one", ({
    resources,
  }) => {
    const run = setup({ ...memoryMessages() }, { sleeper: false })
    resources.defer(closing(run))
    run.messaging.register("B", here, "fox", null)
    bind(run.messaging, "B", "claude", "bound-1")
    expect(run.messaging.resting("B")).toBeUndefined()
    run.messaging.rest("B", here, "fox", null, { agent: "claude", sessionId: "bound-1" })
    expect(run.messaging.resting("B")).toEqual({ agent: "claude", sessionId: "bound-1" })
    expect(run.messaging.delivery("B")?.state).toBe("unbound")
    run.send("are you there?")
    expect(run.wakes).toEqual(["B"])
  })

  it("is occupied while a message waits for it, not the sender, nor one a release holds", ({
    resources,
  }) => {
    const run = setup({ ...memoryMessages() }, { sleeper: false })
    resources.defer(closing(run))
    run.messaging.register("B", here, "fox", null)
    bind(run.messaging, "B", "claude", "bound-1")
    expect(run.messaging.occupied("B")).toBe(false)
    run.send("hello")
    expect(run.messaging.occupied("B")).toBe(true)
    expect(run.messaging.occupied("A")).toBe(false)
    expect(run.messaging.occupied("nobody")).toBe(false)
  })
})

describe("a terminal moved to another session", () => {
  it("is seen by the terminals of its new session, with its new handle and lead, and no longer by the old", () => {
    const { messaging } = setup()
    messaging.register("C", { projectId: "p", sessionId: "t" }, "owl", null)
    bind(messaging, "C", "claude", "s-c")
    expect(messaging.send("A", { to: "owl", text: "hi" }).ok).toBe(false)
    messaging.move("B", { projectId: "p", sessionId: "t" }, "kite", "owl")
    expect(messaging.leadOf("B")).toBe("owl")
    expect(messaging.send("C", { to: "kite", text: "hi" }).ok).toBe(true)
    expect(messaging.inboxOwner("B")).toMatchObject({ workspaceSessionId: "t", handle: "kite" })
    expect(messaging.send("A", { to: "fox", text: "hi" }).ok).toBe(false)
  })
})
