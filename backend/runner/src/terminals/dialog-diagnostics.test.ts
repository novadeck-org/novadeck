import { refuse, type DialogAdapter } from "@novadeck/harness-core/dialogs"
import { fakeAdapter, FakeTui } from "@novadeck/harness-core/testing/dialogs"
import type { AgentName } from "@novadeck/protocol"

import { logs, useLogger } from "../log.js"
import { describe, expect, it } from "../test.js"
import { toolForLog } from "./dialog-diagnostics.js"
import { Dialogs, type Waiting } from "./dialogs.js"

type Line = {
  evt: string
  msg: string
  opts: { data?: Record<string, unknown>; verbose?: boolean }
}

// The log's lines, while the test runs.
const listening = (resources: { defer: (undo: () => void) => void }): Line[] => {
  const lines: Line[] = []
  const before = logs.current()
  const note = (evt: string, msg = "", opts: Line["opts"] = {}) =>
    void lines.push({ evt, msg, opts })
  useLogger({
    for: () => ({ debug: note, info: note, warn: note, error: note, fatal: note }),
    flush: () => {},
    close: () => {},
  })
  resources.defer(() => useLogger(before))
  return lines
}

const asked = (ref: string, command: string, tool = "Bash"): Waiting => ({
  ref,
  actor: null,
  facts: { kind: "permission", tool, input: { command }, cwd: null },
  subject: command,
  screen: false,
  askedAt: Date.now(),
})

// A terminal whose agent waits on a request for `command`, the fake TUI on its screen.
const terminal = (command: string, adapter: DialogAdapter | false = fakeAdapter()) => {
  const tui = new FakeTui()
  const requests = [asked("r1", command)]
  const dialogs = new Dialogs(
    {
      pending: () => ({ agent: "codex" as AgentName, version: "0.160.1", requests }),
      adapter: () => (adapter === false ? undefined : adapter),
      screen: () => Promise.resolve(tui.screen()),
      ask: () => {},
      clear: () => {},
      changed: () => {},
    },
    { throttleMs: 5, settleMs: 40, rawStillMs: 40, rawAgeMs: 40, rawLatestMs: 60 },
  )
  return { tui, dialogs }
}

const until = async (check: () => boolean): Promise<void> => {
  for (let tries = 0; tries < 200 && !check(); tries += 1)
    // eslint-disable-next-line no-await-in-loop -- Polled in turn.
    await new Promise((resolve) => setTimeout(resolve, 5))
  expect(check()).toBe(true)
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const named = (lines: Line[], evt: string) => lines.filter((line) => line.evt === evt)

// An adapter that reads nothing and says where it stopped.
const stopping: DialogAdapter = { read: () => refuse("fake.read.1") }

describe("the log of a dialog that can't be read", () => {
  it("tells it once for the request, however often the screen moves, with ids, counts and codes", async ({
    resources,
  }) => {
    const lines = listening(resources)
    const secret = "deploy --token hunter2-the-command"
    const { tui, dialogs } = terminal(secret, stopping)
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1")?.type === "raw")
    for (let frame = 0; frame < 6; frame += 1) {
      tui.noise += 1
      dialogs.changed("t")
      // eslint-disable-next-line no-await-in-loop -- A frame at a time.
      await pause(30)
    }
    const unread = named(lines, "dialogs.unread")
    expect(unread).toHaveLength(1)
    expect(unread[0]!.opts.data).toEqual({
      terminal: "t",
      harness: "codex",
      version: "0.160.1",
      kind: "permission",
      tool: "Bash",
      why: "unrecognized",
      refusals: "fake.read.1",
      cols: 80,
      rows: 5,
      waitedMs: expect.any(Number),
    })
    // Nothing the screen or the request said is in the line, but for the verbose lines.
    expect(JSON.stringify(unread)).not.toContain("hunter2")
    expect(JSON.stringify(unread)).not.toContain("FAKE")
    const screen = named(lines, "dialogs.screen")
    expect(screen.length).toBeGreaterThan(0)
    expect(screen.every((line) => line.opts.verbose === true)).toBe(true)
    expect(screen.map((line) => line.msg)).toContain("FAKE ASK ls")
  })

  it("names a harness with no adapter as unsupported, with no codes", async ({ resources }) => {
    const lines = listening(resources)
    const { dialogs } = terminal("ls", false)
    dialogs.changed("t")
    await until(() => named(lines, "dialogs.unread").length === 1)
    expect(named(lines, "dialogs.unread")[0]!.opts.data).toMatchObject({
      why: "unsupported",
      refusals: "",
    })
  })

  it("tells once that a raw dialog read after all, with how long it was raw", async ({
    resources,
  }) => {
    const lines = listening(resources)
    const { tui, dialogs } = terminal("pwd")
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1")?.type === "raw")
    tui.command = "pwd"
    tui.noise += 1
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1")?.type === "choices")
    for (let frame = 0; frame < 3; frame += 1) {
      tui.noise += 1
      dialogs.changed("t")
      // eslint-disable-next-line no-await-in-loop -- A frame at a time.
      await pause(20)
    }
    const late = named(lines, "dialogs.read-late")
    expect(late).toHaveLength(1)
    expect(late[0]!.opts.data).toEqual({
      terminal: "t",
      harness: "codex",
      version: "0.160.1",
      kind: "permission",
      tool: "Bash",
      rawMs: expect.any(Number),
    })
    expect(named(lines, "dialogs.unread")).toHaveLength(1)
  })

  it("says nothing of a dialog that reads at once", async ({ resources }) => {
    const lines = listening(resources)
    const { dialogs } = terminal("ls")
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1")?.type === "choices")
    await pause(50)
    expect(lines.filter((line) => line.evt.startsWith("dialogs."))).toEqual([])
  })

  it("tells a failed answer once, with the driver's own words, and the dialog going raw", async ({
    resources,
  }) => {
    const lines = listening(resources)
    const { dialogs } = terminal("ls")
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1")?.type === "choices")
    const why = "The screen never showed question 2 of 3."
    dialogs.lock("t", "r1", "failed", ["the screen"], why)
    dialogs.lock("t", "r1", "failed", ["the screen"], why)
    expect(named(lines, "dialogs.answer-failed")).toHaveLength(1)
    expect(named(lines, "dialogs.answer-failed")[0]!.opts.data).toEqual({
      terminal: "t",
      harness: "codex",
      version: "0.160.1",
      kind: "permission",
      tool: "Bash",
      pressed: true,
      why,
    })
    expect(named(lines, "dialogs.unread")[0]!.opts.data).toMatchObject({ why: "failed" })
  })
})

describe("the tool a dialog line names", () => {
  it("keeps a harness's own tool and hides an MCP server's and tool's names", () => {
    expect(toolForLog("Bash")).toBe("Bash")
    expect(toolForLog("run_command")).toBe("run_command")
    expect(toolForLog("mcp__our-server__elicitation")).toBe("mcp")
    expect(toolForLog("call_mcp_tool")).toBe("mcp")
    expect(toolForLog("deploy the thing/now")).toBe("other")
  })
})
