import type { AgentName, TerminalSummary } from "@novadeck/protocol"

import type { Root } from "../harnesses/roots.js"
import { Messaging } from "../messaging/messaging.js"
import { describe, expect, it } from "../test.js"
import { introduction, unknownTo, type Caller } from "./introductions.js"
import { peerOf, TerminalPeers, type PeerRecord } from "./peers-host.js"
import type { AgentReport, Knew } from "./saved-terminals.js"

const hour = 3_600_000
const now = Date.now()
/** The caller's session began two hours ago; the handle was given one hour ago. */
const began = now - 2 * hour
const given = now - hour
const here = { projectId: "p", sessionId: "s" }

const rootOf = (agent: AgentName, sessionId: string): Root => ({
  agent,
  sessionId,
  instance: null,
  source: "binding",
})

type World = {
  readonly peers: TerminalPeers
  readonly messaging: Messaging
  readonly caller: PeerRecord
  readonly saved: Caller[]
  readonly records: Map<string, PeerRecord>
  /** A peers host over the same terminals, as a runner restarted over the saved reports. */
  readonly restarted: () => TerminalPeers
}

/**
 * Three running terminals of one project and session: `moth`, the caller, whose agent session
 * began long ago; `fox`, given its handle an hour ago, which the caller is never shown unless
 * a test does; and `owl`, given its handle before the caller's session began.
 */
const world = (
  options: {
    readonly knew?: Knew | undefined
    readonly agent?: AgentName
    readonly source?: Root["source"]
    readonly foxGivenAt?: number
  } = {},
): World => {
  const agent = options.agent ?? "claude"
  const messaging = new Messaging({
    now: () => Date.now(),
    sweepMs: 0,
    restoreMs: 0,
  })
  const record = (
    id: string,
    handle: string,
    handleGivenAt: number,
    extra: Partial<PeerRecord> = {},
  ): PeerRecord =>
    ({
      summary: {
        id,
        sessionId: "s",
        handle,
        handleGivenAt,
        title: `${handle} work`,
        cwd: "/w",
      } as TerminalSummary,
      naming: {
        person: null,
        opener: null,
        murmur: null,
        own: null,
        summary: `${handle} summary`,
      },
      work: null,
      openedBy: null,
      bound: null,
      ...extra,
    }) as PeerRecord
  const root = { ...rootOf(agent, "sa"), source: options.source ?? "binding" }
  const report: AgentReport = {
    sessionId: "sa",
    seq: 1,
    ...("knew" in options
      ? options.knew && { knew: options.knew }
      : { knew: { since: began, shown: [] } }),
  }
  const caller = record("A", "moth", began - hour, {
    root,
    agents: { [agent]: report },
  })
  const records = new Map([
    ["A", caller],
    ["F", record("F", "fox", options.foxGivenAt ?? given)],
    ["O", record("O", "owl", began - hour)],
  ])
  for (const [id, each] of records) {
    messaging.register(id, here, each.summary.handle, null)
    messaging.expect(id, "claude")
  }
  messaging.rooted("A", [{ type: "new", root, guess: false, ready: true }])
  const saved: Caller[] = []
  const build = () =>
    new TerminalPeers({
      messaging,
      caller: (terminalId) => (terminalId === "A" ? caller : undefined),
      terminal: (terminalId) => records.get(terminalId),
      running: () => [...records.values()],
      projectFolder: () => undefined,
      happenings: () => [],
      bar: () => [],
      worktrees: () => [],
      stopping: () => false,
      save: (each) => void saved.push(each),
      former: (_session, handle, before) =>
        handle === "fox" ? { title: "the old fox", closedAt: before - hour } : undefined,
    })
  return {
    peers: build(),
    messaging,
    caller,
    saved,
    records,
    restarted: build,
  }
}

const call = (request: { readonly [key: string]: unknown }) => ({
  type: "send" as const,
  terminalId: "A",
  token: "k",
  request,
})

const text = (answer: { readonly ok: boolean; readonly reason?: string }) =>
  answer.ok ? "" : (answer.reason ?? "")

