import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach } from "vitest"

import { context, describe, expect, it } from "../../test"
import { Waveform } from "./Waveform"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

// The waveform at 400px wide from x = 100, as jsdom measures nothing.
const shown = (
  props: Partial<Parameters<typeof Waveform>[0]> = {},
): { wave: HTMLElement; seeks: number[]; container: HTMLElement } => {
  const seeks: number[] = []
  const rect = { left: 100, width: 400, right: 500, top: 0, bottom: 56, height: 56, x: 100, y: 0 }
  const original = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect })
  const { container, unmount } = render(
    createElement(Waveform, {
      peaks: [0.2, 1, 0.5, 0.8],
      time: 12,
      duration: 100,
      onSeek: (to: number) => seeks.push(to),
      ...props,
    }),
  )
  unmounts.push(unmount, () => (Element.prototype.getBoundingClientRect = original))
  return { wave: container.querySelector<HTMLElement>(".wave")!, seeks, container }
}
const pointer = (wave: HTMLElement, type: string, clientX: number) =>
  act(() => {
    wave.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, button: 0 }))
  })
const press = (wave: HTMLElement, key: string) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  act(() => {
    wave.dispatchEvent(event)
  })
  return event
}

describe("a recording's waveform", () => {
  context("as a slider", () => {
    it("says where it is in words", () => {
      const { wave } = shown({ time: 75, duration: 92 })
      expect(wave.getAttribute("role")).toBe("slider")
      expect(wave.getAttribute("aria-valuetext")).toBe("1:15 of 1:32")
      expect(wave.getAttribute("aria-valuemax")).toBe("92")
    })

    it("jumps 5 seconds with the arrows, and to the ends with Home and End", () => {
      const { wave, seeks } = shown({ time: 12, duration: 100 })
      press(wave, "ArrowRight")
      press(wave, "ArrowLeft")
      press(wave, "Home")
      press(wave, "End")
      expect(seeks).toEqual([17, 7, 0, 100])
    })

    it("holds a jump to the recording, and keeps its keys from the player's", () => {
      const { wave, seeks } = shown({ time: 2, duration: 100 })
      const event = press(wave, "ArrowLeft")
      expect(seeks).toEqual([0])
      expect(event.defaultPrevented).toBe(true)
      expect(press(wave, "x").defaultPrevented).toBe(false)
    })

    it("does nothing until the recording's length is known", () => {
      const { wave, seeks } = shown({ duration: 0 })
      press(wave, "ArrowRight")
      pointer(wave, "pointerdown", 300)
      expect(seeks).toEqual([])
      expect(wave.getAttribute("aria-disabled")).toBe("true")
    })
  })

  context("with the pointer", () => {
    it("seeks to where it is pressed, and follows a drag", () => {
      const { wave, seeks } = shown({ duration: 80 })
      pointer(wave, "pointerdown", 300)
      pointer(wave, "pointermove", 400)
      pointer(wave, "pointerup", 400)
      pointer(wave, "pointermove", 500)
      expect(seeks).toEqual([40, 60])
    })

    it("holds a press outside to the ends", () => {
      const { wave, seeks } = shown({ duration: 80 })
      pointer(wave, "pointerdown", 50)
      pointer(wave, "pointerdown", 900)
      expect(seeks).toEqual([0, 80])
    })

    it("shows the time under it while hovered, and no more once it leaves", () => {
      const { wave, container } = shown({ duration: 100 })
      pointer(wave, "pointermove", 200)
      expect(container.querySelector(".wave-tip")!.textContent).toBe("0:25")
      expect(container.querySelector(".wave-line")).not.toBeNull()
      pointer(wave, "pointerout", 200)
      expect(container.querySelector(".wave-tip")).toBeNull()
    })
  })

  context("in its bars", () => {
    it("draws as many as fit, 4 pixels to a bar, and the played part to where it has got", () => {
      const { wave } = shown({ time: 25, duration: 100 })
      expect(
        wave.querySelectorAll(".wave-bars:not(.wave-played .wave-bars) > .wave-bar"),
      ).toHaveLength(100)
      expect(wave.style.getPropertyValue("--_played")).toBe("25%")
      expect(wave.getAttribute("data-peaks")).toBe("ready")
    })

    it("draws a flat track without peaks, which waits while they are worked out", () => {
      const waiting = shown({ peaks: undefined })
      expect(waiting.wave.getAttribute("data-peaks")).toBe("pending")
      const bars = [...waiting.wave.querySelectorAll<HTMLElement>(".wave-bar")]
      expect(new Set(bars.map((bar) => bar.style.height)).size).toBe(1)
      expect(shown({ peaks: null }).wave.getAttribute("data-peaks")).toBe("none")
    })
  })
})
