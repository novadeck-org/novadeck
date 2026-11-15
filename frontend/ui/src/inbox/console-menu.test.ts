import type { ChatAnswer, ChatDialogOption, ChatRequest } from "@novadeck/core/conversation"
import type { InboxRow, Trouble } from "@novadeck/core/inbox"

import { context, describe, expect, it } from "../test"
import { menuOf, requestReceipt, type MenuRow, type OwnRow } from "./console-menu"

const source: InboxRow["source"] = {
  projectId: "p",
  workspaceSessionId: "s",
  terminalId: "t",
  handle: "crow",
  agent: "codex",
  title: "Title",
  projectName: "Project",
}
const base = { id: "i", source, at: 0, stopped: true, seen: false }

const request = (
  dialog: ChatRequest["dialog"],
  kind: ChatRequest["kind"] = "permission",
  tool = kind === "plan" ? "ExitPlanMode" : "Bash",
): ChatRequest => ({
  id: "r",
  kind,
  tool,
  subject: "pnpm add x",
  choices: [],
  subagent: false,
  answered: false,
  askedAt: 0,
  dialog,
})
const choices = (
  options: readonly ChatDialogOption[],
  kind: "permission" | "plan" = "permission",
): ChatRequest =>
  request({ type: "choices", id: "d", title: null, detail: "pnpm add x", options }, kind)
const picked = (option: string, text?: string): ChatAnswer => ({
  type: "choice",
  dialog: "d",
  option,
  ...(text === undefined ? {} : { text }),
})

const codex: readonly ChatDialogOption[] = [
  { id: "yes", label: "Yes, proceed", text: null },
  {
    id: "always",
    label: "Yes, and don't ask again for commands that start with `pnpm add`",
    text: null,
  },
  { id: "no", label: "No, continue without running it", text: null },
  { id: "differently", label: "No, and tell Codex what to do differently", text: "prompt" },
]

const labels = (rows: readonly MenuRow[]): string[] => rows.map((row) => row.label)
const words = (row: MenuRow | undefined): Extract<MenuRow, { type: "words" }> => {
  if (row?.type !== "words") throw new Error("not a words row")
  return row
}

