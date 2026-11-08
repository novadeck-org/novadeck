import { emptyCompanions, isOnBar, type Companions, type ItemContent } from "@novadeck/core/items"
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
  closeItem: (itemId) => void workspace.dispatch({ type: "item/close", target, itemId }),
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
    terminalKey: key,
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
  companions: Companions = emptyCompanions(),
): { container: HTMLElement; workspace: WorkspaceStore; itemStore: ItemStore } => {
  const workspace = createWorkspaceStore(initial)
  const itemStore = createItemStore({ companions, workspace })
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
  return { container, workspace, itemStore }
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

describe("a pane beside its terminal", () => {
  it("offers its divider to a screen reader as what resizes the pane", () => {
    const { container } = renderTerminal(
      workspaceReducer(workspaceReducer(workspaceFixture(), shown()), {
        type: "bar/open",
        target,
        terminalId: "01",
        key: hero.id,
      }),
    )
    const divider = container.querySelector(".pane-divider")
    expect(divider?.getAttribute("role")).toBe("separator")
    expect(divider?.getAttribute("aria-label")).toBe("Resize pane")
  })

  context("when a drag on its divider is cancelled", () => {
    it("stops resizing the pane with the pointer's moves", () => {
      const { container } = renderTerminal(
        workspaceReducer(workspaceReducer(workspaceFixture(), shown()), {
          type: "bar/open",
          target,
          terminalId: "01",
          key: hero.id,
        }),
      )
      const frame = container.querySelector<HTMLElement>(".pane-split")!
      frame.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 600)
      const divider = container.querySelector<HTMLElement>(".pane-divider")!
      divider.setPointerCapture = () => {}
      const pointer = (type: string, clientX: number) =>
        act(() => {
          divider.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX, pointerId: 1 }))
        })
      const ratio = () => divider.getAttribute("aria-valuenow")
      pointer("pointerdown", 500)
      pointer("pointermove", 400)
      expect(ratio()).toBe("40")
      pointer("pointercancel", 400)
      pointer("pointermove", 600)
      expect(ratio()).toBe("40")
    })
  })
})

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

  context("when the person closes a plan placed here whose edits can't be saved", () => {
    // Plans another terminal's agent made, placed on this terminal's bar.
    const placed = (id: string, name: string) =>
      itemFixture(id, "01", {
        kind: "plan",
        name,
        path: `/p/${id}.md`,
        from: { terminalId: "02", handle: "fox" },
        plan: { agent: "Codex", role: "root", source: "file" },
      })
    // A plan titled after its file's name, as `first.md` reads "First".
    const titleOf = (name: string) => name[0]!.toUpperCase() + name.slice(1, -3)
    const ready = (text: string): ItemContent => ({
      state: "ready",
      stamp: "1",
      content: { kind: "plan", text, truncated: false, writable: true, skill: true },
    })
    const edited = (name: string) => `# ${titleOf(name)}\n\nMine.\n`
    // The plans on the bar, each edited, then its file gone: the edits can't reach it.
    const stuck = async (plans: readonly ReturnType<typeof placed>[]) => {
      const emitters = new Map<string, (content: ItemContent) => void>()
      const companions: Companions = {
        ...emptyCompanions(),
        follow: (_target, itemId, _options, on) => {
          emitters.set(itemId, on)
          const item = plans.find((each) => each.id === itemId)!
          on(ready(`# ${titleOf(item.name)}\n`))
          return () => {}
        },
        save: () => new Promise(() => {}),
      }
      const initial = plans.reduce(
        (workspace, item) => workspaceReducer(workspace, shown(item)),
        workspaceFixture(),
      )
      const rendered = renderTerminal(initial, undefined, companions)
      await act(async () => {
        for (const item of plans) {
          rendered.itemStore.plan(target, item.id).edit(edited(item.name), [])
          emitters.get(item.id)!({ state: "unavailable", reason: "gone", size: null })
        }
      })
      return rendered
    }
    const dialog = () => document.querySelector<HTMLElement>("[role='alertdialog']")
    const answer = async (label: string) => {
      const button = [...dialog()!.querySelectorAll("button")].find(
        (each) => each.textContent === label,
      )!
      await act(async () => button.click())
    }
    const onBar = (workspace: WorkspaceStore) =>
      activeSession(workspace.getSnapshot())!.state.items.map((item) => item.name)
    // jsdom has no clipboard: the one the page has here, until the test ends.
    const clipboard = (writeText?: (text: string) => Promise<void>) => {
      Object.defineProperty(navigator, "clipboard", {
        value: writeText && { writeText },
        configurable: true,
      })
      unmounts.push(() => Reflect.deleteProperty(navigator, "clipboard"))
    }

    it("copies the edits, then closes it", async () => {
      const copied: string[] = []
      clipboard(async (text) => void copied.push(text))
      const { container, workspace } = await stuck([placed("p1", "first.md")])
      await act(async () => (icon(container, "Plan: First") as HTMLElement).click())
      await act(async () =>
        container.querySelector<HTMLElement>("[aria-label='Close First']")!.click(),
      )
      expect(dialog()?.textContent).toContain("couldn't be saved, and closing it loses them")
      await answer("Copy my edits and close")
      expect(copied).toEqual([edited("first.md")])
      expect(onBar(workspace)).toEqual([])
    })

    it("keeps it open and says so when the edits couldn't be copied", async () => {
      const writeText = vi.fn<(text: string) => Promise<void>>(() =>
        Promise.reject(new Error("Document is not focused")),
      )
      clipboard(writeText)
      const { container, workspace } = await stuck([placed("p1", "first.md")])
      await act(async () => (icon(container, "Plan: First") as HTMLElement).click())
      await act(async () =>
        container.querySelector<HTMLElement>("[aria-label='Close First']")!.click(),
      )
      await answer("Copy my edits and close")
      expect(writeText).toHaveBeenCalledOnce()
      expect(onBar(workspace)).toEqual(["first.md"])
      expect(dialog()?.textContent).toContain("Your edits couldn't be copied")
      // The dialog still cancels, though it was confirmed.
      await act(async () =>
        dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      )
      await vi.waitFor(() => expect(dialog()).toBeNull())
      expect(onBar(workspace)).toEqual(["first.md"])
    })

    it("keeps it open where there's no clipboard", async () => {
      clipboard()
      const { container, workspace } = await stuck([placed("p1", "first.md")])
      await act(async () => (icon(container, "Plan: First") as HTMLElement).click())
      await act(async () =>
        container.querySelector<HTMLElement>("[aria-label='Close First']")!.click(),
      )
      await answer("Copy my edits and close")
      expect(onBar(workspace)).toEqual(["first.md"])
      expect(dialog()?.textContent).toContain("Your edits couldn't be copied")
    })

    // The plan's close asked for and confirmed, with a clipboard whose write waits to be
    // answered.
    const confirmedPending = async () => {
      const writes: { resolve: () => void; reject: (error: Error) => void }[] = []
      clipboard(() => new Promise<void>((resolve, reject) => void writes.push({ resolve, reject })))
      const rendered = await stuck([placed("p1", "first.md")])
      const close = () =>
        act(async () =>
          rendered.container.querySelector<HTMLElement>("[aria-label='Close First']")!.click(),
        )
      await act(async () => (icon(rendered.container, "Plan: First") as HTMLElement).click())
      await close()
      await answer("Copy my edits and close")
      return { ...rendered, writes, close }
    }

    it("copies once however often the person confirms while the copy is under way", async () => {
      const { writes, workspace } = await confirmedPending()
      await answer("Copy my edits and close")
      expect(writes).toHaveLength(1)
      await act(async () => writes[0]!.resolve())
      expect(onBar(workspace)).toEqual([])
    })

    it("lets a copy the person cancelled go, keeping the plan and saying nothing of it", async () => {
      const { writes, workspace, close } = await confirmedPending()
      await answer("Cancel")
      await act(async () => writes[0]!.reject(new Error("Document is not focused")))
      expect(onBar(workspace)).toEqual(["first.md"])
      await vi.waitFor(() => expect(dialog()).toBeNull())
      await close()
      expect(dialog()?.textContent).toContain("couldn't be saved, and closing it loses them")
    })

    it("doesn't ask about a stuck plan that left the bar while it waited its turn", async () => {
      clipboard(async () => {})
      const { container, workspace } = await stuck([
        placed("p1", "first.md"),
        placed("p2", "second.md"),
      ])
      const stack = icon(container, "2 plans") as HTMLElement
      await act(async () =>
        stack.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
      )
      const close = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
        (each) => each.textContent === "Close 2 plans",
      )!
      await act(async () => close.click())
      await vi.waitFor(() =>
        expect(dialog()?.querySelector(".modal-subject")?.textContent).toBe("first.md"),
      )
      // Its agent closed the second meanwhile.
      await act(
        async () =>
          void workspace.dispatch({ type: "item/close", target, itemId: placed("p2", "").id }),
      )
      await answer("Copy my edits and close")
      await vi.waitFor(() => expect(dialog()).toBeNull())
      expect(onBar(workspace)).toEqual([])
    })

    it("asks about each of a stack's stuck plans in turn", async () => {
      clipboard(async () => {})
      const { container, workspace } = await stuck([
        placed("p1", "first.md"),
        placed("p2", "second.md"),
      ])
      const stack = icon(container, "2 plans") as HTMLElement
      await act(async () =>
        stack.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
      )
      const close = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
        (each) => each.textContent === "Close 2 plans",
      )!
      await act(async () => close.click())
      // The menu runs what was chosen once it has closed, a frame later.
      await vi.waitFor(() =>
        expect(dialog()?.querySelector(".modal-subject")?.textContent).toBe("first.md"),
      )
      await answer("Copy my edits and close")
      await vi.waitFor(() =>
        expect(dialog()?.querySelector(".modal-subject")?.textContent).toBe("second.md"),
      )
      await answer("Copy my edits and close")
      expect(onBar(workspace)).toEqual([])
    })
  })
})
