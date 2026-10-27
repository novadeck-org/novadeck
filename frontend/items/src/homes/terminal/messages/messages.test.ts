import { messagesKey } from "@novadeck/core/companion-bar"
import { companionKeyId } from "@novadeck/core/items"
import { noMessages, type MessageParty, type MessagesState } from "@novadeck/core/messages"
import { activeSession } from "@novadeck/core/state"
import { createStore, createWorkspaceStore } from "@novadeck/core/store"
import { workspaceFixture } from "@novadeck/core/testing"
import { afterEach } from "vitest"

import { describe, expect, it } from "../../../test"
import { followMessages } from "./messages"

const agent = (handle: string): MessageParty => ({ kind: "agent", handle, agent: null })

const target = { projectId: "project", workspaceSessionId: "initial" }

const stops: (() => void)[] = []
afterEach(() => stops.splice(0).forEach((stop) => stop()))

describe("a terminal's messages on its taskbar", () => {
  const messagesOf = (count: number): MessagesState => ({
    ...noMessages,
    terminals: {
      [companionKeyId({ ...target, terminalId: "01" })]: {
        handle: "moth",
        agent: true,
        threads: [
          {
            id: "th",
            peer: agent("fox"),
            hops: count,
            idle: 0,
            held: false,
            heldFor: null,
            messages: Array.from({ length: count }, (_, index) => ({
              id: `m${index}`,
              hop: index + 1,
              from: agent("fox"),
              to: agent("moth"),
              text: "Ready",
              sentAt: 0,
              state: "delivered" as const,
              held: null,
              deliveredAt: 0,
            })),
          },
        ],
      },
    },
  })
  // Messages are heard once the turn that changed them is over.
  const heard = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve))
  const following = (initial: MessagesState) => {
    const state = createStore(initial)
    const workspace = createWorkspaceStore(workspaceFixture())
    stops.push(
      followMessages(workspace, { state, pause: () => {}, release: () => {}, stop: () => {} }),
    )
    const bar = () => activeSession(workspace.getSnapshot())!.state.bars["01"]
    const hide = () =>
      workspace.dispatch({ type: "bar/hide", target, terminalId: "01", key: messagesKey })
    return { state, bar, hide }
  }

  it("join the bar's order once the terminal has them", () => {
    expect(following(messagesOf(0)).bar()?.order).toEqual([messagesKey])
  })

  it("join the bar's order with the first message, after an agent with none", async () => {
    const { state, bar } = following({
      ...noMessages,
      terminals: {
        [companionKeyId({ ...target, terminalId: "01" })]: {
          handle: "moth",
          agent: false,
          threads: [],
        },
      },
    })
    expect(bar()).toBeUndefined()
    state.update(() => messagesOf(1))
    await heard()
    expect(bar()?.order).toEqual([messagesKey])
  })

  it("stay off the bar while hidden, whatever else changes", async () => {
    const { state, bar, hide } = following(messagesOf(1))
    hide()
    state.update((current) => ({ ...current, paused: true }))
    await heard()
    expect(bar()).toMatchObject({ hidden: [messagesKey], order: [] })
  })

  it("come back with the next message once hidden, whether the terminal is on screen or not", async () => {
    const { state, bar, hide } = following(messagesOf(1))
    hide()
    state.update(() => messagesOf(1))
    await heard()
    expect(bar()?.hidden).toEqual([messagesKey])
    state.update(() => messagesOf(2))
    await heard()
    expect(bar()).toMatchObject({ hidden: [], order: [messagesKey] })
  })

  it("change inside a workspace commit without failing it, never reaching a terminal it closed", async () => {
    const state = createStore(messagesOf(1))
    // A backend that lets a closed terminal's messages go as it commits the close, as the
    // runner adapter does.
    const workspace = createWorkspaceStore(workspaceFixture(), (_, actions) => {
      if (actions.some((action) => action.type === "terminal/close")) state.update(() => noMessages)
      else if (actions.some((action) => action.type === "terminal/rename"))
        state.update(() => messagesOf(2))
    })
    stops.push(
      followMessages(workspace, { state, pause: () => {}, release: () => {}, stop: () => {} }),
    )
    const bar = () => activeSession(workspace.getSnapshot())!.state.bars["01"]
    workspace.dispatch({ type: "bar/hide", target, terminalId: "01", key: messagesKey })

    expect(() =>
      workspace.dispatch({ type: "terminal/rename", target, terminalId: "01", name: "Moth" }),
    ).not.toThrow()
    await heard()
    expect(bar()).toMatchObject({ hidden: [], order: [messagesKey] })

    state.update(() => messagesOf(3))
    expect(() =>
      workspace.dispatch({ type: "terminal/close", target, terminalId: "01" }),
    ).not.toThrow()
    await heard()
    expect(bar()).toBeUndefined()
  })
})
