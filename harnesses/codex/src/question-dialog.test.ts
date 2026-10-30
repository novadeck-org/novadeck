import type { RequestAnswer } from "@novadeck/protocol"
import { describe, expect, it } from "vitest"

import {
  answer,
  choice,
  decoded,
  factsOf,
  hooks,
  keys,
  probe,
  read,
  replaced,
  screen,
  sizes,
} from "./dialogs.test-support.js"

describe("Codex's request_user_input", () => {
  const facts = factsOf("rui-default-on")
  const rows = screen("rui-default-on")
  const questions = {
    type: "questions",
    chat: "prompt",
    questions: [
      {
        id: "color",
        header: "Color",
        question: "Which color should the button be?",
        options: [
          { id: "1", label: "Blue (Recommended)", description: "The house color." },
          { id: "2", label: "Green", description: "Calmer." },
        ],
        multiSelect: false,
        text: true,
      },
    ],
  }

  it("is a question from its PreToolUse, resolved by its PostToolUse", () => {
    expect(facts).toMatchObject({ kind: "question", tool: "request_user_input" })
    const [pre, , , , post] = hooks("rui-default-on").filter(({ event }) =>
      ["PreToolUse", "PostToolUse"].includes(event),
    )
    expect(pre?.event).toBe("PreToolUse")
    const [asked] = decoded(pre!)
    const [done] = decoded(
      post ?? hooks("rui-default-on").find(({ event }) => event === "PostToolUse")!,
    )
    expect(asked).toMatchObject({
      type: "attention-requested",
      kind: "question",
      toolName: "request_user_input",
      subject: "Which color should the button be?",
      choices: ["Blue (Recommended)", "Green"],
      actor: null,
    })
    expect(done).toMatchObject({ type: "attention-resolved", outcome: "allowed" })
    expect((done as { requestId: string }).requestId).toBe(
      (asked as { requestId: string }).requestId,
    )
  })

  it("reads at both sizes: its questions and options with descriptions, and the none-of-the-above notes", () => {
    for (const size of sizes) {
      expect(read(screen("rui-default-on", size), facts)!.dialog).toEqual(questions)
    }
  })

  it("answers an option with its digit", () => {
    expect(keys(rows, facts, answer(["2"]))).toEqual([{ press: "2" }])
    expect(keys(screen("rui-default-on", "narrow"), facts, answer(["1"]))).toEqual([{ press: "1" }])
  })

  it("answers in words through the notes of 'None of the above', or of an option", () => {
    const wide = keys(rows, facts, answer([], "Red, please"))!
    expect(wide.filter((step) => "press" in step)).toEqual([
      { press: "\x1b[B" },
      { press: "\x1b[B" },
      { press: "\t" },
      { press: "\r" },
    ])
    expect(wide).toContainEqual({ type: "Red, please" })
    const option = keys(rows, facts, answer(["2"], "calmer than that"))!
    expect(option.filter((step) => "press" in step)).toEqual([
      { press: "\x1b[B" },
      { press: "\t" },
      { press: "\r" },
    ])
    expect(option).toContainEqual({ type: "calmer than that" })
    const waits = wide.filter((step) => "until" in step)
    expect(waits).toHaveLength(3)
    // It waits for the row to be highlighted, then for the notes to open, then for the words.
    const [highlight, notes] = waits as { until: (rows: readonly string[]) => boolean }[]
    expect(highlight!.until(rows)).toBe(false)
    const moved = [...rows]
    moved[moved.findIndex((r) => r.includes("1. Blue"))] =
      "    1. Blue (Recommended)  The house color."
    moved[moved.findIndex((r) => r.includes("3. None"))] =
      "  › 3. None of the above   Optionally, add details in notes (tab)"
    expect(highlight!.until(moved)).toBe(true)
    expect(notes!.until(rows)).toBe(false)
    expect(notes!.until([...moved, "  tab or esc to clear notes | enter to submit answer"])).toBe(
      true,
    )
  })

  it("takes no answer the dialog can't: none, several options, an unknown one", () => {
    expect(keys(rows, facts, answer([]))).toBeUndefined()
    expect(keys(rows, facts, answer(["1", "2"]))).toBeUndefined()
    expect(keys(rows, facts, answer(["7"]))).toBeUndefined()
    expect(
      keys(rows, facts, {
        type: "questions",
        dialog: "d",
        answers: [{ question: "other", options: ["1"] }],
      }),
    ).toBeUndefined()
    expect(keys(rows, facts, choice("1"))).toBeUndefined()
  })

  it("is answered once its question is gone, as the answer's line says", () => {
    const found = read(rows, facts)!
    expect(found.answered(rows)).toBe(false)
    expect(found.answered(screen("rui-default-on", "narrow"))).toBe(false)
    expect(found.answered(probe.scenarios["rui-default-on"]!.pressed![0]!.screen.rows)).toBe(true)
  })

  it("walks several questions, waiting for each", () => {
    const two = {
      ...facts,
      input: {
        questions: [
          ...(facts.input as { questions: unknown[] }).questions,
          {
            id: "size",
            header: "Size",
            question: "How big?",
            options: [
              { label: "S", description: "small" },
              { label: "L", description: "large" },
            ],
          },
        ],
      },
    }
    const first = replaced(rows, "Question 1/1", "Question 1/2")
    const steps = keys(first, two, {
      type: "questions",
      dialog: "d",
      answers: [
        { question: "color", options: ["2"] },
        { question: "size", options: ["1"] },
      ],
    })!
    expect(
      steps.map((step) => ("press" in step ? step.press : "until" in step ? "wait" : "type")),
    ).toEqual(["2", "wait", "1"])
    const wait = steps[1] as { until: (rows: readonly string[]) => boolean }
    expect(wait.until(first)).toBe(false)
    expect(
      wait.until([
        "  Question 2/2 (1 unanswered)",
        "  How big?",
        "  › 1. S  small",
        "    2. L  large",
        "    3. None of the above   Optionally, add details in notes (tab)",
      ]),
    ).toBe(true)
    expect(keys(first, two, answer(["1"]))).toBeUndefined()
  })
})

