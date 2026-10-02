import { act, createElement, type ComponentProps } from "react"
import { afterEach, vi } from "vitest"

import type {
  ArtifactRef,
  CompanionEvent,
  CompanionKey,
  CompanionSnapshot,
  Companions,
} from "../../model/companion"
import { noMail, type AgentMessage, type MailState, type Messages } from "../../model/messages"
import { createStore } from "../../model/store"
import { context, describe, expect, it } from "../../test"
import { render } from "../../test/render"
import { createDragSession, DragSessionContext } from "../drag-session"
import { close, mailTab } from "./pane"
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

const key: CompanionKey = { projectId: "p", workspaceSessionId: "s", terminalId: "01" }
const hero: ArtifactRef = { id: "hero", kind: "image", name: "hero.png", detail: "", version: 1 }

// Companions that start from `shown` and report what `emit` is given.
const companionsOf = (shown: readonly ArtifactRef[]) => {
  const listeners = new Set<(event: CompanionEvent) => void>()
  const snapshot: CompanionSnapshot[] = shown.length ? [{ key, plans: [], shown }] : []
  const companions: Companions = {
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load: () => new Promise(() => {}),
    save: () => Promise.reject(new Error("No plans")),
  }
  // Async, so the presence's microtask, which marks a change after mount, runs too.
  const emit = (event: CompanionEvent) =>
    act(async () => listeners.forEach((listener) => listener(event)))
  return { companions, emit }
}

// What a terminal does with its items, as the app's commands would, here only closing.
const itemsOf = (panes: Panes): ItemCommands => ({
  undock: () => {},
  place: () => {},
  closeItem: (from, item) =>
    panes.of({ ...key, terminalId: from }).update((pane) => close(pane, item)),
})

// Renders the terminal as the app does: its panes made first, following the backend only
// once it has mounted.
const renderTerminal = (
  companions: Companions,
  messages?: Messages,
): { container: HTMLElement; panes: Panes } => {
  const panes = createPanes(companions, messages)
  const props: ComponentProps<typeof TerminalCompanion> = {
    panes,
    messages,
    peerName: () => undefined,
    companionKey: key,
    view: "focus",
    items: itemsOf(panes),
    children: null,
  }
  const { container, unmount } = render(
    createElement(
      DragSessionContext,
      { value: createDragSession() },
      createElement(TerminalCompanion, props),
    ),
  )
  unmounts.push(unmount)
  unmounts.push(panes.connect())
  return { container, panes }
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
    "p/s/01": {
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
      const { companions, emit } = companionsOf([])
      const { container } = renderTerminal(companions)
      expect(taskbar(container)).toBeNull()
      await emit({ type: "artifact/shown", key, artifact: hero, asked: false })
      expect(taskbar(container)?.getAttribute("data-state")).toBe("open")
    })
  })

  context("when the terminal already had something to show as it mounted", () => {
    it("appears as it was, without animating", () => {
      const { companions } = companionsOf([hero])
      const { container } = renderTerminal(companions)
      expect(taskbar(container)).not.toBeNull()
      expect(taskbar(container)?.hasAttribute("data-state")).toBe(false)
    })
  })

  context("when the person closed the messages", () => {
    it("brings them back with the next message", async () => {
      const { companions } = companionsOf([hero])
      const state = createStore(mailOf([message("m1")]))
      const { container, panes } = renderTerminal(companions, {
        state,
        pause: () => {},
        release: () => {},
      })
      const icon = () => container.querySelector(".plan-tb-item[aria-label^='Messages']")
      expect(icon()).not.toBeNull()
      // As its menu's Close does.
      await act(async () => panes.of(key).update((pane) => close(pane, mailTab)))
      expect(icon()).toBeNull()
      await act(async () => state.update(() => mailOf([message("m1"), message("m2")])))
      expect(icon()).not.toBeNull()
    })
  })
})
