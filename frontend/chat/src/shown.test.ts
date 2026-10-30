import {
  answeringInTerminal,
  chatAvailable,
  chatShown,
  keepTerminalAnswers,
  noTerminalAnswers,
  setAnsweringInTerminal,
} from "./shown"
import { context, describe, expect, it } from "./test"

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
