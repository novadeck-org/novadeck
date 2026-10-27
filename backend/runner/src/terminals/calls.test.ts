import { describe, expect, it } from "vitest"

import { Calls, type CallsHost } from "./calls.js"
import { leadNotice } from "./leads.js"
import type { Opener } from "./opens.js"
import { sessionCommandRefusal } from "./opens.js"
import { Claims } from "./resumes.js"

const token = "a".repeat(48)
const call = { type: "models", terminalId: "t1", token, request: {} } as const
const claude = [{ id: "opus", efforts: ["low", "max"] }] as const

const calls = (models: CallsHost["models"]) =>
  new Calls(1000, {
    records: () => new Map([["t1", { terminal: { exiting: false }, token }]]),
    models,
  } as unknown as CallsHost)

describe("the models call", () => {
  it("answers each harness's models, none for one that can't be listed", async () => {
    const answer = await calls((agent) =>
      agent === "claude"
        ? Promise.resolve(claude)
        : agent === "codex"
          ? Promise.reject(new Error("unreadable"))
          : Promise.resolve([]),
    ).call(call)
    expect(answer).toEqual({ ok: true, models: { claude, codex: [], agy: [] } })
  })

  it("learns nothing more for a call without the terminal's own token", async () => {
    const unknown = calls(() => Promise.resolve(claude))
    expect(await unknown.call({ ...call, token: "b".repeat(48) })).toEqual({
      ok: false,
      reason: "Novadeck couldn't list the models.",
    })
  })
})

