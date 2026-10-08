import type { ChatRequest } from "../../model/conversation"
import { context, describe, expect, it } from "../../test"
import {
  composerState,
  joinDraft,
  chatAvailable,
  chatDraftOf,
  answeringInTerminal,
  chatShown,
  keepChatDrafts,
  keepTerminalAnswers,
  noChatDrafts,
  noTerminalAnswers,
  setAnsweringInTerminal,
  setChatDraft,
} from "./mode-state"

describe("answers in the terminal", () => {
  it("are kept by session and terminal", () => {
    const on = setAnsweringInTerminal(noTerminalAnswers, "p/s", "01", true)
    expect(answeringInTerminal(on, "p/s", "01")).toBe(true)
    expect(answeringInTerminal(on, "p/s", "02")).toBe(false)
    expect(answeringInTerminal(on, "p/other", "01")).toBe(false)
    expect(setAnsweringInTerminal(on, "p/s", "01", false)).toEqual(noTerminalAnswers)
  })

  it("change nothing when already as asked", () => {
    expect(setAnsweringInTerminal(noTerminalAnswers, "p/s", "01", false)).toBe(noTerminalAnswers)
    const on = setAnsweringInTerminal(noTerminalAnswers, "p/s", "01", true)
    expect(setAnsweringInTerminal(on, "p/s", "01", true)).toBe(on)
  })

  it("keep only the terminals that still qualify", () => {
    let answers = setAnsweringInTerminal(noTerminalAnswers, "p/s", "01", true)
    answers = setAnsweringInTerminal(answers, "p/s", "02", true)
    expect(keepTerminalAnswers(answers, (_, id) => id === "02")).toEqual({ "p/s": { "02": true } })
    expect(keepTerminalAnswers(answers, () => true)).toBe(answers)
  })

  context("for a terminal", () => {
    const terminal = { id: "01", name: "t", directory: "/", command: "zsh", process: "claude" }
    it("is available while an agent runs in it", () => {
      expect(chatAvailable({ ...terminal, state: "running", agent: { working: false } })).toBe(true)
      expect(chatAvailable({ ...terminal, process: "zsh", state: "running" })).toBe(false)
      // Antigravity reports nothing, but its program says an agent runs.
      expect(chatAvailable({ ...terminal, process: "agy", state: "running" })).toBe(true)
      expect(chatAvailable({ ...terminal, state: "idle" })).toBe(false)
    })

    it("shows its chat with the chat view on, unless the person answers in the terminal", () => {
      const running = { ...terminal, state: "running" as const, agent: { working: false } }
      const answering = setAnsweringInTerminal(noTerminalAnswers, "p/s", "01", true)
      expect(chatShown(true, noTerminalAnswers, "p/s", running)).toBe(true)
      expect(chatShown(false, noTerminalAnswers, "p/s", running)).toBe(false)
      expect(chatShown(true, answering, "p/s", running)).toBe(false)
      expect(chatShown(true, noTerminalAnswers, "p/s", { ...terminal, state: "idle" })).toBe(false)
    })
  })
})

describe("chat drafts", () => {
  it("are kept by session and terminal, and an empty one is dropped", () => {
    const kept = setChatDraft(noChatDrafts, "p/s", "01", "half a thought")
    expect(chatDraftOf(kept, "p/s", "01")).toBe("half a thought")
    expect(chatDraftOf(kept, "p/s", "02")).toBe("")
    expect(setChatDraft(kept, "p/s", "01", "")).toEqual({})
    expect(setChatDraft(noChatDrafts, "p/s", "01", "")).toBe(noChatDrafts)
  })

  it("go with the terminals that no longer show a chat", () => {
    const kept = setChatDraft(setChatDraft(noChatDrafts, "p/s", "01", "a"), "p/s", "02", "b")
    expect(keepChatDrafts(kept, (_, id) => id === "02")).toEqual({ "p/s": { "02": "b" } })
  })
})

describe("words joined to a draft", () => {
  it("go on a line after it, or are all there is", () => {
    expect(joinDraft("meanwhile", "use pnpm")).toBe("meanwhile\nuse pnpm")
    expect(joinDraft("  ", "use pnpm")).toBe("use pnpm")
    expect(joinDraft("go", "")).toBe("go")
  })

  it("go before a shell command, never becoming more of its lines", () => {
    expect(joinDraft("!npm test", "also the changelog")).toBe("also the changelog\n!npm test")
  })

  it("make one command of two shell commands, the second without its !", () => {
    expect(joinDraft("!npm test", " ! ls")).toBe("!npm test\nls")
  })
})

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
      expect(composerState("hello", null, [], true)).toBe("message")
      expect(composerState("", null, [], true)).toBe("message")
      expect(composerState(" !git status", null, [], true)).toBe("shell")
      expect(composerState("!", null, [], true)).toBe("shell")
    })
  })

  context("replying to a question still asked in its own field", () => {
    it("is the reply, whatever the words", () => {
      expect(composerState("!pick X", to, [asked("q1")], true)).toBe("reply")
      expect(composerState("", to, [asked("q1")], true)).toBe("reply")
    })
  })

  context("replying before the agent's requests are read", () => {
    it("waits for them", () => {
      expect(composerState("pick X", to, [], false)).toBe("waiting")
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
        expect(composerState("pick X", to, requests, true)).toBe("held")
        expect(composerState(" ", to, requests, true)).toBe("message")
      }
    })
  })

  context("held", () => {
    it("holds its words until there are none", () => {
      expect(composerState("!pick X", "held", [asked("q1")], true)).toBe("held")
      expect(composerState("", "held", [], false)).toBe("message")
    })
  })
})
