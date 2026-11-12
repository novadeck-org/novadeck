import { page, userEvent } from "vitest/browser"

import { agentShowsPage } from "../support/backend"
import { companionPane } from "../support/companions"
import { pressableToasts } from "../support/toasts"
import {
  expectStaysAbsent,
  layoutSettled,
  openWorkspace,
  terminal,
  terminalTab,
} from "../support/workspace"
import { describe, expect, it } from "../test"

describe("Canvas with a pane an agent opens in a window that is not selected", () => {
  // Its toast is pressed.
  pressableToasts()
  const node = (name: string): HTMLElement =>
    terminal(name).element().closest<HTMLElement>(".react-flow__node")!
  const selected = (name: string): boolean => node(name).classList.contains("selected")
  const camera = (): string =>
    document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? ""

  it("waits behind a toast, the camera still; a click on it selects the window", async () => {
    await openWorkspace("/projects/bar-mleczny/sessions/initial/canvas?demo=babcia")
    await expect.element(terminal("Seasonal specials")).toBeVisible()
    await terminalTab("Menu page").click()
    await layoutSettled()
    expect(selected("Menu page")).toBe(true)
    const before = camera()

    agentShowsPage()
    await expect.element(page.getByText("wants to show you")).toBeVisible()
    const toast = document.querySelector<HTMLElement>(".toast")!
    expect(toast.textContent).toContain("Seasonal specials")
    await expectStaysAbsent(companionPane("Seasonal specials"), { ms: 500 })
    expect(camera()).toBe(before)
    expect(selected("Menu page")).toBe(true)

    // A click on it, as on an Inbox toast, takes the person there.
    await userEvent.click(page.elementLocator(toast))
    await expect.element(companionPane("Seasonal specials")).toBeVisible()
    await expect.poll(() => selected("Seasonal specials")).toBe(true)
  })
})