describe("the rule for a handle given after an agent session began", () => {
  const target = { id: "F", givenAt: given }

  it("asks only when the handle was given after the session began", () => {
    const knew = { since: began, shown: [] }
    expect(unknownTo(knew, target, () => false)).toBe(true)
    // The session began after the handle was given: it knows only the holder now.
    expect(unknownTo({ since: given + 1, shown: [] }, target, () => false)).toBe(false)
    expect(unknownTo({ since: given, shown: [] }, target, () => false)).toBe(false)
  })

  it("never asks of a terminal whose handle was given long ago", () => {
    expect(unknownTo({ since: 0, shown: [] }, { id: "F", givenAt: 0 }, () => false)).toBe(false)
  })

  it("does not ask of a terminal the session was shown, or exchanged a message with", () => {
    expect(unknownTo({ since: began, shown: ["F"] }, target, () => false)).toBe(false)
    expect(unknownTo({ since: began, shown: [] }, target, () => true)).toBe(false)
    expect(unknownTo({ since: began, shown: ["O"] }, target, () => false)).toBe(true)
  })

  it("counts a session whose start is not known as having begun before everything", () => {
    expect(unknownTo({ since: 0, shown: [] }, target, () => false)).toBe(true)
  })

  it("names the new holder and the old one, and says calling again goes through", () => {
    const refusal = introduction(
      "fox",
      { title: "api server", summary: "serves the API", givenAt: given },
      { title: "old tests", closedAt: given - hour },
      now,
    )
    expect(refusal).toContain('@fox now is "api server", serves the API, opened 1 h ago.')
    expect(refusal).toContain('known as @fox ("old tests") closed 2 h ago')
    expect(refusal).toContain("call again with the same handle")
    expect(
      introduction("fox", { title: "t", summary: null, givenAt: given }, undefined, now),
    ).toContain("known as @fox closed.")
  })
})

