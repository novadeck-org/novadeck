import { randomBytes } from "node:crypto"

import { z } from "zod"

import type { Dialect, Request, Response } from "./dialect.js"
import { withImages, type Call, type Reply, type Turn } from "./script.js"

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

// How many image blocks a content holds.
const imagesIn = (value: string | readonly Block[]): number =>
  typeof value === "string" ? 0 : value.filter((one) => one.type === "image").length

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
      ...withImages(imagesIn(content.catch("").parse(one.content ?? ""))),
    }))
  const text = textOf(message.content)
  return text || results.length === 0 ? [...results, { role: "user", text }] : results
}

// Claude Code's tool that loads the schemas of the tools it names only (`deferredOf`).
const search = "ToolSearch"

/**
 * The turns without the fake model's own loads of deferred tools (see `anthropic`): its
 * call to `ToolSearch`, the result, and the "Tool loaded." Claude Code says with it, so the
 * rules see the conversation as it was before the load. Anything else that came with the
 * result, as a reminder, joins the turn before the load, a user's or a tool result.
 */
const unsearched = (turns: readonly Turn[]): Turn[] => {
  const loads = new Set(
    turns.flatMap((turn) =>
      turn.role === "assistant" &&
      turn.text === "" &&
      turn.calls.length > 0 &&
      turn.calls.every((call) => call.name === search)
        ? turn.calls.map((call) => call.id)
        : [],
    ),
  )
  let loaded = false
  return turns.reduce<Turn[]>((kept, turn) => {
    const after = loaded
    loaded = false
    if (turn.role === "assistant" && turn.calls.some((call) => loads.has(call.id))) return kept
    if (turn.role === "tool" && loads.has(turn.id)) {
      loaded = true
      return kept
    }
    const last = kept.at(-1)
    if (turn.role !== "user" || (!after && last?.role !== "user")) return [...kept, turn]
    const text = after ? turn.text.replace(/^Tool loaded\.\n?/, "") : turn.text
    if (!text) return kept
    if (last?.role === "user")
      return [...kept.slice(0, -1), { role: "user", text: `${last.text}\n${text}` }]
    if (last?.role === "tool")
      return [...kept.slice(0, -1), { ...last, text: `${last.text}\n${text}` }]
    return [...kept, { role: "user", text }]
  }, [])
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

// How Claude Code lists the tools it offers by name only, one a line, in its reminders.
const deferredList =
  /The following deferred tools are now available via ToolSearch\.[^\n]*\n((?:[^\n]+\n?)+)/g

/**
 * The tools a request names as deferred and doesn't offer yet: their schemas load only
 * once the model asks `ToolSearch` for them. Claude Code defers MCP tools, and some of its
 * own; from 2.1.304 behind any API, where 2.1.287 offered them all behind one not
 * Anthropic's own, as this one is.
 */
const deferredOf = (request: z.infer<typeof messages>): string[] => {
  const offered = new Set((request.tools ?? []).map((tool) => tool.name))
  const texts = [
    ...(request.system === undefined ? [] : [textOf(request.system)]),
    ...request.messages.map((message) => textOf(message.content)),
  ]
  const named = texts.flatMap((text) =>
    [...text.matchAll(deferredList)].flatMap((match) =>
      (match[1] ?? "").split("\n").map((line) => line.trim()),
    ),
  )
  return [...new Set(named)].filter((name) => name !== "" && !offered.has(name))
}

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
    turns: unsearched(turns),
    tools,
    rawTools: request.tools ?? [],
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

/**
 * Anthropic's Messages API, as Claude Code speaks it. Where it offers tools by name only
 * (`deferredOf`), the fake model first loads them all through `ToolSearch`, as a model
 * would before calling one, without asking the rules: they see that call's conversation
 * on the next, with every tool offered, as before tools were deferred.
 */
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
    const sent = messages.parse(body)
    const deferred = call.tools.includes(search) ? deferredOf(sent) : []
    // Loaded once: what a load left deferred isn't asked for again.
    const last = sent.messages.findLast((one) => one.role === "assistant")?.content
    const loading =
      deferred.length > 0 &&
      !(Array.isArray(last) && last.some((one) => one.type === "tool_use" && one.name === search))
    const message = messageOf(
      call,
      loading
        ? {
            calls: [
              {
                name: search,
                input: { query: `select:${deferred.join(",")}`, max_results: deferred.length },
              },
            ],
          }
        : await reply(call),
    )
    if (!sent.stream) return json(200, message)
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
