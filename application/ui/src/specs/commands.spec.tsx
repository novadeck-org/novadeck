import { describe as context, describe, expect, it } from "vitest"

import { terminalCount } from "./support/keyboard"
import {
  anyRenameField,
  newTerminalButton,
  sidebarRenameField,
  tabAction,
} from "./support/terminals"
import {
  commandInput,
  expectSelected,
  expectStaysAbsent,
  openWorkspace,
  terminalTab,
} from "./support/workspace"

describe("workspace commands", () => {
  context("when creating a terminal while another name is being edited", () => {
    it("saves the existing name and creates the new terminal in the same interaction", async () => {
      await openWorkspace()
      await tabAction("Rename Dev server").click()
      await sidebarRenameField("Dev server").fill("API server")

      await newTerminalButton().click()

      await expect.element(terminalTab("API server")).toBeVisible()
      await expect.element(commandInput("Terminal 07")).toHaveFocus()
      await expectStaysAbsent(anyRenameField())
      await expectSelected("Terminal 07")
      await expect.element(terminalCount(7)).toBeVisible()
    })
  })
})
