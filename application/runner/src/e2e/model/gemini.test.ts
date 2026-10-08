import { describe, expect, it } from "../../test.js"
import type { Request } from "./dialect.js"
import { gemini, parse } from "./gemini.js"
import { tool, type Call, type Reply } from "./script.js"

const post = (path: string, body: object): Request => ({
  method: "POST",
  path,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

// Antigravity's system prompt lists the MCP tools it loads lazily, by server.
const system = `You are Antigravity.
<mcp_servers>
The following MCP servers and their available tools are listed below, following this format:
\`\`\`
# <serverName>
Eager:
<toolName>
Lazy:
<toolName>
\`\`\`
# novadeck_novadeck
Lazy:
show
send
</mcp_servers>`

// A turn of Antigravity's, trimmed: its prompt, the message its PreInvocation hook
// injected as content of its own, a thought, its call to Novadeck's `send` through
// `call_mcp_tool`, and the tool's result, which it sends in a content of the model's.
const conversation = {
  contents: [
    { role: "user", parts: [{ text: "<USER_REQUEST>\nAsk t2\n</USER_REQUEST>" }] },
    { role: "user", parts: [{ text: '<novadeck-messages><message from="t2">hi</message>' }] },
    {
      role: "model",
      parts: [
        { text: "Planning.", thought: true },
        {
          functionCall: {
            id: "call_1",
            name: "call_mcp_tool",
            args: {
              ServerName: "novadeck_novadeck",
              ToolName: "send",
              Arguments: { to: "t2", text: "hello" },
              toolSummary: "Message",
              toolAction: "Sending",
            },
          },
        },
      ],
    },
    {
      role: "model",
      parts: [
        {
          functionResponse: {
            id: "call_1",
            name: "call_mcp_tool",
            response: { output: "Message m-1 to t2 is queued." },
          },
        },
      ],
    },
  ],
  systemInstruction: { role: "user", parts: [{ text: system }] },
  tools: [{ functionDeclarations: [{ name: "run_command" }, { name: "call_mcp_tool" }] }],
  generationConfig: { maxOutputTokens: 65535 },
}

const stream = "/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse"

// The JSON of each event of a streamed answer, in order.
const events = (body: string | readonly string[]): unknown[] =>
  [body]
    .flat()
    .join("")
    .split("\r\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as unknown)

const handle = async (request: Request, reply: Reply) => {
  const calls: Call[] = []
  const response = await gemini.handle(request, async (call) => {
    calls.push(call)
    return reply
  })
  return { response, calls }
}

describe("gemini", () => {
  it("reads a conversation as turns, with an injected message in the prompt's turn", () => {
    expect(parse("gemini-3.1-pro-preview", conversation)).toEqual({
      api: "gemini",
      model: "gemini-3.1-pro-preview",
      system,
      turns: [
        {
          role: "user",
          text: '<USER_REQUEST>\nAsk t2\n</USER_REQUEST>\n<novadeck-messages><message from="t2">hi</message>',
        },
        {
          role: "assistant",
          text: "",
          calls: [
            {
              id: "call_1",
              name: "mcp_novadeck_novadeck_send",
              input: { to: "t2", text: "hello" },
            },
          ],
        },
        { role: "tool", id: "call_1", text: "Message m-1 to t2 is queued." },
      ],
      tools: [
        "run_command",
        "call_mcp_tool",
        "mcp_novadeck_novadeck_show",
        "mcp_novadeck_novadeck_send",
      ],
      side: false,
    })
  })

  it("offers Novadeck's lazy tools only where Antigravity can reach them", () => {
    const reachable = parse("m", conversation)
    expect(tool(reachable, "send")).toBe("mcp_novadeck_novadeck_send")
    const unreachable = parse("m", { ...conversation, tools: [{ functionDeclarations: [] }] })
    expect(tool(unreachable, "send")).toBeUndefined()
  })

  it("takes a call that offers no tools for the harness's own, as its title is", () => {
    const title = parse("gemini-3.1-flash-lite-preview", {
      contents: [{ role: "user", parts: [{ text: "Ask t2" }] }],
      systemInstruction: { parts: [{ text: "You are a conversation title generator." }] },
    })
    expect(title.side).toBe(true)
    expect(title.turns).toEqual([{ role: "user", text: "Ask t2" }])
  })

  it("streams a reply's text and calls, a lazy tool's through call_mcp_tool", async () => {
    const { response, calls } = await handle(post(stream, conversation), {
      text: "Sending.",
      calls: [
        { name: "mcp_novadeck_novadeck_send", input: { to: "t1", text: "teal" } },
        { name: "run_command", input: { CommandLine: "sleep 1" } },
      ],
    })

    expect(calls).toHaveLength(1)
    expect(response.status).toBe(200)
    expect(response.headers["content-type"]).toBe("text/event-stream")
    const [event] = events(response.body) as {
      candidates: { content: { role: string; parts: Record<string, unknown>[] } }[]
    }[]
    const parts = event?.candidates[0]?.content.parts
    expect(parts?.[0]).toEqual({ text: "Sending." })
    expect(parts?.[1]?.functionCall).toMatchObject({
      name: "call_mcp_tool",
      args: {
        ServerName: "novadeck_novadeck",
        ToolName: "send",
        Arguments: { to: "t1", text: "teal" },
      },
    })
    expect(parts?.[2]?.functionCall).toMatchObject({
      name: "run_command",
      args: { CommandLine: "sleep 1" },
    })
  })

  it("calls an eagerly loaded tool as itself, with the summary Antigravity asks of it", async () => {
    // Now and then Antigravity loads Novadeck's tools eagerly, as tools of its own, and
    // offers no call_mcp_tool. It refuses a call to one without `toolSummary`, or with
    // `toolAction`.
    const eager = {
      ...conversation,
      contents: [
        { role: "user", parts: [{ text: "Ask t2" }] },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "call_1",
                name: "mcp_novadeck_novadeck_send",
                args: { to: "t2", text: "hello", toolSummary: "send call" },
              },
            },
          ],
        },
      ],
      systemInstruction: {
        role: "user",
        parts: [{ text: system.replace("Lazy:\nshow\nsend", "Eager:\nshow\nsend") }],
      },
      tools: [
        {
          functionDeclarations: [
            { name: "run_command" },
            { name: "mcp_novadeck_novadeck_show" },
            { name: "mcp_novadeck_novadeck_send" },
          ],
        },
      ],
    }
    const call = parse("m", eager)
    expect(call.tools).toEqual([
      "run_command",
      "mcp_novadeck_novadeck_show",
      "mcp_novadeck_novadeck_send",
    ])
    expect(tool(call, "send")).toBe("mcp_novadeck_novadeck_send")
    expect(call.turns[1]).toMatchObject({
      calls: [{ name: "mcp_novadeck_novadeck_send", input: { to: "t2", text: "hello" } }],
    })

    const { response } = await handle(post(stream, eager), {
      calls: [
        { name: "mcp_novadeck_novadeck_send", input: { to: "t1", text: "teal" } },
        { name: "run_command", input: { CommandLine: "sleep 1" } },
      ],
    })
    const [event] = events(response.body) as {
      candidates: { content: { parts: Record<string, unknown>[] } }[]
    }[]
    const parts = event?.candidates[0]?.content.parts
    expect(parts?.[0]?.functionCall).toMatchObject({
      name: "mcp_novadeck_novadeck_send",
      args: { to: "t1", text: "teal", toolSummary: "send call" },
    })
    expect(parts?.[0]?.functionCall).not.toHaveProperty("args.toolAction")
    expect(parts?.[1]?.functionCall).toMatchObject({
      name: "run_command",
      args: { CommandLine: "sleep 1" },
    })
  })

  it("answers a call that isn't streamed as one response", async () => {
    const { response } = await handle(
      post("/v1beta/models/gemini-3.1-pro-preview:generateContent", conversation),
      { text: "Done." },
    )
    expect(JSON.parse(String(response.body))).toMatchObject({
      candidates: [
        { content: { role: "model", parts: [{ text: "Done." }] }, finishReason: "STOP" },
      ],
      modelVersion: "gemini-3.1-pro-preview",
    })
  })

  it("answers no method but a model call's", async () => {
    const { response, calls } = await handle(
      post("/v1beta/models/gemini-3.1-pro-preview:countTokens", conversation),
      {},
    )
    expect(response.status).toBe(404)
    expect(calls).toEqual([])
  })

  it("words Antigravity's tool validation errors as refusals, never a tool's execution errors", () => {
    const stamp = "Created At: 2026-10-08T14:42:08+02:00\nCompleted At: 2026-10-08T14:42:08+02:00\n"
    const refused = [
      `${stamp}Encountered error in tool validation: unknown tool: "no_such_tool" — check spelling`,
      `${stamp}Encountered error in tool validation: invalid arguments: - missing property 'toolSummary'`,
    ]
    const tools = [
      `${stamp}Encountered error in tool execution: t2 has no agent Novadeck can deliver to.`,
    ]

    expect(refused.map((text) => gemini.rejection?.test(text))).toEqual([true, true])
    expect(tools.map((text) => gemini.rejection?.test(text))).toEqual([false])
  })

  it("matches the Gemini API's paths alone", () => {
    expect(gemini.matches(post(stream, {}))).toBe(true)
    expect(gemini.matches(post("/v1internal:loadCodeAssist", {}))).toBe(false)
    expect(gemini.matches(post("/v1/messages", {}))).toBe(false)
    expect(gemini.matches(post("/v1/responses", {}))).toBe(false)
  })
})
