import { vi } from "vitest"

import { describe, expect, it } from "../test.js"
import { novadeckSender, type Message } from "./messages.js"
import { peerOf, type Happening, type Peer, type Whereabouts } from "./peers.js"
import { exchanged, happened, renderTeam, type Entry, type Look } from "./team.js"

const now = 10 * 60 * 60_000
const minutes = (count: number) => count * 60_000

// What an entry says, apart from the key that tells it from the others.
const quoted = (entries: Entry[]) => entries.map(({ at, text }) => ({ at, text }))

const whereabouts = (overrides: Partial<Whereabouts> = {}): Whereabouts => ({
  title: null,
  summary: null,
  git: null,
  working: false,
  since: null,
  waiting: null,
  waitsOn: null,
  startup: null,
  happenings: [],
  standing: false,
  shell: { running: false, command: null },
  background: null,
  ...overrides,
})

const member = (
  handle: string,
  lead: string | null,
  where: Partial<Whereabouts> = {},
  busy = false,
): Peer =>
  peerOf({
    terminalId: handle.toUpperCase(),
    handle,
    agent: "claude",
    expecting: null,
    busy,
    where: whereabouts(where),
    lead,
  })

const message = (fields: Partial<Message> = {}): Message => ({
  id: "m-1",
  projectId: "p",
  thread: "t-1",
  hop: 1,
  from: { kind: "agent", terminalId: "MOTH", handle: "moth", agent: "claude", sessionId: "s1" },
  to: { terminalId: "FOX", handle: "fox", agent: "claude", sessionId: "s2" },
  text: "Leave them,\nadd a follow-up issue",
  sentAt: now - minutes(4),
  state: "queued",
  deliveredAt: null,
  notified: false,
  stopped: false,
  fromLead: false,
  toLead: false,
  ...fields,
})

const team = (input: {
  handle?: string
  lead?: string | null
  peers: readonly Peer[]
  exchanges?: (peer: Peer) => readonly Entry[]
  look?: Look
  all?: boolean
}) =>
  renderTeam({
    handle: input.handle ?? "moth",
    lead: input.lead ?? null,
    peers: input.peers,
    exchanges: input.exchanges ?? (() => []),
    look: input.look,
    all: input.all ?? false,
    now,
  })

describe("what a member's agent session did, as team lists it", () => {
  const update = (at: number): Happening => ({
    kind: "update",
    at,
    subject: "Tests pass",
    body: "",
    pr: null,
  })
  const turn = (
    at: number,
    text: string | null = "Should I also migrate the old rows?",
    from: number | null = null,
  ) => ({ kind: "turn", at, from, outcome: "completed", text }) as const

  it("lists a report whose body was not read by its subject alone", () => {
    expect(
      quoted(happened([{ kind: "done", at: 5, subject: "Shipped", body: null, pr: null }])),
    ).toEqual([{ at: 5, text: "done: Shipped" }])
  })

  it("lists its reports, its asks, and each turn that ended without a report", () => {
    expect(
      quoted(
        happened([
          update(10),
          turn(11),
          turn(20),
          { kind: "asked", at: 21, subject: "Which shape?" },
          { kind: "done", at: 25, subject: "Shipped", body: "PR merged\nand released", pr: null },
          turn(26),
          { kind: "turn", at: 30, from: null, outcome: "failed", text: "API error" },
        ]),
      ),
    ).toEqual([
      { at: 10, text: "update: Tests pass" },
      { at: 20, text: 'turn ended without a report: "Should I also migrate the old rows?"' },
      { at: 21, text: "asked the user: Which shape?" },
      { at: 25, text: "done: Shipped — PR merged and released" },
      { at: 30, text: "turn failed: API error" },
    ])
  })

  it("says a silent turn ended even where it has no reply", () => {
    expect(happened([turn(5, null)])).toEqual([{ at: 5, text: "turn ended without a report" }])
  })

  it("credits a report to the turn it came in, where the turn's start is known", () => {
    // The update came in a turn that was interrupted, which isn't kept: the next turn,
    // started after it, still ended without a report.
    expect(quoted(happened([update(100), turn(300, "Should I migrate the rows?", 200)]))).toEqual([
      { at: 100, text: "update: Tests pass" },
      { at: 300, text: 'turn ended without a report: "Should I migrate the rows?"' },
    ])
    expect(
      quoted(happened([turn(300, "Done", 50), update(100)].toSorted((a, b) => a.at - b.at))),
    ).toEqual([{ at: 100, text: "update: Tests pass" }])
  })
})

