import { explain } from "@novadeck/harness-core/dialogs"
import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"
import {
  readOn,
  chat,
  colours,
  questionFacts,
  questionsAnswer,
  read,
  rowsOf,
  sent,
  waits,
} from "./dialogs.test-support.js"

const size = { question: "Which size?", header: "Size" }
const sizes = ["Small", "Large"]
const one = questionFacts(colours())
const two = questionFacts(colours("Colour", ["Red", "Blue"]), colours("Size", sizes, size))
const toppings = questionFacts(
  colours("Toppings", ["Ham", "Cheese", "Olives"], { multiple: true, question: "Which toppings?" }),
)

// Probed 2026-11-22, 1.19.6 (fixtures/dialogs.probe.json): the `question` tool's dialog alone,
// with several questions, as a multi-select, with its own answer's field open, and at 60x20.
describe("opencode's question dialog for one question", () => {
  it("reads the question, its options with their descriptions, and the own answer it adds", () => {
    expect(read(rowsOf("qOne"), one).dialog).toEqual({
      type: "questions",
      chat: null,
      questions: [
        {
          id: "1",
          header: "Colour",
          question: "Which colour?",
          options: [
            { id: "1", label: "Red", description: "about red" },
            { id: "2", label: "Blue", description: "about blue" },
            { id: "3", label: "Green", description: "about green" },
          ],
          multiSelect: false,
          text: true,
        },
      ],
    })
  })

  it("answers with its option's digit, which picks and submits at once", () => {
    const found = read(rowsOf("qOne"), one)
    expect(sent(found.keys(questionsAnswer({ question: "1", options: ["2"] })))).toEqual(["2"])
    expect(sent(found.keys(questionsAnswer({ question: "1", options: ["3"] })))).toEqual(["3"])
  })

  it("answers in words with the own answer's digit, its field open, the words typed and seen", () => {
    const found = read(rowsOf("qOne"), one)
    const steps = found.keys(questionsAnswer({ question: "1", options: [], text: "purple" }))
    expect(sent(steps)).toEqual(["4", '"purple"', "\r"])
    const [open, typed] = waits(steps)!
    expect(open!(rowsOf("qOneOwn"))).toBe(true)
    expect(open!(rowsOf("qOne"))).toBe(false)
    expect(typed!(rowsOf("qOneTyped"))).toBe(true)
    expect(typed!(rowsOf("qOneOwn"))).toBe(false)
  })

  it("reads a dialog with its field open, and answers nothing there", () => {
    const found = read(rowsOf("qOneOwn"), one)
    expect(found.dialog).toMatchObject({ type: "questions" })
    expect(found.keys(questionsAnswer({ question: "1", options: ["1"] }))).toBeUndefined()
  })

  it("takes no answer it can't give: another option, two, none, words with an option", () => {
    const found = read(rowsOf("qOne"), one)
    for (const answer of [
      questionsAnswer({ question: "1", options: ["4"] }),
      questionsAnswer({ question: "1", options: ["1", "2"] }),
      questionsAnswer({ question: "1", options: [] }),
      questionsAnswer({ question: "1", options: ["1"], text: "words" }),
      questionsAnswer({ question: "2", options: ["1"] }),
      chat("let's talk"),
    ])
      expect(found.keys(answer)).toBeUndefined()
  })

  it("is answered once it is gone, or another dialog took its place", () => {
    const found = read(rowsOf("qOne"), one)
    expect(found.answered(rowsOf("qOne"))).toBe(false)
    expect(found.answered(rowsOf("qOneTyped"))).toBe(false)
    expect(found.answered(rowsOf("models60"))).toBe(true)
    expect(found.answered(rowsOf("qMulti"))).toBe(true)
  })

  it("reads on 60 columns", () => {
    expect(read(rowsOf("qOne60"), one).dialog).toMatchObject({ questions: [{ text: true }] })
  })

  it("offers the own answer whatever the call says, as its tool schema takes no such field", () => {
    // `custom: false` never reached its event (probed 2026-11-22, 1.19.6, `qNoCustom`: the
    // dialog still showed it); a call that did carry one is not one this was probed for.
    const nothing = questionFacts(colours("Colour", ["Red", "Blue"], { custom: false }))
    expect(readOn(rowsOf("qNoCustom"), nothing)).toBeUndefined()
    const plain = questionFacts(colours("Colour", ["Red", "Blue"]))
    expect(read(rowsOf("qNoCustom"), plain).dialog).toMatchObject({ questions: [{ text: true }] })
  })

  it("reads a long question and long options as wrapped on 60 columns", () => {
    const long = questionFacts({
      question:
        "A long question that goes on and on and on, wrapping over several rows on a narrow screen, asking which colour?",
      header: "Colour",
      options: [
        {
          label: "Red with a long label that is very long indeed",
          description:
            "a long description that also wraps around when it is long enough to need it",
        },
        { label: "Blue", description: "cool" },
      ],
    })
    expect(read(rowsOf("qLong60"), long).dialog).toMatchObject({
      questions: [{ options: [{}, {}] }],
    })
  })

  it("does not read it for other questions or other options", () => {
    expect(
      readOn(rowsOf("qOne"), questionFacts(colours("Colour", ["Red", "Blue"]))),
    ).toBeUndefined()
    expect(
      readOn(rowsOf("qOne"), questionFacts(colours("Colour", ["Red", "Blue", "Teal"]))),
    ).toBeUndefined()
    expect(
      dialogs.read(
        rowsOf("qOne"),
        questionFacts(colours("Colour", ["Red", "Blue", "Green"], { question: "Which shade?" })),
      ),
    ).toBeUndefined()
    expect(
      dialogs.read(
        rowsOf("qOne"),
        questionFacts(colours("Colour", ["Red", "Blue", "Green"], { multiple: true })),
      ),
    ).toBeUndefined()
    expect(readOn(rowsOf("qOne"), { ...one, input: { questions: "no" } })).toBeUndefined()
  })

  it("says where it stopped reading", () => {
    const { result, refusals } = explain(() =>
      readOn(rowsOf("qOne"), questionFacts(colours("Colour", ["Red", "Blue"]))),
    )
    expect(result).toBeUndefined()
    expect(refusals).toContain("question.stateOf.8")
  })
})

