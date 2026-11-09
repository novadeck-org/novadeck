import { clickBackground, settled } from "../support/canvas"
import { chooseView, openWorkspace, press, terminal, terminalTab } from "../support/workspace"
import { context, describe, expect, it } from "../test"

// Agent avatars, an experimental feature: each terminal's critter, the avatar Messages
// draws, in its program's place in its tab and window header, growing past the window's
// corner on a zoomed-out Canvas.

const name = "Checkout implementation"

/** Opens the agents demo with Agent avatars switched on, in an app that follows experimental
 * builds unless `experimental` is false. */
const openWithAvatars = async ({ experimental = true } = {}): Promise<void> => {
  localStorage.setItem("novadeck.preferences", JSON.stringify({ agentAvatars: true }))
  await openWorkspace(`/?demo=agents${experimental ? "&channel=experimental" : ""}`)
  await expect.element(terminalTab(name)).toBeVisible()
}

const avatarIn = (element: Element, selector = ".message-av"): HTMLElement | null =>
  element.querySelector<HTMLElement>(selector)

const headerAvatar = (): HTMLElement =>
  avatarIn(terminal(name).element(), ".terminal-switch .message-av")!

// The Canvas's zoom, from the window's size on screen against its own.
const zoom = (): number => {
  const element = terminal(name).element() as HTMLElement
  return element.getBoundingClientRect().width / element.offsetWidth
}

/** Presses a zoom key, one step after another, until the zoom has passed `target`. */
const zoomPast = async (key: "+" | "-", target: number): Promise<void> => {
  for (let step = 0; step < 12; step++) {
    // eslint-disable-next-line no-await-in-loop -- Each step reads the zoom the last one left.
    const now = await settled(zoom)
    if (key === "+" ? now >= target : now <= target) return
    // eslint-disable-next-line no-await-in-loop -- One zoom step after another.
    await press(key)
  }
}

describe("agent avatars", () => {
  context("when switched on in an app that follows experimental builds", () => {
    it("puts the terminal's critter in its tab and window header", async () => {
      await openWithAvatars()

      await expect.poll(() => avatarIn(terminalTab(name).element())).not.toBeNull()
      await expect
        .poll(() => avatarIn(terminal(name).element(), ".terminal-switch .message-av"))
        .not.toBeNull()
      // Its slot widens to the critter's 24px, so the name moves over rather than under it.
      const slot = terminalTab(name).element().querySelector(".sidebar-item-icon")!
      expect(slot.getBoundingClientRect().width).toBe(24)
      // It stands as Messages draws it: Dev server runs no agent, so its critter is dim.
      expect(avatarIn(terminalTab("Dev server").element())?.dataset.live).toBe("gone")
    })
  })

  context("when switched on but the app doesn't follow experimental builds", () => {
    it("keeps the program's icon", async () => {
      await openWithAvatars({ experimental: false })

      expect(avatarIn(terminalTab(name).element())).toBeNull()
      expect(avatarIn(terminal(name).element(), ".terminal-switch .message-av")).toBeNull()
    })
  })

  context("on Canvas", () => {
    it("keeps the critter 24px on screen as it zooms out, inside its header, pushing the title over", async () => {
      await openWithAvatars()
      await chooseView("Canvas")
      await expect.element(terminal(name)).toBeVisible()
      await clickBackground({ x: 150, y: 100 })

      const window = (): DOMRect => terminal(name).element().getBoundingClientRect()
      const title = (): DOMRect =>
        terminal(name).element().querySelector("[data-terminal-name]")!.getBoundingClientRect()
      const inside = (critter: DOMRect): void => {
        const frame = window()
        expect(critter.left).toBeGreaterThanOrEqual(frame.left)
        expect(critter.top).toBeGreaterThanOrEqual(frame.top)
        expect(critter.right).toBeLessThanOrEqual(title().left)
      }

      // While the header has room it holds 24px on screen, whatever the zoom.
      await zoomPast("+", 0.6)
      const near = await settled(() => headerAvatar().getBoundingClientRect().toJSON() as DOMRect)
      expect(zoom()).toBeGreaterThan(0.45)
      expect(near.width).toBeCloseTo(24, 0)
      inside(near)

      // Further out it fills the header and shrinks with it, never leaving its window.
      await zoomPast("-", 0.2)
      const far = await settled(() => headerAvatar().getBoundingClientRect().toJSON() as DOMRect)
      expect(far.width).toBeLessThan(24)
      expect(far.width).toBeGreaterThan(12)
      inside(far)
    })
  })
})