describe("the messages between the caller and a member", () => {
  const fox = { terminalId: "FOX", handle: "fox" }

  it("say where each of the caller's is, and show the member's once delivered", () => {
    const back = (fields: Partial<Message>) =>
      message({
        id: "m-2",
        from: { kind: "agent", terminalId: "FOX", handle: "fox", agent: "claude", sessionId: "s2" },
        to: { terminalId: "MOTH", handle: "moth", agent: "claude", sessionId: "s1" },
        text: "Done with the compact view",
        ...fields,
      })
    const texts = (messages: Message[]) => exchanged(messages, "MOTH", fox).map(({ text }) => text)
    expect(
      texts([
        message(),
        message({ id: "m-3", state: "delivered" }),
        message({ id: "m-4", state: "held" }),
        message({ id: "m-5", state: "gone" }),
      ]),
    ).toEqual([
      'you → @fox, on its way: "Leave them, add a follow-up issue"',
      'you → @fox: "Leave them, add a follow-up issue"',
      'you → @fox, held until the user lets it go: "Leave them, add a follow-up issue"',
      'you → @fox, won\'t arrive: "Leave them, add a follow-up issue"',
    ])
    expect(texts([back({ state: "delivered" })])).toEqual([
      '@fox → you: "Done with the compact view"',
    ])
    // On its way to the caller, its text never shows: no listing gets past a pause.
    expect(texts([back({ state: "held" })])).toEqual(["@fox → you: a message on its way to you"])
    expect(texts([back({ state: "gone" })])).toEqual([])
  })

  it("leave out Novadeck's notices and other terminals' messages", () => {
    const notice = message({ from: novadeckSender })
    const other = message({
      to: { terminalId: "OWL", handle: "owl", agent: "claude", sessionId: "s" },
    })
    expect(exchanged([notice, other], "MOTH", fox)).toEqual([])
  })
})

