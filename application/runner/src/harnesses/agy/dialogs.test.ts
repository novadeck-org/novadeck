import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { RequestAnswer } from "@novadeck/protocol"

import { describe, expect, it } from "../../test.js"
import type { DialogRead, KeyStep, RequestFacts } from "../dialogs.js"
import { dialogs } from "./dialogs.js"

type Screens = { [name: string]: string[] }
const { scenarios } = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "ask.probe.json"), "utf8"),
) as {
  scenarios: {
    command: { pending: Screens }
    twin: { first: string[]; second: string[] }
    write_to_file: { pending: Screens }
    ask_question: {
      pending: Screens
      multiSelect: Screens
      twoQuestions: Screens
      writeIn: string[]
    }
    plan_feedback: { afterWrite: Screens; review: Screens }
    answered: { [name: string]: string[] }
  }
}
const { command, write_to_file: write, ask_question: ask, plan_feedback: plan } = scenarios
const gone = scenarios.answered

const run = (text: string) => ({
  name: "run_command",
  args: { CommandLine: text, Cwd: "/tmp/sandbox/project" },
})
const colours = (options: string[], multi = false) => ({
  question: "Which colour?",
  options,
  is_multi_select: multi,
})
const asking = (...questions: object[]) => ({ name: "ask_question", args: { questions } })
const permission = (input: unknown): RequestFacts => ({
  kind: "permission",
  tool: "confirmation",
  cwd: null,
  input,
})
const question = (input: unknown): RequestFacts => ({
  kind: "question",
  tool: "ask_question",
  cwd: null,
  input,
})
const colour = asking(colours(["Red", "Green", "Blue"]))

const read = (rows: readonly string[], request: RequestFacts): DialogRead => {
  const found = dialogs.read(rows, request)
  if (!found) throw new Error("the dialog went unrecognised")
  return found
}
const same = (rows: readonly string[], from: string | RegExp, to: string): string[] => {
  const index = rows.findIndex((row) => (typeof from === "string" ? row === from : from.test(row)))
  if (index < 0) throw new Error(`no row ${String(from)}`)
  return rows.with(index, to)
}
const without = (rows: readonly string[], pattern: RegExp): string[] =>
  rows.filter((row) => !pattern.test(row))

// What a step list presses and types, with its waits left out.
const sent = (steps: readonly KeyStep[] | undefined) =>
  steps?.flatMap((step) =>
    "press" in step ? [step.press] : "type" in step ? [`"${step.type}"`] : [],
  )
// The screens a step list's waits ask for, in order.
const waits = (steps: readonly KeyStep[] | undefined) =>
  steps?.flatMap((step) => ("until" in step ? [step.until] : []))
const questions = (...answers: { question: string; options: string[]; text?: string }[]) =>
  ({ type: "questions", dialog: "d", answers }) satisfies RequestAnswer
const chat = (text?: string) =>
  ({ type: "chat", dialog: "d", ...(text !== undefined && { text }) }) satisfies RequestAnswer
const choice = (option: string, text?: string) =>
  ({
    type: "choice",
    dialog: "d",
    option,
    ...(text !== undefined && { text }),
  }) satisfies RequestAnswer

