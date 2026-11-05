import { useEffect } from "react"
import { describe, expect, it } from "vitest"
import { render } from "vitest-browser-react"

// The specs in this file run in order: the first leaves its app mounted, as every spec does,
// and the second checks what the next spec starts with.
const left = "novadeck.specs.left-by-unmount"

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