describe("what team says", () => {
  const fox = member("fox", "moth", {
    title: "ti listing",
    summary: "Splitting the listing",
    since: now - minutes(6),
    happenings: [
      {
        kind: "update",
        at: now - minutes(12),
        subject: "PR opened, CI running",
        body: "",
        pr: null,
      },
      // The turn the update was told in, then one that ended with no report.
      { kind: "turn", at: now - minutes(10), from: null, outcome: "completed", text: "PR is up" },
      {
        kind: "turn",
        at: now - minutes(5),
        from: null,
        outcome: "completed",
        text: "Should I migrate?",
      },
    ],
  })
  const owl = member("owl", "moth", { since: now - minutes(3) }, true)

  it("names the team, then each member with what happened, its lead first", () => {
    const lead = member("crow", null)
    const mate = member("wren", "crow")
    const { text } = team({ handle: "moth", lead: "crow", peers: [mate, fox, lead, owl] })
    expect(text.split("\n")).toEqual([
      "You are @moth in Novadeck.",
      "Your team in this project and session:",
      "- led by @crow: @wren and you",
      "- led by you: @fox and @owl",
      "- @crow: Claude Code, idle, your lead",
      "  nothing reported yet",
      "- @wren: Claude Code, idle, your teammate",
      "  nothing reported yet",
      "- @fox · ti listing: Claude Code, idle for 6 min, led by you",
      '  "Splitting the listing"',
      "  latest:",
      "    12 min ago, update: PR opened, CI running",
      '    5 min ago, turn ended without a report: "Should I migrate?"',
      "- @owl: Claude Code, busy for 3 min, led by you",
      "  nothing reported yet",
    ])
  })

  it("leaves out peers, and says when the caller is on no team", () => {
    const { text } = team({ peers: [member("fox", null), member("owl", "crow")] })
    expect(text).toBe(
      "You are @moth in Novadeck, on no team in this project and session: no agent leads " +
        "you, and you lead none. Call agents to see every terminal here.",
    )
  })

  it("shows only what happened since the caller last looked, a member with nothing new on one line", () => {
    // The caller looked 8 minutes ago, before the last turn ended and its message went.
    const earlier = { ...fox, happenings: fox.happenings.slice(0, 2) }
    const { look } = team({ peers: [earlier, owl] })
    const { text } = team({
      peers: [fox, owl],
      look,
      exchanges: (peer) =>
        peer.handle === "fox"
          ? exchanged([message()], "MOTH", { terminalId: "FOX", handle: "fox" })
          : [],
    })
    expect(text.split("\n").slice(3)).toEqual([
      "- @fox · ti listing: Claude Code, idle for 6 min, led by you",
      '  "Splitting the listing"',
      "  since you last looked:",
      '    5 min ago, turn ended without a report: "Should I migrate?"',
      '    4 min ago, you → @fox, on its way: "Leave them, add a follow-up issue"',
      "- @owl: Claude Code, busy for 3 min, led by you · nothing new since you last looked",
    ])
  })

  it("shows a turn stored after the caller looked, though it ended before", () => {
    // A turn's end is stored a moment after it ends: a lead woken by its worker may look
    // in between.
    const idle = member("fox", "moth", { since: now - minutes(1) })
    const { look } = team({ peers: [idle] })
    const stored = member("fox", "moth", {
      since: now - minutes(1),
      happenings: [
        { kind: "turn", at: now - minutes(1), from: null, outcome: "completed", text: "Hm?" },
      ],
    })
    expect(team({ peers: [stored], look }).text).toContain(
      '  since you last looked:\n    1 min ago, turn ended without a report: "Hm?"',
    )
  })

  it("shows a message again once where it is changed", () => {
    const quiet = member("fox", "moth")
    const said = (state: Message["state"]) => () =>
      exchanged([message({ state })], "MOTH", { terminalId: "FOX", handle: "fox" })
    const { look } = team({ peers: [quiet], exchanges: said("held") })
    expect(team({ peers: [quiet], look, exchanges: said("held") }).text).toContain(
      "nothing new since you last looked",
    )
    expect(team({ peers: [quiet], look, exchanges: said("gone") }).text).toContain(
      "you → @fox, won't arrive:",
    )
  })

  it("shows a member whose state changed, though nothing new happened", () => {
    const { look } = team({ peers: [owl] })
    const idle = member("owl", "moth", { since: now - minutes(1) })
    expect(
      team({ peers: [idle], look })
        .text.split("\n")
        .slice(3),
    ).toEqual(["- @owl: Claude Code, idle for 1 min, led by you"])
  })

  it("shows every member's latest with all, whatever the caller saw", () => {
    const { look } = team({ peers: [fox] })
    expect(team({ peers: [fox], look, all: true }).text).toContain(
      "  latest:\n    12 min ago, update: PR opened, CI running",
    )
  })

  it("reads the body of only the reports it shows", () => {
    const read = vi.fn<() => string>(() => "the whole report")
    const busy = member("fox", "moth", {
      happenings: Array.from({ length: 8 }, (_, index) => ({
        kind: "done" as const,
        at: now - minutes(10 - index),
        subject: `Done ${index + 1}`,
        body: null,
        pr: null,
        read,
      })),
    })
    const text = team({ peers: [busy] }).text
    expect(read).toHaveBeenCalledTimes(5)
    expect(text).toContain("done: Done 8 — the whole report")
    // Looking again, the entries seen are told apart without reading any body.
    read.mockClear()
    const first = team({ peers: [busy] })
    team({ peers: [busy], look: first.look })
    expect(read).toHaveBeenCalledTimes(5)
  })

  it("shows the latest few of a member's entries, and counts the rest", () => {
    const busy = member("fox", "moth", {
      happenings: Array.from({ length: 8 }, (_, index) => ({
        kind: "asked" as const,
        at: now - minutes(10 - index),
        subject: `Question ${index + 1}`,
      })),
    })
    const lines = team({ peers: [busy] })
      .text.split("\n")
      .slice(4)
    expect(lines[0]).toBe("  latest (and 3 earlier):")
    expect(lines.slice(1)).toHaveLength(5)
    expect(lines.at(-1)).toBe("    3 min ago, asked the user: Question 8")
  })

  it("shows in full what a member waits on the person for", () => {
    const subject = `Which listing shape? ${"x".repeat(200)}`
    const waiting = member("fox", "moth", {
      waiting: { kind: "question", tool: "AskUserQuestion", subject, more: 0, since: null },
    })
    expect(team({ peers: [waiting] }).text).toContain(
      `- @fox: Claude Code, waiting on the user: a question: ${subject}, led by you`,
    )
  })
})
