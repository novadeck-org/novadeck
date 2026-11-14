import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../../../test"
import { FilePreview } from "./FilePreview"
import type { Agent } from "./layout"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const main = Array.from({ length: 12 }, (_, at) => `line ${at + 1}`).join("\n") + "\n"
const agent = (key: string, changedAt: number, hunks: Agent["hunks"]): Agent => ({
  key,
  handle: key,
  label: `@${key}`,
  status: "modified",
  changedAt,
  hunks,
})
const moth = agent("moth", 1, [{ at: 3, removed: 1, lines: ["moth's three"], applies: true }])
const crow = agent("crow", 2, [{ at: 3, removed: 1, lines: ["crow's three"], applies: true }])
const owl = agent("owl", 3, [{ at: 8, removed: 1, lines: ["owl's eight"], applies: false }])

const shown = async (
  agents: readonly Agent[],
  lit: readonly string[] = [],
  writing: readonly string[] = [],
) => {
  const page = render(
    createElement(FilePreview, {
      path: "src/a.ts",
      main,
      agents,
      lit: new Set(lit),
      writing: new Set(writing),
    }),
  )
  unmounts.push(page.unmount)
  await act(async () => {
    await vi.dynamicImportSettled()
  })
  return page.container
}

const texts = (root: HTMLElement) =>
  [...root.querySelectorAll(".diff-row")].map(
    (row) => row.querySelector(".changes-text")?.textContent,
  )

describe("a file's preview", () => {
  it("names the folder and file, says it is a preview, and holds the merge set", async () => {
    const root = await shown([moth, crow])
    expect(root.querySelector(".changes-crumbs")?.textContent).toBe("src/a.tspreview")
    expect(root.querySelector(".preview-summary")?.textContent).toContain(
      "main + @moth + @crow merged",
    )
  })

  context("with two agents changing the same line", () => {
    it("shows the last writer's version under a clash head, and the picked one until someone writes", async () => {
      const root = await shown([moth, crow])
      expect(texts(root)).toContain("crow's three")
      expect(texts(root)).not.toContain("moth's three")
      expect(root.querySelector("[data-clash] .changes-hunk-head")?.textContent).toContain("Clash")
      const pick = [...root.querySelectorAll<HTMLButtonElement>(".preview-pick")].find(
        (button) => button.textContent === "@moth",
      )!
      act(() => pick.click())
      expect(texts(root)).toContain("moth's three")
      const untouched = [...root.querySelectorAll<HTMLButtonElement>(".preview-pick")].find(
        (button) => button.textContent === "main",
      )!
      act(() => untouched.click())
      expect(texts(root)).toContain("line 3")
      expect(texts(root)).not.toContain("crow's three")
    })

    it("leaves out an agent that is toggled off, which is no clash then", async () => {
      const root = await shown([moth, crow])
      const toggle = [...root.querySelectorAll<HTMLButtonElement>(".preview-merge")].find(
        (button) => button.textContent === "@crow",
      )!
      act(() => toggle.click())
      expect(toggle.getAttribute("aria-pressed")).toBe("false")
      expect(texts(root)).toContain("moth's three")
      expect(root.querySelector("[data-clash]")).toBeNull()
    })
  })

  context("with a change that doesn't apply", () => {
    it("keeps main's line, counts the change, and shows its version on request", async () => {
      const root = await shown([owl])
      expect(root.querySelector(".preview-stale-count")?.textContent).toBe("1 change doesn't apply")
      expect(texts(root)).toContain("line 8")
      expect(texts(root)).not.toContain("owl's eight")
      act(() => root.querySelector<HTMLButtonElement>(".preview-stale")!.click())
      expect(texts(root)).toContain("owl's eight")
    })
  })

  it("only dims the runs of agents that are not lit, and puts the cursor of a writing agent after its last line", async () => {
    const root = await shown(
      [moth, owl].map((each) => ({ ...each })),
      ["moth"],
      ["moth"],
    )
    expect(root.querySelector("[data-dim]")).toBeNull()
    const other = await shown([crow], ["moth"])
    expect(other.querySelector("[data-dim]")).not.toBeNull()
    expect(texts(other)).toContain("crow's three")
    expect(root.querySelector(".diff-row .source-cursor")).not.toBeNull()
  })
})
