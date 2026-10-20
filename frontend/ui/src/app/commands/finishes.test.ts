import type { Unread } from "../../terminals/unread-state"
import { context, describe, expect, it } from "../../test"
import { openCommands } from "../../test/commands"

// Two session contexts with finishes the person hasn't read.
const unread: Unread = {
  "project/initial": { "01": "done", "02": "failed" },
  "project/other": { "09": "done" },
}

const unreadApp = () => {
  const app = openCommands()
  app.ui.update((state) => ({ ...state, unread }))
  return app
}

describe("Finish commands", () => {
  context("when the Inbox reads finishes", () => {
    it("clears those, in every session, and no other", () => {
      const app = unreadApp()
      app.commands.readFinishes([
        { context: "project/initial", terminalId: "01" },
        { context: "project/other", terminalId: "09" },
      ])
      expect(app.ui.getSnapshot().unread).toEqual({ "project/initial": { "02": "failed" } })
    })

    it("leaves the state as it was when none of them is unread", () => {
      const app = unreadApp()
      app.commands.readFinishes([{ context: "project/initial", terminalId: "07" }])
      expect(app.ui.getSnapshot().unread).toBe(unread)
    })
  })
})
