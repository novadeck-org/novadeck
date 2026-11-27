import { page, type Locator } from "vitest/browser"

import { expect } from "../test"

/** The footer's Help button, there while Experimental and Nova's switch are on, with a tour. */
export const helpButton = (): Locator => page.getByRole("button", { name: "Help", exact: true })

/** Opens the footer's Help menu and chooses its "Take the tour". */
export const takeTourFromHelp = async (): Promise<void> => {
  await helpButton().click()
  await page.getByRole("menuitem", { name: "Take the tour" }).click()
  await expect.element(page.getByRole("dialog", { name: "Take the tour" })).toBeVisible()
}
