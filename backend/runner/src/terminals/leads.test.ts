import type { AgentMode, AgentName } from "@novadeck/protocol"
import { afterEach, beforeEach, vi } from "vitest"

import { Messaging } from "../messaging/messaging.js"
import type { PeerAnswer } from "../messaging/sending.js"
import { describe, expect, it } from "../test.js"
import { Approvals } from "./approvals.js"
import type { Bindings } from "./binding/facts.js"
import { Leads, leadNotice, nobodyToLead, type LeadsHost } from "./leads.js"
import type { Record } from "./record.js"
import type { Sleepers } from "./sleepers.js"
import { Teams, teamNotice } from "./teams.js"

const token = "t".repeat(48)

// A terminal as far as leading reads it: `ledBy` is what it persists, the lead's terminal id.
const terminal = (handle: string, ledBy: string | null): Record =>
  ({
    summary: { id: `id-${handle}`, handle, title: "Terminal", sessionId: "session", ledBy },
    terminal: { exiting: false },
    token,
    closed: false,
  }) as unknown as Record

// Leads over a runner of fakes: terminals with the agent each runs and who leads them
// (`ledBy` is the lead's handle, which the terminal keeps as the lead's id), and a record of what was sent, noticed and saved.
const setup = (terminals: {
  [handle: string]: {
    agent: AgentName | null
    ledBy?: string
    asleep?: true
  }
}) => {
  // A sleeper has no record: the sleepers hear of the wake it is asked for.
  const records = new Map(
    Object.entries(terminals)
      .filter(([, { asleep }]) => !asleep)
      .map(([handle, { ledBy }]) => [
        `id-${handle}`,
        terminal(handle, ledBy ? `id-${ledBy}` : null),
      ]),
  )
  const approvals = new Approvals()
  // The agent messages reach in each terminal, by handle, with its root session: what the
  // tests change to end or swap an agent while its shell stays open.
  const agents = new Map<string, { agent: AgentName; sessionId: string | null } | undefined>(
    Object.entries(terminals).map(([handle, { agent }]) => [
      handle,
      agent === null ? undefined : { agent, sessionId: `s-${handle}` },
    ]),
  )
  const notices: { to: string; text: string; always?: true }[] = []
  const sent: { from: string; to: string; text: string }[] = []
  const saved: string[] = []
  const dropped: string[] = []
  let stopping = false
  let mode: AgentMode = "herd"
  const introduced: string[] = []
  type Sending =
    | {
        ok: true
        id: string
        to?: string
        state?: string
        held?: string
        why?: string
        gone?: object[]
        holds?: string[]
      }
    | { ok: false; reason: string }
  let sending: Sending = { ok: true, id: "m1" }
  let marked = true
  // The state of each message and who hears of a terminal's messages changing, as messaging does.
  const states = new Map<string, string>()
  // The brief each terminal's lead ends with, by terminal id.
  const briefs = new Map<string, string>()
  const listeners = new Set<(change: { kind: "terminal"; terminalId: string }) => void>()
  // Whom each sleeper's lead is, by terminal id: messaging holds a sleeper's lead as a running one's.
  const rested = new Map(
    Object.entries(terminals)
      .filter(([, { asleep }]) => asleep)
      .map(([handle, { ledBy }]) => [`id-${handle}`, ledBy ? `id-${ledBy}` : null]),
  )
  const handleOf = (id: string) => id.replace(/^id-/, "")
  const sleeping = (id: string) => rested.has(id) && !records.has(id)
  // The lead is the terminal `ledBy` names, running or asleep, in the same session.
  const leadOf = (id: string) => {
    const by = records.get(id)?.summary.ledBy ?? rested.get(id)
    return by && (records.has(by) || sleeping(by))
      ? { terminalId: by, handle: handleOf(by) }
      : undefined
  }
  const host = {
    agentMode: () => mode,
    records: () => records,
    stopping: () => stopping,
    closingNow: () => false,
    approvals: () => approvals,
    sleepers: () =>
      ({
        sleepersOf: () =>
          [...rested.keys()].filter(sleeping).map((id) => ({
            summary: { id, handle: handleOf(id), title: "Terminal", sessionId: "session" },
          })),
        setLead: (id: string, leadId: string) => {
          rested.set(id, leadId)
          saved.push(`${handleOf(id)} asleep, led by ${handleOf(leadId)}`)
        },
        endLead: (id: string) => {
          rested.set(id, null)
          saved.push(`${handleOf(id)} asleep, unled`)
        },
        peer: (id: string) => {
          const handle = Object.keys(terminals).find((each) => `id-${each}` === id)
          return handle && terminals[handle]?.asleep && !records.has(id)
            ? {
                summary: {
                  id,
                  handle,
                  title: "Terminal",
                  sessionId: "session",
                  ledBy: rested.get(id) ?? null,
                },
              }
            : undefined
        },
        resting: (id: string) => {
          const handle = Object.keys(terminals).find((each) => `id-${each}` === id)
          return handle && terminals[handle]?.asleep && !records.has(id)
            ? { agent: terminals[handle].agent, sessionId: `s-${handle}` }
            : undefined
        },
      }) as unknown as Sleepers,
    messaging: () =>
      ({
        leadOf,
        isFromLead: () => marked,
        stateOf: (id: string) => states.get(id),
        briefOf: (terminalId: string) => briefs.get(terminalId),
        subscribe: (listener: (change: { kind: "terminal"; terminalId: string }) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        agentIn: (id: string) => {
          const found = agents.get(handleOf(id))
          return found
            ? { ok: true, ...found }
            : {
                ok: false,
                code: "none",
                reason: `@${handleOf(id)} has no agent running there that Novadeck can deliver to.`,
              }
        },
        dropLeadMessages: (id: string) => {
          dropped.push(id)
          saved.push(`dropped for ${id}`)
        },
        notice: (to: string, text: string, options?: { always?: boolean }) => {
          notices.push({ to, text, ...(options?.always && { always: true }) })
          return true
        },
        send: (from: string, request: { to: string; text: string }) => {
          sent.push({ from, ...request })
          return sending
        },
      }) as unknown as Messaging,
    peers: () => ({
      introduce: (from: string, ...ids: string[]) =>
        void introduced.push(...ids.map((id) => `${from}>${id}`)),
      target: async (_caller: unknown, to: string): Promise<PeerAnswer> => {
        const known = to in terminals
        return known
          ? {
              ok: true,
              terminalId: `id-${to}`,
              handle: to,
              agent: terminals[to]?.agent ?? null,
            }
          : { ok: false, reason: `"${to}" is no terminal's handle here.` }
      },
    }),
    bindings: () =>
      ({
        setLead: (record: Record, leadId: string) => {
          record.summary = { ...record.summary, ledBy: leadId }
          saved.push(`${record.summary.handle} led by ${records.get(leadId)?.summary.handle}`)
        },
        endLead: (record: Record) => {
          record.summary = { ...record.summary, ledBy: null }
          saved.push(`${record.summary.handle} unled`)
        },
      }) as unknown as Bindings,
  } as unknown as LeadsHost
  const leads = new Leads(host)
  const teams = new Teams(host, leads)
  const call = (
    type: "lead" | "release" | "join" | "leave" | "handLead",
    from: string,
    request: object,
  ) => ({
    type,
    terminalId: `id-${from}`,
    token,
    request: request as { [key: string]: unknown },
  })
  return {
    leads,
    approvals,
    records,
    notices,
    sent,
    saved,
    dropped,
    agents,
    lead: (from: string, to: string, message = "Review the diff.") =>
      leads.lead(call("lead", from, { to, message })),
    release: (from: string, to: string) => leads.release(call("release", from, { to })),
    join: (from: string, to: string, request: object = {}) =>
      teams.join(call("join", from, { to, ...request })),
    leave: (from: string) => teams.leave(call("leave", from, {})),
    hand: (from: string, to: string) => teams.hand(call("handLead", from, { to })),
    mode: (next: AgentMode) => (mode = next),
    introduced,
    sending: (next: Sending) => (sending = next),
    marking: (next: boolean) => (marked = next),
    stop: () => (stopping = true),
    listening: () => listeners.size,
    // The terminal's lead waits for this brief.
    briefing: (terminalId: string, id: string) => briefs.set(terminalId, id),
    unbrief: (terminalId: string) => briefs.delete(terminalId),
    // A message of the terminal moves to `state`, which its listeners hear.
    forget: (id: string, terminalId: string) => {
      states.delete(id)
      for (const listener of listeners) listener({ kind: "terminal", terminalId })
    },
    moved: (id: string, state: string, terminalId: string) => {
      states.set(id, state)
      for (const listener of listeners) listener({ kind: "terminal", terminalId })
    },
  }
}

// The client following the approvals, collecting what it is sent.
const person = (approvals: Approvals) => {
  const items: { type: string; requestId: string; action?: unknown }[] = []
  void (async () => {
    for await (const item of approvals.follow("person")) items.push(item)
  })()
  return items
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const settle = () => vi.advanceTimersByTimeAsync(0)

describe("an agent asking to lead or release a sleeper", () => {
  it("is told it is asleep and that a message wakes it, and nothing changes", async () => {
    const run = setup({
      moth: { agent: "claude" },
      fox: { agent: "codex", asleep: true },
      owl: { agent: "claude", asleep: true, ledBy: "moth" },
    })
    const asked = person(run.approvals)
    const lead = await run.lead("moth", "fox")
    expect(lead).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/@fox's agent is asleep.*message to it wakes it/s),
    })
    const release = await run.release("moth", "owl")
    expect(release).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/@owl's agent is asleep.*message to it wakes it/s),
    })
    await settle()
    expect(asked).toEqual([])
    expect(run.sent).toEqual([])
    expect(run.saved).toEqual([])
  })
})

