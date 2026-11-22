import type { InboxEntry, InboxState } from "@novadeck/core/inbox"
import type { AgentMessage, MessagesState } from "@novadeck/core/messages"
import type { Approval } from "@novadeck/core/port"
import { itemFixture, terminalFixture, workspaceFixture } from "@novadeck/core/testing"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"
import type { Work } from "@novadeck/core/works"

import { leadState, noTeam, tourSignals } from "./signals"
import { describe, expect, it } from "./test"

const terminal = (parts: Partial<TerminalMetadata>): TerminalMetadata =>
  ({ ...terminalFixture(1, "~/.novadeck/tour"), ...parts }) as TerminalMetadata

describe("The tour's lead", () => {
  it("is gone without a terminal, and ended once its process is", () => {
    expect(leadState(undefined)).toEqual({ kind: "gone" })
    expect(leadState(terminal({ state: "exited", exitCode: 1, signal: null }))).toEqual({
      kind: "ended",
    })
  })

  it("is starting while no agent shows", () => {
    expect(leadState(terminal({ state: "running" }))).toEqual({ kind: "starting" })
    expect(leadState(terminal({ state: "idle" }))).toEqual({ kind: "starting" })
  })

  it("holds at a screen of its agent's own, as its status says", () => {
    expect(
      leadState(terminal({ state: "running", agent: { working: false, startup: "sign-in" } })),
    ).toEqual({ kind: "screen", screen: "sign-in" })
  })

  it("is its agent once there, named once it took a title of its own", () => {
    expect(leadState(terminal({ state: "running", agent: { working: true } }))).toEqual({
      kind: "agent",
      working: true,
      named: false,
      answered: false,
    })
    expect(
      leadState(
        terminal({
          state: "running",
          agent: { working: false },
          titleSource: { kind: "agent", by: "moth" },
        }),
      ),
    ).toMatchObject({ named: true })
  })
})

describe("The tour's lead, once its program ended", () => {
  it("has left where an agent ran and the shell is back, not while its command hasn't run", () => {
    expect(leadState(terminal({ state: "running", agentRan: true }))).toEqual({ kind: "left" })
    expect(leadState(terminal({ state: "idle", agentRan: true }))).toEqual({ kind: "left" })
    // A normal start: the shell is up and the command not yet an agent.
    expect(leadState(terminal({ state: "running" }))).toEqual({ kind: "starting" })
    expect(leadState(terminal({ state: "starting" }))).toEqual({ kind: "starting" })
    // Its process gone is `ended`, and an agent there again is its agent.
    expect(
      leadState(terminal({ state: "exited", exitCode: 1, signal: null, agentRan: true })),
    ).toEqual({
      kind: "ended",
    })
    expect(
      leadState(terminal({ state: "running", agentRan: true, agent: { working: false } })),
    ).toMatchObject({ kind: "agent" })
  })

  it("is told of a teammate or the artist that left", () => {
    const workspace = teamWorkspace()
    const roster = workspace.projects[0]!.history[0]!.state.roster
    Object.assign(roster, {
      terminals: roster.terminals.map((each) =>
        each.id === "04" ? { ...each, state: "running", agentRan: true } : each,
      ),
    })
    expect(tourSignals(workspace, "01").teamLeft).toBeNull()
    expect(tourSignals(workspace, "01", { artist: "04" }).teamLeft).toEqual({ terminalId: "04" })
  })
})

describe("The tour's lead, resting", () => {
  it("is its agent, asleep for a message to wake it, its turn ended", () => {
    expect(leadState(terminal({ state: "sleeping", agent: "claude" }))).toEqual({
      kind: "agent",
      working: false,
      named: false,
      answered: true,
    })
  })
})

describe("The tour's signals", () => {
  it("find the lead in any project, and say whether that project is on screen", () => {
    const workspace = workspaceFixture()
    const [first] = workspace.projects[0]!.history[0]!.state.roster.terminals
    expect(tourSignals(workspace, first!.id).onScreen).toBe(
      workspace.activeProjectId === workspace.projects[0]!.id,
    )
    expect(tourSignals(workspace, "nowhere")).toEqual({
      lead: { kind: "gone" },
      onScreen: false,
      ...noTeam,
    })
  })
})

