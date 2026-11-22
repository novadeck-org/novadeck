import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { pluginSource } from "./plugin-source.js"
import { events, files } from "./plugin.js"
import { minimum, unknownFrom } from "./version.js"

// A stand-in for Novadeck's hook launcher, run by each hook command: it records the report
// and prints the answer a test queued for its event, once.
const launcher = `
const fs = require("node:fs"), path = require("node:path")
const [dir, event] = process.argv.slice(2)
let input = ""
process.stdin.on("data", (chunk) => (input += chunk))
process.stdin.on("end", () => {
  fs.appendFileSync(path.join(dir, "reports.jsonl"), JSON.stringify({ event, payload: JSON.parse(input) }) + "\\n")
  const queued = path.join(dir, "answers", event)
  if (fs.existsSync(queued)) {
    process.stdout.write(fs.readFileSync(queued, "utf8"))
    fs.rmSync(queued)
  }
})
`

type Report = { readonly event: string; readonly payload: Record<string, any> }
type Hooks = Record<string, (...args: any[]) => Promise<void>>

let dir: string
let prompted: { id: string; parts: unknown[]; [field: string]: unknown }[]
let sessions: Record<string, { parentID?: string }>
let versionOf: string
// Each call the plugin made to opencode's interface API (`client.tui`), the one way, beside the
// terminal itself, it could change what the person's box holds.
let interfaceCalls: string[]
// Each reply the plugin sent to a permission's request, and what opencode answers one with.
let permissionReplies: { path: { id: string; permissionID: string }; body: { response: string } }[]
let replyAnswer: () => Promise<unknown>

const client = () => ({
  postSessionIdPermissionsPermissionId: async (options: (typeof permissionReplies)[number]) => {
    permissionReplies.push(options)
    return await replyAnswer()
  },
  _client: { get: async () => ({ data: { healthy: true, version: versionOf } }) },
  session: {
    // As opencode answers: the session, or no data for one it doesn't have.
    get: async ({ path }: { path: { id: string } }) => ({
      data: sessions[path.id] ? { id: path.id, ...sessions[path.id] } : undefined,
    }),
    list: async () => ({ data: [] }),
    messages: async () => ({ data: [] }),
    promptAsync: async ({ path, body }: { path: { id: string }; body: { parts: unknown[] } }) => {
      prompted.push({ id: path.id, ...body })
      return { data: undefined }
    },
  },
  tui: new Proxy(
    {},
    {
      get: (_, name) => async () => {
        interfaceCalls.push(String(name))
        return { data: true }
      },
    },
  ),
  config: {
    providers: async () => ({
      data: { providers: [{ id: "fake", models: { m: { limit: { context: 1000 } } } }] },
    }),
  },
})

// The plugin rendered into the test's folder with hooks that run the stand-in, loaded and started.
const start = async (env: Record<string, string> = {}, gate = false): Promise<Hooks> => {
  const script = join(dir, "launcher.cjs")
  await writeFile(script, launcher)
  const hooks = Object.fromEntries(
    events.map((event) => [event, `"${process.execPath}" "${script}" "${dir}" ${event}`]),
  )
  const file = join(dir, `plugin-${Math.random().toString(36).slice(2)}.mjs`)
  await writeFile(
    file,
    pluginSource({
      hooks,
      hookMs: 10_000,
      mcp: ["relay", "mcp"],
      worktrees: "/w",
      minimum,
      unknownFrom,
      ...(gate && { gate: true }),
    }),
  )
  Object.assign(process.env, { NOVADECK_HOOK: script, ...env })
  const module = (await import(pathToFileURL(file).href)) as {
    NovadeckPlugin: (input: unknown) => Promise<Hooks>
  }
  return module.NovadeckPlugin({ client: client(), directory: "/project" })
}

const reports = (): Report[] => {
  const file = join(dir, "reports.jsonl")
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Report)
    : []
}
const answer = (event: string, deliver: string) =>
  writeFile(join(dir, "answers", event), JSON.stringify({ deliver }))
const answered = (event: string, what: unknown) =>
  writeFile(join(dir, "answers", event), `${JSON.stringify(what)}\n`)
const emit = (hooks: Hooks, type: string, properties: unknown) =>
  hooks.event!({ event: { type, properties } })
