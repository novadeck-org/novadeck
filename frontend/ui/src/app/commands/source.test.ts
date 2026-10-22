import { emptyCompanions, type Companions } from "@novadeck/core/items"
import { activeSession, createTerminalState, createWorkspaceSession } from "@novadeck/core/state"
import { itemFixture } from "@novadeck/core/testing"
import type { CompanionWindowMeta } from "@novadeck/core/types"

import { context, describe, expect, it } from "../../test"
import { openCommands } from "../../test/commands"
import { absolutePath } from "./source"

const readme = itemFixture("readme", "01", {
  kind: "file",
  name: "README.md",
  path: "/p/README.md",
})
const windowOf = (id: string, name: string): CompanionWindowMeta => ({
  id,
  home: "project",
  itemId: readme.id,
  name,
  titleSource: { kind: "default" },
})

// A backend whose project window holds one file, and what it was asked to open.
const open = (openInProject?: Companions["openInProject"], url?: string) => {
  const asked: { path: string; windowId: string }[] = []
  const companions: Companions = {
    ...emptyCompanions(),
    ...(openInProject && {
      openInProject: (target, path, windowId) => (
        asked.push({ path, windowId }),
        openInProject(target, path, windowId)
      ),
    }),
  }
  const app = openCommands({ companions, ...(url ? { url } : {}) })
  return { ...app, asked }
}

const reply = () => Promise.resolve({ item: readme, window: windowOf("session-1", "README.md") })

describe("source commands", () => {
  context("when opening a file", () => {
    it("opens it in a new project window by its absolute path, selected", async () => {
      const app = open(reply)
      await app.commands.openSourceFile("README.md")
      expect(app.asked).toEqual([{ path: "~/project/README.md", windowId: "session-1" }])
      expect(app.state().selected).toBe("session-1")
      expect(app.state().roster.windows.map((each) => each.name)).toEqual(["README.md"])
    })

    it("needs no terminal open", async () => {
      const app = open(reply)
      for (const { id } of app.state().roster.terminals) app.commands.close(id)
      await app.commands.openSourceFile("README.md")
      expect(app.state().roster.windows.map((each) => each.id)).toEqual(["session-1"])
    })

    it("keeps the person in the panel it was opened from", async () => {
      const app = open(reply)
      app.navigation.go({ panel: "source" })
      await app.commands.openSourceFile("README.md")
      expect(app.ui.getSnapshot().location.route.panel).toBe("source")
    })

    it("re-points the window it already has, which stays one", async () => {
      let name = "README.md"
      const app = open(() =>
        Promise.resolve({ item: { ...readme, name }, window: windowOf("session-1", name) }),
      )
      await app.commands.openSourceFile("README.md")
      name = "notes.md"
      await app.commands.openSourceFile("notes.md")
      expect(app.state().roster.windows.map((each) => each.name)).toEqual(["notes.md"])
      expect(app.state().selected).toBe("session-1")
    })

    it("puts the window in the session it was opened for, not the one the person moved to", async () => {
      let answer!: () => void
      const app = open(
        () =>
          new Promise(
            (resolve) =>
              (answer = () =>
                resolve({ item: readme, window: windowOf("session-1", "README.md") })),
          ),
      )
      const opening = app.commands.openSourceFile("README.md")
      app.workspace.dispatch({
        type: "session/add",
        projectId: "project",
        session: createWorkspaceSession(
          { name: "Other", state: createTerminalState([], "grid", "grid") },
          { id: "other", now: 2 },
        ),
      })
      expect(activeSession(app.workspace.getSnapshot())!.id).toBe("other")
      answer()
      await opening
      expect(app.state().roster.windows).toEqual([])
      expect(app.state().items).toEqual([])
      const project = app.workspace.getSnapshot().projects.find((each) => each.id === "project")!
      const first = project.history.find((session) => session.id === "initial")!
      expect(first.state.roster.windows.map((each) => each.id)).toEqual(["session-1"])
      expect(first.state.items).toEqual([readme])
    })

    it("does nothing where the backend can't open files", async () => {
      const app = open()
      await expect(app.commands.openSourceFile("package.json")).resolves.toBeUndefined()
      expect(app.state().roster.windows).toEqual([])
    })

    it("rejects when the backend can't open it, leaving the workspace as it was", async () => {
      const app = open(() => Promise.reject(new Error("gone")))
      await expect(app.commands.openSourceFile("package.json")).rejects.toThrow("gone")
      expect(app.state().roster.windows).toEqual([])
    })
  })

  context("when writing a path from a project's directory", () => {
    it("joins with the separator the directory uses", () => {
      expect(absolutePath("/home/me/shop", "src/a.ts")).toBe("/home/me/shop/src/a.ts")
      expect(absolutePath("/home/me/shop/", "a.ts")).toBe("/home/me/shop/a.ts")
      expect(absolutePath("C:\\Users\\me\\shop", "src/a.ts")).toBe("C:\\Users\\me\\shop\\src\\a.ts")
    })
  })
})
