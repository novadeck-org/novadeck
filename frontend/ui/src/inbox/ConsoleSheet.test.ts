import {
  noConversation,
  type ChatDialogOption,
  type ChatItem,
  type ChatQuestion,
  type Conversation,
  type Conversations,
} from "@novadeck/core/conversation"
import {
  emptyInbox,
  type AskShape,
  type Inbox,
  type InboxAnswer,
  type InboxRow,
  type InboxState,
} from "@novadeck/core/inbox"
import { createStore } from "@novadeck/core/store"
import { nextFrame, render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { AgentContextProvider } from "./agent-context"
import { contextWaitMs } from "./ConsoleSheet"
import { InboxList } from "./InboxList"
import { InboxProvider } from "./InboxProvider"
import { InboxSheet } from "./InboxSheet"

// What the sheet records of the plan approvals it answered.
const { planAnswered } = vi.hoisted(() => ({
  planAnswered: vi.fn<(row: InboxRow) => void>(),
}))
vi.mock("./plan-text", async (original) => ({
  ...(await original<typeof import("./plan-text")>()),
  usePlanAnswered: () => planAnswered,
}))

// jsdom has no ResizeObserver, which the sheet's placement watches its anchor with.
Object.assign(globalThis, {
  ResizeObserver: class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
})

const source = (handle: string): InboxRow["source"] => ({
  projectId: "p",
  workspaceSessionId: "s",
  terminalId: `t-${handle}`,
  handle,
  agent: "codex",
  title: `Task of ${handle}`,
  projectName: "Project",
})

const permission = (
  options: readonly ChatDialogOption[],
  { id = "i", handle = "crow", kind = "permission", agent = "codex", at = 0 } = {} as {
    id?: string
    handle?: string
    kind?: "permission" | "plan"
    agent?: InboxRow["source"]["agent"]
    at?: number
  },
): InboxRow => ({
  id,
  source: { ...source(handle), agent },
  at,
  stopped: true,
  seen: false,
  kind: "request",
  request: {
    id: "r",
    kind,
    tool: kind === "plan" ? "ExitPlanMode" : "Bash",
    subject: "pnpm add x",
    choices: [],
    subagent: false,
    answered: false,
    dialog: { type: "choices", id: "d", title: null, detail: "pnpm add x", options },
  },
})

const asked = (shape: AskShape, { id = "a", hard = null as string | null, at = 1 } = {}) =>
  ({
    id,
    source: source("owl"),
    at,
    stopped: true,
    seen: false,
    kind: "ask",
    ask: { subject: "Which catalog?", body: "Choose one.", details: null, hardToUndo: hard, shape },
  }) satisfies InboxRow

const questions = (...list: ChatQuestion[]): InboxRow => ({
  id: "q",
  source: source("moth"),
  at: 0,
  stopped: true,
  seen: false,
  kind: "request",
  request: {
    id: "q",
    kind: "question",
    tool: "AskUserQuestion",
    subject: null,
    choices: [],
    subagent: false,
    answered: false,
    dialog: { type: "questions", id: "d", chat: "prompt", questions: list },
  },
})

const question = (id: string, labels: readonly string[], more: Partial<ChatQuestion> = {}) => ({
  id,
  header: null,
  question: `Which ${id}?`,
  multiSelect: false,
  text: false,
  options: labels.map((label) => ({ id: label, label, description: null })),
  ...more,
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

// What a test mounted, unmounted after it however it ended.
let mounted: { readonly unmount: () => void } | null = null
afterEach(() => {
  vi.restoreAllMocks()
  planAnswered.mockClear()
  mounted?.unmount()
  mounted = null
})

// The Inbox over these rows with the first one's sheet open, and the answers it gives.
const mount = (
  inboxRows: readonly InboxRow[],
  {
    failing = false,
    open = 0,
    conversations,
  }: { failing?: boolean; open?: number; conversations?: Pick<Conversations, "conversation"> } = {},
) => {
  const revealed: string[] = []
  const state = createStore<InboxState>({ ...emptyInbox, items: inboxRows })
  const sent: InboxAnswer[] = []
  const inbox: Inbox = {
    state,
    answer: (id, answer) => {
      sent.push(answer)
      if (failing)
        return state.update((current) => ({
          ...current,
          failed: { [id]: "The agent didn't take that." },
        }))
      state.update((current) => ({ ...current, answering: { [id]: true } }))
    },
    see: () => {},
    readAll: () => {},
  }
  const page = createElement(
    InboxProvider,
    { inbox, reveal: (terminal: string) => revealed.push(terminal) },
    createElement("div", { id: "inbox-panel" }, createElement(InboxList)),
    createElement(InboxSheet, { active: true }),
  )
  const view = render(
    conversations ? createElement(AgentContextProvider, { conversations }, page) : page,
  )
  mounted = view
  act(() => view.container.querySelectorAll<HTMLElement>(".inbox-row-select")[open]!.click())
  const rows = () => Array.from(document.querySelectorAll<HTMLElement>(".console-option"))
  const row = (text: string) => rows().find((each) => each.textContent?.includes(text))!
  const press = (text: string): void => act(() => row(text).click())
  const key = (
    name: string,
    target: Element = document.activeElement ?? document.body,
    { repeat = false } = {},
  ): void =>
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key: name, repeat, bubbles: true, cancelable: true }),
      )
    })
  const field = () => document.querySelector<HTMLTextAreaElement>(".inbox-sheet textarea")!
  const type = (text: string): void =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field(),
        text,
      )
      field().dispatchEvent(new Event("input", { bubbles: true }))
    })
  // The backend takes the answer: the row leaves.
  const confirm = (id: string): void =>
    act(() => {
      state.update((current) => ({
        ...current,
        items: current.items.filter((each) => each.id !== id),
        answering: {},
      }))
    })
  const fail = (id: string, message: string): void =>
    act(() => {
      state.update((current) => ({ ...current, answering: {}, failed: { [id]: message } }))
    })
  const done = async (): Promise<void> => {
    await nextFrame()
    view.unmount()
    mounted = null
  }
  return { view, state, sent, revealed, rows, row, press, key, field, type, confirm, fail, done }
}

