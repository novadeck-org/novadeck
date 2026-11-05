import { demoInboxIds } from "@novadeck/demo/inbox/fixtures"
import { useEffect } from "react"
import { describe, expect, it } from "vitest"
import { cleanup, render } from "vitest-browser-react"

import { desktopWindow } from "./support/backend"
import { openWorkspace } from "./support/workspace"

// The first two specs run in order: the first leaves its app mounted, as every spec does, and
// the second checks what the next spec starts with.
const left = "novadeck.specs.left-by-unmount"
const route =
  "/projects/storefront/sessions/initial/focus?terminal=storefront-initial-01&desktop=on"

function WritesOnUnmount() {
  useEffect(() => () => localStorage.setItem(left, "written"), [])
  return <p>Mounted</p>
}

describe("each spec's start", () => {
  it("follows a spec that leaves an app writing to storage as it unmounts", async () => {
    const screen = await render(<WritesOnUnmount />)

    await expect.element(screen.getByText("Mounted")).toBeVisible()
  })

  it("comes after the last spec's app is gone, with whatever it wrote cleared", () => {
    expect(document.body.textContent).not.toContain("Mounted")
    expect(localStorage.getItem(left)).toBeNull()
  })
})

describe("the desktop window a spec reads", () => {
  it("is the page's, once the workspace opens again", async () => {
    await openWorkspace(route)
    desktopWindow.arrive(demoInboxIds.preview)
    await expect.poll(desktopWindow.rowIds).toContain(demoInboxIds.preview)

    await cleanup()
    await openWorkspace(route)

    desktopWindow.arrive(demoInboxIds.webhook)

    // The new page's backend never heard of the first arrival.
    await expect.poll(desktopWindow.rowIds).toEqual([demoInboxIds.webhook])
  })
})