// The reports made so far, once the plugin's queue of them has run.
const settled = async (count: number): Promise<Report[]> => {
  for (let tries = 0; tries < 200 && reports().length < count; tries++)
    // eslint-disable-next-line no-await-in-loop -- It polls until the reports are in.
    await new Promise((resolve) => setTimeout(resolve, 25))
  return reports()
}

const saved = { ...process.env }
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "novadeck-opencode-plugin-"))
  await mkdir(join(dir, "answers"))
  prompted = []
  sessions = {}
  versionOf = "1.19.6"
  interfaceCalls = []
  permissionReplies = []
  replyAnswer = async () => ({ data: true })
})
afterEach(async () => {
  process.env = { ...saved }
  await rm(dir, { recursive: true, force: true })
})

describe("Novadeck's opencode plugin", () => {
  it("does nothing outside Novadeck's terminals", async () => {
    const script = join(dir, "x.mjs")
    await writeFile(
      script,
      pluginSource({ hooks: {}, hookMs: 1, mcp: [], worktrees: null, minimum, unknownFrom }),
    )
    delete process.env.NOVADECK_HOOK
    const module = (await import(pathToFileURL(script).href)) as {
      NovadeckPlugin: (input: unknown) => Promise<Hooks>
    }
    expect(await module.NovadeckPlugin({ client: client(), directory: "/p" })).toEqual({})
  })

  // The runner reads the version itself, and Preferences says what it lacks (limited.ts).
  it("does nothing in an opencode 2, which it doesn't know yet, not even a report", async () => {
    versionOf = "2.3.2"
    expect(await start()).toEqual({})
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(reports()).toEqual([])
  })

  it("does nothing in an opencode older than it works with, not even a report", async () => {
    versionOf = "1.2.10"
    expect(await start()).toEqual({})
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(reports()).toEqual([])
  })

  it("adds Novadeck's MCP server and its tools allowed, beside the person's own rules", async () => {
    const hooks = await start()
    const loaded: Record<string, any> = {
      mcp: { theirs: { type: "local", command: ["x"] } },
      permission: { bash: "ask", external_directory: "ask" },
    }
    await hooks.config!(loaded)
    expect(loaded.mcp).toEqual({
      theirs: { type: "local", command: ["x"] },
      novadeck: { type: "local", command: ["relay", "mcp"], enabled: true },
    })
    expect(loaded.permission).toEqual({
      bash: "ask",
      external_directory: { "*": "ask", "/w/*": "allow" },
      "novadeck_*": "allow",
    })
  })

  it("keeps a person's rule for every tool where they gave one as a word", async () => {
    const hooks = await start()
    const loaded: Record<string, any> = { permission: "ask" }
    await hooks.config!(loaded)
    expect(loaded.permission).toEqual({
      "*": "ask",
      "novadeck_*": "allow",
      external_directory: { "/w/*": "allow" },
    })
  })

  it("keeps a person's own rule for Novadeck's tools", async () => {
    const hooks = await start()
    const loaded: Record<string, any> = { permission: { "novadeck_*": "ask" } }
    await hooks.config!(loaded)
    expect(loaded.permission["novadeck_*"]).toBe("ask")
  })

  it("merges a launch's own configuration over the person's, as a provider it brings", async () => {
    const hooks = await start({
      NOVADECK_OPENCODE_CONFIG: JSON.stringify({
        provider: { openrouter: { options: { apiKey: "k" } } },
        model: "openrouter/x",
      }),
    })
    const loaded: Record<string, any> = {
      model: "theirs/y",
      provider: { openrouter: { options: { baseURL: "b" } }, theirs: {} },
    }
    await hooks.config!(loaded)
    expect(loaded.model).toBe("openrouter/x")
    // Its titles go to the same model, not the person's small one.
    expect(loaded.small_model).toBe("openrouter/x")
    expect(loaded.provider).toEqual({
      openrouter: { options: { baseURL: "b", apiKey: "k" } },
      theirs: {},
    })
  })

  it("binds the session a prompt makes and adds the prompt's delivery to it", async () => {
    const hooks = await start()
    await emit(hooks, "session.created", { info: { id: "ses_a" } })
    await answer("UserPromptSubmit", "<novadeck-messages>hi</novadeck-messages>")
    const output = {
      message: { id: "msg_1", sessionID: "ses_a" },
      parts: [{ id: "p1", type: "text", text: "go" }],
    }
    await hooks["chat.message"]!({ sessionID: "ses_a", agent: "build" }, output)
    expect(output.parts.at(-1)).toEqual(
      expect.objectContaining({
        type: "text",
        text: "<novadeck-messages>hi</novadeck-messages>",
        synthetic: true,
      }),
    )
    const [bound, prompt] = await settled(2)
    expect(bound).toEqual(
      expect.objectContaining({
        event: "SessionStart",
        payload: expect.objectContaining({
          session_id: "ses_a",
          source: "startup",
          cwd: "/project",
        }),
      }),
    )
    expect(prompt!.payload).toEqual(expect.objectContaining({ prompt: "go", continuation: false }))
    // The prompt is the transcript's, whole, with what the plugin added.
    const transcript = await readFile(join(dir, "sessions", "ses_a.jsonl"), "utf8")
    expect(JSON.parse(transcript.trim()).parts).toHaveLength(2)
  })

  it("adds a tool-time delivery to the result the model reads next", async () => {
    const hooks = await start()
    await answer("PostToolUse", "<novadeck-messages>lead</novadeck-messages>")
    const output = { output: "done", title: "t", metadata: {} }
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_a", callID: "c", args: {} },
      output,
    )
    expect(output.output).toBe("done\n\n<novadeck-messages>lead</novadeck-messages>")
  })

  it("starts the next turn with a Stop's delivery, once, and tells its prompt as its own", async () => {
    const hooks = await start()
    await emit(hooks, "session.created", { info: { id: "ses_a" } })
    await emit(hooks, "session.status", { sessionID: "ses_a", status: { type: "busy" } })
    await answer("Stop", "<novadeck-messages>later</novadeck-messages>")
    await emit(hooks, "session.idle", { sessionID: "ses_a" })
    expect(prompted).toEqual([
      {
        id: "ses_a",
        parts: [
          { type: "text", text: "<novadeck-messages>later</novadeck-messages>", synthetic: true },
        ],
      },
    ])
    const output = { message: { id: "msg_2", sessionID: "ses_a" }, parts: [prompted[0]!.parts[0]] }
    await hooks["chat.message"]!({ sessionID: "ses_a" }, output)
    // A second idle with no turn between, as an Escape gives, reports nothing.
    await emit(hooks, "session.idle", { sessionID: "ses_a" })
    const told = await settled(3)
    expect(told.map(({ event }) => event)).toEqual(["SessionStart", "Stop", "UserPromptSubmit"])
    expect(told[2]!.payload.continuation).toBe(true)
  })

  it("goes on in the agent, model and variant of the person's last prompt", async () => {
    const hooks = await start()
    const model = { providerID: "fake", modelID: "m" }
    await hooks["chat.message"]!(
      { sessionID: "ses_a", agent: "plan", model, variant: "high" },
      { message: { id: "msg_1", sessionID: "ses_a" }, parts: [{ type: "text", text: "Plan it" }] },
    )
    await emit(hooks, "session.status", { sessionID: "ses_a", status: { type: "busy" } })
    await answer("Stop", "<novadeck-messages>later</novadeck-messages>")
    await emit(hooks, "session.idle", { sessionID: "ses_a" })
    await settled(3)
    // Its plan agent, not opencode's default build agent, which may change files.
    expect(prompted).toMatchObject([{ id: "ses_a", agent: "plan", model, variant: "high" }])
  })

  it("takes a prompt of the person's that comes as its delivery starts the turn as theirs", async () => {
    const hooks = await start()
    await emit(hooks, "session.created", { info: { id: "ses_a" } })
    await emit(hooks, "session.status", { sessionID: "ses_a", status: { type: "busy" } })
    await answer("Stop", "<novadeck-messages>later</novadeck-messages>")
    await emit(hooks, "session.idle", { sessionID: "ses_a" })
    await hooks["chat.message"]!(
      { sessionID: "ses_a" },
      { message: { id: "msg_2", sessionID: "ses_a" }, parts: [{ type: "text", text: "Mine" }] },
    )
    await hooks["chat.message"]!(
      { sessionID: "ses_a" },
      { message: { id: "msg_3", sessionID: "ses_a" }, parts: [prompted[0]!.parts[0]] },
    )
    const told = (await settled(4)).filter(({ event }) => event === "UserPromptSubmit")
    expect(told.map(({ payload }) => [payload.prompt, payload.continuation])).toEqual([
      ["Mine", false],
      ["", true],
    ])
  })

  // The runner gives a Stop's messages over a draft of the person's, as for every harness: the
  // draft stays byte for byte only while the delivery types nothing, so a later move to the
  // interface's prompt (`tui.appendPrompt`, `submitPrompt`) would fail here, not quietly.
  it("starts the next turn without touching the person's box: no interface call, nothing on the terminal", async () => {
    const hooks = await start()
    await emit(hooks, "session.created", { info: { id: "ses_a" } })
    await emit(hooks, "session.status", { sessionID: "ses_a", status: { type: "busy" } })
    await answer("Stop", "<novadeck-messages>later</novadeck-messages>")
    const writes: unknown[] = []
    const write = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      writes.push(chunk)
      return write(chunk as string, ...(rest as []))
    }) as typeof process.stdout.write
    try {
      await emit(hooks, "session.idle", { sessionID: "ses_a" })
      await settled(3)
    } finally {
      process.stdout.write = write
    }
    expect(prompted).toHaveLength(1)
    expect(interfaceCalls).toEqual([])
    expect(writes).toEqual([])
  })

  it("delivers nothing more where the turn its delivery started ends with nothing new", async () => {
    const hooks = await start()
    await emit(hooks, "session.created", { info: { id: "ses_a" } })
    // A turn with a delivery, then the turn it started, with nothing new.
    await emit(hooks, "session.status", { sessionID: "ses_a", status: { type: "busy" } })
    await answer("Stop", "<novadeck-messages>once</novadeck-messages>")
    await emit(hooks, "session.idle", { sessionID: "ses_a" })
    await emit(hooks, "session.status", { sessionID: "ses_a", status: { type: "busy" } })
    await emit(hooks, "session.idle", { sessionID: "ses_a" })
    expect(prompted).toHaveLength(1)
  })

  it("ends a turn with its reply, its error and a refusal, and the model's window", async () => {
    const hooks = await start()
    await emit(hooks, "session.created", { info: { id: "ses_a" } })
    await emit(hooks, "session.status", { sessionID: "ses_a", status: { type: "busy" } })
    await emit(hooks, "message.updated", {
      info: { id: "m1", sessionID: "ses_a", role: "user", time: { created: 1 } },
    })
    // The person's own words come as a part too: they are no reply.
    await emit(hooks, "message.part.updated", {
      part: { id: "p0", messageID: "m1", sessionID: "ses_a", type: "text", text: "go" },
    })
    await emit(hooks, "message.updated", {
      info: {
        id: "m2",
        sessionID: "ses_a",
        role: "assistant",
        modelID: "m",
        providerID: "fake",
        tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 2 },
      },
    })
    await emit(hooks, "message.part.updated", {
      part: {
        id: "p1",
        messageID: "m2",
        sessionID: "ses_a",
        type: "text",
        text: "Done.",
        time: { start: 2, end: 3 },
      },
    })
    await emit(hooks, "permission.replied", {
      sessionID: "ses_a",
      requestID: "per_1",
      reply: "reject",
    })
    await emit(hooks, "session.idle", { sessionID: "ses_a" })
    const stop = (await settled(3)).find(({ event }) => event === "Stop")!
    expect(stop.payload).toEqual(
      expect.objectContaining({
        last_assistant_message: "Done.",
        rejected: true,
        error: null,
        usage: expect.objectContaining({ model: "m", provider: "fake", window: 1000 }),
      }),
    )
  })

  it("writes a tool call as it starts running, once, and its result once it ended", async () => {
    const hooks = await start()
    await emit(hooks, "session.created", { info: { id: "ses_a" } })
    await emit(hooks, "message.updated", {
      info: { id: "m1", sessionID: "ses_a", role: "assistant", time: { created: 1 } },
    })
    const tool = (state: Record<string, unknown>) => ({
      part: {
        id: "p1",
        messageID: "m1",
        sessionID: "ses_a",
        type: "tool",
        tool: "bash",
        callID: "c1",
        state,
      },
    })
    await emit(hooks, "message.part.updated", tool({ status: "pending", input: {} }))
    await emit(hooks, "message.part.updated", tool({ status: "running", input: { command: "ls" } }))
    await emit(hooks, "message.part.updated", tool({ status: "running", input: { command: "ls" } }))
    await emit(
      hooks,
      "message.part.updated",
      tool({ status: "completed", input: { command: "ls" }, output: "a" }),
    )
    const lines = (await readFile(join(dir, "sessions", "ses_a.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines.map(({ call, called }) => ({ call, called }))).toEqual([
      { call: true, called: undefined },
      { call: undefined, called: true },
    ])
  })

  it("writes a prompt given while a tool runs after that tool's result, whole, once", async () => {
    const hooks = await start()
    await emit(hooks, "session.created", { info: { id: "ses_a" } })
    await emit(hooks, "message.updated", {
      info: { id: "m1", sessionID: "ses_a", role: "assistant", time: { created: 1 } },
    })
    await emit(hooks, "session.status", { sessionID: "ses_a", status: { type: "busy" } })
    const tool = (state: Record<string, unknown>) => ({
      part: {
        id: "p1",
        messageID: "m1",
        sessionID: "ses_a",
        type: "tool",
        tool: "bash",
        callID: "c1",
        state,
      },
    })
    await emit(hooks, "message.part.updated", tool({ status: "running", input: { command: "ls" } }))
    // The prompt's message and text part are stored first, its hook comes after (probed
    // 2026-11-22, 1.19.6): neither writes it, its hook does, once the tool's result is in.
    await emit(hooks, "message.updated", {
      info: { id: "m2", sessionID: "ses_a", role: "user", time: { created: 2 } },
    })
    await emit(hooks, "message.part.updated", {
      part: { id: "p2", messageID: "m2", sessionID: "ses_a", type: "text", text: "then this" },
    })
    await hooks["chat.message"]!(
      { sessionID: "ses_a", agent: "build" },
      {
        message: { id: "m2", sessionID: "ses_a", time: { created: 2 } },
        parts: [{ id: "p2", type: "text", text: "then this" }],
      },
    )
    await emit(
      hooks,
      "message.part.updated",
      tool({ status: "completed", input: { command: "ls" }, output: "a" }),
    )
    const lines = (await readFile(join(dir, "sessions", "ses_a.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, any>)
      .filter((line) => line.type !== "message")
    expect(lines.map((line) => line.type)).toEqual(["part", "part", "prompt"])
    expect(lines[2]!.parts[0].text).toBe("then this")
  })

  it("tells a task's child session as a subagent of its root, by the type its call named", async () => {
    const hooks = await start()
    await emit(hooks, "session.created", { info: { id: "ses_a" } })
    await hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "ses_a", callID: "c" },
      { args: { subagent_type: "general" } },
    )
    sessions.ses_b = { parentID: "ses_a" }
    await emit(hooks, "session.created", { info: { id: "ses_b", parentID: "ses_a" } })
    await emit(hooks, "session.status", { sessionID: "ses_b", status: { type: "busy" } })
    await emit(hooks, "session.idle", { sessionID: "ses_b" })
    const told = await settled(4)
    expect(told.slice(2)).toEqual([
      {
        event: "SubagentStart",
        payload: expect.objectContaining({
          session_id: "ses_a",
          agent_id: "ses_b",
          agent_type: "general",
        }),
      },
      {
        event: "SubagentStop",
        payload: expect.objectContaining({ session_id: "ses_a", agent_id: "ses_b" }),
      },
    ])
  })

  it("binds the session the shim said opencode resumes, as it starts", async () => {
    sessions.ses_old = {}
    await start({ NOVADECK_OPENCODE_SESSION: "ses_old" })
    const [bound] = await settled(1)
    expect(bound).toEqual({
      event: "SessionStart",
      payload: expect.objectContaining({ session_id: "ses_old", source: "resume" }),
    })
  })

  it("binds a session again that the person left for its home and went back to", async () => {
    const hooks = await start()
    const prompt = async (id: string) =>
      hooks["chat.message"]!(
        { sessionID: "ses_a" },
        { message: { id, sessionID: "ses_a" }, parts: [{ type: "text", text: "hi" }] },
      )
    await prompt("msg_1")
    await prompt("msg_2")
    // The TUI plugin's mark of a /new, which the runner ended the binding at.
    await mkdir(join(dir, "left"), { recursive: true })
    await writeFile(join(dir, "left", "ses_a"), "")
    await prompt("msg_3")
    const starts = (await settled(5)).filter(({ event }) => event === "SessionStart")
    expect(starts.map(({ payload }) => payload.source)).toEqual(["startup", "switch"])
    expect(existsSync(join(dir, "left", "ses_a"))).toBe(false)
  })

  it("binds no session it was given that opencode doesn't have, which it exits at", async () => {
    const hooks = await start({ NOVADECK_OPENCODE_SESSION: "ses_gone" })
    // A prompt's report shows the reports so far are through: none was a SessionStart.
    await hooks["chat.message"]!(
      { sessionID: "ses_new" },
      { message: { id: "msg_1", sessionID: "ses_new" }, parts: [{ type: "text", text: "hi" }] },
    )
    const told = await settled(2)
    expect(told.filter(({ payload }) => payload.session_id === "ses_gone")).toEqual([])
  })
})

