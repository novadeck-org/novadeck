import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"
import {
  ask,
  asking,
  chat,
  choice,
  colour,
  colours,
  command,
  gone,
  permission,
  question,
  questions,
  read,
  run,
  same,
  sent,
  waits,
  without,
} from "./dialogs.test-support.js"

describe("Antigravity's ask_question", () => {
  it("is read at both sizes: one single-select, its Write-in a field", () => {
    for (const screen of [ask.pending.screen120!.rows, ask.pending.screen60!.rows]) {
      const found = read(screen, question(colour))
      expect(found.dialog).toEqual({
        type: "questions",
        questions: [
          {
            id: "1",
            header: null,
            question: "Which colour?",
            options: [
              { id: "1", label: "Red", description: null },
              { id: "2", label: "Green", description: null },
              { id: "3", label: "Blue", description: null },
            ],
            multiSelect: false,
            text: true,
          },
        ],
        chat: "field",
      })
    }
  })

  it("sets the question aside to talk it over: its words, prefixed, through Write-in", () => {
    const found = read(ask.pending.screen120!.rows, question(colour))
    const steps = found.keys(chat("is Red accessible?"))
    expect(sent(steps)).toEqual([
      "\x1b[B",
      "\x1b[B",
      "\x1b[B",
      "\r",
      `"Let's discuss this first: is Red accessible?"`,
      "\r",
    ])
    const [, field, typedIn] = waits(steps)!
    expect(field!(ask.writeIn.rows)).toBe(true)
    const typed = ask.writeIn.rows.flatMap((row) =>
      row === "  Your answer:" ? [row, "  Let's discuss this first: is Red accessible?"] : [row],
    )
    expect(typedIn!(typed)).toBe(true)
    expect(typedIn!(ask.writeIn.rows)).toBe(false)
    // Words are needed, and plain.
    expect(found.keys(chat())).toBeUndefined()
    expect(found.keys(chat("a\nb"))).toBeUndefined()
    expect(found.keys(chat("  "))).toBeUndefined()
    // Not where Write-in isn't offered: several questions, a multi-select.
    const two = asking(colours(["Red", "Green"]), {
      question: "Which size?",
      options: ["Small", "Large"],
      is_multi_select: false,
    })
    const several = read(ask.twoQuestions.q1!.rows, question(two))
    expect(several.dialog).toMatchObject({ chat: null })
    expect(several.keys(chat("hm"))).toBeUndefined()
    const multi = read(
      ask.multiSelect.screen!.rows,
      question(asking(colours(["Red", "Green", "Blue"], true))),
    )
    expect(multi.dialog).toMatchObject({ chat: null })
    expect(multi.keys(chat("hm"))).toBeUndefined()
    // Nor from a state that isn't the start.
    const moved = ask.pending.screen120!.rows.map((row) =>
      row.replace(/^> 1\. /, "  1. ").replace(/^ {2}2\. /, "> 2. "),
    )
    expect(read(moved, question(colour)).keys(chat("hm"))).toBeUndefined()
  })

  it("picks an option with Down and Enter, waiting for the highlight to land", () => {
    const found = read(ask.pending.screen120!.rows, question(colour))
    const first = found.keys(questions({ question: "1", options: ["1"] }))
    expect(sent(first)).toEqual(["\r"])
    const third = found.keys(questions({ question: "1", options: ["3"] }))
    expect(sent(third)).toEqual(["\x1b[B", "\x1b[B", "\r"])
    // It waits for the third row to be marked, and for nothing else.
    const [until] = waits(third)!
    expect(until!(ask.pending.screen120!.rows)).toBe(false)
    const moved = ask.pending.screen120!.rows.map((row) =>
      row.replace(/^> 1\. /, "  1. ").replace(/^ {2}3\. /, "> 3. "),
    )
    expect(until!(moved)).toBe(true)
    expect(until!(ask.writeIn.rows)).toBe(false)
  })

  it("types its own words into Write-in: Down to it, Enter, wait for the field, type, Enter", () => {
    const found = read(ask.pending.screen120!.rows, question(colour))
    const steps = found.keys(questions({ question: "1", options: [], text: "Purple" }))
    expect(sent(steps)).toEqual(["\x1b[B", "\x1b[B", "\x1b[B", "\r", '"Purple"', "\r"])
    const [lands, field] = waits(steps)!
    const fourth = ask.pending.screen120!.rows.map((row) =>
      row.replace(/^> 1\. /, "  1. ").replace(/^ {2}4\. /, "> 4. "),
    )
    expect(lands!(fourth)).toBe(true)
    // Enter only follows its words showing in the field's own row.
    const [, , typedIn] = waits(steps)!
    const typed = ask.writeIn.rows
      .map((row) => (row === "  Your answer:" ? "  Your answer:\n  Purple" : row))
      .flatMap((row) => row.split("\n"))
    expect(typedIn!(ask.writeIn.rows)).toBe(false)
    expect(typedIn!(typed)).toBe(true)
    expect(typedIn!([...ask.writeIn.rows, "Purple"])).toBe(false)
    expect(lands!(ask.pending.screen120!.rows)).toBe(false)
    expect(field!(ask.writeIn.rows)).toBe(true)
    expect(field!(ask.pending.screen120!.rows)).toBe(false)
    // Options and words together, or words with a line break, are not an answer.
    expect(found.keys(questions({ question: "1", options: ["1"], text: "x" }))).toBeUndefined()
    expect(found.keys(questions({ question: "1", options: [], text: "a\nb" }))).toBeUndefined()
    expect(found.keys(questions({ question: "1", options: [] }))).toBeUndefined()
  })

  it("reads each state the keys pass through as the same dialog, with no keys of its own", () => {
    const found = read(ask.pending.screen120!.rows, question(colour))
    const moved = ask.pending.screen120!.rows.map((row) =>
      row.replace(/^> 1\. /, "  1. ").replace(/^ {2}2\. /, "> 2. "),
    )
    for (const state of [moved, ask.writeIn.rows]) {
      const now = read(state, question(colour))
      expect(now.dialog).toEqual(found.dialog)
      expect(now.keys(questions({ question: "1", options: ["1"] }))).toBeUndefined()
    }
    // A write-in field with its keys gone, or a footer of none, is not read.
    expect(
      dialogs.read(without(ask.writeIn.rows, /enter Submit/), question(colour)),
    ).toBeUndefined()
  })

  it("refuses answers that don't fit its questions", () => {
    const found = read(ask.pending.screen120!.rows, question(colour))
    expect(found.keys(questions({ question: "1", options: ["4"] }))).toBeUndefined()
    expect(found.keys(questions({ question: "1", options: ["1", "2"] }))).toBeUndefined()
    expect(found.keys(questions({ question: "2", options: ["1"] }))).toBeUndefined()
    expect(
      found.keys(questions({ question: "1", options: ["1"] }, { question: "2", options: ["1"] })),
    ).toBeUndefined()
    expect(found.keys(choice("1"))).toBeUndefined()
  })

  it("toggles a multi-select's options by digit, each seen checked, then submits", () => {
    const request = question(asking(colours(["Red", "Green", "Blue"], true)))
    const found = read(ask.multiSelect.screen!.rows, request)
    expect(found.dialog).toMatchObject({
      questions: [{ multiSelect: true, text: false, options: [{ label: "Red" }, {}, {}] }],
    })
    const steps = found.keys(questions({ question: "1", options: ["3", "1"] }))
    expect(sent(steps)).toEqual(["1", "3", "\r"])
    const [first, third] = waits(steps)!
    const checked = (number: number) =>
      ask.multiSelect.screen!.rows.map((row) => row.replace(`${number}. [ ]`, `${number}. [x]`))
    expect(first!(ask.multiSelect.screen!.rows)).toBe(false)
    expect(first!(checked(1))).toBe(true)
    expect(third!(checked(1))).toBe(false)
    expect(third!(checked(3))).toBe(true)
    // None, or words (not probed beside toggles), is not an answer.
    expect(found.keys(questions({ question: "1", options: [] }))).toBeUndefined()
    expect(found.keys(questions({ question: "1", options: ["1"], text: "x" }))).toBeUndefined()
    // One already toggled is the same dialog, but no start the keys assume.
    const toggled = read(checked(2), request)
    expect(toggled.dialog).toEqual(found.dialog)
    expect(toggled.keys(questions({ question: "1", options: ["1"] }))).toBeUndefined()
  })

  it("answers several questions in turn, waiting for each next", () => {
    const two = asking(colours(["Red", "Green"]), {
      question: "Which size?",
      options: ["Small", "Large"],
      is_multi_select: false,
    })
    const found = read(ask.twoQuestions.q1!.rows, question(two))
    expect(found.dialog).toMatchObject({
      questions: [
        { id: "1", question: "Which colour?", text: false },
        { id: "2", question: "Which size?", text: false },
      ],
    })
    const steps = found.keys(
      questions({ question: "1", options: ["2"] }, { question: "2", options: ["2"] }),
    )
    expect(sent(steps)).toEqual(["\x1b[B", "\r", "\x1b[B", "\r"])
    const [one, next, two2] = waits(steps)!
    // The next question must show with its own text and options, not only its number.
    const otherText = ask.twoQuestions.q2!.rows.map((row) =>
      row.replace("Which size?", "Which shape?"),
    )
    const otherOptions = ask.twoQuestions.q2!.rows.map((row) => row.replace("Large", "Huge"))
    expect(next!(otherText)).toBe(false)
    expect(next!(otherOptions)).toBe(false)
    // Nor with the highlight not back on its first option, which the Downs count from.
    const unmarked = ask.twoQuestions.q2!.rows.map((row) =>
      row.replace(/^> 1\. /, "  1. ").replace(/^ {2}2\. /, "> 2. "),
    )
    expect(next!(unmarked)).toBe(false)
    expect(
      one!(
        ask.twoQuestions.q1!.rows.map((row) =>
          row.replace(/^> 1\. /, "  1. ").replace(/^ {2}2\. /, "> 2. "),
        ),
      ),
    ).toBe(true)
    expect(next!(ask.twoQuestions.q1!.rows)).toBe(false)
    expect(next!(ask.twoQuestions.q2!.rows)).toBe(true)
    expect(two2!(ask.twoQuestions.q2!.rows)).toBe(false)
    // Words, with several questions, are not probed.
    expect(
      found.keys(
        questions({ question: "1", options: [], text: "x" }, { question: "2", options: ["1"] }),
      ),
    ).toBeUndefined()
    // Its second question is the same dialog, but isn't where an answer starts.
    const later = read(ask.twoQuestions.q2!.rows, question(two))
    expect(later.dialog).toEqual(found.dialog)
    expect(
      later.keys(questions({ question: "1", options: ["1"] }, { question: "2", options: ["1"] })),
    ).toBeUndefined()
  })

  it("is answered once no question of it shows, and not while its field is open", () => {
    const found = read(ask.pending.screen120!.rows, question(colour))
    expect(found.answered(ask.pending.screen120!.rows)).toBe(false)
    expect(found.answered(ask.pending.screen60!.rows)).toBe(false)
    expect(found.answered(ask.writeIn.rows)).toBe(false)
    for (const screen of [gone.ask!.rows, gone.writeIn!.rows, gone.two!.rows])
      expect(found.answered(screen)).toBe(true)
    // The call's other questions are its own dialog, and so is another question.
    const other = same(
      ask.pending.screen120!.rows,
      "Question 1/1: Which colour?",
      "Question 1/1: Which shape?",
    )
    expect(found.answered(other)).toBe(true)
  })

  it("agrees with the call's questions and options, or is none", () => {
    const screen = ask.pending.screen120!.rows
    expect(dialogs.read(screen, question(undefined))).toBeUndefined()
    expect(dialogs.read(screen, question(asking(colours(["Red", "Green"]))))).toBeUndefined()
    expect(
      dialogs.read(screen, question(asking(colours(["Red", "Green", "Blue", "Pink"])))),
    ).toBeUndefined()
    expect(
      dialogs.read(screen, question(asking(colours(["Red", "Blue", "Green"])))),
    ).toBeUndefined()
    expect(
      dialogs.read(screen, question(asking(colours(["Red", "Green", "Blue"], true)))),
    ).toBeUndefined()
    expect(
      dialogs.read(
        screen,
        question(asking({ ...colours(["Red", "Green", "Blue"]), question: "Which shade?" })),
      ),
    ).toBeUndefined()
    // Two questions asked, one shown; or a call that isn't a question.
    expect(
      dialogs.read(screen, question(asking(colours(["Red", "Green", "Blue"]), colours(["a"])))),
    ).toBeUndefined()
    expect(dialogs.read(screen, question(run("echo approved")))).toBeUndefined()
    expect(
      dialogs.read(screen, question({ name: "ask_question", args: { questions: [{}] } })),
    ).toBeUndefined()
  })

  it("is none once the screen is broken", () => {
    const request = question(colour)
    for (const screen of [ask.pending.screen120!.rows, ask.pending.screen60!.rows]) {
      const breaks = [
        without(screen, /^Question 1\/1: /),
        same(screen, "Question 1/1: Which colour?", "Question 1/1:"),
        same(screen, "Question 1/1: Which colour?", "Question 2/1: Which colour?"),
        without(screen, /Navigate/),
        same(screen, /Navigate/, "  enter Select"),
        without(screen, /Write-in/),
        same(screen, "  4. Write-in...", "  4. Type here..."),
        same(screen, "  2. Green", "  2. Grey"),
        screen.map((row) => row.replace(/^> 1\. /, "  1. ")),
        screen.map((row) => row.replace(/^ {2}2\. /, "> 2. ")),
        same(screen, "  2. Green", "  2. [ ] Green"),
        same(screen, "  2. Green", "  3. Green"),
        [],
      ]
      for (const broken of breaks) expect(dialogs.read(broken, request)).toBeUndefined()
    }
    expect(
      dialogs.read(ask.pending.screen120!.rows, permission(run("echo approved"))),
    ).toBeUndefined()
    expect(dialogs.read(command.pending.screen120!.rows, request)).toBeUndefined()
  })
})
