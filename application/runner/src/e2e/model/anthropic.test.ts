import { describe, expect, it } from "../../test.js"
import { anthropic, parse } from "./anthropic.js"
import type { Request } from "./dialect.js"
import type { Call, Reply } from "./script.js"

const post = (path: string, body: object): Request => ({
  method: "POST",
  path,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

// A turn of Claude Code's: its prompt with a reminder beside it, the context its hook
// added, its call to a tool and the tool's result.
const conversation = {
  model: "claude-test",
  system: [{ type: "text", text: "You are Claude Code." }],
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "<system-reminder>r</system-reminder>" },
        { type: "text", text: "Ask t2" },
      ],
    },
    { role: "system", content: [{ type: "text", text: "hook context" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hm" },
        { type: "text", text: "Sending." },
        { type: "tool_use", id: "toolu_1", name: "send", input: { to: "t2" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [{ type: "text", text: "queued" }],
        },
      ],
    },
  ],
  tools: [{ name: "Bash" }, { name: "send" }],
}

// The events of a streamed answer, in order.
const events = (body: string | readonly string[]): { type: string }[] =>
  [body]
    .flat()
    .join("")
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as { type: string })

const handle = async (request: Request, reply: Reply) => {
  const calls: Call[] = []
  const response = await anthropic.handle(request, async (call) => {
    calls.push(call)
    return reply
  })
  return { response, calls }
}

describe("anthropic", () => {
  it("reads a conversation as turns, with a hook's context in the prompt's turn", () => {
    expect(parse(conversation)).toEqual({
      api: "anthropic",
      model: "claude-test",
      system: "You are Claude Code.",
      turns: [
        { role: "user", text: "<system-reminder>r</system-reminder>\nAsk t2\nhook context" },
        {
          role: "assistant",
          text: "Sending.",
          calls: [{ id: "toolu_1", name: "send", input: { to: "t2" } }],
        },
        { role: "tool", id: "toolu_1", text: "queued" },
      ],
      tools: ["Bash", "send"],
      side: false,
    })
  })

  it("tells a call that offers no tools as the harness's own", () => {
    const call = parse({ model: "m", messages: [{ role: "user", content: "Name this session" }] })

    expect(call.side).toBe(true)
    expect(call.turns).toEqual([{ role: "user", text: "Name this session" }])
  })

  it("streams a reply's text and tool calls as the Messages API does", async () => {
    const { response, calls } = await handle(
      post("/v1/messages?beta=true", { ...conversation, stream: true }),
      { text: "On it.", calls: [{ name: "send", input: { to: "t1", text: "hi" } }] },
    )

    expect(response.headers["content-type"]).toBe("text/event-stream")
    expect(calls).toHaveLength(1)
    expect(events(response.body).map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect(events(response.body)).toContainEqual({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"to":"t1","text":"hi"}' },
    })
    expect(events(response.body)).toContainEqual(
      expect.objectContaining({
        type: "message_delta",
        delta: expect.objectContaining({ stop_reason: "tool_use" }),
      }),
    )
  })

  it("reports the output tokens a reply says it took, or its own count", async () => {
    const delta = async (reply: Reply) => {
      const { response } = await handle(
        post("/v1/messages?beta=true", { ...conversation, stream: true }),
        reply,
      )
      return events(response.body).find((event) => event.type === "message_delta")
    }

    expect(await delta({ text: "Done." })).toMatchObject({ usage: { output_tokens: 1 } })
    expect(await delta({ text: "Done.", usage: { outputTokens: 300_000 } })).toMatchObject({
      usage: { output_tokens: 300_000 },
    })
    const { response } = await handle(post("/v1/messages", conversation), {
      text: "Done.",
      usage: { outputTokens: 42 },
    })
    expect(JSON.parse(response.body as string).usage).toMatchObject({ output_tokens: 42 })
  })

  it("answers whole when not asked to stream", async () => {
    const { response } = await handle(post("/v1/messages", conversation), { text: "Done." })

    expect(JSON.parse(response.body as string)).toMatchObject({
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text: "Done." }],
      stop_reason: "end_turn",
    })
  })

  it("counts tokens and lists models without making a call", async () => {
    const counted = await handle(post("/v1/messages/count_tokens", conversation), {})
    const listed = await handle(
      { method: "GET", path: "/v1/models?limit=100", headers: {}, body: "" },
      {},
    )

    expect(JSON.parse(counted.response.body as string).input_tokens).toBeGreaterThan(0)
    expect(JSON.parse(listed.response.body as string).data.length).toBeGreaterThan(0)
    expect([...counted.calls, ...listed.calls]).toEqual([])
  })

  it("takes only the Messages and Models APIs", () => {
    expect(anthropic.matches(post("/v1/messages?beta=true", {}))).toBe(true)
    expect(anthropic.matches({ method: "GET", path: "/v1/models", headers: {}, body: "" })).toBe(
      true,
    )
    expect(anthropic.matches(post("/v1/responses", {}))).toBe(false)
    expect(anthropic.matches(post("/api/event_logging/batch", {}))).toBe(false)
  })
})