describe("opencode's question dialog for several questions", () => {
  it("reads the tabs, whichever question or the review it shows", () => {
    for (const name of [
      "qTwo",
      "qTwoSecond",
      "qTwoReview",
      "qTwoAfterFirst",
      "qTwoReviewAnswered",
      "qTwoOwn",
      "qTwo60",
    ])
      expect(read(rowsOf(name), two).dialog, name).toMatchObject({
        questions: [{ header: "Colour" }, { header: "Size" }],
      })
  })

  it("answers each with its digit, waits for the next, and submits at the review with Enter", () => {
    const found = read(rowsOf("qTwo"), two)
    const steps = found.keys(
      questionsAnswer({ question: "1", options: ["1"] }, { question: "2", options: ["2"] }),
    )
    expect(sent(steps)).toEqual(["1", "2", "\r"])
    const [second, review] = waits(steps)!
    expect(second!(rowsOf("qTwoAfterFirst"))).toBe(true)
    expect(second!(rowsOf("qTwo"))).toBe(false)
    expect(review!(rowsOf("qTwoReviewAnswered"))).toBe(true)
    expect(review!(rowsOf("qTwoAfterFirst"))).toBe(false)
  })

  it("answers in words, which move on as an option does", () => {
    const found = read(rowsOf("qTwo"), two)
    const steps = found.keys(
      questionsAnswer(
        { question: "1", options: [], text: "purple" },
        { question: "2", options: ["1"] },
      ),
    )
    expect(sent(steps)).toEqual(["3", '"purple"', "\r", "1", "\r"])
    const [open, typed] = waits(steps)!
    expect(open!(rowsOf("qTwo"))).toBe(false)
    expect(open!(rowsOf("qTwoOwn"))).toBe(true)
    expect(typed!(rowsOf("qTwoOwnTyped"))).toBe(true)
    expect(typed!(rowsOf("qTwoOwn"))).toBe(false)
  })

  it("has no keys from a question the person took it to, or the review", () => {
    for (const name of ["qTwoSecond", "qTwoReview", "qTwoOwn"])
      expect(
        read(rowsOf(name), two).keys(
          questionsAnswer({ question: "1", options: ["1"] }, { question: "2", options: ["1"] }),
        ),
        name,
      ).toBeUndefined()
  })

  it("wants an answer to every question", () => {
    expect(
      read(rowsOf("qTwo"), two).keys(questionsAnswer({ question: "1", options: ["1"] })),
    ).toBeUndefined()
  })

  it("does not read it where the tabs or the questions differ", () => {
    const other = questionFacts(colours("Colour", ["Red", "Blue"]), colours("Sizes", sizes, size))
    expect(readOn(rowsOf("qTwo"), other)).toBeUndefined()
    expect(readOn(rowsOf("qTwo"), one)).toBeUndefined()
  })
})

