import { describe, expect, it } from "vitest"
import { page, userEvent, type Locator } from "vitest/browser"

import { openShowcase, taskbarIcon } from "./support/companions"
import { openWorkspace } from "./support/workspace"

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Moves the pointer about over `target` for `duration` milliseconds, never resting on
// purpose, and says the longest it paused between two moves, which a busy machine can
// stretch.
const sweep = async (target: Locator, duration: number): Promise<number> => {
  const element = target.element()
  const box = element.getBoundingClientRect()
  // The pointer arrives, as a mouse's would, then keeps moving; like a mouse's, its
  // events can be cancelled.
  element.dispatchEvent(
    new PointerEvent("pointerover", { bubbles: true, cancelable: true, pointerType: "mouse" }),
  )
  let longest = 0
  let last = performance.now()
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
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
    // eslint-disable-next-line no-await-in-loop -- Each move waits for the one before.
    await wait(50)
  }
  return longest
}

// Sweeps over `target` until a sweep never paused as long as `rest`, so nothing had time
// to open, leaving between tries so what a stalled try opened closes.
const sweepWithoutResting = async (
  target: Locator,
  duration: number,
  rest: number,
): Promise<void> => {
  for (let attempt = 0; attempt < 5; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- Each try follows the last.
    if ((await sweep(target, duration)) < rest / 2) return
    // React hears the pointer leave from `pointerout`, as a mouse's leaving sends it.
    target.element().dispatchEvent(
      new PointerEvent("pointerout", {
        bubbles: true,
        pointerType: "mouse",
        relatedTarget: document.body,
      }),
    )
    // eslint-disable-next-line no-await-in-loop -- What a stalled try opened closes first.
    await wait(400)
  }
  throw new Error("The machine was too busy to move the pointer without pausing")
}

describe("A tooltip", () => {
  it("waits for the pointer to rest on its trigger", async () => {
    await openWorkspace()
    const zen = page.getByRole("button", { name: "Enter Zen mode" })
    await expect.element(zen).toBeVisible()

    const tooltip = page.getByText(/^Zen · /)

    await sweepWithoutResting(zen, 1000, 400)
    expect(tooltip.query()).toBeNull()

    await userEvent.hover(zen)
    await expect.element(tooltip).toBeVisible()
  })
})

describe("A tooltip for keyboard focus", () => {
  it("opens without waiting", async () => {
    await openWorkspace()
    const zen = page.getByRole("button", { name: "Enter Zen mode" })
    await expect.element(zen).toBeVisible()

    // Tab through the header until the focus reaches it, as a keyboard user would.
    for (let presses = 0; presses < 20 && document.activeElement !== zen.element(); presses++)
      // eslint-disable-next-line no-await-in-loop -- Each Tab moves on from the last.
      await userEvent.keyboard("{Tab}")
    expect(document.activeElement).toBe(zen.element())

    await expect.element(page.getByText(/^Zen · /), { timeout: 300 }).toBeVisible()
  })
})

describe("A tooltip beside one that shows", () => {
  it("still waits for the pointer to rest", async () => {
    await openWorkspace()
    const zen = page.getByRole("button", { name: "Enter Zen mode" })
    const preferences = page.getByRole("button", { name: "Workspace preferences" })
    await userEvent.hover(zen)
    await expect.element(page.getByText(/^Zen · /)).toBeVisible()

    await sweepWithoutResting(preferences, 600, 400)

    expect(page.getByText(/^Preferences · /).query()).toBeNull()
  })
})

describe("A peek", () => {
  it("waits for the pointer to rest on its icon", async () => {
    await openShowcase()
    const icon = taskbarIcon("Build Studio", "2 images")
    await expect.element(icon).toBeVisible()
    const card = page.getByRole("button", { name: /^about\.png/ })

    await sweepWithoutResting(icon, 800, 250)
    expect(card.query()).toBeNull()

    await userEvent.hover(icon)
    await expect.element(card).toBeVisible()
  })
})
