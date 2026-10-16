import { vi } from "vitest"

import { describe, expect, it } from "../../../test"
import { createDemoInbox, demoHiddenCommand, demoInboxIds } from "../inbox"
import { inboxGroups } from "./inbox"
import type { DemoActionContext } from "./types"

const run = (inbox: ReturnType<typeof createDemoInbox>, label: string, notes: string[] = []) => {
  const [group] = inboxGroups(inbox)
  const context: DemoActionContext = {
    target: "selected",
    selected: () => undefined,
    addTerminal: () => {
      throw new Error("unused")
    },
    addInBackground: () => {
      throw new Error("unused")
    },
    startFresh: () => undefined,
    dispatch: undefined,
    workspace: () => undefined,
    note: (text) => notes.push(text),
  }
  void group!.actions.find((action) => action.label === label)!.run(context)
}

describe("the debug panel's Inbox group", () => {
  it("is absent where the demo has no Inbox", () => {
    expect(inboxGroups(undefined)).toEqual([])
  })

  it("hints what each action shows", () => {
    const [group] = inboxGroups(createDemoInbox(1, []))
    expect(group!.actions.every((action) => action.hint.length > 0)).toBe(true)
  })

  it("adds one item of a kind, waiting from now", () => {
    const inbox = createDemoInbox(1, [])
    run(inbox, "Stuck agent")
    const [added] = inbox.state.getSnapshot().items
    expect(added?.kind).toBe("trouble")
    expect(added?.at).toBeGreaterThan(1_000_000_000_000)
  })

  it("adds the next kind that is missing, until every kind is there", () => {
    const inbox = createDemoInbox(1, [])
    const notes: string[] = []
    // Lifecycle controls and variants change or add items rather than adding a kind.
    const kinds = inboxGroups(inbox)[0]!.actions.length - 9
    for (let each = 0; each < kinds; each += 1) run(inbox, "A new item arrives", notes)
    expect(inbox.state.getSnapshot().items).toHaveLength(kinds)
    run(inbox, "A new item arrives", notes)
    expect(notes).toEqual(["Every kind is in the Inbox already."])
  })

  it("adds a permission whose command hides a line, for the card to mark", () => {
    const inbox = createDemoInbox(1, [])
    run(inbox, "Command hiding lines")
    const [item] = inbox.state.getSnapshot().items
    expect(item?.kind === "request" && item.request.dialog?.type === "choices").toBe(true)
    if (item?.kind !== "request" || item.request.dialog?.type !== "choices") return
    expect(item.request.dialog.detail).toBe(demoHiddenCommand)
  })

  it("makes the next answer fail", () => {
    const inbox = createDemoInbox(1)
    run(inbox, "Fail the next answer")
    inbox.answer(inbox.state.getSnapshot().items[0]!.id, { kind: "update", action: "read" })

    expect(Object.keys(inbox.state.getSnapshot().failed)).toHaveLength(1)
  })

  it("makes the next answer report that its ask is no longer available", () => {
    const inbox = createDemoInbox(1)
    run(inbox, "Stale next answer")
    inbox.answer(demoInboxIds.preview, {
      kind: "ask",
      answer: { type: "reply", option: null, text: "Sample products." },
    })

    expect(inbox.state.getSnapshot().failed[demoInboxIds.preview]).toBe(
      "That ask is no longer available.",
    )
    expect(inbox.state.getSnapshot().items.some((item) => item.id === demoInboxIds.preview)).toBe(
      true,
    )
    expect(inbox.state.getSnapshot().answering).toEqual({})
  })

  it("makes withdrawn and ended asks reachable as retained history", () => {
    const outcomes: string[] = []
    const inbox = createDemoInbox(1, [], (_, __, outcome) => {
      if (outcome) outcomes.push(outcome)
    })
    run(inbox, "Ask withdrawn")
    run(inbox, "Ask session ended")
    expect(outcomes).toEqual(["withdrawn", "gone"])
    expect(inbox.state.getSnapshot().items).toEqual([])
  })

  it("makes a queued reply's delivery failure reachable", () => {
    vi.useFakeTimers()
    try {
      const inbox = createDemoInbox(1)
      run(inbox, "Next reply not delivered")
      inbox.answer(demoInboxIds.preview, {
        kind: "ask",
        answer: { type: "reply", option: null, text: "Samples." },
      })
      vi.runAllTimers()
      expect(inbox.state.getSnapshot().failed[demoInboxIds.preview]).toContain(
        "Your reply was not delivered",
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("clears the Inbox", () => {
    const inbox = createDemoInbox(1)
    run(inbox, "Clear the Inbox")
    expect(inbox.state.getSnapshot().items).toEqual([])
  })
})