describe("Codex's request_user_input, as an update might change it", () => {
  const facts = factsOf("rui-default-on")
  const rows = screen("rui-default-on")

  it("is no dialog when the question's wording differs from the request's", () => {
    expect(read(replaced(rows, "Which color", "What colour"), facts)).toBeUndefined()
  })

  it("is no dialog when an option was relabelled, reordered or added", () => {
    expect(read(replaced(rows, "Green", "Teal"), facts)).toBeUndefined()
    const swapped = replaced(
      replaced(rows, "1. Blue (Recommended)  The house color.", "1. Green               Calmer."),
      "2. Green               Calmer.",
      "2. Blue (Recommended)  The house color.",
    )
    expect(read(swapped, facts)).toBeUndefined()
    const extra = [...rows]
    extra.splice(extra.length - 1, 0, "    4. Purple              Bold.")
    expect(read(extra, facts)).toBeUndefined()
    expect(read(replaced(rows, "None of the above", "Something else"), facts)).toBeUndefined()
  })

  it("is a dialog without its none-of-the-above row, taking no words", () => {
    const without = rows.filter((row) => !row.includes("None of the above"))
    const found = read(without, facts)!
    expect(found.dialog).toMatchObject({ questions: [{ text: false }] })
    expect(
      found.keys({
        type: "questions",
        dialog: "d",
        answers: [{ question: "color", options: ["1"], text: "x" }],
      }),
    ).toBeUndefined()
    expect(
      found.keys({
        type: "questions",
        dialog: "d",
        answers: [{ question: "color", options: ["1"] }],
      }),
    ).toEqual([{ press: "1" }])
  })

  it("is no dialog on another question than the first, or of another count", () => {
    expect(read(replaced(rows, "Question 1/1", "Question 2/2"), facts)).toBeUndefined()
    expect(read(replaced(rows, "Question 1/1", "Question 1/3"), facts)).toBeUndefined()
  })

  it("is no dialog while notes are open, where a digit would type", () => {
    expect(read([...rows, "  › Add notes"], facts)).toBeUndefined()
    expect(
      read([...rows, "  tab or esc to clear notes | enter to submit answer"], facts),
    ).toBeUndefined()
  })

  it("is no dialog when the request asks something it can't vouch for", () => {
    expect(read(rows, { ...facts, input: null })).toBeUndefined()
    expect(read(rows, { ...facts, input: { questions: [] } })).toBeUndefined()
    expect(
      read(rows, {
        ...facts,
        input: { questions: [{ id: "color", question: "Which color should the button be?" }] },
      }),
    ).toBeUndefined()
    expect(read(rows, { ...facts, tool: "other" })).toBeUndefined()
  })
})

describe("Codex's notes field, after the words are typed", () => {
  const facts = factsOf("rui-default-on")
  const rows = screen("rui-default-on")

  it("waits for the words in the notes row itself, not a short answer found in another row", () => {
    const steps = keys(rows, facts, {
      type: "questions",
      dialog: "d",
      answers: [{ question: "color", options: [], text: "1" }],
    })!
    const typed = steps.findIndex((step) => "type" in step)
    const wait = steps[typed + 1] as { until: (rows: readonly string[]) => boolean }
    const base = rows.filter((row) => !row.includes("tab to add notes"))
    const open = (note: string) => [
      ...base,
      `  › ${note}`,
      "",
      "  tab or esc to clear notes | enter to submit answer",
    ]
    expect(wait.until(open("Add notes"))).toBe(false)
    expect(wait.until(open("1"))).toBe(true)
    // The options' own "1." and the header's "1/1" are not the words.
    expect(wait.until(open("Add notes").map((row) => row.replace("Blue", "Blue 1")))).toBe(false)
    expect(wait.until(rows)).toBe(false)
    expect(steps.at(-1)).toEqual({ press: "\r" })
  })

  it("accepts words that wrap, by their start", () => {
    const text = "Make it a calm green with a very long description of exactly why it should be so"
    const steps = keys(rows, facts, {
      type: "questions",
      dialog: "d",
      answers: [{ question: "color", options: ["2"], text }],
    })!
    const wait = steps[steps.findIndex((step) => "type" in step) + 1] as {
      until: (rows: readonly string[]) => boolean
    }
    const base = rows.filter((row) => !row.includes("tab to add notes"))
    expect(
      wait.until([
        ...base,
        "  › Make it a calm green with a very long",
        "    description of exactly why it",
        "  tab or esc to clear notes",
      ]),
    ).toBe(true)
    expect(wait.until([...base, "  › Make it a", "  tab or esc to clear notes"])).toBe(false)
  })
})

