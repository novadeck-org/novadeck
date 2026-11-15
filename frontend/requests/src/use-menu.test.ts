import { afterEach } from "vitest"

import { describe, expect, it } from "./test"
import { answersKey, forwardKey, goToRow } from "./use-menu"

// Rows as `useMenu` marks them, the one the person is on taking Tab.
const rows = (count: number, on = 0): HTMLElement => {
  const root = document.createElement("div")
  for (let at = 0; at < count; at += 1) {
    const row = document.createElement("button")
    row.setAttribute("data-menu-row", "")
    row.tabIndex = at === on ? 0 : -1
    row.textContent = `row ${at + 1}`
    root.append(row)
  }
  document.body.append(root)
  return root
}

afterEach(() => {
  document.body.replaceChildren()
})

describe("A key passed on to a dialog's rows", () => {
  it("presses the row its number names, focusing it", () => {
    const root = rows(3)
    const pressed: string[] = []
    root.addEventListener("click", (event) => pressed.push((event.target as Element).textContent!))
    expect(forwardKey(root, "2")).toBe(true)
    expect(pressed).toEqual(["row 2"])
    expect(document.activeElement?.textContent).toBe("row 2")
  })

  it("moves on from the row the person is on, stopping at either end", () => {
    const root = rows(3, 1)
    expect(forwardKey(root, "ArrowDown")).toBe(true)
    expect(document.activeElement?.textContent).toBe("row 3")
    expect(forwardKey(rows(3, 2), "ArrowDown")).toBe(true)
    expect(document.activeElement?.textContent).toBe("row 3")
    expect(forwardKey(rows(3, 0), "ArrowUp")).toBe(true)
    expect(document.activeElement?.textContent).toBe("row 1")
  })

  it("is not theirs for a number past them, another key, or no rows", () => {
    expect(forwardKey(rows(2), "5")).toBe(false)
    expect(forwardKey(rows(2), "Enter")).toBe(false)
    expect(forwardKey(null, "1")).toBe(false)
  })

  it("goes to a row without pressing it", () => {
    const root = rows(3)
    let pressed = false
    root.addEventListener("click", () => (pressed = true))
    goToRow(root, 2)
    expect(document.activeElement?.textContent).toBe("row 3")
    expect(pressed).toBe(false)
  })

  it("answers with digits, Enter and Space, which the arrival guard holds back", () => {
    expect(["1", "9", "Enter", " "].every(answersKey)).toBe(true)
    expect(["ArrowDown", "Escape", "a", "0"].some(answersKey)).toBe(false)
  })
})
