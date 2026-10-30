import type { ChatRequest } from "@novadeck/core/conversation"

import { composerMode } from "./composer-mode"
import { context, describe, expect, it } from "./test"

const asked = (dialog: string, chat: "field" | "prompt" = "field"): ChatRequest => ({
  id: "r1",
  kind: "question",
  tool: "ask_question",
  subject: null,
  choices: [],
  subagent: false,
  answered: false,
  dialog: { type: "questions", id: dialog, chat, questions: [] },
})

describe("the chat box's mode", () => {
  const to = { request: "r1", dialog: "q1" }

  context("without a reply", () => {
    it("is a message, or a shell command for words that start with !", () => {
      expect(composerMode("hello", null, [], true)).toBe("message")
      expect(composerMode("", null, [], true)).toBe("message")
      expect(composerMode(" !git status", null, [], true)).toBe("shell")
      expect(composerMode("!", null, [], true)).toBe("shell")
    })
  })

  context("replying to a question still asked in its own field", () => {
    it("is the reply, whatever the words", () => {
      expect(composerMode("!pick X", to, [asked("q1")], true)).toBe("reply")
      expect(composerMode("", to, [asked("q1")], true)).toBe("reply")
    })
  })

  context("replying before the agent's requests are read", () => {
    it("waits for them", () => {
      expect(composerMode("pick X", to, [], false)).toBe("waiting")
    })
  })

  context("whose question went, changed, was answered or takes its words as a prompt", () => {
    it("holds the words, or is a message without any", () => {
      for (const requests of [
        [],
        [asked("q2")],
        [{ ...asked("q1"), answered: true }],
        [asked("q1", "prompt")],
      ]) {
        expect(composerMode("pick X", to, requests, true)).toBe("held")
        expect(composerMode(" ", to, requests, true)).toBe("message")
      }
    })
  })

  context("held", () => {
    it("holds its words until there are none", () => {
      expect(composerMode("!pick X", "held", [asked("q1")], true)).toBe("held")
      expect(composerMode("", "held", [], false)).toBe("message")
    })
  })
})