describe("Antigravity's command confirmation", () => {
  it("is read from the screen at both sizes, its options as shown, a digit answering at once", () => {
    for (const screen of [command.pending.screen120!, command.pending.screen60!]) {
      const found = read(screen, permission(run("echo approved")))
      expect(found.dialog).toMatchObject({
        type: "choices",
        title: "Run this command?",
        detail: "echo approved",
        options: [
          { id: "1", label: "Yes, run command", text: null },
          { id: "2", label: expect.stringMatching(/^Yes, and always allow in this conversation/) },
          { id: "3", label: expect.stringMatching(/\(Persist to settings\.json\)$/) },
          { id: "4", label: "No, cancel", text: "prompt" },
        ],
      })
      expect(sent(found.keys(choice("1")))).toEqual(["1"])
      expect(sent(found.keys(choice("4")))).toEqual(["4"])
      // Words go with the No only, as the prompt after it; no other option takes them.
      expect(sent(found.keys(choice("4", "use ls instead")))).toEqual(["4"])
      expect(found.keys(choice("1", "and more"))).toBeUndefined()
      expect(found.keys(choice("2", "and more"))).toBeUndefined()
      // An option it hasn't, or another kind of answer, press nothing.
      expect(found.keys(choice("5"))).toBeUndefined()
      expect(found.keys(questions({ question: "1", options: ["1"] }))).toBeUndefined()
    }
  })

  it("joins an option wrapped on a narrow screen", () => {
    const found = read(command.pending.screen60!, permission(run("echo approved")))
    expect(found.dialog).toMatchObject({
      options: [
        {},
        { label: "Yes, and always allow in this conversation for commands that start with 'echo'" },
        {
          label:
            "Yes, and always allow for commands that start with 'echo' (Persist to settings.json)",
        },
        {},
      ],
    })
  })

  it("is answered once its dialog is gone, and not while it, or the same call's, shows", () => {
    const found = read(command.pending.screen120!, permission(run("echo approved")))
    expect(found.answered(command.pending.screen120!)).toBe(false)
    expect(found.answered(command.pending.screen60!)).toBe(false)
    expect(found.answered(gone.ask!)).toBe(true)
    // Parallel calls show their dialogs one at a time: the next is another command's.
    expect(
      found.answered(same(command.pending.screen120!, "   echo approved", "   echo another")),
    ).toBe(true)
  })

  it("tells the next of two identical queued commands by how the tool lines moved on", () => {
    const { twin } = scenarios
    const latest = (
      JSON.parse(
        readFileSync(join(import.meta.dirname, "fixtures", "ask.probe.1.3.0.json"), "utf8"),
      ) as { screens: { [name: string]: string[] } }
    ).screens
    const twins = permission(run("echo same"))
    // 1.2.14 marks the queued call ○ until it is its turn; 1.3.0 folds the ran into a count.
    for (const [first, second] of [
      [twin.first, twin.second],
      [latest.twinFirst!, latest.twinSecond!],
    ]) {
      const found = read(first!, twins)
      expect(found.answered(first!)).toBe(false)
      expect(found.answered(second!)).toBe(true)
    }
    // A redraw of the lines above it, a hint toggled, is no progress.
    const pending = command.pending.screen120!
    const found = read(pending, permission(run("echo approved")))
    const toggled = same(
      pending,
      "● Bash(echo approved) (ctrl+o to expand)",
      "● Bash(echo approved) (ctrl+o to collapse)",
    )
    expect(found.answered(toggled)).toBe(false)
    expect(found.answered(same(pending, "> Run it", "> Run it again"))).toBe(false)
    const queued = read(twin.first!, twins)
    expect(queued.answered(same(twin.first!, /^● Bash\(echo same\)$/, "● Bash(echo same) !"))).toBe(
      false,
    )
    const folded = read(latest.twinFirst!, twins)
    expect(
      folded.answered(same(latest.twinFirst!, /^● Ran \(echo same\)$/, "● Ran (echo same) ·")),
    ).toBe(false)
    // Not at 60 columns, where the lines scrolled off: nothing tells them apart.
    const narrow = read(command.pending.screen60!, permission(run("echo approved")))
    expect(narrow.answered(command.pending.screen60!)).toBe(false)
  })

  it("agrees with the command of the call it was asked of, or is none", () => {
    const screen = command.pending.screen120!
    expect(dialogs.read(screen, permission(run("rm -rf /")))).toBeUndefined()
    expect(dialogs.read(screen, permission(run("echo approved && true")))).toBeUndefined()
    expect(dialogs.read(screen, permission(undefined))).toBeUndefined()
    expect(dialogs.read(screen, permission({ name: "run_command", args: {} }))).toBeUndefined()
    expect(dialogs.read(screen, permission({ name: "write_to_file", args: {} }))).toBeUndefined()
    // Whitespace within a row must match; a row break may be a newline or a space.
    expect(dialogs.read(screen, permission(run("echo   approved")))).toBeUndefined()
    expect(dialogs.read(screen, permission(run("echo\tapproved")))).toBeUndefined()
    expect(dialogs.read(screen, permission(run("  echo approved \n")))).toBeDefined()
    const wrapped = [
      ...screen.slice(0, screen.indexOf("   echo approved")),
      "   echo one",
      "   echo two",
      ...screen.slice(screen.indexOf("   echo approved") + 1),
    ]
    expect(dialogs.read(wrapped, permission(run("echo one\necho two")))).toBeDefined()
    expect(dialogs.read(wrapped, permission(run("echo one echo two")))).toBeDefined()
    expect(dialogs.read(wrapped, permission(run("echo one  echo two")))).toBeUndefined()
    // Words are kept apart: `> x` is not `>x`.
    const redirect = same(screen, "   echo approved", "   echo a > x")
    expect(dialogs.read(redirect, permission(run("echo a > x")))).toBeDefined()
    expect(dialogs.read(redirect, permission(run("echo a >x")))).toBeUndefined()
  })

  it("reads a command cut short with ... as none, whatever its start", () => {
    const request = permission(run("echo approved"))
    const cut = same(command.pending.screen120!, "   echo approved", "   echo appr...")
    expect(dialogs.read(cut, request)).toBeUndefined()
    expect(dialogs.read(cut, permission(run("echo approved and more")))).toBeUndefined()
    const bare = same(command.pending.screen120!, "   echo approved", "   ...")
    expect(dialogs.read(bare, request)).toBeUndefined()
    const short = same(command.pending.screen120!, "   echo approved", "   echo appr")
    expect(dialogs.read(short, request)).toBeUndefined()
  })

  it("is none once the screen is broken", () => {
    const request = permission(run("echo approved"))
    for (const screen of [command.pending.screen120!, command.pending.screen60!]) {
      const breaks = [
        // The question, its footer, the command's heading.
        without(screen, /^Run this command\?$/),
        same(screen, "Run this command?", "Run this program?"),
        without(screen, /Navigate/),
        without(screen, /^Requesting permission for:$/),
        // An option gone, renumbered, unmarked, marked twice, or a row between them.
        without(screen, /^ {2}2\. |^2\. /),
        screen.map((row) => row.replace(/^ {2}3\. /, "  5. ")),
        screen.map((row) => row.replace(/^> 1\. /, "  1. ")),
        screen.map((row) => row.replace(/^ {2}4\. /, "> 4. ")),
        // Another question beside it.
        [...screen, "Allow creation of this file?"],
        // Nothing of it.
        [],
        screen.slice(0, 6),
      ]
      for (const broken of breaks) expect(dialogs.read(broken, request)).toBeUndefined()
    }
    expect(dialogs.read(gone.ask!, request)).toBeUndefined()
  })

  it("is none for a request of another kind", () => {
    expect(
      dialogs.read(command.pending.screen120!, {
        ...permission(run("echo approved")),
        kind: "plan",
      }),
    ).toBeUndefined()
  })
})

