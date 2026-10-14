import { describe, expect, it } from "../test.js"
import type { Message } from "./mailbox.js"
import {
  ago,
  lastBetween,
  peerOf,
  type Peer,
  renderAgents,
  renderPeer,
  unknownHandle,
  type Waiting,
  type Whereabouts,
} from "./peers.js"

const now = 10 * 60 * 60_000

const message = (fields: Partial<Message> = {}): Message => ({
  id: "m-1",
  projectId: "p",
  thread: "t-1",
  hop: 1,
  from: { terminalId: "A", handle: "moth", agent: "claude", sessionId: "s1" },
  to: { terminalId: "B", handle: "fox", agent: "codex", sessionId: "s2" },
  text: "hello",
  sentAt: now - 5 * 60_000,
  state: "queued",
  deliveredAt: null,
  notified: false,
  fromLead: false,
  toLead: false,
  ...fields,
})

// Where a terminal is, as the manager tells it; each fact unknown unless given.
const whereabouts = (overrides: Partial<Whereabouts> = {}): Whereabouts => ({
  title: null,
  titleSource: null,
  summary: null,
  folder: null,
  branch: null,
  plan: null,
  work: null,
  openedBy: null,
  working: false,
  waiting: null,
  place: (path) => path,
  ...overrides,
})

type PeerInput = Parameters<typeof peerOf>[0]

// A peer with each fact unknown unless given: a busy-or-idle Claude Code agent.
const listing = (overrides: Partial<PeerInput> = {}): Peer =>
  peerOf({
    terminalId: "B",
    handle: "fox",
    agent: "claude",
    expecting: null,
    busy: false,
    where: undefined,
    withYou: null,
    lead: null,
    ...overrides,
  })

const peer = listing({
  agent: "codex",
  busy: true,
  where: whereabouts({
    title: "API author",
    titleSource: { kind: "agent", by: "moth" },
    folder: "src/api",
    branch: "feat/paging",
    plan: "Pagination",
    work: {
      session: "codex:s2",
      first: "Build the users API",
      latest: "Build the users API",
      recent: [],
      folders: { "C:\\w\\src\\api": 2, "C:\\w\\tests\\": 1 },
      activeAt: now - 2 * 60 * 60_000,
    },
    place: (path) => path.replace(/^C:\\w\\/, ""),
  }),
  withYou: lastBetween([message()], "A", { terminalId: "B", handle: "fox" }),
})

// A terminal moth's agent opened, whose first prompt the person submitted or not.
const opened = (firstByPerson: boolean, first = true) =>
  listing({
    terminalId: "E",
    handle: "kite",
    where: whereabouts({
      title: "Terminal 05",
      titleSource: { kind: "default" },
      folder: ".",
      work: {
        session: "claude:s",
        first: "fix the build",
        firstByPerson,
        ...(first && { opened: true as const }),
        latest: "fix the build",
        recent: [],
        folders: {},
        activeAt: null,
      },
      openedBy: "moth",
    }),
  })

// A peer as listed, opened by `openedBy` and led now by `lead`.
const led = (handle: string, openedBy: string | null, lead: string | null) =>
  listing({
    terminalId: handle,
    handle,
    where: whereabouts({ openedBy }),
    lead,
  })

// A busy peer led by @haze, waiting as given, as moth, led by @fox, reads it.
const listed = (waiting: Waiting | null, handle = "fox") =>
  renderPeer(
    listing({
      terminalId: handle,
      handle,
      busy: true,
      where: whereabouts({ openedBy: "haze", waiting }),
      lead: "haze",
    }),
    now,
    { handle: "moth", lead: "fox" },
  )

// Reads a peer as a reader with no lead and no one's lead would.
const read = (one: Peer) => renderPeer(one, now, { handle: "moth", lead: null })