describe("an agent asking to lead another terminal's agent", () => {
  it("asks the person at once, carrying the brief, and links nothing yet", async () => {
    const run = setup({ moth: { agent: "claude" }, fox: { agent: "codex" } })
    const asked = person(run.approvals)
    await expect(run.lead("moth", "fox")).resolves.toEqual({
      ok: true,
      asked: true,
      handle: "fox",
      title: "Terminal",
      ran: "Codex",
    })
    await settle()
    expect(asked).toEqual([
      {
        type: "request",
        requestId: expect.any(String),
        from: "id-moth",
        terminalId: "id-fox",
        sessionId: "session",
        action: { type: "lead", brief: "Review the diff." },
      },
    ])
    expect(run.records.get("id-fox")!.summary.ledBy).toBeNull()
    expect(run.sent).toEqual([])
  })

  it.each([
    ["itself", { moth: { agent: "claude" as const } }, "moth", "moth", /lead yourself/],
    [
      "a terminal that is not there",
      { moth: { agent: "claude" as const } },
      "moth",
      "owl",
      /no terminal's handle/,
    ],
    [
      "a terminal that runs no agent",
      { moth: { agent: "claude" as const }, fox: { agent: null } },
      "moth",
      "fox",
      /no agent running there.*open_agent/,
    ],
    [
      "a terminal it already leads",
      { moth: { agent: "claude" as const }, fox: { agent: "codex" as const, ledBy: "moth" } },
      "moth",
      "fox",
      /already lead @fox/,
    ],
    [
      "a terminal another running agent leads",
      {
        moth: { agent: "claude" as const },
        fox: { agent: "codex" as const, ledBy: "owl" },
        owl: { agent: "claude" as const },
      },
      "moth",
      "fox",
      /already has a lead, @owl/,
    ],
    [
      "the agent that leads it",
      { moth: { agent: "claude" as const, ledBy: "fox" }, fox: { agent: "codex" as const } },
      "moth",
      "fox",
      /leads you/,
    ],
    [
      "an agent above its own lead",
      {
        moth: { agent: "claude" as const, ledBy: "owl" },
        owl: { agent: "claude" as const, ledBy: "fox" },
        fox: { agent: "codex" as const },
      },
      "moth",
      "fox",
      /leads you, directly or through/,
    ],
  ])("refuses at once to lead %s", async (_name, terminals, from, to, reason) => {
    const run = setup(terminals)
    person(run.approvals)
    const answer = await run.lead(from, to)
    expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(reason) })
    await settle()
    expect(run.saved).toEqual([])
  })

  it("refuses while an approval already waits for that terminal, and when nobody can be asked", async () => {
    const run = setup({
      moth: { agent: "claude" },
      fox: { agent: "codex" },
      owl: { agent: "claude" },
    })
    await expect(run.lead("moth", "fox")).resolves.toEqual({
      ok: false,
      reason: nobodyToLead,
    })
    person(run.approvals)
    await expect(run.lead("moth", "fox")).resolves.toMatchObject({ ok: true })
    await expect(run.lead("owl", "fox")).resolves.toEqual({
      ok: false,
      reason: "@fox is already waiting for the user's approval.",
    })
  })

  it("refuses a brief over 4 KB, and a request with anything else", async () => {
    const run = setup({ moth: { agent: "claude" }, fox: { agent: "codex" } })
    person(run.approvals)
    await expect(run.lead("moth", "fox", "x".repeat(4097))).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/The brief is 4097 bytes, over the 4096/),
    })
    await expect(
      run.leads.lead({ type: "lead", terminalId: "id-moth", token, request: { to: "fox" } }),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/needs `to`/) })
  })

  it("asks the person about the brief as it will be delivered, cleaned of invisible characters", async () => {
    const run = setup({ moth: { agent: "claude" }, fox: { agent: "codex" } })
    const asked = person(run.approvals)
    await run.lead("moth", "fox", "Fix\u202e the\u200b lint.")
    await settle()
    expect(asked[0]).toMatchObject({ action: { type: "lead", brief: "Fix the lint." } })
    run.approvals.answer({ requestId: asked[0]!.requestId, approved: true }, "person")
    await settle()
    expect(run.sent).toEqual([{ from: "id-moth", to: "fox", text: "Fix the lint." }])
  })

  it("refuses a brief that is empty once cleaned, before asking the person", async () => {
    const run = setup({ moth: { agent: "claude" }, fox: { agent: "codex" } })
    const asked = person(run.approvals)
    await expect(run.lead("moth", "fox", "\u200b \u202e")).resolves.toMatchObject({
      ok: false,
      reason: "The brief is empty.",
    })
    await settle()
    expect(asked).toEqual([])
  })

  it("refuses before asking when the caller's own agent session is not bound", async () => {
    const run = setup({ moth: { agent: "claude" }, fox: { agent: "codex" } })
    const asked = person(run.approvals)
    // Only expected or shown, no root session yet.
    run.agents.set("moth", { agent: "claude", sessionId: null })
    await expect(run.lead("moth", "fox")).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("hasn't seen this terminal's own agent session"),
    })
    // Nothing at all, as with Codex hooks not trusted.
    run.agents.set("moth", undefined)
    await expect(run.lead("moth", "fox")).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("hooks run here"),
    })
    await settle()
    expect(asked).toEqual([])
  })

  it("learns nothing without the terminal's own token", async () => {
    const run = setup({ moth: { agent: "claude" }, fox: { agent: "codex" } })
    await expect(
      run.leads.lead({
        type: "lead",
        terminalId: "id-moth",
        token: "f".repeat(48),
        request: { to: "fox", message: "Hi" },
      }),
    ).resolves.toMatchObject({ ok: false })
  })
})

