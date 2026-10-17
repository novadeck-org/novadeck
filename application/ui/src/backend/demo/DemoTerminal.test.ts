import { act, createElement, type ReactNode } from "react"
import { afterEach, vi } from "vitest"

import type {
  ChatAnswer,
  ChatItem,
  ChatRequest,
  Conversation,
  ConversationKey,
  Conversations,
} from "../../model/conversation"
import { createTerminalState } from "../../model/state"
import { createStore } from "../../model/store"
import type { TerminalMetadata, Workspace } from "../../model/types"
import { context, describe, expect, it } from "../../test"
import { render, type Rendered } from "../../test/render"
import type { BackendConnectionState, TerminalKey } from "../port"
import { terminalKeyId } from "../registry"
import { DemoAgentContext } from "./agent-link"
import { createDemoTerminal } from "./DemoTerminal"
import { createDemoEngine } from "./engine"
import { createMockTerminal } from "./samples"
import type { DemoScreen } from "./surface"

// jsdom has no resizes; the demo terminal watches for its output coming back on screen.
vi.hoisted(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const key: TerminalKey = { projectId: "p", workspaceSessionId: "s", terminalId: "01" }
const shell: TerminalMetadata = {
  id: "01",
  name: "Terminal",
  directory: "~",
  command: "zsh",
  process: "zsh",
  state: "idle",
}
const ended: TerminalMetadata = { ...shell, state: "exited", exitCode: 3, signal: null }

const mounted: Rendered[] = []
afterEach(() => mounted.splice(0).forEach((view) => view.unmount()))

const mount = (terminal: TerminalMetadata, withRuntime: boolean) => {
  const connection = createStore<BackendConnectionState>("connected")
  const screens = createStore<ReadonlyMap<string, DemoScreen>>(new Map())
  const restart = vi.fn<(key: TerminalKey) => void>()
  const Surface = createDemoTerminal(
    createDemoEngine(),
    undefined,
    withRuntime ? { connection, screens, restart } : undefined,
  )
  const view = render(
    createElement(Surface, {
      terminalKey: key,
      terminal,
      projectName: "novadeck",
      view: "focus",
      fontSize: 13,
      focusInput: false,
      onInputFocused: () => {},
      renderWindow: (content: ReactNode) => content,
    }),
  )
  mounted.push(view)
  const input = view.container.querySelector<HTMLInputElement>("[data-terminal-input]")!
  const form = view.container.querySelector("form")!
  const press = (): void => act(() => form.requestSubmit())
  const showScreen = (screen: DemoScreen): void =>
    act(() => void screens.update(() => new Map([[terminalKeyId(key), screen]])))
  return { view, connection, showScreen, restart, input, press }
}

// The output as the layout gives it: 1000 tall in a 400 window, so 600 is the bottom.
const metrics = (scrollHeight: number): void => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(scrollHeight)
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400)
}
const scrollTo = (output: HTMLElement, top: number): void => {
  output.scrollTop = top
  act(() => void output.dispatchEvent(new Event("scroll")))
}

describe("a demo terminal's scroll across a remount", () => {
  const workspace: Workspace = {
    activeProjectId: "p",
    projects: [
      {
        id: "p",
        name: "novadeck",
        directory: "~",
        activeSessionId: "s",
        history: [
          { id: "s", name: "s", visitedAt: 0, state: createTerminalState([shell], "grid", "grid") },
        ],
      },
    ],
  }
  afterEach(() => vi.restoreAllMocks())

  const session = () => {
    const engine = createDemoEngine()
    engine.reconcile(workspace, [])
    const Surface = createDemoTerminal(engine)
    const props = {
      terminalKey: key,
      terminal: shell,
      projectName: "novadeck",
      view: "focus" as const,
      fontSize: 13,
      focusInput: false,
      onInputFocused: () => {},
      renderWindow: (content: ReactNode) => content,
    }
    const open = () => {
      const view = render(createElement(Surface, props))
      mounted.push(view)
      return { view, output: view.container.querySelector<HTMLElement>(".demo-output")! }
    }
    return { open }
  }
  it("stays at the bottom when the layout grew meanwhile", () => {
    metrics(1000)
    const { open } = session()
    const first = open()
    scrollTo(first.output, 600)
    first.view.unmount()
    // Back wider, so the content is taller than the offset it was left at.
    metrics(1200)
    expect(open().output.scrollTop).toBe(1200)
  })

  it("stays at the bottom when a narrower layout clamped the offset on its way out", () => {
    metrics(1000)
    const { open } = session()
    const first = open()
    scrollTo(first.output, 300)
    metrics(800)
    scrollTo(first.output, 400)
    first.view.unmount()
    metrics(1200)
    expect(open().output.scrollTop).toBe(1200)
  })

  it("takes a fraction short of the bottom, as a zoomed page leaves it, as the bottom", () => {
    metrics(1000)
    const { open } = session()
    const first = open()
    scrollTo(first.output, 598.6)
    first.view.unmount()
    metrics(1200)
    expect(open().output.scrollTop).toBe(1200)
  })

  it("keeps a place a few pixels above the bottom", () => {
    metrics(1000)
    const { open } = session()
    const first = open()
    scrollTo(first.output, 595)
    first.view.unmount()
    expect(open().output.scrollTop).toBe(595)
  })

  it("keeps the place of a terminal the person scrolled up", () => {
    metrics(1000)
    const { open } = session()
    const first = open()
    scrollTo(first.output, 250)
    first.view.unmount()
    expect(open().output.scrollTop).toBe(250)
  })
})

