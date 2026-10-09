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

describe("Notification commands", () => {
  context("when the person dismisses a finish", () => {
    it("reads that terminal only", () => {
      const app = unreadApp()
      app.commands.dismissNotification({ context: "project/initial", terminalId: "02" })
      expect(app.ui.getSnapshot().unread).toEqual({
        "project/initial": { "01": "done" },
        "project/other": { "09": "done" },
      })
    })

    it("leaves the state as it was for one already read", () => {
      const app = unreadApp()
      app.commands.dismissNotification({ context: "project/initial", terminalId: "07" })
      expect(app.ui.getSnapshot().unread).toBe(unread)
    })
  })

  context("when the person marks all read", () => {
    it("clears the finishes shown, in every session, and no mark hidden from the panel", () => {
      const app = unreadApp()
      app.commands.dismissAllNotifications([
        { context: "project/initial", terminalId: "01" },
        { context: "project/other", terminalId: "09" },
      ])
      expect(app.ui.getSnapshot().unread).toEqual({ "project/initial": { "02": "failed" } })
    })

    it("leaves the state as it was when none shown is marked", () => {
      const app = unreadApp()
      app.commands.dismissAllNotifications([{ context: "project/initial", terminalId: "07" }])
      expect(app.ui.getSnapshot().unread).toBe(unread)
    })
  })
})
