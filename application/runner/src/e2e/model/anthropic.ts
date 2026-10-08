import { randomBytes } from "node:crypto"

import { z } from "zod"

import type { Dialect, Request, Response } from "./dialect.js"
import type { Call, Reply, Turn } from "./script.js"

// Only what a Call needs; anything else in a request is the harness's business.
const block = z.looseObject({ type: z.string() })
const content = z.union([z.string(), z.array(block)])
const messages = z.looseObject({
  model: z.string().default(""),
  system: content.optional(),
  // A system message may come mid-conversation, as Claude Code's environment does.
  messages: z.array(z.looseObject({ role: z.enum(["user", "assistant", "system"]), content })),
  tools: z.array(z.looseObject({ name: z.string() })).optional(),
  stream: z.boolean().optional(),
})
type Block = z.infer<typeof block>

const id = (prefix: string): string => `${prefix}_${randomBytes(12).toString("hex")}`

const json = (status: number, body: unknown): Response => ({
  status,
  headers: { "content-type": "application/json", "request-id": id("req") },
  body: JSON.stringify(body),
})

const string = (value: unknown): string => (typeof value === "string" ? value : "")

// The text of a content, its blocks' text joined; anything but text is left out.
const textOf = (value: string | readonly Block[]): string =>
  typeof value === "string"
    ? value
    : value
        .filter((one) => one.type === "text")
        .map((one) => string(one.text))
        .join("\n")

// One message as turns: a user message's tool results first, each a turn of its own,
// then whatever text came with them; an assistant's text and the tools it called.
const turnsOf = (message: z.infer<typeof messages>["messages"][number]): Turn[] => {
  const blocks = typeof message.content === "string" ? [] : message.content
  if (message.role === "assistant")
    return [
      {
        role: "assistant",
        text: textOf(message.content),
        calls: blocks
          .filter((one) => one.type === "tool_use")
          .map((one) => ({
            id: string(one.id),
            name: string(one.name),
            input: (one.input ?? {}) as Readonly<Record<string, unknown>>,
          })),
      },
    ]
  const results: Turn[] = blocks
    .filter((one) => one.type === "tool_result")
    .map((one) => ({
      role: "tool",
      id: string(one.tool_use_id),
      text: textOf(content.catch("").parse(one.content ?? "")),
    }))
  const text = textOf(message.content)
  return text || results.length === 0 ? [...results, { role: "user", text }] : results
}

/**
 * The conversation as turns. A system message mid-conversation is context a hook added
 * beside the prompt (Claude Code passes `UserPromptSubmit`'s `additionalContext` so), so
 * it joins the user turn before it; one with no user turn before it is the system's.
 */
const conversation = (request: z.infer<typeof messages>): { turns: Turn[]; system: string[] } =>
  request.messages.reduce<{ turns: Turn[]; system: string[] }>(
    ({ turns, system }, message) => {
      if (message.role !== "system") return { turns: [...turns, ...turnsOf(message)], system }
      const text = textOf(message.content)
      const last = turns.at(-1)
      return last?.role === "user"
        ? {
            turns: [...turns.slice(0, -1), { role: "user", text: `${last.text}\n${text}` }],
            system,
          }
        : { turns, system: [...system, text] }
    },
    { turns: [], system: request.system === undefined ? [] : [textOf(request.system)] },
  )

/**
 * The call a Messages request makes. One that offers no tools is the harness's own, as
 * Claude Code's title and quota calls are: its agent's turns always offer them.
 */
export const parse = (body: unknown): Call => {
  const request = messages.parse(body)
  const tools = (request.tools ?? []).map((tool) => tool.name)
  const { turns, system } = conversation(request)
  return {
    api: "anthropic",
    model: request.model,
    system: system.join("\n"),
    turns,
    tools,
    side: tools.length === 0,
  }
}

// What the reply says, as a Messages response's content blocks.
const blocksOf = (reply: Reply) => [
  ...(reply.text ? [{ type: "text" as const, text: reply.text }] : []),
  ...(reply.calls ?? []).map((call) => ({
    type: "tool_use" as const,
    id: id("toolu"),
    name: call.name,
    input: call.input,
  })),
]

const usage = (call: Call, reply: Reply) => ({
  // About four characters a token, which is all a harness's context meter needs.
  input_tokens: Math.ceil(JSON.stringify(call.turns).length / 4),
  output_tokens: reply.usage?.outputTokens ?? 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
})

const event = (type: string, data: object): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`

// The reply as the Messages API streams it: each block opened, filled with one delta and
// closed, then the stop reason.
const stream = (message: ReturnType<typeof messageOf>): string[] => [
  event("message_start", {
    message: { ...message, content: [], stop_reason: null, stop_sequence: null },
  }),
  ...message.content.flatMap((one, index) => [
    event("content_block_start", {
      index,
      content_block: one.type === "text" ? { type: "text", text: "" } : { ...one, input: {} },
    }),
    event("content_block_delta", {
      index,
      delta:
        one.type === "text"
          ? { type: "text_delta", text: one.text }
          : { type: "input_json_delta", partial_json: JSON.stringify(one.input) },
    }),
    event("content_block_stop", { index }),
  ]),
  event("message_delta", {
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: message.usage.output_tokens },
  }),
  event("message_stop", {}),
]

const messageOf = (call: Call, reply: Reply) => {
  const blocks = blocksOf(reply)
  return {
    id: id("msg"),
    type: "message",
    role: "assistant",
    model: call.model,
    content: blocks.length > 0 ? blocks : [{ type: "text" as const, text: "" }],
    stop_reason: reply.calls?.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: usage(call, reply),
  }
}

const models = ["claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"].map((model) => ({
  type: "model",
  id: model,
  display_name: model,
  created_at: "2026-01-01T00:00:00Z",
}))

const route = (path: string): string => path.split("?")[0] ?? path

/** Anthropic's Messages API, as Claude Code speaks it. */
export const anthropic: Dialect = {
  api: "anthropic",
  // Claude Code's own wrapper for a call it won't run; other errors wrapped the same way,
  // as a file not found, are the tool's.
  rejection: /^<tool_use_error>(?:Error: No such tool available|InputValidationError)/,
  matches: (request: Request) => /^\/v1\/(messages|models)(\/|$)/.test(route(request.path)),
  handle: async (request, reply) => {
    const path = route(request.path)
    if (path === "/v1/models")
      return json(200, { data: models, has_more: false, first_id: "", last_id: "" })
    if (path.startsWith("/v1/models/"))
      return json(200, { ...models[0], id: path.slice("/v1/models/".length) })
    const body: unknown = JSON.parse(request.body || "{}")
    if (path === "/v1/messages/count_tokens")
      return json(200, { input_tokens: Math.ceil(request.body.length / 4) })
    if (path !== "/v1/messages" || request.method !== "POST")
      return json(404, { type: "error", error: { type: "not_found_error", message: path } })
    const call = parse(body)
    const message = messageOf(call, await reply(call))
    if (!messages.parse(body).stream) return json(200, message)
    return {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "request-id": id("req"),
      },
      body: stream(message),
    }
  },
}
