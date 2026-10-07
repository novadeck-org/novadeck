import { describe, expect, it } from "vitest"

import type { ChatQuestion } from "../../model/conversation"
import {
  answered,
  answeredCount,
  chatAnswer,
  holdsControls,
  oneLine,
  wordsOf,
  choiceAnswer,
  choose,
  complete,
  questionsAnswer,
  reconcile,
  write,
  type Picks,
} from "./answers"

const question = (overrides: Partial<ChatQuestion> = {}): ChatQuestion => ({
  id: "q1",
  header: null,
  question: "Which runner?",
  options: [
    { id: "a", label: "Vitest", description: null },
    { id: "b", label: "Jest", description: null },
    { id: "c", label: "Mocha", description: null },
  ],
  multiSelect: false,
  text: true,
  ...overrides,
})

describe("A single-select question", () => {
  it("takes one option at a time", () => {
    const one = question()
    const picks = choose(choose({}, one, "a"), one, "b")
    expect(picks.q1?.options).toEqual(["b"])
  })

  it("lets the person's words replace the option, and an option the words", () => {
    const one = question()
    const written = write(choose({}, one, "a"), one, "Something else")
    expect(written.q1).toEqual({ options: [], text: "Something else" })
    expect(choose(written, one, "c").q1).toEqual({ options: ["c"], text: "" })
  })
})

describe("A multi-select question", () => {
  it("toggles options and keeps the words beside them", () => {
    const many = question({ multiSelect: true })
    let picks: Picks = choose(choose({}, many, "a"), many, "c")
    picks = write(picks, many, "and more")
    expect(picks.q1).toEqual({ options: ["a", "c"], text: "and more" })
    expect(choose(picks, many, "a").q1?.options).toEqual(["c"])
  })
})

describe("Whether a form can be submitted", () => {
  const first = question()
  const second = question({ id: "q2", text: false })

  it("waits until each question has an answer", () => {
    let picks: Picks = choose({}, first, "a")
    expect(answered(picks, first)).toBe(true)
    expect(answered(picks, second)).toBe(false)
    expect(answeredCount(picks, [first, second])).toBe(1)
    expect(complete(picks, [first, second])).toBe(false)
    picks = choose(picks, second, "b")
    expect(complete(picks, [first, second])).toBe(true)
  })

  it("counts words as an answer only where the question takes them", () => {
    expect(answered(write({}, first, "  "), first)).toBe(false)
    expect(answered(write({}, first, "mine"), first)).toBe(true)
    expect(answered(write({}, second, "mine"), second)).toBe(false)
  })
})

describe("The answer a form makes", () => {
  it("lists options in the dialog's order and trims the words", () => {
    const many = question({ multiSelect: true })
    const other = question({ id: "q2", text: false })
    let picks: Picks = choose(choose({}, many, "c"), many, "a")
    picks = write(picks, many, "  also Bun ")
    picks = choose(picks, other, "b")
    expect(questionsAnswer("d1", picks, [many, other])).toEqual({
      type: "questions",
      dialog: "d1",
      answers: [
        { question: "q1", options: ["a", "c"], text: "also Bun" },
        { question: "q2", options: ["b"] },
      ],
    })
  })

  it("leaves out words a question doesn't take", () => {
    const closed = question({ text: false })
    const picks = { q1: { options: ["a"], text: "stale" } }
    expect(questionsAnswer("d1", picks, [closed])).toEqual({
      type: "questions",
      dialog: "d1",
      answers: [{ question: "q1", options: ["a"] }],
    })
  })

  it("sends a choice with its words trimmed, or without when blank", () => {
    expect(choiceAnswer("d1", "no", " use pnpm ")).toEqual({
      type: "choice",
      dialog: "d1",
      option: "no",
      text: "use pnpm",
    })
    expect(choiceAnswer("d1", "no", "  ")).toEqual({ type: "choice", dialog: "d1", option: "no" })
    expect(choiceAnswer("d1", "yes")).toEqual({ type: "choice", dialog: "d1", option: "yes" })
  })
})

describe("A dialog that was read again", () => {
  it("drops the picks that no longer exist and keeps the words", () => {
    const before = question({ multiSelect: true })
    const picks = write(choose(choose({}, before, "a"), before, "c"), before, "mine")
    const after = question({
      multiSelect: true,
      options: [{ id: "c", label: "Mocha", description: null }],
    })
    expect(reconcile(picks, [after]).q1).toEqual({ options: ["c"], text: "mine" })
  })
})

describe("Chatting about the questions instead", () => {
  it("sends the trimmed words, or none", () => {
    expect(chatAnswer("d1", " what is this? ")).toEqual({
      type: "chat",
      dialog: "d1",
      text: "what is this?",
    })
    expect(chatAnswer("d1", " ")).toEqual({ type: "chat", dialog: "d1" })
  })
})

describe("Words for a field that takes one line", () => {
  it("turns pasted newlines and tabs into spaces", () => {
    expect(oneLine("a\nb\r\n\tc")).toBe("a b c")
  })

  it("names the words an answer carries to the agent", () => {
    expect(wordsOf(choiceAnswer("d", "o", "hi"))).toBe("hi")
    expect(wordsOf(chatAnswer("d", "hello"))).toBe("hello")
    expect(wordsOf(chatAnswer("d", ""))).toBe("")
  })
})

describe("Words with control characters", () => {
  it("are held back for questions that take them, and only those", () => {
    const open = question()
    const closed = question({ id: "q2", text: false })
    expect(holdsControls(write({}, open, "log \u001b[31mred"), [open])).toBe(true)
    expect(holdsControls(write({}, open, "plain"), [open])).toBe(false)
    expect(holdsControls({ q2: { options: [], text: "\u001b" } }, [closed])).toBe(false)
  })
})
