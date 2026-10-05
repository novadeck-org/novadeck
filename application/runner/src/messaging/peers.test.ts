import { describe, expect, it } from "../test.js"
import type { Message } from "./mailbox.js"
import {
  ago,
  lastBetween,
  peerOf,
  renderAgents,
  renderPeer,
  unknownHandle,
  type Whereabouts,
} from "./peers.js"

const now = 10 * 60 * 60_000

const message = (fields: Partial<Message> = {}): Message => ({
  id: "m-1",
  projectId: "p",
  thread: "t-1",
  hop: 1,
  from: { terminalId: "A", handle: "t1", agent: "claude", sessionId: "s1" },
  to: { terminalId: "B", handle: "t2", agent: "codex", sessionId: "s2" },
  text: "hello",
  sentAt: now - 5 * 60_000,
  state: "queued",
  deliveredAt: null,
  notified: false,
  ...fields,
})

const peer = peerOf({
  terminalId: "B",
  handle: "t2",
  agent: "codex",
  expecting: null,
  busy: true,
  where: {
    title: "API author",
    titleSource: { kind: "agent", by: "t1" },
    summary: null,
    folder: "src/api",
    branch: "feat/paging",
    plan: "Pagination",
    work: {
      session: "codex:s2",
      first: "Build the users API",
      latest: "Build the users API",
      folders: { "C:\\w\\src\\api": 2, "C:\\w\\tests\\": 1 },
      activeAt: now - 2 * 60 * 60_000,
    },
    openedBy: null,
    working: false,
    place: (path) => path.replace(/^C:\\w\\/, ""),
  },
  withYou: lastBetween([message()], "A", { terminalId: "B", handle: "t2" }),
})

// A terminal t1's agent opened, whose first prompt the person submitted or not.
const opened = (firstByPerson: boolean, first = true) =>
  peerOf({
    terminalId: "E",
    handle: "t5",
    agent: "claude",
    expecting: null,
    busy: false,
    where: {
      title: "Terminal 05",
      titleSource: { kind: "default" },
      summary: null,
      folder: ".",
      branch: null,
      plan: null,
      work: {
        session: "claude:s",
        first: "fix the build",
        firstByPerson,
        ...(first && { opened: true as const }),
        latest: "fix the build",
        folders: {},
        activeAt: null,
      },
      openedBy: "t1",
      working: false,
      place: (path) => path,
    },
    withYou: null,
  })

