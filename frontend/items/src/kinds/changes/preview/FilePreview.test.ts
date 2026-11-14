import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../../../test"
import { FilePreview, type Rename } from "./FilePreview"
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
  extra: {
    renames?: readonly Rename[]
    onOpen?: (path: string) => void
    main?: string | null
  } = {},
) => {
  const page = render(
    createElement(FilePreview, {
      path: "src/a.ts",
      main: extra.main === undefined ? main : extra.main,
      agents,
      lit: new Set(lit),
      writing: new Set(writing),
      renames: extra.renames ?? [],
      onOpen: extra.onOpen ?? (() => {}),
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

  it("says what a change does where the file's language says nothing: adds, removes or changes lines", async () => {
    const root = await shown([
      agent("moth", 1, [
        { at: 2, removed: 0, lines: ["new"], applies: true },
        { at: 5, removed: 2, lines: [], applies: true },
        { at: 9, removed: 1, lines: ["nine"], applies: true },
      ]),
    ])
    const heads = [...root.querySelectorAll(".changes-hunk-head .changes-scope")].map(
      (head) => head.textContent,
    )
    expect(heads).toEqual([
      "@moth · adds 1 line",
      "@moth · removes lines 5–6",
      "@moth · changes line 9",
    ])
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

  context("with a file renamed away or added", () => {
    it("says who renames this file and where to, and opens that path from its Open", async () => {
      const opened: string[] = []
      const root = await shown([moth], [], [], {
        renames: [{ label: "@crow", to: "src/b.ts" }],
        onOpen: (path) => opened.push(path),
      })
      const note = root.querySelector(".preview-note")!
      expect(note.textContent).toBe("@crowrenames this file to src/b.tsOpen")
      act(() => note.querySelector("button")!.click())
      expect(opened).toEqual(["src/b.ts"])
    })

    it("heads a file renamed to this path by where it was renamed from", async () => {
      const renamer = { ...agent("crow", 2, []), renamedFrom: "src/a-old.ts" }
      const root = await shown([renamer])
      expect(root.querySelector(".changes-hunk-head")?.textContent).toContain(
        "@crow · renamed from src/a-old.ts",
      )
    })

    it("draws a file main lacks, added by an agent, as added lines under its head", async () => {
      const root = await shown(
        [agent("moth", 1, [{ at: 1, removed: 0, lines: ["one", "two"], applies: true }])],
        [],
        [],
        {
          main: null,
        },
      )
      expect(texts(root)).toEqual(["one", "two"])
      expect(root.querySelectorAll('.diff-row[data-kind="add"]')).toHaveLength(2)
    })
  })
})
