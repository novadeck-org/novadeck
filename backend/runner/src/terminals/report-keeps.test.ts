import type { LoggedReport } from "../messaging/report-log.js"
import { describe, expect, it } from "../test.js"
import { reportKeeps, type KeepParts } from "./report-keeps.js"

const row = (terminalId: string, sessionId: string, agent = "claude"): LoggedReport => ({
  id: `${terminalId}-${sessionId}`,
  projectId: "p",
  terminalId,
  agent: agent as LoggedReport["agent"],
  sessionId,
  kind: "done",
  at: 1,
  from: null,
  subject: "Done",
  outcome: null,
  text: null,
  pr: null,
})

type Held = ReturnType<KeepParts["saved"]["terminals"]>[number]

// The runner as the retention reads it: nothing running, saved or closed unless given.
const keeps = (
  over: {
    running?: KeepParts["running"]
    saved?: readonly Held[]
    closed?: readonly Held[]
    closing?: readonly string[]
  } = {},
) =>
  reportKeeps(
    over.running ?? new Map(),
    { terminals: () => over.saved ?? [] },
    { all: () => over.closed ?? [] },
    new Set(over.closing ?? []),
  )

describe("which report log rows are still wanted", () => {
  it("keeps those made in a terminal that runs or sleeps, and those of its sessions", () => {
    const wanted = keeps({
      running: new Map([
        ["run", { agents: {}, bound: { binding: { agent: "codex", sessionId: "bound" } } }],
      ]),
      saved: [{ id: "asleep", agents: { claude: { sessionId: "resting" } } }],
    })
    expect(wanted(row("run", "anything"))).toBe(true)
    expect(wanted(row("asleep", "anything"))).toBe(true)
    // A session resumed in another terminal reads what it reported where it was made.
    expect(wanted(row("elsewhere", "bound", "codex"))).toBe(true)
    expect(wanted(row("elsewhere", "resting"))).toBe(true)
    expect(wanted(row("elsewhere", "resting", "codex"))).toBe(false)
    expect(wanted(row("gone", "unheld"))).toBe(false)
  })

  it("keeps those of a terminal History keeps a row for, and of its sessions", () => {
    const wanted = keeps({
      closed: [{ id: "closed", agents: { claude: { sessionId: "kept" } } }],
    })
    expect(wanted(row("closed", "any"))).toBe(true)
    expect(wanted(row("restored", "kept"))).toBe(true)
    expect(wanted(row("other", "other"))).toBe(false)
  })

  it("lets go of a terminal closing, running or saved, unless History kept a row for it", () => {
    const running: KeepParts["running"] = new Map([
      ["t1", { agents: { claude: { sessionId: "s1" } }, bound: null }],
    ])
    const held = [{ id: "t1", agents: { claude: { sessionId: "s1" } } }]
    const closing = ["t1"]
    expect(keeps({ running, saved: held, closing })(row("t1", "s1"))).toBe(false)
    expect(keeps({ running, saved: held, closed: held, closing })(row("t1", "s1"))).toBe(true)
  })
})
