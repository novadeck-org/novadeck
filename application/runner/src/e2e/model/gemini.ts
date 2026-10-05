import { randomBytes } from "node:crypto"

import { z } from "zod"

import type { Dialect, Request, Response } from "./dialect.js"
import type { Call, Reply, Turn } from "./script.js"

// Only what a Call needs; anything else in a request is the harness's business.
const part = z.looseObject({
  text: z.string().optional(),
  // A thought the model showed earlier, which isn't part of what it said.
  thought: z.boolean().optional(),
  functionCall: z
    .looseObject({ id: z.string().optional(), name: z.string(), args: z.unknown().optional() })
    .optional(),
  functionResponse: z
    .looseObject({ id: z.string().optional(), name: z.string(), response: z.unknown().optional() })
    .optional(),
})
const content = z.looseObject({ role: z.string().optional(), parts: z.array(part).default([]) })
const generate = z.looseObject({
  contents: z.array(content).default([]),
  systemInstruction: content.optional(),
  tools: z
    .array(
      z.looseObject({
        functionDeclarations: z.array(z.looseObject({ name: z.string() })).optional(),
      }),
    )
    .optional(),
})
type Part = z.infer<typeof part>

const id = (prefix: string): string => `${prefix}_${randomBytes(12).toString("hex")}`

const json = (status: number, body: unknown): Response => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

// What the parts say, their text joined; thoughts and anything but text are left out.
const textOf = (parts: readonly Part[]): string =>
  parts
    .filter((one) => one.text !== undefined && !one.thought)
    .map((one) => one.text)
    .join("\n")

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

// A tool's result as text: its `output` when it gives one, else all of it.
const resultOf = (response: unknown): string => {
  const output = record(response).output
  return typeof output === "string" ? output : JSON.stringify(response ?? {})
}

/**
 * Antigravity's tool for an MCP tool it loads lazily, as it does Novadeck's: the model
 * reads the tool's schema from a file and calls it through this one, naming its server.
 */
const lazy = "call_mcp_tool"

// The name Antigravity gives an MCP tool it loads eagerly, as a tool of its own.
const mcpName = (server: string, tool: string): string => `mcp_${server}_${tool}`

/**
 * The MCP tools Antigravity loads lazily, by the names it would give them loaded eagerly,
 * each with its server and tool: its system prompt lists them under `<mcp_servers>`, a
 * `# <server>` heading over its `Eager:` and `Lazy:` tools.
 */
const lazyTools = (system: string): ReadonlyMap<string, { server: string; tool: string }> => {
  const listed = /<mcp_servers>([\s\S]*?)<\/mcp_servers>/.exec(system)?.[1] ?? ""
  const tools = new Map<string, { server: string; tool: string }>()
  let server = ""
  let section = ""
  for (const line of listed.split("\n").map((one) => one.trim())) {
    if (line.startsWith("```")) continue
    if (line.startsWith("# ")) [server, section] = [line.slice(2), ""]
    else if (/^(Eager|Lazy):$/.test(line)) section = line
    else if (server && section === "Lazy:" && /^[\w.-]+$/.test(line))
      tools.set(mcpName(server, line), { server, tool: line })
  }
  return tools
}

// A tool call as the model made it, a lazy MCP tool's by the name it would have eagerly.
const callOf = (call: { id?: string | undefined; name: string; args?: unknown }) => {
  const args = record(call.args)
  const lazyCall =
    call.name === lazy && typeof args.ServerName === "string" && typeof args.ToolName === "string"
  return {
    id: call.id ?? call.name,
    name: lazyCall ? mcpName(String(args.ServerName), String(args.ToolName)) : call.name,
    input: lazyCall ? record(args.Arguments) : args,
  }
}

/**
 * One content as turns: the model's text and the tools it called, and the tools' results,
 * each a turn of its own; on the user's side its results first, then whatever text came
 * with them. Antigravity sends tool results in a content of the model's own.
 */
const turnsOf = (one: z.infer<typeof content>): Turn[] => {
  const results: Turn[] = one.parts.flatMap(({ functionResponse: result }) =>
    result
      ? [{ role: "tool" as const, id: result.id ?? result.name, text: resultOf(result.response) }]
      : [],
  )
  const text = textOf(one.parts)
  if (one.role !== "model")
    return text || results.length === 0 ? [...results, { role: "user", text }] : results
  const calls = one.parts.flatMap(({ functionCall: call }) => (call ? [callOf(call)] : []))
  return text || calls.length > 0 || results.length === 0
    ? [{ role: "assistant", text, calls }, ...results]
    : results
}

