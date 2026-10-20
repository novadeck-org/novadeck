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
        { type: "text", text: "Ask fox" },
      ],
    },
    { role: "system", content: [{ type: "text", text: "hook context" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hm" },
        { type: "text", text: "Sending." },
        { type: "tool_use", id: "toolu_1", name: "send", input: { to: "fox" } },
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
        { role: "user", text: "<system-reminder>r</system-reminder>\nAsk fox\nhook context" },
        {
          role: "assistant",
          text: "Sending.",
          calls: [{ id: "toolu_1", name: "send", input: { to: "fox" } }],
        },
        { role: "tool", id: "toolu_1", text: "queued" },
      ],
      tools: ["Bash", "send"],
      rawTools: conversation.tools,
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
      { text: "On it.", calls: [{ name: "send", input: { to: "moth", text: "hi" } }] },
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
      delta: { type: "input_json_delta", partial_json: '{"to":"moth","text":"hi"}' },
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

  it("words only the calls Claude Code won't run as refusals, never a tool's own errors", () => {
    const refused = [
      "<tool_use_error>Error: No such tool available: no_such_tool</tool_use_error>",
      "<tool_use_error>InputValidationError: Bash failed due to the following issue:\nThe required parameter `command` is missing</tool_use_error>",
    ]
    const tools = [
      "<tool_use_error>File does not exist.</tool_use_error>",
      "A message needs `to`, a terminal's handle, and its `text`.",
      "@fox has no agent Novadeck can deliver to.",
    ]

    expect(refused.map((text) => anthropic.rejection?.test(text))).toEqual([true, true])
    expect(tools.map((text) => anthropic.rejection?.test(text))).toEqual([false, false, false])
  })

  // Claude Code 2.1.304's first look at a prompt: Novadeck's tools named, not offered.
  const deferring = {
    model: "claude-test",
    messages: [
      { role: "user", content: [{ type: "text", text: "Ask fox" }] },
      {
        role: "system",
        content: [
          {
            type: "text",
            text: 'The following deferred tools are now available via ToolSearch. Use ToolSearch with query "select:<name>[,<name>...]":\nWebFetch\nmcp__plugin_novadeck_novadeck__send\n\nAvailable agent types:',
          },
        ],
      },
    ],
    tools: [{ name: "Bash" }, { name: "ToolSearch" }],
  }
  // The look after its load: the tools offered, the load's call and result after the prompt.
  const loaded = {
    ...deferring,
    messages: [
      ...deferring.messages,
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_s",
            name: "ToolSearch",
            input: { query: "select:WebFetch,mcp__plugin_novadeck_novadeck__send" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_s",
            content: [{ type: "tool_reference", tool_name: "mcp__plugin_novadeck_novadeck__send" }],
          },
          { type: "text", text: "<system-reminder>loaded</system-reminder>" },
        ],
      },
    ],
    tools: [
      ...deferring.tools,
      { name: "WebFetch", defer_loading: true },
      { name: "mcp__plugin_novadeck_novadeck__send", defer_loading: true },
    ],
  }

  it("loads the tools Claude Code defers before the rules see a call, as a model would", async () => {
    const { response, calls } = await handle(post("/v1/messages", deferring), { text: "Sent." })

    expect(calls).toEqual([])
    expect(JSON.parse(response.body as string)).toMatchObject({
      content: [
        {
          type: "tool_use",
          name: "ToolSearch",
          input: { query: "select:WebFetch,mcp__plugin_novadeck_novadeck__send", max_results: 2 },
        },
      ],
      stop_reason: "tool_use",
    })
  })

  it("shows the rules the call after the load as its first look, every tool offered", async () => {
    const { calls } = await handle(post("/v1/messages", loaded), { text: "Sent." })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.turns).toEqual([
      { role: "user", text: expect.stringMatching(/^Ask fox\n.*\n<system-reminder>loaded/s) },
    ])
    expect(calls[0]?.tools).toEqual([
      "Bash",
      "ToolSearch",
      "WebFetch",
      "mcp__plugin_novadeck_novadeck__send",
    ])
  })

  it("leaves a tool's result the latest turn when a load follows it, as a server joins late", () => {
    const call = parse({
      model: "claude-test",
      messages: [
        { role: "user", content: [{ type: "text", text: "Ask now" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_e", name: "mcp__elicit__elicit", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_e",
              content: [{ type: "text", text: "elicited" }],
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_s", name: "ToolSearch", input: { query: "select:x" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_s",
              content: [{ type: "tool_reference", tool_name: "x" }],
            },
            { type: "text", text: "Tool loaded." },
          ],
        },
        {
          role: "system",
          content: [{ type: "text", text: "<total_tokens>9 left</total_tokens>" }],
        },
      ],
      tools: [{ name: "ToolSearch" }, { name: "mcp__elicit__elicit" }, { name: "x" }],
    })

    expect(call.turns.at(-1)).toEqual({
      role: "tool",
      id: "toolu_e",
      text: "elicited\n<total_tokens>9 left</total_tokens>",
    })
    expect(call.turns).toHaveLength(3)
  })

  it("asks the rules once a load left a tool deferred, rather than load it again", async () => {
    const left = { ...loaded, tools: deferring.tools }
    const { calls } = await handle(post("/v1/messages", left), { text: "Sent." })

    expect(calls).toHaveLength(1)
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
