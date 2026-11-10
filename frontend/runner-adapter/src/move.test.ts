import { describe, expect, it } from "./test"
import { id, keptSummary, scripted } from "./testing/scripted"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const sessionOf = (app: ReturnType<typeof scripted>, sessionId: string) =>
  app.workspace().projects[0]!.history.find((each) => each.id === sessionId)!.state.roster

describe("a terminal the runner moves to another session", () => {
  it("goes there with its shell, under its new handle, and closes nothing", async () => {
    const running = keptSummary(id(1), id(8), { started: true, handle: "moth" })
    const app = scripted({
      shown: [{ id: id(1), lastProcess: "" }],
      background: [{ id: id(2), lastProcess: "" }],
      listed: [running],
      apply: true,
    })
    await wait(100)
    app.changes.push({
      type: "changed",
      terminal: { ...running, sessionId: id(9), handle: "fox" },
    })
    await wait(100)
    expect(sessionOf(app, id(8)).terminals.map((each) => each.id)).toEqual([])
    expect(sessionOf(app, id(9)).terminals.find((each) => each.id === id(1))).toMatchObject({
      handle: "fox",
    })
    expect(app.of("close")).toEqual([])
    expect(app.of("create")).toEqual([])
    app.stop()
  })

  it("is asked of the runner once the session it goes to is there", async () => {
    const running = keptSummary(id(1), id(8), { started: true })
    const moved = {
      sessionId: id(9),
      moved: [{ terminalId: id(1), handle: "moth", was: "moth" }],
      left: null,
    }
    const app = scripted({
      shown: [{ id: id(1), lastProcess: "" }],
      background: [{ id: id(2), lastProcess: "" }],
      listed: [running],
      move: async () => moved,
    })
    await wait(100)
    await expect(app.backend.moveTerminal!(app.key(id(1)), id(9))).resolves.toEqual(moved)
    expect(app.of("move")).toEqual([{ terminalId: id(1), to: { sessionId: id(9) } }])
    app.stop()
  })
})
