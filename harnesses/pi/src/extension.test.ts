import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { extensionSource, type ExtensionConfig } from "./extension-source.js"
import { events } from "./plugin.js"

/**
 * Novadeck's pi extension, rendered and run as pi runs it, against a stand-in for pi's extension
 * API: pi's own packages are stubs the module imports by name, a hook command stands in for
 * Novadeck's relay (it writes each report down and answers as told), and a stdio MCP server for
 * Novadeck's tools. pi itself, with the same extension, was probed on 1.6.0 (2026-11-24).
 */

type Handler = (event: Record<string, unknown>, ctx: Context) => unknown
type Context = Record<string, unknown>
type Tool = {
  name: string
  exposure?: string
  description: string
  parameters: unknown
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>
}

let root: string
let renders = 0

const hookScript = `import { appendFileSync, readFileSync } from "node:fs"
let input = ""
for await (const chunk of process.stdin) input += chunk
const payload = JSON.parse(input)
const [log, answersFile] = process.argv.slice(2)
appendFileSync(log, JSON.stringify(payload) + "\\n")
let answers = {}
try {
  answers = JSON.parse(readFileSync(answersFile, "utf8"))
} catch {}
const answer = answers[payload.hook_event_name]
// A line of the person's shell before the answer, which the extension reads past.
console.log("profile noise")
console.log(answer === undefined ? "{}" : JSON.stringify(answer))
`

const mcpScript = `import { createInterface } from "node:readline"
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line)
  if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "novadeck" } } })
  else if (m.method === "tools/list") out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "send", description: "Send a message", inputSchema: { type: "object", properties: { to: { type: "string" } } } }] } })
  else if (m.method === "tools/call") out({ jsonrpc: "2.0", id: m.id, result: m.params.arguments.to === "@nobody" ? { content: [{ type: "text", text: "No such terminal" }], isError: true } : { content: [{ type: "text", text: "sent to " + m.params.arguments.to }] } })
  else if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, result: {} })
})
`

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-extension-"))
  // pi's packages as the extension imports them: only the names it reads.
  const stub = async (name: string, source: string) => {
    const folder = join(root, "node_modules", "@earendil-works", name)
    await mkdir(folder, { recursive: true })
    await writeFile(
      join(folder, "package.json"),
      JSON.stringify({ name, type: "module", main: "index.js" }),
    )
    await writeFile(join(folder, "index.js"), source)
  }
  // A live binding, so a test can make pi another release after the module is loaded.
  await stub(
    "pi-coding-agent",
    "export let VERSION = '1.6.0'\nglobalThis.setPiVersion = (version) => { VERSION = version }\n",
  )
  await stub(
    "pi-ai",
    "export const getSupportedThinkingLevels = (model) => (model.reasoning ? ['off', 'minimal', 'low', 'medium', 'high'] : ['off'])\n",
  )
  await writeFile(join(root, "hook.mjs"), hookScript)
  await writeFile(join(root, "mcp.mjs"), mcpScript)
})

afterAll(() => rm(root, { recursive: true, force: true }))

const saved = { ...process.env }
const setVersion = (version: string) =>
  (globalThis as unknown as { setPiVersion: (version: string) => void }).setPiVersion(version)
beforeEach(() => {
  process.env.NOVADECK_HOOK = "1"
})
afterEach(() => {
  process.env = { ...saved }
  setVersion("1.6.0")
})

