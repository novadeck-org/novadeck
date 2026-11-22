import type { InboxEntry, InboxState } from "@novadeck/core/inbox"
import type { AgentMessage, MessagesState } from "@novadeck/core/messages"
import { itemFixture, terminalFixture, workspaceFixture } from "@novadeck/core/testing"
import type { TerminalMetadata } from "@novadeck/core/types"

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
    expect(tourSignals(teamWorkspace(), "01").team).toEqual({ count: 2, named: 1 })
  })

  it("count each message the teammates sent the team once, and none from outside it", () => {
    const messages = messagesOf([
      message("m1", "02", "03"),
      message("m2", "03", "01"),
      message("m3", "04", "01"),
    ])
    expect(tourSignals(teamWorkspace(), "01", { messages }).talks).toBe(2)
  })

  it("leave out the lead's own messages to its teammates, as their tasks", () => {
    const messages = messagesOf([message("t1", "01", "02"), message("t2", "01", "03")])
    expect(tourSignals(teamWorkspace(), "01", { messages }).talks).toBe(0)
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

  it("see the lead's own shown card, an image, not a teammate's", () => {
    const workspace = teamWorkspace()
    const state = workspace.projects[0]!.history[0]!.state
    Object.assign(state, { items: [itemFixture("card", "01", { kind: "image" })] })
    expect(tourSignals(workspace, "01").shown).toBe(true)
  })

  it("see the lead's own shown page or file, not a teammate's", () => {
    const workspace = teamWorkspace()
    const state = workspace.projects[0]!.history[0]!.state
    Object.assign(state, { items: [itemFixture("card", "02", { kind: "page" })] })
    expect(tourSignals(workspace, "01").shown).toBe(false)
    Object.assign(state, { items: [itemFixture("card", "01", { kind: "page" })] })
    expect(tourSignals(workspace, "01").shown).toBe(true)
  })

  it("see the lead's own shown 3D model", () => {
    const workspace = teamWorkspace()
    const state = workspace.projects[0]!.history[0]!.state
    Object.assign(state, { items: [itemFixture("card", "01", { kind: "model" })] })
    expect(tourSignals(workspace, "01").shown).toBe(true)
  })
})