describe("an agent leading another terminal's agent where agents decide for themselves", () => {
  it("leads at once, sends the brief as the lead, and asks the person nothing", async () => {
    const run = setup({ moth: { agent: "claude" }, fox: { agent: "codex" } })
    run.mode("swarm")
    const asked = person(run.approvals)
    await expect(run.lead("moth", "fox")).resolves.toEqual({
      ok: true,
      led: true,
      handle: "fox",
      title: "Terminal",
      ran: "Codex",
      brief: "Your brief, message m1, is sent; its replies arrive by themselves.",
    })
    await settle()
    expect(asked).toEqual([])
    expect(run.records.get("id-fox")!.summary.ledBy).toBe("id-moth")
    expect(run.sent).toEqual([{ from: "id-moth", to: "fox", text: "Review the diff." }])
    expect(run.notices).toEqual([
      { to: "id-fox", always: true, text: leadNotice.nowLed("moth", false) },
    ])
    expect(leadNotice.nowLed("moth", false)).not.toContain("The user")
  })

  it("leads with no client to ask, and says when the brief wasn't sent", async () => {
    const run = setup({ moth: { agent: "claude" }, fox: { agent: "codex" } })
    run.mode("swarm")
    run.sending({ ok: false, reason: "the message is empty." })
    await expect(run.lead("moth", "fox")).resolves.toMatchObject({
      ok: true,
      led: true,
      brief: "Your brief wasn't sent: the message is empty. Send it again with send.",
    })
    expect(run.records.get("id-fox")!.summary.ledBy).toBe("id-moth")
  })

  it("keeps its refusals: a lead already, no agent, or the caller's own lead", async () => {
    const run = setup({
      moth: { agent: "claude" as const, ledBy: "owl" },
      owl: { agent: "claude" as const },
      fox: { agent: "codex" as const, ledBy: "owl" },
      ant: { agent: null },
    })
    run.mode("swarm")
    expect(await run.lead("moth", "fox")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/already has a lead/),
    })
    expect(await run.lead("moth", "ant")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no agent running/),
    })
    expect(await run.lead("moth", "owl")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/leads you/),
    })
    expect(run.saved).toEqual([])
  })

  it("reads the mode at each call: Herd asks again", async () => {
    const run = setup({
      moth: { agent: "claude" },
      fox: { agent: "codex" },
      owl: { agent: "agy" },
    })
    person(run.approvals)
    run.mode("swarm")
    expect(await run.lead("moth", "fox")).toMatchObject({ led: true })
    run.mode("herd")
    expect(await run.lead("moth", "owl")).toMatchObject({ asked: true })
    expect(run.records.get("id-owl")!.summary.ledBy).toBeNull()
  })
})

