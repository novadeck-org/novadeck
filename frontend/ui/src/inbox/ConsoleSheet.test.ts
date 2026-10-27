import type { ChatDialogOption, ChatQuestion } from "@novadeck/core/conversation"
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
import { afterEach } from "vitest"

import { context, describe, expect, it } from "../test"
import { InboxList } from "./InboxList"
import { InboxProvider } from "./InboxProvider"
import { InboxSheet } from "./InboxSheet"

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
  mounted?.unmount()
  mounted = null
})

// The Inbox over these items with the first one's sheet open, and the answers it gives.
const mount = (items: readonly InboxRow[], { failing = false } = {}) => {
  const state = createStore<InboxState>({ ...emptyInbox, items })
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
  const view = render(
    createElement(
      InboxProvider,
      { inbox, reveal: () => {} },
      createElement("div", { id: "inbox-panel" }, createElement(InboxList)),
      createElement(InboxSheet, { active: true }),
    ),
  )
  mounted = view
  act(() => view.container.querySelector<HTMLElement>(".inbox-row-select")!.click())
  const rows = () => Array.from(document.querySelectorAll<HTMLElement>(".console-option"))
  const row = (text: string) => rows().find((each) => each.textContent?.includes(text))!
  const press = (text: string): void => act(() => row(text).click())
  const key = (name: string, target: Element = document.activeElement ?? document.body): void =>
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
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
  // The backend takes the answer: the item leaves.
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
  return { view, state, sent, rows, row, press, key, field, type, confirm, fail, done }
}

const sheet = () => document.querySelector<HTMLElement>(".inbox-sheet")
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
        "No, and tell Codex what to do differently",
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
      inbox.press("tell Codex")
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
      inbox.press("tell Codex")
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
    it("needs words where its only way back is them, and says why Antigravity refuses some", async () => {
      const review: readonly ChatDialogOption[] = [
        { id: "approve", label: "Approve", text: null },
        { id: "reject", label: "Reject", text: null },
        { id: "feedback", label: "Tell it what to change", text: "field" },
      ]
      const inbox = mount([permission(review, { kind: "plan", agent: "agy" })])

      expect(text(".console-tag")).toBe("Plan")
      expect(text(".console-planbar")).toContain("plan")
      inbox.press("Tell it what to change")
      inbox.type("/compact")
      expect(text(".console-own-hint")).toBe(
        "Antigravity can't take words that start with /, ? or !, or that have an @.",
      )
      inbox.key("Enter", inbox.field())
      expect(inbox.sent).toEqual([])
      inbox.type("Split the second step")
      inbox.key("Enter", inbox.field())

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
    it("opens the next item that needs the person, with a receipt naming the agent", async () => {
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
      expect(text(".console-page > .console-note")).toBe("1 of 2 answered")
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
      expect(document.querySelector("[role=menu]")).toBeNull()
      expect(text(".console-body")).toContain("from here once it resets")
      await before.done()

      const after = mount([limit(Date.now() - 60_000)])
      after.press("Continue now")
      expect(after.sent).toEqual([{ kind: "trouble", action: { type: "continue" } }])
      await after.done()
    })
  })
})