describe("the open call", () => {
  // Calls over a runner of fakes: a caller `moth` in /work, a client that opens every
  // terminal it is asked for as `t2`, and a record of what was asked, sent and noticed.
  const setup = (bound: string[] = []) => {
    const records = new Map<string, unknown>([
      [
        "t1",
        {
          terminal: { exiting: false },
          token,
          summary: { handle: "moth", cwd: "/work", sessionId: "s" },
        },
      ],
    ])
    const asked: { command?: string; opener: Opener }[] = []
    const sent: { to: string; text: string }[] = []
    const notices: { to: string; text: string }[] = []
    const ended: string[] = []
    let listener: ((change: { kind: "terminal"; terminalId: string }) => void) | undefined
    let state = "queued"
    const opened = {
      summary: { id: "t2", handle: "fox", title: "claude", ledBy: "moth" },
      terminal: { exiting: false },
    } as { startedWith?: string; summary: { id: string; ledBy: string | null } }
    const host = {
      records: () => records,
      stopping: () => false,
      closingNow: () => false,
      save: () => undefined,
      install: () => Promise.resolve(undefined),
      models: () => Promise.resolve([{ id: "opus", efforts: ["low", "max"] }]),
      claims: () => claims,
      launcher: () => ({
        connected: () => Promise.resolve(true),
        startsCommands: () => Promise.resolve(true),
        directory: (path: string) => Promise.resolve(path),
      }),
      opens: () => ({
        ask: (request: { command?: string }, _ms: number, opener: Opener) => {
          asked.push({ ...request, opener })
          records.set("t2", opened)
          return Promise.resolve({ type: "answered", answer: { requestId: "r", terminalId: "t2" } })
        },
      }),
      messaging: () => ({
        refusal: () => undefined,
        send: (_from: string, request: { to: string; text: string }) => {
          sent.push(request)
          return { ok: true, id: "m1", to: request.to, state: "queued" }
        },
        notice: (to: string, text: string) => {
          notices.push({ to, text })
          return true
        },
        stateOf: () => state,
        subscribe: (next: typeof listener) => {
          listener = next
          return () => (listener = undefined)
        },
      }),
      bindings: () => ({
        endLead: (record: typeof opened) => {
          record.summary.ledBy = null
          ended.push(record.summary.id)
        },
      }),
    } as unknown as CallsHost
    const claims = new Claims({
      boundElsewhere: (_id, agent, session) => bound.includes(`${agent}:${session}`),
    })
    const run = new Calls(1000, host)
    return {
      asked,
      sent,
      notices,
      ended,
      claims,
      opened,
      open: (request: object) =>
        run.open({ type: "open", terminalId: "t1", token, request: request as never }),
      deliver: () => {
        state = "delivered"
        listener?.({ kind: "terminal", terminalId: "t2" })
      },
    }
  }

  const line = /^claude "\[Novadeck: automatic notice, agent messages waiting, [A-Za-z0-9]{6}\]"$/

  it("starts an agent at its prompt without a message, unled unless asked to lead it", async () => {
    const plain = setup()
    expect(await plain.open({ agent: "claude" })).toMatchObject({ ok: true, led: false })
    expect(plain.asked[0]!.opener).toMatchObject({ leads: false })
    expect(plain.notices).toEqual([])
    const run = setup()
    const answer = await run.open({ agent: "claude", lead: true })
    expect(run.asked.map(({ command }) => command)).toEqual(["claude"])
    expect(run.asked[0]!.opener).toMatchObject({ by: "moth", leads: true, command: "claude" })
    expect(answer).toMatchObject({ ok: true, terminalId: "t2", command: "claude", led: true })
    expect(answer).not.toHaveProperty("task")
    expect(run.sent).toEqual([])
    expect(run.notices).toEqual([{ to: "t2", text: leadNotice.openedLed("moth") }])
    expect(run.opened.startedWith).toBeUndefined()
  })

  it("starts it with a model and effort, and unled when asked to", async () => {
    const run = setup()
    const answer = await run.open({ agent: "claude", model: "opus", effort: "low", lead: false })
    expect(run.asked[0]!.command).toBe("claude --model opus --effort low")
    expect(run.asked[0]!.opener).toMatchObject({ leads: false })
    expect(answer).toMatchObject({ ok: true, led: false })
    expect(run.notices).toEqual([])
    expect(await run.open({ agent: "claude", effort: "low" })).toEqual({
      ok: false,
      reason: "Give a model with effort: Claude Code's efforts depend on the model.",
    })
  })

  it("starts an agent with a brief as its prompt's doorbell, and leads it by default", async () => {
    const run = setup()
    const answer = await run.open({ agent: "claude", message: "Review a.ts." })
    expect(run.asked[0]!.command).toMatch(line)
    expect(run.asked[0]!.opener).toMatchObject({ leads: true })
    expect(run.sent).toEqual([{ to: "fox", text: "Review a.ts." }])
    expect(answer).toMatchObject({ ok: true, led: true, task: { ok: true, id: "m1" } })
    expect(run.opened.startedWith).toMatch(/^[A-Za-z0-9]{6}$/)
    // The brief tells it who leads it: no notice beside it.
    expect(run.notices).toEqual([])
    run.deliver()
    await Promise.resolve()
    expect(run.ended).toEqual([])
  })

  it("leads only until the brief is delivered when asked not to lead with one", async () => {
    const run = setup()
    const answer = await run.open({ agent: "claude", message: "Review a.ts.", lead: false })
    // Led from the start, so the brief is the lead's, never a peer's request.
    expect(run.asked[0]!.opener).toMatchObject({ leads: true })
    expect(run.asked[0]!.command).toMatch(line)
    expect(run.sent).toEqual([{ to: "fox", text: "Review a.ts." }])
    expect(answer).toMatchObject({ ok: true, led: false, task: { ok: true } })
    expect(run.opened.summary.ledBy).toBe("moth")
    expect(run.notices).toEqual([])
    run.deliver()
    await Promise.resolve()
    expect(run.ended).toEqual(["t2"])
    expect(run.opened.summary.ledBy).toBeNull()
    expect(run.notices).toEqual([{ to: "t2", text: leadNotice.released("moth") }])
  })

  it("leads a brief and keeps leading it when asked to", async () => {
    const run = setup()
    const answer = await run.open({ agent: "claude", message: "Review a.ts.", lead: true })
    expect(answer).toMatchObject({ ok: true, led: true })
    run.deliver()
    await Promise.resolve()
    expect(run.ended).toEqual([])
  })

  it("resumes a past session of the agent, with the model, effort and a brief", async () => {
    const run = setup()
    const answer = await run.open({
      agent: "claude",
      resume: "s-1",
      model: "opus",
      message: "Carry on.",
    })
    expect(run.asked[0]!.command).toBe("claude --model opus --resume s-1")
    expect(run.asked[0]!.opener).toMatchObject({
      leads: true,
      resume: { agent: "claude", session: "s-1" },
    })
    expect(answer).toMatchObject({ ok: true, resumed: "s-1", led: true, task: { ok: true } })
    // The brief goes as a message after: the resumed session isn't started with a prompt.
    expect(run.sent).toEqual([{ to: "fox", text: "Carry on." }])
    expect(run.opened.startedWith).toBeUndefined()
  })

  it("resumes with no brief, and with Codex's and Antigravity's own words", async () => {
    const run = setup()
    await run.open({ agent: "codex", resume: "t-1", lead: false })
    await run.open({ agent: "agy", resume: "c-1" })
    expect(run.asked.map(({ command }) => command)).toEqual([
      "codex resume t-1",
      "agy --conversation c-1",
    ])
    expect(run.sent).toEqual([])
  })

  it("refuses a session another terminal runs or was given, and opens nothing", async () => {
    const run = setup(["claude:s-1"])
    const refusal = {
      ok: false,
      reason: expect.stringContaining("already open in a terminal"),
    }
    expect(await run.open({ agent: "claude", resume: "s-1" })).toMatchObject(refusal)
    run.claims.claim("codex:s-2", "other")
    expect(await run.open({ agent: "codex", resume: "s-2" })).toMatchObject(refusal)
    expect(await run.open({ agent: "agy", resume: "s-1" })).toMatchObject({ ok: true })
    expect(run.asked).toHaveLength(1)
  })

  it("refuses a command that would start an agent session, and lets any other through", async () => {
    const run = setup()
    for (const [command, agent] of [
      ["claude", "claude"],
      ["codex 'fix it'", "codex"],
      ["agy --conversation x", "agy"],
    ] as const)
      // eslint-disable-next-line no-await-in-loop -- Opened in turn.
      expect(await run.open({ command })).toEqual({
        ok: false,
        reason: sessionCommandRefusal(agent),
      })
    expect(run.asked).toEqual([])
    expect(await run.open({ command: "claude --version" })).toMatchObject({ ok: true })
    expect(await run.open({ command: "npm run dev" })).toMatchObject({ ok: true })
    expect(run.asked.map(({ opener }) => opener.leads)).toEqual([false, false])
  })
})
