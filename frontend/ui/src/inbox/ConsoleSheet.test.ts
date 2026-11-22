import {
  noConversation,
  type ChatDialog,
  type ChatDialogOption,
  type ChatFormField,
  type ChatItem,
  type ChatQuestion,
  type Conversation,
  type Conversations,
  noDoorbell,
} from "@novadeck/core/conversation"
import {
  emptyInbox,
  type AskShape,
  type Inbox,
  type InboxAnswer,
  type InboxEntry,
  type InboxState,
} from "@novadeck/core/inbox"
import { createStore } from "@novadeck/core/store"
import { nextFrame, render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { AgentContextProvider } from "./agent-context"
import { movedGuardMs } from "./ConsoleSheet"
import { InboxList } from "./InboxList"
import { InboxProvider } from "./InboxProvider"
import { InboxSheet } from "./InboxSheet"

// What the sheet records of the plan approvals it answered.
const { planAnswered } = vi.hoisted(() => ({
  planAnswered: vi.fn<(entry: InboxEntry) => void>(),
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

type Agent = InboxEntry["source"]["agent"]

const source = (handle: string, agent: Agent = "codex"): InboxEntry["source"] => ({
  projectId: "p",
  workspaceSessionId: "s",
  terminalId: `t-${handle}`,
  handle,
  agent,
  title: `Task of ${handle}`,
  projectName: "Project",
})

// A request entry of the agent `agent`, asking with `dialog`.
const requested = (
  dialog: ChatDialog | null,
  {
    id = "i",
    handle = "crow",
    kind = "permission",
    agent = "codex",
    at = 0,
    tool = kind === "plan" ? "ExitPlanMode" : kind === "question" ? "AskUserQuestion" : "Bash",
    subject = "pnpm add x",
  }: {
    id?: string
    handle?: string
    kind?: "permission" | "question" | "plan"
    agent?: Agent
    at?: number
    tool?: string
    subject?: string | null
  } = {},
): InboxEntry => ({
  id,
  source: source(handle, agent),
  at,
  stopped: true,
  seen: false,
  kind: "request",
  request: {
    id: "r",
    kind,
    tool,
    subject,
    choices: [],
    subagent: false,
    answered: false,
    askedAt: 0,
    dialog,
  },
})

type Asking = Omit<NonNullable<Parameters<typeof requested>[1]>, "tool" | "subject">

// A permission, or a plan, whose dialog offers `options`.
const permission = (options: readonly ChatDialogOption[], asking: Asking = {}): InboxEntry =>
  requested({ type: "choices", id: "d", title: null, detail: "pnpm add x", options }, asking)

const asked = (shape: AskShape, { id = "a", hard = null as string | null, at = 1 } = {}) =>
  ({
    id,
    source: source("owl"),
    at,
    stopped: true,
    seen: false,
    kind: "ask",
    ask: { subject: "Which catalog?", body: "Choose one.", details: null, hardToUndo: hard, shape },
  }) satisfies InboxEntry

const questions = (
  list: readonly ChatQuestion[],
  {
    chat = "prompt" as "prompt" | "field" | null,
    ...asking
  }: Asking & { chat?: "prompt" | "field" | null } = {},
): InboxEntry =>
  requested(
    { type: "questions", id: "d", chat, questions: list },
    { id: "q", handle: "moth", kind: "question", subject: null, ...asking },
  )

const question = (id: string, labels: readonly string[], more: Partial<ChatQuestion> = {}) => ({
  id,
  header: null,
  question: `Which ${id}?`,
  multiSelect: false,
  text: false,
  options: labels.map((label) => ({ id: label, label, description: null })),
  ...more,
})

const formField = (id: string, more: Partial<ChatFormField> = {}): ChatFormField => ({
  id,
  label: id[0]!.toUpperCase() + id.slice(1),
  description: null,
  kind: "text",
  choices: [],
  required: false,
  ...more,
})

// An MCP server asking for a form to be filled in.
const form = (fields: readonly ChatFormField[], asking: Asking = {}): InboxEntry =>
  requested(
    { type: "form", id: "f", message: "Name the deploy", fields },
    { id: "form", handle: "crow", kind: "question", tool: "Elicitation", subject: null, ...asking },
  )

// Each harness's own labels, as its dialogs word them (`chat-contract/src/wordings`).
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
const claude: readonly ChatDialogOption[] = [
  { id: "yes", label: "Yes", text: null },
  {
    id: "always",
    label: "Yes, and don't ask again for pnpm add commands in /sandbox/project",
    text: null,
  },
  { id: "no", label: "No", text: null },
  { id: "differently", label: "No, and tell Claude what to do", text: "prompt" },
]
const antigravity: readonly ChatDialogOption[] = [
  { id: "yes", label: "Yes, run command", text: null },
  {
    id: "always",
    label: "Yes, and always allow in this conversation for commands that start with 'echo'",
    text: null,
  },
  { id: "no", label: "No, cancel", text: "prompt" },
]
const claudePlan: readonly ChatDialogOption[] = [
  { id: "bypass", label: "Yes, and bypass permissions", text: null },
  { id: "auto", label: "Yes, auto-accept edits", text: null },
  { id: "manual", label: "Yes, manually approve edits", text: null },
  { id: "change", label: "Tell Claude what to change", text: "field" },
]
const antigravityPlan: readonly ChatDialogOption[] = [
  { id: "approve", label: "Approve", text: null },
  { id: "reject", label: "Reject", text: null },
  { id: "feedback", label: "Tell it what to change", text: "field" },
]

// What a test mounted, unmounted after it however it ended.
let mounted: { readonly unmount: () => void } | null = null
afterEach(() => {
  vi.restoreAllMocks()
  planAnswered.mockClear()
  mounted?.unmount()
  mounted = null
})

// What a row of the card's menu says: its words, or what its field is for.
const nameOf = (row: Element): string | undefined =>
  row.querySelector(".request-option-words")?.textContent ??
  row.querySelector("textarea")?.placeholder

// Sets what an input or a field holds, as the person typing would.
const write = (element: HTMLInputElement | HTMLTextAreaElement, value: string): void =>
  act(() => {
    const prototype =
      element instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
    Object.getOwnPropertyDescriptor(prototype.prototype, "value")!.set!.call(element, value)
    element.dispatchEvent(new Event("input", { bubbles: true }))
  })

// The Inbox over these entries with the nth one's sheet open, and the answers it gives.
const mount = (
  inboxEntries: readonly InboxEntry[],
  {
    failing = false,
    open = 0,
    conversations,
    openLogs,
  }: {
    failing?: boolean
    open?: number
    conversations?: Pick<Conversations, "conversation"> & Partial<Pick<Conversations, "saveDialog">>
    openLogs?: () => void
  } = {},
) => {
  const revealed: string[] = []
  // The list puts the entry added last first; these entries are given oldest first, as they were
  // added, so the one with the greater `at` is listed below.
  const state = createStore<InboxState>({
    ...emptyInbox,
    items: inboxEntries.map((entry) => ({ ...entry, at: 1000 - entry.at })),
  })
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
  }
  const page = createElement(
    InboxProvider,
    { inbox, reveal: (terminal: string) => revealed.push(terminal) },
    createElement("div", { id: "inbox-panel" }, createElement(InboxList)),
    createElement(InboxSheet, { active: true }),
  )
  const view = render(
    conversations ? createElement(AgentContextProvider, { conversations, openLogs }, page) : page,
  )
  mounted = view
  // The nth of the entries as given, whatever place the list puts it in.
  const openRow = (at: number): void =>
    act(() =>
      view.container
        .querySelector<HTMLElement>(`[data-inbox-row="${inboxEntries[at]!.id}"] .inbox-row-select`)!
        .click(),
    )
  openRow(open)
  const rows = () =>
    Array.from(document.querySelectorAll<HTMLElement>(".inbox-sheet .request-option"))
  // A row by its words: a row that takes the person's own is a field, its words the placeholder.
  const row = (text: string) =>
    rows().find(
      (each) =>
        each.textContent?.includes(text) ||
        each.querySelector("textarea")?.placeholder.includes(text),
    )!
  const names = () => rows().map(nameOf)
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
  // The sheet's row in the list, where its number and arrow keys are the card's.
  const listed = (at = 0) => document.querySelectorAll(".inbox-row-select")[at]!
  const fieldOf = () => document.querySelector<HTMLTextAreaElement>(".inbox-sheet textarea")!
  const type = (text: string): void => write(fieldOf(), text)
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
  // Leaves the sheet, and comes back to the nth row's.
  const reopen = async (at = 0): Promise<void> => {
    act(() => document.querySelector<HTMLElement>(".inbox-sheet [aria-label='Close']")!.click())
    await nextFrame()
    expect(sheet()).toBeNull()
    openRow(at)
    await nextFrame()
    expect(sheet()).not.toBeNull()
  }
  const done = async (): Promise<void> => {
    await nextFrame()
    view.unmount()
    mounted = null
  }
  return {
    view,
    state,
    sent,
    revealed,
    rows,
    row,
    names,
    press,
    key,
    listed,
    field: fieldOf,
    type,
    confirm,
    fail,
    reopen,
    done,
  }
}

// After this long past now, the guards a sheet keeps as it arrives or as its context moves it
// have let go.
const later = (ms = 1000): void => void vi.spyOn(Date, "now").mockReturnValue(Date.now() + ms)

const sheet = () => document.querySelector<HTMLElement>(".inbox-sheet")
const text = (selector: string) => document.querySelector(selector)?.textContent ?? null
const button = (name: string): HTMLButtonElement =>
  [...document.querySelectorAll("button")].find((each) => each.textContent?.includes(name))!

// The pages of a card's questions: its tabs, the page on screen, and a control by its words.
const tabs = () => Array.from(document.querySelectorAll<HTMLElement>(".inbox-sheet [role='tab']"))
const shownPage = () => document.querySelector(".inbox-sheet .request-page[data-shown]")
const pick = (label: string): HTMLInputElement =>
  Array.from(
    document.querySelectorAll<HTMLInputElement>(
      ".inbox-sheet input[type=radio], .inbox-sheet input[type=checkbox]",
    ),
  ).find((each) => each.closest("label")?.textContent?.includes(label))!
const control = (name: string): HTMLButtonElement =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".inbox-sheet button")).find((each) =>
    each.textContent?.includes(name),
  )!
const click = (element: Element): void => act(() => (element as HTMLElement).click())
// The words an "Other" input of the card's questions takes.
const other = () =>
  document.querySelector<HTMLInputElement>(".inbox-sheet input[aria-label^='Other']")!
// An input of a form, by the label of its field.
const textField = (label: string): HTMLInputElement =>
  Array.from(document.querySelectorAll(".inbox-sheet .request-form-field"))
    .find((each) => each.querySelector(".request-form-label")?.textContent?.startsWith(label))!
    .querySelector("input")!

// The cards of the Inbox's own kinds and the chat's are the same frame.
const card = () => document.querySelector<HTMLElement>(".inbox-sheet article.request-card")

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

    it("keeps its Show terminal, where the card's menu has no way there", async () => {
      const inbox = mount([permission(codex)])
      act(() => document.querySelector<HTMLElement>("[aria-label='Show terminal']")!.click())

      expect(inbox.revealed).toEqual(["t-crow"])
      expect(inbox.names()).not.toContain("Go to terminal")
      await inbox.done()
    })
  })

  context("for a command", () => {
    it("is the chat's card: its title, the command it asks, the harness's labels verbatim", async () => {
      const inbox = mount([permission(codex)])

      expect(card()?.dataset.kind).toBe("permission")
      expect(text(".request-head h3")).toBe("Needs your permission")
      expect(text(".request-detail-text")).toBe("pnpm add x")
      // The standing yes's scope is under it, not in its words; nothing is relabelled, and no
      // row goes to the terminal.
      expect(inbox.names()).toEqual([
        "Yes, proceed",
        "Yes, and don't ask again",
        "No, continue without running it",
        "No, and tell Codex what to do differently",
      ])
      expect(inbox.row("don't ask again").querySelector(".request-option-more")?.textContent).toBe(
        "for commands that start with `pnpm add`",
      )
      // A group of buttons, as the chat's: no ARIA menu, which the workspace takes for an overlay.
      expect(document.querySelector(".request-options")?.getAttribute("role")).toBe("group")
      expect(document.querySelector(".request-options")?.getAttribute("aria-label")).toBe("Answers")
      await inbox.done()
    })

    it("takes words as long as a request's answer does, past what an ask's reply takes", async () => {
      const inbox = mount([permission(codex)])
      inbox.press("No, and tell Codex")
      inbox.type("x".repeat(5000))
      inbox.key("Enter", inbox.field())

      expect(inbox.sent).toEqual([
        {
          kind: "request",
          answer: { type: "choice", dialog: "d", option: "differently", text: "x".repeat(5000) },
        },
      ])
      await inbox.done()
    })

    it("won't send words past what a request's answer takes", async () => {
      const inbox = mount([permission(codex)])
      inbox.press("No, and tell Codex")
      inbox.type("x".repeat(16_385))
      inbox.key("Enter", inbox.field())

      expect(inbox.sent).toEqual([])
      expect(text(".request-field-hint")).toBe(
        "1 over the 16,384 character limit. Shorten it to send.",
      )
      await inbox.done()
    })

    it("answers at once on a number pressed on its row", async () => {
      const inbox = mount([permission(codex)])
      inbox.key("1", inbox.listed())

      expect(inbox.sent).toEqual([
        { kind: "request", answer: { type: "choice", dialog: "d", option: "yes" } },
      ])
      await inbox.done()
    })

    it("moves the cursor with the arrows and answers on Enter in the menu", async () => {
      const inbox = mount([permission(codex)])
      inbox.key("ArrowDown", inbox.listed())
      expect(document.activeElement).toBe(inbox.row("don't ask again"))
      inbox.key("ArrowDown")
      expect(inbox.row("No, continue").dataset.on).toBe("true")
      inbox.key("Enter")

      expect(inbox.sent).toEqual([
        { kind: "request", answer: { type: "choice", dialog: "d", option: "no" } },
      ])
      await inbox.done()
    })

    it("answers nothing on Enter on its row or title, so a key pressed twice to open it is safe", async () => {
      const inbox = mount([permission(codex)])
      inbox.key("Enter", inbox.listed())
      inbox.key("Enter", document.querySelector(".inbox-sheet-title")!)
      inbox.key(" ", document.querySelector(".inbox-sheet-title")!)

      expect(inbox.sent).toEqual([])
      await inbox.done()
    })

    it("takes its number and arrows from the sheet's title as from its row", async () => {
      const inbox = mount([permission(codex)])
      const title = document.querySelector(".inbox-sheet-title")!
      inbox.key("ArrowDown", title)
      expect(document.activeElement).toBe(inbox.row("don't ask again"))
      inbox.key("3", title)

      expect(inbox.sent).toEqual([
        { kind: "request", answer: { type: "choice", dialog: "d", option: "no" } },
      ])
      await inbox.done()
    })

    it("turns the row for words into a field in place, and sends them with the option that takes them", async () => {
      const inbox = mount([permission(codex)])
      inbox.press("No, and tell Codex")
      expect(document.activeElement).toBe(inbox.field())
      // The field is the row: its number, the harness's words as its placeholder.
      expect(inbox.field().placeholder).toBe("No, and tell Codex what to do differently")
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

    it("goes back to the rows on Esc in the field, keeping the words, and the sheet open", async () => {
      const inbox = mount([permission(codex)])
      inbox.press("No, and tell Codex")
      inbox.type("Use npm.")
      inbox.key("Escape", inbox.field())

      expect(sheet()).not.toBeNull()
      // Out of the field, to the row before it; the words stay in the field.
      expect(document.activeElement).toBe(inbox.row("No, continue"))
      expect(inbox.field().value).toBe("Use npm.")
      inbox.key("ArrowDown")
      expect(document.activeElement).toBe(inbox.field())
      await inbox.done()
    })

    it("says that an answer didn't take in the chat's own error line, and stays", async () => {
      const inbox = mount(
        [permission(codex, { id: "first" }), asked({ type: "text" }, { id: "second", at: 5 })],
        { failing: true },
      )
      inbox.press("Yes, proceed")

      const error = document.querySelector(".chat-error.request-error")
      expect(error?.textContent).toBe("The agent didn't take that.")
      expect(error?.getAttribute("role")).toBe("alert")
      expect(text(".console-tag")).toBe("Command")
      expect(text(".console-receipt")).toBeNull()
      await inbox.done()
    })
  })

  context("for each harness's own words", () => {
    it("shows Claude Code's labels as it words them, its standing yes's scope under it", async () => {
      const inbox = mount([permission(claude, { agent: "claude" })])

      expect(inbox.names()).toEqual([
        "Yes",
        "Yes, and don't ask again",
        "No",
        "No, and tell Claude what to do",
      ])
      expect(inbox.row("don't ask again").querySelector(".request-option-more")?.textContent).toBe(
        "for pnpm add commands in /sandbox/project",
      )
      await inbox.done()
    })

    it("shows Antigravity's labels as it words them, its standing yes whole", async () => {
      const inbox = mount([permission(antigravity, { agent: "agy" })])

      expect(inbox.names()).toEqual([
        "Yes, run command",
        "Yes, and always allow in this conversation for commands that start with 'echo'",
        "No, cancel",
      ])
      // The no that takes the person's words is a field.
      expect(inbox.row("No, cancel").querySelector("textarea")).not.toBeNull()
      inbox.key("2", inbox.listed())
      expect(inbox.sent).toEqual([
        { kind: "request", answer: { type: "choice", dialog: "d", option: "always" } },
      ])
      await inbox.done()
    })

    it("answers an option no rule knows as it words itself, never as the terminal's", async () => {
      const inbox = mount([
        permission([
          { id: "a", label: "Continue", text: null },
          { id: "b", label: "Stop", text: null },
        ]),
      ])

      expect(inbox.names()).toEqual(["Continue", "Stop"])
      inbox.press("Stop")
      expect(inbox.sent).toEqual([
        { kind: "request", answer: { type: "choice", dialog: "d", option: "b" } },
      ])
      await inbox.done()
    })
  })

  context("for a plan", () => {
    it("shows the plan's own labels, what its standing yes lets the agent do, and arms it", async () => {
      const inbox = mount([permission(claudePlan, { kind: "plan", agent: "claude" })])

      expect(text(".request-head h3")).toBe("Plan to review")
      expect(text(".console-tag")).toBe("Plan")
      expect(text(".request-plan .request-detail-bar")).toContain("plan")
      expect(inbox.names()).toEqual([
        "Yes, and bypass permissions",
        "Yes, auto-accept edits",
        "Yes, manually approve edits",
        "Tell Claude what to change",
      ])
      expect(inbox.row("bypass").querySelector(".request-option-effect")?.textContent).toBe(
        "It edits and runs commands without asking.",
      )
      expect(inbox.row("auto-accept").querySelector(".request-option-effect")?.textContent).toBe(
        "It edits without asking.",
      )
      expect(inbox.row("manually").querySelector(".request-option-effect")).toBeNull()

      inbox.key("1", inbox.listed())
      expect(inbox.sent).toEqual([])
      expect(inbox.row("bypass").dataset.armed).toBe("true")
      expect(inbox.row("bypass").textContent).toContain("↵ again to send it")
      inbox.key("1")

      expect(inbox.sent).toEqual([
        { kind: "request", answer: { type: "choice", dialog: "d", option: "bypass" } },
      ])
      // The plan it showed is spent: a round sent back is never the next approval's plan.
      expect(planAnswered).toHaveBeenCalledWith(expect.objectContaining({ id: "i" }))
      await inbox.done()
    })

    it("sends the plain yes at once, with nothing armed", async () => {
      const inbox = mount([permission(claudePlan, { kind: "plan", agent: "claude" })])
      inbox.key("3", inbox.listed())

      expect(inbox.sent).toEqual([
        { kind: "request", answer: { type: "choice", dialog: "d", option: "manual" } },
      ])
      await inbox.done()
    })

    it("takes the person's words in place of a way back that needs them, as Claude Code words it", async () => {
      const inbox = mount([permission(claudePlan, { kind: "plan", agent: "claude" })])
      inbox.press("Tell Claude what to change")
      // Only Antigravity refuses words for how they start.
      inbox.type("/compact the steps @file")
      expect(text(".request-field-hint")).toBe("")
      inbox.key("Enter", inbox.field())

      expect(inbox.sent).toEqual([
        {
          kind: "request",
          answer: {
            type: "choice",
            dialog: "d",
            option: "change",
            text: "/compact the steps @file",
          },
        },
      ])
      await inbox.done()
    })

    it("refuses, with its reason, words Antigravity can't take, and sends the rest", async () => {
      const inbox = mount([permission(antigravityPlan, { kind: "plan", agent: "agy" })])

      expect(text(".console-tag")).toBe("Plan")
      expect(inbox.names()).toEqual(["Approve", "Reject", "Tell it what to change"])
      inbox.press("Tell it what to change")
      const refusal = "Antigravity can't take words that start with /, ? or !, or that have an @."
      for (const words of ["/compact", "? help", "!ls", "see @plan.md"]) {
        inbox.type(words)
        expect(text(".request-field-hint")).toBe(refusal)
        inbox.key("Enter", inbox.field())
        expect(inbox.sent).toEqual([])
      }
      inbox.type("Split the second step")
      expect(text(".request-field-hint")).toBe("")
      expect(planAnswered).not.toHaveBeenCalled()
      inbox.key("Enter", inbox.field())

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

    it("needs words in the field before it sends", async () => {
      const inbox = mount([permission(antigravityPlan, { kind: "plan", agent: "agy" })])
      inbox.press("Tell it what to change")
      inbox.key("Enter", inbox.field())

      expect(inbox.sent).toEqual([])
      expect(text(".request-writing-hint")).toBe("type your answer · Esc back to the options")
      await inbox.done()
    })
  })

  context("for the receipt of an answer", () => {
    // The first entry's answer taken, the sheet moved on to a second: what it says it did.
    const receipted = async (
      first: InboxEntry,
      answer: (inbox: ReturnType<typeof mount>) => void,
    ): Promise<string | null> => {
      const inbox = mount([first, asked({ type: "text" }, { id: "second", at: 5 })])
      answer(inbox)
      inbox.confirm(first.id)
      const note = text(".console-receipt")
      await inbox.done()
      return note
    }
    const words = (label: string, typed: string) => (inbox: ReturnType<typeof mount>) => {
      inbox.press(label)
      inbox.type(typed)
      inbox.key("Enter", inbox.field())
    }
    const once = (label: string) => (inbox: ReturnType<typeof mount>) => inbox.press(label)
    const armed = (label: string) => (inbox: ReturnType<typeof mount>) => {
      inbox.press(label)
      inbox.press(label)
    }
    const plan = (options: readonly ChatDialogOption[], agent: Agent) =>
      permission(options, { kind: "plan", agent })

    const cases: readonly [
      string,
      () => InboxEntry,
      (inbox: ReturnType<typeof mount>) => void,
      string,
    ][] = [
      [
        "Claude Code's yes",
        () => permission(claude, { agent: "claude" }),
        once("Yes"),
        "Allowed @crow's command.",
      ],
      [
        "Claude Code's standing yes",
        () => permission(claude, { agent: "claude" }),
        once("don't ask again"),
        "Allowed @crow's command; it won't ask again.",
      ],
      [
        "Claude Code's no",
        () => permission(claude, { agent: "claude" }),
        once("No"),
        "Denied @crow's command.",
      ],
      [
        "Claude Code's no with words",
        () => permission(claude, { agent: "claude" }),
        words("No, and tell Claude", "Use npm."),
        "Denied @crow's command, with your words.",
      ],
      ["Codex's yes", () => permission(codex), once("Yes, proceed"), "Allowed @crow's command."],
      [
        "Codex's standing yes",
        () => permission(codex),
        once("don't ask again"),
        "Allowed @crow's command; it won't ask again.",
      ],
      ["Codex's no", () => permission(codex), once("No, continue"), "Denied @crow's command."],
      [
        "Codex's no with words",
        () => permission(codex),
        words("No, and tell Codex", "Use npm."),
        "Denied @crow's command, with your words.",
      ],
      [
        "Antigravity's yes",
        () => permission(antigravity, { agent: "agy" }),
        once("Yes, run command"),
        "Allowed @crow's command.",
      ],
      [
        "Antigravity's standing yes",
        () => permission(antigravity, { agent: "agy" }),
        once("always allow"),
        "Allowed @crow's command; it won't ask again.",
      ],
      [
        "Antigravity's no with words",
        () => permission(antigravity, { agent: "agy" }),
        words("No, cancel", "Not now."),
        "Denied @crow's command, with your words.",
      ],
      [
        "Claude Code's plan yes",
        () => plan(claudePlan, "claude"),
        once("manually approve"),
        "Approved @crow's plan.",
      ],
      [
        "Claude Code's plan standing yes",
        () => plan(claudePlan, "claude"),
        armed("auto-accept"),
        "Approved @crow's plan; it won't ask again.",
      ],
      [
        "Claude Code's plan sent back with words",
        () => plan(claudePlan, "claude"),
        words("Tell Claude what to change", "Split it."),
        "Sent back @crow's plan, with your words.",
      ],
      [
        "Antigravity's plan approval",
        () => plan(antigravityPlan, "agy"),
        once("Approve"),
        "Approved @crow's plan.",
      ],
      [
        "Antigravity's plan rejection",
        () => plan(antigravityPlan, "agy"),
        once("Reject"),
        "Sent back @crow's plan.",
      ],
    ]
    for (const [name, entry, answer, note] of cases)
      it(`says ${name} as "${note}"`, async () => {
        expect(await receipted(entry(), answer)).toBe(note)
      })

    it("says a tool's yes by the tool", async () => {
      const entry = requested(
        {
          type: "choices",
          id: "d",
          title: null,
          detail: null,
          options: [{ id: "yes", label: "Yes", text: null }],
        },
        { tool: "WebFetch", agent: "claude" },
      )
      expect(await receipted(entry, once("Yes"))).toBe("Allowed @crow's WebFetch.")
    })
  })

  context("after an answer has taken", () => {
    it("opens the next row that needs the person, with a receipt naming the agent", async () => {
      const inbox = mount([
        permission(codex, { id: "first", handle: "crow" }),
        asked({ type: "text" }, { id: "second", at: 5 }),
      ])
      inbox.press("Yes, proceed")
      expect(inbox.row("Yes, proceed").dataset.pressed).toBe("true")
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
      inbox.press("Yes, proceed")
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
      inbox.press("Yes, proceed")

      expect(text(".request-error")).toBe("The agent didn't take that.")
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
      expect(text(".request-error")).toBe(
        "Your reply was not delivered because the agent's session ended.",
      )
      expect(inbox.field().value).toBe("Use samples.")
      await inbox.done()
    })
  })

  context("for a card with nothing it can send", () => {
    it("says to answer a dialog it can't answer in the terminal, and offers only the way there", async () => {
      const inbox = mount([
        requested({ type: "raw", text: "Allow this?\n1. Yes", reason: "unsupported" }),
      ])

      expect(text(".request-raw-reason")).toBe(
        "Novadeck can't answer this dialog. Answer it in the terminal.",
      )
      expect(text(".request-raw")).toBe("Allow this?\n1. Yes")
      expect(document.querySelector(".inbox-sheet .request-options")).toBeNull()
      const terminal = document.querySelector<HTMLElement>("[aria-label='Answer in terminal']")!
      expect(terminal.textContent).toBe("terminal")
      act(() => terminal.click())
      expect(inbox.revealed).toEqual(["t-crow"])
      expect(inbox.sent).toEqual([])
      await inbox.done()
    })

    it("saves a dialog it can't read for debugging, on the person's click, and says where", async () => {
      const saved: [string, string][] = []
      const opened: string[] = []
      const inbox = mount(
        [requested({ type: "raw", text: "Allow this?\n1. Yes", reason: "unrecognized" })],
        {
          conversations: {
            conversation: () => createStore<Conversation>(noConversation),
            saveDialog: async (key, request) => {
              saved.push([key.terminalId, request])
              return "/logs/dialogs/saved.json"
            },
          },
          openLogs: () => opened.push("logs"),
        },
      )

      act(() => button("Save for debugging").click())
      await act(async () => {})
      expect(saved).toEqual([["t-crow", expect.any(String)]])
      expect(text(".request-raw-save")).toContain("Saved to /logs/dialogs/saved.json")
      act(() => button("Open logs folder").click())
      expect(opened).toEqual(["logs"])
      expect(inbox.sent).toEqual([])
      await inbox.done()
    })

    it("offers no saving where the backend can't", async () => {
      const inbox = mount([requested({ type: "raw", text: "x", reason: "unrecognized" })])

      expect(document.querySelector(".request-raw-save")).toBeNull()
      await inbox.done()
    })

    it("waits for a dialog not read yet, with the way to the terminal", async () => {
      const inbox = mount([requested(null)])

      expect(text(".request-waiting")).toBe("Waiting for the dialog…")
      act(() => document.querySelector<HTMLElement>("[aria-label='Answer in terminal']")!.click())
      expect(inbox.revealed).toEqual(["t-crow"])
      expect(inbox.sent).toEqual([])
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
      expect(text(".request-writing-hint")).toBe(
        "↵ send your words instead · Esc back to the options",
      )
      inbox.key("Enter", inbox.field())

      expect(inbox.sent).toEqual([
        { kind: "ask", answer: { type: "reply", option: null, text: "Neither." } },
      ])
      await inbox.done()
    })

    it("takes the person's own words in place: the row is its field, reached like any row", async () => {
      const inbox = mount([asked(options)])
      const own = inbox.row("Reply in your own words")
      const field = own.querySelector("textarea")!

      // The row's number, then the field in its place, named by the row's words.
      expect(own.querySelector(".request-option-number")?.textContent).toBe("3")
      expect(field.placeholder).toBe("Reply in your own words")
      expect(field.getAttribute("aria-label")).toBe("Reply in your own words")
      expect(own.querySelector(".request-own-foot")?.textContent).toBe("")
      // Its number, from the sheet's row, puts the person in it at once.
      inbox.key("3", inbox.listed())
      expect(document.activeElement).toBe(field)
      expect(inbox.sent).toEqual([])
      inbox.type("Both, please.")
      expect(own.dataset.chosen).toBe("true")
      expect(own.querySelector(".request-writing-hint")?.textContent).toBe(
        "↵ send your words instead · Esc back to the options",
      )
      // Up from its start goes back to the rows; down comes into it again.
      act(() => field.setSelectionRange(0, 0))
      inbox.key("ArrowUp", field)
      expect(document.activeElement).toBe(inbox.row("Test catalog"))
      inbox.key("ArrowDown")
      expect(document.activeElement).toBe(field)
      inbox.key("Enter", field)

      expect(inbox.sent).toEqual([
        { kind: "ask", answer: { type: "reply", option: null, text: "Both, please." } },
      ])
      await inbox.done()
    })

    it("arms a hard-to-undo answer on the first press and sends it on the second", async () => {
      const inbox = mount([asked(options, { hard: "It sets the schema." })])

      expect(text(".console-tag")).toBe("Question")
      expect(sheet()?.dataset.tint).toBe("attention")
      expect(text(".request-hard")).toBe("Hard to undo: It sets the schema.")
      inbox.key("2", inbox.listed())
      expect(inbox.sent).toEqual([])
      expect(inbox.row("Test catalog").textContent).toContain("↵ again to send it")
      inbox.key("2")

      expect(inbox.sent).toEqual([{ kind: "ask", answer: { type: "reply", option: 1, text: "" } }])
      await inbox.done()
    })

    it("arms again for a newer ask under the same id", async () => {
      const inbox = mount([asked(options, { hard: "It sets the schema." })])
      inbox.key("2", inbox.listed())
      expect(inbox.row("Test catalog").textContent).toContain("↵ again to send it")
      // The agent asks again under the same id: another ask, not the one that was armed.
      act(() =>
        inbox.state.update((current) => ({
          ...current,
          items: [asked(options, { hard: "It sets the schema.", at: 2 })],
        })),
      )
      expect(inbox.row("Test catalog").textContent).not.toContain("↵ again to send it")
      inbox.key("2")

      expect(inbox.sent).toEqual([])
      await inbox.done()
    })

    it("keeps a draft for its own ask only, not a newer one under the same id", async () => {
      const inbox = mount([asked(options)])
      inbox.press("Reply in your own words")
      inbox.type("Neither.")
      expect(document.querySelector(".inbox-row")?.textContent).toContain("Draft")
      act(() =>
        inbox.state.update((current) => ({ ...current, items: [asked(options, { at: 2 })] })),
      )
      expect(document.querySelector(".inbox-row")?.textContent).not.toContain("Draft")
      await inbox.done()
    })

    it("goes to the terminal on the first press, hard to undo or not, answering nothing", async () => {
      const inbox = mount([asked(options, { hard: "It sets the schema." })])
      const away = String(inbox.rows().length)
      inbox.key(away, inbox.listed())

      expect(inbox.revealed).toEqual(["t-owl"])
      expect(inbox.sent).toEqual([])
      await inbox.done()
    })

    it("keeps an overlong reply editable and won't send it", async () => {
      const inbox = mount([asked({ type: "text" })])

      inbox.type("x".repeat(4100))
      inbox.key("Enter", inbox.field())

      expect(inbox.sent).toEqual([])
      expect(text(".request-field-hint")).toBe(
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
      expect(text(".request-detail-text")).toBe("$ vercel login")
      expect(document.querySelector(".request-detail [aria-label='Copy command']")).not.toBeNull()
      inbox.press("I've logged in")
      expect(inbox.sent).toEqual([{ kind: "ask", answer: { type: "done" } }])
      await inbox.done()
    })
  })

  context("for an agent's questions", () => {
    const one = () => questions([question("library", ["date-fns", "Temporal"])])
    const two = () =>
      questions([question("q1", ["A1", "B1", "C1"]), question("q2", ["A2", "B2", "C2"])])

    it("is the chat's pages: a tab for each question, one to send them, one page on screen", async () => {
      const inbox = mount([two()])

      expect(text(".request-head h3")).toBe("Has a question")
      expect(tabs().map((tab) => tab.textContent)).toEqual(["Question 1", "Question 2", "Submit"])
      expect(shownPage()?.textContent).toContain("Which q1?")
      expect(document.querySelectorAll(".inbox-sheet .request-pages > .request-page")).toHaveLength(
        3,
      )
      // The harness's own words, "(Recommended)" among them, as they are.
      await inbox.done()
    })

    it("keeps '(Recommended)' in the label, verbatim", async () => {
      const inbox = mount([questions([question("lib", ["date-fns (Recommended)", "Temporal"])])])

      expect(pick("date-fns").closest("label")?.textContent).toContain("date-fns (Recommended)")
      await inbox.done()
    })

    it("goes to the review page on a pick of one question, and sends from it", async () => {
      const inbox = mount([one()])
      inbox.key("2", inbox.listed())

      expect(inbox.sent).toEqual([])
      expect(shownPage()?.textContent).toContain("Send these answers?")
      expect(shownPage()?.querySelector("dl")?.textContent).toContain("Temporal")
      expect(tabs()[0]!.textContent).toBe("✓Question 1")
      click(control("Submit answers"))

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

    it("goes on to the next question on a pick, and sends them all from the review", async () => {
      const inbox = mount([two()])
      inbox.key("2", inbox.listed())
      expect(inbox.sent).toEqual([])
      expect(shownPage()?.textContent).toContain("Which q2?")
      expect(text(".inbox-sheet [role=status].sr-only")).toBe("1 of 2 answered")
      // Focus is on the page now shown, so its keys go on from there.
      inbox.key("3")
      expect(shownPage()?.textContent).toContain("Send these answers?")
      expect(inbox.sent).toEqual([])
      inbox.key("1", inbox.listed())

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

    it("takes a number from the row for the question on screen, never a hidden page's", async () => {
      const inbox = mount([two()])
      click(pick("B1"))
      expect(shownPage()?.textContent).toContain("Which q2?")
      inbox.key("1", inbox.listed())

      expect(pick("A2").checked).toBe(true)
      expect(pick("A1").checked).toBe(false)
      expect(pick("B1").checked).toBe(true)
      await inbox.done()
    })

    // The page is part of the card's draft, which the Inbox keeps though nothing is picked.
    it("stays on the page a tab turned to, before anything is picked", async () => {
      const inbox = mount([two()])
      click(tabs()[1]!)

      expect(shownPage()?.textContent).toContain("Which q2?")
      await inbox.done()
    })

    it("moves along the shown page's rows with the arrows from its row or title", async () => {
      const inbox = mount([two()])
      inbox.key("ArrowDown", inbox.listed())
      const first = document.activeElement
      expect(first).toBe(pick("B1"))
      inbox.key("ArrowDown", document.querySelector(".inbox-sheet-title")!)
      expect(document.activeElement).toBe(pick("C1"))
      inbox.key("ArrowUp", inbox.listed())
      expect(document.activeElement).toBe(pick("B1"))
      expect(inbox.sent).toEqual([])
      await inbox.done()
    })

    it("ticks several with numbers, and sends them with the person's words", async () => {
      const inbox = mount([
        questions([
          question("suites", ["Unit", "E2E", "Visual"], { multiSelect: true, text: true }),
        ]),
      ])
      inbox.key("1", inbox.listed())
      inbox.key("3")
      expect(pick("Unit").checked).toBe(true)
      expect(pick("Visual").checked).toBe(true)
      // A page of several picks stays: only Enter in a row or the words goes on.
      expect(shownPage()?.textContent).toContain("Which suites?")
      write(other(), "and the a11y run")
      inbox.key("Enter", other())
      expect(shownPage()?.textContent).toContain("Send these answers?")
      click(control("Submit answers"))

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

    it("takes words of the person's own to go on, and says what the review holds", async () => {
      const inbox = mount([
        questions([question("q1", ["A1", "B1"]), question("q2", ["A2", "B2"], { text: true })]),
      ])
      click(tabs()[1]!)
      write(other(), "none of these; use C")
      inbox.key("Enter", other())
      expect(shownPage()?.textContent).toContain("Send these answers?")
      expect(shownPage()?.textContent).toContain("“none of these; use C”")
      expect(shownPage()?.textContent).toContain("not answered")
      // The first has none yet: the review can't send.
      expect(control("Submit answers").getAttribute("aria-disabled")).toBe("true")
      click(control("Submit answers"))
      expect(inbox.sent).toEqual([])

      click(tabs()[0]!)
      click(pick("B1"))
      click(tabs()[2]!)
      click(control("Submit answers"))
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

    it("starts over from the first page with nothing picked", async () => {
      const inbox = mount([two()])
      click(pick("A1"))
      click(pick("A2"))
      click(control("Start over"))

      expect(shownPage()?.textContent).toContain("Which q1?")
      expect(pick("A1").checked).toBe(false)
      expect(pick("A2").checked).toBe(false)
      expect(inbox.sent).toEqual([])
      await inbox.done()
    })

    it("takes the person's own words to the limit of a request's answer, as the chat does", async () => {
      const inbox = mount([questions([question("q1", ["A"], { text: true })])])

      expect(other().maxLength).toBe(16_384)
      await inbox.done()
    })

    it("sets the questions aside to talk them over, and shows the terminal", async () => {
      const inbox = mount([questions([question("q1", ["A", "B"])])])
      click(control("Chat about this"))

      expect(inbox.sent).toEqual([{ kind: "request", answer: { type: "chat", dialog: "d" } }])
      expect(inbox.revealed).toEqual(["t-moth"])
      await inbox.done()
    })

    it("leaves the sheet for the terminal after talking them over, as a follow-up does", async () => {
      const inbox = mount([
        questions([question("q1", ["A", "B"])]),
        asked({ type: "text" }, { id: "second", at: 5 }),
      ])
      click(control("Chat about this"))
      inbox.confirm("q")
      await nextFrame()

      expect(sheet()).toBeNull()
      await inbox.done()
    })

    it("names a question answered, and several answered, on the receipt", async () => {
      const first = mount([one(), asked({ type: "text" }, { id: "second", at: 5 })])
      first.key("1", first.listed())
      click(control("Submit answers"))
      first.confirm("q")
      expect(text(".console-receipt")).toBe("Answered @moth's question.")
      await first.done()

      const several = mount([two(), asked({ type: "text" }, { id: "second", at: 5 })])
      several.key("1", several.listed())
      several.key("1")
      click(control("Submit answers"))
      several.confirm("q")
      expect(text(".console-receipt")).toBe("Answered @moth's questions.")
      await several.done()
    })
  })

  context("for a form", () => {
    const deploy = () => [
      formField("name", { required: true }),
      formField("count", { kind: "number" }),
      formField("dry", { kind: "boolean" }),
    ]

    it("is answered in the card: its fields, and Submit and Decline", async () => {
      const inbox = mount([form(deploy())])

      expect(text(".request-head h3")).toBe("Has a question")
      expect(text(".request-dialog-title")).toBe("Name the deploy")
      expect(document.querySelectorAll(".inbox-sheet .request-form-field")).toHaveLength(3)
      expect(inbox.names()).toEqual(["Submit", "Decline"])
      expect(document.querySelector("[aria-label='Answer in terminal']")).toBeNull()
      await inbox.done()
    })

    it("sends what was filled in on Submit, and says so on the receipt", async () => {
      const inbox = mount([form(deploy()), asked({ type: "text" }, { id: "second", at: 5 })])
      expect(control("Submit").getAttribute("aria-disabled")).toBe("true")
      write(textField("Name"), "api")
      write(textField("Count"), "3")
      click(control("Submit"))

      expect(inbox.sent).toEqual([
        {
          kind: "request",
          answer: {
            type: "form",
            dialog: "f",
            action: "accept",
            values: { name: "api", count: 3 },
          },
        },
      ])
      inbox.confirm("form")
      expect(text(".console-receipt")).toBe("Filled in @crow's form.")
      await inbox.done()
    })

    it("sends nothing for a form missing what is required, and says what is missing", async () => {
      const inbox = mount([form(deploy())])
      click(control("Submit"))

      expect(inbox.sent).toEqual([])
      expect(
        document.querySelector(".inbox-sheet .request-form-field")?.hasAttribute("data-missing"),
      ).toBe(true)
      await inbox.done()
    })

    it("declines with nothing filled in, and says so on the receipt", async () => {
      const inbox = mount([form(deploy()), asked({ type: "text" }, { id: "second", at: 5 })])
      click(control("Decline"))

      expect(inbox.sent).toEqual([
        {
          kind: "request",
          answer: { type: "form", dialog: "f", action: "decline", values: {} },
        },
      ])
      inbox.confirm("form")
      expect(text(".console-receipt")).toBe("Declined @crow's form.")
      await inbox.done()
    })

    it("takes the number keys from its row for Submit and Decline", async () => {
      const inbox = mount([form([formField("note")])])
      inbox.key("2", inbox.listed())

      expect(inbox.sent).toMatchObject([{ answer: { type: "form", action: "decline" } }])
      await inbox.done()
    })
  })

  context("for what is typed and not yet sent", () => {
    const marked = () => document.querySelector(".inbox-row")?.textContent?.includes("Draft")

    it("keeps the words typed into an option when the sheet closes and opens again, and marks the row", async () => {
      const inbox = mount([permission(codex)])
      expect(marked()).toBe(false)
      inbox.press("No, and tell Codex")
      inbox.type("Use npm.")
      expect(marked()).toBe(true)
      await inbox.reopen()

      expect(inbox.field().value).toBe("Use npm.")
      expect(marked()).toBe(true)
      inbox.key("Enter", inbox.field())
      expect(inbox.sent).toMatchObject([{ answer: { option: "differently", text: "Use npm." } }])
      await inbox.done()
    })

    it("marks no Draft for words erased again", async () => {
      const inbox = mount([permission(codex)])
      inbox.press("No, and tell Codex")
      inbox.type("Use npm.")
      inbox.type("")

      expect(marked()).toBe(false)
      await inbox.done()
    })

    it("keeps the picks on questions, and the page they were on", async () => {
      const inbox = mount([
        questions([
          question("q1", ["A1", "B1"]),
          question("q2", ["A2", "B2"], { multiSelect: true }),
        ]),
      ])
      click(pick("B1"))
      expect(shownPage()?.textContent).toContain("Which q2?")
      click(pick("A2"))
      expect(marked()).toBe(true)
      await inbox.reopen()

      expect(shownPage()?.textContent).toContain("Which q2?")
      expect(pick("A2").checked).toBe(true)
      expect(pick("B1").checked).toBe(true)
      expect(tabs()[0]!.textContent).toBe("✓Question 1")
      await inbox.done()
    })

    it("keeps the words of a question's own row", async () => {
      const inbox = mount([questions([question("q1", ["A"], { text: true })])])
      write(other(), "something else")
      await inbox.reopen()

      expect(other().value).toBe("something else")
      expect(marked()).toBe(true)
      await inbox.done()
    })

    it("keeps what was entered in a form", async () => {
      const inbox = mount([
        form([formField("name", { required: true }), formField("dry", { kind: "boolean" })]),
      ])
      write(textField("Name"), "api")
      click(
        Array.from(
          document.querySelectorAll<HTMLInputElement>(".inbox-sheet input[type=radio]"),
        ).find((each) => each.closest("label")?.textContent === "Yes")!,
      )
      expect(marked()).toBe(true)
      await inbox.reopen()

      expect(textField("Name").value).toBe("api")
      click(control("Submit"))
      expect(inbox.sent).toMatchObject([
        { answer: { action: "accept", values: { name: "api", dry: true } } },
      ])
      await inbox.done()
    })

    it("drops a draft with its entry", async () => {
      const inbox = mount([permission(codex, { id: "x" }), permission(codex, { id: "y", at: 1 })])
      inbox.press("No, and tell Codex")
      inbox.type("Use npm.")
      act(() => inbox.state.update((current) => ({ ...current, items: current.items.slice(1) })))
      await nextFrame()

      expect(marked()).toBe(false)
      await inbox.done()
    })
  })

  context("for a sheet it moved on to", () => {
    it("puts focus on the next sheet's first row, and takes no answer as it arrives", async () => {
      const inbox = mount([
        permission(codex, { id: "first", handle: "crow" }),
        permission(codex, { id: "second", handle: "fox", at: 5 }),
      ])
      // Opened from the keyboard, its title takes focus a frame later.
      await nextFrame()
      inbox.key("1", inbox.listed())
      inbox.confirm("first")
      await nextFrame()

      expect(text(".inbox-sheet-head .handle-chip")).toBe("@fox")
      expect(document.activeElement).toBe(inbox.row("Yes, proceed"))
      // The same key again, meant for @crow's, answers nothing on @fox's.
      inbox.key("1")
      inbox.key("Enter")
      inbox.key(" ")
      expect(inbox.sent).toHaveLength(1)
      later()
      inbox.key("1")
      expect(inbox.sent).toHaveLength(2)
      await inbox.done()
    })

    it("takes no click as it arrives either: a double-click's second lands on nothing", async () => {
      const inbox = mount([
        permission(codex, { id: "first", handle: "crow" }),
        permission(codex, { id: "second", handle: "fox", at: 5 }),
      ])
      act(() => inbox.row("Yes, proceed").click())
      inbox.confirm("first")
      await nextFrame()

      expect(text(".inbox-sheet-head .handle-chip")).toBe("@fox")
      // The double-click's second click, on @fox's sheet, answers nothing.
      act(() => inbox.row("Yes, proceed").click())
      expect(inbox.sent).toHaveLength(1)
      later()
      act(() => inbox.row("Yes, proceed").click())
      expect(inbox.sent).toHaveLength(2)
      await inbox.done()
    })

    it("takes no key or click on a question page as it arrives", async () => {
      const inbox = mount([
        permission(codex, { id: "first" }),
        questions([question("q1", ["A", "B"])], { at: 5 }),
      ])
      await nextFrame()
      inbox.key("1", inbox.listed())
      inbox.confirm("first")
      await nextFrame()

      expect(text(".inbox-sheet-head .handle-chip")).toBe("@moth")
      expect(pick("A")).toBe(document.activeElement)
      inbox.key("1")
      inbox.key("Enter")
      expect(pick("A").checked).toBe(false)
      click(pick("B"))
      expect(pick("B").checked).toBe(false)
      expect(shownPage()?.textContent).toContain("Which q1?")
      later()
      inbox.key("2")
      expect(shownPage()?.textContent).toContain("Send these answers?")
      await inbox.done()
    })

    it("takes no key or click on a form as it arrives, and sends nothing on Submit", async () => {
      const inbox = mount([
        permission(codex, { id: "first" }),
        form([formField("note")], { at: 5 }),
      ])
      await nextFrame()
      inbox.key("1", inbox.listed())
      inbox.confirm("first")
      await nextFrame()

      expect(text(".inbox-sheet-head .handle-chip")).toBe("@crow")
      expect(document.activeElement).toBe(textField("Note"))
      inbox.key("Enter")
      click(control("Submit"))
      expect(inbox.sent).toHaveLength(1)
      later()
      click(control("Submit"))
      expect(inbox.sent).toHaveLength(2)
      expect(inbox.sent[1]).toMatchObject({ answer: { type: "form", action: "accept" } })
      await inbox.done()
    })

    it("puts focus in the field of a next sheet that is only a field for words", async () => {
      const inbox = mount([
        permission(codex, { id: "first", handle: "crow" }),
        asked({ type: "text" }, { id: "second", at: 5 }),
      ])
      await nextFrame()
      inbox.key("1", inbox.listed())
      inbox.confirm("first")
      await nextFrame()

      expect(text(".inbox-sheet-head .handle-chip")).toBe("@owl")
      expect(document.activeElement).toBe(inbox.field())
      await inbox.done()
    })

    it("goes into the menu on an arrow up from its row, not round to its last row", async () => {
      const inbox = mount([permission(codex)])
      inbox.key("ArrowUp", inbox.listed())

      expect(document.activeElement).toBe(inbox.row("Yes, proceed"))
      await inbox.done()
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
      expect(text(".request-error")).toContain("delivery size limit")
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

      const [first] = inbox.field().getAttribute("aria-describedby")!.split(" ")
      const hint = document.getElementById(first!)
      expect(hint?.textContent).toBe("4 over the 4,096 character limit. Shorten it to send.")
      await inbox.done()
    })
  })

  context("for an entry that takes the place of one answered", () => {
    it("shows as waiting, not as the old answer", async () => {
      const inbox = mount([
        permission(codex, { id: "a", handle: "crow", at: 0 }),
        permission(codex, { id: "b", handle: "fox", at: 1 }),
      ])
      inbox.press("Yes, proceed")
      inbox.confirm("a")
      await nextFrame()
      expect(sheet()?.getAttribute("data-state")).toBe("asking")
      act(() =>
        inbox.state.update((current) => ({
          ...current,
          items: [...current.items, permission(codex, { id: "a", handle: "crow", at: 50 })],
        })),
      )
      act(() =>
        document.querySelector<HTMLElement>("[data-inbox-row='a'] .inbox-row-select")!.click(),
      )

      expect(card()?.getAttribute("aria-label")).toBe("Needs your permission: Bash")
      expect(sheet()?.getAttribute("data-state")).toBe("asking")
      expect(inbox.names()).toContain("Yes, proceed")
      await inbox.done()
    })
  })

  context("for the context over the card", () => {
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
      outcome: null,
      scripted: false,
      interrupted: false,
      ring: null,
      ...fields,
    })
    const loaded = (items: readonly ChatItem[]): Conversation => ({
      slice: null,
      doorbell: noDoorbell,
      agent: "codex",
      session: "x",
      loaded: true,
      records: { state: "read", lines: 0, unread: 0 },
      rest: true,
      turned: false,
      screen: null,
      items,
      requests: [],
      prompts: [],
      box: null,
    })
    const said = turn({ text: "run the suite and report back please", at: 10 })
    const ran = [
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
    ]

    it("draws your last words and the agent's steps as the chat draws them", async () => {
      const transcript = createStore<Conversation>(noConversation)
      const inbox = mount([permission(codex)], {
        conversations: { conversation: () => transcript },
      })
      expect(document.querySelector(".inbox-context")).toBeNull()

      act(() => transcript.update(() => loaded([said, ...ran])))
      const section = document.querySelector(".inbox-context")!
      expect(section.tagName).toBe("SECTION")
      expect(section.classList.contains("chat-thread")).toBe(true)
      expect(section.getAttribute("aria-label")).toBe("Where it was")
      const words = section.querySelector("article.chat-message[data-role='user']")!
      expect(words.querySelector("p.chat-text")?.textContent).toContain("run the suite")
      expect(section.querySelectorAll(".chat-tools li.chat-tool")).toHaveLength(1)
      // Over the card, which keeps its place in the sheet's page.
      expect(section.nextElementSibling).toBe(card())
      await inbox.done()
    })

    it("takes no reserved room: none while there is no transcript", async () => {
      const inbox = mount([permission(codex)])

      expect(document.querySelector(".inbox-context")).toBeNull()
      expect(document.querySelector(".console-tail")).toBeNull()
      await inbox.done()
    })

    // jsdom lays nothing out: the card stands a line lower for each row the context over it
    // draws, as the sheet's page would place it.
    const laidOut = (): void => {
      const original = HTMLElement.prototype.getBoundingClientRect
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        if (!this.classList.contains("request-card")) return original.call(this)
        const rows = document.querySelectorAll(".inbox-context :is(.chat-message, .chat-tool)")
        return new DOMRect(0, 40 + 21 * rows.length, 600, 200)
      })
    }

    it("holds back a click on the card for a moment after the context moved it", async () => {
      laidOut()
      const transcript = createStore<Conversation>(noConversation)
      const inbox = mount([permission(codex)], {
        conversations: { conversation: () => transcript },
      })
      expect(movedGuardMs).toBe(400)
      act(() => transcript.update(() => loaded([said])))
      expect(document.querySelector(".inbox-context")).not.toBeNull()

      // The card moved under the pointer: this click was meant for what was there.
      act(() => inbox.row("Yes, proceed").click())
      expect(inbox.sent).toEqual([])
      later(movedGuardMs / 2)
      act(() => inbox.row("Yes, proceed").click())
      expect(inbox.sent).toEqual([])
      later(movedGuardMs * 2)
      act(() => inbox.row("Yes, proceed").click())
      expect(inbox.sent).toEqual([
        { kind: "request", answer: { type: "choice", dialog: "d", option: "yes" } },
      ])
      await inbox.done()
    })

    it("holds a click again as the agent's steps come in, and not keys", async () => {
      laidOut()
      const transcript = createStore<Conversation>(noConversation)
      const inbox = mount([permission(codex)], {
        conversations: { conversation: () => transcript },
      })
      act(() => transcript.update(() => loaded([said])))
      later(2000)
      act(() => transcript.update(() => loaded([said, ...ran])))
      expect(document.querySelectorAll(".inbox-context .chat-tool")).toHaveLength(1)
      act(() => inbox.row("Yes, proceed").click())
      expect(inbox.sent).toEqual([])
      // The guard is the card's clicks': a key answers as ever.
      inbox.key("1", inbox.listed())
      expect(inbox.sent).toHaveLength(1)
      await inbox.done()
    })

    it("holds back no click where the context changed in the room it had", async () => {
      laidOut()
      const transcript = createStore<Conversation>(noConversation)
      const inbox = mount([permission(codex)], {
        conversations: { conversation: () => transcript },
      })
      act(() => transcript.update(() => loaded([said, ...ran])))
      later(2000)
      // Another step in the place of the one before: the card stays where it was.
      const next = ran.map((item) =>
        item.kind === "tool-call"
          ? {
              ...item,
              id: "other-call",
              call: "c2",
              text: JSON.stringify({ command: "pnpm lint" }),
            }
          : { ...item, id: "other-result", call: "c2" },
      )
      act(() => transcript.update(() => loaded([said, ...next])))
      expect(document.querySelector(".inbox-context .chat-tool")?.textContent).toContain("pnpm")
      act(() => inbox.row("Yes, proceed").click())

      expect(inbox.sent).toHaveLength(1)
      await inbox.done()
    })

    it("holds back no click when the context has been there from the start", async () => {
      const transcript = createStore<Conversation>(loaded([said]))
      const inbox = mount([permission(codex)], {
        conversations: { conversation: () => transcript },
      })
      act(() => inbox.row("Yes, proceed").click())

      expect(inbox.sent).toHaveLength(1)
      await inbox.done()
    })

    it("holds back no click that is not on the card", async () => {
      const transcript = createStore<Conversation>(noConversation)
      const inbox = mount([permission(codex)], {
        conversations: { conversation: () => transcript },
      })
      act(() => transcript.update(() => loaded([said])))
      const toggled = vi.fn<() => void>()
      const words = document.querySelector<HTMLElement>(".inbox-context")!
      words.addEventListener("click", toggled)
      act(() => words.click())

      expect(toggled).toHaveBeenCalledOnce()
      await inbox.done()
    })
  })

  context("for trouble", () => {
    const limited = (minutes: number): InboxEntry => ({
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

      expect(text(".request-prose")).toContain("used up its usage window")
      expect(text(".request-prose")).not.toContain("0-hour")
      await inbox.done()
    })

    it("shows a failed turn's error once, and asks it to fix with what it sends", async () => {
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
      expect(text(".request-head h3")).toBe("Ended its turn on an error")
      expect(text(".request-detail-text")).toBe("API Error: 529 Overloaded")
      expect(
        inbox.row("Ask it to fix").querySelector(".request-option-effect")?.textContent,
      ).toContain("Look at what went wrong and fix it.")
      await inbox.done()
    })

    it("offers Continue now only once a limit has reset", async () => {
      const limit = (resetsAt: number): InboxEntry => ({
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
      expect(text(".request-head h3")).toBe("Hit its usage limit")
      expect(before.names()).toEqual(["Go to terminal"])
      expect(text(".request-prose")).toContain("from here once it resets")
      await before.done()

      const after = mount([limit(Date.now() - 60_000)])
      after.press("Continue now")
      expect(after.sent).toEqual([{ kind: "trouble", action: { type: "continue" } }])
      await after.done()
    })
  })

  context("for the Inbox's own kinds", () => {
    const own: readonly [string, InboxEntry, string][] = [
      ["an ask", asked({ type: "text" }), "Has a question"],
      [
        "an ask to act on",
        asked({ type: "action", command: "vercel login", directory: null, doneLabel: "Done" }),
        "Needs you to act",
      ],
      [
        "a held message",
        {
          id: "h",
          source: source("owl"),
          at: 0,
          stopped: true,
          seen: false,
          kind: "held",
          held: {
            from: { handle: "owl", title: "Owl" },
            to: { handle: "wren", title: "Wren" },
            text: "hello",
            heldFor: "loop",
          },
        } as unknown as InboxEntry,
        "Holds a message",
      ],
      [
        "an update",
        {
          id: "u",
          source: source("wren"),
          at: 0,
          stopped: false,
          seen: false,
          kind: "update",
          update: { type: "done", subject: "Done", body: "All of it." },
        },
        "Has an update",
      ],
    ]
    for (const [name, entry, title] of own)
      it(`draws ${name} in the card's frame, titled "${title}"`, async () => {
        const inbox = mount([entry])

        expect(card()?.querySelector("header.request-head h3")?.textContent).toBe(title)
        expect(card()?.getAttribute("aria-label")).toContain(title)
        expect(document.querySelector(".inbox-sheet .console-box")).toBeNull()
        await inbox.done()
      })
  })

  context("as keys come", () => {
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
      inbox.key("1", inbox.listed())
      inbox.key("1", document.activeElement!, { repeat: true })
      inbox.key("Enter", document.activeElement!, { repeat: true })
      expect(inbox.sent).toEqual([])
      inbox.key("1")
      expect(inbox.sent).toHaveLength(1)
      await inbox.done()
    })

    it("answers nothing from a number held on the row, for a question or a command", async () => {
      const inbox = mount([permission(codex)])
      inbox.key("1", inbox.listed(), { repeat: true })

      expect(inbox.sent).toEqual([])
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
      const code = document.querySelector<HTMLElement>(".request-more pre")!
      act(() => code.focus())
      inbox.key(" ", code)
      inbox.key("Enter", code)
      inbox.key("2", code)

      expect(inbox.sent).toEqual([])
      await inbox.done()
    })
  })

  context("for an answered entry opened again", () => {
    it("says what its answer did, stays on it, and lets j go past it", async () => {
      const inbox = mount(
        [
          permission(codex, { id: "x", handle: "xx", at: 0 }),
          permission(codex, { id: "y", handle: "yy", at: 1 }),
          permission(codex, { id: "z", handle: "zz", at: 2 }),
        ],
        { open: 1 },
      )
      inbox.press("Yes, proceed")
      inbox.confirm("y")
      await nextFrame()
      expect(text(".inbox-sheet-head .handle-chip")).toBe("@xx")
      inbox.key("j", document.body)
      await nextFrame()

      expect(text(".inbox-sheet-head .handle-chip")).toBe("@yy")
      expect(card()?.querySelector("h3")?.textContent).toBe("Answered")
      expect(card()?.querySelector(".request-subject")?.textContent).toBe("pnpm add x")
      expect(card()?.querySelector(".request-note")?.textContent).toBe("Allowed @yy's command.")
      expect(document.querySelector(".inbox-sheet .request-options")).toBeNull()
      inbox.key("j", document.body)
      await nextFrame()
      expect(text(".inbox-sheet-head .handle-chip")).toBe("@zz")
      await inbox.done()
    })
  })

  context("for an update", () => {
    it("is read as it opens, and leaves the terminal to go to", async () => {
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
      inbox.press("Go to terminal")

      expect(inbox.sent).toEqual([{ kind: "update", action: "read" }])
      expect(inbox.revealed).toEqual(["t-wren"])
      await inbox.done()
    })
  })

  context("with an empty box for words", () => {
    it("asks for an answer rather than offering to send nothing", async () => {
      const inbox = mount([asked({ type: "text" })])
      // The hints come as the person is in the field.
      expect(text(".request-writing-hint")).toBe("")
      act(() => inbox.field().focus())

      expect(text(".request-writing-hint")).toBe("type your answer · Esc back to the options")
      inbox.type("Samples.")
      expect(text(".request-writing-hint")).toBe("↵ send · Esc back to the options")
      await inbox.done()
    })
  })

  context("as answered entries pile up", () => {
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
        inbox.press("Yes, proceed")
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
      expect(text(".request-note")).toBe("Allowed @zz's command.")
      await inbox.done()
    })

    it("moves on from a newer entry that took an answered one's id", async () => {
      const inbox = mount([
        permission(codex, { id: "a", handle: "crow", at: 0 }),
        permission(codex, { id: "b", handle: "fox", at: 1 }),
      ])
      inbox.press("Yes, proceed")
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
      expect(document.querySelector(".inbox-sheet .request-options")).not.toBeNull()
      inbox.press("Yes, proceed")
      inbox.confirm("a")
      await nextFrame()

      expect(text(".inbox-sheet-head .handle-chip")).toBe("@fox")
      expect(text(".console-receipt")).toBe("Allowed @crow's command.")
      await inbox.done()
    })
  })
})
