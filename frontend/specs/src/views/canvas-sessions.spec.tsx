import { boxOf, dragBackground, sameBox, scrollCanvas, settled } from "../support/canvas"
import {
  currentSessionName,
  emptyWorkspace,
  expectCurrentSession,
  pressNewSession,
  savedSession,
} from "../support/sessions"
import {
  chooseView,
  layoutSettled,
  openWorkspace,
  sidebarPanel,
  terminal,
} from "../support/workspace"
import { context, describe, expect, it } from "../test"

const name = "Checkout implementation"

describe("Canvas across workspace sessions", () => {
  context("when switching session right after moving the camera", () => {
    it("frames every window afresh on returning, as on opening", async () => {
      await openWorkspace()
      await sidebarPanel("Sessions").click()
      const original = await currentSessionName()
      await chooseView("Canvas")
      await expect.element(terminal(name)).toBeVisible()
      await layoutSettled()
      const framed = await settled(() => boxOf(terminal(name)))
      await dragBackground({ x: 150, y: 100 }, { x: 0, y: 450 })
      const panned = await settled(() => boxOf(terminal(name)))
      expect(sameBox(panned, framed)).toBe(false)

      await scrollCanvas(-300)
      await expect.poll(() => boxOf(terminal(name)).width).toBeGreaterThan(panned.width + 20)
      // No waiting for the gesture to end: Canvas would save the camera as it unmounts.
      await pressNewSession()
      await expect.element(emptyWorkspace()).toBeVisible()
      await sidebarPanel("Sessions").click()
      await savedSession(original).click()

      await expectCurrentSession(original)
      await expect.element(terminal(name)).toBeVisible()
      const back = await settled(() => boxOf(terminal(name)))
      expect(back).toSatisfy((box: typeof framed) => sameBox(box, framed))
    })
  })
})
