import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll } from "vitest"

import { plugin } from "../harnesses/harness.js"
import { describe, expect, it } from "../test.js"
import { installShellFiles } from "./install.js"
import { mcpScript } from "./mcp.js"
import { listenForReports, type Call, type Reports } from "./reports.js"

const token = "0123456789abcdef".repeat(3)
let folder: string
let script: string

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "novadeck-mcp-test-"))
  script = join(folder, "mcp.mjs")
  await writeFile(script, mcpScript)
})

afterAll(async () => {
  await rm(folder, { recursive: true, force: true })
})

// One message the server sent back.
type Answer = {
  readonly id?: number
  readonly result?: {
    readonly tools?: readonly { readonly name: string }[]
    readonly [key: string]: unknown
  }
  readonly error?: { readonly code: number }
}

// How the server starts: its script on this Node, or as a plugin names it.
type Start = { readonly command: string; readonly args?: readonly string[] }

// Runs the server as an agent would, without a shell, sends it these messages, and
// collects its answers until it has answered every one with an id, and every batch. With
// `close`, it closes the server's input at once and collects what it answers before it
// exits.
const session = (
  env: NodeJS.ProcessEnv,
  messages: readonly object[],
  { start, close = false }: { readonly start?: Start; readonly close?: boolean } = {},
) =>
  new Promise<Answer[]>((resolve, reject) => {
    const { command, args = [] } = start ?? { command: process.execPath, args: [script] }
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "inherit"] })
    const expected = messages.filter((message) => Array.isArray(message) || "id" in message).length
    const answers: Answer[] = []
    let buffer = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf("\n")) >= 0) {
        answers.push(JSON.parse(buffer.slice(0, end)) as Answer)
        buffer = buffer.slice(end + 1)
      }
      if (!close && answers.length >= expected) {
        child.stdin.end()
        resolve(answers)
      }
    })
    child.on("error", reject)
    child.on("close", () => resolve(answers))
    for (const message of messages)
      child.stdin.write(
        `${JSON.stringify(Array.isArray(message) ? message : { jsonrpc: "2.0", ...message })}\n`,
      )
    if (close) child.stdin.end()
  })

// This environment without the variables of a NovaDeck terminal the tests run in.
const outside = (): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  delete env.NOVADECK_TERMINAL_ID
  delete env.NOVADECK_REPORT
  delete env.NOVADECK_REPORT_TOKEN
  return env
}

const initialize = { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }
const initialized = { method: "notifications/initialized" }
const list = { id: 2, method: "tools/list" }

