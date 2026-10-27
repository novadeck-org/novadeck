import { freshWork } from "../terminals/work.js"
import { describe, expect, it } from "../test.js"
import type { Message } from "./messages.js"
import {
  ago,
  deliveredTo,
  lastBetween,
  peerOf,
  type Peer,
  renderAgents,
  renderPeer,
  standingDone,
  unknownHandle,
  type Waiting,
  waitsOnNote,
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
  stopped: false,
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
  waitsOn: null,
  reports: { tell: null, done: null },
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
    deliveredAt: null,
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
    const lead = "  your lead: it directs your work"
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

  it("says its agent reported done until a prompt or a message gave it more, and its latest update", () => {
    const report = (subject: string, minutes: number) => ({ subject, at: now - minutes * 60_000 })
    const reported = (
      reports: Whereabouts["reports"],
      given: { personAt?: number; deliveredAt?: number } = {},
    ): readonly string[] =>
      read(
        listing({
          deliveredAt: given.deliveredAt ?? null,
          where: whereabouts({
            reports,
            work: {
              ...freshWork("claude:s1"),
              ...(given.personAt !== undefined && { personAt: given.personAt }),
            },
          }),
        }),
      ).slice(1)
    const done = report("Fixed the login bug", 4)
    const tell = report("Opened PR #512", 20)
    expect(reported({ tell: null, done: null })).toEqual([])
    expect(reported({ tell, done })).toEqual(["  reported done 4 min ago: Fixed the login bug"])
    // A tell after its done is news of its own.
    expect(reported({ tell: report("Merged PR #512", 1), done })).toEqual([
      "  reported done 4 min ago: Fixed the login bug",
      "  latest update 1 min ago: Merged PR #512",
    ])
    // The person's prompt or a message delivered after the done gave it more to do.
    const after = now - 2 * 60_000
    for (const given of [{ personAt: after }, { deliveredAt: after }])
      expect(reported({ tell, done }, given)).toEqual([
        "  latest update 4 min ago: Fixed the login bug",
      ])
    // Nor did one before it.
    expect(reported({ tell, done }, { personAt: now - 10 * 60_000 })).toEqual([
      "  reported done 4 min ago: Fixed the login bug",
    ])
    expect(reported({ tell, done: null })).toEqual(["  latest update 20 min ago: Opened PR #512"])
    expect(
      reported({ tell: report(`Opened ${"a very long name ".repeat(20)}`, 1), done: null })[0],
    ).toMatch(/^ {2}latest update 1 min ago: Opened a very long name .*…$/)
    // A terminal with no agent bound says nothing of reports.
    expect(read(listing({ agent: null, where: whereabouts({ reports: { tell, done } }) }))).toEqual(
      ["- @fox: no agent Novadeck can deliver to"],
    )
  })

  it("knows when a message was last delivered to a terminal, never counting Novadeck's own notices", () => {
    const to = (terminalId: string, deliveredAt: number | null): Message =>
      message({ to: { ...message().to, terminalId }, deliveredAt })
    const notice = { ...to("B", 30), from: { ...message().from, terminalId: "novadeck" } }
    expect(deliveredTo([to("B", 5), to("B", 9), to("B", null), to("C", 20), notice], "B")).toBe(9)
    expect(deliveredTo([to("C", 20)], "B")).toBeNull()
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

  it("say why a message is held for release, as send did", () => {
    const text = renderAgents({
      handle: "moth",
      lead: null,
      peers: [],
      messages: [
        {
          message: message({ state: "held" }),
          hold: "release",
          why: "your thread with @fox waits for the user's release.",
        },
        { message: message({ id: "m-2", state: "held" }), hold: "release" },
      ],
      unbound: false,
      now,
    })
    expect(text).toContain(": held: your thread with @fox waits for the user's release.\n")
    expect(text).toContain(": held until the user releases its thread")
  })

  it("say why a message of the caller's will not arrive: its session ended, or the user stopped its thread", () => {
    const told = (fields: Partial<Message>) =>
      renderAgents({
        handle: "moth",
        lead: null,
        peers: [],
        messages: [{ message: message({ state: "gone", ...fields }), hold: null }],
        unbound: false,
        now,
      })
    expect(told({})).toMatch(/won't arrive: the agent session it was for ended$/m)
    expect(told({ stopped: true })).toMatch(
      /won't arrive: the user stopped it in Novadeck$/m,
    )
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

describe("a peer whose agent waits to be woken", () => {
  const job = (description: string | null, command: string) => ({
    id: "b1",
    description,
    command,
    since: now,
    until: null,
  })
  const waits = (
    waiting: Parameters<typeof waitsOnNote>[0],
    fields: Partial<PeerInput> = {},
  ): string =>
    read(
      listing({
        where: whereabouts({ waitsOn: waitsOnNote(waiting, now) }),
        ...fields,
      }),
    )[0]!

  it("says what it waits on in the agent's own words, and that it wakes by itself", () => {
    expect(waits({ jobs: [job("PR #436 checks", "gh pr checks 436 --watch")], wake: null })).toBe(
      "- @fox: Claude Code, waiting on PR #436 checks, will wake by itself",
    )
  })

  it("never shows a command, which may carry a secret, and counts the rest", () => {
    const line = waits({
      jobs: [job(null, `API_KEY=hunter2 gh run watch 1`), job("b", "c")],
      wake: null,
    })
    expect(line).toBe(
      "- @fox: Claude Code, waiting on a job it started (and 1 more), will wake by itself",
    )
  })

  it("cuts a long description short", () => {
    const line = waits({ jobs: [job("w".repeat(200), "c")], wake: null })
    expect(line).toMatch(/^- @fox: Claude Code, waiting on w+…, will wake/)
    expect(line.length).toBeLessThan(160)
  })

  it("says a wake-up it set", () => {
    expect(waits({ jobs: [], wake: { at: now, reason: "check the deploy" } })).toBe(
      "- @fox: Claude Code, waiting on a wake-up it set: check the deploy, will wake by itself",
    )
  })

  it("leaves out a wait whose time has passed", () => {
    const dead = { ...job("x", "y"), until: now - 1 }
    expect(waitsOnNote({ jobs: [dead], wake: null }, now)).toBeNull()
    expect(waitsOnNote({ jobs: [dead, job("live", "z")], wake: null }, now)).toBe("live")
    const wake = (at: number) => ({ jobs: [], wake: { at, reason: null } })
    expect(waitsOnNote(wake(now - 119_000), now)).toBe("a wake-up it set")
    expect(waitsOnNote(wake(now - 121_000), now)).toBeNull()
  })

  it("says nothing of a busy agent, and the person's request comes first", () => {
    const waiting = { jobs: [job("x", "y")], wake: null }
    expect(waits(waiting, { busy: true })).toBe("- @fox: Claude Code, busy")
    const asking = whereabouts({
      waitsOn: waitsOnNote(waiting, now),
      waiting: { kind: "question", tool: "AskUserQuestion", subject: null, more: 0 },
    })
    expect(read(listing({ where: asking }))[0]).toContain("waiting on the user: a question")
  })
})

describe("the done that stands", () => {
  const done = { subject: "Fixed it", at: 100 }
  const reports = { tell: null, done }

  it("stands until the person's prompt or a delivered message comes after it", () => {
    expect(standingDone(reports, undefined, null)).toBe(done)
    expect(standingDone(reports, 99, 50)).toBe(done)
    expect(standingDone(reports, 100, null)).toBeNull()
    expect(standingDone(reports, 10, 150)).toBeNull()
  })

  it("is none without a done", () => {
    expect(standingDone({ tell: null, done: null }, undefined, null)).toBeNull()
    expect(standingDone(undefined, undefined, null)).toBeNull()
  })
})
