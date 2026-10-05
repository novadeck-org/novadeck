import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { render, type Rendered } from "../test/render"
import { CrashLoopDialog } from "./CrashLoopDialog"

const mounted: Rendered[] = []
afterEach(() => mounted.splice(0).forEach((page) => page.unmount()))

const dialog = () => document.querySelector<HTMLElement>("[role=alertdialog]")

const show = (crashes: number | null) => {
  const onRetry = vi.fn<() => void>()
  const onDismiss = vi.fn<() => void>()
  const page = render(createElement(CrashLoopDialog, { crashes, onRetry, onDismiss }))
  mounted.push(page)
  const button = (name: string) =>
    [...(dialog()?.querySelectorAll("button") ?? [])].find((item) => item.textContent === name)!
  return { button, onRetry, onDismiss }
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)))

describe("crash loop dialog", () => {
  context("when the guard trips", () => {
    // Initial focus and Escape come from Ark's focus trap and dismissal, which need a
    // real browser; the desktop smoke run covers them.
    it("says how often the runner crashed", async () => {
      show(4)
      await settle()
      expect(dialog()?.textContent).toContain("The runner keeps crashing")
      expect(dialog()?.textContent).toContain(
        "Novadeck stopped restarting your terminals after 4 crashes in a minute.",
      )
    })
  })

  context("when the person answers", () => {
    it("tries again on Try again", async () => {
      const { button, onRetry, onDismiss } = show(4)
      await settle()
      act(() => button("Try again").click())
      expect(onRetry).toHaveBeenCalledOnce()
      expect(onDismiss).not.toHaveBeenCalled()
    })

    it("leaves it on Not now", async () => {
      const { button, onDismiss } = show(4)
      await settle()
      act(() => button("Not now").click())
      expect(onDismiss).toHaveBeenCalledOnce()
    })
  })

  context("while nothing crashes", () => {
    it("stays closed", () => {
      show(null)
      expect(dialog()).toBeNull()
    })
  })
})
