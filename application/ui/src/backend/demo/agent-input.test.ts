import { describe, expect, it } from "vitest"

import type { ChatDialog, ChatRequest } from "#core/conversation"

import { readLine, shownRequest, withWords } from "./agent-input"

const request = (id: string, answered = false): ChatRequest => ({
  id,
  kind: "permission",
  tool: "Bash",
  subject: null,
  choices: [],
  subagent: false,
  dialog: null,
  answered,
})

const choices: ChatDialog = {
  type: "choices",
  id: "d1",
  title: null,
  detail: null,
  options: [
    { id: "yes", label: "Yes", text: null },
    { id: "no", label: "No, and tell it why", text: "prompt" },
  ],
}
const questions: ChatDialog = {
  type: "questions",
  id: "d2",
  chat: null,
  questions: ["q1", "q2"].map((id) => ({
    id,
    header: id,
    question: id,
    options: ["a", "b", "c"].map((option) => ({ id: option, label: option, description: null })),
    multiSelect: id === "q2",
    text: false,
  })),
}

describe("shownRequest", () => {
  it("is the oldest unanswered request, else the oldest answered", () => {
    expect(shownRequest([])).toBeUndefined()
    expect(shownRequest([request("a", true), request("b"), request("c")])?.id).toBe("b")
    expect(shownRequest([request("a", true), request("b", true)])?.id).toBe("a")
  })
})

describe("readLine", () => {
  it("answers a choices dialog by number, with the rest of the line as its words", () => {
    expect(readLine("1", choices, [])).toEqual({
      type: "answer",
      answer: { type: "choice", dialog: "d1", option: "yes" },
    })
    expect(readLine("2 use the other way", choices, [])).toEqual({
      type: "answer",
      answer: { type: "choice", dialog: "d1", option: "no", text: "use the other way" },
    })
    // An option that takes no words ignores them.
    expect(readLine("1 thanks", choices, [])).toMatchObject({
      answer: { option: "yes" },
    })
  })

  it("refuses what isn't an option of the dialog", () => {
    expect(readLine("yes", choices, [])).toEqual({ type: "note", text: "Type an option's number." })
    expect(readLine("3", choices, [])).toEqual({ type: "note", text: "No option 3." })
    expect(readLine("0", choices, [])).toEqual({ type: "note", text: "No option 0." })
  })

  it("takes questions one by one, then answers all of them", () => {
    const first = readLine("2", questions, [])
    expect(first).toEqual({ type: "next", answers: [{ question: "q1", options: ["b"] }] })
    if (first.type !== "next") throw new Error("unreachable")
    expect(readLine("1 3", questions, first.answers)).toEqual({
      type: "answer",
      answer: {
        type: "questions",
        dialog: "d2",
        answers: [
          { question: "q1", options: ["b"] },
          { question: "q2", options: ["a", "c"] },
        ],
      },
    })
  })

  it("takes one number for a single-select question", () => {
    expect(readLine("1 2", questions, [])).toEqual({ type: "note", text: "Pick one option." })
    expect(readLine("x", questions, [])).toEqual({ type: "note", text: "Type an option's number." })
  })
})

describe("withWords", () => {
  it("appends the words to the draft after a space, or stands alone", () => {
    expect(withWords("", "queued")).toBe("queued")
    expect(withWords("  ", "queued")).toBe("queued")
    expect(withWords("so far", "queued")).toBe("so far queued")
    expect(withWords("so far  ", "queued")).toBe("so far queued")
  })
})
