import type { RequestFacts } from "@novadeck/harness-core/dialogs"
import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"
import {
  answer,
  chat,
  choice,
  Down,
  eventually,
  factsOf,
  need,
  never,
  options,
  pressed,
  readOf,
  replace,
  Right,
  screen,
  sizes,
  step,
  swap,
  typed,
  waits,
} from "./dialogs.test-support.js"

describe("Claude Code's AskUserQuestion", () => {
  it.each(sizes)("reads a single question with its descriptions at %s", (size) => {
    const dialog = need(readOf("ask-single", size))
    expect(dialog.dialog).toEqual({
      type: "questions",
      chat: "prompt",
      questions: [
        {
          id: "q1",
          header: "Database",
          question: "Which database should we use?",
          options: [
            {
              id: "1",
              label: "Postgres",
              description: "Relational, battle tested, needs a server",
            },
            { id: "2", label: "SQLite", description: "Embedded, zero setup, single writer" },
            { id: "3", label: "DuckDB", description: "Analytical, columnar" },
          ],
          multiSelect: false,
          text: true,
        },
      ],
    })
    expect(
      pressed(
        dialog.keys({
          type: "questions",
          dialog: "d",
          answers: [{ question: "q1", options: ["2"] }],
        }),
      ),
    ).toEqual(["2"])
    expect(dialog.answered(screen("ask-single", size))).toBe(false)
    expect(dialog.answered(step("ask-single", "after"))).toBe(true)
  })

  it("answers with the person's own words once the row is focused", () => {
    const dialog = need(readOf("ask-other", "120x40"))
    const keys = dialog.keys({
      type: "questions",
      dialog: "d",
      answers: [{ question: "q1", options: [], text: "MariaDB please" }],
    })
    expect(keys).toMatchObject([
      { press: "4" },
      { until: expect.any(Function), why: expect.any(String) },
      { type: "MariaDB please" },
      { until: expect.any(Function), why: expect.any(String) },
      { press: "\r" },
    ])
    const [focused, landed] = waits(keys)
    // The words must show in that row itself, not anywhere on screen.
    expect(landed!.until(step("ask-other", "typed"))).toBe(true)
    expect(landed!.until(step("ask-other", "pressed-4"))).toBe(false)
    const short = need(readOf("ask-other", "120x40")).keys({
      type: "questions",
      dialog: "d",
      answers: [{ question: "q1", options: [], text: "1" }],
    })
    const [, one] = waits(short)
    const elsewhere = step("ask-other", "pressed-4").map((row) => row.replace("2. SQLite", "2. 1"))
    expect(one!.until(elsewhere)).toBe(false)
    // Not before the screen shows the row focused, which it does after the digit.
    expect(focused!.until(screen("ask-other", "120x40"))).toBe(false)
    expect(focused!.until(step("ask-other", "pressed-4"))).toBe(true)
    expect(dialog.answered(step("k-ask-other-enter", "after-enter"))).toBe(true)
  })

  it("refuses answers a question can't take", () => {
    const dialog = need(readOf("ask-single", "120x40"))
    expect(dialog.keys(answer(["9"]))).toBeUndefined()
    expect(dialog.keys(answer([]))).toBeUndefined()
    expect(dialog.keys(answer(["1", "2"]))).toBeUndefined()
    expect(dialog.keys(answer(["1"], "and more"))).toBeUndefined()
    expect(dialog.keys(answer([], "two\nlines"))).toBeUndefined()
    expect(dialog.keys(choice("1"))).toBeUndefined()
    expect(
      dialog.keys({
        type: "questions",
        dialog: "d",
        answers: [{ question: "q2", options: ["1"] }],
      }),
    ).toBeUndefined()
  })

  it.each(sizes)("reads several questions and a multi-select at %s", (size) => {
    const dialog = need(readOf("ask-multi", size))
    expect(dialog.dialog).toMatchObject({
      type: "questions",
      questions: [
        { id: "q1", header: "Database", multiSelect: false, text: true },
        {
          id: "q2",
          header: "Features",
          multiSelect: true,
          text: true,
          options: [
            { id: "1", label: "Auth", description: "Login and sessions" },
            { id: "2", label: "Billing", description: "Stripe integration" },
            { id: "3", label: "Search", description: "Full text search" },
          ],
        },
        { id: "q3", header: "Region", multiSelect: false, text: true },
      ],
    })
  })

  it("answers several questions: digits, Right after a multi-select, then submit", () => {
    const dialog = need(readOf("ask-multi", "120x40"))
    const keys = dialog.keys({
      type: "questions",
      dialog: "d",
      answers: [
        { question: "q1", options: ["2"] },
        { question: "q2", options: ["1", "3"] },
        { question: "q3", options: ["1"] },
      ],
    })
    expect(pressed(keys)).toEqual(["2", "1", "3", Right, "1", "1"])
    // The waits follow what the probe saw after each key.
    const [next, first, ticked, third, afterThird, review] = waits(keys)
    expect(next!.until(step("ask-multi", "after-q1"))).toBe(true)
    expect(next!.until(screen("ask-multi", "120x40"))).toBe(false)
    expect(first!.until(step("ask-multi", "after-q1"))).toBe(false)
    expect(first!.until(step("ask-multi", "toggled-1"))).toBe(true)
    expect(ticked!.until(step("ask-multi", "space-on-3"))).toBe(true)
    expect(third!.until(step("ask-multi-finish", "after-right"))).toBe(true)
    expect(afterThird!.until(step("ask-multi-finish", "after-q3"))).toBe(true)
    expect(review).toBeUndefined()
    expect(dialog.answered(step("ask-multi-finish", "after-q3"))).toBe(false)
    expect(dialog.answered(step("k-ask-multi-full", "submitted"))).toBe(true)
  })

  it("answers a free-text question among several, then moves to the next", () => {
    const dialog = need(readOf("ask-multi", "120x40"))
    const keys = dialog.keys({
      type: "questions",
      dialog: "d",
      answers: [
        { question: "q1", options: [], text: "Mongo" },
        { question: "q2", options: ["2"] },
        { question: "q3", options: ["2"] },
      ],
    })
    expect(pressed(keys)).toEqual(["4", "\r", "2", Right, "2", "1"])
    expect(typed(keys)).toEqual(["Mongo"])
  })

  it("reads the preview layout, where digits only move the highlight", () => {
    const dialog = need(readOf("ask-preview", "120x40"))
    expect(dialog.dialog).toMatchObject({
      questions: [
        {
          options: [{ label: "Postgres" }, { label: "SQLite" }],
          multiSelect: false,
          text: false,
        },
      ],
    })
    const keys = dialog.keys(answer(["2"]))
    expect(pressed(keys)).toEqual([Down, "\r"])
    expect(waits(keys)[0]!.until(step("ask-preview", "down"))).toBe(true)
    expect(waits(keys)[0]!.until(screen("ask-preview", "120x40"))).toBe(false)
    expect(pressed(dialog.keys(answer(["1"])))).toEqual(["\r"])
    expect(
      dialog.keys({
        type: "questions",
        dialog: "d",
        answers: [{ question: "q1", options: [], text: "x" }],
      }),
    ).toBe(undefined)
    expect(dialog.answered(step("k-ask-preview-enter", "after-enter"))).toBe(true)
  })

  it("reads the preview layout at 60x20 when its box is cut", () => {
    expect(readOf("ask-preview", "60x20")).toBeDefined()
  })

  it("reads the long question at 120x40 and refuses it where its top scrolled off", () => {
    const dialog = need(readOf("ask-long", "120x40"))
    expect(dialog.dialog).toMatchObject({
      questions: [{ header: "Approach", options: [{}, {}, {}, {}] }],
    })
    expect(readOf("ask-long", "60x20")).toBeUndefined()
    expect(readOf("ask-long", "60x12")).toBeUndefined()
  })

  it("refuses the review screen, the answered screen, and screens of other questions", () => {
    const facts = factsOf("ask-multi")
    expect(dialogs.read(step("ask-multi-finish", "after-q3"), facts)).toBeUndefined()
    expect(dialogs.read(step("ask-multi", "after-q1"), facts)).toBeUndefined()
    expect(dialogs.read(step("ask-single", "after"), factsOf("ask-single"))).toBeUndefined()
    expect(dialogs.read(screen("ask-single", "120x40"), facts)).toBeUndefined()
    expect(dialogs.read(screen("ask-multi", "120x40"), factsOf("ask-single"))).toBeUndefined()
    expect(
      dialogs.read(step("k-ask-multi-back", "back-on-q1"), factsOf("ask-multi")),
    ).toBeUndefined()
  })

  it("refuses when the request and the screen disagree", () => {
    const facts = factsOf("ask-single")
    const rows = screen("ask-single", "120x40")
    const asking = (change: (question: Record<string, unknown>) => void): RequestFacts => {
      const input = structuredClone(facts.input) as { questions: Record<string, unknown>[] }
      change(input.questions[0]!)
      return { ...facts, input }
    }
    const disagreements: { [name: string]: RequestFacts } = {
      "a question that no longer matches": asking((q) => (q.question = "Which engine?")),
      "another header": asking((q) => (q.header = "Storage")),
      "an option the screen lacks": asking((q) => options(q).push({ label: "Mongo" })),
      "an option the request lacks": asking((q) => options(q).pop()),
      "a renamed option": asking((q) => (options(q)[0]!.label = "PostgreSQL")),
      "reordered options": asking((q) => (q.options = options(q).toReversed())),
      "another description": asking((q) => (options(q)[1]!.description = "Different")),
      "a multi-select the screen shows single": asking((q) => (q.multiSelect = true)),
      "a request of no questions": { ...facts, input: { questions: [] } },
      "no input": { ...facts, input: undefined },
    }
    for (const [name, each] of Object.entries(disagreements)) {
      expect(dialogs.read(rows, each), name).toBeUndefined()
    }
  })

  it("refuses a screen an update changed", () => {
    const facts = factsOf("ask-multi")
    const single = factsOf("ask-single")
    const preview = factsOf("ask-preview")
    const cases: { name: string; facts: RequestFacts; rows: string[] }[] = []
    const mutate = (
      name: string,
      scene: string,
      size: string,
      withFacts: RequestFacts,
      change: (rows: string[]) => string[],
    ) => cases.push({ name, facts: withFacts, rows: change(screen(scene, size)) })
    for (const size of sizes) {
      mutate(
        `${size}: changed footer`,
        "ask-single",
        size,
        single,
        replace("Enter to select", "Press Enter"),
      )
      mutate(`${size}: a different marker`, "ask-single", size, single, replace("❯ 1.", "> 1."))
      mutate(
        `${size}: another marker glyph on a tab bar`,
        "ask-multi",
        size,
        facts,
        replace("←", "<"),
      )
      mutate(
        `${size}: renamed type row`,
        "ask-single",
        size,
        single,
        replace("Type something.", "Other"),
      )
      mutate(
        `${size}: renamed chat row`,
        "ask-single",
        size,
        single,
        replace("Chat about this", "Discuss"),
      )
      mutate(`${size}: an extra option`, "ask-single", size, single, (rows) =>
        rows.flatMap((row) => (row.includes("3. DuckDB") ? [row, "  3b. Mongo"] : [row])),
      )
      mutate(`${size}: reordered options`, "ask-single", size, single, (rows) =>
        rows.map((row) =>
          row.includes("1. Postgres")
            ? row.replace("Postgres", "SQLite")
            : row.includes("2. SQLite")
              ? row.replace("SQLite", "Postgres")
              : row,
        ),
      )
      mutate(`${size}: no highlight`, "ask-single", size, single, replace("❯ 1.", "  1."))
      mutate(
        `${size}: two highlights`,
        "ask-single",
        size,
        single,
        replace("  2. SQLite", "❯ 2. SQLite"),
      )
      mutate(
        `${size}: changed question wording`,
        "ask-single",
        size,
        single,
        replace("Which database", "What database"),
      )
      mutate(
        `${size}: changed description`,
        "ask-single",
        size,
        single,
        replace("Embedded", "Built-in"),
      )
      mutate(
        `${size}: an answered tab`,
        "ask-multi",
        size,
        facts,
        replace("☐ Database", "☒ Database"),
      )
      mutate(`${size}: renamed tab`, "ask-multi", size, facts, replace("Features", "Options"))
      mutate(`${size}: no submit tab`, "ask-multi", size, facts, replace("✔ Submit", "✔ Send"))
      mutate(`${size}: an unknown row`, "ask-single", size, single, (rows) => {
        const at = rows.findIndex((row) => row.includes("Enter to select"))
        return [...rows.slice(0, at), "Something new", ...rows.slice(at)]
      })
      mutate(`${size}: unknown preview layout`, "ask-preview", size, preview, replace("┌", "+"))
      mutate(
        `${size}: renamed preview chat row`,
        "ask-preview",
        size,
        preview,
        replace("Chat about this", "Discuss"),
      )
    }
    for (const { name, facts: each, rows } of cases) {
      expect(dialogs.read(rows, each), name).toBeUndefined()
    }
  })
})