describe("the person answering a request to lead", () => {
  const asking = async () => {
    const run = setup({ moth: { agent: "claude" }, fox: { agent: "codex" } })
    const asked = person(run.approvals)
    await run.lead("moth", "fox")
    await settle()
    const answer = (approved: boolean) => {
      run.approvals.answer({ requestId: asked[0]!.requestId, approved }, "person")
      return settle()
    }
    return { run, answer }
  }

  it("links the terminals, tells both, and sends the brief as the lead", async () => {
    const { run, answer } = await asking()
    await answer(true)
    expect(run.records.get("id-fox")!.summary.ledBy).toBe("id-moth")
    expect(run.saved).toEqual(["fox led by moth"])
    expect(run.sent).toEqual([{ from: "id-moth", to: "fox", text: "Review the diff." }])
    expect(run.notices).toEqual([
      { to: "id-fox", always: true, text: leadNotice.nowLed("moth") },
      {
        to: "id-moth",
        always: true,
        text: leadNotice.led("fox", "Terminal", {
          ok: true,
          text: "Your brief, message m1, is sent; its replies arrive by themselves.",
        }),
      },
    ])
  })

  it("tells what the brief's send answered: held, gone messages, and holds", async () => {
    const { run, answer } = await asking()
    run.sending({
      ok: true,
      id: "m2",
      state: "held",
      held: "paused",
      gone: [{ id: "m0", to: "fox", released: true }],
      holds: ["Your messages to @fox are held."],
    })
    await answer(true)
    const text = run.notices.at(-1)!.text
    expect(text).toContain("Your brief, message m2, is held: the user paused messaging")
    expect(text).toContain("Your earlier message m0 to @fox won't arrive: the user released")
    expect(text).toContain("Your messages to @fox are held.")
    expect(text).not.toContain("is sent")
  })

  it("says no brief went out when the identical earlier message it matched is gone", async () => {
    const { run, answer } = await asking()
    run.sending({ ok: true, id: "m3", state: "gone" })
    await answer(true)
    const text = run.notices.at(-1)!.text
    expect(text).toContain("won't arrive: no brief went out")
    expect(text).not.toContain("is sent")
  })

  it("does not claim a lead-marked brief went when an identical earlier message stood in", async () => {
    const { run, answer } = await asking()
    run.marking(false)
    await answer(true)
    expect(run.notices.at(-1)!.text).toContain("no lead-marked brief went out")
  })

  it("still links when the brief can't be sent, and says so", async () => {
    const { run, answer } = await asking()
    run.sending({ ok: false, reason: "Too long." })
    await answer(true)
    expect(run.records.get("id-fox")!.summary.ledBy).toBe("id-moth")
    expect(run.notices.at(-1)!.text).toBe(
      leadNotice.led("fox", "Terminal", { ok: false, reason: "Too long." }),
    )
  })

  it("links nothing when the target lost its agent meanwhile, and tells the caller", async () => {
    const { run, answer } = await asking()
    run.agents.set("fox", undefined)
    await answer(true)
    expect(run.records.get("id-fox")!.summary.ledBy).toBeNull()
    expect(run.sent).toEqual([])
    expect(run.notices).toEqual([
      {
        to: "id-moth",
        always: true,
        text: expect.stringContaining(
          "The user approved, but nothing changed: @fox has no agent running there",
        ),
      },
    ])
  })

  it("links nothing when the caller's agent exited while its shell stayed open", async () => {
    const { run, answer } = await asking()
    run.agents.set("moth", undefined)
    await answer(true)
    expect(run.records.get("id-fox")!.summary.ledBy).toBeNull()
    expect(run.sent).toEqual([])
    expect(run.notices).toEqual([
      {
        to: "id-moth",
        always: true,
        text: expect.stringContaining("nothing changed: your agent session there"),
      },
    ])
  })

  it("still links when a session id was corrected or replaced, as the agent is the same", async () => {
    const { run, answer } = await asking()
    run.agents.set("moth", { agent: "claude", sessionId: "s-corrected" })
    run.agents.set("fox", { agent: "codex", sessionId: "s-corrected" })
    await answer(true)
    expect(run.records.get("id-fox")!.summary.ledBy).toBe("id-moth")
  })

  it("links nothing when the target's agent was swapped for another in the same shell", async () => {
    const { run, answer } = await asking()
    run.agents.set("fox", { agent: "claude", sessionId: "s-other" })
    await answer(true)
    expect(run.records.get("id-fox")!.summary.ledBy).toBeNull()
    expect(run.sent).toEqual([])
    expect(run.notices).toEqual([
      {
        to: "id-moth",
        always: true,
        text: expect.stringContaining("the agent in @fox is not the one you asked about"),
      },
    ])
  })

  it("still links when the target's session binds between the ask and the answer", async () => {
    const run = setup({ moth: { agent: "claude" }, fox: { agent: "codex" } })
    run.agents.set("fox", { agent: "codex", sessionId: "s-fox" })
    const asked = person(run.approvals)
    await run.lead("moth", "fox")
    await settle()
    run.agents.set("fox", { agent: "codex", sessionId: "s-fox" })
    run.approvals.answer({ requestId: asked[0]!.requestId, approved: true }, "person")
    await settle()
    expect(run.records.get("id-fox")!.summary.ledBy).toBe("id-moth")
  })

  it("links nothing when another agent came to lead it meanwhile", async () => {
    const { run, answer } = await asking()
    run.records.set("id-owl", terminal("owl", null))
    run.records.get("id-fox")!.summary = {
      ...run.records.get("id-fox")!.summary,
      ledBy: "id-owl",
    }
    await answer(true)
    expect(run.records.get("id-fox")!.summary.ledBy).toBe("id-owl")
    expect(run.notices.at(-1)!.text).toMatch(/already has a lead, @owl/)
    expect(run.sent).toEqual([])
  })

  it("links nothing when the target now leads the caller", async () => {
    const { run, answer } = await asking()
    run.records.get("id-moth")!.summary = {
      ...run.records.get("id-moth")!.summary,
      ledBy: "id-fox",
    }
    await answer(true)
    expect(run.records.get("id-fox")!.summary.ledBy).toBeNull()
    expect(run.notices.at(-1)!.text).toMatch(/leads you/)
  })

  it("tells the caller when the person declines, and links nothing", async () => {
    const { run, answer } = await asking()
    await answer(false)
    expect(run.records.get("id-fox")!.summary.ledBy).toBeNull()
    expect(run.notices).toEqual([
      { to: "id-moth", always: true, text: leadNotice.declined("fox", "Terminal") },
    ])
  })

  it("tells the caller when the ask is withdrawn as a terminal closes, or the window goes", async () => {
    const closed = await asking()
    closed.run.approvals.withdraw("id-fox")
    await settle()
    expect(closed.run.notices).toEqual([
      { to: "id-moth", always: true, text: leadNotice.vanished("fox") },
    ])
    const gone = await asking()
    gone.run.approvals.release("person")
    await settle()
    expect(gone.run.notices).toEqual([
      { to: "id-moth", always: true, text: leadNotice.gone("fox") },
    ])
    expect(gone.run.records.get("id-fox")!.summary.ledBy).toBeNull()
  })

  it("links nothing when the terminal was replaced before the person approved", async () => {
    const { run, answer } = await asking()
    run.records.set("id-fox", terminal("fox", null))
    await answer(true)
    expect(run.records.get("id-fox")!.summary.ledBy).toBeNull()
    expect(run.notices.at(-1)!.text).toBe(leadNotice.vanished("fox"))
  })
})

describe("a lead releasing the terminal it leads", () => {
  it("ends the link and tells the terminal", async () => {
    const run = setup({ moth: { agent: "claude" }, fox: { agent: "codex", ledBy: "moth" } })
    await expect(run.release("moth", "fox")).resolves.toEqual({
      ok: true,
      handle: "fox",
      title: "Terminal",
    })
    expect(run.records.get("id-fox")!.summary.ledBy).toBeNull()
    expect(run.saved).toEqual(["fox unled"])
    expect(run.notices).toEqual([{ to: "id-fox", always: true, text: leadNotice.released("moth") }])
  })

  it("is refused for anyone but the running lead", async () => {
    const run = setup({
      moth: { agent: "claude" },
      fox: { agent: "codex", ledBy: "owl" },
      owl: { agent: "claude" },
      jinx: { agent: "claude" },
    })
    await expect(run.release("moth", "fox")).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/lead of @fox can release it, and that is @owl/),
    })
    await expect(run.release("moth", "jinx")).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/don't lead @jinx/),
    })
    await expect(run.release("moth", "moth")).resolves.toMatchObject({ ok: false })
    expect(run.records.get("id-fox")!.summary.ledBy).toBe("id-owl")
    expect(run.saved).toEqual([])
  })
})