// A workspace whose first terminal (01) leads 02 and 03, with 04 on its own.
const teamWorkspace = () => {
  const workspace = workspaceFixture({ terminals: 4 })
  const roster = workspace.projects[0]!.history[0]!.state.roster
  Object.assign(roster, {
    terminals: roster.terminals.map((each) =>
      each.id === "02" || each.id === "03"
        ? {
            ...each,
            ledBy: "01",
            ...(each.id === "02" && { titleSource: { kind: "agent", by: "glint" } as const }),
          }
        : each,
    ),
  })
  return workspace
}

const agentParty = (terminalId: string) =>
  ({ kind: "agent", terminalId, handle: terminalId, agent: "claude" }) as const

const message = (id: string, from: string, to: string): AgentMessage =>
  ({
    id,
    hop: 1,
    from: agentParty(from),
    to: agentParty(to),
    text: "hi",
    sentAt: 0,
    state: "delivered",
    held: null,
    deliveredAt: 0,
  }) as AgentMessage

const messagesOf = (list: readonly AgentMessage[]): MessagesState =>
  ({
    terminals: {
      a: { threads: [{ messages: list }] },
      b: { threads: [{ messages: list }] },
    },
  }) as unknown as MessagesState

const askRow = (terminalId: string, shape: "options" | "action" = "options"): InboxEntry =>
  ({
    id: `ask-${terminalId}`,
    kind: "ask",
    ask: { shape: { type: shape } },
    source: { terminalId },
    at: 0,
    stopped: false,
    seen: false,
  }) as unknown as InboxEntry

