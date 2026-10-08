import { randomBytes } from "node:crypto"

import { z } from "zod"

import type { Dialect, Request, Response } from "./dialect.js"
import type { Call, Reply, ToolCall, Turn } from "./script.js"

// Only what a Call needs; anything else in a request is the harness's business.
const part = z.looseObject({ type: z.string() })
const item = z.looseObject({ type: z.string().default("message") })
const tool = z.looseObject({
  type: z.string(),
  name: z.string().optional(),
  // A namespace holds tools of its own, as Codex offers an MCP server's.
  tools: z.array(z.looseObject({ name: z.string() })).optional(),
})
const payload = z.looseObject({
  model: z.string().default(""),
  instructions: z.string().default(""),
  input: z.union([z.string(), z.array(item)]).default([]),
  tools: z.array(tool).default([]),
  stream: z.boolean().optional(),
  client_metadata: z.looseObject({}).optional(),
})
type Item = z.infer<typeof item>
type Tool = z.infer<typeof tool>

const id = (prefix: string): string => `${prefix}_${randomBytes(12).toString("hex")}`

const json = (status: number, body: unknown): Response => ({
  status,
  headers: { "content-type": "application/json", "x-request-id": id("req") },
  body: JSON.stringify(body),
})

const string = (value: unknown): string => (typeof value === "string" ? value : "")

// The text of a message's content or a tool's output: a string, or its parts' text joined.
const textOf = (value: unknown): string =>
  typeof value === "string"
    ? value
    : z
        .array(part)
        .catch([])
        .parse(value)
        .map((one) => string(one.text))
        .filter(Boolean)
        .join("\n")

/**
 * The name a call or offer of a tool goes by: a namespaced one, as Codex offers an MCP
 * server's tools (`mcp__novadeck` holding `send`), as `namespace.name`.
 */
const qualified = (name: string, namespace?: string): string =>
  namespace ? `${namespace}.${name}` : name

const namesOf = (offered: Tool): string[] =>
  offered.type === "namespace"
    ? (offered.tools ?? []).map((one) => qualified(one.name, offered.name))
    : [offered.name ?? offered.type]

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

// A call's arguments, which the API sends as a JSON string; kept whole when they aren't.
const inputOf = (args: unknown): Readonly<Record<string, unknown>> => {
  if (typeof args !== "string") return {}
  const value = parsed(args)
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : { arguments: args }
}

// A call the model made, as the input replays it; undefined for any other item.
const callOf = (one: Item): ToolCall | undefined => {
  if (one.type === "function_call")
    return {
      id: string(one.call_id),
      name: qualified(string(one.name), string(one.namespace) || undefined),
      input: inputOf(one.arguments),
    }
  if (one.type === "custom_tool_call")
    return { id: string(one.call_id), name: string(one.name), input: { input: one.input } }
  return undefined
}

const outputs = new Set(["function_call_output", "custom_tool_call_output"])

/**
 * The input as the conversation: the developer and system messages before it starts join
 * the instructions; after that, every user, developer and system message until the next
 * answer is one user turn, as a prompt hook's context comes as a developer message beside
 * the prompt; the assistant's text and calls one turn; each call's output a turn of its own.
 */
const conversation = (input: readonly Item[]): { system: string[]; turns: Turn[] } => {
  const system: string[] = []
  const turns: Turn[] = []
  for (const one of input) {
    const last = turns.at(-1)
    const call = callOf(one)
    if (call || (one.type === "message" && one.role === "assistant")) {
      const text = call ? "" : textOf(one.content)
      const calls = call ? [call] : []
      if (last?.role === "assistant")
        turns[turns.length - 1] = {
          role: "assistant",
          text: [last.text, text].filter(Boolean).join("\n"),
          calls: [...last.calls, ...calls],
        }
      else turns.push({ role: "assistant", text, calls })
      continue
    }
    if (outputs.has(one.type)) {
      turns.push({ role: "tool", id: string(one.call_id), text: textOf(one.output) })
      continue
    }
    if (one.type !== "message") continue
    const text = textOf(one.content)
    if (one.role !== "user" && turns.length === 0) system.push(text)
    else if (last?.role === "user")
      turns[turns.length - 1] = { role: "user", text: [last.text, text].join("\n") }
    else turns.push({ role: "user", text })
  }
  return { system, turns }
}

// The turn metadata Codex sends with each call, as far as it tells a side call.
const metadata = z
  .looseObject({ thread_source: z.string().optional(), request_kind: z.string().optional() })
  .catch({})

/**
 * Whether Codex makes the call for itself, as its thread's title: its turn metadata names
 * the thread's source, which is the person's (`user`) or an agent it spawned (`subagent`)
 * for the agent's own turns, and a feature's name, a review or a memory's otherwise.
 */
const sideOf = (request: z.infer<typeof payload>, headers: Request["headers"]): boolean => {
  const raw =
    string(request.client_metadata?.["x-codex-turn-metadata"]) || headers["x-codex-turn-metadata"]
  if (!raw) return false
  const turn = metadata.parse(parsed(raw))
  const source = turn.thread_source
  return (
    (source !== undefined && source !== "user" && source !== "subagent") ||
    (turn.request_kind !== undefined && turn.request_kind !== "turn")
  )
}

