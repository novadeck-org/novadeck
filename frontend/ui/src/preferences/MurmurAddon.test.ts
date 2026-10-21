import type { MurmurState } from "@novadeck/core/murmur"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { vi } from "vitest"

import { describe, expect, it } from "../test"
import { MurmurAddon } from "./MurmurAddon"

const unchecked: MurmurState = {
  available: true,
  installed: true,
  enabled: false,
  wanted: true,
  sizes: { engine: 34 * 1024 * 1024, model: 1222 * 1024 * 1024 },
  installing: null,
  check: null,
  kept: false,
  unsupported: null,
  offers: 0,
  refused: null,
  failure: null,
  stopped: null,
}

const actions = () => ({
  install: vi.fn<() => Promise<void>>(() => Promise.resolve()),
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
    // Not a failure: a quiet note that the check is owed.
    expect(container.querySelector("[role=alert]")).toBeNull()
    expect(container.textContent).toMatch(/has not passed its check/)
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
  const failed: MurmurState = {
    ...unchecked,
    refused: { call: "uninstall", message: "Disk busy." },
  }

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
      failure: "Murmur stopped: its graphics device went away.",
    }
    const calls = actions()
    const { container, unmount } = render(
      createElement(MurmurAddon, { murmur: { state: checked, actions: calls } }),
    )
    expect(container.querySelector("[role=alert]")?.textContent).toMatch(
      /graphics device went away/,
    )
    expect(container.textContent).toMatch(/Intel Arc Graphics/)
    button("Try again", container)?.click()
    expect(calls.install).toHaveBeenCalledOnce()
    unmount()
  })
})

describe("murmur's card on a computer that can't run it", () => {
  const unsupported: MurmurState = {
    ...unchecked,
    installed: false,
    failure: null,
    unsupported: {
      reason: "No graphics device answered. On Linux, check that a Vulkan driver is installed.",
      source: "check" as const,
    },
  }

  it("offers no Remove while no model is kept", () => {
    const { container, unmount } = render(
      createElement(MurmurAddon, { murmur: { state: unsupported, actions: actions() } }),
    )
    expect(button("Remove", container)).toBeUndefined()
    unmount()
  })

  it("offers Remove for a kept model, which asks first and then uninstalls", async () => {
    const calls = actions()
    const { container, unmount } = render(
      createElement(MurmurAddon, {
        murmur: { state: { ...unsupported, kept: true }, actions: calls },
      }),
    )
    // Check again stays beside it.
    expect(container.textContent).toMatch(/Not available on this computer/)
    await act(async () => {
      button("Remove", container)?.click()
      await Promise.resolve()
    })
    expect(calls.uninstall).not.toHaveBeenCalled()
    const dialog = document.querySelector("[role=alertdialog]")
    await act(async () => {
      button("Remove", dialog ?? document)?.click()
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(calls.uninstall).toHaveBeenCalledOnce()
    unmount()
  })

  it("says Not available in place of Install, with the reason behind Details", () => {
    const calls = actions()
    const { container, unmount } = render(
      createElement(MurmurAddon, { murmur: { state: unsupported, actions: calls } }),
    )
    expect(container.textContent).toMatch(/Not available on this computer/)
    expect(button("Install", container)).toBeUndefined()
    expect(container.querySelector("[role=switch]")).toBeNull()
    expect(container.textContent).not.toMatch(/GPU/)
    const details = container.querySelector("details")
    expect(details?.querySelector("summary")?.textContent).toBe("Details")
    expect(details?.open).toBe(false)
    expect(details?.textContent).toMatch(/Vulkan driver/)
    unmount()
  })

  it("offers Check again inside Details, which installs again", () => {
    const calls = actions()
    const { container, unmount } = render(
      createElement(MurmurAddon, { murmur: { state: unsupported, actions: calls } }),
    )
    expect(
      container.querySelector("details")?.contains(button("Check again", container) ?? null),
    ).toBe(true)
    button("Check again", container)?.click()
    expect(calls.install).toHaveBeenCalledOnce()
    unmount()
  })

  it("has no Check again for what the host saw", () => {
    const { container, unmount } = render(
      createElement(MurmurAddon, {
        murmur: {
          state: {
            ...unsupported,
            unsupported: { reason: "Software rendering only.", source: "host" as const },
          },
          actions: actions(),
        },
      }),
    )
    expect(button("Check again", container)).toBeUndefined()
    unmount()
  })
})

describe("murmur's card before an install", () => {
  it("says what it downloads without mentioning a GPU", () => {
    const { container, unmount } = render(
      createElement(MurmurAddon, {
        murmur: {
          state: { ...unchecked, installed: false, failure: null },
          actions: actions(),
        },
      }),
    )
    expect(container.textContent).toMatch(/Downloads 1\.2 GB once, then works offline\./)
    expect(container.textContent).not.toMatch(/GPU/)
    unmount()
  })
})

describe("murmur's card when a verdict stands beside files", () => {
  it("says Not available with Details beside Uninstall, with no switch and no Try again", () => {
    const { container, unmount } = render(
      createElement(MurmurAddon, {
        murmur: {
          state: {
            ...unchecked,
            failure: null,
            unsupported: {
              reason: "This computer reports only software rendering.",
              source: "host" as const,
            },
          },
          actions: actions(),
        },
      }),
    )
    expect(container.textContent).toMatch(/Not available on this computer/)
    expect(container.querySelector("details")?.textContent).toMatch(/software rendering/)
    expect(container.querySelector("[role=switch]")).toBeNull()
    expect(button("Uninstall", container)).toBeDefined()
    expect(button("Try again", container)).toBeUndefined()
    unmount()
  })

  it("keeps the switch for an install that passed its check, whatever the host says", () => {
    const { container, unmount } = render(
      createElement(MurmurAddon, {
        murmur: {
          state: {
            ...unchecked,
            enabled: true,
            check: { device: "Intel Arc Graphics", integrated: true, milliseconds: 900 },
            failure: null,
            unsupported: {
              reason: "This computer reports only software rendering.",
              source: "host" as const,
            },
          },
          actions: actions(),
        },
      }),
    )
    expect(container.querySelector("[role=switch]")).not.toBeNull()
    expect(container.textContent).not.toMatch(/Not available/)
    unmount()
  })
})

describe("murmur's card when an install runs beside a standing verdict", () => {
  it("shows the install, not Not available, until the new check ends", () => {
    const { container, unmount } = render(
      createElement(MurmurAddon, {
        murmur: {
          state: {
            ...unchecked,
            installed: false,
            unsupported: { reason: "No graphics device answered.", source: "check" as const },
            installing: { step: "check", received: 0, total: 0, origin: "person" },
          },
          actions: actions(),
        },
      }),
    )
    expect(container.textContent).toMatch(/Checking this computer/)
    expect(container.textContent).not.toMatch(/Not available/)
    unmount()
  })
})

describe("murmur's card under the host's verdict", () => {
  it("offers no retry for a runtime failure of an install that works, only Uninstall", () => {
    const { container, unmount } = render(
      createElement(MurmurAddon, {
        murmur: {
          state: {
            ...unchecked,
            enabled: true,
            check: { device: "Intel Arc Graphics", integrated: true, milliseconds: 900 },
            unsupported: {
              reason: "This computer reports only software rendering.",
              source: "host" as const,
            },
            failure: "Murmur stopped: its engine kept failing.",
          },
          actions: actions(),
        },
      }),
    )
    expect(container.textContent).toMatch(/engine kept failing/)
    expect(button("Try again", container)).toBeUndefined()
    expect(button("Uninstall", container)).toBeDefined()
    unmount()
  })
})
