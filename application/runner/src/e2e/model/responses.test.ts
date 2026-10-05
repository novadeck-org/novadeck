import { readFileSync } from "node:fs"

import { describe, expect, it } from "../../test.js"
import type { Request } from "./dialect.js"
import { parse, responses } from "./responses.js"
import { latest, tool, type Call, type Reply } from "./script.js"

// Requests Codex 0.159.3 made to a loopback provider, its long texts and tool definitions
// cut short: a turn after Novadeck's prompt hook added a delivery, the model called
// `send` and a Stop hook continued it; and the title it asks for itself.
const fixture = (name: string): Request =>
  JSON.parse(readFileSync(new URL(`fixtures/codex-${name}.json`, import.meta.url), "utf8"))
const turn = fixture("turn")
const title = fixture("title")

const called = (request: Request): Call => parse(JSON.parse(request.body), request.headers)

// The events of a streamed answer, by type, with their data.
const events = (body: string | readonly string[]) =>
  [body]
    .flat()
    .join("")
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const [event = "", data = ""] = chunk.split("\n")
      return { type: event.replace(/^event: /, ""), data: JSON.parse(data.replace(/^data: /, "")) }
    })

const post = (path: string): Request => ({ method: "POST", path, headers: {}, body: "{}" })

const answer = async (request: Request, reply: (call: Call) => Reply) => {
  const response = await responses.handle(request, async (call) => reply(call))
  return { ...response, events: events(response.body) }
}

describe("responses", () => {
  it("joins the instructions and the developer messages before the conversation", () => {
    const call = called(turn)
    expect(call.api).toBe("responses")
    expect(call.model).toBe("fake-model")
    expect(call.system).toMatch(/^You are a coding agent running in the Codex CLI/)
    expect(call.system).toContain("<skills_instructions>")
  })

  it("keeps a prompt hook's context in the prompt's turn", () => {
    const [first] = called(turn).turns
    expect(first?.role).toBe("user")
    expect(first?.role === "user" && first.text).toContain("call send now")
    expect(first?.role === "user" && first.text).toContain(
      '<novadeck-messages from="t1">prompt-delivery</novadeck-messages>',
    )
  })

  it("reads the model's calls, their outputs and a Stop hook's continuation", () => {
    const call = called(turn)
    expect(call.turns.map((one) => one.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ])
    const [, asked, result, said] = call.turns
    expect(asked).toMatchObject({
      role: "assistant",
      calls: [{ name: "mcp__novadeck.send", input: { to: "t2", text: "ping" } }],
    })
    expect(result).toMatchObject({
      role: "tool",
      id: asked?.role === "assistant" ? asked.calls[0]?.id : "",
    })
    expect(result?.role === "tool" && result.text).toContain('sent {"to":"t2","text":"ping"}')
    expect(said).toMatchObject({ role: "assistant", text: "Hello from fake", calls: [] })
    expect(latest(call)).toMatch(/^<hook_prompt /)
  })

  it("names an MCP server's tools by their namespace", () => {
    const call = called(turn)
    expect(call.tools).toContain("exec_command")
    expect(call.tools).toContain("multi_agent_v1.spawn_agent")
    expect(tool(call, "send")).toBe("mcp__novadeck.send")
    expect(call.side).toBe(false)
  })

  it("tells the title Codex asks for itself from the agent's turns", () => {
    const call = called(title)
    expect(call.side).toBe(true)
    expect(call.tools).toEqual([])
    expect(latest(call)).toContain("Generate a concise, single-line task title")
  })

  it("streams text as a message that completes the response", async () => {
    const { status, headers, events: streamed } = await answer(turn, () => ({ text: "Hi there" }))
    expect(status).toBe(200)
    expect(headers["content-type"]).toBe("text/event-stream")
    expect(streamed.map((one) => one.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_item.done",
      "response.completed",
    ])
    expect(streamed[2]?.data.delta).toBe("Hi there")
    expect(streamed[3]?.data.item).toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Hi there" }],
    })
    expect(streamed[4]?.data.response.usage).toMatchObject({
      input_tokens: expect.any(Number),
      output_tokens: expect.any(Number),
      total_tokens: expect.any(Number),
    })
  })

  it("reports no rate limits unless the reply gives them", async () => {
    const { headers } = await answer(turn, () => ({ text: "Hi there" }))
    expect(Object.keys(headers).filter((name) => name.startsWith("x-codex-"))).toEqual([])
  })

  it("reports the share of its rate limits a reply says is used, as Codex reads them", async () => {
    const before = Math.floor(Date.now() / 1000)
    const { headers } = await answer(turn, () => ({
      text: "Hi there",
      limits: { usedPercent: 95 },
    }))
    expect(headers).toMatchObject({
      "x-codex-primary-used-percent": "95",
      "x-codex-primary-window-minutes": "300",
      "x-codex-secondary-used-percent": "95",
      "x-codex-secondary-window-minutes": "10080",
    })
    const resets = Number(headers["x-codex-primary-reset-at"])
    expect(resets).toBeGreaterThanOrEqual(before + 300 * 60)
    expect(resets).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 300 * 60)
  })

  it("sends a call to a namespaced tool back in its namespace", async () => {
    const { events: streamed } = await answer(turn, (call) => ({
      calls: [{ name: tool(call, "send") ?? "", input: { to: "t1", text: "pong" } }],
    }))
    const done = streamed.find((one) => one.type === "response.output_item.done")?.data.item
    expect(done).toMatchObject({
      type: "function_call",
      namespace: "mcp__novadeck",
      name: "send",
      arguments: JSON.stringify({ to: "t1", text: "pong" }),
    })
    // Replayed in the next request, as Codex does, it reads as the same call.
    const body = JSON.parse(turn.body)
    const next = parse({ ...body, input: [...body.input, done] })
    expect(next.turns.at(-1)).toMatchObject({
      role: "assistant",
      calls: [{ id: done.call_id, name: "mcp__novadeck.send", input: { to: "t1", text: "pong" } }],
    })
  })

  it("answers the featured plugins Codex asks its ChatGPT backend for with none", async () => {
    const featured: Request = {
      method: "GET",
      path: "/backend-api/plugins/featured?platform=codex",
      headers: {},
      body: "",
    }
    expect(responses.matches(featured)).toBe(true)
    expect(await responses.handle(featured, async () => ({}))).toMatchObject({
      status: 200,
      body: "[]",
    })
  })

  it("leaves other APIs' requests to their dialects", () => {
    expect(responses.matches(post("/v1/responses"))).toBe(true)
    expect(responses.matches(post("/v1/messages"))).toBe(false)
    expect(responses.matches(post("/backend-api/codex/analytics-events"))).toBe(false)
  })
})
