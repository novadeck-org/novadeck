import { watchBarDrag } from "../support/bar-drag"
import { dragIconToFreeSpace, openShowcase } from "../support/companions"
import { gridView } from "../support/layouts"
import { layoutSettled, terminal } from "../support/workspace"
import { expect, it } from "../test"

for (const one of [false, true])
  it(`finds free Grid space beyond a window's resize handle in ${one ? "one move" : "several moves"}`, async () => {
    watchBarDrag()
    await openShowcase()
    const view = gridView()
    // A 32px strip below the windows fits a drop, but the coarse scan lands on a handle.
    const element = view.element() as HTMLElement
    Object.assign(element.style, { flex: "none", height: "608px", maxHeight: "608px" })
    await layoutSettled()
    const box = element.getBoundingClientRect()
    expect(
      document
        .elementFromPoint(box.right - 40, box.bottom - 40)
        ?.classList.contains("react-resizable-handle"),
    ).toBe(true)

    await dragIconToFreeSpace("Refactor auth", "Plan: refactor-auth.md", view, { one })
    await expect.element(terminal("refactor-auth.md")).toBeVisible()
  })
