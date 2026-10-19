import type {
  ChatItem,
  ChatRequest,
  Conversation,
  Conversations,
} from "@novadeck/core/conversation"
import type { TerminalKey } from "@novadeck/core/port"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { createStore } from "@novadeck/core/store"
import type { AgentStatus, Workspace } from "@novadeck/core/types"
import { createView, type Terminal } from "@novadeck/emulator/browser"
import { afterEach, vi } from "vitest"

import type { DemoAgentLink } from "../agent-link"
import { createDemoEngine } from "../engine"
import { demoSeed, demoTerminalId } from "../samples"
import { context, describe, expect, it } from "../test"
import { createDemoTerminalScreen, fixedIntro } from "./terminal"
import { span, wrap } from "./vt"

// jsdom has no layout observers, media queries or canvas; xterm falls back without them.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  })
})

const session = { projectId: "storefront", workspaceSessionId: "initial" }
const slot = (number: number): TerminalKey => ({
  ...session,
  terminalId: demoTerminalId(session, number),
})

const closing: (() => void)[] = []
afterEach(() => closing.splice(0).forEach((close) => close()))

// A real emulator, as the views draw with, reading what the screen writes.
const emulator = (cols: number, rows: number): Terminal => {
  const element = document.body.appendChild(document.createElement("div"))
  const view = createView(element, {
    fontSize: 13,
    fontFamily: "monospace",
    theme: {},
    scrollback: 1000,
  })
  view.terminal.resize(cols, rows)
  closing.push(() => {
    view.dispose()
    element.remove()
  })
  return view.terminal
}
const written = (terminal: Terminal, data: string): Promise<void> =>
  new Promise((resolve) => terminal.write(data, resolve))
const text = (terminal: Terminal): string => {
  const buffer = terminal.buffer.active
  const rows: string[] = []
  for (let row = 0; row < buffer.length; row += 1)
    rows.push(buffer.getLine(row)?.translateToString(true) ?? "")
  return rows.join("\n").trimEnd()
}

// The agent of a terminal as its conversation tells it, with what the screen sends it.
const agentLink = (conversation: Conversation) => {
  const store = createStore(conversation)
  const conversations = {
    conversation: () => store,
    send: vi.fn<Conversations["send"]>(() => Promise.resolve()),
    interrupt: vi.fn<Conversations["interrupt"]>(() => Promise.resolve(null)),
    answer: vi.fn<Conversations["answer"]>(() => Promise.resolve()),
    refused: () => undefined,
  } as unknown as Conversations & {
    send: ReturnType<typeof vi.fn<Conversations["send"]>>
    interrupt: ReturnType<typeof vi.fn<Conversations["interrupt"]>>
    answer: ReturnType<typeof vi.fn<Conversations["answer"]>>
  }
  const link: DemoAgentLink = { conversations, opening: () => 0 }
  return { link, store, conversations }
}

const conversationOf = (fields: Partial<Conversation> = {}): Conversation => ({
  agent: "claude",
  session: "s1",
  loaded: true,
  items: [],
  requests: [],
  ...fields,
})

