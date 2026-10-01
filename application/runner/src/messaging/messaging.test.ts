import type { AgentName } from "@novadeck/protocol"
import { afterEach, beforeEach, vi } from "vitest"

import type { Binding } from "../harnesses/bindings.js"
import type { HarnessEvent } from "../harnesses/events.js"
import { doorbellLine } from "../harnesses/harness.js"
import { harnesses } from "../harnesses/registry.js"
import { followRoot, type Root } from "../harnesses/roots.js"
import { typedPromptStart } from "../harnesses/typed-prompts.js"
import { describe, expect, it } from "../test.js"
import { clock, retentionMs, threadMs } from "./mailbox.js"
import {
  Messaging,
  type MessagingChange,
  type MessagingOptions,
  type SendAnswer,
} from "./messaging.js"
import type { Whereabouts } from "./peers.js"
import { memoryMailbox, type MailboxRecords } from "./records.js"

const binding = (agent: AgentName, sessionId: string, instance: string | null = "10"): Binding => ({
  agent,
  sessionId,
  instance,
})

const fact = (bound: Binding) => ({
  agent: bound.agent,
  sessionId: bound.sessionId,
  instance: bound.instance,
  startedAt: 1,
})

const started = (
  bound: Binding,
  cause: "prompt" | "harness" | "call" = "prompt",
): HarnessEvent => ({ type: "turn-started", ...fact(bound), cause })

const stopped = (bound: Binding, background = false): HarnessEvent => ({
  type: "turn-ended",
  ...fact(bound),
  outcome: "completed",
  background,
})

const observed = (bound: Binding, root = false): HarnessEvent => ({
  type: "session-observed",
  ...fact(bound),
  evidence: "conversation-observed",
  ...(root && { root }),
})

type Clock = { now: number }

// One project and NovaDeck session, and another project.
const here = { projectId: "p", sessionId: "s" }
const elsewhere = { projectId: "q", sessionId: "s2" }

const create = (
  records: MailboxRecords = memoryMailbox(),
  time: Clock = { now: 1_000_000 },
  options: MessagingOptions = {},
) => {
  const changed: string[] = []
  const messaging = new Messaging({
    records,
    now: () => time.now,
    sweepMs: 0,
    restoreMs: 0,
    ...options,
  })
  messaging.subscribe((change) => {
    if (change.kind === "terminal") changed.push(change.terminalId)
  })
  // Each terminal's root, followed as the terminal manager follows it.
  const roots = new Map<string, Root | null>()
  const follow = (
    terminalId: string,
    bound: Binding | null,
    events: readonly HarnessEvent[] = [],
    statusLine = false,
  ) => {
    const current = roots.get(terminalId) ?? null
    const agent = bound?.agent ?? current?.agent
    const { root, changes } = followRoot(current, bound, events, {
      mode: agent ? harnesses[agent].messaging.root : "binding",
      statusLine,
      awaited: (sessionId) => messaging.awaits(terminalId, sessionId),
    })
    roots.set(terminalId, root)
    messaging.rooted(terminalId, changes)
  }
  // A report the terminal's hooks made, with the binding it left.
  const observe = (
    terminalId: string,
    bound: Binding | null,
    events: readonly HarnessEvent[],
    statusLine = false,
  ) => {
    follow(terminalId, bound, events, statusLine)
    messaging.observe(terminalId, events)
  }
  // Two running terminals in one project, each with its agent bound.
  const claude = binding("claude", "s-claude", "1")
  const codex = binding("codex", "s-codex", "2")
  messaging.register("A", here, "t1")
  messaging.register("B", here, "t2")
  follow("A", claude)
  follow("B", codex)
  // What a hook of the terminal's agent asks, with plenty of time left.
  const ask = (
    terminalId: string,
    bound: Binding,
    event: string,
    events: HarnessEvent[],
    deadline = time.now + 3_000,
  ) => {
    follow(terminalId, bound, events)
    return messaging.ask(terminalId, { agent: bound.agent, event, events, deadline })
  }
  const prompt = (terminalId: string, bound: Binding, cause?: "prompt" | "harness" | "call") =>
    ask(terminalId, bound, bound.agent === "agy" ? "PreInvocation" : "UserPromptSubmit", [
      started(bound, cause),
    ])
  const stop = (terminalId: string, bound: Binding, background = false) =>
    ask(terminalId, bound, "Stop", [stopped(bound, background)])
  const send = (from: string, to: string, text: string) => messaging.send(from, { to, text })
  return {
    messaging,
    records,
    clock: time,
    changed,
    claude,
    codex,
    follow,
    observe,
    ask,
    prompt,
    stop,
    send,
  }
}

const sent = (answer: SendAnswer) => {
  if (!answer.ok) throw new Error(answer.reason)
  return answer
}

const messages = (messaging: Messaging, terminalId: string) =>
  messaging.list(terminalId, "t?").threads.flatMap((thread) => thread.messages)

