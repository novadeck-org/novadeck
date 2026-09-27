import { context, describe, expect, it } from "../test"
import { terminalFixture } from "../test/fixtures"
import { beginRename, changeDraft, endRename, renameAction, renameView } from "./rename-state"

const target = { projectId: "project", workspaceSessionId: "initial" }
const scope = { context: "project/initial", view: "grid", target, request: 1 } as const
const rename = beginRename(terminalFixture(1, "~/project"), "sidebar", scope)

describe("terminal rename", () => {
  context("when a rename starts", () => {
    it("drafts from the current name", () => {
      expect(rename).toMatchObject({ id: "01", original: "Terminal 01", draft: "Terminal 01" })
      expect(renameView(rename)).toEqual({
        id: "01",
        value: "Terminal 01",
        request: 1,
        origin: "sidebar",
      })
    })
  })

  context("when the draft changes", () => {
    it("changes only the matching rename in its own session", () => {
      expect(changeDraft(rename, scope.context, "01", "Server")?.draft).toBe("Server")
      expect(changeDraft(rename, "other/session", "01", "Server")).toBe(rename)
      expect(changeDraft(rename, scope.context, "02", "Server")).toBe(rename)
    })
  })

  context("when it ends", () => {
    it("saves a trimmed new name and nothing for an unchanged or empty one", () => {
      const drafted = { ...rename, draft: "  Server  " }
      expect(renameAction(drafted, true)).toEqual({
        type: "terminal/rename",
        target,
        terminalId: "01",
        name: "Server",
      })
      expect(renameAction(drafted, false)).toBeNull()
      expect(renameAction({ ...rename, draft: "   " }, true)).toBeNull()
      expect(renameAction(rename, true)).toBeNull()
    })

    it("clears only the rename it belongs to", () => {
      const newer = { ...rename, request: 2 }
      expect(endRename(rename, rename)).toBeNull()
      expect(endRename(newer, rename)).toBe(newer)
    })
  })
})
