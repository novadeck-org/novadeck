import type { ScreenText } from "@novadeck/emulator/headless"
import type { KeyStep, RequestFacts } from "@novadeck/harness-core/dialogs"
import type { RequestAnswer } from "@novadeck/protocol"
import { describe, expect, it } from "vitest"

import {
  decoded,
  load,
  probe,
  read,
  replaced,
  screen,
  session,
  sizes,
  type Hook,
} from "./dialogs.test-support.js"

describe("Codex's async question", () => {
  // Its screens as the pin (0.166.0) drew them; 0.165.0's read the same, but for the `•`
  // that headed the question in the chat where 0.166.0 draws `?` (fixtures/ask.probe*.json).
  const newest = load("ask.probe.0.166.0.json")
  type Steps = { readonly label: string; readonly screen: ScreenText }[]
  const panel = (name: string, source = newest): string[] => [
    ...(source.scenarios[name] as unknown as { before: ScreenText }).before.rows,
  ]
  const step = (name: string, label: string, source = newest): string[] => [
    ...(source.scenarios[name] as unknown as { steps: Steps }).steps.find(
      (each) => each.label === label,
    )!.screen.rows,
  ]
  const asyncFacts = (name: string, source = newest): RequestFacts => {
    const hook = (source.scenarios[name]!.hooksAll ?? []).find(
      ({ kind, event, payload }) =>
        kind === "start" &&
        event === "PreToolUse" &&
        payload?.tool_name === "request_user_input_async",
    )!
    const event = decoded({
      event: "PreToolUse",
      payload: { ...hook.payload!, session_id: session },
    } as Hook)[0]!
    if (event.type !== "attention-requested") throw new Error("no request")
    return { kind: event.kind, tool: event.toolName, input: event.input, cwd: null }
  }
  const one = asyncFacts("rui-async-panel-digit-2")
  const two = asyncFacts("rui-async-panel-two-questions")
  const free = (title: string): RequestFacts => ({
    kind: "question",
    tool: "request_user_input_async",
    input: { questions: [{ title }] },
    cwd: null,
  })
  const reply = (
    ...answers: readonly { question: string; options?: string[]; text?: string }[]
  ): RequestAnswer => ({
    type: "questions",
    dialog: "d",
    answers: answers.map(({ question, options = [], text }) => ({
      question,
      options,
      ...(text !== undefined && { text }),
    })),
  })
  const waits = (steps: readonly KeyStep[] | undefined) =>
    steps!.filter((each) => "until" in each) as {
      until: (rows: readonly string[]) => boolean
    }[]

  it("reads as the questions it asks, open to words, with the answer keys behind the panel", () => {
    const found = read(panel("rui-async-panel-digit-2"), one)!
    expect(found.dialog).toEqual({
      type: "questions",
      chat: null,
      questions: [
        {
          id: "1",
          header: null,
          question: "Which color should the button be?",
          options: [
            { id: "1", label: "Blue", description: null },
            { id: "2", label: "Green", description: null },
          ],
          multiSelect: false,
          text: true,
        },
      ],
    })
    const steps = found.keys(reply({ question: "1", options: ["2"] }))!
    expect(steps[0]).toEqual({ press: "\x1b[1;2D" })
    // It waits for the picker on this question before the digit.
    const [opened] = waits(steps)
    expect(opened!.until(panel("rui-async-panel-digit-2"))).toBe(false)
    expect(opened!.until(step("rui-async-panel-digit-2", "shift+left"))).toBe(true)
    expect(steps.slice(2)).toEqual([{ press: "2" }])
    // While the turn shows its question, keys answer it, never a prompt.
    expect(found.prompt).toBeUndefined()
  })

  it("reads with the picker already open, and presses no key to open it", () => {
    const rows = step("rui-async-panel-digit-2", "shift+left")
    const found = read(rows, one)!
    expect(found.keys(reply({ question: "1", options: ["1"] }))).toEqual([{ press: "1" }])
    expect(found.keys(reply({ question: "1", options: ["3"] }))).toBeUndefined()
  })

  it("reads only the panel that counts its own questions", () => {
    expect(read(panel("rui-async-panel-two-questions"), one)).toBeUndefined()
    expect(read(panel("rui-async-panel-digit-2"), two)).toBeUndefined()
    expect(read(panel("rui-async-panel-two-questions"), two)).toBeDefined()
    expect(read(step("rui-async-panel-two-questions", "shift+left"), one)).toBeUndefined()
    expect(read(step("rui-async-panel-digit-2", "shift+left"), two)).toBeUndefined()
  })

  it("reads no panel or picker left on screen once the hooks say the turn has ended", () => {
    // 0.166.0's screen 13 ms after its Stop hook (probed 2026-10-31): the turn's last words
    // where its status row was, the panel still under them, gone a moment later.
    const left = replaced(
      panel("rui-async-panel-digit-2"),
      /^• Working \(\d+s • esc to interrupt\)/,
      "• Finished the request.",
    )
    const ended = { ...one, turnEnded: true as const }
    // Without the hooks' word the screen reads as the panel.
    expect(read(left, one)).toBeDefined()
    expect(read(left, ended)).toBeUndefined()
    expect(
      read(
        replaced(
          step("rui-async-panel-digit-2", "shift+left"),
          /^• Working \(\d+s • esc to interrupt\)/,
          "• Finished the request.",
        ),
        ended,
      ),
    ).toBeUndefined()
    // Its status row still drawn, as after an Escape that only closed the picker, which
    // reads to Novadeck as the turn's end, the turn runs on and its panel answers: also
    // while a hook runs.
    expect(read(panel("rui-async-panel-digit-2"), ended)).toBeDefined()
    expect(
      read(
        replaced(panel("rui-async-panel-digit-2"), /interrupt\)/, "interrupt) · Running hooks"),
        ended,
      ),
    ).toBeDefined()
    // Once they have gone, the answer is the next prompt.
    expect(read(screen("rui-async-offered", "wide", newest), ended)?.prompt).toBeDefined()
  })

  it("reads no picker on another question, or with another request's options", () => {
    const rows = step("rui-async-panel-digit-2", "shift+left")
    expect(read(rows, free("Which color should the button be?"))).toBeUndefined()
    expect(read(replaced(rows, "Which color", "Which colour"), one)).toBeUndefined()
    expect(read(replaced(rows, "2. Green", "2. Teal"), one)).toBeUndefined()
    expect(
      read(
        rows.filter((row) => !row.includes("3. Other")),
        one,
      ),
    ).toBeUndefined()
    expect(
      read(
        rows.filter((row) => !row.includes("enter submit")),
        one,
      ),
    ).toBeUndefined()
  })

  it("answers several in turn, waiting for each next question before its digit", () => {
    const rows = step("rui-async-panel-two-questions", "shift+left")
    const found = read(rows, two)!
    expect(found.dialog).toMatchObject({
      questions: [
        { id: "1", text: true },
        { id: "2", options: [], text: true },
      ],
    })
    const steps = found.keys(
      reply({ question: "1", options: ["1"] }, { question: "2", text: "Large" }),
    )!
    const next = waits(steps).at(-2)!
    expect(next.until(rows)).toBe(false)
    expect(next.until(step("rui-async-panel-two-questions", "1"))).toBe(true)
    expect(steps.some((each) => "type" in each && each.type === "Large")).toBe(true)
    expect(found.keys(reply({ question: "1", options: ["1"] }))).toBeUndefined()
    expect(
      found.keys(reply({ question: "1", options: ["1"] }, { question: "9", text: "x" })),
    ).toBeUndefined()
    expect(found.prompt).toBeUndefined()
  })

  it("takes words on its Other row, checking each step shows", () => {
    const rows = step("rui-async-panel-digit-2", "shift+left")
    const steps = read(rows, one)!.keys(reply({ question: "1", text: "Purple" }))!
    expect(
      steps.map((each) => ("press" in each ? each.press : "type" in each ? each.type : "?")),
    ).toEqual(["3", "?", "Purple", "?", "\r"])
    const [marked, typed] = waits(steps)
    expect(marked!.until(rows)).toBe(false)
    expect(
      marked!.until(rows.map((row) => row.replace("› 1.", "  1.").replace("  3.", "› 3."))),
    ).toBe(true)
    const withWords = rows.map((row) =>
      row.replace("› 1.", "  1.").replace("  3. Other", "› 3. Purple"),
    )
    expect(typed!.until(withWords)).toBe(true)
    expect(typed!.until(rows)).toBe(false)
  })

  it("takes words alone for a question with no options, waiting for them to show", () => {
    const opened = step("rui-async-panel-free-words", "shift+left", probe)
    const typed = step("rui-async-panel-free-words", "Large", probe)
    const facts = asyncFacts("rui-async-panel-free-words", probe)
    expect(facts.input).toEqual({ questions: [{ title: "What should its label say?" }] })
    const found = read(opened, facts)!
    expect(found.dialog).toMatchObject({ questions: [{ options: [], text: true }] })
    const steps = found.keys(reply({ question: "1", text: "Large" }))!
    expect(
      steps.map((each) => ("press" in each ? each.press : "type" in each ? each.type : "?")),
    ).toEqual(["Large", "?", "\r"])
    const [shown] = waits(steps)
    expect(shown!.until(opened)).toBe(false)
    expect(shown!.until(typed)).toBe(true)
    // Words already in the field are a draft, not a picker to answer.
    expect(read(typed, facts)).toBeUndefined()
    // A digit means nothing to it.
    expect(found.keys(reply({ question: "1", options: ["1"] }))).toBeUndefined()
  })

  it("waits for its words on the Other row they replace, as probed", () => {
    const facts = asyncFacts("rui-async-panel-other-words", probe)
    const open = step("rui-async-panel-other-words", "shift+left", probe)
    const marked = step("rui-async-panel-other-words", "3", probe)
    const typed = step("rui-async-panel-other-words", "Purple", probe)
    const [other, words] = waits(read(open, facts)!.keys(reply({ question: "1", text: "Purple" })))
    expect(other!.until(open)).toBe(false)
    expect(other!.until(marked)).toBe(true)
    expect(words!.until(marked)).toBe(false)
    expect(words!.until(typed)).toBe(true)
    // The words in another row, or on a row that isn't highlighted, are not its field.
    expect(words!.until(replaced(typed, "› 3. Purple", "› 3. Violet"))).toBe(false)
    expect(words!.until(replaced(typed, "› 3. Purple", "  3. Purple"))).toBe(false)
    // Words typed already: no digit answers, so no dialog to read.
    expect(read(typed, facts)).toBeUndefined()
    // Words are not mixed with an option.
    expect(
      read(open, facts)!.keys(reply({ question: "1", options: ["1"], text: "Purple" })),
    ).toBeUndefined()
    expect(read(open, facts)!.keys(reply({ question: "1", text: "  " }))).toBeUndefined()
  })

  it("reads the second question's picker once the first is answered, and checks the answers shown", () => {
    const facts = asyncFacts("rui-async-panel-two-other", probe)
    const open = step("rui-async-panel-two-other", "shift+left", probe)
    const found = read(open, facts)!
    const steps = found.keys(
      reply({ question: "1", text: "Purple" }, { question: "2", text: "Large" }),
    )!
    const [, , next, shown] = waits(steps)
    const later = step("rui-async-panel-two-other", "Purple, enter", probe)
    expect(next!.until(open)).toBe(false)
    expect(next!.until(later)).toBe(true)
    expect(shown!.until(later)).toBe(false)
    const last = step("rui-async-panel-two-other", "Large, enter", probe)
    expect(found.answered(last)).toBe(true)
    expect(found.answered(later)).toBe(false)
    expect(found.answered(open)).toBe(false)
  })

  it("reads the keys of its hints as macOS draws them, and the picker they open", () => {
    const mac = (rows: readonly string[]) =>
      rows.map((row) =>
        row
          .replace("shift+← to answer", "⇧← to answer")
          .replace("^] skip", "⌃] skip")
          .replace("shift+→ main prompt", "⇧→ main prompt"),
      )
    const found = read(mac(panel("rui-async-panel-digit-2")), one)!
    const [, opened] = found.keys(reply({ question: "1", options: ["2"] }))!
    expect(
      (opened as { until: (rows: readonly string[]) => boolean }).until(
        mac(step("rui-async-panel-digit-2", "shift+left")),
      ),
    ).toBe(true)
    // Any other key said to open it is not the one pressed.
    expect(
      read(
        panel("rui-async-panel-digit-2").map((row) =>
          row.replace("shift+← to answer", "alt+← to answer"),
        ),
        one,
      ),
    ).toBeUndefined()
  })

  it("asks only the questions still to answer, once some were answered on their own", () => {
    const rest = { ...two, answered: [0] }
    // The first answer queued, the picker moved on to the second at once.
    const found = read(step("rui-async-panel-two-questions", "1"), rest)!
    expect(found.dialog).toMatchObject({
      type: "questions",
      questions: [{ id: "1", question: "What should its label say?", options: [] }],
    })
    const steps = found.keys(reply({ question: "1", text: "Large" }))!
    expect(steps.some((each) => "press" in each && each.press === "\x1b[1;2D")).toBe(false)
    expect(steps.some((each) => "type" in each && each.type === "Large")).toBe(true)
    // Once the turn has ended, the prompt quotes only what remains.
    const after = read(screen("rui-async-offered", "wide", newest), rest)!
    expect(after.prompt!(reply({ question: "1", text: "Large" }))).toBe(
      "> What should its label say?\n\nLarge",
    )
    expect(read(panel("rui-async-panel-digit-2"), { ...one, answered: [0] })).toBeUndefined()
  })

  it("reads once the turn has ended, and takes the answer as a prompt", () => {
    for (const size of sizes) {
      const rows = screen("rui-async-offered", size, newest)
      const found = read(rows, one)!
      expect(found.keys(reply({ question: "1", options: ["1"] }))).toBeUndefined()
      expect(found.prompt!(reply({ question: "1", options: ["1"] }))).toBe(
        "> Which color should the button be?\n\nBlue",
      )
      expect(found.prompt!(reply({ question: "1", text: "Purple" }))).toBe(
        "> Which color should the button be?\n\nPurple",
      )
      expect(found.prompt!(reply({ question: "1", options: ["7"] }))).toBeUndefined()
      expect(found.prompt!(reply({ question: "1", text: "a\nb" }))).toBeUndefined()
      expect(found.prompt!({ type: "chat", dialog: "d", text: "hi" })).toBeUndefined()
      // Words as the prompt quotes them back: set apart on their own, no space around.
      expect(found.prompt!(reply({ question: "1", text: "  Purple " }))).toBe(
        "> Which color should the button be?\n\nPurple",
      )
      // A question over several lines can't be quoted as one: no prompt reads for it.
      expect(read(rows, free("Which color,\nreally?"))).toBeUndefined()
      // Every question in one prompt, in Codex's own words for each.
      const both = read(rows, asyncFacts("rui-async-panel-two-questions"))!
      expect(
        both.prompt!(reply({ question: "1", options: ["1"] }, { question: "2", text: "Large" })),
      ).toBe("> Which color should the button be?\n\nBlue\n\n> What should its label say?\n\nLarge")
    }
  })

  it("reads an idle screen whatever its box shows, a suggestion or a draft, which the prompt checks", () => {
    const idle = screen("rui-async-offered", "wide", newest)
    expect(
      read(replaced(idle, "Ask Codex to do anything", "Explain this codebase"), one)?.prompt,
    ).toBeDefined()
  })

  it("reads no idle screen with a turn running or anything else drawn on it", () => {
    const idle = screen("rui-async-offered", "wide", newest)
    expect(
      read([...idle.slice(0, 7), "• Working (3s • esc to interrupt)", ...idle.slice(7)], one),
    ).toBeUndefined()
    expect(
      read([...idle.slice(0, 7), "◦ Working (3s • esc to interrupt)", ...idle.slice(7)], one),
    ).toBeUndefined()
    expect(read(idle.slice(0, -3), one)).toBeUndefined()
    // Another dialog's screen.
    expect(read(screen("exec-approve"), one)).toBeUndefined()
  })

  it("is answered once its last answer is queued, or no panel of Codex's is left", () => {
    const found = read(panel("rui-async-panel-digit-2"), one)!
    const queued = step("rui-async-panel-digit-2", "2")
    expect(found.answered(queued)).toBe(true)
    expect(found.answered(step("rui-async-panel-digit-2", "shift+left"))).toBe(false)
    expect(found.answered(panel("rui-async-panel-digit-2"))).toBe(false)
    const both = read(
      step("rui-async-panel-two-questions", "shift+left"),
      asyncFacts("rui-async-panel-two-questions"),
    )!
    expect(both.answered(step("rui-async-panel-two-questions", "1"))).toBe(false)
  })
})
