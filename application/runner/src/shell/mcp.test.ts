import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll } from "vitest"

import { plugin } from "../harnesses/harness.js"
import { unboundNote } from "../messaging/peers.js"
import { describe, expect, it } from "../test.js"
import { installShellFiles } from "./install.js"
import { mcpScript } from "./mcp.js"
import { listenForReports, unheard, type Call, type Reports } from "./reports.js"
import { shellFiles, shellPaths } from "./scripts.js"

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
    let answer: unknown = { ok: true, id: "abc", kind: "image", name: "hero.png", opened: true }
    // How long the runner takes to answer.
    let delay = 0

    beforeAll(async () => {
      reports = await listenForReports({
        report: () => {},
        ask: () => Promise.resolve(unheard),
        ack: () => {},
        call: async (call) => {
          calls.push(call)
          await new Promise((resolve) => setTimeout(resolve, delay))
          return answer
        },
      })
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

    it("offers its tools: show, open_terminal, send, agents and describe", async () => {
      const [, tools] = await session(terminal(), [initialize, list])
      expect(tools?.result?.tools?.map((tool) => tool.name)).toEqual([
        "show",
        "open_terminal",
        "send",
        "agents",
        "describe",
      ])
      // Each as MCP lists a tool, without what the server keeps for itself.
      for (const tool of tools?.result?.tools ?? [])
        expect(Object.keys(tool).toSorted()).toEqual(["description", "inputSchema", "name"])
    })

    it("forwards a request for a new terminal, and says where it opened", async () => {
      calls.length = 0
      answer = {
        ok: true,
        terminalId: "t",
        handle: "t2",
        cwd: "/work/app",
        command: "claude",
      }
      const [, opened] = await session(terminal(), [
        initialize,
        {
          id: 3,
          method: "tools/call",
          params: {
            name: "open_terminal",
            arguments: { command: "claude", cwd: "app", focus: true, extra: "dropped" },
          },
        },
      ])
      expect(calls).toEqual([
        {
          type: "open",
          terminalId: "3f1c2b1e-0000-4000-8000-000000000001",
          token,
          request: { command: "claude", cwd: "app", focus: true },
        },
      ])
      expect(opened?.result).toEqual({
        content: [
          { type: "text", text: "Opened a new terminal, t2, running claude in /work/app." },
        ],
        isError: false,
      })
      answer = { ok: true, terminalId: "t", cwd: "/work" }
      const [, plain] = await session(terminal(), [
        initialize,
        { id: 4, method: "tools/call", params: { name: "open_terminal", arguments: {} } },
      ])
      expect(plain?.result).toEqual({
        content: [{ type: "text", text: "Opened a new terminal in /work." }],
        isError: false,
      })
      answer = { ok: false, reason: "NovaDeck isn't open to show a new terminal." }
      const [, refused] = await session(terminal(), [
        initialize,
        { id: 5, method: "tools/call", params: { name: "open_terminal", arguments: {} } },
      ])
      expect(refused?.result).toEqual({
        content: [{ type: "text", text: "NovaDeck isn't open to show a new terminal." }],
        isError: true,
      })
    })

    it("forwards an agent and its task, and says where the task is", async () => {
      calls.length = 0
      answer = {
        ok: true,
        terminalId: "t",
        handle: "t3",
        cwd: "/work",
        command: 'codex "[NovaDeck: automatic notice, agent messages waiting, k3f9q2]"',
        task: {
          ok: true,
          to: "t3",
          id: "m-1",
          state: "queued",
          route: "when its agent first prompts",
        },
      }
      const [, opened] = await session(terminal(), [
        initialize,
        {
          id: 3,
          method: "tools/call",
          params: { name: "open_terminal", arguments: { agent: "codex", message: "Review a.ts" } },
        },
      ])
      expect(calls).toMatchObject([
        { type: "open", request: { agent: "codex", message: "Review a.ts" } },
      ])
      expect((opened!.result as { content: { text: string }[] }).content[0]?.text).toMatch(
        /, t3, running codex .* Its task, message m-1, waits for the agent's first session there/,
      )
      answer = { ...(answer as object), task: { ok: false, reason: "Too many messages." } }
      const [, unsent] = await session(terminal(), [
        initialize,
        {
          id: 4,
          method: "tools/call",
          params: { name: "open_terminal", arguments: { agent: "codex", message: "Review a.ts" } },
        },
      ])
      expect((unsent!.result as { content: { text: string }[] }).content[0]?.text).toMatch(
        /Its task wasn't sent: Too many messages\.$/,
      )
      answer = { ...(answer as object), task: { ok: true, id: "m-1" }, taskWaits: true }
      const [, waits] = await session(terminal(), [
        initialize,
        {
          id: 5,
          method: "tools/call",
          params: { name: "open_terminal", arguments: { agent: "agy", message: "Review a.ts" } },
        },
      ])
      expect((waits!.result as { content: { text: string }[] }).content[0]?.text).toMatch(
        /doesn't trust this folder yet, so it started without its task: message m-1 reaches it once the user trusts the folder and its prompt shows\./,
      )
    })

    it("describes only its own terminal, and says when the title stayed", async () => {
      calls.length = 0
      const described = async (runner: unknown) => {
        answer = runner
        const [, said] = await session(terminal(), [
          initialize,
          {
            id: 3,
            method: "tools/call",
            params: {
              name: "describe",
              // A target is no argument it takes.
              arguments: { title: "API", summary: "Builds the users API.", to: "t2" },
            },
          },
        ])
        return (said!.result as { content: { text: string }[] }).content[0]?.text
      }
      await expect(described({ ok: true, title: "API" })).resolves.toBe(
        'Described this terminal as "API", with your summary.',
      )
      expect(calls).toEqual([
        {
          type: "describe",
          terminalId: "3f1c2b1e-0000-4000-8000-000000000001",
          token,
          request: { title: "API", summary: "Builds the users API." },
        },
      ])
      await expect(described({ ok: true, title: "Mine", kept: "person" })).resolves.toBe(
        'The user named this terminal "Mine", so that title stays; your summary is saved.',
      )
      await expect(described({ ok: true, title: "Mine", kept: "unasked" })).resolves.toBe(
        "Not renamed: the user named this terminal. Suggest the title to them. Your summary is saved.",
      )
    })

    it("forwards a call to the terminal's runner with its token, and says what happened", async () => {
      calls.length = 0
      answer = { ok: true, id: "abc", kind: "image", name: "hero.png", opened: true }
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

    it("forwards a page by its url", async () => {
      calls.length = 0
      answer = { ok: true, id: "def", kind: "page", name: "localhost:5173", opened: true }
      const [, shown] = await session(terminal(), [
        initialize,
        {
          id: 3,
          method: "tools/call",
          params: { name: "show", arguments: { url: "http://localhost:5173/", open: true } },
        },
      ])
      expect(calls.map((call) => call.type === "present" && call.request)).toEqual([
        { url: "http://localhost:5173/", open: true },
      ])
      expect(shown?.result).toMatchObject({ isError: false })
    })

    it("says what the runner did, not what was asked: waiting, or held for secrets", async () => {
      const said = async (runner: unknown) => {
        answer = runner
        const [, shown] = await session(terminal(), [
          initialize,
          {
            id: 4,
            method: "tools/call",
            params: { name: "show", arguments: { path: ".env", open: true } },
          },
        ])
        return shown?.result
      }
      await expect(
        said({ ok: true, id: "a", kind: "file", name: "notes.md", opened: false }),
      ).resolves.toEqual({
        content: [
          { type: "text", text: "notes.md is waiting for the user in NovaDeck, marked new." },
        ],
        isError: false,
      })
      await expect(
        said({ ok: true, id: "b", kind: "file", name: ".env", opened: false, held: true }),
      ).resolves.toMatchObject({
        content: [{ type: "text", text: expect.stringContaining(".env may hold secrets") }],
        isError: false,
      })
    })

    it("passes on why something can't be shown", async () => {
      answer = { ok: false, reason: "That file doesn't exist." }
      const [, refused] = await session(terminal(), [
        initialize,
        {
          id: 4,
          method: "tools/call",
          params: { name: "show", arguments: { path: "gone.txt" } },
        },
      ])
      expect(refused?.result).toEqual({
        content: [{ type: "text", text: "That file doesn't exist." }],
        isError: true,
      })
    })

    it("offers nothing and calls nothing when one of the terminal's variables is missing", async () => {
      calls.length = 0
      const { NOVADECK_REPORT_TOKEN: _, ...partial } = terminal()
      const [, tools, call, open, sent, listed] = await session(partial, [
        initialize,
        list,
        { id: 3, method: "tools/call", params: { name: "show", arguments: { path: "a" } } },
        { id: 4, method: "tools/call", params: { name: "open_terminal", arguments: {} } },
        {
          id: 5,
          method: "tools/call",
          params: { name: "send", arguments: { to: "codex", text: "hi" } },
        },
        { id: 6, method: "tools/call", params: { name: "agents", arguments: {} } },
      ])
      expect(tools?.result?.tools).toEqual([])
      for (const refused of [call, open, sent, listed])
        expect(refused?.error).toMatchObject({ code: -32602 })
      expect(calls).toEqual([])
    })

    it("sends a message through the terminal's runner, and says where it is", async () => {
      calls.length = 0
      const said = async (runner: unknown, args: object = { to: "t2", text: "Review a.ts" }) => {
        answer = runner
        const [, sent] = await session(terminal(), [
          initialize,
          { id: 3, method: "tools/call", params: { name: "send", arguments: args } },
        ])
        return sent?.result as { content: { text: string }[]; isError: boolean }
      }
      const queued = await said(
        {
          ok: true,
          to: "t2",
          id: "m-1",
          state: "queued",
          route: "when its current turn ends",
        },
        { to: "t2", text: "Review a.ts", from: "the person" },
      )
      expect(calls).toEqual([
        {
          type: "send",
          terminalId: "3f1c2b1e-0000-4000-8000-000000000001",
          token,
          request: { to: "t2", text: "Review a.ts" },
        },
      ])
      expect(queued.isError).toBe(false)
      expect(queued.content[0]?.text).toContain(
        "Message m-1 to t2 is queued: it reaches them when its current turn ends.",
      )
      expect(queued.content[0]?.text).toContain("End your turn rather than wait")
      const held = await said({
        ok: true,
        to: "t2",
        id: "m-2",
        state: "held",
        held: "release",
        gone: [{ id: "m-0", to: "t3" }],
        unbound: true,
      })
      expect(held.content[0]?.text).toContain("waits for the user to release it")
      expect(held.content[0]?.text).toContain("m-0 to t3 won't arrive")
      expect(held.content[0]?.text).toContain("/hooks")
      const refused = await said({ ok: false, reason: '"codex" is no terminal\'s handle here.' })
      expect(refused).toEqual({
        content: [{ type: "text", text: '"codex" is no terminal\'s handle here.' }],
        isError: true,
      })
      // Refused, from a terminal whose own session never bound: told both.
      const unbound = await said({ ok: false, reason: "t2 has no agent.", unbound: true })
      expect(unbound).toEqual({
        content: [{ type: "text", text: `t2 has no agent.\n${unboundNote}` }],
        isError: true,
      })
    })

    it("refuses a message too long to send, without calling the runner", async () => {
      calls.length = 0
      const [, refused] = await session(terminal(), [
        initialize,
        {
          id: 3,
          method: "tools/call",
          params: { name: "send", arguments: { to: "codex", text: "é".repeat(40_000) } },
        },
      ])
      expect(refused?.result).toEqual({
        content: [
          {
            type: "text",
            text:
              "The message is 80000 bytes, over the 4096 a message may hold; put longer " +
              "content in a file the recipient can open, and send its path.",
          },
        ],
        isError: true,
      })
      expect(calls).toEqual([])
    })

    it("lists the project's other terminals as the runner renders them", async () => {
      calls.length = 0
      const text =
        "You are t1 in NovaDeck.\nThere are no other terminals in this project and session."
      answer = { ok: true, text }
      const [, listed] = await session(terminal(), [
        initialize,
        { id: 3, method: "tools/call", params: { name: "agents", arguments: { extra: 1 } } },
      ])
      expect(calls).toMatchObject([{ type: "agents", request: {} }])
      expect(listed?.result).toEqual({ content: [{ type: "text", text }], isError: false })
    })

    it("carries the messaging rules in each messaging tool's description", async () => {
      const [, tools] = await session(terminal(), [initialize, list])
      const described = tools?.result?.tools as { name: string; description: string }[]
      for (const name of ["send", "agents"]) {
        const { description } = described.find((tool) => tool.name === name)!
        expect(description).toContain("Replying to a message you received is fine")
        expect(description).toContain("only when the user asked you to")
        expect(description).toContain("never an approval")
        expect(description).toContain("call agents again")
        expect(description).toContain("ask the user rather than guess")
        expect(description).toContain("end your turn rather than wait or poll")
      }
      const send = described.find((tool) => tool.name === "send")!
      expect(send.description).toContain("exact handle")
      expect(send.description).not.toMatch(/agent's name/)
    })

    it("still answers a call under way when the agent closes its side", async () => {
      answer = { ok: true, id: "abc", kind: "image", name: "hero.png", opened: true }
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
        // Not PowerShell's 20 s and more on a CI runner: cscript starts in about one, and
        // under 10 even on a busy one, as Codex gives an MCP server 10 s.
        expect(Date.now() - began).toBeLessThan(15_000)
        expect(hello?.result).toMatchObject({
          protocolVersion: "2025-06-18",
          serverInfo: { name: "novadeck", version: plugin.version },
        })
        expect(tools?.result?.tools).toEqual([])
      }, 30_000)

      it("runs the server in a NovaDeck terminal", async () => {
        calls.length = 0
        answer = { ok: true, id: "abc", kind: "image", name: "hero.png", opened: true }
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
        expect(tools?.result?.tools?.map((tool) => tool.name)).toEqual([
          "show",
          "open_terminal",
          "send",
          "agents",
          "describe",
        ])
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

  it("answers outside NovaDeck's terminals through cscript on Windows, never PowerShell", () => {
    const paths = shellPaths("C:\\data", "win32")
    const launcher = shellFiles(paths, "C:\\app\\novadeck.exe", "", mcpScript, "win32").find(
      (file) => file.path === paths.mcp,
    )
    expect(launcher?.content).toContain("cscript.exe //nologo //E:jscript")
    expect(launcher?.content.toLowerCase()).not.toContain("powershell")
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
