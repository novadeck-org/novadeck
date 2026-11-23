import { randomBytes } from "node:crypto"

import { z } from "zod"

import type { Dialect, Request, Response } from "./dialect.js"
import { withImages, type Call, type Reply, type ToolCall, type Turn } from "./script.js"

// Only what a Call needs; anything else in a request is the harness's business.
const part = z.looseObject({ type: z.string() })
const message = z.looseObject({
  role: z.string(),
  content: z.union([z.string(), z.array(part), z.null()]).optional(),
  tool_calls: z
    .array(
      z.looseObject({
        id: z.string().default(""),
        function: z.looseObject({ name: z.string(), arguments: z.string().default("") }),
      }),
    )
    .optional(),
  tool_call_id: z.string().optional(),
})
const payload = z.looseObject({
  model: z.string().default(""),
  messages: z.array(message).default([]),
  tools: z
    .array(z.looseObject({ function: z.looseObject({ name: z.string() }).optional() }))
    .default([]),
})

const id = (prefix: string): string => `${prefix}-${randomBytes(12).toString("hex")}`

const string = (value: unknown): string => (typeof value === "string" ? value : "")

// A message's content: a string, or its text parts joined.
const textOf = (content: z.infer<typeof message>["content"]): string =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .map((one) => string(one.text))
        .filter(Boolean)
        .join("\n")

const imagesIn = (content: z.infer<typeof message>["content"]): number =>
  Array.isArray(content) ? content.filter((one) => one.type === "image_url").length : 0

const inputOf = (args: string): Readonly<Record<string, unknown>> => {
  try {
    const value: unknown = JSON.parse(args)
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : { arguments: args }
  } catch {
    return { arguments: args }
  }
}

/**
 * The conversation as the model would see it: the system messages are the instructions; every
 * user message after the last answer is one turn; an assistant message is a turn of text and
 * calls; each tool message is the result of its call.
 */
const conversation = (messages: readonly z.infer<typeof message>[]) => {
  const system: string[] = []
  const turns: Turn[] = []
  for (const one of messages) {
    const last = turns.at(-1)
    if (one.role === "system" || one.role === "developer") {
      system.push(textOf(one.content))
    } else if (one.role === "assistant") {
      const calls: ToolCall[] = (one.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        input: inputOf(call.function.arguments),
      }))
      turns.push({ role: "assistant", text: textOf(one.content), calls })
    } else if (one.role === "tool") {
      turns.push({
        role: "tool",
        id: string(one.tool_call_id),
        text: textOf(one.content),
        ...withImages(imagesIn(one.content)),
      })
    } else if (last?.role === "user") {
      turns[turns.length - 1] = {
        ...last,
        text: [last.text, textOf(one.content)].join("\n"),
        ...withImages((last.images ?? 0) + imagesIn(one.content)),
      }
    } else
      turns.push({ role: "user", text: textOf(one.content), ...withImages(imagesIn(one.content)) })
  }
  return { system, turns }
}

// The call a harness makes for itself rather than the agent's turn: its thread's title.
const titling = /^\s*You are a title generator/

/** The call a chat completions request makes. */
export const parse = (data: unknown): Call => {
  const request = payload.parse(data)
  const { system, turns } = conversation(request.messages)
  const tools = request.tools.flatMap((one) => (one.function ? [one.function.name] : []))
  return {
    api: "chat",
    model: request.model,
    system: system.join("\n"),
    turns,
    tools,
    rawTools: request.tools,
    side: titling.test(system[0] ?? ""),
  }
}

const chunk = (call: Call, delta: object, finish: string | null): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1,
    model: call.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`

/**
 * The reply as chat completions streams it: the text as one delta, each call whole in a delta of
 * its own, the finish reason, the usage and `[DONE]`.
 */
export const stream = (call: Call, reply: Reply): string[] => {
  const calls = reply.calls ?? []
  const input = Math.ceil(JSON.stringify(call.turns).length / 4)
  const output = Math.ceil((reply.text ?? "").length / 4) + 1
  return [
    chunk(call, { role: "assistant", content: "" }, null),
    ...(reply.text ? [chunk(call, { content: reply.text }, null)] : []),
    ...calls.map((one, index) =>
      chunk(
        call,
        {
          tool_calls: [
            {
              index,
              id: id("call"),
              type: "function",
              function: { name: one.name, arguments: JSON.stringify(one.input) },
            },
          ],
        },
        null,
      ),
    ),
    chunk(call, {}, calls.length > 0 ? "tool_calls" : "stop"),
    `data: ${JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 1,
      model: call.model,
      choices: [],
      usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
    })}\n\n`,
    "data: [DONE]\n\n",
  ]
}

const route = (path: string): string => path.split("?")[0] ?? path

const json = (status: number, body: unknown): Response => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

/**
 * OpenAI's chat completions API, as opencode's `openrouter` provider speaks it: the tour points it
 * at `<endpoint>/chat/completions`, the endpoint being the fake tour service's (`/tour/v1`).
 */
export const chat: Dialect = {
  api: "chat",
  matches: (request: Request) => route(request.path).endsWith("/chat/completions"),
  handle: async (request, reply) => {
    if (request.method !== "POST")
      return json(404, { error: { type: "invalid_request_error", message: request.path } })
    const call = parse(JSON.parse(request.body || "{}"))
    const answer = await reply(call)
    return {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: stream(call, answer),
    }
  },
}