describe("a lead that lasts only for its brief", () => {
  const led = () => {
    const run = setup({ moth: { agent: "claude" }, fox: { agent: "codex", ledBy: "moth" } })
    const fox = run.records.get("id-fox")!
    run.briefing("id-fox", "m1")
    run.leads.releaseAfterBrief("id-fox", "id-moth", "m1")
    return { run, fox }
  }

  it("holds while the brief waits, and ends once it is delivered, with its own notice", async () => {
    const { run } = led()
    run.moved("m1", "queued", "id-fox")
    run.moved("m1", "leased", "id-fox")
    // Another terminal's messages changing says nothing about it.
    run.moved("m1", "delivered", "id-owl")
    await settle()
    expect(run.records.get("id-fox")!.summary.ledBy).toBe("id-moth")
    expect(run.listening()).toBe(1)
    run.moved("m1", "delivered", "id-fox")
    await settle()
    expect(run.records.get("id-fox")!.summary.ledBy).toBeNull()
    expect(run.saved).toEqual(["fox unled"])
    expect(run.notices).toEqual([
      { to: "id-fox", always: true, text: leadNotice.briefDone("moth") },
    ])
    expect(run.listening()).toBe(0)
  })

  it("ends at once when the brief is gone, telling the agent only if it may have seen it", async () => {
    const unseen = led()
    unseen.run.moved("m1", "queued", "id-fox")
    unseen.run.moved("m1", "gone", "id-fox")
    await settle()
    expect(unseen.fox.summary.ledBy).toBeNull()
    expect(unseen.run.notices).toEqual([])
    expect(unseen.run.listening()).toBe(0)
    const seen = led()
    seen.run.moved("m1", "leased", "id-fox")
    seen.run.moved("m1", "gone", "id-fox")
    await settle()
    expect(seen.fox.summary.ledBy).toBeNull()
    expect(seen.run.notices).toHaveLength(1)
  })

  it("ends a lead whose brief was forgotten, telling the agent only if it may have seen it", async () => {
    const unseen = led()
    unseen.run.moved("m1", "queued", "id-fox")
    unseen.run.forget("m1", "id-fox")
    await settle()
    expect(unseen.fox.summary.ledBy).toBeNull()
    expect(unseen.run.notices).toEqual([])
    const seen = led()
    seen.run.moved("m1", "leased", "id-fox")
    seen.run.forget("m1", "id-fox")
    await settle()
    expect(seen.fox.summary.ledBy).toBeNull()
    expect(seen.run.notices).toHaveLength(1)
  })

  it("ends nothing once the lead ended or was set again, even by the same lead", async () => {
    const { run, fox } = led()
    // The person released it and approved the same lead again: a lead of its own, no brief's.
    run.unbrief("id-fox")
    run.moved("m1", "delivered", "id-fox")
    await settle()
    expect(fox.summary.ledBy).toBe("id-moth")
    expect(run.notices).toEqual([])
    expect(run.listening()).toBe(0)
  })

  it("keeps listening while its terminal is between records, and stops when the runner does", async () => {
    const between = led()
    between.run.records.delete("id-fox")
    between.run.moved("m1", "queued", "id-fox")
    await settle()
    expect(between.run.listening()).toBe(1)
    expect(between.run.notices).toEqual([])
    // Closed for good, messaging lets go of the brief and says so.
    between.run.unbrief("id-fox")
    between.run.moved("m1", "queued", "id-fox")
    expect(between.run.listening()).toBe(0)
    const stopped = led()
    stopped.run.stop()
    stopped.run.moved("m1", "delivered", "id-fox")
    await settle()
    expect(stopped.fox.summary.ledBy).toBe("id-moth")
    expect(stopped.run.listening()).toBe(0)
  })
})

describe("the person releasing a terminal", () => {
  it("ends its lead and tells the terminal and its former lead", () => {
    const run = setup({ moth: { agent: "claude" }, fox: { agent: "codex", ledBy: "moth" } })
    run.leads.releaseByPerson("id-fox")
    expect(run.records.get("id-fox")!.summary.ledBy).toBeNull()
    expect(run.dropped).toEqual(["id-fox"])
    // Before the lead ends, so its messages are dropped as released, not as ended.
    expect(run.saved).toEqual(["dropped for id-fox", "fox unled"])
    expect(run.notices).toEqual([
      { to: "id-fox", always: true, text: leadNotice.personReleased("moth") },
      { to: "id-moth", always: true, text: leadNotice.personReleasedFrom("fox", "Terminal") },
    ])
  })

  it("names a sleeping lead from its saved row, and tells the terminal without a handle where its lead is gone", () => {
    const asleep = setup({
      moth: { agent: "claude", asleep: true },
      fox: { agent: "codex", ledBy: "moth" },
    })
    asleep.leads.releaseByPerson("id-fox")
    expect(asleep.notices).toEqual([
      { to: "id-fox", always: true, text: leadNotice.personReleased("moth") },
    ])
    const run = setup({ moth: { agent: "claude" }, fox: { agent: "codex", ledBy: "moth" } })
    run.records.delete("id-moth")
    run.leads.releaseByPerson("id-fox")
    expect(run.records.get("id-fox")!.summary.ledBy).toBeNull()
    expect(run.notices).toEqual([
      { to: "id-fox", always: true, text: leadNotice.personReleasedFromGone() },
    ])
  })

  it("does nothing for a terminal with no lead, and refuses one that isn't there", () => {
    const run = setup({ fox: { agent: "codex" } })
    run.leads.releaseByPerson("id-fox")
    expect(run.saved).toEqual([])
    expect(run.notices).toEqual([])
    expect(() => run.leads.releaseByPerson("id-none")).toThrow(
      expect.objectContaining({ code: "TERMINAL_NOT_FOUND" }),
    )
  })
})