describe("Antigravity's file confirmation", () => {
  const target = { name: "write_to_file", args: { TargetFile: "/tmp/sandbox/project/probe.txt" } }

  it("is read by its wording, its options as shown", () => {
    const found = read(write.pending.screen120!, permission(target))
    expect(found.dialog).toEqual({
      type: "choices",
      title: "Allow creation of this file?",
      detail: "/tmp/sandbox/project/probe.txt  +1\n   1 +  hello",
      options: [
        { id: "1", label: "Yes, allow creation", text: null },
        { id: "2", label: "No, deny creation", text: "prompt" },
      ],
    })
    expect(sent(found.keys(choice("2")))).toEqual(["2"])
    expect(found.answered(write.pending.screen120!)).toBe(false)
    expect(found.answered(gone.ask!)).toBe(true)
  })

  it("shows the whole of what it asks, never a cut of it", () => {
    const long = `echo ${"x".repeat(1500)}`
    const screen = same(command.pending.screen120!, "   echo approved", `   ${long}`)
    const found = read(screen, permission(run(long)))
    expect(found.dialog).toMatchObject({ detail: long })
  })

  it("agrees with the file of the call, or is none", () => {
    const screen = write.pending.screen120!
    const other = { name: "write_to_file", args: { TargetFile: "/tmp/sandbox/project/other.txt" } }
    expect(dialogs.read(screen, permission(other))).toBeUndefined()
    expect(dialogs.read(screen, permission({ name: "write_to_file", args: {} }))).toBeUndefined()
    expect(dialogs.read(screen, permission(run("echo approved")))).toBeUndefined()
    expect(dialogs.read(screen, permission(undefined))).toBeUndefined()
    expect(dialogs.read(without(screen, /Navigate/), permission(target))).toBeUndefined()
    expect(
      dialogs.read(same(screen, "Allow creation of this file?", "Create it?"), permission(target)),
    ).toBeUndefined()
    expect(dialogs.read(without(screen, /^ {2}2\. /), permission(target))).toBeUndefined()
    // Another tool on the same file, as a delete, is not a write.
    expect(
      dialogs.read(screen, permission({ name: "delete_file", args: target.args })),
    ).toBeUndefined()
    // The file's name elsewhere than its own lines (the transcript above, a longer path).
    const elsewhere = same(
      screen,
      "/tmp/sandbox/project/probe.txt  +1",
      "/tmp/sandbox/project/other.txt  +1",
    ).map((row) => (row === "Create file" ? "Create file" : row))
    const above = ["see /tmp/sandbox/project/probe.txt", ...elsewhere]
    expect(dialogs.read(above, permission(target))).toBeUndefined()
    const longer = same(
      screen,
      "/tmp/sandbox/project/probe.txt  +1",
      "/tmp/sandbox/project/probe.txt.bak  +1",
    )
    expect(dialogs.read(longer, permission(target))).toBeUndefined()
    expect(
      dialogs.read(same(screen, "Create file", "Delete file"), permission(target)),
    ).toBeUndefined()
  })
})