/** The call a Responses request makes, given its headers for the turn metadata Codex sends. */
export const parse = (data: unknown, headers: Request["headers"] = {}): Call => {
  const request = payload.parse(data)
  const input =
    typeof request.input === "string"
      ? [{ type: "message", role: "user", content: request.input }]
      : request.input
  const { system, turns } = conversation(input)
  return {
    api: "responses",
    model: request.model,
    system: [request.instructions, ...system].filter(Boolean).join("\n"),
    turns,
    tools: request.tools.flatMap(namesOf),
    side: sideOf(request, headers),
  }
}

/**
 * A reply's call as an output item: a name the request offered in a namespace goes back
 * as that namespace and the tool's own name, as Codex routes it.
 */
const functionCall = (call: Omit<ToolCall, "id">, offered: readonly Tool[]) => {
  const space = offered.find(
    (one) =>
      one.type === "namespace" &&
      (one.tools ?? []).some((inner) => qualified(inner.name, one.name) === call.name),
  )
  const name = space?.name ? call.name.slice(space.name.length + 1) : call.name
  return {
    type: "function_call",
    id: id("fc"),
    call_id: id("call"),
    ...(space?.name && { namespace: space.name }),
    name,
    arguments: JSON.stringify(call.input),
    status: "completed",
  }
}

const event = (type: string, data: object): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`

/**
 * The reply as the Responses API streams it: the response created, each output item
 * added, a message's text as one delta, each item done, then the response completed with
 * its usage, which Codex needs to end the turn.
 */
export const stream = (call: Call, reply: Reply, offered: readonly Tool[] = []): string[] => {
  const response = id("resp")
  const message = reply.text
    ? [
        {
          type: "message",
          id: id("msg"),
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: reply.text, annotations: [] }],
        },
      ]
    : []
  const items = [...message, ...(reply.calls ?? []).map((one) => functionCall(one, offered))]
  const created = {
    id: response,
    object: "response",
    model: call.model,
    status: "in_progress",
    output: [],
  }
  // About four characters a token, which is all a harness's context meter needs.
  const input = Math.ceil(JSON.stringify(call.turns).length / 4)
  const output = Math.ceil((reply.text ?? "").length / 4) + 1
  return [
    event("response.created", { response: created }),
    ...items.flatMap((one, index) => [
      event("response.output_item.added", {
        output_index: index,
        item:
          one.type === "message"
            ? { ...one, status: "in_progress", content: [] }
            : { ...one, status: "in_progress", arguments: "" },
      }),
      ...(one.type === "message"
        ? [
            event("response.output_text.delta", {
              output_index: index,
              content_index: 0,
              item_id: one.id,
              delta: reply.text,
            }),
          ]
        : []),
      event("response.output_item.done", { output_index: index, item: one }),
    ]),
    event("response.completed", {
      response: {
        ...created,
        status: "completed",
        output: items,
        usage: {
          input_tokens: input,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: output,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: input + output,
        },
      },
    }),
  ]
}

/**
 * The rate-limit headers Codex reads beside a response: the share used of its short
 * window (five hours) and its long one (a week), each resetting a window from now.
 */
export const limits = (usedPercent: number): Record<string, string> => {
  const now = Math.floor(Date.now() / 1000)
  const window = (name: string, minutes: number) => ({
    [`x-codex-${name}-used-percent`]: String(usedPercent),
    [`x-codex-${name}-window-minutes`]: String(minutes),
    [`x-codex-${name}-reset-at`]: String(now + minutes * 60),
  })
  return { ...window("primary", 300), ...window("secondary", 10_080) }
}

const route = (path: string): string => path.split("?")[0] ?? path

/**
 * OpenAI's Responses API, as Codex speaks it through a model provider of its own
 * (`wire_api = "responses"`, its `base_url` the fake model's `/v1`). Pointed at the fake
 * model too (`chatgpt_base_url`), its ChatGPT backend's only call on the way to the
 * prompt, the featured plugins, is answered with none.
 */
export const responses: Dialect = {
  api: "responses",
  // Codex's answers to a call to a tool it has none of, and to arguments its tool can't parse.
  rejection: /^(?:unsupported call: |failed to parse function arguments)/,
  matches: (request) => {
    const path = route(request.path)
    return path === "/v1/responses" || path.endsWith("/backend-api/plugins/featured")
  },
  handle: async (request, reply) => {
    const path = route(request.path)
    if (path.endsWith("/plugins/featured")) return json(200, [])
    if (request.method !== "POST")
      return json(404, { error: { type: "invalid_request_error", message: path } })
    const data: unknown = JSON.parse(request.body || "{}")
    const call = parse(data, request.headers)
    const answer = await reply(call)
    const offered = payload.parse(data).tools
    return {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-request-id": id("req"),
        ...(answer.limits && limits(answer.limits.usedPercent)),
      },
      body: stream(call, answer, offered),
    }
  },
}