describe("demo terminal surface", () => {
  context("without a runtime", () => {
    it("is its own root and shows no ending", () => {
      const { view } = mount(ended, false)
      const root = view.container.firstElementChild!
      expect(root.hasAttribute("data-terminal-content")).toBe(true)
      expect(view.container.querySelector("[data-terminal-ending]")).toBeNull()
    })
  })

  context("with a runtime", () => {
    it("keeps one content root, which frames the output", () => {
      const { view } = mount(shell, true)
      expect(view.container.querySelectorAll("[data-terminal-content]")).toHaveLength(1)
      const root = view.container.querySelector("[data-terminal-content]")!
      expect(root.classList.contains("terminal-content")).toBe(true)
      expect(root.classList.contains("nodrag")).toBe(true)
      expect(root.querySelector("[data-terminal-input]")).not.toBeNull()
    })

    it("shows how an ended shell ended, with Restart", () => {
      const { view, restart } = mount(ended, true)
      expect(view.container.querySelector("[data-terminal-ending]")?.textContent).toContain(
        "Exited · code 3",
      )
      act(() => view.container.querySelector<HTMLButtonElement>(".terminal-restart")?.click())
      expect(restart).toHaveBeenCalledWith(key)
    })

    it("restarts on Enter once the shell ended", () => {
      const { restart, press } = mount(ended, true)
      press()
      expect(restart).toHaveBeenCalledWith(key)
    })

    it("shows no ending for a shell that runs", () => {
      const { view } = mount(shell, true)
      expect(view.container.querySelector("[data-terminal-ending]")).toBeNull()
    })

    it("locks while the connection is away, and refuses Restart and Enter", () => {
      const { view, connection, restart, input, press } = mount(ended, true)
      act(() => void connection.update(() => "reconnecting"))
      expect(view.container.querySelector(".terminal-lock")?.textContent).toBe("Reconnecting…")
      expect(input.getAttribute("aria-disabled")).toBe("true")
      press()
      act(() => view.container.querySelector<HTMLButtonElement>(".terminal-restart")?.click())
      expect(restart).not.toHaveBeenCalled()
      act(() => void connection.update(() => "unavailable"))
      expect(view.container.querySelector(".terminal-lock")?.textContent).toBe("Runner offline")
      act(() => void connection.update(() => "connected"))
      expect(view.container.querySelector(".terminal-lock")).toBeNull()
    })

    it("locks while its shell starts", () => {
      const { view } = mount({ ...shell, state: "starting" }, true)
      expect(view.container.querySelector(".terminal-lock")?.textContent).toBe("Starting shell…")
    })

    it("locks while its output is on the way", () => {
      const { view, showScreen } = mount(shell, true)
      showScreen({ attaching: true })
      expect(view.container.querySelector(".terminal-lock")?.textContent).toBe("Loading output…")
      showScreen({})
      expect(view.container.querySelector(".terminal-lock")).toBeNull()
    })

    it("shows a notice at the top without locking", () => {
      const { view, showScreen } = mount(shell, true)
      showScreen({ notice: "Novadeck can't read the clipboard" })
      expect(view.container.querySelector("[data-paste-notice]")?.textContent).toBe(
        "Novadeck can't read the clipboard",
      )
      expect(view.container.querySelector(".terminal-lock")).toBeNull()
    })
  })
})