/**
 * The conversation as turns. User text that follows a user turn joins it, as a hook's
 * message injected beside the prompt is: Antigravity sends `PreInvocation`'s ephemeral
 * message as user content of its own after the prompt.
 */
const conversation = (contents: readonly z.infer<typeof content>[]): Turn[] =>
  contents.flatMap(turnsOf).reduce<Turn[]>((turns, turn) => {
    const last = turns.at(-1)
    return turn.role === "user" && last?.role === "user"
      ? [...turns.slice(0, -1), { role: "user", text: `${last.text}\n${turn.text}` }]
      : [...turns, turn]
  }, [])

/**
 * The call a `generateContent` request makes for `model`. Its tools are those declared
 * and, when it offers `call_mcp_tool`, the MCP tools that reaches, by the names they
 * would have loaded eagerly, so a rule finds Novadeck's `send` however it is loaded. One
 * that offers no tools is the harness's own, as Antigravity's title call is: its agent's
 * turns always offer them.
 */
export const parse = (model: string, body: unknown): Call => {
  const request = generate.parse(body)
  const system = request.systemInstruction ? textOf(request.systemInstruction.parts) : ""
  const declared = (request.tools ?? []).flatMap((tool) =>
    (tool.functionDeclarations ?? []).map((declaration) => declaration.name),
  )
  const reached = declared.includes(lazy) ? [...lazyTools(system).keys()] : []
  const tools = [...declared, ...reached.filter((name) => !declared.includes(name))]
  return {
    api: "gemini",
    model,
    system,
    turns: conversation(request.contents),
    tools,
    side: tools.length === 0,
  }
}

/**
 * A tool call as Antigravity takes it: a lazy MCP tool's through `call_mcp_tool`, with
 * the summary and action it asks of every call, and any other as itself.
 */
const functionCallOf = (call: Call, name: string, input: Readonly<Record<string, unknown>>) => {
  const target = call.tools.includes(lazy) ? lazyTools(call.system).get(name) : undefined
  if (!target) return { id: id("call"), name, args: input }
  return {
    id: id("call"),
    name: lazy,
    args: {
      ServerName: target.server,
      ToolName: target.tool,
      Arguments: input,
      toolSummary: `${target.tool} call`,
      toolAction: `Calling ${target.tool}`,
    },
  }
}

// What the reply says, as the model's parts.
const partsOf = (call: Call, reply: Reply) => [
  ...(reply.text ? [{ text: reply.text }] : []),
  ...(reply.calls ?? []).map((one) => ({
    functionCall: functionCallOf(call, one.name, one.input),
  })),
]

const responseOf = (call: Call, reply: Reply) => {
  const parts = partsOf(call, reply)
  // About four characters a token, which is all a harness's context meter needs.
  const prompt = Math.ceil(JSON.stringify(call.turns).length / 4)
  return {
    candidates: [
      {
        content: { role: "model", parts: parts.length > 0 ? parts : [{ text: "" }] },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: prompt,
      candidatesTokenCount: 1,
      totalTokenCount: prompt + 1,
    },
    modelVersion: call.model,
    responseId: id("resp"),
  }
}

const route = (path: string): string => path.split("?")[0] ?? path

// `/v1beta/models/<model>:<method>`, as the Gemini API names a model's methods.
const method = /^\/v1(?:beta|alpha)?\/models\/([^/:]+):(\w+)$/

/**
 * The Gemini API, as Antigravity speaks it with an API key: its `generateContent`, whose
 * contents, parts and function calls are those Code Assist wraps, streamed as server-sent
 * events. Antigravity asks it for nothing else on the way to its turns.
 */
export const gemini: Dialect = {
  api: "gemini",
  matches: (request: Request) => method.test(route(request.path)),
  handle: async (request, reply) => {
    const [, model = "", name = ""] = method.exec(route(request.path)) ?? []
    if (name !== "generateContent" && name !== "streamGenerateContent")
      return json(404, { error: { code: 404, message: name, status: "NOT_FOUND" } })
    const call = parse(model, JSON.parse(request.body || "{}"))
    const response = responseOf(call, await reply(call))
    if (name === "generateContent") return json(200, response)
    return {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: [`data: ${JSON.stringify(response)}\r\n\r\n`],
    }
  },
}
