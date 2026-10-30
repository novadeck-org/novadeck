import { emptyCompanions, isOnBar } from "@novadeck/core/items"
import { emptyBar, messagesKey } from "@novadeck/core/items/companion-bar"
import {
  noMessages,
  type AgentMessage,
  type MessageParty,
  type MessagesState,
  type Messages,
} from "@novadeck/core/messages"
import { activeSession, workspaceReducer, type WorkspaceAction } from "@novadeck/core/state"
import { createStore, createWorkspaceStore, type WorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import type { Workspace } from "@novadeck/core/types"
import { render } from "@novadeck/test-kit/render"
import { act, createElement, useSyncExternalStore, type ComponentProps } from "react"
import { afterEach, vi } from "vitest"

import { createDragSession, DragSessionContext } from "../../bar/drag-session"
import { createItemStore, type ItemStore } from "../../store/item-store"
import { context, describe, expect, it } from "../../test"
import { followMessages, noLinks } from "./messages/messages"
import { TerminalCompanion, type ItemCommands } from "./TerminalCompanion"

const agent = (handle: string): MessageParty => ({ kind: "agent", handle, agent: null })

// jsdom has no layout and no resizes; the taskbar's drag-to-reorder asks for them.
vi.hoisted(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const target = { projectId: "project", workspaceSessionId: "initial" }
const key = { ...target, terminalId: "01" }
const hero = itemFixture("hero", "01", { kind: "image", name: "hero.png", path: "/p/hero.png" })
const shown = (item = hero): WorkspaceAction => ({ type: "item/upsert", target, item })

const notes = itemFixture("notes", "01", {
  kind: "page",
  name: "notes",
  path: null,
  url: "http://x/",
})

// What a terminal does with its bar, as the app's commands would, here only opening,
// minimizing and hiding.
const commandsOf = (workspace: WorkspaceStore): ItemCommands => ({
  undock: () => {},
  place: () => {},
  closeItem: () => {},
  markSeen: () => {},
  openBarTab: (terminalId, barKey) =>
    void workspace.dispatch({ type: "bar/open", target, terminalId, key: barKey }),
  minimizeOnBar: (terminalId, barKey) =>
    void workspace.dispatch({ type: "bar/minimize", target, terminalId, key: barKey }),
  closeBarPane: (terminalId) => void workspace.dispatch({ type: "bar/close", target, terminalId }),
  hideOnBar: (terminalId, barKey) =>
    void workspace.dispatch({ type: "bar/hide", target, terminalId, key: barKey }),
  moveBarSlot: () => {},
})

// The first terminal as the app renders it, from the workspace as it stands.
const Terminal = ({
  workspace,
  itemStore,
  messages,
}: {
  workspace: WorkspaceStore
  itemStore: ItemStore
  messages: Messages | undefined
}) => {
  const state = useSyncExternalStore(
    workspace.subscribe,
    () => activeSession(workspace.getSnapshot())!.state,
  )
  const props: ComponentProps<typeof TerminalCompanion> = {
    itemStore,
    messages,
    links: noLinks,
    companionKey: key,
    view: "focus",
    bar: state.bars["01"] ?? emptyBar,
    items: state.items.filter((item) => isOnBar(item, "01")),
    fresh: state.fresh,
    commands: commandsOf(workspace),
    children: createElement("textarea", { "data-terminal-input": "" }),
  }
  return createElement(TerminalCompanion, props)
}

// Renders the terminal as the app does: its item store made first, following the backend and
// the messages only once it has mounted.
const renderTerminal = (
  initial: Workspace,
  messages?: Messages,
): { container: HTMLElement; workspace: WorkspaceStore } => {
  const workspace = createWorkspaceStore(initial)
  const itemStore = createItemStore({ companions: emptyCompanions(), workspace })
  const { container, unmount } = render(
    createElement(
      DragSessionContext,
      { value: createDragSession() },
      createElement(Terminal, { workspace, itemStore, messages }),
    ),
  )
  unmounts.push(unmount)
  // Following the messages tells the terminal its messages: a render of its own, inside act.
  act(() => {
    unmounts.push(itemStore.connect())
    if (messages) unmounts.push(followMessages(workspace, messages))
  })
  return { container, workspace }
}

// A message for the terminal from its peer, and the terminal's messages holding them.
const message = (id: string): AgentMessage => ({
  id,
  hop: 1,
  from: agent("fox"),
  to: agent("moth"),
  text: "Ready for review",
  sentAt: 0,
  state: "delivered",
  held: null,
  deliveredAt: 0,
})
const messagesOf = (messages: readonly AgentMessage[]): MessagesState => ({
  ...noMessages,
  terminals: {
    "project/initial/01": {
      handle: "moth",
      agent: true,
      threads: [
        { id: "th", peer: agent("fox"), hops: 1, idle: 0, held: false, heldFor: null, messages },
      ],
    },
  },
})

const taskbar = (container: HTMLElement) => container.querySelector(".taskbar")
const icon = (container: HTMLElement, name: string) =>
  container.querySelector(`.taskbar-item[aria-label^='${name}']`)

describe("a pane covering its terminal", () => {
  // jsdom has no container queries: the narrow window's rule (pane.css) is set by hand.
  const covered = (): { container: HTMLElement; input: HTMLTextAreaElement } => {
    const { container } = renderTerminal(
      workspaceReducer(workspaceReducer(workspaceFixture(), shown()), {
        type: "bar/open",
        target,
        terminalId: "01",
        key: hero.id,
      }),
    )
    container.querySelector<HTMLElement>(".pane-split")?.style.setProperty("--_pane-cover", "1")
    return { container, input: container.querySelector("textarea")! }
  }
  const press = async (
    on: Element | null,
    pressed: string,
    init: KeyboardEventInit = {},
  ): Promise<KeyboardEvent> => {
    const event = new KeyboardEvent("keydown", {
      key: pressed,
      bubbles: true,
      cancelable: true,
      ...init,
    })
    await act(async () => void on?.dispatchEvent(event))
    return event
  }
  const open = (container: HTMLElement): boolean =>
    icon(container, "hero.png")?.getAttribute("data-state") === "open"
  // The terminal's input hears what the page lets through.
  const heard = (input: Element): string[] => {
    const keys: string[] = []
    input.addEventListener("keydown", (event) => keys.push((event as KeyboardEvent).key))
    return keys
  }

  it("minimizes on Escape, which never reaches the terminal", async () => {
    const { container, input } = covered()
    const keys = heard(input)
    expect((await press(input, "Escape")).defaultPrevented).toBe(true)
    expect(open(container)).toBe(false)
    expect(keys).toEqual([])
  })

  it("minimizes on Enter without sending it", async () => {
    const { container, input } = covered()
    const keys = heard(input)
    await press(input, "Enter")
    expect(open(container)).toBe(false)
    expect(keys).toEqual([])
  })

  it("holds back an Escape held down, once the pane is gone", async () => {
    const { container, input } = covered()
    // The pane's leaving remounts this stand-in for the terminal, where the app moves its
    // one terminal element across: what's heard is the input there now.
    const keys = heard(container)
    const terminalInput = (): HTMLTextAreaElement => container.querySelector("textarea")!
    await press(input, "Escape")
    await vi.waitFor(() => expect(container.querySelector(".pane-reader")).toBeNull())
    await press(terminalInput(), "Escape", { repeat: true })
    expect(open(container)).toBe(false)
    expect(keys).toEqual([])
    await act(
      async () =>
        void terminalInput().dispatchEvent(
          new KeyboardEvent("keyup", { key: "Escape", bubbles: true }),
        ),
    )
    await press(terminalInput(), "Escape")
    expect(keys).toEqual(["Escape"])
  })

  it.each(["a", "Backspace", "ArrowUp", "Tab"])(
    "minimizes on %s, which goes on to the terminal",
    async (typed) => {
      const { container, input } = covered()
      const keys = heard(input)
      expect((await press(input, typed)).defaultPrevented).toBe(false)
      expect(open(container)).toBe(false)
      expect(keys).toEqual([typed])
    },
  )

  it("stays over the terminal for a modifier alone", async () => {
    const { container, input } = covered()
    await press(input, "Shift", { shiftKey: true })
    await press(input, "Control", { ctrlKey: true })
    expect(open(container)).toBe(true)
  })

  it("leaves the keys of its own fields to them", async () => {
    const { container } = covered()
    const field = document.createElement("input")
    container.querySelector(".pane-reader")?.append(field)
    await press(field, "a")
    await press(field, "Enter")
    expect(open(container)).toBe(true)
  })

  // The terminal reads a key by its code, so the one it gets is the key pressed, not one
  // made from its character: "." is not Delete (46), nor "(" Down (40).
  it.each([
    ["a", "KeyA", 65, false],
    [".", "Period", 190, false],
    ["(", "Digit9", 57, true],
  ] as const)(
    "takes %s typed on its surface into the terminal",
    async (typed, code, keyCode, shiftKey) => {
      const { container, input } = covered()
      const reader = await vi.waitFor(() => {
        const found = container.querySelector(".pane-reader")
        if (!found) throw new Error("its viewer is still loading")
        return found
      })
      const got: KeyboardEvent[] = []
      input.addEventListener("keydown", (event) => got.push(event))
      const event = await press(reader, typed, { code, keyCode, shiftKey })
      expect(event.defaultPrevented).toBe(true)
      expect(open(container)).toBe(false)
      expect(
        got.map((each) => ({
          key: each.key,
          code: each.code,
          keyCode: each.keyCode,
          shiftKey: each.shiftKey,
        })),
      ).toEqual([{ key: typed, code, keyCode, shiftKey }])
    },
  )

  it("minimizes on Escape from a control on its surface", async () => {
    const { container } = covered()
    const button = document.createElement("button")
    container.querySelector(".pane-reader")?.append(button)
    await press(button, "Escape")
    expect(open(container)).toBe(false)
  })

  it("minimizes on a character typed on a control, leaving it to the app to reach the terminal", async () => {
    const { container, input } = covered()
    const button = document.createElement("button")
    container.querySelector(".pane-reader")?.append(button)
    const typed: string[] = []
    input.addEventListener("keydown", (event) => typed.push(event.key))
    expect((await press(button, "a")).defaultPrevented).toBe(false)
    expect(open(container)).toBe(false)
    expect(typed).toEqual([])
  })

  it("leaves Space on a control to it", async () => {
    const { container } = covered()
    const button = document.createElement("button")
    container.querySelector(".pane-reader")?.append(button)
    await press(button, " ")
    expect(open(container)).toBe(true)
  })

  it("minimizes on a character typed with focus nowhere, once the app sends it to the terminal", async () => {
    const { container, input } = covered()
    const app = (): void => input.focus()
    window.addEventListener("keydown", app)
    await press(document.body, "a")
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve))))
    window.removeEventListener("keydown", app)
    expect(open(container)).toBe(false)
  })

  it("stays over the terminal for a character typed elsewhere that doesn't reach it", async () => {
    const { container } = covered()
    await press(document.body, "a")
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve))))
    expect(open(container)).toBe(true)
  })

  it("leaves a composition's keys to the input method", async () => {
    const { container, input } = covered()
    await press(input, "a", { isComposing: true })
    await press(input, "Process", { keyCode: 229 })
    expect(open(container)).toBe(true)
  })

  it("stops holding back an Escape when the window is left", async () => {
    const { input } = covered()
    const keys = heard(input)
    await press(input, "Escape")
    await act(async () => void window.dispatchEvent(new Event("blur")))
    await press(input, "Escape", { repeat: true })
    expect(keys).toEqual(["Escape"])
  })

  it("leaves Enter and Tab on its surface to the pane", async () => {
    const { container } = covered()
    await press(container.querySelector(".pane-reader"), "Enter")
    await press(container.querySelector(".pane-reader"), "Tab")
    expect(open(container)).toBe(true)
  })

  it("leaves a key the app took first alone", async () => {
    const { container, input } = covered()
    const app = (event: KeyboardEvent): void => event.stopPropagation()
    window.addEventListener("keydown", app, true)
    await press(input, "k", { ctrlKey: true, shiftKey: true })
    window.removeEventListener("keydown", app, true)
    expect(open(container)).toBe(true)
  })

  it("does nothing where the pane shares the window", async () => {
    const { container, input } = covered()
    container.querySelector<HTMLElement>(".pane-split")?.style.removeProperty("--_pane-cover")
    await press(input, "Escape")
    expect(open(container)).toBe(true)
  })
})

