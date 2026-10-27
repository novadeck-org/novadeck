import type { AgentName } from "@novadeck/protocol"
import { afterEach, beforeEach, vi } from "vitest"

import type { Messaging, PeerAnswer } from "../messaging/messaging.js"
import { describe, expect, it } from "../test.js"
import { Approvals } from "./approvals.js"
import type { Bindings } from "./binding/facts.js"
import { Leads, leadNotice, nobodyToLead, type LeadsHost } from "./leads.js"
import type { Record } from "./record.js"

const token = "t".repeat(48)

// A terminal as far as leading reads it: `ledBy` is what it persists, `bound` whether it
// runs an agent.
const terminal = (handle: string, agent: AgentName | null, ledBy: string | null): Record =>
  ({
    summary: { id: `id-${handle}`, handle, title: "Terminal", sessionId: "session", ledBy },
    terminal: { exiting: false },
    token,
    closed: false,
  }) as unknown as Record

// Leads over a runner of fakes: terminals with the agent each runs and who leads them
// (`ledBy` is the lead's handle), and a record of what was sent, noticed and saved.
const setup = (terminals: { [handle: string]: { agent: AgentName | null; ledBy?: string } }) => {
  const records = new Map(
    Object.entries(terminals).map(([handle, { agent, ledBy }]) => [
      `id-${handle}`,
      terminal(handle, agent, ledBy ?? null),
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
  const listeners = new Set<(change: { kind: "terminal"; terminalId: string }) => void>()
  // The running lead is the one `ledBy` names, in the same session.
  const leadOf = (id: string) => {
    const by = records.get(id)?.summary.ledBy
    return by && [...records.values()].some((each) => each.summary.handle === by) ? by : undefined
  }
  const host = {
    records: () => records,
    stopping: () => stopping,
    closingNow: () => false,
    approvals: () => approvals,
    messaging: () =>
      ({
        leadOf,
        isFromLead: () => marked,
        stateOf: (id: string) => states.get(id),
        subscribe: (listener: (change: { kind: "terminal"; terminalId: string }) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        agentIn: (id: string) => {
          const found = agents.get(records.get(id)?.summary.handle ?? "")
          return found
            ? { ok: true, ...found }
            : {
                ok: false,
                code: "none",
                reason: `@${records.get(id)?.summary.handle} has no agent running there that Novadeck can deliver to.`,
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
      target: async (_caller: unknown, to: string): Promise<PeerAnswer> => {
        const record = [...records.values()].find((each) => each.summary.handle === to)
        return record
          ? {
              ok: true,
              terminalId: record.summary.id,
              handle: to,
              agent: terminals[to]?.agent ?? null,
            }
          : { ok: false, reason: `"${to}" is no terminal's handle here.` }
      },
    }),
    bindings: () =>
      ({
        setLead: (record: Record, handle: string) => {
          record.summary = { ...record.summary, ledBy: handle }
          saved.push(`${record.summary.handle} led by ${handle}`)
        },
        endLead: (record: Record) => {
          record.summary = { ...record.summary, ledBy: null }
          saved.push(`${record.summary.handle} unled`)
        },
      }) as unknown as Bindings,
  } as unknown as LeadsHost
  const leads = new Leads(host)
  const call = (type: "lead" | "release", from: string, request: object) => ({
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
    sending: (next: Sending) => (sending = next),
    marking: (next: boolean) => (marked = next),
    stop: () => (stopping = true),
    listening: () => listeners.size,
    // A message of the terminal moves to `state`, which its listeners hear.
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

describe("an agent asking to lead another terminal's agent", () => {
  it("asks the user at once, carrying the brief, and links nothing yet", async () => {
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
        type: "ask",
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

  it("asks the user about the brief as it will be delivered, cleaned of invisible characters", async () => {
    const run = setup({ moth: { agent: "claude" }, fox: { agent: "codex" } })
    const asked = person(run.approvals)
    await run.lead("moth", "fox", "Fix\u202e the\u200b lint.")
    await settle()
    expect(asked[0]).toMatchObject({ action: { type: "lead", brief: "Fix the lint." } })
    run.approvals.answer({ requestId: asked[0]!.requestId, approved: true }, "person")
    await settle()
    expect(run.sent).toEqual([{ from: "id-moth", to: "fox", text: "Fix the lint." }])
  })

  it("refuses a brief that is empty once cleaned, before asking the user", async () => {
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

describe("the user answering an ask to lead", () => {
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
    expect(run.records.get("id-fox")!.summary.ledBy).toBe("moth")
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
    expect(run.records.get("id-fox")!.summary.ledBy).toBe("moth")
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
    expect(run.records.get("id-fox")!.summary.ledBy).toBe("moth")
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
    expect(run.records.get("id-fox")!.summary.ledBy).toBe("moth")
  })

  it("links nothing when another agent came to lead it meanwhile", async () => {
    const { run, answer } = await asking()
    run.records.set("id-owl", terminal("owl", "claude", null))
    run.records.get("id-fox")!.summary = {
      ...run.records.get("id-fox")!.summary,
      ledBy: "owl",
    }
    await answer(true)
    expect(run.records.get("id-fox")!.summary.ledBy).toBe("owl")
    expect(run.notices.at(-1)!.text).toMatch(/already has a lead, @owl/)
    expect(run.sent).toEqual([])
  })

  it("links nothing when the target now leads the caller", async () => {
    const { run, answer } = await asking()
    run.records.get("id-moth")!.summary = {
      ...run.records.get("id-moth")!.summary,
      ledBy: "fox",
    }
    await answer(true)
    expect(run.records.get("id-fox")!.summary.ledBy).toBeNull()
    expect(run.notices.at(-1)!.text).toMatch(/leads you/)
  })

  it("tells the caller when the user declines, and links nothing", async () => {
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

  it("links nothing when the terminal was replaced before the user approved", async () => {
    const { run, answer } = await asking()
    run.records.set("id-fox", terminal("fox", "codex", null))
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
    expect(run.records.get("id-fox")!.summary.ledBy).toBe("owl")
    expect(run.saved).toEqual([])
  })
})

describe("a lead that lasts only for its brief", () => {
  const led = () => {
    const run = setup({ moth: { agent: "claude" }, fox: { agent: "codex", ledBy: "moth" } })
    const fox = run.records.get("id-fox")!
    run.leads.releaseAfterBrief(fox, "moth", "m1")
    return { run, fox }
  }

  it("holds while the brief waits, and ends once it is delivered, as a release does", async () => {
    const { run } = led()
    run.moved("m1", "queued", "id-fox")
    run.moved("m1", "leased", "id-fox")
    // Another terminal's messages changing says nothing about it.
    run.moved("m1", "delivered", "id-owl")
    await settle()
    expect(run.records.get("id-fox")!.summary.ledBy).toBe("moth")
    expect(run.listening()).toBe(1)
    run.moved("m1", "delivered", "id-fox")
    await settle()
    expect(run.records.get("id-fox")!.summary.ledBy).toBeNull()
    expect(run.saved).toEqual(["fox unled"])
    expect(run.notices).toEqual([{ to: "id-fox", always: true, text: leadNotice.released("moth") }])
    expect(run.listening()).toBe(0)
  })

  it("ends silently when the brief goes without being delivered", async () => {
    const { run } = led()
    run.moved("m1", "gone", "id-fox")
    await settle()
    expect(run.records.get("id-fox")!.summary.ledBy).toBeNull()
    expect(run.notices).toEqual([])
    expect(run.listening()).toBe(0)
  })

  it("leaves a lead the user ended, or another's, as it is", async () => {
    const ended = led()
    ended.fox.summary = { ...ended.fox.summary, ledBy: null }
    ended.run.moved("m1", "delivered", "id-fox")
    await settle()
    expect(ended.run.saved).toEqual([])
    expect(ended.run.notices).toEqual([])
    const taken = led()
    taken.fox.summary = { ...taken.fox.summary, ledBy: "owl" }
    taken.run.moved("m1", "delivered", "id-fox")
    await settle()
    expect(taken.fox.summary.ledBy).toBe("owl")
    expect(taken.run.notices).toEqual([])
  })

  it("stops listening once its terminal is replaced or the runner stops", async () => {
    const replaced = led()
    replaced.run.records.set("id-fox", terminal("fox", "codex", "moth"))
    replaced.run.moved("m1", "queued", "id-fox")
    await settle()
    expect(replaced.run.listening()).toBe(0)
    expect(replaced.run.notices).toEqual([])
    const stopped = led()
    stopped.run.stop()
    stopped.run.moved("m1", "delivered", "id-fox")
    await settle()
    expect(stopped.fox.summary.ledBy).toBe("moth")
    expect(stopped.run.listening()).toBe(0)
  })
})

describe("the user releasing a terminal", () => {
  it("ends its lead and tells the terminal and its former lead", () => {
    const run = setup({ moth: { agent: "claude" }, fox: { agent: "codex", ledBy: "moth" } })
    run.leads.releaseByPerson("id-fox")
    expect(run.records.get("id-fox")!.summary.ledBy).toBeNull()
    expect(run.dropped).toEqual(["id-fox"])
    // Before the lead ends, so its messages are dropped as released, not as ended.
    expect(run.saved).toEqual(["dropped for id-fox", "fox unled"])
    expect(run.notices).toEqual([
      { to: "id-fox", always: true, text: leadNotice.userReleased("moth") },
      { to: "id-moth", always: true, text: leadNotice.userReleasedFrom("fox", "Terminal") },
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