const claude: TerminalMetadata = {
  ...createMockTerminal({ projectId: "p", workspaceSessionId: "s" }, 1, "~/p"),
  id: "01",
  process: "claude",
  state: "running",
  agent: { working: false },
}
const item = (id: string, over: Partial<ChatItem>): ChatItem => ({
  id,
  at: null,
  role: "assistant",
  kind: "text",
  text: "",
  truncated: false,
  tool: null,
  call: null,
  author: null,
  ...over,
})
const asking = (over: Partial<ChatRequest>): ChatRequest => ({
  id: "r1",
  kind: "permission",
  tool: "Bash",
  subject: "pnpm test",
  choices: [],
  subagent: false,
  dialog: {
    type: "choices",
    id: "d1",
    title: null,
    detail: null,
    options: [
      { id: "yes", label: "Yes", text: null },
      { id: "no", label: "No", text: "prompt" },
    ],
  },
  answered: false,
  ...over,
})

const link = (conversation: Conversation, opening = 1) => {
  const store = createStore(conversation)
  const calls = {
    send: vi.fn<(key: ConversationKey, text: string) => Promise<void>>(async () => {}),
    answer: vi.fn<(key: ConversationKey, request: string, answer: ChatAnswer) => Promise<void>>(
      async () => {},
    ),
    interrupt: vi.fn<(key: ConversationKey) => Promise<string | null>>(async () => null),
  }
  const conversations: Conversations = {
    conversation: () => store,
    refused: () => false,
    ...calls,
  }
  return { store, calls, value: { conversations, opening: () => opening } }
}
const conversation = (over: Partial<Conversation>): Conversation => ({
  agent: "claude",
  session: "x",
  loaded: true,
  items: [],
  requests: [],
  ...over,
})

const mountAgent = (
  terminal: TerminalMetadata,
  value: ReturnType<typeof link>["value"] | undefined,
) => {
  const engine = createDemoEngine()
  engine.reconcile(
    {
      activeProjectId: "p",
      projects: [
        {
          id: "p",
          name: "p",
          directory: "~/p",
          activeSessionId: "s",
          history: [
            {
              id: "s",
              name: "s",
              visitedAt: 0,
              state: createTerminalState([terminal], "grid", "grid"),
            },
          ],
        },
      ],
    },
    [],
  )
  const Surface = createDemoTerminal(engine)
  const view = render(
    createElement(
      DemoAgentContext.Provider,
      { value },
      createElement(Surface, {
        terminalKey: key,
        terminal,
        projectName: "novadeck",
        view: "focus",
        fontSize: 13,
        focusInput: false,
        onInputFocused: () => {},
        renderWindow: (content: ReactNode) => content,
      }),
    ),
  )
  mounted.push(view)
  const input = view.container.querySelector<HTMLInputElement>("[data-terminal-input]")!
  const type = (text: string): void =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
  const submit = async (text: string): Promise<void> => {
    type(text)
    await act(async () => view.container.querySelector("form")!.requestSubmit())
  }
  const text = (): string => view.container.textContent ?? ""
  return { view, input, type, submit, text }
}