describe("a peer as agents read it", () => {
  it("is one short block of what Novadeck knows, each fact left out when unknown", () => {
    expect(read(peer)).toEqual([
      "- @fox: Codex, busy, last active 2 h ago",
      "  title: API author (set by @moth, not the user)",
      "  folder: src/api, branch feat/paging",
      // The latest prompt, the same as the first, is left out.
      "  started with: Build the users API",
      "  plan: Pagination",
      // One separator wherever the runner runs.
      "  works in: src/api/ (2), tests/ (1)",
      "  with you: you, 5 min ago: hello",
    ])
    const bare = listing({ terminalId: "C", handle: "owl", agent: null })
    expect(read(bare)).toEqual(["- @owl: no agent Novadeck can deliver to"])
    // Opened to run an agent that hasn't started: messages to it are taken.
    const starting = listing({
      terminalId: "D",
      handle: "crow",
      agent: null,
      expecting: "codex",
    })
    expect(read(starting)).toEqual(["- @crow: expecting Codex, not started yet"])
    // Its agent at its prompt, whose hooks Novadeck can't run there until the user trusts them.
    const untrusted = listing({
      terminalId: "F",
      handle: "raven",
      agent: null,
      expecting: "codex",
      untrusted: "codex",
    })
    expect(untrusted).toMatchObject({ expecting: null, untrusted: "codex" })
    expect(read(untrusted)).toEqual([
      "- @raven: no agent Novadeck can deliver to: Codex runs there, but Novadeck's hooks " +
        "aren't trusted for it yet (the user can trust them with /hooks)",
    ])
    // Opened by another terminal's agent with a task, before its session said anything.
    const tasked = listing({
      terminalId: "E",
      handle: "kite",
      agent: null,
      expecting: "claude",
      where: whereabouts({
        title: "Terminal 05",
        titleSource: { kind: "default" },
        folder: ".",
        openedBy: "moth",
      }),
      lead: "moth",
    })
    expect(renderPeer(tasked, now, { handle: "haze", lead: null })).toEqual([
      "- @kite: expecting Claude Code, not started yet",
      "  title: Terminal 05",
      "  folder: .",
      "  led by @moth",
    ])
  })

  it("tells the lead relationship from the reader's side", () => {
    // moth leads fox: moth reads it as its worker.
    expect(read(led("fox", "moth", "moth"))[1]).toBe("  led by you")
    // fox reads moth as its lead, whoever opened or leads moth.
    const lead = "  your lead: it opened this terminal and directs your work"
    const reader = { handle: "fox", lead: "moth" }
    expect(renderPeer(led("moth", null, null), now, reader)[1]).toBe(lead)
    expect(renderPeer(led("moth", "dusk", "dusk"), now, reader)[1]).toBe(lead)
    // Nobody leads it, and it leads nobody here: nothing to say.
    expect(renderPeer(led("kite", null, null), now, reader)).toEqual(["- @kite: Claude Code, idle"])
    // A lead whose terminal closed leads no one, though the terminal was opened by it.
    expect(read(led("raven", "crow", null))).toEqual(read(led("raven", null, null)))
    // Led by another terminal, the reader's peers are just led by it.
    expect(read(led("owl", "crow", "crow"))[1]).toBe("  led by @crow")
  })

  it("names the lead of the reader, and what a peer waits on the user for", () => {
    expect(listed(null, "owl")).toEqual(["- @owl: Claude Code, busy", "  led by @haze"])
    const waits = (waiting: Waiting) => listed(waiting)[0]
    expect(
      waits({
        kind: "permission",
        tool: "Bash",
        subject: "rm -rf build",
        more: 0,
      }),
    ).toBe("- @fox: Claude Code, waiting on the user: permission to use Bash: rm -rf build")
    expect(
      waits({
        kind: "question",
        tool: "AskUserQuestion",
        subject: null,
        more: 2,
      }),
    ).toBe("- @fox: Claude Code, waiting on the user: a question (and 2 more)")
    expect(
      waits({
        kind: "plan",
        tool: "ExitPlanMode",
        subject: "plan.md",
        more: 0,
      }),
    ).toBe("- @fox: Claude Code, waiting on the user: approval of its plan: plan.md")
    // A long subject is cut.
    expect(
      waits({
        kind: "permission",
        tool: "Bash",
        subject: "x".repeat(300),
        more: 0,
      }),
    ).toHaveLength("- @fox: Claude Code, waiting on the user: permission to use Bash: ".length + 80)
  })

  it("says who its title is from, and lists its agent's summary on a line of its own", () => {
    const titled = (
      titleSource: Whereabouts["titleSource"],
      summary: string | null = null,
    ): readonly string[] =>
      read(
        listing({
          agent: "codex",
          where: whereabouts({ title: "Users API", titleSource, summary }),
        }),
      ).slice(1)
    expect(titled({ kind: "person" })).toEqual(["  title: Users API"])
    expect(titled({ kind: "agent", by: "moth" })).toEqual([
      "  title: Users API (set by @moth, not the user)",
    ])
    expect(titled({ kind: "murmur" }, "Builds the users API.\nThen paging.")).toEqual([
      "  title: Users API (written by Novadeck's local model, not the user)",
      "  described by its agent: Builds the users API. / Then paging.",
    ])
    expect(titled({ kind: "default" })).toEqual(["  title: Users API"])
    // A summary stands without a title of murmur's, as when the person named the terminal.
    expect(titled({ kind: "person" }, "Fixes login.")).toEqual([
      "  title: Users API",
      "  described by its agent: Fixes login.",
    ])
  })

  it("tells the latest message between the caller and the peer, either way", () => {
    const reply = message({
      from: message().to,
      to: { ...message().from, agent: "claude" },
      sentAt: now,
      text: "Done",
      state: "delivered",
    })
    expect(lastBetween([message(), reply], "A", { terminalId: "B", handle: "fox" })).toEqual({
      from: "fox",
      text: "Done",
      at: now,
    })
    expect(lastBetween([message()], "A", { terminalId: "C", handle: "owl" })).toBeNull()
  })

  it("never shows the caller a message still on its way to it, as held while paused", () => {
    const pending = (state: Message["state"]) =>
      message({
        from: message().to,
        to: { ...message().from, agent: "claude" },
        sentAt: now,
        text: "Rename yourself.",
        state,
      })
    for (const state of ["queued", "held", "leased", "gone"] as const)
      expect(
        lastBetween([message(), pending(state)], "A", {
          terminalId: "B",
          handle: "fox",
        }),
      ).toMatchObject({ from: "you", text: "hello" })
    // Its own, the caller sees whatever their state.
    expect(
      lastBetween([message({ state: "held" })], "A", {
        terminalId: "B",
        handle: "fox",
      }),
    ).toMatchObject({ from: "you" })
  })

  it("says a terminal another agent opened started with its command, unless the user prompted it", () => {
    expect(read(opened(false))).toContain("  started with (@moth's command): fix the build")
    expect(read(opened(true))).toContain("  started with: fix the build")
    // Only its first root session after the open: a later one is the person's.
    expect(read(opened(false, false))).toContain("  started with: fix the build")
  })
})

