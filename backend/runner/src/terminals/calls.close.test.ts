import type { AgentName } from "@novadeck/protocol"
import { afterEach, beforeEach, vi } from "vitest"

import type { Messaging, PeerAnswer } from "../messaging/messaging.js"
import { describe, expect, it } from "../test.js"
import { Approvals } from "./approvals.js"
import { Calls, type CallsHost } from "./calls.js"
import { closeNotice, selfCloseMs } from "./closes.js"
import type { Record } from "./record.js"

const token = "t".repeat(48)

// A terminal as far as a close reads it.
const terminal = (id: string, handle: string, title = "Terminal"): Record =>
  ({
    summary: { id, handle, title, sessionId: "session" },
    terminal: { exiting: false },
    token,
    closed: false,
  }) as unknown as Record

// Calls over a runner of fakes: the terminals by handle, who runs which agent, who leads
// whom, and what the close steps and notices did.
const setup = (
  runs: { readonly [handle: string]: AgentName | null },
  leads: { readonly [handle: string]: string } = {},
) => {
  const ids = Object.keys(runs)
  const records = new Map(ids.map((handle) => [`id-${handle}`, terminal(`id-${handle}`, handle)]))
  const approvals = new Approvals()
  const steps: string[] = []
  const notices: { to: string; text: string; always?: true }[] = []
  let stopping = false
  const find = (id: string) => [...records.values()].find((record) => record.summary.id === id)
  const host = {
    records: () => records,
    stopping: () => stopping,
    messaging: () =>
      ({
        leadOf: (id: string) => leads[find(id)?.summary.handle ?? ""],
        waitingFor: () => 0,
        goneFrom: () => [],
        notice: (to: string, text: string, options?: { always?: boolean }) => {
          notices.push({ to, text, ...(options?.always && { always: true }) })
          return true
        },
      }) as unknown as Messaging,
    peers: () => ({
      target: async (_caller: unknown, to: string): Promise<PeerAnswer> => {
        const record = [...records.values()].find((each) => each.summary.handle === to)
        return record
          ? { ok: true, terminalId: record.summary.id, handle: to, agent: runs[to] ?? null }
          : { ok: false, reason: `"${to}" is no terminal's handle here.` }
      },
    }),
    approvals: () => approvals,
    closingNow: () => false,
    closeForGood: (record: Record) => {
      record.closed = true
      steps.push(`closing ${record.summary.handle}`)
    },
    terminate: async (record: Record) => {
      steps.push(`ended ${record.summary.handle}`)
    },
    remove: (record: Record) => {
      records.delete(record.summary.id)
      steps.push(`removed ${record.summary.handle}`)
    },
    forget: (id: string) => {
      steps.push(`forgot ${id}`)
      calls.forgetOpener(id)
    },
  } as unknown as CallsHost
  const calls = new Calls(1_000, host)
  const close = (from: string, to: string) =>
    calls.closePeer({ type: "close", terminalId: `id-${from}`, token, request: { to } })
  return {
    calls,
    approvals,
    close,
    steps,
    notices,
    records,
    stop: () => (stopping = true),
  }
}

