import type { Refusal } from "@novadeck/core/addon"
import type { MurmurState } from "@novadeck/core/murmur"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"

import { describe, expect, it } from "../test"
import { FooterMurmur } from "./FooterMurmur"

const idle: MurmurState = {
  available: true,
  installed: false,
  enabled: false,
  wanted: true,
  sizes: { engine: 100, model: 300 },
  installing: null,
  check: null,
  unsupported: null,
  offers: 1,
  refused: null,
  failure: null,
}
const refusal = (message: string): Refusal => ({ call: "install", message })
const actions = { install: () => Promise.resolve(), cancel: () => {} }
const item = (state: MurmurState) =>
  createElement(FooterMurmur, {
    murmur: { state, actions, blocked: false, returnFocus: () => {} },
    hidden: false,
  })
const chip = (): HTMLButtonElement | null => document.querySelector("button.footer-murmur")
const sheetText = (): string => document.querySelector(".footer-murmur-sheet")?.textContent ?? ""

describe("Murmur's footer item as it mounts and as refusals come", () => {
  it("shows a refusal that comes after it mounted", () => {
    const { rerender, unmount } = render(item(idle))
    expect(chip()).toBeNull()
    rerender(item({ ...idle, refused: refusal("Already installing.") }))
    expect(chip()?.textContent).toBe("Murmur · failed")
    unmount()
  })

  it("does not show a refusal that was still there as it mounted", () => {
    const { unmount } = render(item({ ...idle, refused: refusal("Already installing.") }))
    expect(chip()).toBeNull()
    unmount()
  })

  it("says a second refusal while failed, in its own words", () => {
    const { rerender, unmount } = render(item(idle))
    rerender(item({ ...idle, refused: refusal("Already installing.") }))
    expect(sheetText()).toContain("Already installing.")

    // A Try again refused again: a new refusal, said too, though the sheet had been closed.
    act(() => document.querySelector<HTMLButtonElement>(".footer-murmur-sheet .primary")?.click())
    rerender(item({ ...idle, refused: refusal("The runner is busy.") }))
    expect(chip()).not.toBeNull()
    expect(sheetText()).toContain("The runner is busy.")
    unmount()
  })

  it("leaves a failure the runner made once it is cleared, but keeps one a refusal made", () => {
    const failed = render(item(idle))
    // An install that ran, then failed on the runner's side.
    failed.rerender(
      item({
        ...idle,
        installing: { step: "model", received: 1, total: 300, origin: "person" },
      }),
    )
    failed.rerender(item({ ...idle, failure: "The download stopped." }))
    expect(chip()?.textContent).toBe("Murmur · failed")
    failed.rerender(item(idle))
    expect(chip()).toBeNull()
    failed.unmount()

    const refused = render(item(idle))
    refused.rerender(item({ ...idle, refused: refusal("Already installing.") }))
    // The refusal goes with the next snapshot; the item waits to be answered.
    refused.rerender(item(idle))
    expect(chip()).not.toBeNull()
    refused.unmount()
  })
})

describe("Murmur's footer item as the runner's failure comes", () => {
  const installed: MurmurState = { ...idle, installed: true, enabled: true }
  const failing = { ...installed, failure: "The engine failed to start." }
  const notNow = (): void =>
    act(() => {
      for (const button of document.querySelectorAll<HTMLButtonElement>(
        ".footer-murmur-sheet .button",
      ))
        if (button.textContent === "Not now") button.click()
    })

  it("turns to failed and opens the sheet when the failure comes, and back when it clears", () => {
    const { rerender, unmount } = render(item(installed))
    expect(chip()).toBeNull()
    rerender(item(failing))
    expect(chip()?.textContent).toBe("Murmur · failed")
    expect(sheetText()).toContain("The engine failed to start.")
    rerender(item(installed))
    expect(chip()).toBeNull()
    unmount()
  })

  it("shows a failure that stands as it mounts", () => {
    const { unmount } = render(item(failing))
    expect(chip()?.textContent).toBe("Murmur · failed")
    expect(sheetText()).toContain("The engine failed to start.")
    unmount()
  })

  it("stays shut after Not now while the failure stands, and shows a new one after it clears", () => {
    const { rerender, unmount } = render(item(failing))
    notNow()
    expect(chip()).toBeNull()
    rerender(item({ ...failing }))
    expect(chip()).toBeNull()
    rerender(item(installed))
    rerender(item(failing))
    expect(chip()?.textContent).toBe("Murmur · failed")
    expect(sheetText()).toContain("The engine failed to start.")
    unmount()
  })
})