describe("opencode's question dialog for a multi-select", () => {
  it("reads it, its question ending `(select all that apply)` and its rows with boxes", () => {
    expect(read(rowsOf("qMulti"), toppings).dialog).toMatchObject({
      questions: [{ question: "Which toppings?", multiSelect: true, text: true }],
    })
    expect(
      dialogs.read(
        rowsOf("qMulti"),
        questionFacts(
          colours("Toppings", ["Ham", "Cheese", "Olives"], { question: "Which toppings?" }),
        ),
      ),
    ).toBeUndefined()
  })

  it("toggles each option by its digit, seen checked, then Tab to the review and Enter", () => {
    const found = read(rowsOf("qMulti"), toppings)
    const steps = found.keys(questionsAnswer({ question: "1", options: ["3", "1"] }))
    expect(sent(steps)).toEqual(["1", "3", "\t", "\r"])
    const [ham, olives, review] = waits(steps)!
    expect(ham!(rowsOf("qMultiChecked"))).toBe(true)
    expect(ham!(rowsOf("qMulti"))).toBe(false)
    expect(olives!(rowsOf("qMultiChecked"))).toBe(true)
    expect(review!(rowsOf("qMultiReview"))).toBe(true)
  })

  it("adds an own answer of its words, its row seen checked after", () => {
    const found = read(rowsOf("qMulti"), toppings)
    const steps = found.keys(questionsAnswer({ question: "1", options: ["2"], text: "kiwi" }))
    expect(sent(steps)).toEqual(["2", "4", '"kiwi"', "\r", "\t", "\r"])
    const checkedOwn = waits(steps)!.at(-2)!
    expect(checkedOwn(rowsOf("qMultiOwnChecked"))).toBe(true)
    expect(checkedOwn(rowsOf("qMultiOwn"))).toBe(false)
  })

  it("has no answer of no option at all", () => {
    expect(
      read(rowsOf("qMulti"), toppings).keys(questionsAnswer({ question: "1", options: [] })),
    ).toBeUndefined()
  })

  it("is no start with an option checked", () => {
    expect(
      read(rowsOf("qMultiChecked"), toppings).keys(
        questionsAnswer({ question: "1", options: ["2"] }),
      ),
    ).toBeUndefined()
  })
})

// Plan mode's review: `plan_exit` asks, with `custom: false`, whether to switch to the build agent
// (probed 2026-11-22, 1.19.6, `qPlan`): Yes and No, no own-answer row. Yes switches the agent to
// build and sends the plan as approved; No stays in plan.
describe("opencode's plan review", () => {
  const review = {
    kind: "plan" as const,
    tool: "plan_exit",
    cwd: null,
    input: {
      questions: [
        {
          question:
            "Plan at plans/x.md is complete. Would you like to switch to the build agent and start implementing?",
          header: "Build Agent",
          custom: false,
          options: [
            { label: "Yes", description: "Switch to build agent and start implementing the plan" },
            { label: "No", description: "Stay with plan agent to continue refining the plan" },
          ],
        },
      ],
    },
  }

  it("reads as a question with no own answer, answered by its digits", () => {
    const found = read(rowsOf("qPlan"), review)
    expect(found.dialog).toMatchObject({
      type: "questions",
      questions: [
        { header: "Build Agent", text: false, options: [{ label: "Yes" }, { label: "No" }] },
      ],
    })
    expect(sent(found.keys(questionsAnswer({ question: "1", options: ["1"] })))).toEqual(["1"])
    expect(sent(found.keys(questionsAnswer({ question: "1", options: ["2"] })))).toEqual(["2"])
  })

  it("takes no words, and no option beyond its two", () => {
    const found = read(rowsOf("qPlan"), review)
    expect(
      found.keys(questionsAnswer({ question: "1", options: [], text: "later" })),
    ).toBeUndefined()
    expect(found.keys(questionsAnswer({ question: "1", options: ["3"] }))).toBeUndefined()
  })

  it("is not read for a question that offers its own answer, nor for another plan request", () => {
    const own = {
      ...review,
      input: { questions: [{ ...review.input.questions[0]!, custom: undefined }] },
    }
    expect(dialogs.read(rowsOf("qPlan"), own)).toBeUndefined()
    expect(dialogs.read(rowsOf("qPlan"), { ...review, tool: "ExitPlanMode" })).toBeUndefined()
    expect(dialogs.read(rowsOf("qOne"), review)).toBeUndefined()
  })
})