describe("A request's receipt", () => {
  // Each harness's own options, as its adapter reads them (chat-contract's wordings goldens).
  const permissions: readonly [string, ChatDialogOption[]][] = [
    [
      "Claude Code",
      [
        { id: "1", label: "Yes", text: null },
        { id: "2", label: "Yes, and don't ask again for example.com", text: null },
        { id: "3", label: "No", text: null },
        { id: "tell", label: "No, and tell Claude what to do", text: "prompt" },
      ],
    ],
    ["Codex", codex.map((each, at) => ({ ...each, id: String(at + 1) }))],
    [
      "Antigravity",
      [
        { id: "1", label: "Yes, run command", text: null },
        {
          id: "2",
          label: "Yes, and always allow in this conversation for commands that start with 'echo'",
          text: null,
        },
        { id: "3", label: "No, cancel", text: "prompt" },
      ],
    ],
  ]
  const plans: readonly [string, ChatDialogOption[]][] = [
    [
      "Claude Code",
      [
        { id: "1", label: "Yes, auto-accept edits", text: null },
        { id: "2", label: "Yes, manually approve edits", text: null },
        { id: "3", label: "Tell Claude what to change", text: "field" },
      ],
    ],
    [
      "Codex",
      [
        { id: "1", label: "Yes, implement this plan", text: null },
        { id: "2", label: "No, stay in Plan mode", text: "prompt" },
      ],
    ],
    [
      "Antigravity",
      [
        { id: "approve", label: "Approve", text: null },
        { id: "feedback", label: "Tell it what to change", text: "field" },
      ],
    ],
  ]

  it.each(permissions)(
    "says what %s's yes, standing yes and noes did, by what core reads into them",
    (_, options) => {
      const asked = choices(options)
      const [yes, standing, ...noes] = options
      expect(requestReceipt(asked, "crow", picked(yes!.id))).toBe("Allowed @crow's command.")
      expect(requestReceipt(asked, "crow", picked(standing!.id))).toBe(
        "Allowed @crow's command; it won't ask again.",
      )
      const back = noes.find((each) => each.text !== null)!
      expect(requestReceipt(asked, "crow", picked(back.id, "Use npm."))).toBe(
        "Denied @crow's command, with your words.",
      )
    },
  )

  it.each(plans)("says what %s's plan answers did", (_, options) => {
    const asked = choices(options, "plan")
    expect(requestReceipt(asked, "moth", picked(options[0]!.id))).toMatch(
      /^Approved @moth's plan(; it won't ask again)?\.$/,
    )
    const back = options.find((each) => each.text !== null)!
    expect(requestReceipt(asked, "moth", picked(back.id, "Split it."))).toBe(
      "Sent back @moth's plan, with your words.",
    )
  })

  it("says a plain no as Denied, and an option no rule reads as answered", () => {
    const asked = choices(codex)
    expect(requestReceipt(asked, "crow", picked("no"))).toBe("Denied @crow's command.")
    const other = choices([{ id: "run", label: "Run it in a sandbox", text: null }])
    expect(requestReceipt(other, "crow", picked("run"))).toBe("Answered @crow's command.")
    expect(requestReceipt(asked, "crow", picked("gone"))).toBe("Answered @crow's command.")
  })

  it("names what a tool no rule reads asked by its name", () => {
    const asked = request(
      { type: "choices", id: "d", title: null, detail: null, options: codex },
      "permission",
      "WebFetch",
    )
    expect(requestReceipt(asked, "crow", picked("yes"))).toBe("Allowed @crow's WebFetch.")
  })

  it("says a dialog of questions was answered, one or several", () => {
    const question = {
      id: "q1",
      header: null,
      question: "Which?",
      options: [],
      multiSelect: false,
      text: true,
    }
    const one = request(
      { type: "questions", id: "d", chat: "prompt", questions: [question] },
      "question",
    )
    const two = request(
      {
        type: "questions",
        id: "d",
        chat: "prompt",
        questions: [question, { ...question, id: "q2" }],
      },
      "question",
    )
    const answer: ChatAnswer = { type: "questions", dialog: "d", answers: [] }
    expect(requestReceipt(one, "moth", answer)).toBe("Answered @moth's question.")
    expect(requestReceipt(two, "moth", answer)).toBe("Answered @moth's questions.")
    expect(requestReceipt(two, "moth", { type: "chat", dialog: "d" })).toBe(
      "Set @moth's questions aside to talk them over in its terminal.",
    )
  })

  it("says a form was filled in, or declined", () => {
    const form = request(
      { type: "form", id: "f", message: "Configure it", fields: [] },
      "question",
      "mcp_deploy_configure_target",
    )
    const answer = (action: "accept" | "decline"): ChatAnswer => ({
      type: "form",
      dialog: "f",
      action,
      values: {},
    })
    expect(requestReceipt(form, "kite", answer("accept"))).toBe("Filled in @kite's form.")
    expect(requestReceipt(form, "kite", answer("decline"))).toBe("Declined @kite's form.")
  })
})