describe("a lead that lasts only for its brief, over the real messaging", () => {
  // moth leads fox, whose agent is expected; its brief is sent as the lead's alone.
  const world = () => {
    const messaging = new Messaging({ sweepMs: 0, restoreMs: 0, waitsMs: 0, platform: "linux" })
    const scope = { projectId: "p", sessionId: "session" }
    messaging.register("id-moth", scope, "moth", null)
    const records = new Map<string, Record>([
      ["id-moth", terminal("moth", null)],
      ["id-fox", terminal("fox", "id-moth")],
    ])
    messaging.register("id-fox", scope, "fox", "id-moth")
    messaging.expect("id-fox", "codex")
    const host = {
      records: () => records,
      stopping: () => false,
      messaging: () => messaging,
      bindings: () =>
        ({
          endLead: (record: Record) => {
            record.summary = { ...record.summary, ledBy: null }
            messaging.endLead(record.summary.id)
          },
        }) as unknown as Bindings,
    } as unknown as LeadsHost
    const leads = new Leads(host)
    const brief = messaging.sendBrief("id-moth", { to: "fox", text: "Fix the build." })
    if (!brief.ok) throw new Error(brief.reason)
    leads.releaseAfterBrief("id-fox", "id-moth", brief.id)
    return { messaging, records, scope, brief, leads }
  }

  it("ends the lead when the worker exits and is restored, and later messages are a peer's", async () => {
    const { messaging, records, scope, brief } = world()
    expect(messaging.briefOf("id-fox")).toBe(brief.id)
    // Its shell exits before any session bound: the brief goes with it.
    messaging.unregister("id-fox")
    await settle()
    expect(messaging.stateOf(brief.id)).toBe("gone")
    expect(records.get("id-fox")!.summary.ledBy).toBeNull()
    expect(messaging.briefOf("id-fox")).toBeUndefined()
    // Restored as a new record, it is no one's to lead: nothing the opener sends is marked.
    records.set("id-fox", terminal("fox", null))
    messaging.register("id-fox", scope, "fox", null)
    messaging.expect("id-fox", "codex")
    const later = messaging.send("id-moth", { to: "fox", text: "Also this." })
    expect(later.ok && messaging.isFromLead(later.id)).toBe(false)
  })

  it("keeps the brief while the terminal is only between records, and lets go when it closes", async () => {
    const { messaging, records, brief } = world()
    // Its record is let go before the shell exits, as when an exited terminal is evicted.
    records.delete("id-fox")
    messaging.unregister("id-fox")
    await settle()
    // The release found no record to end the lead of, and ended nothing: the entry survives.
    expect(messaging.stateOf(brief.id)).toBe("gone")
    expect(messaging.briefOf("id-fox")).toBe(brief.id)
    messaging.unregister("id-fox", true)
    expect(messaging.briefOf("id-fox")).toBeUndefined()
  })
})

describe("an agent joining another terminal's team", () => {
  const pair = () => setup({ moth: { agent: "claude" }, fox: { agent: "codex" } })

  it("asks the person with its introduction, and joins nothing yet", async () => {
    const run = pair()
    const asked = person(run.approvals)
    await expect(run.join("moth", "fox", { message: "I work on the API." })).resolves.toEqual({
      ok: true,
      asked: true,
      handle: "fox",
      title: "Terminal",
      ran: "Codex",
    })
    await settle()
    expect(asked).toEqual([
      {
        type: "request",
        requestId: expect.any(String),
        from: "id-moth",
        terminalId: "id-fox",
        sessionId: "session",
        action: { type: "join", message: "I work on the API." },
      },
    ])
    expect(run.records.get("id-moth")!.summary.ledBy).toBeNull()
    expect(run.sent).toEqual([])
  })

  it("makes the terminal its lead once the person approves, telling both and introducing itself", async () => {
    const run = pair()
    const asked = person(run.approvals)
    await run.join("moth", "fox", { message: "I work on the API." })
    await settle()
    run.approvals.answer({ requestId: asked[0]!.requestId, approved: true }, "person")
    await settle()
    expect(run.records.get("id-moth")!.summary.ledBy).toBe("id-fox")
    expect(run.saved).toEqual(["moth led by fox"])
    expect(run.sent).toEqual([{ from: "id-moth", to: "fox", text: "I work on the API." }])
    expect(run.notices).toEqual([
      {
        to: "id-fox",
        always: true,
        text: teamNotice.joined("moth", "Terminal", true),
      },
      {
        to: "id-moth",
        always: true,
        text: teamNotice.nowJoined(
          "fox",
          "Terminal",
          "Your introduction, message m1, is sent; its replies arrive by themselves.",
        ),
      },
    ])
    expect(run.introduced).toContain("id-fox>id-moth")
  })

  it("joins nothing and tells the caller when the person declines", async () => {
    const run = pair()
    const asked = person(run.approvals)
    await run.join("moth", "fox")
    await settle()
    run.approvals.answer({ requestId: asked[0]!.requestId, approved: false }, "person")
    await settle()
    expect(run.records.get("id-moth")!.summary.ledBy).toBeNull()
    expect(run.notices).toEqual([
      {
        to: "id-moth",
        always: true,
        text: teamNotice.joinDeclined("fox", "Terminal"),
      },
    ])
  })

  it("joins nothing when the caller got a lead before the person approved", async () => {
    const run = setup({
      moth: { agent: "claude" },
      fox: { agent: "codex" },
      owl: { agent: "claude" },
    })
    const asked = person(run.approvals)
    await run.join("moth", "fox")
    await settle()
    run.records.get("id-moth")!.summary.ledBy = "id-owl"
    run.approvals.answer({ requestId: asked[0]!.requestId, approved: true }, "person")
    await settle()
    expect(run.records.get("id-moth")!.summary.ledBy).toBe("id-owl")
    expect(run.notices).toEqual([
      {
        to: "id-moth",
        always: true,
        text: leadNotice.unfit("You have a lead already: leave its team first."),
      },
    ])
  })

  it("joins at once where agents decide for themselves, telling the lead", async () => {
    const run = pair()
    run.mode("swarm")
    const asked = person(run.approvals)
    await expect(run.join("moth", "fox", { message: "I work on the API." })).resolves.toEqual({
      ok: true,
      joined: true,
      handle: "fox",
      title: "Terminal",
      ran: "Codex",
      introduction: "Your introduction, message m1, is sent; its replies arrive by themselves.",
    })
    await settle()
    expect(asked).toEqual([])
    expect(run.records.get("id-moth")!.summary.ledBy).toBe("id-fox")
    expect(run.sent).toEqual([{ from: "id-moth", to: "fox", text: "I work on the API." }])
    expect(run.notices).toEqual([
      {
        to: "id-fox",
        always: true,
        text: teamNotice.joined("moth", "Terminal", false),
      },
    ])
    expect(teamNotice.joined("moth", "Terminal", false)).not.toContain("user approved")
  })

  it("joins at once with no introduction and no client to ask", async () => {
    const run = pair()
    run.mode("swarm")
    const answer = await run.join("moth", "fox")
    expect(answer).toMatchObject({ ok: true, joined: true })
    expect(answer).not.toHaveProperty("introduction")
    expect(run.sent).toEqual([])
  })

  it.each(["herd", "swarm"] as const)("refuses, in %s, what no join can be", async (mode) => {
    const run = setup({
      moth: { agent: "claude" },
      fox: { agent: "codex" },
      owl: { agent: "claude", ledBy: "moth" },
      bee: { agent: "agy", ledBy: "owl" },
      ant: { agent: null },
      led: { agent: "claude", ledBy: "fox" },
    })
    run.mode(mode)
    person(run.approvals)
    const refusal = (reason: RegExp) => ({
      ok: false,
      reason: expect.stringMatching(reason),
    })
    expect(await run.join("moth", "moth")).toMatchObject(refusal(/your own team/))
    expect(await run.join("moth", "ghost")).toMatchObject(refusal(/no terminal's handle/))
    expect(await run.join("moth", "ant")).toMatchObject(refusal(/no agent running/))
    // An agent it leads, and one it leads through others.
    expect(await run.join("moth", "owl")).toMatchObject(refusal(/You lead @owl/))
    expect(await run.join("moth", "bee")).toMatchObject(refusal(/You lead @bee/))
    // Already led: leave first.
    expect(await run.join("led", "moth")).toMatchObject(refusal(/leave its team first/))
    expect(await run.join("moth", "fox", { surprise: 1 })).toMatchObject(refusal(/needs `to`/))
    expect(run.saved).toEqual([])
    expect(run.sent).toEqual([])
  })

  it("may join an agent that has a lead of its own", async () => {
    const run = setup({
      moth: { agent: "claude" },
      fox: { agent: "codex", ledBy: "owl" },
      owl: { agent: "claude" },
    })
    run.mode("swarm")
    expect(await run.join("moth", "fox")).toMatchObject({
      ok: true,
      joined: true,
    })
  })

  it("refuses a sleeper, a caller whose session never bound, and a call without the token", async () => {
    const run = setup({
      moth: { agent: "claude" },
      fox: { agent: "codex", asleep: true },
    })
    run.mode("swarm")
    expect(await run.join("moth", "fox")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/asleep/),
    })
    run.agents.set("moth", { agent: "claude", sessionId: null })
    expect(await run.join("moth", "fox")).toMatchObject({ ok: false })
    expect(
      await new Teams(
        { ...({} as LeadsHost), records: () => new Map() } as LeadsHost,
        {} as Leads,
      ).join({
        type: "join",
        terminalId: "id-moth",
        token: "x",
        request: { to: "fox" },
      }),
    ).toEqual({
      ok: false,
      reason: "Novadeck couldn't join the terminal's team.",
    })
  })
})