describe("sending", () => {
  it("addresses a terminal by its exact handle, never one without an agent", () => {
    const { messaging, send } = create()
    messaging.register("C", here, "t3")
    expect(sent(send("A", "t2", "hi"))).toMatchObject({ to: "t2", state: "queued" })
    expect(send("A", "t3", "hi")).toEqual({
      ok: false,
      reason: "t3 has no agent running there that NovaDeck can deliver to.",
    })
    // Terminals of other projects are not there to address.
    messaging.register("Z", elsewhere, "t1")
    expect(send("Z", "t2", "hi")).toMatchObject({ ok: false })
  })

  it("refuses anything but a current handle, describing every terminal there", () => {
    const { messaging, send } = create()
    for (const to of ["codex", "T2", " t2", "t9"])
      expect(send("A", to, "hi")).toEqual({
        ok: false,
        reason: [
          `"${to}" is no terminal's handle here. Send to one of these by its exact handle, ` +
            "picking by its title, folder and work; if more than one could be meant, ask the " +
            "user rather than guess.",
          "Other terminals in this project and session:",
          "- t2: Codex, idle",
        ].join("\n"),
      })
    expect(send("A", "t1", "hi")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^t1 is this terminal\.\n/),
    })
    // A handle stays its terminal's: a closed one's is refused, never another's.
    messaging.unregister("B")
    expect(send("A", "t2", "hi")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("There are no other terminals in this project and session."),
    })
  })

  it("says where a message goes, never that it was delivered", () => {
    const { messaging, send, prompt, stop, claude, codex } = create()
    expect(sent(send("A", "t2", "one"))).toMatchObject({
      state: "queued",
      route: "when its agent first prompts",
    })
    prompt("B", codex)
    expect(sent(send("A", "t2", "two"))).toMatchObject({
      route: "at its turn's end or its next prompt",
    })
    prompt("A", claude)
    expect(sent(send("B", "t1", "three"))).toMatchObject({ route: "when its current turn ends" })
    // Its Stop takes the message; the turn it continues ends with background work running.
    messaging.acknowledge("A", stop("A", claude).leaseId!)
    prompt("A", claude, "harness")
    stop("A", claude, true)
    expect(sent(send("B", "t1", "four"))).toMatchObject({ route: "when its next turn starts" })
  })

  it("keeps the text as sent, without control characters, up to 4 KB", () => {
    const { messaging, send } = create()
    sent(send("A", "t2", "line\r\n\u001b[1mbold\ttab"))
    expect(messages(messaging, "A")[0]?.text).toBe("line\n[1mbold\ttab")
    expect(send("A", "t2", "é".repeat(2_049))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("4098 bytes, over the 4096 a message may hold"),
    })
    expect(sent(send("A", "t2", "é".repeat(2_048)))).toMatchObject({ state: "queued" })
    expect(send("A", "t2", " \n\u0007")).toEqual({ ok: false, reason: "The message is empty." })
    expect(messaging.send("A", { to: "t2" })).toMatchObject({ ok: false })
    expect(messaging.send("A", { to: "t2", text: "x", as: "the person" })).toMatchObject({
      ok: false,
    })
  })

  it("answers the same text to the same recipient within ten seconds as the same message", () => {
    const { send, clock: time } = create()
    const first = sent(send("A", "t2", "same"))
    time.now += 10_000
    expect(sent(send("A", "t2", "same")).id).toBe(first.id)
    time.now += 1
    expect(sent(send("A", "t2", "same")).id).not.toBe(first.id)
  })

  it("threads messages between the same two terminals within ten minutes, either way", () => {
    const { messaging, send, clock: time } = create()
    const first = sent(send("A", "t2", "one"))
    time.now += threadMs
    sent(send("B", "t1", "two"))
    time.now += threadMs + 1
    sent(send("A", "t2", "three"))
    const { threads } = messaging.list("A", "t1")
    expect(threads.map((thread) => thread.messages.map(({ text, hop }) => [text, hop]))).toEqual([
      [["three", 1]],
      [
        ["one", 1],
        ["two", 2],
      ],
    ])
    expect(threads[1]).toMatchObject({ peer: "t2", hops: 2, allowed: 12, held: false })
    expect(threads[1]?.messages[0]?.id).toBe(first.id)
  })

  it("limits a sender to 10 a minute, 3 of them to any one terminal", () => {
    const { messaging, send, follow, clock: time } = create()
    for (const [index, id] of ["C", "D", "E", "F"].entries()) {
      messaging.register(id, here, `t${index + 3}`)
      follow(id, binding("codex", `s-${id}`, id))
    }
    for (let index = 0; index < 3; index += 1) sent(send("A", "t2", `to B ${index}`))
    expect(send("A", "t2", "fourth")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("3 of them to any one terminal"),
    })
    for (const to of ["t3", "t4"])
      for (let index = 0; index < 3; index += 1) sent(send("A", to, `to ${to} ${index}`))
    sent(send("A", "t5", "tenth"))
    expect(send("A", "t6", "eleventh")).toMatchObject({ ok: false })
    time.now += 60_000
    expect(sent(send("A", "t6", "a minute on"))).toMatchObject({ state: "queued" })
  })

  it("limits every agent together to 60 a minute", () => {
    const { messaging, send, follow } = create()
    const recipients = ["R1", "R2", "R3"].map((id, index) => {
      messaging.register(id, here, `t${index + 10}`)
      follow(id, binding("codex", `s-${id}`, id))
      return `t${index + 10}`
    })
    const senders = Array.from({ length: 7 }, (_, index) => {
      const id = `S${index}`
      messaging.register(id, here, `t${index + 20}`)
      return id
    })
    const answers = senders.flatMap((from) =>
      recipients.flatMap((to) => [0, 1, 2].map((index) => send(from, to, `${from} ${index}`))),
    )
    expect(answers.filter((answer) => answer.ok)).toHaveLength(60)
    expect(answers.at(-1)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("as many messages as they may this minute"),
    })
  })

  it("refuses more once a recipient has 50 waiting", () => {
    const { messaging, send, clock: time } = create()
    for (let index = 0; index < 50; index += 1) {
      if (index % 3 === 0) time.now += 60_000
      sent(send("A", "t2", `message ${index}`))
    }
    time.now += 60_000
    expect(send("A", "t2", "one more")).toMatchObject({
      ok: false,
      reason: "t2 already has 50 messages waiting; wait for it to take them before sending more.",
    })
    expect(messages(messaging, "B")).toHaveLength(50)
  })

  it("needs descriptions only when `to` is no handle there", () => {
    const { messaging } = create()
    expect(messaging.describes("A", { to: "t2", text: "hi" })).toBe(false)
    expect(messaging.describes("A", { to: "codex", text: "hi" })).toBe(true)
    expect(messaging.describes("A", { to: "t1", text: "hi" })).toBe(true)
    expect(messaging.describes("A", { text: "hi" })).toBe(false)
  })
})

describe("an addressee with no session yet", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("waits for the first session of the agent its terminal expects", () => {
    const { messaging, send, follow, prompt } = create()
    messaging.register("N", here, "t3")
    messaging.expect("N", "codex")
    expect(sent(send("A", "t3", "hello"))).toMatchObject({
      state: "queued",
      route: "when its agent first prompts",
    })
    expect(messages(messaging, "N")[0]).toMatchObject({ toAgent: "codex", state: "queued" })
    const first = binding("codex", "s-first", "3")
    follow("N", first)
    expect(prompt("N", first).stdout).toContain("hello")
  })

  it("shows in the listings as expected, matching what send takes", () => {
    const { messaging, send } = create()
    messaging.register("N", here, "t3")
    messaging.expect("N", "codex")
    const listed = messaging.agents("A")
    expect(listed.ok && listed.text).toContain("- t3: expecting Codex, not started yet")
    expect(send("A", "nobody", "hi")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("- t3: expecting Codex, not started yet"),
    })
  })

  it("ends once the expected agent's session binds: after it ends, nothing more is taken", () => {
    const { messaging, send, follow, prompt } = create()
    messaging.register("N", here, "t3")
    messaging.expect("N", "codex")
    const first = binding("codex", "s-first", "3")
    follow("N", first)
    follow("N", null)
    const refusal = {
      ok: false,
      reason: "t3 has no agent running there that NovaDeck can deliver to.",
    }
    expect(send("A", "t3", "after")).toEqual(refusal)
    // A later, unrelated session there gets nothing sent before it.
    const later = binding("codex", "s-later", "4")
    follow("N", later)
    expect(prompt("N", later)).toEqual({ leaseId: null, stdout: "" })
    follow("N", null)
    expect(send("A", "t3", "again")).toEqual(refusal)
  })

  it("ends once a different agent's session binds, refusing sends after it ends", () => {
    const { messaging, send, follow } = create()
    messaging.register("N", here, "t3")
    messaging.expect("N", "codex")
    follow("N", binding("claude", "s-other", "3"))
    follow("N", null)
    expect(send("A", "t3", "hi")).toEqual({
      ok: false,
      reason: "t3 has no agent running there that NovaDeck can deliver to.",
    })
  })

  it("never hands a message that waited for the first session to a later one", () => {
    const { messaging, send, follow, prompt } = create()
    messaging.register("N", here, "t3")
    messaging.expect("N", "codex")
    const { id } = sent(send("A", "t3", "for the first session"))
    const first = binding("codex", "s-first", "3")
    follow("N", first)
    // The first session ends before it ever prompts: its message is gone with it.
    follow("N", null)
    const later = binding("codex", "s-later", "4")
    follow("N", later)
    expect(prompt("N", later)).toEqual({ leaseId: null, stdout: "" })
    expect(messages(messaging, "N")).toMatchObject([{ id, state: "gone" }])
  })

  it("outlasts the restore, and is gone once another agent binds there or the terminal closes", () => {
    const records = memoryMailbox()
    const setup = create(records, { now: 1_000_000 }, { restoreMs: 60_000 })
    setup.messaging.register("N", here, "t3")
    setup.messaging.expect("N", "codex")
    setup.messaging.register("M", here, "t4")
    setup.messaging.expect("M", "agy")
    sent(setup.send("A", "t3", "for codex"))
    sent(setup.send("A", "t4", "for agy"))
    vi.advanceTimersByTime(60_000)
    expect(records.messages().map(({ state }) => state)).toEqual(["queued", "queued"])
    setup.follow("N", binding("claude", "s-claude-2", "3"))
    setup.messaging.unregister("M")
    expect(records.messages().map(({ state }) => state)).toEqual(["gone", "gone"])
    setup.messaging.close()
  })
})

