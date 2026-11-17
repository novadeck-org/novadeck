import { page, type Locator } from "vitest/browser"

import { expect } from "../test"

/**
 * Switches the onboarding tour on in the saved preferences, beside any already saved, as
 * Preferences → Experimental does: before the app opens, so it reads them at its start.
 */
export const switchTourOn = (): void => {
  const saved = JSON.parse(localStorage.getItem("novadeck.preferences") ?? "{}") as object
  localStorage.setItem("novadeck.preferences", JSON.stringify({ ...saved, onboardingTour: true }))
}

/** The footer's Help button, there while Experimental and the onboarding tour's switch are on. */
export const helpButton = (): Locator => page.getByRole("button", { name: "Help", exact: true })

/** Opens the footer's Help menu and chooses its "Take the tour". */
export const takeTourFromHelp = async (): Promise<void> => {
  await helpButton().click()
  await page.getByRole("menuitem", { name: "Take the tour" }).click()
  await expect.element(page.getByRole("dialog", { name: "Take the tour" })).toBeVisible()
}
