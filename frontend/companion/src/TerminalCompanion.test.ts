import { emptyCompanions, isOnBar } from "@novadeck/core/companion"
import { emptyBar, messagesKey } from "@novadeck/core/companion-bar"
import { noMail, type AgentMessage, type MailState, type Messages } from "@novadeck/core/messages"
import { activeSession, workspaceReducer, type WorkspaceAction } from "@novadeck/core/state"
import { createStore, createWorkspaceStore, type WorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import type { Workspace } from "@novadeck/core/types"
import { render } from "@novadeck/test-kit/render"
import { act, createElement, useSyncExternalStore, type ComponentProps } from "react"
import { afterEach, vi } from "vitest"

import { createDragSession, DragSessionContext } from "./drag-session"
import { createPanes, type Panes } from "./state"
import { TerminalCompanion, type ItemCommands } from "./TerminalCompanion"
import { context, describe, expect, it } from "./test"

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
  panes,
  messages,
}: {
  workspace: WorkspaceStore
  panes: Panes
  messages: Messages | undefined
}) => {
  const state = useSyncExternalStore(
    workspace.subscribe,
    () => activeSession(workspace.getSnapshot())!.state,
  )
  const props: ComponentProps<typeof TerminalCompanion> = {
    panes,
    messages,
    peerName: () => undefined,
    companionKey: key,
    view: "focus",
    bar: state.bars["01"] ?? emptyBar,
    items: state.items.filter((item) => isOnBar(item, "01")),
    fresh: state.fresh,
    commands: commandsOf(workspace),
    children: null,
  }
  return createElement(TerminalCompanion, props)
}

// Renders the terminal as the app does: its panes made first, following the backend only
// once it has mounted.
const renderTerminal = (
  initial: Workspace,
  messages?: Messages,
): { container: HTMLElement; workspace: WorkspaceStore } => {
  const workspace = createWorkspaceStore(initial)
  const panes = createPanes({ companions: emptyCompanions(), workspace, messages })
  const { container, unmount } = render(
    createElement(
      DragSessionContext,
      { value: createDragSession() },
      createElement(Terminal, { workspace, panes, messages }),
    ),
  )
  unmounts.push(unmount)
  // Connecting tells the terminal its messages: a render of its own, inside act.
  let disconnect = (): void => {}
  act(() => {
    disconnect = panes.connect()
  })
  unmounts.push(disconnect)
  return { container, workspace }
}

// A message for the terminal from its peer, and the terminal's messages holding them.
const message = (id: string): AgentMessage => ({
  id,
  hop: 1,
  from: "fox",
  to: "moth",
  text: "Ready for review",
  sentAt: 0,
  state: "delivered",
  held: null,
  deliveredAt: 0,
})
const mailOf = (messages: readonly AgentMessage[]): MailState => ({
  ...noMail,
  terminals: {
    "project/initial/01": {
      handle: "moth",
      agent: true,
      threads: [{ id: "th", peer: "fox", hops: 1, allowed: 4, held: false, messages }],
    },
  },
})

const taskbar = (container: HTMLElement) => container.querySelector(".plan-taskbar")
const icon = (container: HTMLElement, name: string) =>
  container.querySelector(`.plan-tb-item[aria-label^='${name}']`)

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
        [...container.querySelectorAll(".plan-stack-sheet")].map((each) =>
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
      expect(container.querySelectorAll(".plan-stack-sheet")).toHaveLength(0)
    })

    it("hides the whole pane on Escape, marking everything open as waiting", async () => {
      const { container } = renderTerminal(opened())
      const pane = container.querySelector<HTMLElement>(".plan-reader")
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

    it("hides the whole pane on Escape from a sheet peeking out behind it", async () => {
      const { container } = renderTerminal(opened())
      const card = container.querySelector<HTMLElement>(".plan-stack-sheet")
      await act(async () =>
        card?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      )
      expect(icon(container, "hero.png")?.getAttribute("data-state")).toBe("behind")
      expect(icon(container, "notes")?.getAttribute("data-state")).toBe("behind")
    })
  })

  context("when the person closed the messages", () => {
    it("brings them back with the next message", async () => {
      const state = createStore(mailOf([message("m1")]))
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
      await act(async () => state.update(() => mailOf([message("m1"), message("m2")])))
      expect(messagesIcon()).not.toBeNull()
    })
  })
})