describe("Claude Code's wait for the next question", () => {
  const keysFor = () =>
    need(readOf("ask-multi", "120x40")).keys({
      type: "questions",
      dialog: "d",
      answers: [
        { question: "q1", options: ["2"] },
        { question: "q2", options: ["1"] },
        { question: "q3", options: ["1"] },
      ],
    })

  it("passes on the next question's own screen and on no other", () => {
    const [next] = waits(keysFor())
    expect(never(next, step("ask-multi", "after-q1"))).toBe(true)
    expect(never(next, screen("ask-multi", "120x40"))).toBe(false)
  })

  it("does not take the next question's words inside this question's for it", () => {
    const [next] = waits(keysFor())
    // Q1's screen whose own question text contains Q2's: its options are still Q1's.
    const quoting = screen("ask-multi", "120x40").map((row) =>
      row === "Which database should we use?"
        ? "Which database should we use? Which features should be enabled?"
        : row,
    )
    expect(never(next, quoting)).toBe(false)
    // Or Q2's text on a line of its own above Q1's question, between the tab bar and options.
    const above = screen("ask-multi", "120x40").flatMap((row) =>
      row === "Which database should we use?" ? ["Which features should be enabled?", row] : [row],
    )
    expect(never(next, above)).toBe(false)
    // Q2's screen with another header than Q2's tab.
    const renamed = step("ask-multi", "after-q1").map((row) => row.replace("Features", "Options"))
    expect(never(next, renamed)).toBe(false)
  })
})

