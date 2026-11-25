import { render, type Rendered } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import { originText } from "./FooterOrigin"
import { WorkspaceFooter } from "./WorkspaceFooter"

const mounted: Rendered[] = []
afterEach(() => mounted.splice(0).forEach((page) => page.unmount()))

const hour = 60 * 60_000
const now = 100 * hour
const failing = [
  { repository: "novadeck", said: "Could not resolve host: github.com", since: now - 2 * hour },
]

const show = (origin?: Parameters<typeof WorkspaceFooter>[0]["origin"], hidden = false) => {
  const page = render(createElement(WorkspaceFooter, { hidden, count: 2, running: 1, origin }))
  mounted.push(page)
  return () => page.container.querySelector<HTMLButtonElement>(".footer-middle button")
}

describe("the footer's word on origin", () => {
  it("is a chip in the middle while the open project's origin keeps failing to fetch, and none otherwise", () => {
    expect(show()()).toBeNull()
    expect(show({ failing: [], onRetry: async () => {}, now })()).toBeNull()
    expect(show({ failing, onRetry: async () => {}, now }, true)()).toBeNull()
    expect(show({ failing, onRetry: async () => {}, now })()?.textContent).toBe("Can't fetch")
  })

  it("says which repository, for how long and git's reason, then what a click does", () => {
    expect(originText(failing, now)).toBe(
      [
        "novadeck: fetching origin has failed for 2 h. Could not resolve host: github.com",
        "Worktrees can't tell what has landed since. Click to try again.",
      ].join("\n"),
    )
  })

  it("fetches again on a click, saying so until the fetch has ended", async () => {
    let end = () => {}
    const onRetry = vi.fn<() => Promise<void>>(
      () => new Promise<void>((resolve) => (end = resolve)),
    )
    const chip = show({ failing, onRetry, now })
    act(() => chip()!.click())
    expect(onRetry).toHaveBeenCalledOnce()
    expect(chip()?.textContent).toBe("Fetching…")
    expect(chip()?.disabled).toBe(true)
    await act(async () => end())
    expect(chip()?.textContent).toBe("Can't fetch")
  })
})