describe("Antigravity's ask_question", () => {
  it("is read at both sizes: one single-select, its Write-in a field", () => {
    for (const screen of [ask.pending.screen120!, ask.pending.screen60!]) {
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
    const found = read(ask.pending.screen120!, question(colour))
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
    expect(field!(ask.writeIn)).toBe(true)
    const typed = ask.writeIn.flatMap((row) =>
      row === "  Your answer:" ? [row, "  Let's discuss this first: is Red accessible?"] : [row],
    )
    expect(typedIn!(typed)).toBe(true)
    expect(typedIn!(ask.writeIn)).toBe(false)
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
    const several = read(ask.twoQuestions.q1!, question(two))
    expect(several.dialog).toMatchObject({ chat: null })
    expect(several.keys(chat("hm"))).toBeUndefined()
    const multi = read(
      ask.multiSelect.screen!,
      question(asking(colours(["Red", "Green", "Blue"], true))),
    )
    expect(multi.dialog).toMatchObject({ chat: null })
    expect(multi.keys(chat("hm"))).toBeUndefined()
    // Nor from a state that isn't the start.
    const moved = ask.pending.screen120!.map((row) =>
      row.replace(/^> 1\. /, "  1. ").replace(/^ {2}2\. /, "> 2. "),
    )
    expect(read(moved, question(colour)).keys(chat("hm"))).toBeUndefined()
  })

  it("picks an option with Down and Enter, waiting for the highlight to land", () => {
    const found = read(ask.pending.screen120!, question(colour))
    const first = found.keys(questions({ question: "1", options: ["1"] }))
    expect(sent(first)).toEqual(["\r"])
    const third = found.keys(questions({ question: "1", options: ["3"] }))
    expect(sent(third)).toEqual(["\x1b[B", "\x1b[B", "\r"])
    // It waits for the third row to be marked, and for nothing else.
    const [until] = waits(third)!
    expect(until!(ask.pending.screen120!)).toBe(false)
    const moved = ask.pending.screen120!.map((row) =>
      row.replace(/^> 1\. /, "  1. ").replace(/^ {2}3\. /, "> 3. "),
    )
    expect(until!(moved)).toBe(true)
    expect(until!(ask.writeIn)).toBe(false)
  })

  it("types its own words into Write-in: Down to it, Enter, wait for the field, type, Enter", () => {
    const found = read(ask.pending.screen120!, question(colour))
    const steps = found.keys(questions({ question: "1", options: [], text: "Purple" }))
    expect(sent(steps)).toEqual(["\x1b[B", "\x1b[B", "\x1b[B", "\r", '"Purple"', "\r"])
    const [lands, field] = waits(steps)!
    const fourth = ask.pending.screen120!.map((row) =>
      row.replace(/^> 1\. /, "  1. ").replace(/^ {2}4\. /, "> 4. "),
    )
    expect(lands!(fourth)).toBe(true)
    // Enter only follows its words showing in the field's own row.
    const [, , typedIn] = waits(steps)!
    const typed = ask.writeIn
      .map((row) => (row === "  Your answer:" ? "  Your answer:\n  Purple" : row))
      .flatMap((row) => row.split("\n"))
    expect(typedIn!(ask.writeIn)).toBe(false)
    expect(typedIn!(typed)).toBe(true)
    expect(typedIn!([...ask.writeIn, "Purple"])).toBe(false)
    expect(lands!(ask.pending.screen120!)).toBe(false)
    expect(field!(ask.writeIn)).toBe(true)
    expect(field!(ask.pending.screen120!)).toBe(false)
    // Options and words together, or words with a line break, are not an answer.
    expect(found.keys(questions({ question: "1", options: ["1"], text: "x" }))).toBeUndefined()
    expect(found.keys(questions({ question: "1", options: [], text: "a\nb" }))).toBeUndefined()
    expect(found.keys(questions({ question: "1", options: [] }))).toBeUndefined()
  })

  it("reads each state the keys pass through as the same dialog, with no keys of its own", () => {
    const found = read(ask.pending.screen120!, question(colour))
    const moved = ask.pending.screen120!.map((row) =>
      row.replace(/^> 1\. /, "  1. ").replace(/^ {2}2\. /, "> 2. "),
    )
    for (const state of [moved, ask.writeIn]) {
      const now = read(state, question(colour))
      expect(now.dialog).toEqual(found.dialog)
      expect(now.keys(questions({ question: "1", options: ["1"] }))).toBeUndefined()
    }
    // A write-in field with its keys gone, or a footer of none, is not read.
    expect(dialogs.read(without(ask.writeIn, /enter Submit/), question(colour))).toBeUndefined()
  })

  it("refuses answers that don't fit its questions", () => {
    const found = read(ask.pending.screen120!, question(colour))
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
    const found = read(ask.multiSelect.screen!, request)
    expect(found.dialog).toMatchObject({
      questions: [{ multiSelect: true, text: false, options: [{ label: "Red" }, {}, {}] }],
    })
    const steps = found.keys(questions({ question: "1", options: ["3", "1"] }))
    expect(sent(steps)).toEqual(["1", "3", "\r"])
    const [first, third] = waits(steps)!
    const checked = (number: number) =>
      ask.multiSelect.screen!.map((row) => row.replace(`${number}. [ ]`, `${number}. [x]`))
    expect(first!(ask.multiSelect.screen!)).toBe(false)
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
    const found = read(ask.twoQuestions.q1!, question(two))
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
    const otherText = ask.twoQuestions.q2!.map((row) => row.replace("Which size?", "Which shape?"))
    const otherOptions = ask.twoQuestions.q2!.map((row) => row.replace("Large", "Huge"))
    expect(next!(otherText)).toBe(false)
    expect(next!(otherOptions)).toBe(false)
    // Nor with the highlight not back on its first option, which the Downs count from.
    const unmarked = ask.twoQuestions.q2!.map((row) =>
      row.replace(/^> 1\. /, "  1. ").replace(/^ {2}2\. /, "> 2. "),
    )
    expect(next!(unmarked)).toBe(false)
    expect(
      one!(
        ask.twoQuestions.q1!.map((row) =>
          row.replace(/^> 1\. /, "  1. ").replace(/^ {2}2\. /, "> 2. "),
        ),
      ),
    ).toBe(true)
    expect(next!(ask.twoQuestions.q1!)).toBe(false)
    expect(next!(ask.twoQuestions.q2!)).toBe(true)
    expect(two2!(ask.twoQuestions.q2!)).toBe(false)
    // Words, with several questions, are not probed.
    expect(
      found.keys(
        questions({ question: "1", options: [], text: "x" }, { question: "2", options: ["1"] }),
      ),
    ).toBeUndefined()
    // Its second question is the same dialog, but isn't where an answer starts.
    const later = read(ask.twoQuestions.q2!, question(two))
    expect(later.dialog).toEqual(found.dialog)
    expect(
      later.keys(questions({ question: "1", options: ["1"] }, { question: "2", options: ["1"] })),
    ).toBeUndefined()
  })

  it("is answered once no question of it shows, and not while its field is open", () => {
    const found = read(ask.pending.screen120!, question(colour))
    expect(found.answered(ask.pending.screen120!)).toBe(false)
    expect(found.answered(ask.pending.screen60!)).toBe(false)
    expect(found.answered(ask.writeIn)).toBe(false)
    for (const screen of [gone.ask!, gone.writeIn!, gone.two!])
      expect(found.answered(screen)).toBe(true)
    // The call's other questions are its own dialog, and so is another question.
    const other = same(
      ask.pending.screen120!,
      "Question 1/1: Which colour?",
      "Question 1/1: Which shape?",
    )
    expect(found.answered(other)).toBe(true)
  })

  it("agrees with the call's questions and options, or is none", () => {
    const screen = ask.pending.screen120!
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
    for (const screen of [ask.pending.screen120!, ask.pending.screen60!]) {
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
    expect(dialogs.read(ask.pending.screen120!, permission(run("echo approved")))).toBeUndefined()
    expect(dialogs.read(command.pending.screen120!, request)).toBeUndefined()
  })
})

describe("Antigravity's plan review", () => {
  const request: RequestFacts = { kind: "plan", tool: "artifact", cwd: null, input: null }
  const written = plan.afterWrite.screen120!

  it("is a request the screen alone tells, by its footer over an empty idle prompt", () => {
    expect(dialogs.screenRequest!(written)).toEqual({
      kind: "plan",
      tool: "artifact",
      input: null,
      subject: "1 artifact to review",
    })
    // Not while the review itself is listed, as it is no longer the prompt.
    expect(dialogs.screenRequest!(plan.review.screen120!)).toBeUndefined()
    for (const none of [
      gone.planApproved!,
      gone.planRejected!,
      gone.ask!,
      command.pending.screen120!,
      ask.pending.screen120!,
      [],
    ])
      expect(dialogs.screenRequest!(none)).toBeUndefined()
  })

  it("offers Approve, Reject and Reject with feedback, a prompt for the words", () => {
    const found = read(written, request)
    expect(found.dialog).toEqual({
      type: "choices",
      title: "1 artifact to review",
      detail: null,
      options: [
        { id: "approve", label: "Approve", text: null },
        { id: "reject", label: "Reject", text: null },
        { id: "feedback", label: "Tell it what to change", text: "field" },
      ],
    })
  })

  it("types /artifact, waits for the review, then y or n", () => {
    const found = read(written, request)
    const approve = found.keys(choice("approve"))
    expect(sent(approve)).toEqual(["/artifact", "\r", "y"])
    expect(sent(found.keys(choice("reject")))).toEqual(["/artifact", "\r", "n"])
    // Its feedback is a plain prompt, with neither y nor n, which would reject first.
    const feedback = found.keys(choice("feedback", "Use SQLite"))
    expect(sent(feedback)).toEqual(['"Use SQLite"', "\r"])
    // It presses Enter only once the words show in the prompt box, not on another row.
    const [typedIn] = waits(feedback)!
    expect(typedIn!(written)).toBe(false)
    expect(typedIn!(same(written, ">", "> Use SQLite"))).toBe(true)
    expect(typedIn!([...written, "> Use SQLite"])).toBe(false)
    expect(typedIn!(same(written, ">", "> Use SQL"))).toBe(false)
    // Words that start a slash command or help are refused, with or without space before.
    // Nor a shell: `!` in the empty box activates bash mode and runs it (probed).
    for (const text of [
      "/clear",
      " /artifact",
      "?",
      "? help",
      "!echo hi",
      "  !ls",
      "@notes",
      "fix @notes",
      "mail a@b",
    ])
      expect(found.keys(choice("feedback", text))).toBeUndefined()
    expect(sent(found.keys(choice("feedback", "use /clear or !ls")))).toBeDefined()
    expect(found.keys(choice("feedback"))).toBeUndefined()
    expect(found.keys(choice("feedback", "a\nb"))).toBeUndefined()
    const [listed] = waits(approve)!
    expect(listed!(plan.review.screen120!)).toBe(true)
    expect(listed!(written)).toBe(false)
    expect(listed!(without(plan.review.screen120!, /^Action required/))).toBe(false)
    expect(found.keys(choice("approve", "go"))).toBeUndefined()
    expect(found.keys(choice("later"))).toBeUndefined()
    expect(found.keys(questions({ question: "1", options: ["1"] }))).toBeUndefined()
  })

  it("is answered once the review is closed, as the turn it starts shows", () => {
    const found = read(written, request)
    expect(found.answered(written)).toBe(false)
    expect(found.answered(plan.review.screen120!)).toBe(false)
    expect(found.answered(gone.planApproved!)).toBe(true)
    expect(found.answered(gone.planRejected!)).toBe(true)
  })

  it("reads as the same request with /artifact typed or its review listed, with no keys", () => {
    const found = read(written, request)
    const typed = same(written, ">", "> /artifact")
    for (const state of [typed, plan.review.screen120!]) {
      const now = read(state, request)
      expect(now.dialog).toEqual(found.dialog)
      expect(now.keys(choice("approve"))).toBeUndefined()
    }
  })

  it("reads a draft in the prompt box as the same dialog, with no keys, as /artifact would join it", () => {
    const draft = read(same(written, ">", "> half a sent"), request)
    expect(draft.keys(choice("approve"))).toBeUndefined()
    expect(dialogs.screenRequest!(same(written, ">", "> half a sent"))).toBeUndefined()
  })

  it("is none once the screen is broken, or where keys would reach something else", () => {
    const breaks = [
      // A turn running, not the idle prompt.
      same(written, /^\? for shortcuts/, "esc to cancel"),
      // More than one artifact, which y and n take one by one.
      same(written, /artifact to review$/, "2 artifacts · /artifact to review"),
      without(written, /artifact to review$/),
      [],
    ]
    for (const broken of breaks) expect(dialogs.read(broken, request)).toBeUndefined()
    expect(dialogs.read(written, { ...request, tool: "plan" })).toBeUndefined()
    expect(dialogs.read(written, { ...request, kind: "question" })).toBeUndefined()
  })
})

describe("Antigravity 1.3.0's dialogs (fixtures/ask.probe.1.3.0.json)", () => {
  const latest = (
    JSON.parse(
      readFileSync(join(import.meta.dirname, "fixtures", "ask.probe.1.3.0.json"), "utf8"),
    ) as { screens: { [name: string]: string[] } }
  ).screens

  it("read as 1.2.14's do: the same options, keys and answered", () => {
    const found = read(latest.command!, permission(run("echo approved")))
    expect(found.dialog).toMatchObject({
      detail: "echo approved",
      options: [{}, {}, {}, { id: "4" }],
    })
    expect(sent(found.keys(choice("4")))).toEqual(["4"])
    expect(found.answered(latest.command!)).toBe(false)
    expect(found.answered(latest.planApproved!)).toBe(true)
    const file = { name: "write_to_file", args: { TargetFile: "/tmp/sandbox/project/probe.txt" } }
    expect(read(latest.write!, permission(file)).dialog).toMatchObject({ options: [{}, {}] })
    const asked = read(latest.ask!, question(colour))
    expect(sent(asked.keys(questions({ question: "1", options: ["2"] })))).toEqual(["\x1b[B", "\r"])
    expect(
      sent(asked.keys(questions({ question: "1", options: [], text: "Purple" }))),
    ).toHaveLength(6)
    const typedIn = waits(
      asked.keys(questions({ question: "1", options: [], text: "Purple" })),
    )![2]!
    expect(typedIn(latest.writeInTyped!)).toBe(true)
    expect(typedIn(latest.writeIn!)).toBe(false)
    expect(read(latest.writeIn!, question(colour)).dialog).toEqual(asked.dialog)
    expect(
      read(latest.multi!, question(asking(colours(["Red", "Green", "Blue"], true)))).dialog,
    ).toMatchObject({ questions: [{ multiSelect: true }] })
    const two = asking(colours(["Red", "Green"]), {
      question: "Which size?",
      options: ["Small", "Large"],
      is_multi_select: false,
    })
    expect(read(latest.q1!, question(two)).dialog).toMatchObject({ questions: [{}, {}] })
    expect(read(latest.q2!, question(two)).dialog).toMatchObject({ questions: [{}, {}] })
  })

  it("read the plan review as 1.2.14's", () => {
    const request: RequestFacts = { kind: "plan", tool: "artifact", cwd: null, input: null }
    expect(dialogs.screenRequest!(latest.planWritten!)).toMatchObject({ kind: "plan" })
    const found = read(latest.planWritten!, request)
    const [listed] = waits(found.keys(choice("approve")))!
    expect(listed!(latest.review!)).toBe(true)
    expect(found.answered(latest.review!)).toBe(false)
    expect(found.answered(latest.planApproved!)).toBe(true)
    expect(dialogs.screenRequest!(latest.planApproved!)).toBeUndefined()
  })
})