describe("guards", () => {
  it("hold a thread's 13th message until the person releases it, then allow 12 more", () => {
    const { messaging, send, clock: time } = create()
    const answers = Array.from({ length: 14 }, (_, index) => {
      time.now += 30_000
      return sent(index % 2 === 0 ? send("A", "t2", `${index}`) : send("B", "t1", `${index}`))
    })
    expect(answers.slice(0, 12).every(({ state }) => state === "queued")).toBe(true)
    expect(answers.slice(12)).toMatchObject([
      { state: "held", held: "release" },
      { state: "held", held: "release" },
    ])
    const [thread] = messaging.list("A", "t1").threads
    expect(thread).toMatchObject({ hops: 14, allowed: 12, held: true })
    messaging.release(thread!.id)
    expect(messaging.list("A", "t1").threads[0]).toMatchObject({ allowed: 26, held: false })
    expect(messages(messaging, "A").every(({ state }) => state === "queued")).toBe(true)
    expect(() => messaging.release("t-unknown")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
  })

  it("hold every message while paused, across restarts, and deliver in order once resumed", () => {
    const records = memoryMailbox()
    const first = create(records)
    sent(first.send("A", "t2", "before"))
    first.messaging.pause(true)
    expect(sent(first.send("A", "t2", "during"))).toMatchObject({
      state: "held",
      held: "paused",
    })
    expect(messages(first.messaging, "A").map(({ state }) => state)).toEqual(["held", "held"])
    first.messaging.close()
    const second = create(records)
    expect(second.messaging.isPaused()).toBe(true)
    expect(second.prompt("B", second.codex)).toEqual({ leaseId: null, stdout: "" })
    second.messaging.pause(false)
    expect(records.messagingPaused()).toBe(false)
    const answer = second.prompt("B", second.codex)
    expect(answer.stdout).toMatch(/before[\s\S]*during/)
  })
})

describe("delivery through hooks", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("leases waiting messages at the recipient's prompt, delivered once acknowledged", () => {
    const { messaging, send, prompt, codex } = create()
    const { id } = sent(send("A", "t2", "Review a.ts"))
    const answer = prompt("B", codex)
    expect(answer.leaseId).toEqual(expect.any(String))
    const { hookSpecificOutput } = JSON.parse(answer.stdout!) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string }
    }
    expect(hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
    expect(hookSpecificOutput.additionalContext).toContain(
      `<message id="${id}" from="t1" agent="Claude Code"`,
    )
    expect(hookSpecificOutput.additionalContext).toContain(">Review a.ts</message>")
    expect(messages(messaging, "B")[0]).toMatchObject({ state: "leased" })
    messaging.acknowledge("B", answer.leaseId!)
    expect(messages(messaging, "B")[0]).toMatchObject({
      state: "delivered",
      deliveredAt: 1_000_000,
    })
    // Nothing more waits.
    expect(prompt("B", codex)).toEqual({ leaseId: null, stdout: "" })
  })

  it("continues a working agent's Stop with its messages, at most twice a turn", () => {
    const { messaging, send, prompt, stop, codex, clock: time } = create()
    prompt("B", codex)
    const stops = [1, 2, 3].map((index) => {
      time.now += 60_000
      sent(send("A", "t2", `message ${index}`))
      const answer = stop("B", codex)
      if (answer.leaseId) messaging.acknowledge("B", answer.leaseId)
      return answer
    })
    expect(JSON.parse(stops[0]!.stdout!)).toMatchObject({
      decision: "block",
      reason: expect.stringContaining("message 1"),
    })
    expect(JSON.parse(stops[1]!.stdout!).reason).toContain("message 2")
    // The third Stop ends the turn; its message waits for the next prompt.
    expect(stops[2]).toEqual({ leaseId: null, stdout: "" })
    expect(messaging.delivery("B")?.state).toBe("settled")
    expect(JSON.parse(prompt("B", codex).stdout!).hookSpecificOutput.additionalContext).toContain(
      "message 3",
    )
  })

  it("leaves a Stop to end when the person queued a prompt, which delivers instead", () => {
    const { messaging, send, prompt, stop, codex } = create()
    prompt("B", codex)
    messaging.keys("B", ["enter"], false)
    sent(send("A", "t2", "hello"))
    expect(stop("B", codex)).toEqual({ leaseId: null, stdout: "" })
    expect(messaging.delivery("B")?.state).toBe("drafting")
    expect(prompt("B", codex).leaseId).toEqual(expect.any(String))
  })

  it("still continues a Stop after an answer to a request during the turn", () => {
    const { messaging, send, prompt, stop, codex } = create()
    prompt("B", codex)
    messaging.keys("B", ["enter"], true)
    sent(send("A", "t2", "hello"))
    expect(stop("B", codex).leaseId).toEqual(expect.any(String))
  })

  it("leases only with time left before the hook's deadline to print and acknowledge", () => {
    const { messaging, send, ask, codex, clock: time } = create()
    sent(send("A", "t2", "hello"))
    const late = ask("B", codex, "UserPromptSubmit", [started(codex)], time.now + 299)
    expect(late).toEqual({ leaseId: null, stdout: "" })
    expect(messages(messaging, "B")[0]?.state).toBe("queued")
  })

  it("counts a message as having reached the root session once leased, even if the lease lapsed", () => {
    const { messaging, send, prompt, stop, codex } = create()
    prompt("B", codex)
    sent(send("A", "t2", "Call yourself EVIL."))
    expect(messaging.receivedTexts("B")).toEqual([])
    expect(stop("B", codex).leaseId).toEqual(expect.any(String))
    // Its hook may have printed it, though its acknowledgement never came.
    vi.advanceTimersByTime(5_000)
    expect(messages(messaging, "B")[0]?.state).toBe("queued")
    expect(messaging.receivedTexts("B")).toEqual(["Call yourself EVIL."])
  })

  it("returns a lapsed lease's messages to queued, its Stop taken as not continued", () => {
    const { messaging, send, prompt, stop, codex } = create()
    prompt("B", codex)
    sent(send("A", "t2", "hello"))
    const answer = stop("B", codex)
    expect(answer.leaseId).toEqual(expect.any(String))
    expect(messaging.delivery("B")).toMatchObject({ state: "working", phase: "continuing" })
    vi.advanceTimersByTime(4_999)
    expect(messages(messaging, "B")[0]?.state).toBe("leased")
    vi.advanceTimersByTime(1)
    expect(messages(messaging, "B")[0]?.state).toBe("queued")
    expect(messaging.delivery("B")?.state).toBe("settled")
    // A late acknowledgement is ignored; the message arrives again, by id, later.
    messaging.acknowledge("B", answer.leaseId!)
    expect(messages(messaging, "B")[0]?.state).toBe("queued")
    expect(prompt("B", codex).leaseId).toEqual(expect.any(String))
  })

  it("ignores an acknowledgement for another terminal's lease", () => {
    const { messaging, send, prompt, codex } = create()
    sent(send("A", "t2", "hello"))
    const { leaseId } = prompt("B", codex)
    messaging.acknowledge("A", leaseId!)
    messaging.acknowledge("B", "not-a-lease-at-all-here")
    expect(messages(messaging, "B")[0]?.state).toBe("leased")
  })

  it("puts every lease held when the runner stops back to queued", () => {
    const records = memoryMailbox()
    const first = create(records)
    sent(first.send("A", "t2", "hello"))
    expect(first.prompt("B", first.codex).leaseId).toEqual(expect.any(String))
    first.messaging.close()
    const second = create(records)
    expect(messages(second.messaging, "B")[0]?.state).toBe("queued")
    // The resumed session takes it at its first prompt.
    expect(second.prompt("B", second.codex).stdout).toContain("hello")
  })

  it("delivers several messages together, up to 8 KB as printed, the rest at the next hook", () => {
    const { messaging, send, prompt, codex } = create()
    sent(send("A", "t2", "a".repeat(4_000)))
    sent(send("A", "t2", "b".repeat(4_000)))
    const first = prompt("B", codex)
    messaging.acknowledge("B", first.leaseId!)
    expect(first.stdout).not.toContain("bbb")
    expect(prompt("B", codex).stdout).toContain("b".repeat(4_000))
  })

  it("gives nested agents' and other sessions' hooks nothing", () => {
    const { send, messaging, clock: time } = create()
    sent(send("A", "t2", "hello"))
    // A codex exec inside Codex: another process, another session, while Codex stays bound.
    const nested = binding("codex", "s-nested", "99")
    for (const event of ["UserPromptSubmit", "Stop"])
      expect(
        messaging.ask("B", {
          agent: "codex",
          event,
          events: [event === "Stop" ? stopped(nested) : started(nested)],
          deadline: time.now + 3_000,
        }),
      ).toEqual({ leaseId: null, stdout: "" })
    expect(messages(messaging, "B")[0]?.state).toBe("queued")
    expect(messaging.delivery("B")?.state).toBe("fresh")
  })

  it("keeps a Claude Code turn working while its background tasks run", () => {
    const { messaging, prompt, stop, claude } = create()
    prompt("A", claude)
    stop("A", claude, true)
    expect(messaging.delivery("A")).toMatchObject({ state: "working", phase: "background" })
    prompt("A", claude, "harness")
    stop("A", claude)
    expect(messaging.delivery("A")?.state).toBe("settled")
  })

  it("delivers at a Stop after background work, once the person prompts again", () => {
    const { messaging, send, prompt, stop, claude } = create()
    prompt("A", claude)
    // The turn ends with a background task still running.
    stop("A", claude, true)
    // The person's Enter starts their next prompt at once: nothing is queued.
    messaging.keys("A", ["enter"], false)
    prompt("A", claude)
    sent(send("B", "t1", "Review it"))
    expect(stop("A", claude).leaseId).toEqual(expect.any(String))
  })

  it("leaves a turn that began since alone when an older Stop's lease lapses", () => {
    const { messaging, send, prompt, stop, codex } = create()
    prompt("B", codex)
    sent(send("A", "t2", "one"))
    expect(stop("B", codex).leaseId).toEqual(expect.any(String))
    // Its acknowledgement was lost, but the harness continued, and the person prompted.
    prompt("B", codex)
    vi.advanceTimersByTime(5_000)
    expect(messaging.delivery("B")).toMatchObject({ state: "working", phase: "turn" })
  })

  it("refuses a message too large to deliver, saying how large it may be", () => {
    const { send } = create()
    expect(send("A", "t2", "&".repeat(4_000))).toEqual({
      ok: false,
      reason: expect.stringMatching(
        /^Delivered, this message would take \d+ bytes, over the 8192 a delivery may/,
      ),
    })
    expect(sent(send("A", "t2", "a".repeat(4_096)))).toMatchObject({ state: "queued" })
  })

  it("makes messages gone once restoring is over for a terminal never restored, until it is", () => {
    const records = memoryMailbox()
    const first = create(records)
    sent(first.send("A", "t2", "hello"))
    first.messaging.close()
    const second = new Messaging({ records, sweepMs: 0, restoreMs: 60_000, exists: () => true })
    second.register("A", here, "t1")
    vi.advanceTimersByTime(60_000)
    expect(records.messages()[0]?.state).toBe("gone")
    second.register("B", here, "t2")
    const root = { ...first.codex, source: "binding" } as const
    second.rooted("B", [{ type: "new", root, guess: false }])
    expect(records.messages()[0]?.state).toBe("queued")
    second.close()
  })
})

