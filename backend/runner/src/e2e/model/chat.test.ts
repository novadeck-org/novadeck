import { describe, expect, it } from "../../test.js"
import { chat, parse, stream } from "./chat.js"

const request = {
  model: "openai/gpt-6-luna",
  messages: [
    { role: "system", content: "You are an agent." },
    { role: "user", content: [{ type: "text", text: "Hello" }] },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "novadeck_describe", arguments: '{"title":"T"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "Described." },
  ],
  tools: [{ type: "function", function: { name: "novadeck_describe" } }],
}

describe("the chat completions dialect", () => {
  it("reads the conversation, the tools and who made the call", () => {
    const call = parse(request)
    expect(call).toMatchObject({
      api: "chat",
      model: "openai/gpt-6-luna",
      system: "You are an agent.",
      tools: ["novadeck_describe"],
      side: false,
    })
    expect(call.turns).toEqual([
      { role: "user", text: "Hello" },
      {
        role: "assistant",
        text: "",
        calls: [{ id: "c1", name: "novadeck_describe", input: { title: "T" } }],
      },
      { role: "tool", id: "c1", text: "Described." },
    ])
  })

  it("takes the title call for a side call", () => {
    const call = parse({
      model: "m",
      messages: [
        { role: "system", content: "You are a title generator. You output ONLY a title." },
      ],
    })
    expect(call.side).toBe(true)
  })

  it("streams text, then each call whole, the finish reason, the usage and DONE", () => {
    const call = parse(request)
    const chunks = stream(call, {
      text: "Hi",
      calls: [{ name: "novadeck_send", input: { to: "@a" } }],
    })
    const events = chunks.map((one) => one.replace(/^data: /, "").trim())
    expect(events.at(-1)).toBe("[DONE]")
    const parsed = events.slice(0, -1).map((one) => JSON.parse(one))
    expect(parsed[1].choices[0].delta.content).toBe("Hi")
    expect(parsed[2].choices[0].delta.tool_calls[0].function).toEqual({
      name: "novadeck_send",
      arguments: '{"to":"@a"}',
    })
    expect(parsed[3].choices[0].finish_reason).toBe("tool_calls")
    expect(parsed[4].usage.total_tokens).toBeGreaterThan(0)
  })

  it("serves the tour's provider path alone", () => {
    const at = (path: string) => ({ method: "POST", path, headers: {}, body: "" })
    expect(chat.matches(at("/tour/v1/chat/completions"))).toBe(true)
    expect(chat.matches(at("/v1/responses"))).toBe(false)
  })
})
