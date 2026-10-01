import { describe, expect, it } from "../test.js"
import type { Message } from "./mailbox.js"
import { ago, lastBetween, peerOf, renderAgents, renderPeer, unknownHandle } from "./peers.js"

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
    titledBy: "t1",
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
    place: (path) => path.replace(/^C:\\w\\/, ""),
  },
  withYou: lastBetween([message()], "A", { terminalId: "B", handle: "t2" }),
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
  })

  it("tells the latest message between the caller and the peer, either way", () => {
    const reply = message({
      from: message().to,
      to: { ...message().from, agent: "claude" },
      sentAt: now,
      text: "Done",
    })
    expect(lastBetween([message(), reply], "A", { terminalId: "B", handle: "t2" })).toEqual({
      from: "t2",
      text: "Done",
      at: now,
    })
    expect(lastBetween([message()], "A", { terminalId: "C", handle: "t3" })).toBeNull()
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

  it("say how long ago in words", () => {
    expect(ago(now - 10_000, now)).toBe("just now")
    expect(ago(now - 59 * 60_000, now)).toBe("59 min ago")
    expect(ago(now - 47 * 60 * 60_000, now)).toBe("47 h ago")
    expect(ago(now - 72 * 60 * 60_000, now)).toBe("3 days ago")
  })
})