describe("Claude Code's later questions", () => {
  const plan = () =>
    need(readOf("ask-multi", "120x40")).keys({
      type: "questions",
      dialog: "d",
      answers: [
        { question: "q1", options: ["2"] },
        { question: "q2", options: ["1"] },
        { question: "q3", options: ["1"] },
      ],
    })

  it("have their options checked as the first question's are", () => {
    const [second, , third] = waits(plan())
    const q2 = step("ask-multi", "after-q1")
    expect(never(second, q2)).toBe(true)
    const broken: { [name: string]: string[] } = {
      "a renamed option": swap(q2, "Billing", "Invoicing"),
      "a changed description": swap(q2, "Stripe integration", "Paypal integration"),
      "an extra option row": q2.flatMap((row) =>
        row.includes("3. [ ] Search") ? ["  3b. [ ] Else", row] : [row],
      ),
      "a renamed Next row": swap(q2, "     Next", "     Done"),
      "a renamed type row": swap(q2, "Type something", "Other"),
      "a renamed chat row": swap(q2, "Chat about this", "Discuss"),
      "the highlight on the free-text row": swap(
        swap(q2, "❯ 1.", "  1."),
        "  4. [ ] Type",
        "❯ 4. [ ] Type",
      ),
      "no highlight": swap(q2, "❯ 1.", "  1."),
    }
    for (const [name, rows] of Object.entries(broken)) expect(never(second, rows), name).toBe(false)
    // The last question: its screen is the third's, and its options are checked as well.
    const q3 = step("ask-multi-finish", "after-right")
    expect(never(third, q3)).toBe(true)
    expect(never(third, swap(q3, "us-east", "us-west"))).toBe(false)
    expect(never(third, swap(q3, "Virginia", "Maryland"))).toBe(false)
  })
})