describe("change notices", () => {
  it("tell of each change to a terminal's messages and delivery state", () => {
    const { messaging, send, prompt, codex, changed } = create()
    changed.length = 0
    sent(send("A", "t2", "hello"))
    expect(changed).toEqual(["B", "A"])
    changed.length = 0
    const { leaseId } = prompt("B", codex)
    // The turn began, then its message was leased.
    expect(changed).toEqual(["B", "B", "A"])
    changed.length = 0
    messaging.acknowledge("B", leaseId!)
    expect(changed).toEqual(["B", "A"])
    changed.length = 0
    // A call within the turn changes nothing.
    prompt("B", codex, "call")
    expect(changed).toEqual([])
  })

  it("reach every listener until each stops listening", () => {
    const { messaging, send } = create()
    const first: MessagingChange[] = []
    const second: MessagingChange[] = []
    const stopFirst = messaging.subscribe((change) => first.push(change))
    messaging.subscribe((change) => second.push(change))
    sent(send("A", "t2", "hello"))
    const told = [
      { kind: "terminal", terminalId: "B" },
      { kind: "terminal", terminalId: "A" },
    ]
    expect(first).toEqual(told)
    expect(second).toEqual(told)
    stopFirst()
    sent(send("A", "t2", "again"))
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(4)
  })

  it("keep reaching the others when one listener fails", () => {
    const { messaging, send } = create()
    const heard: MessagingChange[] = []
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    messaging.subscribe(() => {
      throw new Error("broken")
    })
    messaging.subscribe((change) => heard.push(change))
    sent(send("A", "t2", "hello"))
    expect(heard).toHaveLength(2)
    expect(error).toHaveBeenCalled()
  })

  it("tell of the pause once each time it changes", () => {
    const { messaging } = create()
    const heard: MessagingChange[] = []
    messaging.subscribe((change) => heard.push(change))
    messaging.pause(true)
    messaging.pause(true)
    messaging.pause(false)
    expect(heard).toEqual([
      { kind: "pause", paused: true },
      { kind: "pause", paused: false },
    ])
  })

  it("tell both terminals of a thread released, whose hops allowed changed", () => {
    const { messaging, send, clock: time, changed } = create()
    for (let index = 0; index < 4; index++) {
      time.now += 30_000
      sent(index % 2 === 0 ? send("A", "t2", `${index}`) : send("B", "t1", `${index}`))
    }
    const [thread] = messaging.list("A", "t1").threads
    changed.length = 0
    // Nothing is held, but the thread may now go further.
    messaging.release(thread!.id)
    expect(changed.toSorted()).toEqual(["A", "B"])
  })
})