// The client following the approvals, collecting what it is sent.
const person = (approvals: Approvals) => {
  const items: { type: string; requestId: string }[] = []
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

describe("an agent closing its own terminal", () => {
  it("is answered first, then closes the terminal a moment later", async () => {
    const run = setup({ moth: "claude", fox: "codex" })
    await expect(run.close("moth", "moth")).resolves.toEqual({
      ok: true,
      self: true,
      handle: "moth",
      title: "Terminal",
    })
    expect(run.steps).toEqual([])
    await vi.advanceTimersByTimeAsync(selfCloseMs - 1)
    expect(run.steps).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(run.steps).toEqual(["closing moth", "ended moth", "removed moth", "forgot id-moth"])
    expect(run.records.has("id-fox")).toBe(true)
  })

  it("closes once, though it asks again meanwhile", async () => {
    const run = setup({ moth: "claude" })
    await run.close("moth", "moth")
    await expect(run.close("moth", "moth")).resolves.toEqual({
      ok: false,
      reason: "@moth is already closing.",
    })
    await vi.advanceTimersByTimeAsync(selfCloseMs)
    expect(run.steps.filter((step) => step === "closing moth")).toHaveLength(1)
  })

  it("closes nothing once the terminal is closed or replaced by then, or the runner stops", async () => {
    const closed = setup({ moth: "claude" })
    await closed.close("moth", "moth")
    closed.records.get("id-moth")!.closed = true
    await vi.advanceTimersByTimeAsync(selfCloseMs)
    expect(closed.steps).toEqual([])

    const replaced = setup({ moth: "claude" })
    await replaced.close("moth", "moth")
    replaced.records.set("id-moth", terminal("id-moth", "moth"))
    await vi.advanceTimersByTimeAsync(selfCloseMs)
    expect(replaced.steps).toEqual([])

    const stopped = setup({ moth: "claude" })
    await stopped.close("moth", "moth")
    stopped.stop()
    await vi.advanceTimersByTimeAsync(selfCloseMs)
    expect(stopped.steps).toEqual([])
  })

  it("is charged to no close budget", async () => {
    const run = setup({ moth: "claude", fox: null })
    // Five other closes would exhaust a chain's budget; its own close still goes.
    for (let index = 0; index < 5; index += 1) {
      run.records.set(`id-x${index}`, terminal(`id-x${index}`, `x${index}`))
      // eslint-disable-next-line no-await-in-loop -- In turn.
      await run.close("moth", `x${index}`)
    }
    await expect(run.close("moth", "moth")).resolves.toMatchObject({ ok: true, self: true })
  })
})

describe("an agent closing a teammate it leads, or a terminal with no agent", () => {
  it("closes a teammate it leads at once, with no ask", async () => {
    const run = setup({ moth: "claude", fox: "codex" }, { fox: "moth" })
    const requested = person(run.approvals)
    await expect(run.close("moth", "fox")).resolves.toMatchObject({
      ok: true,
      handle: "fox",
      ran: "Codex",
    })
    expect(requested).toEqual([])
    expect(run.steps).toContain("removed fox")
  })

  it("closes a terminal that runs no agent at once, though no client could be asked", async () => {
    const run = setup({ moth: "claude", fox: null })
    const answer = await run.close("moth", "fox")
    expect(answer).toMatchObject({ ok: true, handle: "fox" })
    expect(answer).not.toHaveProperty("ran")
    expect(run.steps).toContain("removed fox")
  })
})

describe("an agent closing another agent's terminal", () => {
  it("asks the person and answers at once, closing nothing yet", async () => {
    const run = setup({ moth: "claude", fox: "codex" })
    const requested = person(run.approvals)
    await expect(run.close("moth", "fox")).resolves.toEqual({
      ok: true,
      asked: true,
      handle: "fox",
      title: "Terminal",
      ran: "Codex",
    })
    await settle()
    expect(requested).toEqual([
      {
        type: "request",
        requestId: expect.any(String),
        from: "id-moth",
        terminalId: "id-fox",
        sessionId: "session",
        action: { type: "close" },
      },
    ])
    expect(run.steps).toEqual([])
  })

  it("closes it once the person confirms, and tells the agent that asked", async () => {
    const run = setup({ moth: "claude", fox: "codex" })
    const requested = person(run.approvals)
    await run.close("moth", "fox")
    await settle()
    run.approvals.answer({ requestId: requested[0]!.requestId, approved: true }, "person")
    await settle()
    expect(run.steps).toEqual(["closing fox", "ended fox", "removed fox", "forgot id-fox"])
    expect(run.notices).toEqual([
      { to: "id-moth", always: true, text: closeNotice.confirmed("fox", "Terminal", "Codex") },
    ])
  })

  it("keeps it open when the person declines, and tells the agent that asked", async () => {
    const run = setup({ moth: "claude", fox: "codex" })
    const requested = person(run.approvals)
    await run.close("moth", "fox")
    await settle()
    run.approvals.answer({ requestId: requested[0]!.requestId, approved: false }, "person")
    await settle()
    expect(run.steps).toEqual([])
    expect(run.notices).toEqual([
      { to: "id-moth", always: true, text: closeNotice.declined("fox", "Terminal") },
    ])
  })

  it("takes the request back when the target closes meanwhile, and tells the agent", async () => {
    const run = setup({ moth: "claude", fox: "codex" })
    const requested = person(run.approvals)
    await run.close("moth", "fox")
    await settle()
    run.calls.forgetOpener("id-fox")
    await settle()
    expect(requested.map((item) => item.type)).toEqual(["request", "withdrawn"])
    expect(run.notices).toEqual([
      { to: "id-moth", always: true, text: closeNotice.vanished("fox") },
    ])
    // A late yes closes nothing.
    expect(() =>
      run.approvals.answer({ requestId: requested[0]!.requestId, approved: true }, "person"),
    ).toThrow(expect.objectContaining({ code: "NOT_FOUND" }))
    expect(run.steps).toEqual([])
  })

  it("closes nothing when the person confirms after the target closed some other way", async () => {
    const run = setup({ moth: "claude", fox: "codex" })
    const requested = person(run.approvals)
    await run.close("moth", "fox")
    await settle()
    // Its record went without the ask hearing of it.
    run.records.get("id-fox")!.closed = true
    run.approvals.answer({ requestId: requested[0]!.requestId, approved: true }, "person")
    await settle()
    expect(run.steps).toEqual([])
    expect(run.notices).toEqual([
      { to: "id-moth", always: true, text: closeNotice.vanished("fox") },
    ])
  })

  it("takes the request back when the agent that asked closes, and says nothing to it", async () => {
    const run = setup({ moth: "claude", fox: "codex" })
    const requested = person(run.approvals)
    await run.close("moth", "fox")
    await settle()
    run.records.delete("id-moth")
    run.calls.forgetOpener("id-moth")
    await settle()
    expect(requested.map((item) => item.type)).toEqual(["request", "withdrawn"])
    expect(run.steps).toEqual([])
  })

  it("tells the agent nothing closed when the client goes away before the person answers", async () => {
    const run = setup({ moth: "claude", fox: "codex" })
    person(run.approvals)
    await run.close("moth", "fox")
    await settle()
    run.approvals.release("person")
    await settle()
    expect(run.steps).toEqual([])
    expect(run.notices).toEqual([{ to: "id-moth", always: true, text: closeNotice.gone("fox") }])
  })

  it("refuses when no client follows the requests", async () => {
    const run = setup({ moth: "claude", fox: "codex" })
    await expect(run.close("moth", "fox")).resolves.toEqual({
      ok: false,
      reason: "Novadeck isn't open to ask the user, so nothing closed.",
    })
    expect(run.steps).toEqual([])
  })

  it("refuses a second ask for a terminal already waiting for the person", async () => {
    const run = setup({ moth: "claude", fox: "codex", owl: "claude" })
    person(run.approvals)
    await expect(run.close("moth", "fox")).resolves.toMatchObject({ ok: true, asked: true })
    await expect(run.close("owl", "fox")).resolves.toEqual({
      ok: false,
      reason: "@fox is already waiting for the user's confirmation to close.",
    })
  })

  it("charges the close budget at ask time, so agents can't spam the person", async () => {
    const targets = ["a0", "a1", "a2", "a3", "a4", "a5"]
    const run = setup({
      moth: "claude",
      ...Object.fromEntries(targets.map((each) => [each, "codex"])),
    })
    person(run.approvals)
    for (const each of targets.slice(0, 5))
      // eslint-disable-next-line no-await-in-loop -- Asked in turn.
      await expect(run.close("moth", each)).resolves.toMatchObject({ ok: true, asked: true })
    await expect(run.close("moth", "a5")).resolves.toMatchObject({ ok: false })
  })
})
