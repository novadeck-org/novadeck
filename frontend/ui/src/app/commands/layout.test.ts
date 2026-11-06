import { orderedTiles } from "@novadeck/core/roster"

import { context, describe, expect, it } from "../../test"
import { openCommands } from "../../test/commands"

const target = { projectId: "project", workspaceSessionId: "initial" }

describe("layout commands", () => {
  context("when the person reorders the Terminals list", () => {
    it("saves the order and says so, for Canvas to arrange its windows afresh", () => {
      const app = openCommands()
      app.commands.reorder(target, ["02", "01"])
      expect(orderedTiles(app.state().roster).map((tile) => tile.id)).toEqual(["02", "01"])
      expect(app.shell().reordered).toBe(1)
    })

    it("says nothing for a drag that ends on the order it began with", () => {
      const app = openCommands()
      app.commands.reorder(target, ["02", "01"])
      app.commands.reorder(target, ["02", "01"])
      expect(app.shell().reordered).toBe(1)
    })
  })
})
