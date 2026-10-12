import { describe as context, describe, expect, it, vi } from "vitest"
import { page, type Locator } from "vitest/browser"

import { findDialog, pressShortcut } from "./support/keyboard"
import {
  commandInput,
  expectStaysAbsent,
  focusStage,
  openWorkspace,
  press,
  terminalTab,
} from "./support/workspace"

const chip = (): Locator => page.getByRole("button", { name: /^No sandbox:/ })
const notice = (): Locator =>
  page.getByRole("region", { name: "Novadeck is running without its security sandbox" })

describe("the sandbox notice", () => {
  it("is absent where the host does not say", async () => {
    await openWorkspace()
    await expectStaysAbsent(chip())
    expect(chip().query()).toBeNull()
  })

  context("on a host running without its sandbox", () => {
    it("waits in the footer as a chip, and opens with the command to copy", async () => {
      await openWorkspace("/?sandbox=off")
      await expect.element(chip()).toBeVisible()
      await expect.element(notice()).not.toBeInTheDocument()
      await chip().click()
      await expect.element(notice()).toBeVisible()
      await expect.element(notice().getByText(/^curl .*--sandbox$/)).toBeVisible()
      await expect.element(notice().getByRole("button", { name: "Copy" })).toBeVisible()
    })

    it("keeps Escape working after Copy is pressed with the mouse", async () => {
      await openWorkspace("/?sandbox=off")
      await chip().click()
      await notice().getByRole("button", { name: "Copy" }).click()
      await press("{Escape}")
      await expect.element(notice()).not.toBeInTheDocument()
    })

    it("closes the update notice when opened, and is closed by the update chip", async () => {
      await openWorkspace("/?demo=update&sandbox=off")
      const update = page.getByRole("region", { name: "Novadeck 0.0.80 is ready" })
      await expect.element(update).toBeVisible()
      await chip().click()
      await expect.element(notice()).toBeVisible()
      await expect.element(update).not.toBeInTheDocument()
      await page.getByRole("button", { name: /^Update ready:/ }).click()
      await expect.element(update).toBeVisible()
      await expect.element(notice()).not.toBeInTheDocument()
    })

    it("returns focus to the chip after a dialog opened from inside it closes", async () => {
      await openWorkspace("/?sandbox=off")
      await chip().click()
      await expect.element(notice()).toHaveFocus()
      await pressShortcut("find")
      await expect.element(findDialog()).toBeVisible()
      await expectStaysAbsent(notice())
      await press("{Escape}")
      await expect.element(findDialog()).not.toBeInTheDocument()
      await expect.element(chip()).toHaveFocus()
    })

    it("hands focus to the terminal when its text is clicked while the view has focus", async () => {
      await openWorkspace("/?sandbox=off")
      await terminalTab("Dev server").click()
      await chip().click()
      await expect.element(notice()).toBeVisible()
      // The panel takes focus a frame after it shows. Moving focus to the view before that
      // lets the panel take it back, and the click on its text then has nothing to hand over.
      await expect.element(notice()).toHaveFocus()
      await focusStage()
      await notice()
        .getByText(/^This system blocks/)
        .click()
      await expect.element(commandInput("Dev server")).toHaveFocus()
    })

    it("closes on Escape", async () => {
      await openWorkspace("/?sandbox=off")
      await chip().click()
      await expect.element(notice()).toBeVisible()
      // The panel takes focus a frame after it shows.
      await expect.element(notice()).toHaveFocus()
      await press("{Escape}")
      await expect.element(notice()).not.toBeInTheDocument()
    })

    it("explains without a command or a copy button when it has no fix", async () => {
      await openWorkspace("/?sandbox=off-unfixed")
      await chip().click()
      await expect.element(notice()).toBeVisible()
      await expectStaysAbsent(notice().getByRole("button", { name: "Copy" }))
      await expect.element(notice().getByText(/--no-sandbox/)).toBeVisible()
      await expect.element(notice().getByText(/user namespaces/)).toBeVisible()
      expect(notice().element().textContent).not.toMatch(/was started without/)
    })

    it("lets the command be selected with the mouse", async () => {
      await openWorkspace("/?sandbox=off")
      await chip().click()
      const command = notice().getByLabelText("Command to turn on the sandbox")
      await expect.element(command).toBeVisible()
      const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      command.element().dispatchEvent(down)
      expect(down.defaultPrevented).toBe(false)
      const text = notice().getByText(/^This system blocks/)
      const other = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      text.element().dispatchEvent(other)
      expect(other.defaultPrevented).toBe(true)
      await command.click()
      expect(window.getSelection()?.toString()).toMatch(/^curl .*--sandbox$/)
    })

    it("says so when the command cannot be copied, and keeps Escape working", async () => {
      await openWorkspace("/?sandbox=off")
      await chip().click()
      vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"))
      await notice().getByRole("button", { name: "Copy" }).click()
      await expect.element(notice().getByRole("button", { name: "Copy failed" })).toBeVisible()
      await expect.element(notice().getByText("Select the command and copy it.")).toBeVisible()
      expect(notice().element().querySelector("[aria-live=polite]")?.textContent).toBe(
        "Copy failed. Select the command to copy it.",
      )
      await press("{Escape}")
      await expect.element(notice()).not.toBeInTheDocument()
      await expect.element(chip()).toHaveFocus()
    })

    it("announces a successful copy politely", async () => {
      await openWorkspace("/?sandbox=off")
      await chip().click()
      vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined)
      await notice().getByRole("button", { name: "Copy" }).click()
      await expect.element(notice().getByRole("button", { name: "Copied" })).toBeVisible()
      expect(notice().element().querySelector("[aria-live=polite]")?.textContent).toBe("Copied")
    })
  })
})