describe("Codex's request_user_input, set aside to talk it over", () => {
  const facts = factsOf("rui-default-on")
  const rows = screen("rui-default-on")
  const chat: RequestAnswer = { type: "chat", dialog: "d", text: "Let me clarify" }
  const after = [...probe.scenarios["rui-esc-then-prompt"]!.screenAfterEsc!.rows]

  it("is offered with its words as a prompt, at both sizes", () => {
    for (const size of sizes) {
      expect(read(screen("rui-default-on", size), facts)!.dialog).toMatchObject({ chat: "prompt" })
    }
  })

  it("presses Esc alone", () => {
    expect(keys(rows, facts, chat)).toEqual([{ press: "\x1b" }])
    expect(keys(rows, facts, { type: "chat", dialog: "d" })).toEqual([{ press: "\x1b" }])
  })

  it("is answered once the turn was interrupted and the composer is back, not before", () => {
    const found = read(rows, facts)!
    expect(found.answered(after)).toBe(true)
    expect(found.answered(rows)).toBe(false)
    expect(found.answered([])).toBe(false)
  })

  it("is no dialog while notes are open, where Esc would only close them", () => {
    expect(read([...rows, "  › Add notes", "  tab or esc to clear notes"], facts)).toBeUndefined()
  })
})

const given = (...answers: { question: string; options: string[]; text?: string }[]) =>
  ({ type: "questions", dialog: "d", answers }) as RequestAnswer

const second = (a: string, b: string) => [
  "  Question 2/2 (1 unanswered)",
  "  How big?",
  `  › 1. ${a}`,
  `    2. ${b}`,
  "    3. None of the above   Optionally, add details in notes (tab)",
  "  tab to add notes | enter to submit answer",
]

describe("Codex's request_user_input with several questions, and their words", () => {
  const facts = factsOf("rui-default-on")
  const two = {
    ...facts,
    input: {
      questions: [
        ...(facts.input as { questions: unknown[] }).questions,
        {
          id: "size",
          header: "Size",
          question: "How big?",
          options: [{ label: "S" }, { label: "L" }],
        },
      ],
    },
  }
  const first = replaced(screen("rui-default-on"), "Question 1/1", "Question 1/2")

  it("takes words for the first question only, reporting text per question", () => {
    const found = read(first, two)!
    expect(found.dialog).toMatchObject({
      questions: [
        { id: "color", text: true },
        { id: "size", text: false },
      ],
    })
    expect(
      found.keys(
        given(
          { question: "color", options: [], text: "purple" },
          { question: "size", options: ["1"] },
        ),
      ),
    ).toBeDefined()
    expect(
      found.keys(
        given(
          { question: "color", options: ["1"] },
          { question: "size", options: [], text: "huge" },
        ),
      ),
    ).toBeUndefined()
    expect(
      found.keys(
        given(
          { question: "color", options: ["1"] },
          { question: "size", options: ["2"], text: "huge" },
        ),
      ),
    ).toBeUndefined()
  })

  it("waits for a later question's options as the request lists them, before its digit", () => {
    const steps = read(first, two)!.keys(
      given({ question: "color", options: ["1"] }, { question: "size", options: ["2"] }),
    )!
    const wait = steps.find((step) => "until" in step) as {
      until: (rows: readonly string[]) => boolean
    }
    expect(wait.until(second("S", "L"))).toBe(true)
    // The options swapped, or another, or an extra one: the digit would pick the wrong row.
    expect(wait.until(second("L", "S"))).toBe(false)
    expect(wait.until(second("S", "XL"))).toBe(false)
    expect(wait.until([...second("S", "L").slice(0, 5), "    4. Huge", "  tab to add notes"])).toBe(
      false,
    )
    expect(wait.until([...second("S", "L"), "  › Add notes"])).toBe(false)
  })

  it("takes no words for any question where the first has no none-of-the-above row", () => {
    const without = first.filter((row) => !row.includes("None of the above"))
    expect(read(without, two)!.dialog).toMatchObject({
      questions: [{ text: false }, { text: false }],
    })
  })
})
