import type { Companions, FileContent, ItemContent } from "@novadeck/core/items"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { registry } from "../../registry"
import { createItemStore } from "../../store/item-store"
import { context, describe, expect, it } from "../../test"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const target = { projectId: "project", workspaceSessionId: "initial" }

const fileContent = (path: string, lines: readonly string[]): FileContent => ({
  kind: "file",
  path,
  firstLine: 1,
  lines,
  from: 1,
  to: lines.length,
  total: lines.length,
  clamped: false,
  truncated: false,
})

// The file kind's pane body for item `id`, showing `content`.
const show = async (id: string, content: FileContent) => {
  const item = itemFixture(id, "01", { kind: "file", name: content.path, path: content.path })
  const loaded: ItemContent = { state: "ready", stamp: "1", content }
  const companions: Companions = {
    follow: (_target, _id, _options, on) => {
      on(loaded)
      return () => {}
    },
    save: () => new Promise(() => {}),
    trouble: () => {},
  }
  const workspace = createWorkspaceStore(
    workspaceReducer(workspaceFixture(), { type: "item/upsert", target, item }),
  )
  const itemStore = createItemStore({ companions, workspace })
  const disconnect = itemStore.connect()
  const rendered = render(createElement(registry.file.View, { item, itemStore, target }))
  const unmount = (): void => {
    rendered.unmount()
    disconnect()
  }
  unmounts.push(unmount)
  await act(async () => {
    await vi.dynamicImportSettled()
  })
  const switcher = () =>
    rendered.container.querySelector<HTMLButtonElement>('button[aria-label="Show source"]')
  return { ...rendered, unmount, switcher }
}

const readme = fileContent("docs/README.md", ["# Readme", "", "## Install", "Run it."])

describe("a file with a preview", () => {
  it("shows its preview first, with a switch to its source in the row", async () => {
    const { container, switcher } = await show("readme-1", readme)
    expect(container.querySelector(".artifact-file")?.getAttribute("data-view")).toBe("preview")
    expect(container.querySelector(".document-editor")).not.toBeNull()
    expect(container.querySelector(".code-viewer")).toBeNull()
    expect(switcher()?.getAttribute("aria-pressed")).toBe("false")
  })

  it("shows the bare file in the code viewer, numbered, once switched to its source", async () => {
    const { container, switcher } = await show("readme-2", readme)
    act(() => switcher()!.click())
    expect(container.querySelector(".artifact-file")?.getAttribute("data-view")).toBe("source")
    expect(container.querySelector(".document-editor")).toBeNull()
    const code = container.querySelector(".code-viewer")
    expect(code?.textContent).toContain("# Readme")
    expect(code?.textContent).toContain("## Install")
    expect(switcher()?.getAttribute("aria-pressed")).toBe("true")
    act(() => switcher()!.click())
    expect(container.querySelector(".document-editor")).not.toBeNull()
  })

  it("switches on its key from inside the file, and back, keeping focus in it", async () => {
    const { container } = await show("readme-3", readme)
    const file = container.querySelector<HTMLElement>(".artifact-file")!
    const mac = /Mac|iPhone|iPad/.test(navigator.platform)
    // The key, pressed where focus is.
    const press = () =>
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "V",
          code: "KeyV",
          shiftKey: true,
          ctrlKey: !mac,
          metaKey: mac,
          bubbles: true,
          cancelable: true,
        }),
      )
    act(() => file.focus())
    act(() => void press())
    expect(file.getAttribute("data-view")).toBe("source")
    // Into the code, which goes as the file switches back.
    act(() => container.querySelector<HTMLElement>(".code-viewer")!.focus())
    act(() => void press())
    expect(file.getAttribute("data-view")).toBe("preview")
    expect(file.contains(document.activeElement)).toBe(true)
    act(() => void press())
    expect(file.getAttribute("data-view")).toBe("source")
  })

  context("when its pane is built again", () => {
    it("shows what the person last switched it to", async () => {
      const first = await show("readme-4", readme)
      act(() => first.switcher()!.click())
      act(() => first.unmount())
      const again = await show("readme-4", readme)
      expect(again.container.querySelector(".code-viewer")).not.toBeNull()
      expect(again.switcher()?.getAttribute("aria-pressed")).toBe("true")
    })

    it("opens another file the item is shown on its preview", async () => {
      const first = await show("readme-7", readme)
      act(() => first.switcher()!.click())
      act(() => first.unmount())
      const changelog = fileContent("docs/CHANGELOG.md", ["# Changelog", "", "## 1.0"])
      const again = await show("readme-7", changelog)
      expect(again.container.querySelector(".document-editor")).not.toBeNull()
    })

    it("keeps each item's choice its own", async () => {
      const switched = await show("readme-5", readme)
      act(() => switched.switcher()!.click())
      const other = await show("readme-6", readme)
      expect(other.container.querySelector(".document-editor")).not.toBeNull()
    })
  })
})

