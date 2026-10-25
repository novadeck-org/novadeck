import type { InboxContent, InboxItem } from "@novadeck/core/inbox"
import { describe, expect, it } from "vitest"

import { inboxBadge } from "./inbox-badge"

const entry = (content: InboxContent, index = 0, stopped = true): InboxItem => ({
  ...content,
  id: `item-${index}`,
  source: {
    projectId: "project",
    workspaceSessionId: "session",
    terminalId: `t${index}`,
    handle: "moth",
    agent: "claude",
    title: "Agent",
    projectName: "Project",
  },
  at: index,
  stopped,
  seen: false,
})

const finished: InboxContent = {
  kind: "update",
  update: { type: "finished", subject: "Done", reply: "Done", files: [] },
}
const failed: InboxContent = { kind: "trouble", trouble: { type: "failed", error: null } }
const asked: InboxContent = {
  kind: "ask",
  ask: { subject: "Which?", body: "", details: null, hardToUndo: null, shape: { type: "text" } },
}
const held: InboxContent = {
  kind: "held",
  held: {
    threadId: "th",
    from: { handle: "moth", title: "A" },
    to: { handle: "fox", title: "B" },
    text: "Hi",
    hop: 3,
    heldFor: "loop",
  },
}

describe("inboxBadge", () => {
  it("shows nothing while nothing but updates is there", () => {
    expect(inboxBadge([])).toBeUndefined()
    expect(inboxBadge([entry(finished)])).toBeUndefined()
  })

  it("counts what waits, and no update, and says so in the bell's name", () => {
    expect(inboxBadge([entry(finished), entry(held, 1), entry(held, 2)])).toEqual({
      text: "2",
      label: "Inbox, 2 waiting",
      status: "attention",
    })
  })

  it("takes the tone of the most pressing item", () => {
    expect(inboxBadge([entry(held), entry(failed, 1)])?.status).toBe("failed")
    expect(inboxBadge([entry(asked), entry(held, 1, false)])?.status).toBe("question")
  })

  it("counts a feedback draft, as needing attention", () => {
    const draft: InboxContent = { kind: "feedback", draft: { kind: "bug", text: "It broke." } }
    expect(inboxBadge([entry(draft, 0, false)])).toEqual({
      text: "1",
      label: "Inbox, 1 waiting",
      status: "attention",
    })
  })

  it("caps the printed count at 9+ but keeps the full count in the name", () => {
    const list = Array.from({ length: 12 }, (_, index) => entry(held, index))
    expect(inboxBadge(list)).toMatchObject({ text: "9+", label: "Inbox, 12 waiting" })
  })
})
