import { describe, expect, it } from "vitest"
import { page } from "vitest/browser"

import { expectStaysAbsent, openWorkspace } from "./support/workspace"

const restart = () => page.getByRole("button", { name: /^Restart to update/ })

describe("the footer's update", () => {
  it("is absent where the host does not update", async () => {
    await openWorkspace()
    await expectStaysAbsent(restart())
    expect(restart().query()).toBeNull()
  })

  it("offers a restart that names the version once the host has an update", async () => {
    await openWorkspace("/?demo=update")
    await expect
      .element(page.getByRole("status").filter({ hasText: "Update ready" }))
      .toBeInTheDocument()
    await expect
      .element(page.getByRole("button", { name: "Restart to update to 0.0.80" }))
      .toBeVisible()
  })

  it("keeps the announcement at narrow widths, where the button alone says Update", async () => {
    await page.viewport(600, 800)
    await openWorkspace("/?demo=update")
    await expect
      .element(page.getByRole("status").filter({ hasText: "Update ready" }))
      .toBeInTheDocument()
    await expect.element(restart().getByText("Update", { exact: true })).toBeVisible()
    await expect.element(restart().getByText("Restart", { exact: true })).not.toBeVisible()
  })

  it("shows Restarting once Restart is pressed, and does nothing more", async () => {
    await openWorkspace("/?demo=update")
    await restart().click()
    const restarting = page.getByRole("button", { name: "Restarting to update to 0.0.80" })
    await expect.element(restarting).toBeDisabled()
    await expect.element(restarting).toHaveTextContent("Restarting…")
  })
})