describe("demo agent terminal", () => {
  context("with its agent linked", () => {
    it("shows the conversation after its opening, and the status line", () => {
      const { value } = link(
        conversation({
          items: [
            item("0", { role: "user", text: "already in the intro" }),
            item("1", { role: "user", text: "fix the flake" }),
            item("2", {
              kind: "tool-call",
              role: "tool",
              tool: "Bash",
              text: '{"command":"pnpm test"}',
            }),
            item("3", { kind: "tool-result", role: "tool", text: "one\ntwo\nthree\nfour" }),
            item("4", { text: "Fixed." }),
          ],
        }),
      )
      const { text } = mountAgent({ ...claude, agent: { working: true, planning: true } }, value)
      expect(text()).not.toContain("already in the intro")
      expect(text()).toContain("fix the flake")
      expect(text()).toContain("Bash pnpm test")
      expect(text()).toContain("└ one")
      expect(text()).toContain("three…")
      expect(text()).not.toContain("four")
      expect(text()).toContain("Fixed.")
      expect(text()).toContain("✻ Working… (esc to interrupt)")
      expect(text()).toContain("plan mode on")
    })

    it("draws the waiting request as a dialog and never a canned one", () => {
      const { value } = link(conversation({ requests: [asking({})] }))
      const { view, text } = mountAgent(claude, value)
      const ask = view.container.querySelector(".agent-ask")!
      expect(ask.getAttribute("data-kind")).toBe("permission")
      expect(ask.textContent).toContain("Allow Bash?")
      expect(ask.textContent).toContain("pnpm test")
      expect(ask.textContent).toContain("❯ 1. Yes")
      expect(text()).not.toContain("Ready to code?")
    })

    it("reads an answered request as answered", () => {
      const { value } = link(conversation({ requests: [asking({ answered: true })] }))
      const { view } = mountAgent(claude, value)
      expect(view.container.querySelector(".agent-ask")?.textContent).toContain("Answered")
      expect(view.container.querySelector(".agent-ask")?.textContent).not.toContain("1. Yes")
    })

    it("answers a choices dialog by number and clears the draft", async () => {
      const { value, calls } = link(conversation({ requests: [asking({})] }))
      const { input, submit } = mountAgent(claude, value)
      await submit("2 not that way")
      expect(calls.answer).toHaveBeenCalledWith(key, "r1", {
        type: "choice",
        dialog: "d1",
        option: "no",
        text: "not that way",
      })
      expect(calls.send).not.toHaveBeenCalled()
      expect(input.value).toBe("")
    })

    it("keeps a line that is no option, with a muted note", async () => {
      const { value, calls } = link(conversation({ requests: [asking({})] }))
      const { input, submit, text } = mountAgent(claude, value)
      await submit("maybe")
      expect(calls.answer).not.toHaveBeenCalled()
      expect(input.value).toBe("maybe")
      expect(text()).toContain("Type an option's number.")
    })

    it("shows why an answer was rejected", async () => {
      const { value, calls } = link(conversation({ requests: [asking({})] }))
      calls.answer.mockRejectedValueOnce(new Error("The dialog changed."))
      const { submit, text } = mountAgent(claude, value)
      await submit("1")
      expect(text()).toContain("The dialog changed.")
    })

    it("answers a questions dialog question by question", async () => {
      const options = ["a", "b", "c"].map((id) => ({ id, label: id, description: null }))
      const dialog = {
        type: "questions" as const,
        id: "d2",
        chat: null,
        questions: [
          { id: "q1", header: "One", question: "First?", options, multiSelect: false, text: false },
          { id: "q2", header: "Two", question: "Second?", options, multiSelect: true, text: false },
        ],
      }
      const { value, calls } = link(
        conversation({ requests: [asking({ kind: "question", dialog })] }),
      )
      const { submit, text } = mountAgent(claude, value)
      await submit("2")
      expect(calls.answer).not.toHaveBeenCalled()
      expect(text()).toContain("Second?")
      await submit("1 3")
      expect(calls.answer).toHaveBeenCalledWith(key, "r1", {
        type: "questions",
        dialog: "d2",
        answers: [
          { question: "q1", options: ["b"] },
          { question: "q2", options: ["a", "c"] },
        ],
      })
    })

    it("reads a form only, and takes a typed line as a prompt that moves the agent on", async () => {
      const dialog = { type: "form" as const, id: "d3", message: "Fill me", fields: [] }
      const { value, calls } = link(conversation({ requests: [asking({ dialog })] }))
      const { submit, text } = mountAgent(claude, value)
      expect(text()).toContain("Answer this form from the chat, or type to go on.")
      await submit("skip it")
      expect(calls.answer).not.toHaveBeenCalled()
      expect(calls.send).toHaveBeenCalledWith(key, "skip it")
    })

    it("tells a raw dialog's own agent answers it, not the chat", async () => {
      const dialog = {
        type: "raw" as const,
        text: "Allow this?",
        reason: "unrecognized" as const,
      }
      const { value, calls } = link(conversation({ requests: [asking({ dialog })] }))
      const { submit, text } = mountAgent(claude, value)
      expect(text()).toContain("answer it in the agent, or type to go on")
      expect(text()).not.toContain("from the chat")
      await submit("go on")
      expect(calls.send).toHaveBeenCalledWith(key, "go on")
    })

    it("sends a typed line as a prompt when nothing waits, and shows a rejection", async () => {
      const { value, calls } = link(conversation({}))
      calls.send.mockRejectedValueOnce(new Error("Another agent's message is reaching it."))
      const { input, submit, text } = mountAgent(claude, value)
      await submit("run the tests")
      expect(calls.send).toHaveBeenCalledWith(key, "run the tests")
      expect(input.value).toBe("")
      expect(text()).toContain("Another agent's message is reaching it.")
    })

    it("interrupts on Escape while the agent works, and takes its words back", async () => {
      const { value, calls } = link(conversation({}))
      calls.interrupt.mockResolvedValueOnce("queued words")
      const { input } = mountAgent({ ...claude, agent: { working: true } }, value)
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      })
      expect(calls.interrupt).toHaveBeenCalledWith(key)
      expect(input.value).toBe("queued words")
    })

    it("appends the words an Escape gives back to what was typed", async () => {
      const { value, calls } = link(conversation({}))
      calls.interrupt.mockResolvedValueOnce("queued words")
      const { input, type } = mountAgent({ ...claude, agent: { working: true } }, value)
      type("so far")
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      })
      expect(input.value).toBe("so far queued words")
    })

    it("announces a note from a region that was mounted before it", async () => {
      const { value } = link(conversation({ requests: [asking({})] }))
      const { view, submit } = mountAgent(claude, value)
      const region = (): Element | null =>
        view.container.querySelector('.agent-tail [role="status"]')
      const before = region()
      expect(before?.textContent).toBe("")
      await submit("maybe")
      expect(region()).toBe(before)
      expect(before?.textContent).toContain("Type an option's number.")
    })

    it("drops the note once another request is shown", async () => {
      const { value, store } = link(conversation({ requests: [asking({})] }))
      const { submit, text } = mountAgent(claude, value)
      await submit("maybe")
      expect(text()).toContain("Type an option's number.")
      act(() => void store.update((c) => ({ ...c, requests: [asking({ id: "r2" })] })))
      expect(text()).not.toContain("Type an option's number.")
    })

    it("says which of several requests it shows, and advances as they are answered", () => {
      const { value, store } = link(
        conversation({ requests: [asking({ id: "a" }), asking({ id: "b" }), asking({ id: "c" })] }),
      )
      const { view } = mountAgent(claude, value)
      const tag = (): string => view.container.querySelector(".agent-ask-tag")!.textContent!
      expect(tag()).toContain("1 of 3")
      act(
        () =>
          void store.update((c) => ({
            ...c,
            requests: c.requests.map((each) => ({ ...each, answered: each.id === "a" })),
          })),
      )
      expect(tag()).toContain("2 of 3")
    })

    it("names no place for a lone request", () => {
      const { value } = link(conversation({ requests: [asking({})] }))
      const { view } = mountAgent(claude, value)
      expect(view.container.querySelector(".agent-ask-tag")!.textContent).not.toContain(" of ")
    })

    it("ignores Escape while it rests", () => {
      const { value, calls } = link(conversation({}))
      const { input } = mountAgent(claude, value)
      act(
        () =>
          void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      )
      expect(calls.interrupt).not.toHaveBeenCalled()
    })

    it("scrolls to the end as the conversation grows", () => {
      const { value, store } = link(conversation({}))
      const { view, text } = mountAgent(claude, value)
      const output = view.container.querySelector<HTMLElement>(".demo-output")!
      Object.defineProperty(output, "scrollHeight", { configurable: true, value: 900 })
      output.scrollTop = 0
      // The person scrolled up before the news came.
      act(() => void output.dispatchEvent(new Event("scroll")))
      act(
        () =>
          void store.update((c) => ({
            ...c,
            items: [item("8", {}), item("9", { text: "More news." })],
          })),
      )
      expect(text()).toContain("More news.")
      expect(output.scrollTop).toBe(900)
    })
  })

  context("repeating a note", () => {
    it("renders the same note anew, so the screen's live region announces it again", async () => {
      const { value } = link(conversation({ requests: [asking({})] }))
      const { view, submit } = mountAgent(claude, value)
      const region = (): Element => view.container.querySelector(".agent-note")!
      await submit("maybe")
      const first = region().firstElementChild
      expect(region().textContent).toBe("Type an option's number.")
      await submit("maybe")
      expect(region().textContent).toBe("Type an option's number.")
      expect(region().firstElementChild).not.toBe(first)
    })
  })

  context("without the link, or for a terminal that runs no agent", () => {
    it("keeps the engine's behaviour", async () => {
      const { value, calls } = link(conversation({ requests: [asking({})] }))
      const plain = mountAgent(shell, value)
      await plain.submit("help")
      expect(plain.text()).toContain("Local demo commands")
      const unlinked = mountAgent(claude, undefined)
      await unlinked.submit("help")
      expect(unlinked.text()).toContain("Local demo commands")
      expect(unlinked.view.container.querySelector(".agent-ask")).toBeNull()
      expect(calls.send).not.toHaveBeenCalled()
      expect(calls.answer).not.toHaveBeenCalled()
    })
  })
})

