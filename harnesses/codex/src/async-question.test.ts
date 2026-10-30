import type { Report } from "@novadeck/harness-core/report"
import { describe, expect, it } from "vitest"

import { hook as reported } from "./report.test-support.js"

const session = "11111111-2222-4333-8444-555555555555"
const hook = (event: string, payload: Report["payload"]) =>
  reported(event, { session_id: session, ...payload })

const input = {
  questions: [{ title: "Which color should the button be?", options: ["Blue", "Green"] }],
}
const asking = (call: string, extra: Report["payload"] = {}) => ({
  tool_name: "request_user_input_async",
  tool_use_id: call,
  tool_input: input,
  ...extra,
})

// As Codex gives it to the model (0.165.0, fixtures/ask.probe.0.165.0.json).
const replyTo = (...places: (readonly [call: string, part: number])[]): string =>
  `<send_user_message_question_reply>\n${JSON.stringify(
    places.map(([call, part]) => ({
      answer: "Green",
      question: "Which color should the button be?",
      questionItemId: JSON.stringify(["request_user_input_async", call, part]),
    })),
  )}\n</send_user_message_question_reply>`

// The reply to each call's first question.
const reply = (...calls: string[]): string => replyTo(...calls.map((call) => [call, 0] as const))

describe("Codex's async question", () => {
  it("is one detached request per call, named by the call alone", () => {
    const [request, ...rest] = hook("PreToolUse", asking("call_a"))
    expect(rest).toEqual([])
    expect(request).toMatchObject({
      type: "attention-requested",
      kind: "question",
      toolName: "request_user_input_async",
      detached: true,
      actor: null,
      subject: "Which color should the button be?",
      choices: ["Blue", "Green"],
      parts: ["Which color should the button be?"],
      input,
    })
    // A subagent's call is named the same, so the root's reply finds it.
    const [other] = hook("PreToolUse", asking("call_a", { agent_id: "sub-1" }))
    expect(other).toMatchObject({
      actor: "sub-1",
      requestId: (request as { requestId: string }).requestId,
    })
    const [second] = hook("PreToolUse", asking("call_b"))
    expect((second as { requestId: string }).requestId).not.toBe(
      (request as { requestId: string }).requestId,
    )
  })

  it("is not answered by its own PostToolUse, which comes at once", () => {
    const events = hook("PostToolUse", asking("call_a", { tool_response: '{"accepted":true}' }))
    expect(events.map(({ type }) => type)).toEqual(["tool-called"])
  })

  it("still resolves the other question tools by their PostToolUse", () => {
    const events = hook("PostToolUse", { tool_name: "request_user_input", tool_input: {} })
    expect(events.map(({ type }) => type)).toEqual(["attention-resolved", "tool-called"])
  })

  it("is settled by the reply that names its call, a turn of Codex's own", () => {
    const [request] = hook("PreToolUse", asking("call_a"))
    const events = hook("UserPromptSubmit", { turn_id: "turn-2", prompt: reply("call_a") })
    expect(events).toEqual([
      expect.objectContaining({ type: "turn-started", cause: "harness" }),
      {
        type: "attention-resolved",
        agent: "codex",
        sessionId: session,
        instance: "7",
        startedAt: 1,
        requestId: (request as { requestId: string }).requestId,
        actor: null,
        toolName: "request_user_input_async",
        loose: false,
        outcome: "settled",
        part: 0,
      },
    ])
    expect(events[0]).not.toHaveProperty("prompt")
  })

  it("answers each question a reply names, once, by its call and its place there", () => {
    const events = hook("UserPromptSubmit", {
      prompt: replyTo(["call_a", 0], ["call_b", 0], ["call_a", 1], ["call_a", 0]),
    })
    const settled = events.filter(({ type }) => type === "attention-resolved") as {
      requestId: string
      part: number
    }[]
    expect(settled.map(({ part }) => part)).toEqual([0, 0, 1])
    expect(settled[0]!.requestId).toBe(settled[2]!.requestId)
    expect(settled[0]!.requestId).not.toBe(settled[1]!.requestId)
  })

  it("names the questions a prompt quotes as Codex's answer once its turn ended", () => {
    const [plain] = hook("UserPromptSubmit", {
      prompt:
        "> Which color should the button be?\n\nPurple\n\n> What should its label say?\n\nLarge",
    })
    expect(plain).toMatchObject({
      type: "turn-started",
      cause: "prompt",
      answers: ["Which color should the button be?", "What should its label say?"],
    })
    // A quote with nothing after, or none set apart by a blank line, answers nothing.
    for (const prompt of ["> Which color should the button be?", "> a quote\nright on"])
      expect(hook("UserPromptSubmit", { prompt })[0]).not.toHaveProperty("answers")
  })

  it.each([
    ["no JSON", "<send_user_message_question_reply>\nnope\n</send_user_message_question_reply>"],
    [
      "an empty list",
      "<send_user_message_question_reply>\n[]\n</send_user_message_question_reply>",
    ],
    [
      "an item with no place",
      '<send_user_message_question_reply>\n[{"answer":"x"}]\n</send_user_message_question_reply>',
    ],
    [
      "another tool's place",
      `<send_user_message_question_reply>\n[{"questionItemId":"[\\"other\\",\\"call_a\\",0]"}]\n</send_user_message_question_reply>`,
    ],
    [
      "a place with no question's index",
      `<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"call_a\\"]"}]\n</send_user_message_question_reply>`,
    ],
    ["text around the wrapper", `Please read: ${reply("call_a")}`],
    ["an unclosed wrapper", reply("call_a").replace("</send_user_message_question_reply>", "")],
  ])("is an ordinary prompt with %s", (_, prompt) => {
    expect(hook("UserPromptSubmit", { prompt })).toEqual([
      expect.objectContaining({ type: "turn-started", cause: "prompt", prompt: prompt.trim() }),
    ])
  })
})
