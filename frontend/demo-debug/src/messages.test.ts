import { companionKeyId } from "@novadeck/core/items"
import { checkoutMessages, createDemoMessages } from "@novadeck/demo/messages"

import { messageGroups } from "./messages"
import { describe, expect, it } from "./test"
import type { DemoActionContext } from "./types"

const target = { projectId: "p", workspaceSessionId: "s" }
const key = { ...target, terminalId: "01" }

describe("the debug panel's Messages group", () => {
  it("is absent where the messages are the runner's", () => {
    expect(messageGroups(undefined)).toEqual([])
  })

  it("has the selected terminal's latest peer write to it", () => {
    const sessions = checkoutMessages(Date.now(), [target]).map((box) => ({
      ...box,
      terminals: box.terminals.map((each, index) =>
        index === 0 ? { ...each, terminalId: "01" } : each,
      ),
    }))
    const messages = createDemoMessages(sessions)
    const [group] = messageGroups(messages)
    const run = (selected = key, action = 0) => {
      const notes: string[] = []
      void group!.actions[action]!.run({
        selected: () => selected,
        note: (text: string) => notes.push(text),
      } as unknown as DemoActionContext)
      return notes
    }
    expect(run()).toEqual([])
    const latest = messages.state
      .getSnapshot()
      .terminals[companionKeyId(key)]!.threads.flatMap((thread) => thread.messages)
      .toSorted((a, b) => b.sentAt - a.sentAt)[0]!
    expect(latest).toMatchObject({
      to: { kind: "agent", handle: "moth" },
      text: expect.stringContaining("Anything else"),
    })
    expect(run({ ...key, terminalId: "nope" })).toHaveLength(1)
  })

  it("has a handle given again write to the selected terminal", () => {
    const sessions = checkoutMessages(Date.now(), [target]).map((box) => ({
      ...box,
      terminals: box.terminals.map((each, index) =>
        index === 0 ? { ...each, terminalId: "01" } : each,
      ),
    }))
    const messages = createDemoMessages(sessions)
    const [group] = messageGroups(messages)
    void group!.actions[1]!.run({
      selected: () => key,
      note: () => {},
    } as unknown as DemoActionContext)
    const peers = messages.state
      .getSnapshot()
      .terminals[companionKeyId(key)]!.threads.map((thread) => thread.peer)
    expect(peers).toContainEqual({ kind: "agent", handle: "foxz", agent: null })
  })
})