describe("an agent leaving its lead's team", () => {
  const led = () => setup({ moth: { agent: "claude", ledBy: "fox" }, fox: { agent: "codex" } })

  it("is refused with no lead", async () => {
    const run = setup({ moth: { agent: "claude" }, fox: { agent: "codex" } })
    for (const mode of ["herd", "swarm"] as const) {
      run.mode(mode)
      // eslint-disable-next-line no-await-in-loop -- In turn.
      expect(await run.leave("moth")).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/no lead/),
      })
    }
  })

  it("asks the person, and leaves once they approve, telling the lead and the caller", async () => {
    const run = led()
    const asked = person(run.approvals)
    await expect(run.leave("moth")).resolves.toEqual({
      ok: true,
      asked: true,
      handle: "fox",
      title: "Terminal",
      ran: "Codex",
    })
    await settle()
    expect(asked).toMatchObject([
      { from: "id-moth", terminalId: "id-fox", action: { type: "leave" } },
    ])
    expect(run.records.get("id-moth")!.summary.ledBy).toBe("id-fox")
    run.approvals.answer({ requestId: asked[0]!.requestId, approved: true }, "person")
    await settle()
    expect(run.records.get("id-moth")!.summary.ledBy).toBeNull()
    expect(run.notices).toEqual([
      {
        to: "id-fox",
        always: true,
        text: teamNotice.left("moth", "Terminal", true),
      },
      { to: "id-moth", always: true, text: teamNotice.nowLeft("fox") },
    ])
  })

  it("stays when the person declines", async () => {
    const run = led()
    const asked = person(run.approvals)
    await run.leave("moth")
    await settle()
    run.approvals.answer({ requestId: asked[0]!.requestId, approved: false }, "person")
    await settle()
    expect(run.records.get("id-moth")!.summary.ledBy).toBe("id-fox")
    expect(run.notices).toEqual([
      { to: "id-moth", always: true, text: teamNotice.leaveDeclined("fox") },
    ])
  })

  it("leaves at once where agents decide for themselves, telling the lead", async () => {
    const run = led()
    run.mode("swarm")
    const asked = person(run.approvals)
    await expect(run.leave("moth")).resolves.toEqual({
      ok: true,
      left: true,
      handle: "fox",
      title: "Terminal",
      ran: "Codex",
    })
    await settle()
    expect(asked).toEqual([])
    expect(run.records.get("id-moth")!.summary.ledBy).toBeNull()
    expect(run.notices).toEqual([
      {
        to: "id-fox",
        always: true,
        text: teamNotice.left("moth", "Terminal", false),
      },
    ])
  })
})