describe("The tour's story signals", () => {
  it("count the lead's teammates, and those that named themselves", () => {
    expect(tourSignals(teamWorkspace(), "01").team).toMatchObject({ count: 2, named: 1 })
  })

  it("see the person's answer delivered to a teammate, through a reload", () => {
    const answer = { ...message("a1", "02", "02"), inbox: "answer", from: { kind: "person" } }
    const messages = messagesOf([answer as AgentMessage])
    expect(tourSignals(teamWorkspace(), "01", { messages }).answered).toBe(true)
    expect(tourSignals(teamWorkspace(), "01").answered).toBe(false)
  })

  it("name a teammate holding at a screen of its own agent's", () => {
    const workspace = teamWorkspace()
    const roster = workspace.projects[0]!.history[0]!.state.roster
    Object.assign(roster, {
      terminals: roster.terminals.map((each) =>
        each.id === "03"
          ? {
              ...each,
              process: "codex",
              state: "running",
              agent: { working: false, startup: "startup" },
            }
          : each,
      ),
    })
    expect(tourSignals(workspace, "01").teamScreen).toEqual({
      terminalId: "03",
      screen: "startup",
      program: "codex",
    })
  })

  it("see a teammate's question waiting as options, not one from outside the team", () => {
    const asking = { items: [askRow("02")] } as unknown as InboxState
    const elsewhere = { items: [askRow("04")] } as unknown as InboxState
    const unblock = { items: [askRow("02", "action")] } as unknown as InboxState
    expect(tourSignals(teamWorkspace(), "01", { inbox: asking })).toMatchObject({
      asking: true,
      // Its own entry, which the stage marks to press: never another project's question.
      askingRow: "ask-02",
    })
    expect(tourSignals(teamWorkspace(), "01", { inbox: elsewhere })).toMatchObject({
      asking: false,
      askingRow: null,
    })
    expect(tourSignals(teamWorkspace(), "01", { inbox: unblock }).asking).toBe(false)
  })

  it("see an agent of the team waiting on the person's yes, from a dialog or a held message", () => {
    const entry = (kind: string, extra: object, id = "02") =>
      ({ ...askRow(id), kind, ...extra }) as unknown as InboxEntry
    const state = (...items: InboxEntry[]) => ({ items }) as unknown as InboxState
    const permission = entry("request", { request: { kind: "permission" } })
    const held = entry("held", {})
    const lead = entry("request", { request: { kind: "permission" } }, "01")
    expect(tourSignals(teamWorkspace(), "01", { inbox: state(permission) }).permission).toEqual({
      terminalId: "02",
    })
    expect(tourSignals(teamWorkspace(), "01", { inbox: state(held) }).permission).toEqual({
      terminalId: "02",
    })
    expect(tourSignals(teamWorkspace(), "01", { inbox: state(lead) }).permission).toEqual({
      terminalId: "01",
    })
  })

  it("see no permission wait for a question, a settled entry or a terminal outside the team", () => {
    const entry = (extra: object, id = "02") =>
      ({
        ...askRow(id),
        kind: "request",
        request: { kind: "permission" },
        ...extra,
      }) as unknown as InboxEntry
    const state = (...items: InboxEntry[]) => ({ items }) as unknown as InboxState
    const none = (...items: InboxEntry[]) =>
      tourSignals(teamWorkspace(), "01", { inbox: state(...items) }).permission
    expect(none(entry({ request: { kind: "question" } }))).toBeNull()
    expect(none(entry({ settled: { how: "answered" } }))).toBeNull()
    expect(none(entry({}, "04"))).toBeNull()
  })

  it("leave out a question of the lead's own, and an answer to it", () => {
    const asking = { items: [askRow("01")] } as unknown as InboxState
    expect(tourSignals(teamWorkspace(), "01", { inbox: asking }).asking).toBe(false)
    const settled = {
      items: [{ ...askRow("01"), settled: { how: "answered", at: 1 } }],
    } as unknown as InboxState
    expect(tourSignals(teamWorkspace(), "01", { inbox: settled }).answered).toBe(false)
  })

  it("see a teammate's question asked with its harness's own tool", () => {
    const question = {
      ...askRow("02"),
      kind: "request",
      request: { kind: "question" },
    } as unknown as InboxEntry
    const permission = {
      ...askRow("02"),
      kind: "request",
      request: { kind: "permission" },
    } as unknown as InboxEntry
    const ask = (entry: InboxEntry) => ({ items: [entry] }) as unknown as InboxState
    expect(tourSignals(teamWorkspace(), "01", { inbox: ask(question) }).asking).toBe(true)
    expect(tourSignals(teamWorkspace(), "01", { inbox: ask(permission) }).asking).toBe(false)
  })

  it("see a question the person answered or dismissed as dealt with, from its settled entry", () => {
    const settled = (how: string) =>
      ({ items: [{ ...askRow("02"), settled: { how, at: 1 } }] }) as unknown as InboxState
    for (const how of ["answered", "dismissed", "terminal"]) {
      const signals = tourSignals(teamWorkspace(), "01", { inbox: settled(how) })
      expect(signals).toMatchObject({ asking: false, answered: true })
    }
    // Its agent's session ending took it away, not the person.
    expect(tourSignals(teamWorkspace(), "01", { inbox: settled("ended") }).answered).toBe(false)
    // Nor does one from outside the team count.
    const elsewhere = {
      items: [{ ...askRow("04"), settled: { how: "answered", at: 1 } }],
    } as unknown as InboxState
    expect(tourSignals(teamWorkspace(), "01", { inbox: elsewhere }).answered).toBe(false)
  })

  it("count the lead's teammates by id, not the shell it opened for the game's server", () => {
    const workspace = teamWorkspace()
    const roster = workspace.projects[0]!.history[0]!.state.roster
    Object.assign(roster, {
      terminals: roster.terminals.map((each) =>
        each.id === "04" ? { ...each, openedBy: "01" } : each,
      ),
    })
    expect(tourSignals(workspace, "01").team).toEqual({ count: 2, named: 1, ids: ["02", "03"] })
  })
})

// What the agents showed, on the first session's bars.
const withItems = (workspace: Workspace, ...items: ReturnType<typeof itemFixture>[]): Workspace => {
  const state = workspace.projects[0]!.history[0]!.state
  Object.assign(state, { items: [...state.items, ...items] })
  return workspace
}

