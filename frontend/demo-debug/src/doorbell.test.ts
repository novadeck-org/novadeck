import { companionKeyId } from "@novadeck/core/items"
import type { MessagesState } from "@novadeck/core/messages"
import { checkoutMessages, createDemoMessages } from "@novadeck/demo/messages"

import { doorbellGroups } from "./doorbell"
import { describe, expect, it } from "./test"
import type { DemoActionContext } from "./types"

const target = { projectId: "p", workspaceSessionId: "s" }
const key = { ...target, terminalId: "01" }

describe("the debug panel's Doorbell group", () => {
  it("is absent where the messages are the runner's", () => {
    expect(doorbellGroups(undefined)).toEqual([])
  })

  it("puts the selected agent where the doorbell cannot ring, and back", () => {
    const boxes = checkoutMessages(Date.now(), [target]).map((box) => ({
      ...box,
      terminals: box.terminals.map((each, index) =>
        index === 0 ? { ...each, terminalId: "01" } : each,
      ),
    }))
    const messages = createDemoMessages(boxes)
    const [group] = doorbellGroups(messages)
    const waits = () => {
      const state: MessagesState = messages.state.getSnapshot()
      return state.terminals[companionKeyId(key)]?.waits
    }
    const run = (label: string, selected = key) => {
      const notes: string[] = []
      void group!.actions
        .find((action) => action.label === label)!
        .run({
          selected: () => selected,
          note: (text: string) => notes.push(text),
        } as unknown as DemoActionContext)
      return notes
    }
    run("Text in its box")
    expect(waits()).toBe("draft")
    run("Dialog open")
    expect(waits()).toBe("dialog")
    run("Doorbell can ring")
    expect(waits()).toBeNull()
    expect(run("Asking the user", { ...key, terminalId: "nope" })).toHaveLength(1)
  })
})
