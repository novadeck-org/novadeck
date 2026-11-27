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

  it("is told of a teammate that left, not of a terminal outside the team", () => {
    const left = (id: string) => {
      const workspace = teamWorkspace()
      const roster = workspace.projects[0]!.history[0]!.state.roster
      Object.assign(roster, {
        terminals: roster.terminals.map((each) =>
          each.id === id ? { ...each, state: "running", agentRan: true } : each,
        ),
      })
      return tourSignals(workspace, "01").teamLeft
    }
    expect(left("04")).toBeNull()
    expect(left("03")).toEqual({ terminalId: "03" })
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

const message = (id: string, from: string, to: string, text = "hi", sentAt = 0): AgentMessage =>
  ({
    id,
    hop: 1,
    from: agentParty(from),
    to: agentParty(to),
    text,
    sentAt,
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

const inboxOf = (...items: InboxEntry[]): InboxState => ({ items }) as unknown as InboxState

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

  it("see the person's answer to the lead's sheet, delivered to the lead, through a reload", () => {
    const answer = { ...message("a1", "01", "01"), inbox: "answer", from: { kind: "person" } }
    const messages = messagesOf([answer as AgentMessage])
    expect(tourSignals(teamWorkspace(), "01", { messages }).sheet.answered).toBe(true)
    expect(tourSignals(teamWorkspace(), "01").sheet.answered).toBe(false)
    // An answer to a teammate's question is not the sheet's.
    const toMate = { ...answer, to: agentParty("02") }
    expect(
      tourSignals(teamWorkspace(), "01", { messages: messagesOf([toMate as AgentMessage]) }).sheet
        .answered,
    ).toBe(false)
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
    // Its own entry, which the stage marks to press: never another project's question.
    expect(tourSignals(teamWorkspace(), "01", { inbox: asking }).askingRow).toBe("ask-02")
    expect(tourSignals(teamWorkspace(), "01", { inbox: elsewhere }).askingRow).toBeNull()
    expect(tourSignals(teamWorkspace(), "01", { inbox: unblock }).askingRow).toBeNull()
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

  it("see the lead's own question as its sheet, apart from a teammate's", () => {
    const asking = { items: [askRow("01")] } as unknown as InboxState
    expect(tourSignals(teamWorkspace(), "01", { inbox: asking })).toMatchObject({
      sheet: { asking: true, row: "ask-01", answered: false },
      askingRow: null,
    })
    const mate = { items: [askRow("02")] } as unknown as InboxState
    expect(tourSignals(teamWorkspace(), "01", { inbox: mate }).sheet.asking).toBe(false)
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
    expect(tourSignals(teamWorkspace(), "01", { inbox: ask(question) }).askingRow).toBe("ask-02")
    expect(tourSignals(teamWorkspace(), "01", { inbox: ask(permission) }).askingRow).toBeNull()
  })

  it("see the sheet the person answered or dismissed as dealt with, from its settled entry", () => {
    const settled = (how: string, id = "01") =>
      ({ items: [{ ...askRow(id), settled: { how, at: 1 } }] }) as unknown as InboxState
    for (const how of ["answered", "dismissed", "terminal"]) {
      const signals = tourSignals(teamWorkspace(), "01", { inbox: settled(how) })
      expect(signals.sheet).toEqual({ asking: false, row: null, answered: true })
    }
    // Its agent's session ending took it away, not the person.
    expect(tourSignals(teamWorkspace(), "01", { inbox: settled("ended") }).sheet.answered).toBe(
      false,
    )
    // Nor does a teammate's count.
    expect(
      tourSignals(teamWorkspace(), "01", { inbox: settled("answered", "02") }).sheet.answered,
    ).toBe(false)
  })

  it("count the lead's teammates by id, not the shell it opened for the game's server", () => {
    const workspace = teamWorkspace()
    const roster = workspace.projects[0]!.history[0]!.state.roster
    Object.assign(roster, {
      terminals: roster.terminals.map((each) =>
        each.id === "04" ? { ...each, openedBy: "01" } : each,
      ),
    })
    expect(tourSignals(workspace, "01").team).toEqual({
      count: 2,
      named: 1,
      ids: ["02", "03"],
      // With no messages to read, every teammate counts as having told the lead.
      firstIn: 2,
      polished: 2,
      working: false,
      asked: false,
    })
  })

  it("count the teammates that told the lead their first version is in, and that it is polished", () => {
    const messages = messagesOf([
      message("m1", "03", "01", "World: first version in"),
      message("m2", "02", "04", "Core: first version in"),
      message("m3", "03", "01", "World: polished"),
      message("m4", "02", "01", "Core: what does your scene export?"),
    ])
    expect(tourSignals(teamWorkspace(), "01", { messages }).team).toMatchObject({
      firstIn: 1,
      polished: 1,
    })
  })

  it("say whether a teammate is at work, and whether one asked the person", () => {
    const workspace = teamWorkspace()
    const roster = workspace.projects[0]!.history[0]!.state.roster
    Object.assign(roster, {
      terminals: roster.terminals.map((each) =>
        each.id === "02" ? { ...each, state: "running", agent: { working: true } } : each,
      ),
    })
    expect(tourSignals(workspace, "01").team.working).toBe(true)
    expect(tourSignals(teamWorkspace(), "01").team.working).toBe(false)
    const asked = tourSignals(teamWorkspace(), "01", { inbox: inboxOf(askRow("03")) }).team
    expect(asked.asked).toBe(true)
    expect(tourSignals(teamWorkspace(), "01", { inbox: inboxOf(askRow("01")) }).team.asked).toBe(
      false,
    )
    expect(tourSignals(teamWorkspace(), "01").team.asked).toBe(false)
  })

  it("name the teammate that first wrote to another teammate, not to the lead", () => {
    const talker = (list: AgentMessage[]) =>
      tourSignals(teamWorkspace(), "01", { messages: messagesOf(list) })
    expect(talker([]).roles.talker).toBeUndefined()
    // To the lead, from the lead, and to a terminal outside the team: no one talks.
    expect(
      talker([message("m1", "02", "01"), message("m2", "01", "03"), message("m3", "02", "04")])
        .roles.talker,
    ).toBeUndefined()
    const first = talker([message("m2", "02", "03", "hi", 20), message("m1", "03", "02", "hi", 10)])
    expect(first.roles.talker).toBe("03")
    expect(first.mates.talker).toMatchObject({ kind: "starting" })
  })

  it("name the teammate to wait on: one that hasn't said it is polished", () => {
    const messages = messagesOf([message("m1", "02", "01", "Core: polished")])
    expect(tourSignals(teamWorkspace(), "01", { messages }).roles.mate).toBe("03")
    expect(tourSignals(teamWorkspace(), "01").roles.mate).toBe("02")
    expect(tourSignals(workspaceFixture({ terminals: 1 }), "01").roles.mate).toBeUndefined()
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

  it("find the maker by its model shown or its work on the models, never by title", () => {
    const by = (parts: Parameters<typeof tourSignals>[2], workspace = teamWorkspace()) =>
      tourSignals(workspace, "01", parts).roles
    expect(by({}).maker).toBeUndefined()
    expect(by({ works: [work("03", "worktrees/models/models/hero.gltf")] }).maker).toBe("03")
    expect(by({ works: [work("03", "C:\\w\\a\\models\\hero.gltf")] }).maker).toBe("03")
    expect(by({ works: [work("03", "other/notmodels/hero.gltf")] }).maker).toBeUndefined()
    // Work on the game casts no one.
    expect(by({ works: [work("03", "src/main.js")] }).maker).toBeUndefined()
    const shown = withItems(teamWorkspace(), itemFixture("hero", "02", { kind: "model" }))
    expect(by({}, shown).maker).toBe("02")
  })

  it("say what each role showed, on its own bar", () => {
    const workspace = withItems(
      teamWorkspace(),
      itemFixture("model", "02", { kind: "model" }),
      // A model on the lead's bar is no one's.
      itemFixture("elsewhere", "01", { kind: "model" }),
    )
    expect(tourSignals(workspace, "01").shown).toEqual({ page: null, model: "model" })
  })

  it("say what each role's pane shows: its open top tab, by what it is", () => {
    const workspace = withItems(teamWorkspace(), itemFixture("model", "02", { kind: "model" }))
    const state = workspace.projects[0]!.history[0]!.state
    Object.assign(state, {
      bars: {
        "02": { order: ["model"], hidden: [], stack: ["model"], open: true },
        "03": {
          order: ["messages", "diff"],
          hidden: [],
          stack: ["diff", "messages"],
          open: false,
        },
        "01": { order: ["messages"], hidden: [], stack: ["messages"], open: true },
      },
    })
    const open = tourSignals(workspace, "01").open
    expect(open).toMatchObject({ maker: "model", lead: "messages" })
  })
})