describe("gone messages", () => {
  it("are gone once the recipient's session ends, its sender told once, and wait again if it returns", () => {
    const { messaging, send, follow, codex } = create()
    const { id } = sent(send("A", "t2", "hello"))
    follow("B", null)
    expect(messages(messaging, "B")[0]?.state).toBe("gone")
    expect(send("A", "t2", "again")).toEqual({
      ok: false,
      reason: "t2 has no agent running there that NovaDeck can deliver to.",
    })
    messaging.register("C", here, "t3")
    follow("C", binding("agy", "s-agy", "5"))
    const told = sent(send("A", "t3", "first"))
    expect(told.gone).toEqual([{ id, to: "t2" }])
    expect(sent(send("A", "t3", "second")).gone).toBeUndefined()
    follow("B", codex)
    expect(messages(messaging, "B")[0]?.state).toBe("queued")
  })

  it("are gone once the harness announces a new session there, as after /clear", () => {
    const { messaging, send, follow } = create()
    sent(send("A", "t2", "hello"))
    follow("B", binding("codex", "s-cleared", "2"))
    expect(messages(messaging, "B")[0]?.state).toBe("gone")
    expect(messaging.delivery("B")?.state).toBe("fresh")
  })
})

describe("Antigravity's root conversation", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const agyTerminal = (records?: MailboxRecords) => {
    const setup = create(records)
    const root = binding("agy", "c-root", "7")
    setup.messaging.register("G", here, "t3")
    return { ...setup, root }
  }

  const invocation = (bound: Binding, number: number): HarnessEvent[] => [
    observed(bound),
    started(bound, number === 0 ? "prompt" : "call"),
  ]

  it("is the conversation of the first model call after it binds, until its status line names one", () => {
    const { messaging, ask, send, root } = agyTerminal()
    const answer = (bound: Binding, number: number) =>
      ask("G", bound, "PreInvocation", invocation(bound, number))
    expect(answer(root, 0)).toEqual({ leaseId: null, stdout: "{}\n" })
    sent(send("A", "t3", "hello"))
    // A subagent's calls are in its own conversation: they get nothing, and the binding
    // following them is no new session.
    const subagent = binding("agy", "c-sub", "7")
    expect(answer(subagent, 0)).toEqual({ leaseId: null, stdout: "{}\n" })
    expect(messages(messaging, "G")[0]?.state).toBe("queued")
    const first = answer(root, 0)
    expect(JSON.parse(first.stdout!)).toEqual({
      injectSteps: [{ ephemeralMessage: expect.stringContaining(">hello</message>") }],
    })
    messaging.acknowledge("G", first.leaseId!)
    // An injected message lasts one model call: each later call of the turn gets it again.
    const later = answer(root, 1)
    expect(later).toEqual({ leaseId: null, stdout: first.stdout })
    expect(answer(root, 2).stdout).toBe(first.stdout)
    // The next turn starts afresh.
    ask("G", root, "Stop", [stopped(root)])
    expect(answer(root, 1)).toEqual({ leaseId: null, stdout: "{}\n" })
  })

  it("is the conversation its status line names, which alone names a new one", () => {
    const { messaging, ask, observe, send, root } = agyTerminal()
    const subagent = binding("agy", "c-sub", "7")
    // Bound by a subagent's call: a guess its status line corrects.
    observe("G", subagent, invocation(subagent, 0))
    sent(send("A", "t3", "hello"))
    observe("G", root, [observed(root, true)], true)
    const answer = ask("G", root, "PreInvocation", invocation(root, 0))
    expect(answer.stdout).toContain("hello")
    messaging.acknowledge("G", answer.leaseId!)
    sent(send("A", "t3", "later"))
    // A /clear: its status line names another conversation.
    const cleared = binding("agy", "c-new", "7")
    observe("G", cleared, [observed(cleared, true)], true)
    expect(messages(messaging, "G").map(({ state }) => state)).toEqual(["delivered", "gone"])
    expect(messaging.delivery("G")?.state).toBe("fresh")
  })

  it("never makes the root's messages gone when Antigravity restarts during a subagent's work", () => {
    const records = memoryMailbox()
    const first = agyTerminal(records)
    first.observe("G", first.root, [observed(first.root, true)], true)
    sent(first.send("A", "t3", "hello"))
    first.messaging.close()
    const second = agyTerminal(records)
    // The first report after the restart is a subagent's model call.
    const subagent = binding("agy", "c-sub", "8")
    second.observe("G", subagent, [observed(subagent), started(subagent, "call")])
    expect(messages(second.messaging, "G")[0]?.state).toBe("queued")
    // The root's own call, which a message waits for, corrects the guess.
    const rooted = binding("agy", "c-root", "8")
    const answer = second.ask("G", rooted, "PreInvocation", [
      observed(rooted),
      started(rooted, "harness"),
    ])
    expect(answer.stdout).toContain("hello")
  })

  it("continues a Stop with a lasting reason, and an idle status line with no Stop is no completion", () => {
    const { messaging, ask, observe, send, root } = agyTerminal()
    observe("G", root, invocation(root, 0))
    sent(send("A", "t3", "hello"))
    const answer = ask("G", root, "Stop", [observed(root), stopped(root)])
    expect(JSON.parse(answer.stdout!)).toEqual({
      decision: "continue",
      reason: expect.stringContaining("hello"),
    })
    // The continuation's first model call, then Esc or a denial: idle, with no Stop.
    observe("G", root, [started(root, "harness")])
    const idle: HarnessEvent = { type: "turn-idle", ...fact(root), background: false }
    observe("G", root, [idle], true)
    expect(messaging.delivery("G")?.state).toBe("unknown")
    // After a Stop, idle says nothing new.
    observe("G", root, invocation(root, 0))
    ask("G", root, "Stop", [observed(root), stopped(root)])
    observe("G", root, [idle], true)
    expect(messaging.delivery("G")?.state).toBe("settled")
  })

  it("stays working at a Stop while a subagent still runs", () => {
    const { messaging, ask, observe, root } = agyTerminal()
    observe("G", root, invocation(root, 0))
    ask("G", root, "Stop", [observed(root), stopped(root, true)])
    expect(messaging.delivery("G")).toMatchObject({ state: "working", phase: "background" })
  })
})