describe("what agents and a refused send say", () => {
  it("name the caller, its peers, and its messages not yet delivered", () => {
    const text = renderAgents({
      handle: "moth",
      lead: null,
      peers: [],
      messages: [{ message: message({ state: "held" }), hold: "paused" }],
      unbound: true,
      now,
    })
    expect(text.split("\n").slice(0, 4)).toEqual([
      "You are @moth in Novadeck.",
      "There are no other terminals in this project and session.",
      "Your messages not yet delivered:",
      expect.stringMatching(
        /^- m-1 to @fox, sent \d\d:\d\d: held while the user has messaging paused$/,
      ),
    ])
    expect(text).toContain("replies can't reach you")
  })

  it("refuses a name that is no handle by describing every terminal there", () => {
    expect(unknownHandle("codex", "moth", [peer], now, null).split("\n").slice(0, 2)).toEqual([
      '"codex" is no terminal\'s handle here. Send to one of these by its exact handle, ' +
        "picking by its title, folder and work; if more than one could be meant, ask the user " +
        "rather than guess.",
      "Other terminals in this project and session:",
    ])
    expect(unknownHandle("moth", "moth", [], now, null)).toBe(
      "@moth is this terminal.\nThere are no other terminals in this project and session.",
    )
  })

  it("describe every other terminal there in full for a name that is no handle", () => {
    const others = [peer, opened(true)]
    expect(unknownHandle("codex", "moth", others, now, null)).toBe(
      [
        '"codex" is no terminal\'s handle here. Send to one of these by its exact handle, ' +
          "picking by its title, folder and work; if more than one could be meant, ask the user " +
          "rather than guess.",
        "Other terminals in this project and session:",
        ...read(peer),
        ...read(opened(true)),
      ].join("\n"),
    )
    // Each by what tells it apart: its title, folder and work.
    expect(read(peer)).toEqual(
      expect.arrayContaining([
        "  title: API author (set by @moth, not the user)",
        "  folder: src/api, branch feat/paging",
        "  works in: src/api/ (2), tests/ (1)",
      ]),
    )
  })

  it("say how long ago in words", () => {
    expect(ago(now - 10_000, now)).toBe("just now")
    expect(ago(now - 59 * 60_000, now)).toBe("59 min ago")
    expect(ago(now - 47 * 60 * 60_000, now)).toBe("47 h ago")
    expect(ago(now - 72 * 60 * 60_000, now)).toBe("3 days ago")
  })
})