describe("a file with no preview", () => {
  it("shows as code, with no switch", async () => {
    const { container, switcher } = await show(
      "main-ts",
      fileContent("src/main.ts", ["export const answer = 42"]),
    )
    expect(container.querySelector(".code-viewer")).not.toBeNull()
    expect(container.querySelector(".artifact-file")).toBeNull()
    expect(switcher()).toBeNull()
  })
})

describe("a CSV file", () => {
  const people = fileContent("data/people.csv", [
    "﻿name,age,city",
    'Ann,34,"Oslo, NO"',
    "Bo,7,Rome",
    "Cy,1200,Bern",
  ])
  // The table's cells by row, header first.
  const cells = (container: HTMLElement) =>
    [...container.querySelectorAll(".artifact-table tr")].map((row) =>
      [...row.querySelectorAll("th, td")].map((cell) => cell.textContent),
    )

  it("shows as a table, its header named by the file's first row, each row led by its line", async () => {
    const { container, switcher } = await show("people-1", people)
    expect(cells(container)).toEqual([
      ["Line", "name", "age", "city"],
      ["2", "Ann", "34", "Oslo, NO"],
      ["3", "Bo", "7", "Rome"],
      ["4", "Cy", "1200", "Bern"],
    ])
    expect(container.querySelector("td[data-numeric]")?.textContent).toBe("34")
    expect(container.querySelector(".artifact-cut")).toBeNull()
    expect(switcher()).not.toBeNull()
  })

  it("sorts by a column from its header: up, down, then as the file has it", async () => {
    const { container } = await show("people-2", people)
    const age = () =>
      [...container.querySelectorAll("thead th")].find((cell) => cell.textContent === "age")!
    const ages = () =>
      cells(container)
        .slice(1)
        .map((row) => row[2])
    act(() => age().querySelector("button")!.click())
    expect(age().getAttribute("aria-sort")).toBe("ascending")
    expect(ages()).toEqual(["7", "34", "1200"])
    act(() => age().querySelector("button")!.click())
    expect(age().getAttribute("aria-sort")).toBe("descending")
    expect(ages()).toEqual(["1200", "34", "7"])
    act(() => age().querySelector("button")!.click())
    expect(age().getAttribute("aria-sort")).toBe("none")
    expect(ages()).toEqual(["34", "7", "1200"])
  })

  it("opens again sorted and scrolled as it was left", async () => {
    const first = await show("people-3", people)
    const scroller = first.container.querySelector<HTMLElement>(".artifact-table-scroll")!
    act(() =>
      first.container.querySelector<HTMLButtonElement>("thead th:nth-child(3) button")!.click(),
    )
    scroller.scrollTop = 120
    act(() => void scroller.dispatchEvent(new Event("scroll")))
    act(() => first.unmount())
    const again = await show("people-3", people)
    expect(again.container.querySelector(".artifact-table-scroll")!.scrollTop).toBe(120)
    expect(again.container.querySelector("thead th:nth-child(3)")!.getAttribute("aria-sort")).toBe(
      "ascending",
    )
  })

  it("shows its raw text once switched to its source", async () => {
    const { container, switcher } = await show("people-4", people)
    act(() => switcher()!.click())
    expect(container.querySelector(".artifact-table")).toBeNull()
    expect(container.querySelector(".code-viewer")?.textContent).toContain('Ann,34,"Oslo, NO"')
  })

  context("when the runner read only part of it", () => {
    it("says so under the table, with which lines", async () => {
      const { container } = await show("people-5", { ...people, total: 12034, to: 4 })
      expect(container.querySelector(".artifact-cut")?.textContent).toBe(
        "Only part of the file is shown: lines 1–4 of 12,034.",
      )
    })

    it("letters its columns where the lines start past the header", async () => {
      const { container } = await show("people-6", {
        ...fileContent("data/people.csv", ["Ann,34", "Bo,7"]),
        firstLine: 960,
        from: 960,
        to: 961,
        total: 5000,
      })
      expect(cells(container)[0]).toEqual(["Line", "A", "B"])
      expect(container.querySelector(".artifact-cut")?.textContent).toContain(
        "without its header row",
      )
    })
  })
})

describe("a TSV file", () => {
  it("splits its columns on tabs", async () => {
    const { container } = await show(
      "tsv-1",
      fileContent("out/scores.tsv", ["team\tscore", "red, blue\t3"]),
    )
    expect(container.querySelector("tbody tr")?.textContent).toBe("2red, blue3")
  })
})