const item = (id: string, fields: Partial<ChatItem>): ChatItem => ({
  id,
  at: null,
  role: "assistant",
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

const permission: ChatRequest = {
  id: "r1",
  kind: "permission",
  tool: "Bash",
  subject: "pnpm test",
  choices: [],
  subagent: false,
  answered: false,
  dialog: {
    type: "choices",
    id: "d1",
    title: null,
    detail: null,
    options: [
      { id: "yes", label: "Yes", text: null },
      { id: "no", label: "No", text: null },
    ],
  },
} as ChatRequest

// A demo terminal's screen over the sample workspace, written into an emulator as a stream
// would, with the workspace's terminals changed as `change` says.
const open = async (
  key: TerminalKey,
  {
    link,
    intro,
    change = (workspace) => workspace,
    cols = 60,
    rows = 40,
    agents = true,
  }: {
    link?: DemoAgentLink
    intro?: Parameters<typeof createDemoTerminalScreen>[0]["intro"]
    change?: (workspace: Workspace) => Workspace
    cols?: number
    rows?: number
    // The agents demo's seed, or the plain one's, whose first terminal is a shell.
    agents?: boolean
  } = {},
) => {
  const engine = createDemoEngine()
  const workspace = change(
    workspaceFromSeed(demoSeed(Date.now(), agents), {
      view: "focus",
      windowedView: "grid",
      now: 0,
    }),
  )
  engine.reconcile(workspace, [])
  const screen = createDemoTerminalScreen({
    key,
    engine,
    intro,
    link: () => link,
    size: { cols, rows },
  })
  closing.push(screen.dispose)
  const terminal = emulator(cols, rows)
  await written(terminal, screen.snapshot())
  const queued: string[] = []
  screen.attach((data) => queued.push(data))
  // Writes what the screen sent since, as the stream delivers it.
  const settle = async (): Promise<string> => {
    await written(terminal, queued.splice(0).join(""))
    return text(terminal)
  }
  const type = async (data: string): Promise<string> => {
    screen.input(data)
    await Promise.resolve()
    return settle()
  }
  // What the screen has sent since it was last written, without writing it.
  const pending = (): string => queued.join("")
  return { engine, screen, terminal, settle, type, pending, workspace }
}

// The agent's status on a terminal in the workspace, as the panel or a turn sets it.
const withAgent =
  (key: TerminalKey, agent: AgentStatus, process = "claude") =>
  (workspace: Workspace): Workspace => ({
    ...workspace,
    projects: workspace.projects.map((project) => ({
      ...project,
      history: project.history.map((each) => ({
        ...each,
        state: {
          ...each.state,
          roster: {
            ...each.state.roster,
            terminals: each.state.roster.terminals.map((terminal) =>
              terminal.id === key.terminalId && each.id === key.workspaceSessionId
                ? { ...terminal, process, command: process, state: "running" as const, agent }
                : terminal,
            ),
          },
        },
      })),
    })),
  })

describe("a demo terminal's screen", () => {
  context("for a shell", () => {
    it("opens with its program's sample output, under the project's prompt", async () => {
      const { terminal } = await open(slot(1), { agents: false })
      const shown = text(terminal)
      expect(shown).toContain("On branch main")
      expect(shown).toMatch(/⎇ main\n❯$/)
    })

    it("runs a typed command, its reply under it, and clears the line", async () => {
      const { type } = await open(slot(1), { agents: false })
      await type("pwd")
      expect(await type("\r")).toMatch(/❯ pwd\n[^\n]+\n\n\S+ ⎇ main\n❯$/)
    })

    it("draws no prompt under a program running in front, and takes no command", async () => {
      const { terminal, type, engine } = await open(slot(2), { agents: false })
      expect(text(terminal)).toContain("ready in")
      expect(text(terminal)).not.toContain("⎇")
      const typed = (await type("ls")).split("\n")
      expect(typed.at(-1)).toBe("ls")
      expect(typed.at(-2)).not.toMatch(/⎇|❯/)
      await type("\r")
      expect(engine.getSnapshot(slot(2)).entries).toEqual([])
    })

    it("draws everything again at a new width", async () => {
      const { screen, terminal, settle } = await open(slot(1), { cols: 60, agents: false })
      terminal.resize(30, 40)
      screen.resize({ cols: 30, rows: 40 })
      const shown = await settle()
      expect(shown.split("\n").every((row) => [...row].length <= 30)).toBe(true)
      expect(shown).toContain("On branch main")
    })
  })

  context("with an intro of its own", () => {
    it("appends what the intro adds, and draws it anew when it changes otherwise", async () => {
      const first = (width: number) => wrap([span("pnpm dev")], width)
      const second = (width: number) => wrap([span("hmr update")], width)
      const blocks = createStore([first])
      const { settle } = await open(slot(2), { intro: blocks })
      blocks.update(() => [first, second])
      expect(await settle()).toMatch(/^pnpm dev\nhmr update$/)
      blocks.update(() => [second])
      expect(await settle()).toMatch(/^hmr update$/)
    })

    it("keeps a fixed one as it is", async () => {
      const { terminal } = await open(slot(2), {
        intro: fixedIntro([(width) => wrap([span("~/projects/studio · codex")], width)]),
      })
      expect(text(terminal)).toMatch(/^~\/projects\/studio · codex$/)
    })
  })

  context("for an agent with its conversation linked", () => {
    const working: AgentStatus = { working: true }

    it("shows the conversation after the opening, and the status above the prompt", async () => {
      const { link, store } = agentLink(conversationOf())
      const { settle } = await open(slot(1), { link, change: withAgent(slot(1), working) })
      store.update((was) => ({
        ...was,
        items: [
          item("u1", { role: "user", text: "Fix the tests" }),
          item("c1", {
            kind: "tool-call",
            tool: "Bash",
            text: '{"command":"pnpm test"}',
            run: { kind: "run", title: "Ran", detail: "pnpm test" },
          }),
        ],
      }))
      const shown = await settle()
      expect(shown).toContain("❯ Fix the tests")
      expect(shown).toContain("● Bash pnpm test")
      expect(shown).toMatch(/✻ Working… \(esc to interrupt\)\n\n─+\n❯ ?\n─+$/)
    })

    it("answers the dialog that waits by its number", async () => {
      const { link, conversations } = agentLink(conversationOf({ requests: [permission] }))
      const { type } = await open(slot(1), { link, change: withAgent(slot(1), working) })
      const shown = await type("")
      expect(shown).toContain("Allow Bash?")
      expect(shown).toContain("❯ 1. Yes")
      await type("1")
      await type("\r")
      expect(conversations.answer).toHaveBeenCalledWith(slot(1), "r1", {
        type: "choice",
        dialog: "d1",
        option: "yes",
      })
    })

    it("keeps a line that is no option in the command line, with a note", async () => {
      const { link, conversations } = agentLink(conversationOf({ requests: [permission] }))
      const { type, engine } = await open(slot(1), { link, change: withAgent(slot(1), working) })
      await type("9")
      const shown = await type("\r")
      expect(shown).toContain("No option 9.")
      expect(engine.getSnapshot(slot(1)).line.draft).toBe("9")
      expect(conversations.answer).not.toHaveBeenCalled()
    })

    it("sends a line as a prompt when nothing waits", async () => {
      const { link, conversations } = agentLink(conversationOf())
      const { type } = await open(slot(1), { link, change: withAgent(slot(1), working) })
      await type("go on")
      await type("\r")
      expect(conversations.send).toHaveBeenCalledWith(slot(1), "go on")
    })

    it("interrupts on Escape while the agent works, and takes its words back", async () => {
      const { link, conversations } = agentLink(conversationOf())
      conversations.interrupt.mockResolvedValue("and the docs")
      const { type, engine } = await open(slot(1), { link, change: withAgent(slot(1), working) })
      await type("also")
      await type("\x1b")
      await vi.waitFor(() =>
        expect(engine.getSnapshot(slot(1)).line.draft).toBe("also and the docs"),
      )
    })

    it("ignores Escape while it rests", async () => {
      const { link, conversations } = agentLink(conversationOf())
      const { type } = await open(slot(1), {
        link,
        change: withAgent(slot(1), { working: false }),
      })
      await type("\x1b")
      expect(conversations.interrupt).not.toHaveBeenCalled()
    })
  })

  context("answering what its agent asks", () => {
    const working: AgentStatus = { working: true }
    const questions = {
      ...permission,
      id: "r2",
      kind: "question",
      dialog: {
        type: "questions",
        id: "q",
        questions: [
          {
            id: "a",
            header: "Size",
            question: "How big?",
            multiSelect: false,
            options: [
              { id: "s", label: "Small", description: null },
              { id: "l", label: "Large", description: null },
            ],
          },
          {
            id: "b",
            header: "Colour",
            question: "Which colour?",
            multiSelect: false,
            options: [{ id: "r", label: "Red", description: null }],
          },
        ],
      },
    } as unknown as ChatRequest

    it("answers a questions dialog question by question", async () => {
      const { link, conversations } = agentLink(conversationOf({ requests: [questions] }))
      const { type } = await open(slot(1), { link, change: withAgent(slot(1), working) })
      expect(await type("")).toContain("Size · 1 of 2")
      await type("2")
      expect(await type("\r")).toContain("Colour · 2 of 2")
      expect(conversations.answer).not.toHaveBeenCalled()
      await type("1")
      await type("\r")
      expect(conversations.answer).toHaveBeenCalledWith(slot(1), "r2", {
        type: "questions",
        dialog: "q",
        answers: [
          { question: "a", options: ["l"] },
          { question: "b", options: ["r"] },
        ],
      })
    })

    it("keeps a line for a request answered already, or one whose dialog hasn't shown", async () => {
      const answered = { ...permission, answered: true }
      const { link } = agentLink(conversationOf({ requests: [answered] }))
      const first = await open(slot(1), { link, change: withAgent(slot(1), working) })
      await first.type("1")
      expect(await first.type("\r")).toContain("Already answered; the agent is catching up.")
      expect(first.engine.getSnapshot(slot(1)).line.draft).toBe("1")
      const pending = agentLink(conversationOf({ requests: [{ ...permission, dialog: null }] }))
      const second = await open(slot(1), {
        link: pending.link,
        change: withAgent(slot(1), working),
      })
      await second.type("1")
      expect(await second.type("\r")).toContain("This request isn't ready to answer yet.")
    })

    it("says a refusal again when the same line is refused twice, so it's heard again", async () => {
      const { link } = agentLink(conversationOf({ requests: [permission] }))
      const { type, pending, screen } = await open(slot(1), {
        link,
        change: withAgent(slot(1), working),
      })
      await type("9")
      expect(await type("\r")).toContain("No option 9.")
      // The refused line stays, so Enter again refuses it again.
      screen.input("\r")
      await Promise.resolve()
      // oxlint-disable-next-line no-control-regex -- Styles start with ESC.
      expect(pending().replace(/\x1b\[[0-9;]*m/g, "")).toContain("No option 9.")
    })

    it("sends a line as a prompt past a form it can't answer", async () => {
      const form = {
        ...permission,
        dialog: { type: "form", id: "f", message: "Your name", fields: [] },
      } as unknown as ChatRequest
      const { link, conversations } = agentLink(conversationOf({ requests: [form] }))
      const { type } = await open(slot(1), { link, change: withAgent(slot(1), working) })
      await type("Ada")
      await type("\r")
      expect(conversations.send).toHaveBeenCalledWith(slot(1), "Ada")
    })

    it("says why a send failed, and drops the note once another request shows", async () => {
      const { link, store, conversations } = agentLink(conversationOf())
      conversations.send.mockRejectedValue(new Error("The agent isn't listening."))
      const { type, settle } = await open(slot(1), { link, change: withAgent(slot(1), working) })
      await type("hello")
      await type("\r")
      await vi.waitFor(async () => expect(await settle()).toContain("The agent isn't listening."))
      store.update((was) => ({ ...was, requests: [permission] }))
      expect(await settle()).not.toContain("The agent isn't listening.")
    })

    it("says which of several requests it shows", async () => {
      const second = { ...permission, id: "r9" }
      const { link } = agentLink(conversationOf({ requests: [permission, second] }))
      const { type } = await open(slot(1), { link, change: withAgent(slot(1), working) })
      expect(await type("")).toContain("Permission · 1 of 2")
    })

    it("draws an item's own text, though its id came back after its agent started again", async () => {
      const { link, store } = agentLink(
        conversationOf({ items: [item("k:1", { text: "first run" })] }),
      )
      const { settle } = await open(slot(1), { link, change: withAgent(slot(1), working) })
      expect(await settle()).toContain("first run")
      store.update((was) => ({ ...was, items: [] }))
      store.update((was) => ({ ...was, items: [item("k:1", { text: "second run" })] }))
      const shown = await settle()
      expect(shown).toContain("second run")
      expect(shown).not.toContain("first run")
    })
  })

  context("without its agent linked", () => {
    it("runs a typed line as the shell does", async () => {
      const { type, engine } = await open(slot(1), {
        change: withAgent(slot(1), { working: true }),
      })
      await type("pwd")
      await type("\r")
      expect(engine.getSnapshot(slot(1)).entries.map((entry) => entry.command)).toEqual(["pwd"])
    })
  })

  context("for an agent that opened planning, still reading", () => {
    it("reads the file in front of the visitor, a step at a time, by appending", async () => {
      // The emulator writes on timers of its own, which go on with the clock.
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        const planning: AgentStatus = { working: true, planning: true }
        const { settle } = await open(slot(1), { change: withAgent(slot(1), planning) })
        expect(await settle()).not.toContain("Read src/checkout/Checkout.tsx")
        vi.advanceTimersByTime(2200)
        expect(await settle()).toContain("● Read src/checkout/Checkout.tsx")
        vi.advanceTimersByTime(1300)
        expect(await settle()).toContain("└ Read 128 lines")
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
