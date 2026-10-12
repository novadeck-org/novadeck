import { act, createElement } from "react"
import { vi } from "vitest"

import type { MurmurState } from "../model/murmur"
import { describe, expect, it } from "../test"
import { render } from "../test/render"
import { MurmurAddon } from "./MurmurAddon"

const unchecked: MurmurState = {
  available: true,
  installed: true,
  enabled: false,
  wanted: true,
  sizes: { engine: 34 * 1024 * 1024, model: 1222 * 1024 * 1024 },
  installing: null,
  check: null,
  failure:
    "Murmur is installed but has not passed its check on this computer's GPU yet. Try again.",
}

const actions = () => ({
  install: vi.fn<() => void>(),
  cancel: vi.fn<() => void>(),
  uninstall: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  set: vi.fn<(settings: { enabled?: boolean }) => void>(),
})

describe("murmur's card when it is installed but has not passed its check", () => {
  it("shows the switch and the failure with Try again, and no device", () => {
    const calls = actions()
    const { container, unmount } = render(
      createElement(MurmurAddon, { murmur: { state: unchecked, actions: calls } }),
    )
    expect(container.querySelector("[role=switch]")?.getAttribute("aria-checked")).toBe("false")
    expect(container.querySelector("[role=alert]")?.textContent).toMatch(/has not passed its check/)
    expect(container.textContent).not.toMatch(/Runs on/)
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    )
    retry?.click()
    expect(calls.install).toHaveBeenCalledOnce()
    unmount()
  })
})

const button = (name: string, within: ParentNode = document): HTMLButtonElement | undefined =>
  [...within.querySelectorAll("button")].find((candidate) => candidate.textContent === name)

const deferred = () => {
  const removal: { promise: Promise<void>; resolve: () => void } = {
    promise: Promise.resolve(),
    resolve: () => {},
  }
  removal.promise = new Promise<void>((resolve) => {
    removal.resolve = resolve
  })
  return removal
}

describe("murmur's card when an uninstall fails", () => {
  const failed: MurmurState = { ...unchecked, failure: "Couldn't uninstall: Disk busy." }

  it("stops saying Removing once the call settles, though the failure is the same as before", async () => {
    const removal = deferred()
    const calls = actions()
    calls.uninstall.mockImplementation(() => removal.promise)
    const { container, unmount } = render(
      createElement(MurmurAddon, { murmur: { state: failed, actions: calls } }),
    )
    await act(async () => {
      button("Uninstall", container)?.click()
      await Promise.resolve()
    })
    const dialog = document.querySelector("[role=alertdialog]")
    await act(async () => {
      button("Uninstall", dialog ?? document)?.click()
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(calls.uninstall).toHaveBeenCalledOnce()
    expect(button("Removing…", container)?.disabled).toBe(true)
    await act(async () => {
      removal.resolve()
      await removal.promise
    })
    expect(button("Uninstall", container)?.disabled).toBe(false)
    expect(button("Removing…", container)).toBeUndefined()
    unmount()
  })
})

describe("murmur's card when murmur failed while running", () => {
  it("shows the failure and Try again beside the device it passed its check on", () => {
    const checked: MurmurState = {
      ...unchecked,
      enabled: true,
      check: { device: "Intel Arc Graphics", integrated: true, milliseconds: 900 },
      failure: "Murmur stopped: its GPU went away.",
    }
    const calls = actions()
    const { container, unmount } = render(
      createElement(MurmurAddon, { murmur: { state: checked, actions: calls } }),
    )
    expect(container.querySelector("[role=alert]")?.textContent).toMatch(/GPU went away/)
    expect(container.textContent).toMatch(/Intel Arc Graphics/)
    button("Try again", container)?.click()
    expect(calls.install).toHaveBeenCalledOnce()
    unmount()
  })
})
