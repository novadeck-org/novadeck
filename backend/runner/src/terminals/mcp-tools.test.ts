import { logs, useLogger } from "../log.js"
import { describe, expect, it } from "../test.js"
import { McpTools } from "./mcp-tools.js"

// A clock the test moves by hand.
const clock = () => {
  let at = 1_000
  return { now: () => at, pass: (ms: number) => (at += ms) }
}

describe("a terminal's agent holding Novadeck's MCP tools", () => {
  it("holds them while a session that listed them is open, a nested run's beside the agent's", () => {
    const tools = new McpTools()
    expect(tools.session("t", true)).toBe(true)
    // A nested run lists them too, then ends: the agent's session still holds them.
    expect(tools.session("t", true)).toBe(false)
    expect(tools.session("t", false)).toBe(false)
    expect(tools.wait("t")).toBe(0)
    // The agent's ends too: the next one waits for its own listing.
    expect(tools.session("t", false)).toBe(false)
    expect(tools.wait("t")).toBeGreaterThan(0)
  })

  it("waits from the first ask, until a session lists them or the wait runs out", () => {
    const { now, pass } = clock()
    const tools = new McpTools({ now, waitMs: 10_000 })
    expect(tools.wait("t")).toBe(10_000)
    pass(4_000)
    expect(tools.wait("t")).toBe(6_000)
    // Another terminal waits on its own.
    expect(tools.wait("u")).toBe(10_000)
    expect(tools.session("t", true)).toBe(true)
    expect(tools.wait("t")).toBe(0)
  })

  it("rings without them once its wait ran out, said once, and waits no more there until they are listed", ({
    resources,
  }) => {
    const lines: { evt: string; data?: unknown }[] = []
    const before = logs.current()
    const note = (evt: string, _msg?: string, detail?: { data?: unknown }) => {
      lines.push({ evt, data: detail?.data })
    }
    useLogger({
      for: () => ({ debug: note, info: note, warn: note, error: note, fatal: note }),
      flush: () => {},
      close: () => {},
    })
    resources.defer(() => useLogger(before))
    const { now, pass } = clock()
    const tools = new McpTools({ now, waitMs: 10_000 })
    tools.wait("t")
    pass(10_000)
    expect(tools.wait("t")).toBe(0)
    pass(60_000)
    expect(tools.wait("t")).toBe(0)
    expect(lines).toEqual([
      { evt: "doorbell.tools-late", data: { terminalId: "t", waitedMs: 10_000 } },
    ])
    // A session lists them and ends: a later agent there is waited for again.
    tools.session("t", true)
    tools.session("t", false)
    expect(tools.wait("t")).toBe(10_000)
  })

  it("waits not at all with no wait to give, as for a stand-in TUI that starts no MCP server", () => {
    const tools = new McpTools({ waitMs: 0 })
    expect(tools.wait("t")).toBe(0)
  })

  it("forgets a terminal that went", () => {
    const { now, pass } = clock()
    const tools = new McpTools({ now, waitMs: 10_000 })
    tools.session("t", true)
    tools.forget("t")
    expect(tools.wait("t")).toBe(10_000)
    pass(10_000)
    expect(tools.wait("t")).toBe(0)
    tools.forget("t")
    expect(tools.wait("t")).toBe(10_000)
  })
})