const workspace = (terminal: TerminalMetadata): Workspace => ({
  activeProjectId: "p",
  projects: [
    {
      id: "p",
      name: "p",
      directory: "~/p",
      activeSessionId: "s",
      history: [
        {
          id: "s",
          name: "s",
          visitedAt: 0,
          state: createTerminalState([terminal], "grid", "grid"),
        },
      ],
    },
  ],
})
describe("an agent terminal's opening", () => {
  const codex: TerminalMetadata = { ...claude, process: "codex" }
  const planning: TerminalMetadata = { ...claude, agent: { working: true, planning: true } }
  const working: TerminalMetadata = { ...claude, agent: { working: true } }
  // One engine, as the backend keeps it, under surfaces that come and go with the views.
  const setup = (first: TerminalMetadata) => {
    const engine = createDemoEngine()
    engine.reconcile(workspace(first), [])
    const Surface = createDemoTerminal(engine)
    const surface = (terminal: TerminalMetadata) =>
      createElement(Surface, {
        terminalKey: key,
        terminal,
        projectName: "novadeck",
        view: "focus",
        fontSize: 13,
        focusInput: false,
        onInputFocused: () => {},
        renderWindow: (content: ReactNode) => content,
      })
    // The workspace changes first, then the surface that shows it renders.
    const change = (terminal: TerminalMetadata): void => engine.reconcile(workspace(terminal), [])
    const mountView = (terminal: TerminalMetadata) => {
      const view = render(surface(terminal))
      mounted.push(view)
      return { view, text: () => view.container.textContent ?? "" }
    }
    return { surface, change, mountView }
  }

  it("keeps what the agent opened with when its surface remounts in another view", () => {
    const { change, mountView } = setup(planning)
    const grid = mountView(planning)
    expect(grid.text()).toContain("Plan a compact order summary")
    grid.view.unmount()
    mounted.splice(0)
    change(working)
    const focus = mountView(working)
    expect(focus.text()).toContain("Plan a compact order summary")
    expect(focus.text()).not.toContain("Add a compact order summary")
  })

  it("keeps an opening without plan mode as it was when plan mode comes on", () => {
    const { change, mountView } = setup(working)
    mountView(working).view.unmount()
    mounted.splice(0)
    change(planning)
    const canvas = mountView(planning)
    expect(canvas.text()).toContain("Add a compact order summary")
    expect(canvas.text()).not.toContain("Plan a compact order summary")
  })

  it("keeps it while mounted, as plan mode toggles", () => {
    const { change, surface, mountView } = setup(planning)
    const { view, text } = mountView(planning)
    change(working)
    view.rerender(surface(working))
    expect(text()).toContain("Plan a compact order summary")
  })

  it("opens afresh for the agent it becomes, and keeps that opening in turn", () => {
    const { change, surface, mountView } = setup(codex)
    const { view, text } = mountView(codex)
    expect(text()).toContain("Review the checkout changes")
    change(planning)
    view.rerender(surface(planning))
    expect(text()).toContain("Plan a compact order summary")
    expect(text()).not.toContain("Review the checkout changes")
    change(working)
    view.unmount()
    mounted.splice(0)
    const next = mountView(working)
    expect(next.text()).toContain("Plan a compact order summary")
    change(codex)
    next.view.rerender(surface(codex))
    expect(next.text()).toContain("Review the checkout changes")
  })
})
