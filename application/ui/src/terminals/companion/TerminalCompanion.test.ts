import { act, createElement, useSyncExternalStore, type ComponentProps } from "react"
import { afterEach, vi } from "vitest"

import { emptyCompanions, isOnBar } from "../../model/companion"
import { emptyBar, messagesKey } from "../../model/companion-bar"
import { noMail, type AgentMessage, type MailState, type Messages } from "../../model/messages"
import { activeSession, workspaceReducer, type WorkspaceAction } from "../../model/state"
import { createStore, createWorkspaceStore, type WorkspaceStore } from "../../model/store"
import type { Workspace } from "../../model/types"
import { context, describe, expect, it } from "../../test"
import { itemFixture, workspaceFixture } from "../../test/fixtures"
import { render } from "../../test/render"
import { createDragSession, DragSessionContext } from "../drag-session"
import { createPanes, type Panes } from "./state"
import { TerminalCompanion, type ItemCommands } from "./TerminalCompanion"

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

// What a terminal does with its bar, as the app's commands would, here only hiding.
const commandsOf = (workspace: WorkspaceStore): ItemCommands => ({
  undock: () => {},
  place: () => {},
  closeItem: () => {},
  markSeen: () => {},
  openBarTab: () => {},
  closeBarPane: () => {},
  hideOnBar: (terminalId, barKey) =>
    void workspace.dispatch({ type: "bar/hide", target, terminalId, key: barKey }),
  moveBarSlot: () => {},
})

// Terminal 01 as the app renders it, from the workspace as it stands.
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
  unmounts.push(panes.connect())
  return { container, workspace }
}

// A message for the terminal from its peer, and the terminal's messages holding them.
const message = (id: string): AgentMessage => ({
  id,
  hop: 1,
  from: "t2",
  to: "t1",
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
      handle: "t1",
      agent: true,
      threads: [{ id: "th", peer: "t2", hops: 1, allowed: 4, held: false, messages }],
    },
  },
})

const taskbar = (container: HTMLElement) => container.querySelector(".plan-taskbar")

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

  context("when the person closed the messages", () => {
    it("brings them back with the next message", async () => {
      const state = createStore(mailOf([message("m1")]))
      const { container, workspace } = renderTerminal(
        workspaceReducer(workspaceFixture(), shown()),
        {
          state,
          pause: () => {},
          release: () => {},
        },
      )
      const icon = () => container.querySelector(".plan-tb-item[aria-label^='Messages']")
      expect(icon()).not.toBeNull()
      // As its menu's Close does.
      await act(
        async () =>
          void workspace.dispatch({ type: "bar/hide", target, terminalId: "01", key: messagesKey }),
      )
      expect(icon()).toBeNull()
      await act(async () => state.update(() => mailOf([message("m1"), message("m2")])))
      expect(icon()).not.toBeNull()
    })
  })
})