describe("what an agent that called a recycled handle is told", () => {
  it("refuses the first send, naming the new holder and the closed one, then delivers the same call", async () => {
    const { peers } = world()
    const first = await peers.send(call({ to: "@fox", text: "hello" }))
    expect(first.ok).toBe(false)
    expect(text(first)).toContain('@fox now is "fox work", fox summary')
    expect(text(first)).toContain('("the old fox") closed')
    const second = await peers.send(call({ to: "@fox", text: "hello" }))
    expect(second).toMatchObject({ ok: true, to: "fox" })
  })

  it("sends at once to a terminal whose handle was given before the session began", async () => {
    const { peers } = world()
    expect(await peers.send(call({ to: "owl", text: "hi" }))).toMatchObject({
      ok: true,
    })
  })

  it("sends at once to a handle given long ago, whatever the session knew", async () => {
    const { peers } = world({ foxGivenAt: 0, knew: undefined })
    expect(await peers.send(call({ to: "fox", text: "hi" }))).toMatchObject({
      ok: true,
    })
  })

  it("sends at once when the session began after the handle was given", async () => {
    const { peers } = world({ knew: { since: given + 1_000, shown: [] } })
    expect(await peers.send(call({ to: "fox", text: "hi" }))).toMatchObject({
      ok: true,
    })
  })

  it("refuses a session whose start was never kept, once, and keeps that it was told", async () => {
    const { peers, saved, caller } = world({ knew: undefined })
    expect((await peers.send(call({ to: "fox", text: "hi" }))).ok).toBe(false)
    expect(saved).toHaveLength(1)
    expect(caller.agents?.claude?.knew).toEqual({ since: 0, shown: ["F"] })
    expect(await peers.send(call({ to: "fox", text: "hi" }))).toMatchObject({
      ok: true,
    })
  })

  it("refuses a root that is only a guess once, in memory", async () => {
    const { peers, saved, caller } = world({ agent: "agy" })
    expect((await peers.send(call({ to: "fox", text: "hi" }))).ok).toBe(false)
    expect(await peers.send(call({ to: "fox", text: "hi" }))).toMatchObject({
      ok: true,
    })
    // A guess may be corrected to another session, so nothing is kept for it.
    expect(saved).toEqual([])
    expect(caller.agents?.agy?.knew).toEqual({ since: began, shown: [] })
  })

  it("lets a session resumed after a runner restart keep what it was shown", async () => {
    const before = world()
    expect((await before.peers.send(call({ to: "fox", text: "hi" }))).ok).toBe(false)
    expect(before.caller.agents?.claude?.knew).toEqual({
      since: began,
      shown: ["F"],
    })
    // A new runner holds the same saved report, and nothing in memory.
    expect(await before.restarted().send(call({ to: "fox", text: "hi" }))).toMatchObject({
      ok: true,
    })
  })

  it("does not ask a session that /clear began after the handle was given", async () => {
    const { peers, caller, messaging } = world()
    expect((await peers.send(call({ to: "fox", text: "hi" }))).ok).toBe(false)
    // /clear: a new session, whose report starts when it begins, after the handle was given.
    const root = rootOf("claude", "sb")
    caller.root = root
    caller.agents = {
      claude: { sessionId: "sb", seq: 2, knew: { since: now, shown: [] } },
    }
    messaging.rooted("A", [{ type: "new", root, guess: false, ready: true }])
    expect(await peers.send(call({ to: "fox", text: "again" }))).toMatchObject({
      ok: true,
    })
  })

  it("sends at once to a terminal an agents listing showed", async () => {
    const { peers } = world()
    await peers.agents({
      type: "agents",
      terminalId: "A",
      token: "k",
      request: {},
    })
    expect(await peers.send(call({ to: "fox", text: "hi" }))).toMatchObject({
      ok: true,
    })
  })

  it("sends at once to a terminal a team listing showed", async () => {
    const { peers } = world()
    await peers.team({
      type: "team",
      terminalId: "A",
      token: "k",
      request: {},
    })
    expect(await peers.send(call({ to: "fox", text: "hi" }))).toMatchObject({
      ok: true,
    })
  })

  it("sends at once to a terminal the result of opening it named", async () => {
    const { peers } = world()
    peers.introduce("A", "F")
    expect(await peers.send(call({ to: "fox", text: "hi" }))).toMatchObject({
      ok: true,
    })
  })

  it("sends at once to a terminal it exchanged a message with in this session", async () => {
    const { peers, messaging } = world()
    // A message the caller sent it, as its brief; messaging sends it by id.
    expect(messaging.send("A", { to: "fox", text: "your brief" })).toMatchObject({ ok: true })
    expect(await peers.send(call({ to: "fox", text: "hi" }))).toMatchObject({
      ok: true,
    })
  })

  it("refuses a send to several, naming each one the session wasn't shown, before anything is sent", async () => {
    const { peers, messaging } = world()
    const refused = await peers.send(call({ to: "fox owl", text: "hi" }))
    expect(refused.ok).toBe(false)
    expect(text(refused)).toContain("@fox now is")
    expect(text(refused)).not.toContain("@owl now is")
    // Nothing went to owl: the call was refused whole.
    expect(messaging.onTheWay("A", "O")).toEqual([])
  })

  it("does not hold back a send to the team, which names no handle", async () => {
    const { peers } = world()
    const answer = await peers.send(call({ to: "team", text: "hi" }))
    expect(text(answer)).not.toContain("now is")
  })

  it("refuses the other tools that take a handle the same way, once", async () => {
    const { peers, caller: record } = world()
    const caller = peerOf(record)
    const refused = await peers.target(caller, "fox")
    expect(refused.ok).toBe(false)
    expect(text(refused)).toContain("@fox now is")
    expect(await peers.target(caller, "fox")).toMatchObject({
      ok: true,
      terminalId: "F",
    })
    // A terminal it was never refused for, given before its session began, resolves at once.
    expect(await peers.target(caller, "owl")).toMatchObject({
      ok: true,
      terminalId: "O",
    })
  })

  it("leaves a handle no terminal has to the refusal that describes the terminals", async () => {
    const { peers } = world()
    const answer = await peers.send(call({ to: "ghost", text: "hi" }))
    expect(text(answer)).toContain('"ghost" is no terminal\'s handle here')
  })
})
