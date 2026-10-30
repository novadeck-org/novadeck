import type { InboxContent, InboxRow } from "@novadeck/core/inbox"
import { describe, expect, it } from "vitest"

import { inboxBadge } from "./inbox-badge"

const row = (content: InboxContent, index = 0, stopped = true): InboxRow => ({
  ...content,
  id: `row-${index}`,
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

const done: InboxContent = {
  kind: "update",
  update: { type: "done", subject: "Done", body: "Done" },
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
    expect(inboxBadge([row(done)])).toBeUndefined()
  })

  it("counts what waits, and no update, and says so in the bell's name", () => {
    expect(inboxBadge([row(done), row(held, 1), row(held, 2)])).toEqual({
      count: 2,
      label: "Inbox, 2 waiting",
    })
  })

  it("counts past nine", () => {
    const rows = Array.from({ length: 12 }, (_, index) => row(held, index))
    expect(inboxBadge(rows)).toMatchObject({ count: 12, label: "Inbox, 12 waiting" })
  })
})