// What the terminal manager knows of B: its title, where it works, and what it worked on.
const about = (terminalId: string): Whereabouts | undefined =>
  terminalId === "B"
    ? {
        title: "API author",
        titleSource: { kind: "person" },
        summary: null,
        folder: "src/api",
        branch: "feat/paging",
        plan: "Pagination",
        work: {
          session: "codex:s-codex",
          first: "Build the users API",
          latest: "Now add paging",
          folders: { "/w/src/api": 3, "/w/tests": 2, "/w/docs": 1, "/w/web": 1 },
          activeAt: 1_000_000,
        },
        openedBy: null,
        place: (path: string) => path.replace(/^\/w\//, ""),
      }
    : terminalId === "D"
      ? {
          title: "Web client",
          titleSource: { kind: "agent", by: "t1" },
          summary: null,
          folder: null,
          branch: null,
          plan: null,
          work: null,
          openedBy: null,
          place: (path) => path,
        }
      : undefined

describe("listing", () => {
  it("describes each other terminal by what NovaDeck knows, and the caller's messages yet to arrive", () => {
    const { messaging, send, prompt, codex, clock: time } = create()
    messaging.register("C", here, "t3")
    messaging.register("D", here, "t4")
    prompt("B", codex)
    time.now += 60_000
    const { id } = sent(send("A", "t2", "Please accommodate x, y and z in the users route."))
    expect(messaging.agents("A", about)).toEqual({
      ok: true,
      text: [
        "You are t1 in NovaDeck.",
        "Other terminals in this project and session:",
        "- t2: Codex, busy, last active 1 min ago",
        "  title: API author",
        "  folder: src/api, branch feat/paging",
        "  started with: Build the users API",
        "  latest: Now add paging",
        "  plan: Pagination",
        "  works in: src/api/ (3), tests/ (2), docs/ (1)",
        "  with you: you, just now: Please accommodate x, y and z in the users route.",
        "- t3: no agent NovaDeck can deliver to",
        "- t4: no agent NovaDeck can deliver to",
        // An agent named that one: never taken for the person's word.
        "  title: Web client (set by t1, not the user)",
        "Your messages not yet delivered:",
        `- ${id} to t2, sent ${clock(time.now)}: queued`,
      ].join("\n"),
    })
    expect(messaging.agents("C")).toEqual({
      ok: true,
      text: expect.stringMatching(/^You are t3 in NovaDeck\.\n[\s\S]*replies can't reach you/),
    })
  })

  it("lets only terminals of one project and NovaDeck session see each other", () => {
    const { messaging, follow, send } = create()
    messaging.register("O", { projectId: "p", sessionId: "other" }, "t1")
    follow("O", binding("codex", "s-o", "9"))
    const listed = messaging.agents("A")
    expect(listed.ok && listed.text.match(/^- t\d+/gm)).toEqual(["- t2"])
    expect(send("O", "t2", "hi")).toMatchObject({ ok: false })
  })

  it("gives the runner API a terminal's threads, messages and states", () => {
    const { messaging, send } = create()
    sent(send("A", "t2", "hello"))
    expect(messaging.list("B", "t2")).toEqual({
      terminalId: "B",
      handle: "t2",
      delivery: "fresh",
      paused: false,
      threads: [
        {
          id: expect.stringMatching(/^t-/),
          peer: "t1",
          hops: 1,
          allowed: 12,
          held: false,
          messages: [
            {
              id: expect.stringMatching(/^m-/),
              thread: expect.stringMatching(/^t-/),
              hop: 1,
              from: "t1",
              fromAgent: "claude",
              to: "t2",
              toAgent: "codex",
              text: "hello",
              sentAt: 1_000_000,
              state: "queued",
              held: null,
              deliveredAt: null,
            },
          ],
        },
      ],
    })
    // An exited terminal's messages are there while they are kept.
    messaging.unregister("B")
    expect(messaging.list("B", "t2")).toMatchObject({ handle: "t2", delivery: "unbound" })
    expect(messaging.list("B", "t2").threads[0]?.messages[0]?.state).toBe("gone")
  })
})

describe("retention", () => {
  it("keeps messages while either terminal exists, and for a day after their latest activity", () => {
    const kept = new Set(["A", "B"])
    const records = memoryMailbox()
    const {
      messaging,
      send,
      clock: time,
    } = create(records, { now: 1_000_000 }, { exists: (terminalId) => kept.has(terminalId) })
    sent(send("A", "t2", "hello"))
    messaging.unregister("A")
    messaging.unregister("B")
    time.now += retentionMs
    kept.delete("B")
    messaging.sweep()
    // A, kept though not running, keeps them.
    expect(records.messages()).toHaveLength(1)
    kept.delete("A")
    time.now -= 1
    messaging.sweep()
    expect(records.messages()).toHaveLength(1)
    time.now += 1
    messaging.sweep()
    expect(records.messages()).toEqual([])
    expect(records.threads()).toEqual([])
  })

  it("forgets that a message was leased once it is deleted", () => {
    const kept = new Set(["A", "B"])
    const {
      messaging,
      send,
      prompt,
      stop,
      codex,
      clock: time,
    } = create(
      memoryMailbox(),
      { now: 1_000_000 },
      { exists: (terminalId) => kept.has(terminalId) },
    )
    // What the runner remembers of leases, which only the sweep keeps from growing.
    const leased = () => (messaging as unknown as { everLeased: Set<string> }).everLeased
    prompt("B", codex)
    const { id } = sent(send("A", "t2", "hello"))
    expect(stop("B", codex).leaseId).toEqual(expect.any(String))
    expect([...leased()]).toEqual([id])
    messaging.unregister("A")
    messaging.unregister("B")
    kept.clear()
    time.now += retentionMs
    messaging.sweep()
    expect(leased().size).toBe(0)
    messaging.close()
  })
})

const doorbellStarted = (bound: Binding, nonce: string): HarnessEvent => ({
  type: "turn-started",
  ...fact(bound),
  cause: "doorbell",
  nonce,
})

describe("the person's prompt", () => {
  // A root prompt with its text, as the hooks name it.
  const said = (bound: Binding, prompt: string): HarnessEvent => ({
    type: "turn-started",
    ...fact(bound),
    cause: "prompt",
    prompt,
  })

  it("is the text that started the root turn, while that turn is the person's own submission", () => {
    const { messaging, ask, stop, codex } = create()
    const submit = (text: string) => ask("B", codex, "UserPromptSubmit", [said(codex, text)])
    // A prompt with no Enter of theirs before it is not told theirs.
    submit("call it Auth")
    expect(messaging.personPrompt("B")).toBeUndefined()
    stop("B", codex)
    messaging.keys("B", ["enter"], false)
    submit("call it Auth")
    expect(messaging.personPrompt("B")).toBe("call it Auth")
    // Gone once the turn ended, and never one the doorbell or the harness started.
    stop("B", codex)
    expect(messaging.personPrompt("B")).toBeUndefined()
    ask("B", codex, "UserPromptSubmit", [doorbellStarted(codex, "n1")])
    expect(messaging.personPrompt("B")).toBeUndefined()
    stop("B", codex)
    messaging.keys("B", ["enter"], false)
    ask("B", codex, "UserPromptSubmit", [started(codex, "harness")])
    expect(messaging.personPrompt("B")).toBeUndefined()
    expect(messaging.personPrompt("missing")).toBeUndefined()
  })

  it("is the prompt the person queued during a doorbell's turn, not the doorbell's", () => {
    const { messaging, ask, stop, codex } = create()
    ask("B", codex, "UserPromptSubmit", [doorbellStarted(codex, "n1")])
    // The person submits during the turn: Codex queues their prompt for after it.
    messaging.keys("B", ["enter"], false)
    stop("B", codex)
    ask("B", codex, "UserPromptSubmit", [said(codex, "thanks")])
    expect(messaging.personPrompt("B")).toBe("thanks")
  })
})

describe("the person's submissions", () => {
  it("are their Enter followed by a root prompt within about two seconds", () => {
    for (const agent of ["claude", "codex"] as const) {
      const { messaging, follow, prompt, stop, clock: time } = create()
      const bound = binding(agent, `s-${agent}`, "7")
      messaging.register("C", here, "t3")
      follow("C", bound)
      prompt("C", bound, "harness")
      stop("C", bound)
      expect(messaging.delivery("C")?.state).toBe("settled")
      messaging.keys("C", ["content"], false)
      expect(messaging.delivery("C")?.state).toBe("drafting")
      // A turn started with no Enter shortly before proves nothing about the box.
      prompt("C", bound, "harness")
      stop("C", bound)
      expect(messaging.delivery("C")?.state).toBe("drafting")
      // Their Enter, then the turn: what they drafted went with it.
      messaging.keys("C", ["enter"], false)
      time.now += 2_000
      prompt("C", bound, "prompt")
      stop("C", bound)
      expect(messaging.delivery("C")?.state).toBe("settled")
      // An Enter too long before is not the turn's.
      messaging.keys("C", ["content"], false)
      messaging.keys("C", ["enter"], false)
      time.now += 2_001
      prompt("C", bound, "prompt")
      stop("C", bound)
      expect(messaging.delivery("C")?.state).toBe("drafting")
    }
  })

  it("are never a turn a harness started, unless its adapter turned it into a prompt", () => {
    const { messaging, follow, prompt, stop, clock: time } = create()
    const agy = binding("agy", "c-root", "7")
    messaging.register("C", here, "t3")
    follow("C", agy)
    prompt("C", agy, "harness")
    stop("C", agy)
    expect(messaging.delivery("C")?.state).toBe("settled")
    messaging.keys("C", ["content"], false)
    messaging.keys("C", ["enter"], false)
    time.now += 500
    prompt("C", agy, "harness")
    stop("C", agy)
    expect(messaging.delivery("C")?.state).toBe("drafting")
  })

  it("count a prompt queued during the turn, which the harness submits as it ends", () => {
    const { messaging, prompt, stop, codex, clock: time } = create()
    messaging.keys("B", ["content"], false)
    messaging.keys("B", ["enter"], false)
    prompt("B", codex)
    // Typed and queued with Tab during the turn.
    messaging.keys("B", ["content"], false)
    messaging.keys("B", ["enter"], false)
    time.now += 30_000
    stop("B", codex)
    expect(messaging.delivery("B")?.state).toBe("drafting")
    time.now += 30_000
    prompt("B", codex)
    stop("B", codex)
    expect(messaging.delivery("B")?.state).toBe("settled")
  })

  it("never count an answer to a request", () => {
    const { messaging, prompt, stop, codex } = create()
    prompt("B", codex)
    stop("B", codex)
    messaging.keys("B", ["content"], false)
    messaging.keys("B", ["enter"], true)
    prompt("B", codex)
    stop("B", codex)
    expect(messaging.delivery("B")?.state).toBe("drafting")
  })
})

describe("ringing", () => {
  // Codex settled after a turn, with a message waiting.
  const settledWithMail = () => {
    const setup = create()
    setup.prompt("B", setup.codex)
    setup.stop("B", setup.codex)
    sent(setup.send("A", "t2", "Review a.ts"))
    // Past the time its screen has to settle.
    setup.clock.now += 6_000
    return setup
  }

  it("is allowed once per Settled period, with messages waiting for the root session", () => {
    const { messaging, prompt, stop, send, codex, clock: time } = create()
    prompt("B", codex)
    stop("B", codex)
    time.now += 6_000
    expect(messaging.ringable("B")).toBe(false)
    sent(send("A", "t2", "hello"))
    expect(messaging.ringable("B")).toBe(true)
    expect(messaging.ring("B", "n1")).toBe(true)
    expect(messaging.ringing("B")).toBe("n1")
    expect(messaging.ringable("B")).toBe(false)
    messaging.ringFailed("B", "n1")
    expect(messaging.delivery("B")?.state).toBe("unknown")
    // Not again until a new turn settles.
    expect(messaging.ring("B", "n2")).toBe(false)
  })

  it("is confirmed by its doorbell prompt, whose hook delivers", () => {
    const { messaging, ask, codex } = settledWithMail()
    messaging.ring("B", "n1")
    const answer = ask("B", codex, "UserPromptSubmit", [doorbellStarted(codex, "n1")])
    expect(answer.leaseId).toEqual(expect.any(String))
    expect(answer.stdout).toContain(">Review a.ts</message>")
    expect(messaging.ringing("B")).toBeUndefined()
    expect(messaging.delivery("B")).toMatchObject({ state: "working", phase: "turn" })
  })

  it("tells a doorbell prompt with nothing left for it that it can be ignored", () => {
    const { messaging, ask, codex, prompt, stop } = create()
    prompt("B", codex)
    stop("B", codex)
    const answer = ask("B", codex, "UserPromptSubmit", [doorbellStarted(codex, "old")])
    expect(answer.leaseId).toBeNull()
    expect(answer.stdout).toContain("no agent messages are waiting")
    expect(messaging.delivery("B")).toMatchObject({ state: "working", box: { empty: true } })
  })

  it("gives way to another prompt, the ring then over", () => {
    const { messaging, prompt, codex } = settledWithMail()
    messaging.ring("B", "n1")
    expect(messaging.delivery("B")?.state).toBe("ringing")
    expect(prompt("B", codex).leaseId).toEqual(expect.any(String))
    expect(messaging.ringing("B")).toBeUndefined()
    messaging.ringFailed("B", "n1")
    expect(messaging.delivery("B")?.state).toBe("working")
  })

  it("tells of each change, for the doorbell to look again", () => {
    const { messaging, changed } = settledWithMail()
    changed.length = 0
    messaging.ring("B", "n1")
    messaging.ringFailed("B", "n1")
    expect(changed).toEqual(["B", "B"])
  })
})

describe("untouched, erring toward Drafting", () => {
  // Codex settled after the person's own turn.
  const settledCodex = () => {
    const setup = create()
    setup.messaging.keys("B", ["enter"], false)
    setup.prompt("B", setup.codex)
    setup.stop("B", setup.codex)
    expect(setup.messaging.delivery("B")?.state).toBe("settled")
    return setup
  }

  it("keeps a draft typed after the Enter, before its prompt's hook", () => {
    const { messaging, prompt, stop, codex, clock: time } = settledCodex()
    messaging.keys("B", ["content"], false)
    messaging.keys("B", ["enter"], false)
    time.now += 50
    // The person types on before the hook reports: that stays in the box.
    messaging.keys("B", ["content"], false)
    time.now += 400
    prompt("B", codex)
    stop("B", codex)
    expect(messaging.delivery("B")?.state).toBe("drafting")
  })

  it("keeps a draft typed after an Enter queued during the turn", () => {
    const { messaging, prompt, stop, codex, clock: time } = settledCodex()
    messaging.keys("B", ["enter"], false)
    prompt("B", codex)
    messaging.keys("B", ["content"], false)
    messaging.keys("B", ["enter"], false)
    time.now += 1_000
    // The next thought, typed while the queued prompt waits.
    messaging.keys("B", ["content"], false)
    time.now += 20_000
    stop("B", codex)
    time.now += 200
    prompt("B", codex)
    stop("B", codex)
    expect(messaging.delivery("B")?.state).toBe("drafting")
  })

  it("never takes a turn its harness started for the person's, whatever was typed before", () => {
    const { messaging, prompt, stop, codex, clock: time } = settledCodex()
    messaging.keys("B", ["content"], false)
    messaging.keys("B", ["enter"], false)
    time.now += 800
    prompt("B", codex, "harness")
    stop("B", codex)
    expect(messaging.delivery("B")?.state).toBe("drafting")
  })

  it("takes a failed ring's line as a draft, as it stays in the box", () => {
    const { messaging, prompt, stop, send, codex, clock: time } = settledCodex()
    sent(send("A", "t2", "hello"))
    time.now += 6_000
    messaging.ring("B", "n1")
    messaging.ringFailed("B", "n1")
    prompt("B", codex, "harness")
    stop("B", codex)
    expect(messaging.delivery("B")?.state).toBe("drafting")
    expect(messaging.ringable("B")).toBe(false)
  })

  it("takes a ring a turn cut short as a draft, its line left in the box", () => {
    const { messaging, prompt, stop, send, codex, clock: time } = settledCodex()
    sent(send("A", "t2", "hello"))
    time.now += 6_000
    messaging.ring("B", "n1")
    prompt("B", codex, "harness")
    stop("B", codex)
    expect(messaging.delivery("B")?.state).toBe("drafting")
  })

  // The settle window itself is the doorbell's: see terminals/doorbell.test.ts.
  it("tells the doorbell since when it is Settled, for its screen to settle first", () => {
    const { messaging, send, prompt, stop, codex, clock: time } = settledCodex()
    expect(messaging.settledSince("B")).toBe(time.now)
    sent(send("A", "t2", "hello"))
    expect(messaging.ringable("B")).toBe(true)
    time.now += 1_000
    messaging.keys("B", ["enter"], false)
    prompt("B", codex)
    expect(messaging.settledSince("B")).toBeUndefined()
    stop("B", codex)
    expect(messaging.settledSince("B")).toBe(time.now)
  })

  it("tells a doorbell whose messages it couldn't lease that they still wait", () => {
    const { messaging, ask, send, codex } = settledCodex()
    sent(send("A", "t2", "hello"))
    messaging.pause(true)
    const held = ask("B", codex, "UserPromptSubmit", [doorbellStarted(codex, "n1")])
    expect(held.stdout).toContain("still waiting")
    expect(held.stdout).not.toContain("no agent messages are waiting")
    messaging.pause(false)
    const late = ask(
      "B",
      codex,
      "UserPromptSubmit",
      [doorbellStarted(codex, "n2")],
      1_000_000 + 100,
    )
    expect(late.stdout).toContain("still waiting")
  })
})

describe("a task's checks", () => {
  it("are send's own: its size once delivered, and the rates", () => {
    const { messaging, send, clock: time } = create()
    expect(messaging.refusal("A", "Review a.ts", "codex")).toBeUndefined()
    expect(messaging.refusal("A", " ", "codex")).toBe("The message is empty.")
    expect(messaging.refusal("A", "&".repeat(4_000), "codex")).toMatch(
      /^Delivered, this message would take \d+ bytes/,
    )
    for (let index = 0; index < 10; index += 1) {
      if (index % 3 === 0) time.now += 1
      messaging.register(`R${index}`, here, `t${index + 3}`)
      messaging.expect(`R${index}`, "codex")
      sent(send("A", `t${index + 3}`, `message ${index}`))
    }
    expect(messaging.refusal("A", "one more", "codex")).toMatch(/^An agent may send 10 messages/)
  })
})

describe("keys while a request waits on the person", () => {
  it("are never a submission, so its turn's Stop still continues", () => {
    const { messaging, prompt, stop, send, codex } = create()
    messaging.keys("B", ["enter"], false)
    prompt("B", codex)
    // Each question: Down to pick, Enter to take it; then Enter sends the form.
    for (const key of ["content", "enter", "content", "enter", "enter"] as const)
      messaging.keys("B", [key], true)
    messaging.askedCleared("B")
    sent(send("A", "t2", "hello"))
    expect(stop("B", codex).leaseId).toEqual(expect.any(String))
    // Down may have changed the box, and no submission since confirmed it empty.
    prompt("B", codex, "harness")
    stop("B", codex)
    expect(messaging.delivery("B")?.state).toBe("drafting")
  })

  it("leave a sticky draft for a key that may change the box, whatever Enter follows", () => {
    const { messaging, prompt, stop, codex } = create()
    messaging.keys("B", ["enter"], false)
    prompt("B", codex)
    // A hotkey, then Enter: it may have answered the dialog, or put a newline in the box.
    messaging.keys("B", ["content"], true)
    messaging.keys("B", ["enter"], true)
    messaging.askedCleared("B")
    stop("B", codex)
    expect(messaging.delivery("B")?.state).toBe("drafting")
  })

  it("leave the box empty when only Enter answered", () => {
    const { messaging, prompt, stop, codex } = create()
    messaging.keys("B", ["enter"], false)
    prompt("B", codex)
    messaging.keys("B", ["enter"], true)
    messaging.askedCleared("B")
    stop("B", codex)
    expect(messaging.delivery("B")?.state).toBe("settled")
  })

  it("take the person's confirmed submission as emptying the box again", () => {
    const { messaging, prompt, stop, codex, clock: time } = create()
    messaging.keys("B", ["enter"], false)
    prompt("B", codex)
    messaging.keys("B", ["content"], true)
    messaging.askedCleared("B")
    stop("B", codex)
    expect(messaging.delivery("B")?.state).toBe("drafting")
    messaging.keys("B", ["enter"], false)
    time.now += 500
    prompt("B", codex)
    stop("B", codex)
    expect(messaging.delivery("B")?.state).toBe("settled")
  })
})

describe("a ring's confirmation", () => {
  it("takes a Claude Code or Codex doorbell prompt as one only with the ring's own nonce", () => {
    for (const agent of ["claude", "codex"] as const) {
      const { messaging, follow, prompt, stop, ask, send, clock: time } = create()
      const bound = binding(agent, `s-${agent}-2`, "8")
      messaging.register("C", here, "t3")
      follow("C", bound)
      messaging.keys("C", ["enter"], false)
      prompt("C", bound)
      stop("C", bound)
      sent(send("A", "t3", "hello"))
      time.now += 6_000
      expect(messaging.ring("C", "n1")).toBe(true)
      // A stale line, submitted alone: its prompt is no confirmation of this ring.
      ask("C", bound, "UserPromptSubmit", [doorbellStarted(bound, "old")])
      expect(messaging.ringing("C")).toBeUndefined()
      stop("C", bound)
      expect(messaging.delivery("C")?.state).toBe("drafting")
    }
  })
})

describe("Antigravity's prompts, told from its transcript", () => {
  const agy = binding("agy", "c-root", "7")
  const root = { ...agy, source: "status-line" } as const
  const harnessTurn: HarnessEvent = { type: "turn-started", ...fact(agy), cause: "harness" }
  // The turn's facts as the terminal manager tells them from the transcript's last typed entry.
  const told = (
    text: string,
    id: number,
    given: { seen?: number; enteredAt?: number; startedWith?: string },
  ) =>
    typedPromptStart(
      [harnessTurn],
      {
        root,
        typedEntry: harnesses.agy.messaging.typedEntry!,
        transcript: "/t.jsonl",
        seen: given.seen,
        enteredAt: given.enteredAt,
        waiting: false,
        startedWith: given.startedWith,
      },
      () => Promise.resolve({ text, at: null, id }),
    )

  it("tells a start with a task, while messaging is paused, that its messages still wait", async () => {
    const { messaging, follow, send, ask } = create()
    messaging.register("G", here, "t3")
    messaging.expect("G", "agy")
    sent(send("A", "t3", "Review a.ts"))
    messaging.pause(true)
    follow("G", agy)
    // `agy -i "<line>"`: its first turn, the line its transcript records as typed.
    const { events } = await told(doorbellLine("k3f9q2"), 0, { startedWith: "k3f9q2" })
    expect(events).toMatchObject([{ cause: "doorbell", nonce: "k3f9q2" }])
    const answer = ask("G", agy, "PreInvocation", [...events])
    expect(answer.leaseId).toBeNull()
    expect(answer.stdout).toContain("still waiting")
  })

  it("takes a stale line typed with the person's text as their prompt, the line removed", async () => {
    const { messaging, follow, ask, stop, clock: time } = create()
    messaging.register("G", here, "t3")
    follow("G", agy)
    ask("G", agy, "PreInvocation", [harnessTurn])
    stop("G", agy)
    messaging.keys("G", ["content"], false)
    expect(messaging.delivery("G")?.state).toBe("drafting")
    messaging.keys("G", ["enter"], false)
    time.now += 500
    const { events } = await told(`${doorbellLine("old")}fix the build`, 12, {
      seen: 9,
      enteredAt: time.now - 500,
    })
    expect(events).toMatchObject([{ cause: "prompt", prompt: "fix the build" }])
    ask("G", agy, "PreInvocation", [...events])
    stop("G", agy)
    expect(messaging.delivery("G")?.state).toBe("settled")
  })
})