describe("Claude Code's lone multi-select question", () => {
  it("moves to a multi-select's text row from where the highlight is", () => {
    const facts = factsOf("k-ask-multi-lone")
    const rows = swap(
      swap(screen("k-ask-multi-lone", "120x40"), "❯ 1.", "  1."),
      "  2. [ ]",
      "❯ 2. [ ]",
    )
    const dialog = need(dialogs.read(rows, facts))
    const keys = dialog.keys({
      type: "questions",
      dialog: "d",
      answers: [{ question: "q1", options: [], text: "words" }],
    })
    expect(pressed(keys)).toEqual([Down, Down, Down, "\r", "1"])
  })

  const lone = (name: string) => need(readOf(name, "120x40"))
  it.each(sizes)("reads it with its Submit tab at %s", (size) => {
    const dialog = need(readOf("k-ask-multi-lone", size))
    expect(dialog.dialog).toMatchObject({
      questions: [
        {
          header: "Features",
          multiSelect: true,
          text: true,
          options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }],
        },
      ],
    })
  })

  it("ticks with digits, goes to the review with Right, and submits it", () => {
    const dialog = lone("k-ask-multi-lone")
    const keys = dialog.keys(answer(["1", "3"]))
    expect(pressed(keys)).toEqual(["1", "3", Right, "1"])
    const [first, third, review] = waits(keys)
    expect(first!.until(step("k-ask-multi-lone-enter", "after"))).toBe(false)
    expect(first!.until(step("k-ask-multi-lone", "toggled"))).toBe(true)
    expect(third!.until(step("k-ask-multi-lone", "toggled"))).toBe(true)
    expect(review!.until(step("k-ask-multi-lone", "after-right"))).toBe(true)
    expect(review!.until(step("k-ask-multi-lone", "toggled"))).toBe(false)
    expect(dialog.answered(step("k-ask-multi-lone", "after-right"))).toBe(false)
    expect(dialog.answered(step("k-ask-multi-lone", "after-1"))).toBe(true)
  })

  it("types its own words by arrows, as its digit only ticks that row", () => {
    const dialog = lone("k-ask-multi-lone-other")
    const keys = dialog.keys(answer(["1"], "Webhooks please"))
    expect(pressed(keys)).toEqual(["1", Down, Down, Down, Down, "\r", "1"])
    expect(typed(keys)).toEqual(["Webhooks please"])
    const [, focused, landed, onSubmit, review] = waits(keys)
    expect(landed!.until(step("k-ask-multi-lone-other", "typed"))).toBe(true)
    expect(landed!.until(step("k-ask-multi-lone-other", "on-other"))).toBe(false)
    expect(focused!.until(step("k-ask-multi-lone-other", "on-other"))).toBe(true)
    expect(focused!.until(screen("k-ask-multi-lone-other", "120x40"))).toBe(false)
    expect(onSubmit!.until(step("k-ask-multi-lone-enter", "after-enter"))).toBe(false)
    expect(review!.until(step("k-ask-multi-lone-other", "review"))).toBe(true)
    expect(dialog.answered(step("k-ask-multi-lone-other", "review"))).toBe(false)
    expect(dialog.answered(step("k-ask-multi-lone-other", "submitted"))).toBe(true)
    // Words alone, and nothing at all.
    expect(typed(dialog.keys(answer([], "only words")))).toEqual(["only words"])
    expect(dialog.keys(answer([]))).toBeUndefined()
    expect(dialog.keys(answer(["1"], "two\nlines"))).toBeUndefined()
  })

  it("refuses it once the Enter that ticks a row, or a changed screen, shows", () => {
    const facts = factsOf("k-ask-multi-lone")
    const rows = screen("k-ask-multi-lone", "120x40")
    // Ticked options are not the state it was read in.
    expect(dialogs.read(step("k-ask-multi-lone", "toggled"), facts)).toBeUndefined()
    expect(dialogs.read(step("k-ask-multi-lone", "after-right"), facts)).toBeUndefined()
    expect(dialogs.read(step("k-ask-multi-lone-other", "typed"), facts)).toBeUndefined()
    const mutations: { [name: string]: string[] } = {
      "no Submit tab": swap(rows, "✔ Submit", "✔ Send"),
      "a renamed Submit row": swap(rows, "     Submit", "     Next"),
      "a renamed type row": swap(rows, "[ ] Type something", "[ ] Other"),
      "a second option marker": swap(rows, "  2. [ ]", "❯ 2. [ ]"),
      "no tab bar": rows.filter((row) => !row.startsWith("←")),
      "an answered tab": swap(rows, "☐ Features", "☒ Features"),
    }
    for (const [name, mutated] of Object.entries(mutations)) {
      expect(dialogs.read(mutated, facts), name).toBeUndefined()
    }
    // A tab bar over a single-select question is not a layout it has seen.
    const single = factsOf("ask-single")
    expect(
      dialogs.read(
        screen("ask-single", "120x40").map((row) =>
          row.replace(" ☐ Database", "←  ☐ Database  ✔ Submit  →"),
        ),
        single,
      ),
    ).toBeUndefined()
  })
})