describe("a terminal's taskbar", () => {
  context("when the agent first shows something", () => {
    it("appears marked open, so it animates in", async () => {
      const { container, workspace } = renderTerminal(workspaceFixture())
      expect(taskbar(container)).toBeNull()
      // Async, so the presence's microtask, which marks a change after mount, runs too.
      await act(async () => void workspace.dispatch(shown()))
      expect(taskbar(container)?.getAttribute("data-state")).toBe("open")
    })
  })

  context("when the terminal already had something to show as it mounted", () => {
    it("appears as it was, without animating", () => {
      const { container } = renderTerminal(workspaceReducer(workspaceFixture(), shown()))
      expect(taskbar(container)).not.toBeNull()
      expect(taskbar(container)?.hasAttribute("data-state")).toBe(false)
    })
  })

  context("when several things are open in the pane", () => {
    const opened = (): Workspace =>
      [hero, notes].reduce(
        (workspace, item) =>
          workspaceReducer(workspaceReducer(workspace, shown(item)), {
            type: "bar/open",
            target,
            terminalId: "01",
            key: item.id,
          }),
        workspaceFixture(),
      )

    it("shows the last opened, marking the one behind it, which peeks out above it", () => {
      const { container } = renderTerminal(opened())
      expect(icon(container, "notes")?.getAttribute("data-state")).toBe("open")
      expect(icon(container, "hero.png")?.getAttribute("data-state")).toBe("behind")
      expect(
        [...container.querySelectorAll(".pane-stack-sheet")].map((each) =>
          each.getAttribute("aria-label"),
        ),
      ).toEqual(["Bring forward hero.png"])
    })

    it("uncovers the one behind when the person minimizes the top from its icon", async () => {
      const { container } = renderTerminal(opened())
      await act(async () =>
        icon(container, "notes")?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
      )
      expect(icon(container, "hero.png")?.getAttribute("data-state")).toBe("open")
      expect(icon(container, "notes")?.getAttribute("data-state")).toBe("seen")
      expect(container.querySelectorAll(".pane-stack-sheet")).toHaveLength(0)
    })

    it("hides the whole pane on Escape, marking everything open as waiting", async () => {
      const { container } = renderTerminal(opened())
      const pane = container.querySelector<HTMLElement>(".pane-reader")
      await act(async () =>
        pane?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      )
      expect(icon(container, "hero.png")?.getAttribute("data-state")).toBe("behind")
      expect(icon(container, "notes")?.getAttribute("data-state")).toBe("behind")
    })

    it("leaves focus where it was when something else comes to the top, as an agent's does", async () => {
      const { container, workspace } = renderTerminal(opened())
      ;(document.activeElement as HTMLElement | null)?.blur()
      await act(
        async () =>
          void workspace.dispatch({ type: "bar/open", target, terminalId: "01", key: hero.id }),
      )
      expect(icon(container, "hero.png")?.getAttribute("data-state")).toBe("open")
      expect(document.activeElement).toBe(document.body)
    })

    it("hands focus to the pane when the person brings forward what peeks out behind it", async () => {
      const { container } = renderTerminal(opened())
      const card = container.querySelector<HTMLButtonElement>(".pane-stack-sheet")
      card?.focus()
      await act(async () => card?.click())
      expect(icon(container, "hero.png")?.getAttribute("data-state")).toBe("open")
      expect(document.activeElement).toBe(container.querySelector(".pane-reader"))
    })

    it("hides the whole pane on Escape from a sheet peeking out behind it", async () => {
      const { container } = renderTerminal(opened())
      const card = container.querySelector<HTMLElement>(".pane-stack-sheet")
      await act(async () =>
        card?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      )
      expect(icon(container, "hero.png")?.getAttribute("data-state")).toBe("behind")
      expect(icon(container, "notes")?.getAttribute("data-state")).toBe("behind")
    })
  })

  context("the messages' icon", () => {
    // The terminal with `state`, and its messages' icon.
    const messagesWith = (initial: MessagesState) => {
      const { container } = renderTerminal(workspaceFixture(), {
        state: createStore(initial),
        pause: () => {},
        release: () => {},
        stop: () => {},
      })
      return icon(container, "Messages")!
    }
    const waiting = { ...message("m2"), state: "queued" } as const

    it("says nothing more while nothing waits and messaging runs", () => {
      const button = messagesWith(messagesOf([message("m1")]))
      expect(button.getAttribute("aria-label")).toBe("Messages")
      expect(button.querySelector(".taskbar-count")).toBeNull()
    })

    it("counts what waits for the agent, and says so", () => {
      const button = messagesWith(messagesOf([message("m1"), waiting]))
      expect(button.getAttribute("aria-label")).toBe("Messages, 1 message waiting")
      const count = button.querySelector(".taskbar-count")
      expect(count?.getAttribute("data-messages")).toBe("waiting")
      expect(count?.textContent).toBe("1")
    })

    it("marks messaging paused while nothing waits", () => {
      const button = messagesWith({ ...messagesOf([message("m1")]), paused: true })
      expect(button.getAttribute("aria-label")).toBe("Messages, messaging paused")
      expect(button.querySelector(".taskbar-count")?.getAttribute("data-messages")).toBe("paused")
    })
  })

  context("when the person closed the messages", () => {
    it("brings them back with the next message", async () => {
      const state = createStore(messagesOf([message("m1")]))
      const { container, workspace } = renderTerminal(
        workspaceReducer(workspaceFixture(), shown()),
        {
          state,
          pause: () => {},
          release: () => {},
          stop: () => {},
        },
      )
      const messagesIcon = () => icon(container, "Messages")
      expect(messagesIcon()).not.toBeNull()
      // As its menu's Close does.
      await act(
        async () =>
          void workspace.dispatch({ type: "bar/hide", target, terminalId: "01", key: messagesKey }),
      )
      expect(messagesIcon()).toBeNull()
      await act(async () => state.update(() => messagesOf([message("m1"), message("m2")])))
      expect(messagesIcon()).not.toBeNull()
    })
  })
})