describe("a peer as agents read it", () => {
  it("is one short block of what NovaDeck knows, each fact left out when unknown", () => {
    expect(renderPeer(peer, now)).toEqual([
      "- t2: Codex, busy, last active 2 h ago",
      "  title: API author (set by t1, not the user)",
      "  folder: src/api, branch feat/paging",
      // The latest prompt, the same as the first, is left out.
      "  started with: Build the users API",
      "  plan: Pagination",
      // One separator wherever the runner runs.
      "  works in: src/api/ (2), tests/ (1)",
      "  with you: you, 5 min ago: hello",
    ])
    const bare = peerOf({
      terminalId: "C",
      handle: "t3",
      agent: null,
      expecting: null,
      busy: false,
      where: undefined,
      withYou: null,
    })
    expect(renderPeer(bare, now)).toEqual(["- t3: no agent NovaDeck can deliver to"])
    // Opened to run an agent that hasn't started: messages to it are taken.
    const starting = peerOf({
      terminalId: "D",
      handle: "t4",
      agent: null,
      expecting: "codex",
      busy: false,
      where: undefined,
      withYou: null,
    })
    expect(renderPeer(starting, now)).toEqual(["- t4: expecting Codex, not started yet"])
    // Its agent at its prompt, whose hooks NovaDeck can't run there until the user trusts them.
    const untrusted = peerOf({
      terminalId: "F",
      handle: "t6",
      agent: null,
      expecting: "codex",
      untrusted: "codex",
      busy: false,
      where: undefined,
      withYou: null,
    })
    expect(untrusted).toMatchObject({ expecting: null, untrusted: "codex" })
    expect(renderPeer(untrusted, now)).toEqual([
      "- t6: no agent NovaDeck can deliver to: Codex runs there, but NovaDeck's hooks " +
        "aren't trusted for it yet (the user can trust them with /hooks)",
    ])
    // Opened by another terminal's agent with a task, before its session said anything.
    const tasked = peerOf({
      terminalId: "E",
      handle: "t5",
      agent: null,
      expecting: "claude",
      busy: false,
      where: {
        title: "Terminal 05",
        titleSource: { kind: "default" },
        summary: null,
        folder: ".",
        branch: null,
        plan: null,
        work: null,
        openedBy: "t1",
        working: false,
        place: (path) => path,
      },
      withYou: null,
    })
    expect(renderPeer(tasked, now)).toEqual([
      "- t5: expecting Claude Code, not started yet",
      "  title: Terminal 05",
      "  folder: .",
      "  opened by t1",
    ])
  })

  it("says who its title is from, and its agent's own summary, marked as its agent's", () => {
    const titled = (
      titleSource: Whereabouts["titleSource"],
      summary: string | null = null,
    ): readonly string[] =>
      renderPeer(
        peerOf({
          terminalId: "B",
          handle: "t2",
          agent: "codex",
          expecting: null,
          busy: false,
          where: {
            title: "Users API",
            titleSource,
            summary,
            folder: null,
            branch: null,
            plan: null,
            work: null,
            openedBy: null,
            working: false,
            place: (path) => path,
          },
          withYou: null,
        }),
        now,
      ).slice(1)
    expect(titled({ kind: "person" })).toEqual(["  title: Users API"])
    expect(titled({ kind: "agent", by: "t1" })).toEqual([
      "  title: Users API (set by t1, not the user)",
    ])
    expect(titled({ kind: "agent", by: "t2" }, "Builds the users API.\nThen paging.")).toEqual([
      "  title: Users API (set by its own agent, not the user)",
      "  described by its agent: Builds the users API. / Then paging.",
    ])
    expect(titled({ kind: "fallback" })).toEqual([
      "  title: Users API (from the user's first prompt there)",
    ])
    expect(titled({ kind: "default" })).toEqual(["  title: Users API"])
  })

  it("tells the latest message between the caller and the peer, either way", () => {
    const reply = message({
      from: message().to,
      to: { ...message().from, agent: "claude" },
      sentAt: now,
      text: "Done",
      state: "delivered",
    })
    expect(lastBetween([message(), reply], "A", { terminalId: "B", handle: "t2" })).toEqual({
      from: "t2",
      text: "Done",
      at: now,
    })
    expect(lastBetween([message()], "A", { terminalId: "C", handle: "t3" })).toBeNull()
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
        lastBetween([message(), pending(state)], "A", { terminalId: "B", handle: "t2" }),
      ).toMatchObject({ from: "you", text: "hello" })
    // Its own, the caller sees whatever their state.
    expect(
      lastBetween([message({ state: "held" })], "A", { terminalId: "B", handle: "t2" }),
    ).toMatchObject({ from: "you" })
  })

  it("says a terminal another agent opened started with its command, unless the user prompted it", () => {
    expect(renderPeer(opened(false), now)).toContain("  started with (t1's command): fix the build")
    expect(renderPeer(opened(true), now)).toContain("  started with: fix the build")
    // Only its first root session after the open: a later one is the person's.
    expect(renderPeer(opened(false, false), now)).toContain("  started with: fix the build")
  })
})

describe("what agents and a refused send say", () => {
  it("name the caller, its peers, and its messages not yet delivered", () => {
    const text = renderAgents({
      handle: "t1",
      peers: [],
      messages: [{ message: message({ state: "held" }), hold: "paused" }],
      unbound: true,
      now,
    })
    expect(text.split("\n").slice(0, 4)).toEqual([
      "You are t1 in NovaDeck.",
      "There are no other terminals in this project and session.",
      "Your messages not yet delivered:",
      expect.stringMatching(
        /^- m-1 to t2, sent \d\d:\d\d: held while the user has messaging paused$/,
      ),
    ])
    expect(text).toContain("replies can't reach you")
  })

  it("refuses a name that is no handle by describing every terminal there", () => {
    expect(unknownHandle("codex", "t1", [peer], now).split("\n").slice(0, 2)).toEqual([
      '"codex" is no terminal\'s handle here. Send to one of these by its exact handle, ' +
        "picking by its title, folder and work; if more than one could be meant, ask the user " +
        "rather than guess.",
      "Other terminals in this project and session:",
    ])
    expect(unknownHandle("t1", "t1", [], now)).toBe(
      "t1 is this terminal.\nThere are no other terminals in this project and session.",
    )
  })

  it("describe every other terminal there in full for a name that is no handle", () => {
    const others = [peer, opened(true)]
    expect(unknownHandle("codex", "t1", others, now)).toBe(
      [
        '"codex" is no terminal\'s handle here. Send to one of these by its exact handle, ' +
          "picking by its title, folder and work; if more than one could be meant, ask the user " +
          "rather than guess.",
        "Other terminals in this project and session:",
        ...renderPeer(peer, now),
        ...renderPeer(opened(true), now),
      ].join("\n"),
    )
    // Each by what tells it apart: its title, folder and work.
    expect(renderPeer(peer, now)).toEqual(
      expect.arrayContaining([
        "  title: API author (set by t1, not the user)",
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
