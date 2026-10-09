import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { render, type Rendered } from "../test/render"
import { recoveredForMs, WorkspaceFooter, type FooterStatus } from "./WorkspaceFooter"

const mounted: Rendered[] = []
afterEach(() => {
  mounted.splice(0).forEach((page) => page.unmount())
  vi.useRealTimers()
})

const props = (status: FooterStatus, update?: string, onInstall = () => {}) => ({
  hidden: false,
  count: 2,
  running: 1,
  status,
  update,
  onInstall,
})

const announcer = (page: Rendered) =>
  page.container.querySelector<HTMLElement>(".sr-only[role=status]")!

const footer = (status: FooterStatus) =>
  createElement(WorkspaceFooter, { hidden: false, count: 2, running: 1, status })

const show = (status: FooterStatus) => {
  const page = render(footer(status))
  mounted.push(page)
  const bar = () => page.container.querySelector("footer")!
  return {
    bar,
    said: () => page.container.querySelector(".footer-status [role=status]")?.textContent ?? "",
    change: (next: FooterStatus) => page.rerender(footer(next)),
  }
}

describe("workspace footer", () => {
  context("while the runner link is healthy", () => {
    it("shows the counts untoned and no status", () => {
      const { bar, said } = show("ok")
      expect(bar().textContent).toContain("2 terminals")
      expect(bar().hasAttribute("data-tone")).toBe(false)
      expect(said()).toBe("")
    })
  })

  context("while the runner reconnects", () => {
    it("tones the whole bar as a warning and says so", () => {
      const { bar, said } = show("reconnecting")
      expect(bar().dataset["tone"]).toBe("warning")
      expect(bar().textContent).toContain("1 running")
      expect(said()).toBe("Reconnecting")
    })
  })

  context("when the runner is unavailable", () => {
    it("tones the bar as danger and says so assertively", () => {
      const { bar, said } = show("unavailable")
      expect(bar().dataset["tone"]).toBe("danger")
      expect(said()).toBe("Offline")
      expect(bar().querySelector(".footer-status [role=status]")?.getAttribute("aria-live")).toBe(
        "assertive",
      )
    })
  })

  context("when the runner keeps restarting", () => {
    it("tones the bar as danger and says so", () => {
      const { bar, said } = show("restarting")
      expect(bar().dataset["tone"]).toBe("danger")
      expect(said()).toBe("Crash loop")
    })
  })

  context("while a crash loop offers to try again", () => {
    it("carries a Try again action that starts over", () => {
      const onRetry = vi.fn<() => void>()
      const page = render(
        createElement(WorkspaceFooter, {
          hidden: false,
          count: 2,
          running: 0,
          status: "restarting",
          onRetry,
        }),
      )
      mounted.push(page)
      const action = [...page.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Try again",
      )!
      act(() => action.click())
      expect(onRetry).toHaveBeenCalledOnce()
    })

    it("offers nothing while the runner only reconnects", () => {
      const page = render(
        createElement(WorkspaceFooter, {
          hidden: false,
          count: 2,
          running: 0,
          status: "reconnecting",
          onRetry: () => {},
        }),
      )
      mounted.push(page)
      expect(page.container.querySelector("button")).toBeNull()
    })
  })

  context("once the runner is back", () => {
    it("tones the bar as success with Reconnected for a moment, then rests untoned", () => {
      vi.useFakeTimers()
      const { bar, said, change } = show("reconnecting")
      change("ok")
      expect(bar().dataset["tone"]).toBe("success")
      expect(said()).toBe("Reconnected")
      act(() => vi.advanceTimersByTime(recoveredForMs))
      expect(bar().hasAttribute("data-tone")).toBe(false)
      expect(said()).toBe("")
    })
  })

  context("while an update waits", () => {
    const withUpdate = (status: FooterStatus, onInstall = () => {}) => {
      const page = render(createElement(WorkspaceFooter, props(status, "0.0.80", onInstall)))
      mounted.push(page)
      return page
    }

    it("keeps a polite live region mounted, empty until the update arrives, then fills it", () => {
      const page = render(createElement(WorkspaceFooter, props("ok")))
      mounted.push(page)
      const region = announcer(page)
      expect(region.getAttribute("aria-live")).toBe("polite")
      expect(region.textContent).toBe("")
      page.rerender(createElement(WorkspaceFooter, props("ok", "0.0.80")))
      expect(announcer(page)).toBe(region)
      expect(region.textContent).toBe("Update ready")
    })

    it("says Update ready to assistive technology while the narrow bar shows the button alone", () => {
      const page = withUpdate("ok")
      expect(announcer(page).textContent).toBe("Update ready")
      const visible = [...page.container.querySelectorAll(".footer-update > span")]
      expect(visible.every((part) => part.classList.contains("max-[701px]:hidden"))).toBe(true)
      expect(page.container.querySelector(".footer-update button")?.textContent).toBe(
        "RestartUpdate",
      )
    })

    it("shows Restarting once pressed, disabled and announced, and presses only once", () => {
      const onInstall = vi.fn<() => void>()
      const page = withUpdate("ok", onInstall)
      const button = page.container.querySelector("button")!
      act(() => button.click())
      act(() => button.click())
      expect(onInstall).toHaveBeenCalledOnce()
      expect(button.disabled).toBe(true)
      expect(button.textContent).toBe("Restarting…")
      expect(button.getAttribute("aria-label")).toBe("Restarting to update to 0.0.80")
      expect(announcer(page).textContent).toBe("Restarting to update")
      expect(page.container.textContent).not.toContain("Update ready ·")
    })

    it("offers Restart again when a newer version is reported", () => {
      const page = withUpdate("ok")
      act(() => page.container.querySelector("button")!.click())
      page.rerender(createElement(WorkspaceFooter, props("ok", "0.0.81")))
      const button = page.container.querySelector("button")!
      expect(button.disabled).toBe(false)
      expect(button.getAttribute("aria-label")).toBe("Restart to update to 0.0.81")
      expect(announcer(page).textContent).toBe("Update ready")
    })

    it("offers a restart that names the version and installs when pressed", () => {
      const onInstall = vi.fn<() => void>()
      const page = withUpdate("ok", onInstall)
      expect(page.container.textContent).toContain("Update ready")
      const button = page.container.querySelector("button")!
      expect(button.getAttribute("aria-label")).toBe("Restart to update to 0.0.80")
      act(() => button.click())
      expect(onInstall).toHaveBeenCalledOnce()
    })

    it("leaves the bar's tone and the link's status to the connection", () => {
      const page = withUpdate("unavailable")
      const bar = page.container.querySelector("footer")!
      expect(bar.dataset["tone"]).toBe("danger")
      expect(bar.textContent).toContain("Offline")
      expect(bar.textContent).toContain("Update ready")
      expect(bar.querySelector(".footer-status [role=status]")?.textContent).toBe("Offline")
    })

    it("shows nothing without a version or a way to install", () => {
      const page = render(
        createElement(WorkspaceFooter, { hidden: false, count: 2, running: 1, status: "ok" }),
      )
      mounted.push(page)
      expect(page.container.querySelector("button")).toBeNull()
      expect(page.container.textContent).not.toContain("Update ready")
    })
  })
})
