import { describe, expect, it, vi } from "vitest"
import { page, userEvent, type Locator } from "vitest/browser"

import { openShowcase, taskbarIcon } from "./support/companions"
import { expectStaysAbsent, openWorkspace } from "./support/workspace"

// Moves the pointer about over `target` for `duration` milliseconds, a move every 50,
// never resting. The page's timers run on a clock the test moves, so a busy machine can't
// stretch a gap between two moves into a rest.
const sweep = (target: Locator, duration: number): void => {
  const element = target.element()
  const box = element.getBoundingClientRect()
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  try {
    // The pointer arrives, as a mouse's would, then keeps moving; like a mouse's, its
    // events can be cancelled.
    element.dispatchEvent(
      new PointerEvent("pointerover", { bubbles: true, cancelable: true, pointerType: "mouse" }),
    )
    for (let move = 0; move * 50 < duration; move++) {
      element.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          pointerType: "mouse",
          clientX: box.left + box.width * (0.25 + (move % 2) * 0.5),
          clientY: box.top + box.height / 2,
        }),
      )
      vi.advanceTimersByTime(50)
    }
  } finally {
    vi.useRealTimers()
  }
}

describe("A tooltip", () => {
  it("waits for the pointer to rest on its trigger", async () => {
    await openWorkspace()
    const zen = page.getByRole("button", { name: "Enter Zen mode" })
    await expect.element(zen).toBeVisible()

    const tooltip = page.getByText(/^Zen · /)

    sweep(zen, 1000)
    await expectStaysAbsent(tooltip)

    await userEvent.hover(zen)
    await expect.element(tooltip).toBeVisible()
  })
})

describe("A tooltip for keyboard focus", () => {
  it("opens without waiting", async () => {
    await openWorkspace()
    const zen = page.getByRole("button", { name: "Enter Zen mode" })
    await expect.element(zen).toBeVisible()

    // The page's timers stand still, so it opens with no time passing for it, however long
    // a busy machine takes to show it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      // Tab through the header until the focus reaches it, as a keyboard user would.
      for (let presses = 0; presses < 20 && document.activeElement !== zen.element(); presses++)
        // eslint-disable-next-line no-await-in-loop -- Each Tab moves on from the last.
        await userEvent.keyboard("{Tab}")
      expect(document.activeElement).toBe(zen.element())

      await expect.element(page.getByText(/^Zen · /)).toBeVisible()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("A tooltip beside one that shows", () => {
  it("still waits for the pointer to rest", async () => {
    await openWorkspace()
    const zen = page.getByRole("button", { name: "Enter Zen mode" })
    const preferences = page.getByRole("button", { name: "Workspace preferences" })
    await userEvent.hover(zen)
    await expect.element(page.getByText(/^Zen · /)).toBeVisible()

    sweep(preferences, 600)

    await expectStaysAbsent(page.getByText(/^Preferences · /))
  })
})

describe("A peek", () => {
  it("waits for the pointer to rest on its icon", async () => {
    await openShowcase()
    const icon = taskbarIcon("Build Studio", "2 images")
    await expect.element(icon).toBeVisible()
    const card = page.getByRole("button", { name: /^about\.png/ })

    sweep(icon, 800)
    await expectStaysAbsent(card)

    await userEvent.hover(icon)
    await expect.element(card).toBeVisible()
  })
})
