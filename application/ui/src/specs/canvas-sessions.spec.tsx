import { describe as context, describe, expect, it } from "vitest"

import { boxOf, dragBackground, sameBox, scrollCanvas, settled } from "./support/canvas"
import {
  currentSessionName,
  emptyWorkspace,
  expectCurrentSession,
  pressNewSession,
  savedSession,
} from "./support/sessions"
import {
  chooseView,
  layoutSettled,
  openWorkspace,
  sidebarPanel,
  terminal,
} from "./support/workspace"

const name = "Checkout implementation"

describe("Canvas across workspace sessions", () => {
  context("when switching session right after moving the camera", () => {
    it("shows the camera as it was left on returning", async () => {
      await openWorkspace()
      await sidebarPanel("Sessions").click()
      const original = await currentSessionName()
      await chooseView("Canvas")
      await expect.element(terminal(name)).toBeVisible()
      await layoutSettled()
      await dragBackground({ x: 150, y: 100 }, { x: 0, y: 450 })
      const panned = await settled(() => boxOf(terminal(name)))

      await scrollCanvas(-300)
      await expect.poll(() => boxOf(terminal(name)).width).toBeGreaterThan(panned.width + 20)
      const left = boxOf(terminal(name))
      // No waiting for the gesture to end: Canvas saves the camera as it unmounts.
      await pressNewSession()
      await expect.element(emptyWorkspace()).toBeVisible()
      await savedSession(original).click()

      await expectCurrentSession(original)
      await expect.element(terminal(name)).toBeVisible()
      const back = await settled(() => boxOf(terminal(name)))
      expect(back).toSatisfy((box: typeof left) => sameBox(box, left))
    })
  })
})