/** The extension, rendered and loaded once more, given a stand-in for pi's API. */
const load = async (overrides: Partial<ExtensionConfig> = {}) => {
  renders += 1
  const file = join(root, `novadeck-${renders}.mjs`)
  // Its own record and answers, as a report may run on after its test.
  const log = join(root, `hooks-${renders}.log`)
  const answers = join(root, `answers-${renders}.json`)
  const hook = [join(root, "hook.mjs"), log, answers].map((word) => JSON.stringify(word)).join(" ")
  const answer = (given: Record<string, unknown>) => writeFile(answers, JSON.stringify(given))
  await writeFile(
    file,
    extensionSource({
      hooks: Object.fromEntries(events.map((event) => [event, `node ${hook}`])),
      hookMs: 10_000,
      mcp: [process.execPath, join(root, "mcp.mjs")],
      worktrees: join(root, "worktrees"),
      minimum: "1.1.0",
      unknownFrom: "2.0.0",
      prefix: "novadeck_",
      stoppedType: "novadeck-stopped",
      ...overrides,
    }),
  )
  const handlers = new Map<string, Handler[]>()
  const tools: Tool[] = []
  const sent: { message: Record<string, unknown>; options: Record<string, unknown> }[] = []
  const entries: { type: string; data: unknown }[] = []
  const api = {
    on: (name: string, handler: Handler) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool: Tool) => tools.push(tool),
    sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) =>
      sent.push({ message, options }),
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
  }
  const module = (await import(pathToFileURL(file).href)) as { default: (pi: typeof api) => void }
  module.default(api)
  const emit = async (
    name: string,
    event: Record<string, unknown> = {},
    ctx: Context = context(),
  ) => {
    let result: unknown
    // In order, one after another, as pi runs an event's handlers.
    // eslint-disable-next-line no-await-in-loop -- Each handler sees the one before it end.
    for (const handler of handlers.get(name) ?? []) result = (await handler(event, ctx)) ?? result
    return result
  }
  const reports = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  return { file, handlers, tools, sent, entries, emit, reports, answer }
}

const context = (overrides: Context = {}): Context => ({
  cwd: "/home/person/project",
  sessionManager: {
    getSessionId: () => "s1",
    getSessionFile: () => "/home/person/.pi/agent/sessions/--p--/2026_s1.jsonl",
  },
  model: { provider: "openai", id: "gpt-6" },
  thinkingLevel: "high",
  modelRegistry: {
    getAvailable: () => [{ provider: "openai", id: "gpt-6", name: "GPT 6", reasoning: true }],
  },
  getContextUsage: () => ({ tokens: 1200, contextWindow: 200_000, percent: 0.6 }),
  ...overrides,
})