describe("the plugin with the shipping gate on", () => {
  const deny = { decision: "deny", reason: "Novadeck: ask the user for a permit." }
  const before = (hooks: Hooks, tool: string, command = "git push origin main") => {
    const output = { args: { command, description: "d" } }
    return {
      output,
      done: hooks["tool.execute.before"]!({ tool, sessionID: "ses_a", callID: "call_1" }, output),
    }
  }
  const asked = {
    id: "per_1",
    sessionID: "ses_a",
    permission: "bash",
    patterns: ["git push *"],
    metadata: { command: "git push origin main" },
    always: ["git push *"],
    tool: { messageID: "msg_1", callID: "call_1" },
  }

  it("refuses a shell command Novadeck denies, with its reason as the call's result", async () => {
    const hooks = await start({}, true)
    await answered("PreToolUse", deny)
    await expect(before(hooks, "bash").done).rejects.toThrow("Novadeck: ask the user for a permit.")
    const [report] = reports()
    expect(report).toMatchObject({
      event: "PreToolUse",
      payload: {
        tool_name: "bash",
        call_id: "call_1",
        session_id: "ses_a",
        tool_input: { command: "git push origin main" },
      },
    })
  })

  it("lets a shell command through that Novadeck says nothing of, or that its hook failed to answer", async () => {
    const hooks = await start({}, true)
    await expect(before(hooks, "bash").done).resolves.toBeUndefined()
    await answered("PreToolUse", {})
    await expect(before(hooks, "bash").done).resolves.toBeUndefined()
    await writeFile(join(dir, "answers", "PreToolUse"), "not json")
    await expect(before(hooks, "bash").done).resolves.toBeUndefined()
    // A deny with no reason says nothing the model could read.
    await answered("PreToolUse", { decision: "deny" })
    await expect(before(hooks, "bash").done).resolves.toBeUndefined()
  })

  it("never waits for, or refuses, any other tool, and refuses nothing while the gate is off", async () => {
    const gated = await start({}, true)
    await answered("PreToolUse", deny)
    await expect(before(gated, "read").done).resolves.toBeUndefined()
    const off = await start()
    await expect(before(off, "bash").done).resolves.toBeUndefined()
  })

  it("replies once to a shell command's permission only where Novadeck says so, for that request", async () => {
    const hooks = await start({}, true)
    await answered("PermissionRequest", { reply: "once" })
    await emit(hooks, "permission.asked", asked)
    expect(permissionReplies).toEqual([
      { path: { id: "ses_a", permissionID: "per_1" }, body: { response: "once" } },
    ])
    // The report is the one request, made once.
    expect((await settled(1)).filter(({ event }) => event === "PermissionRequest")).toHaveLength(1)
    // No answer, or any other, is no reply: the person's dialog stays.
    permissionReplies.length = 0
    await emit(hooks, "permission.asked", asked)
    await answered("PermissionRequest", { reply: "always" })
    await emit(hooks, "permission.asked", asked)
    await answered("PermissionRequest", { reply: "reject" })
    await emit(hooks, "permission.asked", asked)
    expect(permissionReplies).toEqual([])
  })

  it("reports a dialog again where no answer reached it, so its card and bell show", async () => {
    const hooks = await start({}, true)
    // Its turn waits on the dialog.
    await emit(hooks, "session.status", { sessionID: "ses_a", status: { type: "busy" } })
    // The runner answered, but past the relay's deadline: the plugin hears nothing. Or what it
    // hears is no reply to make.
    let made = 0
    for (const heard of [undefined, { reply: "always" }, { reply: "reject" }, {}]) {
      // eslint-disable-next-line no-await-in-loop -- One at a time: each has its own answer.
      if (heard) await answered("PermissionRequest", heard)
      // eslint-disable-next-line no-await-in-loop -- As above.
      await emit(hooks, "permission.asked", asked)
      made += 2
      // eslint-disable-next-line no-await-in-loop -- As above.
      await settled(made)
    }
    expect(permissionReplies).toEqual([])
    expect(reports().filter(({ event }) => event === "PermissionRequest")).toHaveLength(8)
  })

  it("reports nothing again for a dialog whose turn ended meanwhile, as an Escape ends it", async () => {
    const hooks = await start({}, true)
    // No busy turn: an Escape ended it while the first report was out, and opencode tells no
    // reply of the dialog it took down.
    await emit(hooks, "permission.asked", asked)
    await settled(1)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(reports().filter(({ event }) => event === "PermissionRequest")).toHaveLength(1)
  })

  it("never reports again a dialog the person answered, wherever they did", async () => {
    const hooks = await start({}, true)
    // Answered while the plugin's own reply was on its way: its reply finds nothing to answer.
    replyAnswer = async () => {
      await emit(hooks, "permission.replied", {
        sessionID: "ses_a",
        requestID: "per_1",
        reply: "once",
      })
      return { error: { name: "NotFoundError" } }
    }
    await answered("PermissionRequest", { reply: "once" })
    await emit(hooks, "permission.asked", asked)
    expect(permissionReplies).toHaveLength(1)
    const told = await settled(3)
    expect(told.filter(({ event }) => event === "PermissionRequest")).toHaveLength(1)
    expect(told.filter(({ event }) => event === "PermissionReplied")).toHaveLength(1)
    // Answered before the answer to the report came back: no reply, and no second report.
    replyAnswer = async () => ({ data: true })
    const slow = { ...asked, id: "per_2" }
    const pending = emit(hooks, "permission.asked", slow)
    await emit(hooks, "permission.replied", {
      sessionID: "ses_a",
      requestID: "per_2",
      reply: "reject",
    })
    await pending
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(
      reports().filter(
        ({ event, payload }) => event === "PermissionRequest" && payload.request_id === "per_2",
      ),
    ).toHaveLength(1)
  })

  it("reads the answer from the last JSON line of what the hook printed", async () => {
    const hooks = await start({}, true)
    // A shell's AutoRun or profile printed before the relay's answer.
    await writeFile(
      join(dir, "answers", "PreToolUse"),
      `C:\\Users\\x>echo hi\r\nhello {"decision":"allow"}\r\n${JSON.stringify(deny)}\r\n`,
    )
    await expect(before(hooks, "bash").done).rejects.toThrow("Novadeck: ask the user for a permit.")
    await writeFile(join(dir, "answers", "PermissionRequest"), `banner\n{"reply":"once"}\n`)
    await emit(hooks, "permission.asked", asked)
    expect(permissionReplies).toHaveLength(1)
  })

  it("replies to nothing but a shell command's permission of a named call", async () => {
    const hooks = await start({}, true)
    for (const each of [
      { ...asked, permission: "edit" },
      { ...asked, permission: "external_directory" },
      { ...asked, tool: undefined },
      { ...asked, tool: {} },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- One at a time: each has its own answer.
      await answered("PermissionRequest", { reply: "once" })
      // eslint-disable-next-line no-await-in-loop -- As above.
      await emit(hooks, "permission.asked", each)
    }
    expect(permissionReplies).toEqual([])
    // While the gate is off the answer says nothing to it, whatever it prints.
    const off = await start()
    await answered("PermissionRequest", { reply: "once" })
    await emit(off, "permission.asked", asked)
    expect(permissionReplies).toEqual([])
  })

  it("reports the dialog again where its reply failed, which no answer then covers", async () => {
    const hooks = await start({}, true)
    await emit(hooks, "session.status", { sessionID: "ses_a", status: { type: "busy" } })
    let made = 0
    for (const failing of [
      async () => ({ data: false }),
      async () => ({ error: { name: "NotFoundError" } }),
      async () => {
        throw new Error("down")
      },
    ]) {
      replyAnswer = failing
      // eslint-disable-next-line no-await-in-loop -- One at a time: each has its own answer.
      await answered("PermissionRequest", { reply: "once" })
      // eslint-disable-next-line no-await-in-loop -- As above.
      await emit(hooks, "permission.asked", asked)
      // Its second report has run before the next answer is queued, as it would take it.
      made += 2
      // eslint-disable-next-line no-await-in-loop -- As above.
      await settled(made)
    }
    expect(permissionReplies).toHaveLength(3)
    expect(reports().filter(({ event }) => event === "PermissionRequest")).toHaveLength(6)
  })
})

describe("the plugin's files", () => {
  it("name the same module in the configuration file OPENCODE_CONFIG may name", () => {
    const written = files("linux", { mcp: { command: "/r", args: ["mcp"] } })
    expect(written.map(({ path }) => path)).toEqual([
      "novadeck.mjs",
      "novadeck-tui.mjs",
      "tui.json",
      "opencode.json",
    ])
    // A path opencode resolves against the file's own folder (config/plugin.ts:42, 1.19.6).
    expect(JSON.parse(written[3]!.content)).toEqual({ plugin: ["./novadeck.mjs"] })
  })

  it("name the interface's plugin in the tui.json the shim hands opencode", () => {
    const written = files("linux", { mcp: { command: "/r", args: ["mcp"] } })
    expect(JSON.parse(written[2]!.content)).toEqual({ plugin: ["./novadeck-tui.mjs"] })
  })
})

describe("the interface's plugin", () => {
  // The interface's plugin rendered with a hook command that records its input, given a route
  // that a test moves, as opencode's `api.route.current` is.
  const run = async (routes: unknown[]): Promise<Record<string, unknown>[]> => {
    const log = join(dir, "left.jsonl")
    const script = join(dir, "left.cjs")
    await writeFile(
      script,
      `let i="";process.stdin.on("data",(c)=>i+=c);process.stdin.on("end",()=>require("node:fs").appendFileSync(${JSON.stringify(log)},i+"\\n"))`,
    )
    const { tuiPluginSource } = await import("./tui-plugin-source.js")
    const file = join(dir, "novadeck-tui.mjs")
    await writeFile(
      file,
      tuiPluginSource({
        hook: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
        hookMs: 5000,
      }),
    )
    process.env.NOVADECK_HOOK = "x"
    const module = (await import(`${pathToFileURL(file).href}?${Date.now()}`)) as {
      default: { tui: (api: unknown) => Promise<void> }
    }
    let current: unknown = routes[0]
    let dispose: (() => void) | undefined
    await module.default.tui({
      route: {
        get current() {
          return current
        },
      },
      lifecycle: { onDispose: (stop: () => void) => (dispose = stop) },
    })
    for (const route of routes.slice(1)) {
      current = route
      // eslint-disable-next-line no-await-in-loop -- Each route change gets its time to be seen.
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    dispose?.()
    await new Promise((resolve) => setTimeout(resolve, 300))
    return existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : []
  }
  const session = (id: string) => ({ name: "session", params: { sessionID: id } })

  it("reports the session a route left for home, once, and nothing at its start", async () => {
    const told = await run([{ name: "home" }, session("ses_a"), { name: "home" }, session("ses_b")])
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({ hook_event_name: "SessionLeft", session_id: "ses_a" })
  })

  it("says nothing for a move between sessions, a child's view too", async () => {
    expect(await run([session("ses_a"), session("ses_child"), session("ses_a")])).toEqual([])
  })

  it("leaves the root too where the person goes home from a subagent's view, and marks each", async () => {
    const told = await run([session("ses_a"), session("ses_child"), { name: "home" }])
    expect(told.map(({ session_id }) => session_id).toSorted()).toEqual(["ses_a", "ses_child"])
    expect(existsSync(join(dir, "left", "ses_a"))).toBe(true)
  })
})
