import { emptyCompanions, type CompanionKey } from "@novadeck/core/companion"
import { workspaceReducer, type WorkspaceAction } from "@novadeck/core/state"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"

import { context, describe, expect, it } from "../../test"
import { openCommands } from "../../test/commands"
import { absolutePath } from "./source"

const target = { projectId: "project", workspaceSessionId: "initial" }
const hero = itemFixture("hero", "02", { kind: "image", name: "hero.png", path: "/p/hero.png" })

const open = (attach?: (key: CompanionKey, path: string) => Promise<void>, url?: string) => {
  const attached: { key: CompanionKey; path: string }[] = []
  const companions = {
    ...emptyCompanions(),
    ...(attach && {
      attach: (key: CompanionKey, path: string) => (
        attached.push({ key, path }),
        attach(key, path)
      ),
    }),
  }
  const workspace = workspaceReducer(workspaceFixture(), {
    type: "item/upsert",
    target,
    item: hero,
  } satisfies WorkspaceAction)
  const app = openCommands({ workspace, companions, ...(url ? { url } : {}) })
  return { ...app, attached }
}

describe("source commands", () => {
  context("when opening a file", () => {
    it("attaches it to the focused terminal by its absolute path", async () => {
      const app = open(
        () => Promise.resolve(),
        "/projects/project/sessions/initial/grid?terminal=01",
      )
      await app.commands.openSourceFile("src/cart/useCart.ts")
      expect(app.attached).toEqual([
        { key: { ...target, terminalId: "01" }, path: "~/project/src/cart/useCart.ts" },
      ])
    })

    it("attaches it to the terminal an undocked window came from, while the window is focused", async () => {
      const app = open(() => Promise.resolve())
      app.commands.undock(hero.id)
      expect(app.state().selected).toBe("session-1")
      await app.commands.openSourceFile("package.json")
      expect(app.attached.map(({ key }) => key.terminalId)).toEqual(["02"])
    })

    it("does nothing where the backend can't attach", async () => {
      const app = open()
      await expect(app.commands.openSourceFile("package.json")).resolves.toBeUndefined()
      expect(app.attached).toEqual([])
    })

    it("rejects when the backend can't attach it", async () => {
      const app = open(() => Promise.reject(new Error("gone")))
      await expect(app.commands.openSourceFile("package.json")).rejects.toThrow("gone")
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