describe("Novadeck's pi extension", () => {
  it("does nothing outside Novadeck's terminals", async () => {
    delete process.env.NOVADECK_HOOK
    const { handlers } = await load()
    expect(handlers.size).toBe(0)
  })

  it("does nothing on a pi older than it knows, or on pi 2", async () => {
    setVersion("1.0.4")
    expect((await load()).handlers.size).toBe(0)
    setVersion("2.0.0")
    expect((await load()).handlers.size).toBe(0)
  })

  it("binds a session as it starts, and gives pi Novadeck's tools as its own", async () => {
    const pi = await load()
    await pi.emit("session_start", { reason: "startup" })
    expect(await pi.reports()).toEqual([
      expect.objectContaining({
        hook_event_name: "SessionStart",
        session_id: "s1",
        source: "startup",
        cwd: "/home/person/project",
        version: "1.6.0",
        model: "openai/gpt-6",
        effort: "high",
      }),
    ])
    expect(pi.tools.map(({ name, exposure }) => ({ name, exposure }))).toEqual([
      { name: "novadeck_send", exposure: "model-only" },
    ])
    expect(await pi.tools[0]!.execute("c1", { to: "@fox" })).toEqual({
      content: [{ type: "text", text: "sent to @fox" }],
      details: {},
    })
    await expect(pi.tools[0]!.execute("c2", { to: "@nobody" })).rejects.toThrow("No such terminal")
    // The models it can start with, beside the extension, for Novadeck's picker.
    expect(JSON.parse(await readFile(join(root, "models.json"), "utf8"))).toEqual([
      {
        provider: "openai",
        id: "gpt-6",
        name: "GPT 6",
        levels: ["off", "minimal", "low", "medium", "high"],
      },
    ])
    await pi.emit("session_shutdown", { reason: "quit" })
  })

  it("gives a prompt's delivery to the model right after the prompt", async () => {
    const pi = await load()
    await pi.answer({ UserPromptSubmit: { deliver: "<novadeck-messages>hi</novadeck-messages>" } })
    await pi.emit("input", { text: "fix the build", source: "interactive" })
    expect(
      await pi.emit("before_agent_start", { messageType: "user", prompt: "fix the build" }),
    ).toEqual({
      message: {
        customType: "novadeck",
        content: "<novadeck-messages>hi</novadeck-messages>",
        display: true,
      },
    })
    // Once: the next run brings nothing of it.
    expect(await pi.emit("before_agent_start", { messageType: "user" })).toBeUndefined()
    expect((await pi.reports())[0]).toMatchObject({
      hook_event_name: "UserPromptSubmit",
      prompt: "fix the build",
      queued: null,
    })
  })

  it("tells a prompt the person queued while a run goes on, and an extension's own as nothing", async () => {
    const pi = await load()
    await pi.emit("input", { text: "also this", source: "interactive", streamingBehavior: "steer" })
    await pi.emit("input", { text: "from another extension", source: "extension" })
    expect((await pi.reports()).map((report) => [report.prompt, report.queued])).toEqual([
      ["also this", "steer"],
    ])
  })

  it("refuses a shell call the gate refuses, a codemode script's own ones too, and never a script", async () => {
    const pi = await load({ gate: true })
    await pi.answer({ PreToolUse: { decision: "deny", reason: "No permit to push" } })
    expect(
      await pi.emit("tool_call", {
        toolName: "bash",
        toolCallId: "c1",
        input: { command: "git push" },
      }),
    ).toEqual({
      block: true,
      reason: "No permit to push",
    })
    expect(
      await pi.emit("tool_call", {
        toolName: "bash",
        toolCallId: "c2/1",
        parentToolCallId: "c2",
        input: { command: "git push" },
      }),
    ).toEqual({ block: true, reason: "No permit to push" })
    expect(
      await pi.emit("tool_call", {
        toolName: "codemode",
        toolCallId: "c2",
        input: { code: "tools.bash({ command: 'git push' })" },
      }),
    ).toBeUndefined()
    expect(
      await pi.emit("tool_call", { toolName: "read", toolCallId: "c3", input: { path: "a" } }),
    ).toBeUndefined()
  })

  it("lets every call run with the gate off, whatever the answer", async () => {
    const pi = await load()
    await pi.answer({ PreToolUse: { decision: "deny", reason: "No permit" } })
    expect(
      await pi.emit("tool_call", {
        toolName: "bash",
        toolCallId: "c1",
        input: { command: "git push" },
      }),
    ).toBeUndefined()
  })

  it("steers a delivery in at a root call's result, and asks none at a script's own call", async () => {
    const pi = await load()
    await pi.answer({
      PostToolUse: { deliver: "lead says hi" },
      NestedToolUse: { deliver: "never" },
    })
    await pi.emit("tool_result", {
      toolName: "bash",
      toolCallId: "c1",
      input: { command: "ls" },
      isError: false,
    })
    await pi.emit("tool_result", {
      toolName: "bash",
      toolCallId: "c2/1",
      parentToolCallId: "c2",
      input: { command: "ls" },
    })
    expect(pi.sent).toEqual([
      {
        message: { customType: "novadeck", content: "lead says hi", display: true },
        options: { deliverAs: "steer" },
      },
    ])
    expect((await pi.reports()).map((report) => report.hook_event_name)).toEqual([
      "PostToolUse",
      "NestedToolUse",
    ])
  })

  it("goes on in the same run with a Stop's delivery, and tells the run's end once", async () => {
    const pi = await load()
    await pi.answer({ Stop: { deliver: "a message came" } })
    await pi.emit("agent_start")
    await pi.emit("message_end", {
      message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
    })
    expect(await pi.emit("agent_before_settle", { entries: [] })).toEqual({
      entries: [
        {
          type: "custom_message",
          customType: "novadeck",
          content: "a message came",
          display: true,
        },
      ],
      continue: true,
    })
    await pi.answer({})
    await pi.emit("agent_start")
    expect(await pi.emit("agent_before_settle", { entries: [] })).toBeUndefined()
    await pi.emit("agent_settled", { aborted: false })
    const stops = (await pi.reports()).filter((report) => report.hook_event_name === "Stop")
    expect(stops).toEqual([
      expect.objectContaining({
        last_assistant_message: "done",
        error: null,
        continued: 0,
        usage: { tokens: 1200, window: 200_000, model: "openai/gpt-6", effort: "high" },
      }),
      expect.objectContaining({ continued: 1 }),
    ])
  })

  it("marks each run's end in the session's file, however its Stop's report fared", async () => {
    const pi = await load()
    await pi.emit("agent_start")
    await pi.emit("message_end", {
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "500" },
    })
    await pi.emit("agent_before_settle", { entries: [] })
    await pi.emit("agent_settled", { aborted: false })
    await pi.emit("agent_start")
    await pi.emit("agent_settled", { aborted: true })
    expect(pi.entries).toEqual([
      { type: "novadeck-stopped", data: { at: expect.any(Number), error: "error" } },
      { type: "novadeck-stopped", data: { at: expect.any(Number), error: "aborted" } },
    ])
  })

  it("tells an aborted run's end as it settles, with nothing to deliver", async () => {
    const pi = await load()
    await pi.emit("agent_start")
    await pi.emit("agent_settled", { aborted: true })
    expect((await pi.reports()).at(-1)).toMatchObject({
      hook_event_name: "Stop",
      error: { name: "aborted", message: null },
    })
  })

  it("tells an extension's dialog as it shows and as it goes", async () => {
    const pi = await load()
    await pi.emit("ui_prompt_start", { kind: "confirm", title: "Allow it?" })
    await pi.emit("ui_prompt_end", { kind: "confirm", title: "Allow it?" })
    await pi.emit("ui_prompt_start", { kind: "custom" })
    expect(
      (await pi.reports()).map(({ hook_event_name, request_id, kind, title }) => ({
        hook_event_name,
        request_id,
        kind,
        title,
      })),
    ).toEqual([
      { hook_event_name: "DialogShown", request_id: "ui-1", kind: "confirm", title: "Allow it?" },
      { hook_event_name: "DialogEnded", request_id: "ui-1", kind: "confirm", title: "Allow it?" },
    ])
  })

  it("trusts a worktree of Novadeck's for this process where pi trusts its project already", async () => {
    const agentDir = join(root, "agent")
    const main = join(root, "project")
    const trusted = join(root, "worktrees", "wt1")
    const other = join(root, "worktrees", "wt2")
    await mkdir(agentDir, { recursive: true })
    // Two worktrees: one of the trusted project, one of another.
    const worktree = async (folder: string, owner: string, name: string) => {
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, ".git"), `gitdir: ${join(owner, ".git", "worktrees", name)}\n`)
    }
    await Promise.all([
      worktree(trusted, main, "wt1"),
      worktree(other, join(root, "elsewhere"), "wt2"),
    ])
    await writeFile(join(agentDir, "trust.json"), JSON.stringify({ [main]: true }))
    process.env.PI_CODING_AGENT_DIR = agentDir
    const pi = await load()
    expect(await pi.emit("project_trust", { cwd: trusted })).toEqual({ trusted: "yes" })
    expect(await pi.emit("project_trust", { cwd: other })).toEqual({ trusted: "undecided" })
    expect(await pi.emit("project_trust", { cwd: main })).toEqual({ trusted: "undecided" })
    // Read alone: pi's own decisions stay as they were.
    expect(JSON.parse(await readFile(join(agentDir, "trust.json"), "utf8"))).toEqual({
      [main]: true,
    })
  })
})