describe("Claude Code's Chat about this", () => {
  it("is offered on every question dialog, as words for the next prompt", () => {
    for (const name of ["ask-single", "ask-multi", "k-ask-multi-lone", "ask-preview", "ask-long"]) {
      const size = "120x40"
      expect(need(readOf(name, size)).dialog, name).toMatchObject({ chat: "prompt" })
    }
  })

  it("presses the row's digit, the one after Type something, whatever the options", () => {
    // Three options: 4 is Type something, 5 Chat about this.
    for (const size of sizes) {
      expect(pressed(need(readOf("ask-single", size)).keys(chat("why")))).toEqual(["5"])
    }
    // The words are the driver's to send; none are needed.
    expect(pressed(need(readOf("ask-single", "120x40")).keys(chat()))).toEqual(["5"])
    // With several questions it sets aside the first question's screen it reads.
    expect(pressed(need(readOf("ask-multi", "120x40")).keys(chat()))).toEqual(["5"])
    expect(pressed(need(readOf("k-ask-multi-lone", "120x40")).keys(chat()))).toEqual(["5"])
  })

  it("is answered once the prompt is back", () => {
    const dialog = need(readOf("ask-single", "120x40"))
    expect(dialog.answered(step("k-chat-then-prompt", "after-chat"))).toBe(true)
    expect(dialog.answered(screen("ask-single", "120x40"))).toBe(false)
  })

  it("uses arrows and Enter in the preview layout, which has no digits", () => {
    const dialog = need(readOf("ask-preview", "120x40"))
    const keys = dialog.keys(chat("let us talk"))
    expect(pressed(keys)).toEqual([Down, Down, "\r"])
    const [onChat] = waits(keys)
    const onRow = step("k-ask-preview-chat", "on-second").map((row) =>
      row === "  Chat about this" ? "❯ Chat about this" : row.replace("❯ 2.", "  2."),
    )
    expect(eventually(onChat, onRow)).toBe(true)
    expect(never(onChat, step("k-ask-preview-chat", "on-second"))).toBe(false)
    expect(dialog.answered(step("k-ask-preview-chat", "after-enter"))).toBe(true)
    // From the second option, one Down.
    const second = need(
      dialogs.read(step("k-ask-preview-chat", "on-second"), factsOf("k-ask-preview-chat")),
    )
    expect(pressed(second.keys(chat()))).toEqual([Down, "\r"])
  })

  it("is not offered where the row isn't read", () => {
    const facts = factsOf("ask-single")
    const rows = screen("ask-single", "120x40")
    expect(dialogs.read(swap(rows, "Chat about this", "Discuss this"), facts)).toBeUndefined()
    expect(dialogs.read(swap(rows, "5. Chat", "6. Chat"), facts)).toBeUndefined()
    expect(
      dialogs.read(
        rows.filter((row) => !row.includes("Chat about this")),
        facts,
      ),
    ).toBeUndefined()
  })
})