describe("a lead handing its team to one of its members", () => {
  // moth leads fox and owl, and is led by ant.
  const team = (above = true) =>
    setup({
      ant: { agent: "claude" },
      moth: { agent: "claude", ...(above && { ledBy: "ant" }) },
      fox: { agent: "codex", ledBy: "moth" },
      owl: { agent: "agy", ledBy: "moth" },
      bee: { agent: "claude" },
    })

  it("is refused for a terminal it doesn't lead, or itself", async () => {
    const run = team()
    for (const mode of ["herd", "swarm"] as const) {
      run.mode(mode)
      /* eslint-disable no-await-in-loop -- In turn. */
      expect(await run.hand("moth", "bee")).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/You don't lead @bee/),
      })
      expect(await run.hand("moth", "ant")).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/@ant is led by|You don't lead @ant/),
      })
      expect(await run.hand("fox", "owl")).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/@owl is led by @moth, not you/),
      })
      expect(await run.hand("moth", "moth")).toMatchObject({ ok: false })
      /* eslint-enable no-await-in-loop */
    }
    expect(run.saved).toEqual([])
  })

  it("hands the team over at once where agents decide, and tells everyone it touches", async () => {
    const run = team()
    run.mode("swarm")
    const asked = person(run.approvals)
    await expect(run.hand("moth", "fox")).resolves.toEqual({
      ok: true,
      handed: true,
      handle: "fox",
      title: "Terminal",
      ran: "Codex",
      members: ["owl"],
      under: "ant",
    })
    await settle()
    expect(asked).toEqual([])
    const ledBy = (handle: string) => run.records.get(`id-${handle}`)!.summary.ledBy
    expect(ledBy("fox")).toBe("id-ant")
    expect(ledBy("owl")).toBe("id-fox")
    expect(ledBy("moth")).toBe("id-fox")
    expect(ledBy("ant")).toBeNull()
    expect(run.notices).toEqual([
      {
        to: "id-fox",
        always: true,
        text: teamNotice.handedTo("moth", ["owl"], "ant", false),
      },
      {
        to: "id-owl",
        always: true,
        text: teamNotice.newLead("moth", "fox", false),
      },
      { to: "id-ant", always: true, text: teamNotice.placed("moth", "fox") },
    ])
  })

  it("leaves the new lead unled when the caller had no lead", async () => {
    const run = team(false)
    run.mode("swarm")
    await expect(run.hand("moth", "owl")).resolves.toMatchObject({
      ok: true,
      members: ["fox"],
    })
    const ledBy = (handle: string) => run.records.get(`id-${handle}`)!.summary.ledBy
    expect(ledBy("owl")).toBeNull()
    expect(ledBy("fox")).toBe("id-owl")
    expect(ledBy("moth")).toBe("id-owl")
    expect(run.notices.map(({ to }) => to)).toEqual(["id-owl", "id-fox"])
  })

  it("asks the person, and hands the team over once they approve", async () => {
    const run = team()
    const asked = person(run.approvals)
    await expect(run.hand("moth", "fox")).resolves.toMatchObject({
      ok: true,
      asked: true,
      handle: "fox",
    })
    await settle()
    expect(asked).toMatchObject([
      { from: "id-moth", terminalId: "id-fox", action: { type: "hand" } },
    ])
    expect(run.records.get("id-owl")!.summary.ledBy).toBe("id-moth")
    run.approvals.answer({ requestId: asked[0]!.requestId, approved: true }, "person")
    await settle()
    expect(run.records.get("id-owl")!.summary.ledBy).toBe("id-fox")
    expect(run.records.get("id-moth")!.summary.ledBy).toBe("id-fox")
    expect(run.notices.at(-1)).toEqual({
      to: "id-moth",
      always: true,
      text: teamNotice.nowHanded("fox", ["owl"]),
    })
  })

  it("changes nothing when the person declines", async () => {
    const run = team()
    const asked = person(run.approvals)
    await run.hand("moth", "fox")
    await settle()
    run.approvals.answer({ requestId: asked[0]!.requestId, approved: false }, "person")
    await settle()
    expect(run.saved).toEqual([])
    expect(run.notices).toEqual([
      { to: "id-moth", always: true, text: teamNotice.handDeclined("fox") },
    ])
  })
})

describe("teams with agents that sleep", () => {
  it("lets a member leave a sleeping lead, asking the person and telling the lead, so it may join again", async () => {
    const run = setup({
      moth: { agent: "claude", ledBy: "fox" },
      fox: { agent: "codex", asleep: true },
      owl: { agent: "claude" },
    })
    const asked = person(run.approvals)
    await expect(run.leave("moth")).resolves.toMatchObject({ ok: true, asked: true, handle: "fox" })
    await settle()
    expect(asked).toMatchObject([
      { from: "id-moth", terminalId: "id-fox", action: { type: "leave" } },
    ])
    run.approvals.answer({ requestId: asked[0]!.requestId, approved: true }, "person")
    await settle()
    expect(run.records.get("id-moth")!.summary.ledBy).toBeNull()
    // The sleeping lead is told through the notice that queues to a sleeper and wakes it.
    expect(run.notices.map(({ to }) => to)).toEqual(["id-fox", "id-moth"])
    run.mode("swarm")
    expect(await run.join("moth", "owl")).toMatchObject({ ok: true, joined: true })
  })

  it("lets a member leave a sleeping lead at once where agents decide", async () => {
    const run = setup({
      moth: { agent: "claude", ledBy: "fox" },
      fox: { agent: "codex", asleep: true },
    })
    run.mode("swarm")
    await expect(run.leave("moth")).resolves.toMatchObject({ ok: true, left: true })
    expect(run.records.get("id-moth")!.summary.ledBy).toBeNull()
    expect(run.notices).toEqual([
      { to: "id-fox", always: true, text: teamNotice.left("moth", "Terminal", false) },
    ])
  })

  it("hands sleeping members over too, and the new lead's notice names them", async () => {
    const run = setup({
      moth: { agent: "claude" },
      fox: { agent: "codex", ledBy: "moth" },
      owl: { agent: "agy", ledBy: "moth", asleep: true },
    })
    run.mode("swarm")
    await expect(run.hand("moth", "fox")).resolves.toMatchObject({
      ok: true,
      handed: true,
      members: ["owl"],
    })
    expect(run.saved).toContain("owl asleep, led by fox")
    expect(run.notices[0]).toEqual({
      to: "id-fox",
      always: true,
      text: teamNotice.handedTo("moth", ["owl"], undefined, false),
    })
    expect(run.notices.map(({ to }) => to)).toContain("id-owl")
  })

  it("drops what the old lead sent and hadn't arrived when a member leaves or a lead hands on", async () => {
    const left = setup({ moth: { agent: "claude", ledBy: "fox" }, fox: { agent: "codex" } })
    left.mode("swarm")
    await left.leave("moth")
    expect(left.dropped).toEqual(["id-moth"])
    const handed = setup({
      moth: { agent: "claude" },
      fox: { agent: "codex", ledBy: "moth" },
      owl: { agent: "agy", ledBy: "moth" },
    })
    handed.mode("swarm")
    await handed.hand("moth", "fox")
    expect(handed.dropped.toSorted()).toEqual(["id-fox", "id-moth", "id-owl"])
  })

  it("sees a sleeper's lead in the chain, so a join or lead can't close a cycle", async () => {
    // moth is led by owl, asleep, which is led by fox: fox can't join or lead moth.
    const run = setup({
      moth: { agent: "claude", ledBy: "owl" },
      owl: { agent: "claude", ledBy: "fox", asleep: true },
      fox: { agent: "codex" },
    })
    for (const mode of ["herd", "swarm"] as const) {
      run.mode(mode)
      // eslint-disable-next-line no-await-in-loop -- In turn.
      expect(await run.join("fox", "moth")).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/You lead @moth/),
      })
    }
    expect(await run.lead("fox", "moth")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/already has a lead|leads you/),
    })
    expect(run.records.get("id-fox")!.summary.ledBy).toBeNull()
  })

  it("says a question is waiting about the lead, not that the lead waits for the user, when it has its own", async () => {
    const run = setup({ moth: { agent: "claude", ledBy: "fox" }, fox: { agent: "codex" } })
    person(run.approvals)
    run.approvals.request(
      {
        from: "id-fox",
        terminalId: "id-fox",
        sessionId: "session",
        action: { type: "lead" } as never,
      },
      () => undefined,
    )
    expect(await run.leave("moth")).toEqual({
      ok: false,
      reason:
        "A question about @fox is still waiting for the user's answer, so nothing changed. Try again once it is answered.",
    })
  })
})