const work = (terminalId: string | null, ...paths: string[]) =>
  ({
    terminalId,
    merged: false,
    files: paths.map((path) => ({ path, status: "modified" })),
  }) as unknown as Work

const runApproval = (from: string, type = "run"): Approval =>
  ({
    requestId: "r1",
    from,
    terminalId: from,
    action: { type, command: "node dev.mjs 4000" },
  }) as Approval

describe("The tour's signals of the game story", () => {
  it("say the lead's run waits for a yes only while its own run approval is pending", () => {
    const signals = (approvals: Approval[]) => tourSignals(teamWorkspace(), "01", { approvals })
    expect(signals([runApproval("01")]).approving).toBe(true)
    expect(signals([]).approving).toBe(false)
    expect(signals([runApproval("02")]).approving).toBe(false)
    expect(signals([runApproval("01", "close")]).approving).toBe(false)
  })

  it("say the run was allowed once the lead opened a terminal of its own, or showed its page", () => {
    expect(tourSignals(teamWorkspace(), "01").served).toBe(false)
    const opened = teamWorkspace()
    const roster = opened.projects[0]!.history[0]!.state.roster
    Object.assign(roster, {
      terminals: roster.terminals.map((each) =>
        each.id === "04" ? { ...each, openedBy: "01" } : each,
      ),
    })
    expect(tourSignals(opened, "01").served).toBe(true)
    const page = withItems(teamWorkspace(), itemFixture("game", "01", { kind: "page" }))
    expect(tourSignals(page, "01")).toMatchObject({ served: true, shown: { page: "game" } })
  })

  it("find the sculptor by its model's work or its model shown or its question, never by title", () => {
    const by = (parts: Parameters<typeof tourSignals>[2], workspace = teamWorkspace()) =>
      tourSignals(workspace, "01", parts).roles
    expect(by({}).sculptor).toBeUndefined()
    expect(by({ works: [work("03", "worktrees/hero/model/hero.gltf")] }).sculptor).toBe("03")
    expect(by({ works: [work("03", "C:\\w\\hero\\model\\hero.gltf")] }).sculptor).toBe("03")
    expect(by({ works: [work("03", "other/model/hero.gltf.bak")] }).sculptor).toBeUndefined()
    const shown = withItems(teamWorkspace(), itemFixture("hero", "02", { kind: "model" }))
    expect(by({}, shown).sculptor).toBe("02")
    const asking = { items: [askRow("03")] } as unknown as InboxState
    expect(by({ inbox: asking }).sculptor).toBe("03")
  })

  it("find the fixer as another teammate, by the score's work or its changes shown", () => {
    const hero = work("02", "model/hero.gltf")
    const roles = (parts: Parameters<typeof tourSignals>[2]) =>
      tourSignals(teamWorkspace(), "01", parts).roles
    expect(roles({ works: [hero, work("03", "src/score.js")] })).toMatchObject({
      lead: "01",
      sculptor: "02",
      fixer: "03",
    })
    // One teammate never plays both.
    expect(roles({ works: [work("02", "model/hero.gltf", "src/score.js")] }).fixer).toBeUndefined()
    const shown = withItems(teamWorkspace(), itemFixture("diff", "03", { kind: "changes" }))
    expect(tourSignals(shown, "01").roles.fixer).toBe("03")
  })

  it("say which files were changed, whichever teammate's work did", () => {
    const works = [work("02", "model/hero.gltf")]
    expect(tourSignals(teamWorkspace(), "01", { works }).changed).toEqual({
      hero: true,
      score: false,
    })
    const both = [...works, work("03", "src/score.js")]
    expect(tourSignals(teamWorkspace(), "01", { works: both }).changed).toEqual({
      hero: true,
      score: true,
    })
    const removed = [{ ...work("03"), files: [{ path: "src/score.js", status: "deleted" }] }]
    expect(
      tourSignals(teamWorkspace(), "01", { works: removed as unknown as Work[] }).changed.score,
    ).toBe(false)
  })

  it("say what each role showed, on its own bar", () => {
    const workspace = withItems(
      teamWorkspace(),
      itemFixture("model", "02", { kind: "model" }),
      itemFixture("diff", "03", { kind: "changes" }),
      itemFixture("cover", "04", { kind: "image" }),
      // Another's image on the lead's bar is no one's cover.
      itemFixture("elsewhere", "01", { kind: "image" }),
    )
    const works = [work("02", "model/hero.gltf"), work("03", "src/score.js")]
    expect(tourSignals(workspace, "01", { works, artist: "04" }).shown).toEqual({
      page: null,
      model: "model",
      changes: "diff",
      cover: "cover",
    })
    expect(tourSignals(workspace, "01", { works }).shown.cover).toBeNull()
  })

  it("take the terminal the tour opened as the artist, and where its agent stands", () => {
    const workspace = teamWorkspace()
    const roster = workspace.projects[0]!.history[0]!.state.roster
    Object.assign(roster, {
      terminals: roster.terminals.map((each) =>
        each.id === "04"
          ? {
              ...each,
              state: "running",
              agent: { working: false },
              titleSource: { kind: "agent", by: "pixel" },
            }
          : each,
      ),
    })
    expect(tourSignals(workspace, "01").artist).toBeNull()
    const signals = tourSignals(workspace, "01", { artist: "04" })
    expect(signals.roles.artist).toBe("04")
    expect(signals.artist).toMatchObject({ kind: "agent", named: true })
    // It is on no team.
    expect(signals.team.ids).toEqual(["02", "03"])
  })

  it("say whether the artist and the lead have written to each other", () => {
    const said = (id: string, from: string, to: string) => message(id, from, to)
    const talk = (...list: AgentMessage[]) =>
      tourSignals(teamWorkspace(), "01", { artist: "04", messages: messagesOf(list) }).talk
    expect(talk()).toEqual({ toLead: false, fromLead: false })
    expect(talk(said("m1", "04", "01"))).toEqual({ toLead: true, fromLead: false })
    expect(talk(said("m1", "04", "01"), said("m2", "01", "04"))).toEqual({
      toLead: true,
      fromLead: true,
    })
    // A teammate's message to the artist is not the lead's answer.
    expect(talk(said("m3", "02", "04")).fromLead).toBe(false)
  })

  it("name the artist holding at a screen of its own, and its permission waits, like a teammate's", () => {
    const workspace = teamWorkspace()
    const roster = workspace.projects[0]!.history[0]!.state.roster
    Object.assign(roster, {
      terminals: roster.terminals.map((each) =>
        each.id === "04"
          ? {
              ...each,
              process: "claude",
              state: "running",
              agent: { working: false, startup: "startup" },
            }
          : each,
      ),
    })
    expect(tourSignals(workspace, "01", { artist: "04" }).teamScreen).toEqual({
      terminalId: "04",
      screen: "startup",
      program: "claude",
    })
    const permission = {
      ...askRow("04"),
      kind: "request",
      request: { kind: "permission" },
    } as unknown as InboxEntry
    const inbox = { items: [permission] } as unknown as InboxState
    expect(tourSignals(teamWorkspace(), "01", { inbox, artist: "04" }).permission).toEqual({
      terminalId: "04",
    })
    expect(tourSignals(teamWorkspace(), "01", { inbox }).permission).toBeNull()
  })

  it("say what each role's pane shows: its open top tab, by what it is", () => {
    const workspace = withItems(
      teamWorkspace(),
      itemFixture("model", "02", { kind: "model" }),
      itemFixture("cover", "04", { kind: "image" }),
    )
    const state = workspace.projects[0]!.history[0]!.state
    Object.assign(state, {
      bars: {
        "02": { order: ["model"], hidden: [], stack: ["model"], open: true },
        "04": {
          order: ["messages", "cover"],
          hidden: [],
          stack: ["cover", "messages"],
          open: false,
        },
        "01": { order: ["messages"], hidden: [], stack: ["messages"], open: true },
      },
    })
    const open = tourSignals(workspace, "01", { artist: "04" }).open
    expect(open).toMatchObject({ sculptor: "model", lead: "messages", artist: null })
  })
})