const sheet = () => document.querySelector<HTMLElement>(".inbox-sheet")
const menus = () => Array.from(document.querySelectorAll<HTMLElement>(".console-menu"))
// A row of the nth question's menu.
const optionIn = (menu: number, label: string) =>
  Array.from(menus()[menu]!.querySelectorAll<HTMLElement>(".console-option")).find((each) =>
    each.textContent?.includes(label),
  )!
const status = () => text(".console-page > .console-note")
const text = (selector: string) => document.querySelector(selector)?.textContent ?? null

describe("The Console sheet", () => {
  context("its head", () => {
    it("tags the kind and names the project, the task and the handle, and nothing else", async () => {
      const inbox = mount([permission(codex)])

      expect(text(".console-tag")).toBe("Command")
      expect(text(".console-crumb")).toBe("Project/Task of crow")
      expect(text(".inbox-sheet-head .handle-chip")).toBe("@crow")
      expect(text(".inbox-sheet-head")).not.toContain("Codex")
      expect(text(".inbox-sheet-head")).not.toContain("waiting")
      await inbox.done()
    })
  })

  context("for a command", () => {
    it("shows the command verbatim and numbers the answers, the standing one's scope under it", async () => {
      const inbox = mount([permission(codex)])

      expect(text(".console-command")).toBe("$ pnpm add x")
      expect(inbox.rows().map((row) => row.querySelector(".console-t")?.textContent)).toEqual([
        "Allow",
        "Yes, and don't ask again",
        "Deny",
        "Deny, with your words",
        "Go to terminal",
      ])
      expect(inbox.row("ask again").querySelector(".console-s")?.textContent).toBe(
        "for commands that start with pnpm add",
      )
      expect(document.querySelector("[role=menu]")?.getAttribute("aria-label")).toBe("Answers")
      await inbox.done()
    })

    it("answers at once on a number pressed on its row", async () => {
      const inbox = mount([permission(codex)])
      inbox.key("1", document.querySelector(".inbox-row-select")!)

      expect(inbox.sent).toEqual([
        { kind: "request", answer: { type: "choice", dialog: "d", option: "yes" } },
      ])
      await inbox.done()
    })

    it("moves the cursor with the arrows and answers on Enter in the menu", async () => {
      const inbox = mount([permission(codex)])
      inbox.key("ArrowDown", document.querySelector(".inbox-row-select")!)
      expect(document.activeElement).toBe(inbox.row("ask again"))
      inbox.key("ArrowDown")
      expect(inbox.row("Deny").dataset.on).toBe("true")
      inbox.key("Enter")

      expect(inbox.sent).toEqual([
        { kind: "request", answer: { type: "choice", dialog: "d", option: "no" } },
      ])
      await inbox.done()
    })

    it("answers nothing on Enter on its row or title, so a key pressed twice to open it is safe", async () => {
      const inbox = mount([permission(codex)])
      inbox.key("Enter", document.querySelector(".inbox-sheet-title")!)

      expect(inbox.sent).toEqual([])
      await inbox.done()
    })

    it("turns the row for words into a box in place, and sends them with the option that takes them", async () => {
      const inbox = mount([permission(codex)])
      inbox.press("Deny, with your words")
      expect(document.activeElement).toBe(inbox.field())
      inbox.type("Use npm.")
      inbox.key("Enter", inbox.field())

      expect(inbox.sent).toEqual([
        {
          kind: "request",
          answer: { type: "choice", dialog: "d", option: "differently", text: "Use npm." },
        },
      ])
      await inbox.done()
    })

    it("goes back to the rows on Esc in the box, keeping the words, and the sheet open", async () => {
      const inbox = mount([permission(codex)])
      inbox.press("Deny, with your words")
      inbox.type("Use npm.")
      inbox.key("Escape", inbox.field())

      expect(sheet()).not.toBeNull()
      expect(document.querySelector(".inbox-sheet textarea")).toBeNull()
      expect(document.activeElement).toBe(inbox.row("Use npm."))
      inbox.key("Enter")
      expect(inbox.field().value).toBe("Use npm.")
      await inbox.done()
    })
  })

  context("for a plan", () => {
    it("arms a standing yes on the first press and sends it on the second", async () => {
      const inbox = mount([
        permission(
          [
            { id: "bypass", label: "Yes, and bypass permissions", text: null },
            { id: "manual", label: "Yes, and manually approve edits", text: null },
            { id: "change", label: "Tell Claude what to change", text: "field" },
          ],
          { kind: "plan", agent: "claude" },
        ),
      ])
      expect(inbox.rows().map((row) => row.querySelector(".console-t")?.textContent)).toEqual([
        "Approve",
        "Yes, and bypass permissions",
        "Send it back, with your words",
        "Go to terminal",
      ])
      inbox.key("2", document.querySelector(".inbox-row-select")!)
      expect(inbox.sent).toEqual([])
      expect(inbox.row("bypass").dataset.armed).toBe("true")
      inbox.key("2")

      expect(inbox.sent).toEqual([
        { kind: "request", answer: { type: "choice", dialog: "d", option: "bypass" } },
      ])
      await inbox.done()
    })

    it("needs words where its only way back is them, and says why Antigravity refuses some", async () => {
      const review: readonly ChatDialogOption[] = [
        { id: "approve", label: "Approve", text: null },
        { id: "reject", label: "Reject", text: null },
        { id: "feedback", label: "Tell it what to change", text: "field" },
      ]
      const inbox = mount([permission(review, { kind: "plan", agent: "agy" })])

      expect(text(".console-tag")).toBe("Plan")
      expect(text(".console-planbar")).toContain("plan")
      expect(inbox.rows().map((row) => row.querySelector(".console-t")?.textContent)).toEqual([
        "Approve",
        "Send it back",
        "Send it back, with your words",
        "Go to terminal",
      ])
      inbox.press("Send it back, with your words")
      inbox.type("/compact")
      expect(text(".console-own-hint")).toBe(
        "Antigravity can't take words that start with /, ? or !, or that have an @.",
      )
      inbox.key("Enter", inbox.field())
      expect(inbox.sent).toEqual([])
      inbox.type("Split the second step")
      expect(planAnswered).not.toHaveBeenCalled()
      inbox.key("Enter", inbox.field())
      // The plan it showed is spent: a round sent back is never the next approval's plan.
      expect(planAnswered).toHaveBeenCalledWith(expect.objectContaining({ id: "i" }))

      expect(inbox.sent).toEqual([
        {
          kind: "request",
          answer: {
            type: "choice",
            dialog: "d",
            option: "feedback",
            text: "Split the second step",
          },
        },
      ])
      await inbox.done()
    })
  })

  context("after an answer has taken", () => {
    it("opens the next row that needs the person, with a receipt naming the agent", async () => {
      const inbox = mount([
        permission(codex, { id: "first", handle: "crow" }),
        asked({ type: "text" }, { id: "second", at: 5 }),
      ])
      inbox.press("Allow")
      expect(inbox.row("Allow").dataset.pressed).toBe("true")
      inbox.confirm("first")

      expect(text(".console-receipt")).toBe("Allowed @crow's command.")
      expect(text(".inbox-sheet-head .handle-chip")).toBe("@owl")
      expect(text(".console-tag")).toBe("Question")
      await inbox.done()
    })

    it("skips updates, and closes with nothing else waiting", async () => {
      const inbox = mount([
        permission(codex, { id: "first" }),
        {
          id: "u",
          source: source("wren"),
          at: 9,
          stopped: false,
          seen: false,
          kind: "update",
          update: { type: "done", subject: "Done", body: "All of it." },
        },
      ])
      inbox.press("Allow")
      inbox.confirm("first")
      await nextFrame()

      expect(sheet()).toBeNull()
      await inbox.done()
    })

    it("stays put with the reason when an answer doesn't take", async () => {
      const inbox = mount(
        [permission(codex, { id: "first" }), asked({ type: "text" }, { id: "second", at: 5 })],
        { failing: true },
      )
      inbox.press("Allow")

      expect(text(".inbox-failure")).toBe("The agent didn't take that.")
      expect(text(".console-tag")).toBe("Command")
      expect(text(".console-receipt")).toBeNull()
      await inbox.done()
    })

    it("says on the receipt when a reply it moved on from did not arrive, and goes back to it", async () => {
      const inbox = mount([
        asked({ type: "text" }, { id: "first" }),
        permission(codex, { id: "second", at: 5 }),
      ])

      inbox.type("Use samples.")
      inbox.key("Enter", inbox.field())
      inbox.confirm("first")
      expect(text(".console-receipt")).toBe("Reply queued for @owl.")
      inbox.fail("first", "Your reply was not delivered because the agent's session ended.")

      expect(text(".console-receipt [role=alert], .console-receipt[role=alert]")).toContain(
        "not delivered",
      )
      act(() => document.querySelector<HTMLButtonElement>(".console-receipt button")!.click())
      expect(text(".inbox-failure")).toBe(
        "Your reply was not delivered because the agent's session ended.",
      )
      expect(inbox.field().value).toBe("Use samples.")
      await inbox.done()
    })
  })

  context("for an agent's ask", () => {
    const options: AskShape = {
      type: "options",
      recommend: 0,
      options: [
        { label: "Sample products", summary: "A few.", details: null, code: null },
        { label: "Test catalog", summary: null, details: null, code: null },
      ],
    }

    it("tags its pick and replaces the options with the person's own words", async () => {
      const inbox = mount([asked(options)])

      expect(inbox.row("Sample products").textContent).toContain("its pick")
      inbox.press("Reply in your own words")
      inbox.type("Neither.")
      expect(text(".console-own-hint")).toBe("↵ send your words instead · Esc back to the options")
      inbox.key("Enter", inbox.field())

      expect(inbox.sent).toEqual([
        { kind: "ask", answer: { type: "reply", option: null, text: "Neither." } },
      ])
      await inbox.done()
    })

    it("arms a hard-to-undo answer on the first press and sends it on the second", async () => {
      const inbox = mount([asked(options, { hard: "It sets the schema." })])

      expect(text(".console-tag")).toBe("Question")
      expect(sheet()?.dataset.tone).toBe("urgent")
      expect(text(".console-hard")).toBe("! Hard to undo: It sets the schema.")
      inbox.key("2", document.querySelector(".inbox-row-select")!)
      expect(inbox.sent).toEqual([])
      expect(inbox.row("Test catalog").textContent).toContain("↵ again to send it")
      inbox.key("2")

      expect(inbox.sent).toEqual([{ kind: "ask", answer: { type: "reply", option: 1, text: "" } }])
      await inbox.done()
    })

    it("goes to the terminal on the first press, hard to undo or not, answering nothing", async () => {
      const inbox = mount([asked(options, { hard: "It sets the schema." })])
      const away = String(inbox.rows().length)
      inbox.key(away, document.querySelector(".inbox-row-select")!)

      expect(inbox.revealed).toEqual(["t-owl"])
      expect(inbox.sent).toEqual([])
      await inbox.done()
    })

    it("keeps an overlong reply editable and won't send it", async () => {
      const inbox = mount([asked({ type: "text" })])

      inbox.type("x".repeat(4100))
      inbox.key("Enter", inbox.field())

      expect(inbox.sent).toEqual([])
      expect(text(".console-own-hint")).toBe(
        "4 over the 4,096 character limit. Shorten it to send.",
      )
      expect(inbox.field().value).toHaveLength(4100)
      await inbox.done()
    })

    it("shows something only the person can do with Copy, and the button that says it's done", async () => {
      const inbox = mount([
        asked({
          type: "action",
          command: "vercel login",
          directory: "~/site",
          doneLabel: "I've logged in",
        }),
      ])

      expect(text(".console-tag")).toBe("Your move")
      expect(text(".console-command .console-code")).toBe("$ vercel login")
      expect(document.querySelector(".console-command [aria-label='Copy command']")).not.toBeNull()
      inbox.press("I've logged in")
      expect(inbox.sent).toEqual([{ kind: "ask", answer: { type: "done" } }])
      await inbox.done()
    })
  })

  context("for an agent's questions", () => {
    it("sends one question's pick at once", async () => {
      const inbox = mount([questions(question("library", ["date-fns", "Temporal"]))])
      inbox.key("2", document.querySelector(".inbox-row-select")!)

      expect(inbox.sent).toEqual([
        {
          kind: "request",
          answer: {
            type: "questions",
            dialog: "d",
            answers: [{ question: "library", options: ["Temporal"] }],
          },
        },
      ])
      await inbox.done()
    })

    it("ticks several with numbers and Space, and sends them with the person's words on Enter", async () => {
      const inbox = mount([
        questions(question("suites", ["Unit", "E2E", "Visual"], { multiSelect: true, text: true })),
      ])
      inbox.key("1", document.querySelector(".inbox-row-select")!)
      inbox.key("3")
      expect(inbox.row("Unit").getAttribute("aria-checked")).toBe("true")
      expect(inbox.row("Visual").getAttribute("aria-checked")).toBe("true")
      inbox.key("4")
      inbox.type("and the a11y run")
      expect(text(".console-own-hint")).toBe(
        "↵ send 2 picked + your words · Esc back to the options",
      )
      inbox.key("Enter", inbox.field())

      expect(inbox.sent).toEqual([
        {
          kind: "request",
          answer: {
            type: "questions",
            dialog: "d",
            answers: [
              { question: "suites", options: ["Unit", "Visual"], text: "and the a11y run" },
            ],
          },
        },
      ])
      await inbox.done()
    })

    it("goes on to the next question on a pick, and sends them all from the last", async () => {
      const inbox = mount([
        questions(
          question("library", ["date-fns", "Temporal"]),
          question("zone", ["UTC", "Local"]),
        ),
      ])
      expect(text(".console-page > .console-note")).toBe("0 of 2 answered")
      inbox.key("2", document.querySelector(".inbox-row-select")!)
      expect(inbox.sent).toEqual([])
      expect(text(".console-page > .console-note")).toBe(
        "1 of 2 answered · still to answer: Which zone?",
      )
      expect(document.activeElement).toBe(inbox.row("UTC"))
      inbox.key("2")

      expect(inbox.sent).toMatchObject([
        {
          kind: "request",
          answer: {
            answers: [
              { question: "library", options: ["Temporal"] },
              { question: "zone", options: ["Local"] },
            ],
          },
        },
      ])
      await inbox.done()
    })
  })

  context("for an agent's several questions", () => {
    const two = () =>
      questions(question("q1", ["A1", "B1", "C1"]), question("q2", ["A2", "B2", "C2"]))

    it("goes to the terminal from any question, and Enter there goes even among several picks", async () => {
      const inbox = mount([
        questions(
          question("q1", ["A1", "B1"]),
          question("q2", ["A2", "B2"], { multiSelect: true }),
        ),
      ])
      act(() => optionIn(0, "Go to terminal").click())
      expect(inbox.revealed).toEqual(["t-moth"])

      act(() => optionIn(1, "A2").click())
      const away = optionIn(1, "Go to terminal")
      expect(away.getAttribute("role")).toBe("menuitem")
      expect(away.textContent).not.toContain("[ ]")
      inbox.key("End", optionIn(1, "A2"))
      expect(document.activeElement).toBe(away)
      inbox.key("Enter")
      expect(inbox.revealed).toEqual(["t-moth", "t-moth"])
      expect(inbox.sent).toEqual([])
      await inbox.done()
    })

    it("sends the moment every question is answered, in whatever order, and never an unpicked row", async () => {
      const inbox = mount([two()])
      act(() => optionIn(1, "C2").click())

      expect(inbox.sent).toEqual([])
      // Focus goes to the first question with no answer, not on from the one answered.
      expect(document.activeElement).toBe(optionIn(0, "A1"))
      act(() => optionIn(0, "B1").click())
      inbox.key("Enter", document.body)

      expect(inbox.sent).toMatchObject([
        {
          kind: "request",
          answer: {
            answers: [
              { question: "q1", options: ["B1"] },
              { question: "q2", options: ["C2"] },
            ],
          },
        },
      ])
      await inbox.done()
    })

    it("shows the picked row of a question of one pick, and says which questions are left", async () => {
      const inbox = mount([two()])
      act(() => optionIn(0, "B1").click())

      const rows = Array.from(menus()[0]!.querySelectorAll(".console-option"))
      expect(rows.map((row) => row.getAttribute("role"))).toEqual([
        ...Array(3).fill("menuitemradio"),
        "menuitem",
      ])
      expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual([
        "false",
        "true",
        "false",
        null,
      ])
      expect(optionIn(0, "B1").querySelector(".console-chosen")?.textContent).toContain("your pick")
      expect(optionIn(0, "A1").querySelector(".console-chosen")).toBeNull()
      expect(status()).toBe("1 of 2 answered · still to answer: Which q2?")
      await inbox.done()
    })

    it("says what is left on Enter in a box of words while others are open, and goes there", async () => {
      const inbox = mount([
        questions(question("q1", ["A1", "B1"]), question("q2", ["A2", "B2"], { text: true })),
      ])
      act(() => optionIn(1, "Reply in your own words").click())
      inbox.type("none of these; use C")
      expect(text(".console-own-hint")).toBe("↵ next question · Esc back to the options")
      inbox.key("Enter", inbox.field())

      expect(inbox.sent).toEqual([])
      expect(status()).toBe("1 of 2 answered · still to answer: Which q1?")
      expect(document.activeElement).toBe(optionIn(0, "A1"))
      act(() => optionIn(0, "B1").click())

      expect(inbox.sent).toMatchObject([
        {
          answer: {
            answers: [
              { question: "q1", options: ["B1"] },
              { question: "q2", options: [], text: "none of these; use C" },
            ],
          },
        },
      ])
      await inbox.done()
    })

    context("with several picks and words of their own", () => {
      const suites = () =>
        mount([questions(question("q1", ["A", "B"], { multiSelect: true, text: true }))])

      it("keeps the words when their row is unticked, leaves them out of the answer, and brings them back on ticking", async () => {
        const inbox = suites()
        act(() => inbox.row("A").click())
        act(() => inbox.row("Reply in your own words").click())
        inbox.type("my careful words")
        inbox.key("Escape", inbox.field())
        expect(inbox.row("my careful words").getAttribute("aria-checked")).toBe("true")

        act(() => inbox.row("my careful words").click())
        expect(inbox.row("my careful words").getAttribute("aria-checked")).toBe("false")
        expect(document.querySelector(".inbox-sheet textarea")).toBeNull()
        act(() => inbox.row("my careful words").click())
        expect(inbox.field().value).toBe("my careful words")
        inbox.key("Escape", inbox.field())
        expect(inbox.row("my careful words").getAttribute("aria-checked")).toBe("true")
        act(() => inbox.row("my careful words").click())
        inbox.key("Enter", inbox.row("A"))
        expect(inbox.sent).toEqual([
          {
            kind: "request",
            answer: {
              type: "questions",
              dialog: "d",
              answers: [{ question: "q1", options: ["A"] }],
            },
          },
        ])
        await inbox.done()
      })

      it("won't send words over the limit from a row, however it is asked to", async () => {
        const inbox = suites()
        act(() => inbox.row("A").click())
        act(() => inbox.row("Reply in your own words").click())
        inbox.type("x".repeat(5000))
        inbox.key("Enter", inbox.field())
        inbox.key("Escape", inbox.field())
        inbox.key("Enter", inbox.row("A"))

        expect(inbox.sent).toEqual([])
        await inbox.done()
      })

      it("takes the person to the words that are too long, not past them to the terminal", async () => {
        const inbox = mount([
          questions(
            question("q1", ["A1", "B1"], { multiSelect: true, text: true }),
            question("q2", ["A2", "B2"]),
          ),
        ])
        act(() => optionIn(0, "A1").click())
        act(() => optionIn(0, "Reply in your own words").click())
        inbox.type("x".repeat(5000))
        inbox.key("Escape", inbox.field())
        act(() => optionIn(1, "A2").click())

        expect(document.activeElement?.textContent).toContain("xxx")
        inbox.key("Enter")
        expect(inbox.revealed).toEqual([])
        expect(inbox.sent).toEqual([])
        await inbox.done()
      })
    })
  })

  context("for the length of a reply", () => {
    it("keeps the draft when the delivery size turns an otherwise valid reply down", async () => {
      const inbox = mount([asked({ type: "text" })])
      const words = "🦋".repeat(2048)
      inbox.type(words)
      inbox.key("Enter", inbox.field())
      expect(inbox.sent).toHaveLength(1)
      inbox.fail("a", "This reply exceeds the delivery size limit. Shorten it to send.")

      expect(inbox.field().value).toBe(words)
      expect(text(".inbox-failure")).toContain("delivery size limit")
      expect(text(".console-settled")).toBeNull()
      await inbox.done()
    })

    it("leaves the words to select and copy while the reply is on its way", async () => {
      const inbox = mount([asked({ type: "text" })])
      inbox.type("Use samples.")
      inbox.key("Enter", inbox.field())

      expect(inbox.field().readOnly).toBe(true)
      expect(inbox.field().disabled).toBe(false)
      expect(inbox.field().value).toBe("Use samples.")
      await inbox.done()
    })

    it("ties the box to its limit text", async () => {
      const inbox = mount([asked({ type: "text" })])
      inbox.type("x".repeat(4100))

      const hint = document.getElementById(inbox.field().getAttribute("aria-describedby")!)
      expect(hint?.textContent).toBe("4 over the 4,096 character limit. Shorten it to send.")
      await inbox.done()
    })
  })

  context("for a row that takes the place of one answered", () => {
    it("shows as waiting, not as the old answer", async () => {
      const inbox = mount([
        permission(codex, { id: "a", handle: "crow", at: 0 }),
        permission(codex, { id: "b", handle: "fox", at: 1 }),
      ])
      inbox.press("Allow")
      inbox.confirm("a")
      await nextFrame()
      expect(document.querySelector(".inbox-sheet")?.getAttribute("data-state")).toBe("asking")
      act(() =>
        inbox.state.update((current) => ({
          ...current,
          items: [...current.items, permission(codex, { id: "a", handle: "crow", at: 50 })],
        })),
      )
      act(() =>
        document.querySelector<HTMLElement>("[data-inbox-row='a'] .inbox-row-select")!.click(),
      )

      expect(text(".console-settled")).toBeNull()
      expect(sheet()?.getAttribute("data-state")).toBe("asking")
      expect(inbox.rows().map((row) => row.querySelector(".console-t")?.textContent)).toContain(
        "Allow",
      )
      await inbox.done()
    })
  })

  context("for the room of an agent's context", () => {
    const limited = (minutes: number): InboxRow => ({
      id: "l",
      source: source("moth"),
      at: 0,
      stopped: true,
      seen: false,
      kind: "trouble",
      trouble: {
        type: "limit",
        minutes,
        resetsAt: Date.now() + 3_600_000,
        autoResume: null,
        evidence: [],
      },
    })

    it("names a window of unknown length plainly", async () => {
      const inbox = mount([limited(0)])

      expect(text(".console-body")).toContain("used up its usage window")
      expect(text(".console-body")).not.toContain("0-hour")
      await inbox.done()
    })

    const turn = (fields: Partial<ChatItem>): ChatItem => ({
      id: String(Math.random()),
      at: 1,
      role: "user",
      kind: "text",
      text: "",
      truncated: false,
      tool: null,
      call: null,
      author: null,
      run: null,
      interrupted: false,
      ...fields,
    })

    it("is kept from the start and as the context fills in, so the menu never moves", async () => {
      const transcript = createStore<Conversation>(noConversation)
      const conversations = { conversation: () => transcript }
      const inbox = mount([permission(codex)], { conversations })
      const kept = () => document.querySelector(".console-tail[data-reserved]") !== null
      expect(kept()).toBe(true)

      act(() =>
        transcript.update(() => ({
          agent: "codex",
          session: "x",
          loaded: true,
          items: [turn({ text: "run the suite and report back please", at: 10 })],
          requests: [],
        })),
      )
      expect(text(".console-you")).toContain("run the suite")
      expect(kept()).toBe(true)
      act(() =>
        transcript.update((current) => ({
          ...current,
          items: [
            ...current.items,
            turn({
              role: "assistant",
              kind: "tool-call",
              tool: "Bash",
              call: "c",
              at: 11,
              text: JSON.stringify({ command: "pnpm test" }),
              run: { kind: "run", title: "Ran", detail: "pnpm test" },
            }),
            turn({ role: "tool", kind: "tool-result", call: "c", at: 12, text: "passed" }),
          ],
        })),
      )
      expect(document.querySelectorAll(".console-step")).toHaveLength(1)
      expect(kept()).toBe(true)
      await inbox.done()
    })

    it("is given back where the agent has no transcript", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      const inbox = mount([permission(codex)])
      expect(document.querySelector(".console-tail[data-reserved]")).not.toBeNull()
      act(() => vi.advanceTimersByTime(contextWaitMs))

      expect(document.querySelector(".console-tail")).toBeNull()
      vi.useRealTimers()
      await inbox.done()
    })
  })

  context("for trouble", () => {
    it("shows a failed turn's error once, red, and asks it to fix with what it sends", async () => {
      const inbox = mount([
        {
          id: "f",
          source: source("fox"),
          at: 0,
          stopped: true,
          seen: false,
          kind: "trouble",
          trouble: { type: "failed", error: "API Error: 529 Overloaded" },
        },
      ])

      expect(text(".console-tag")).toBe("Error")
      expect(text("pre.console-box")).toBe("API Error: 529 Overloaded")
      expect(inbox.row("Ask it to fix").querySelector(".console-s")?.textContent).toContain(
        "Look at what went wrong and fix it.",
      )
      await inbox.done()
    })

    it("offers Continue now only once a limit has reset", async () => {
      const limit = (resetsAt: number): InboxRow => ({
        id: "l",
        source: source("fox"),
        at: 0,
        stopped: true,
        seen: false,
        kind: "trouble",
        trouble: { type: "limit", minutes: 300, resetsAt, autoResume: null, evidence: [] },
      })
      const before = mount([limit(Date.now() + 3_600_000)])
      expect(text(".console-tag")).toBe("Limit")
      expect(before.rows().map((row) => row.querySelector(".console-t")?.textContent)).toEqual([
        "Go to terminal",
      ])
      expect(text(".console-body")).toContain("from here once it resets")
      await before.done()

      const after = mount([limit(Date.now() - 60_000)])
      after.press("Continue now")
      expect(after.sent).toEqual([{ kind: "trouble", action: { type: "continue" } }])
      await after.done()
    })
  })

  context("as keys come", () => {
    it("puts focus on the next sheet's first row, and takes no answer as it arrives", async () => {
      const inbox = mount([
        permission(codex, { id: "first", handle: "crow" }),
        permission(codex, { id: "second", handle: "fox", at: 5 }),
      ])
      // Opened from the keyboard, its title takes focus a frame later.
      await nextFrame()
      inbox.key("1", document.querySelector(".inbox-row-select")!)
      inbox.confirm("first")
      await nextFrame()

      expect(text(".inbox-sheet-head .handle-chip")).toBe("@fox")
      expect(document.activeElement).toBe(inbox.row("Allow"))
      // The same key again, meant for @crow's, answers nothing on @fox's.
      inbox.key("1")
      expect(inbox.sent).toHaveLength(1)
      const later = Date.now() + 1000
      vi.spyOn(Date, "now").mockReturnValue(later)
      inbox.key("1")
      expect(inbox.sent).toHaveLength(2)
      await inbox.done()
    })

    it("takes no click as it arrives either: a double-click's second lands on nothing", async () => {
      const inbox = mount([
        permission(codex, { id: "first", handle: "crow" }),
        permission(codex, { id: "second", handle: "fox", at: 5 }),
      ])
      act(() => inbox.row("Allow").click())
      inbox.confirm("first")
      await nextFrame()

      expect(text(".inbox-sheet-head .handle-chip")).toBe("@fox")
      // The double-click's second click, on @fox's sheet, answers nothing.
      act(() => inbox.row("Allow").click())
      expect(inbox.sent).toHaveLength(1)
      const later = Date.now() + 1000
      vi.spyOn(Date, "now").mockReturnValue(later)
      act(() => inbox.row("Allow").click())
      expect(inbox.sent).toHaveLength(2)
      await inbox.done()
    })

    it("routes no key pressed with focus nowhere to the menu", async () => {
      const inbox = mount([permission(codex)])
      inbox.key("1", document.body)

      expect(inbox.sent).toEqual([])
      await inbox.done()
    })

    it("never answers on a held key, nor sends what its first press armed", async () => {
      const inbox = mount([
        asked(
          {
            type: "options",
            recommend: null,
            options: [
              { label: "Drop it", summary: null, details: null, code: null },
              { label: "Keep", summary: null, details: null, code: null },
            ],
          },
          { hard: "It drops data." },
        ),
      ])
      inbox.key("1", document.querySelector(".inbox-row-select")!)
      inbox.key("1", document.activeElement!, { repeat: true })
      inbox.key("Enter", document.activeElement!, { repeat: true })
      expect(inbox.sent).toEqual([])
      inbox.key("1")
      expect(inbox.sent).toHaveLength(1)
      await inbox.done()
    })

    it("answers nothing from inside an option's details", async () => {
      const inbox = mount([
        asked({
          type: "options",
          recommend: null,
          options: [
            {
              label: "One",
              summary: null,
              details: "See it.",
              code: { path: "a.ts", text: "const a = 1" },
            },
            { label: "Two", summary: null, details: null, code: null },
          ],
        }),
      ])
      const code = document.querySelector<HTMLElement>(".console-more pre")!
      act(() => code.focus())
      inbox.key(" ", code)
      inbox.key("Enter", code)
      inbox.key("2", code)

      expect(inbox.sent).toEqual([])
      await inbox.done()
    })
  })

  context("for an answered row opened again", () => {
    it("says what its answer did, stays on it, and lets j go past it", async () => {
      const inbox = mount(
        [
          permission(codex, { id: "x", handle: "xx", at: 0 }),
          permission(codex, { id: "y", handle: "yy", at: 1 }),
          permission(codex, { id: "z", handle: "zz", at: 2 }),
        ],
        { open: 1 },
      )
      inbox.press("Allow")
      inbox.confirm("y")
      await nextFrame()
      expect(text(".inbox-sheet-head .handle-chip")).toBe("@xx")
      inbox.key("j", document.body)
      await nextFrame()

      expect(text(".inbox-sheet-head .handle-chip")).toBe("@yy")
      expect(text(".console-settled")).toBe("Allowed @yy's command.")
      expect(document.querySelector(".inbox-sheet [role=menu]")).toBeNull()
      inbox.key("j", document.body)
      await nextFrame()
      expect(text(".inbox-sheet-head .handle-chip")).toBe("@zz")
      await inbox.done()
    })
  })

  context("for a dialog whose options it can't tell apart", () => {
    it("says to answer it in the terminal, and offers only the way there", async () => {
      const inbox = mount([
        permission([
          { id: "run", label: "Run it", text: null },
          { id: "c", label: "Cancel", text: null },
        ]),
      ])

      expect(text(".console-note")).toBe(
        "Novadeck can't answer this prompt from here. Answer it in the terminal.",
      )
      expect(inbox.rows().map((row) => row.textContent)).toEqual(["❯1Go to terminal"])
      inbox.press("Go to terminal")
      expect(inbox.revealed).toEqual(["t-crow"])
      expect(inbox.sent).toEqual([])
      await inbox.done()
    })
  })

  context("for an update", () => {
    it("marks it read, or reads it and shows the terminal for a follow-up", async () => {
      const inbox = mount([
        {
          id: "u",
          source: source("wren"),
          at: 0,
          stopped: false,
          seen: false,
          kind: "update",
          update: { type: "done", subject: "Done", body: "All of it." },
        },
      ])
      expect(text(".console-tag")).toBe("Update")
      inbox.press("Give @wren a follow-up")

      expect(inbox.sent).toEqual([{ kind: "update", action: "read" }])
      expect(inbox.revealed).toEqual(["t-wren"])
      await inbox.done()
    })
  })

  context("with an empty box for words", () => {
    it("asks for an answer rather than offering to send nothing", async () => {
      const inbox = mount([asked({ type: "text" })])

      expect(text(".console-own-hint")).toBe("type your answer · Esc back to the options")
      inbox.type("Samples.")
      expect(text(".console-own-hint")).toBe("↵ send · Esc back to the options")
      await inbox.done()
    })
  })

  context("as answered rows pile up", () => {
    const listed = () =>
      Array.from(document.querySelectorAll("[data-inbox-row]")).map((row) =>
        row.getAttribute("data-inbox-row"),
      )

    it("keeps each in its place, answered, until the sheet closes, however it is left", async () => {
      const inbox = mount([
        permission(codex, { id: "x", handle: "xx", at: 0 }),
        permission(codex, { id: "y", handle: "yy", at: 1 }),
        permission(codex, { id: "z", handle: "zz", at: 2 }),
        permission(codex, { id: "w", handle: "ww", at: 3 }),
      ])
      // Each press a second after the last, past the guard a sheet keeps as it arrives.
      let clock = Date.now()
      const allow = async (id: string): Promise<void> => {
        clock += 1000
        vi.spyOn(Date, "now").mockReturnValue(clock)
        inbox.press("Allow")
        inbox.confirm(id)
        await nextFrame()
      }
      await allow("x")
      await allow("y")
      await allow("z")
      expect(text(".inbox-sheet-head .handle-chip")).toBe("@ww")
      const step = async (key: "j" | "k", handle: string): Promise<void> => {
        inbox.key(key, document.body)
        await nextFrame()
        expect(text(".inbox-sheet-head .handle-chip")).toBe(handle)
        expect(listed()).toEqual(["x", "y", "z", "w"])
      }
      await step("k", "@zz")
      await step("k", "@yy")
      await step("j", "@zz")
      expect(text(".console-settled")).toBe("Allowed @zz's command.")
      await inbox.done()
    })

    it("moves on from a newer row that took an answered one's id", async () => {
      const inbox = mount([
        permission(codex, { id: "a", handle: "crow", at: 0 }),
        permission(codex, { id: "b", handle: "fox", at: 1 }),
      ])
      inbox.press("Allow")
      inbox.confirm("a")
      await nextFrame()
      expect(text(".inbox-sheet-head .handle-chip")).toBe("@fox")
      act(() =>
        inbox.state.update((current) => ({
          ...current,
          items: [...current.items, permission(codex, { id: "a", handle: "crow", at: 50 })],
        })),
      )
      act(() =>
        document.querySelector<HTMLElement>("[data-inbox-row='a'] .inbox-row-select")!.click(),
      )
      expect(document.querySelector(".inbox-sheet [role=menu]")).not.toBeNull()
      inbox.press("Allow")
      inbox.confirm("a")
      await nextFrame()

      expect(text(".inbox-sheet-head .handle-chip")).toBe("@fox")
      expect(text(".console-receipt")).toBe("Allowed @crow's command.")
      await inbox.done()
    })
  })
})
