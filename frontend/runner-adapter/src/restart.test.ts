import { createStore } from "@novadeck/core/store"
import type { InboxEntry } from "@novadeck/protocol"
import { vi } from "vitest"

import { context, describe, expect, it } from "./test"
import { id, scripted } from "./testing/scripted"

// What an agent told the person, as the runner lists it in the Inbox.
const told = (entryId: string): InboxEntry => ({
  id: entryId,
  terminalId: id(1),
  projectId: "p",
  workspaceSessionId: id(8),
  agent: "claude",
  sessionId: "harness-session",
  handle: "moth",
  at: 4000,
  content: { kind: "tell", subject: "Preview ready", body: "Open the preview." },
})

describe("a backend stopped and started again", () => {
  context("as React's StrictMode runs the app's effects twice in development", () => {
    it("still shows the Inbox's rows", async () => {
      const app = scripted({ shown: [{ id: id(1), lastProcess: "" }] })
      const inbox = app.backend.inbox!
      const workspace = createStore(app.workspace())
      const rows = () => inbox.state.getSnapshot().items.map((item) => item.id)
      // The app's effects: the backend starts (in `scripted`), then the Inbox is bound; both
      // stop, in that order, and run again.
      const unbind = inbox.bind!({ workspace })
      app.stop()
      unbind()
      const again = app.backend.start!({ dispatch: () => {}, open: () => {} })
      const rebound = inbox.bind!({ workspace })

      app.inbox.push([told("told-1")])
      await vi.waitFor(() => expect(rows()).toEqual(["told-1"]))
      rebound()
      again()
    })
  })
})