describe("NovaDeck's MCP server", () => {
  describe("outside a NovaDeck terminal", () => {
    it("answers the handshake and offers no tools", async () => {
      const answers = await session({ PATH: process.env.PATH }, [initialize, initialized, list])
      expect(answers[0]).toMatchObject({
        id: 1,
        result: { protocolVersion: "2025-06-18", serverInfo: { name: "novadeck" } },
      })
      expect(answers[1]).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [] } })
    })
  })

  describe("in a NovaDeck terminal", () => {
    let reports: Reports
    const calls: Call[] = []
    let answer: unknown = { ok: true, id: "abc", kind: "image", name: "hero.png" }
    // How long the runner takes to answer.
    let delay = 0

    beforeAll(async () => {
      reports = await listenForReports(
        () => {},
        async (call) => {
          calls.push(call)
          await new Promise((resolve) => setTimeout(resolve, delay))
          return answer
        },
      )
    })

    afterAll(async () => {
      await reports.close()
    })

    const terminal = () => ({
      PATH: process.env.PATH,
      NOVADECK_TERMINAL_ID: "3f1c2b1e-0000-4000-8000-000000000001",
      NOVADECK_REPORT: reports.endpoint,
      NOVADECK_REPORT_TOKEN: token,
    })

    it("offers the show tool", async () => {
      const [, tools] = await session(terminal(), [initialize, list])
      expect(tools?.result?.tools?.map((tool) => tool.name)).toEqual(["show"])
    })

    it("forwards a call to the terminal's runner with its token, and says what happened", async () => {
      calls.length = 0
      answer = { ok: true, id: "abc", kind: "image", name: "hero.png" }
      const [, shown] = await session(terminal(), [
        initialize,
        {
          id: 3,
          method: "tools/call",
          params: { name: "show", arguments: { path: "hero.png", open: true, extra: "dropped" } },
        },
      ])
      expect(calls).toEqual([
        {
          type: "present",
          terminalId: "3f1c2b1e-0000-4000-8000-000000000001",
          token,
          request: { path: "hero.png", open: true },
        },
      ])
      expect(shown?.result).toEqual({
        content: [{ type: "text", text: "Showing hero.png to the user in NovaDeck." }],
        isError: false,
      })
    })

    it("passes on why something can't be shown", async () => {
      answer = { ok: false, reason: "That file is outside this project." }
      const [, refused] = await session(terminal(), [
        initialize,
        {
          id: 4,
          method: "tools/call",
          params: { name: "show", arguments: { path: "/etc/passwd" } },
        },
      ])
      expect(refused?.result).toEqual({
        content: [{ type: "text", text: "That file is outside this project." }],
        isError: true,
      })
    })

    it("offers nothing and calls nothing when one of the terminal's variables is missing", async () => {
      calls.length = 0
      const { NOVADECK_REPORT_TOKEN: _, ...partial } = terminal()
      const [, tools, call] = await session(partial, [
        initialize,
        list,
        { id: 3, method: "tools/call", params: { name: "show", arguments: { path: "a" } } },
      ])
      expect(tools?.result?.tools).toEqual([])
      expect(call?.error).toMatchObject({ code: -32602 })
      expect(calls).toEqual([])
    })

    it("still answers a call under way when the agent closes its side", async () => {
      answer = { ok: true, id: "abc", kind: "image", name: "hero.png" }
      delay = 300
      try {
        const answers = await session(
          terminal(),
          [
            initialize,
            {
              id: 3,
              method: "tools/call",
              params: { name: "show", arguments: { path: "hero.png" } },
            },
          ],
          { close: true },
        )
        expect(answers.find((each) => each.id === 3)?.result).toMatchObject({ isError: false })
      } finally {
        delay = 0
      }
    })

    describe("through its launcher, as the agents' plugins start it", () => {
      // The server as Claude Code's plugin names it; the others name it alike.
      const installed = async (runtime?: string): Promise<Start> => {
        const paths = await installShellFiles(join(folder, runtime ? "gone" : "launcher"), runtime)
        const config = JSON.parse(
          await readFile(join(paths.plugins.claude, "novadeck", ".mcp.json"), "utf8"),
        ) as { mcpServers: { novadeck: Start } }
        return config.mcpServers.novadeck
      }
      const inTerminal = () => ({ ...outside(), ...terminal(), PATH: process.env.PATH })

      it("answers the handshake with no tools outside a NovaDeck terminal, promptly", async () => {
        const start = await installed()
        const began = Date.now()
        const [hello, tools] = await session(outside(), [initialize, initialized, list], {
          start,
        })
        // Well within the 10 s Codex gives an MCP server to start.
        expect(Date.now() - began).toBeLessThan(5_000)
        expect(hello?.result).toMatchObject({
          protocolVersion: "2025-06-18",
          serverInfo: { name: "novadeck", version: plugin.version },
        })
        expect(tools?.result?.tools).toEqual([])
      }, 30_000)

      it("runs the server in a NovaDeck terminal", async () => {
        calls.length = 0
        answer = { ok: true, id: "abc", kind: "image", name: "hero.png" }
        const start = await installed()
        const [, tools, shown] = await session(
          inTerminal(),
          [
            initialize,
            list,
            {
              id: 3,
              method: "tools/call",
              params: { name: "show", arguments: { path: "hero.png" } },
            },
          ],
          { start },
        )
        expect(tools?.result?.tools?.map((tool) => tool.name)).toEqual(["show"])
        expect(shown?.result).toMatchObject({ isError: false })
        expect(calls).toHaveLength(1)
      }, 30_000)

      it("answers itself, with no tools, once NovaDeck's runtime is gone", async () => {
        const start = await installed(join(folder, "no-such-runtime"))
        const [hello, tools] = await session(
          inTerminal(),
          [initialize, list, { id: 3, method: "ping" }],
          {
            start,
          },
        )
        expect(hello?.result).toMatchObject({ protocolVersion: "2025-06-18" })
        expect(tools?.result?.tools).toEqual([])
      }, 30_000)
    })

    it("says so when NovaDeck can't be reached", async () => {
      const [, unreachable] = await session(
        { ...terminal(), NOVADECK_REPORT: join(folder, "gone.sock") },
        [
          initialize,
          { id: 5, method: "tools/call", params: { name: "show", arguments: { path: "a" } } },
        ],
      )
      expect(unreachable?.result).toMatchObject({ isError: true })
    })
  })

  it("names its version, and answers a version it doesn't know with the newest it does", async () => {
    const [known] = await session({ PATH: process.env.PATH }, [
      { id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    ])
    expect(known?.result).toMatchObject({
      protocolVersion: "2024-11-05",
      serverInfo: { version: plugin.version },
    })
    const [unknown] = await session({ PATH: process.env.PATH }, [
      { id: 1, method: "initialize", params: { protocolVersion: "2099-01-01" } },
    ])
    expect(unknown?.result).toMatchObject({ protocolVersion: "2025-11-25" })
  })

  it("refuses a batch", async () => {
    const [refused] = await session({ PATH: process.env.PATH }, [[initialize, list]])
    expect(refused).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    })
  })

  it("answers methods it doesn't know with an error", async () => {
    const [, unknown] = await session({ PATH: process.env.PATH }, [
      initialize,
      { id: 6, method: "resources/list" },
    ])
    expect(unknown?.error).toMatchObject({ code: -32601 })
  })
})
