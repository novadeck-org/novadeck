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

// A window's grown critter, in the layer over every window, by its node.
const grownAvatarOf = (node: string): HTMLElement =>
  document.querySelector<HTMLElement>(`.canvas-avatar-at[data-node="${node}"] .message-av`)!

const grownAvatar = (): HTMLElement =>
  grownAvatarOf(terminal(name).element().closest<HTMLElement>(".canvas-node")!.dataset.node!)

const opacity = (element: Element): number => Number(getComputedStyle(element).opacity)

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
      // Grown critters belong to Canvas alone.
      expect(document.querySelector(".canvas-avatar")).toBeNull()
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
    it("grows the header's critter past the window's corner once zoomed out, clear of the title", async () => {
      await openWithAvatars()
      await chooseView("Canvas")
      await expect.element(terminal(name)).toBeVisible()
      await clickBackground({ x: 150, y: 100 })

      // Near, the header's critter shows and its twin doesn't.
      await zoomPast("+", 0.6)
      await expect.poll(() => opacity(grownAvatar().parentElement!)).toBe(0)
      expect(opacity(headerAvatar())).toBe(1)

      // Far, the twin takes over, larger than the header's, sharing its lower right corner.
      await zoomPast("-", 0.3)
      expect(zoom()).toBeLessThanOrEqual(0.3)
      await expect.poll(() => opacity(grownAvatar().parentElement!)).toBe(1)
      expect(opacity(headerAvatar())).toBe(0)
      const grown = await settled(() => grownAvatar().getBoundingClientRect().toJSON() as DOMRect)
      const small = headerAvatar().getBoundingClientRect()
      expect(grown.width).toBeGreaterThan(small.width * 2)
      expect(Math.abs(grown.right - small.right)).toBeLessThan(1.5)
      expect(Math.abs(grown.bottom - small.bottom)).toBeLessThan(1.5)
      const title = terminal(name).element().querySelector("[data-terminal-name]")!
      expect(grown.right).toBeLessThanOrEqual(title.getBoundingClientRect().left)

      // No window covers any window's grown critter, its neighbours' included: each one's
      // corners, just inside, are its own. They take no pointer, so for the look they do here.
      const twins = [...document.querySelectorAll<HTMLElement>(".canvas-avatar .message-av")]
      expect(twins.length).toBeGreaterThan(1)
      for (const twin of twins) {
        const { left, top, right, bottom } = twin.getBoundingClientRect()
        twin.style.pointerEvents = "auto"
        for (const [x, y] of [
          [left + 2, top + 2],
          [right - 2, top + 2],
          [left + 2, bottom - 2],
        ] as const)
          expect(twin.contains(document.elementFromPoint(x, y)), `${x},${y}`).toBe(true)
        twin.style.pointerEvents = ""
      }
    })
  })
})