describe("A sheet's menu of its own", () => {
  context("for an agent's ask", () => {
    const asked = (shape: Extract<InboxRow, { kind: "ask" }>["ask"]["shape"], hard?: string) =>
      ({
        ...base,
        kind: "ask",
        ask: { subject: "s", body: "", details: null, hardToUndo: hard ?? null, shape },
      }) satisfies OwnRow

    it("numbers its options, tags its pick, and always takes the person's own words", () => {
      const { rows, hard } = menuOf(
        asked({
          type: "options",
          recommend: 1,
          options: [
            { label: "Retry", summary: "Three times.", details: null, code: null },
            { label: "Queue", summary: null, details: "- More.", code: null },
          ],
        }),
        0,
      )
      expect(labels(rows)).toEqual(["Retry", "Queue", "Reply in your own words", "Go to terminal"])
      expect(rows[0]).toMatchObject({ effect: "Three times.", pick: false, details: null })
      expect(rows[1]).toMatchObject({ pick: true, details: { details: "- More." } })
      expect(rows[1]).toMatchObject({
        answer: { kind: "ask", answer: { type: "reply", option: 1, text: "" } },
      })
      expect(words(rows[2]).answer(" Neither. ")).toEqual({
        kind: "ask",
        answer: { type: "reply", option: null, text: "Neither." },
      })
      expect(hard).toBe(false)
    })

    it("is hard to undo where the agent says its answer is", () => {
      expect(menuOf(asked({ type: "text" }, "It sets the schema."), 0).hard).toBe(true)
    })

    it("offers the done button and the person's words for something only they can do", () => {
      const { rows } = menuOf(
        asked({
          type: "action",
          command: "vercel login",
          directory: null,
          doneLabel: "I've logged in",
        }),
        0,
      )
      expect(labels(rows)).toEqual(["I've logged in", "Reply in your own words", "Go to terminal"])
      expect(rows[0]).toMatchObject({ receipt: "Told @crow it's done." })
    })
  })

  context("for trouble", () => {
    const troubled = (trouble: Trouble, stopped = true): OwnRow => ({
      ...base,
      stopped,
      kind: "trouble",
      trouble,
    })

    it("asks a failed agent at rest to fix it, saying what it sends, and leaves a stored one that has moved on to resolve itself", () => {
      const { rows } = menuOf(troubled({ type: "failed", error: "x", stored: true }), 0)
      expect(labels(rows)).toEqual(["Ask it to fix", "Go to terminal"])
      expect(rows[0]!).toMatchObject({
        effect: "Sends: “Your last turn ended in an error. Look at what went wrong and fix it.”",
      })
      expect(
        labels(menuOf(troubled({ type: "failed", error: "x", stored: true }, false), 0).rows),
      ).toEqual(["Go to terminal"])
    })

    it("offers Continue only once a limit has reset, and the switch only where Novadeck can resume", () => {
      const limit = (autoResume: boolean | null, resetsAt: number) =>
        troubled({ type: "limit", minutes: 300, resetsAt, autoResume, evidence: [] })
      expect(labels(menuOf(limit(null, 100), 50).rows)).toEqual(["Go to terminal"])
      expect(labels(menuOf(limit(null, 100), 200).rows)).toEqual(["Continue now", "Go to terminal"])
      expect(menuOf(limit(true, 100), 50).rows).toMatchObject([
        {
          type: "toggle",
          on: true,
          change: { kind: "trouble", action: { type: "auto-resume", on: false } },
        },
        { type: "reveal", label: "Go to terminal" },
      ])
    })

    it("nudges a stuck agent with its own line or the person's words, as theirs", () => {
      const { rows } = menuOf(
        troubled({ type: "stuck", summary: "", evidence: [], nudge: "Try another way." }),
        0,
      )
      expect(labels(rows)).toEqual([
        "Nudge it",
        "Nudge it in your own words",
        "Stop it",
        "Go to terminal",
      ])
      expect(rows[0]).toMatchObject({
        answer: { kind: "trouble", action: { type: "nudge", text: "Try another way." } },
      })
      expect(words(rows[1]).answer("Read the log.")).toEqual({
        kind: "trouble",
        action: { type: "nudge", text: "Read the log.", own: true },
      })
    })
  })

  context("on every row", () => {
    it("ends on the way to its terminal, and offers it only once", () => {
      const update: OwnRow = {
        ...base,
        kind: "update",
        update: { type: "done", subject: "s", body: "" },
      }
      const held: OwnRow = {
        ...base,
        kind: "held",
        held: {
          threadId: "th",
          from: { handle: "owl", title: "Tests" },
          to: { handle: "moth", title: "Checkout" },
          text: "Hi",
          hop: 3,
          heldFor: "loop",
        },
      }
      for (const inboxRow of [update, held]) {
        const menuRows = menuOf(inboxRow, 0).rows
        expect(menuRows.at(-1)).toEqual({ type: "reveal", label: "Go to terminal", effect: null })
        expect(menuRows.filter((menuRow) => menuRow.type === "reveal")).toHaveLength(1)
      }
    })
  })
})
