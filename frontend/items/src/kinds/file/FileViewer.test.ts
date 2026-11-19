import type { Companions, FileContent, ItemContent } from "@novadeck/core/items"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { PaneChrome } from "../../pane-row"
import { registry } from "../../registry"
import { createItemStore } from "../../store/item-store"
import { context, describe, expect, it } from "../../test"
import { FileThumb } from "./FileViewer"

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

// The file kind's pane body for item `id`, showing `content`: alone, or, `inRow`, under the
// pane's row, where its tools are drawn.
const show = async (id: string, content: FileContent, { inRow = false } = {}) => {
  const item = itemFixture(id, "01", { kind: "file", name: content.path, path: content.path })
  const loaded: ItemContent = { state: "ready", stamp: "1", content }
  // Hands the item the file as it is now, as the runner does once it changes.
  let push: ((content: ItemContent) => void) | undefined
  const companions: Companions = {
    follow: (_target, _id, _options, on) => {
      push = on
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
  const body = createElement(registry.file.View, { item, itemStore, target })
  const rendered = render(inRow ? createElement(PaneChrome, { renderRow: () => null }, body) : body)
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
  const load = (next: FileContent): void =>
    act(() => push?.({ state: "ready", stamp: String(Math.random()), content: next }))
  return { ...rendered, unmount, switcher, load }
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

  context("under the pane's row, where its switch is drawn", () => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform)
    const key = (repeat = false, { typed = "V", code = "KeyV" } = {}) =>
      new KeyboardEvent("keydown", {
        key: typed,
        code,
        shiftKey: true,
        ctrlKey: !mac,
        metaKey: mac,
        repeat,
        bubbles: true,
        cancelable: true,
      })

    it("draws the switch in the row, which switches the file below it", async () => {
      const { container, switcher } = await show("row-1", readme, { inRow: true })
      expect(switcher()?.closest(".pane-row")).not.toBeNull()
      expect(switcher()?.closest(".artifact-file")).toBeNull()
      act(() => switcher()!.click())
      expect(container.querySelector(".artifact-file")?.getAttribute("data-view")).toBe("source")
    })

    it("switches on the key pressed on the switch, which keeps focus", async () => {
      const { container, switcher } = await show("row-2", readme, { inRow: true })
      act(() => switcher()!.focus())
      act(() => void switcher()!.dispatchEvent(key()))
      expect(container.querySelector(".artifact-file")?.getAttribute("data-view")).toBe("source")
      expect(document.activeElement).toBe(switcher())
    })

    it("switches on the letter V, wherever a Latin layout puts it", async () => {
      const { container } = await show("row-5", readme, { inRow: true })
      const file = container.querySelector<HTMLElement>(".artifact-file")!
      act(() => file.focus())
      // Dvorak's V sits where QWERTY's period is; QWERTY's V there types K.
      act(() => void file.dispatchEvent(key(false, { typed: "k", code: "KeyV" })))
      expect(file.getAttribute("data-view")).toBe("preview")
      act(() => void file.dispatchEvent(key(false, { typed: "v", code: "Period" })))
      expect(file.getAttribute("data-view")).toBe("source")
    })

    it("switches on the V key where the layout types another script", async () => {
      const { container } = await show("row-6", readme, { inRow: true })
      const file = container.querySelector<HTMLElement>(".artifact-file")!
      act(() => file.focus())
      act(() => void file.dispatchEvent(key(false, { typed: "м", code: "KeyV" })))
      expect(file.getAttribute("data-view")).toBe("source")
    })

    it("switches once for a key held down", async () => {
      const { container } = await show("row-3", readme, { inRow: true })
      const file = container.querySelector<HTMLElement>(".artifact-file")!
      act(() => file.focus())
      act(() => void file.dispatchEvent(key()))
      act(() => void file.dispatchEvent(key(true)))
      act(() => void file.dispatchEvent(key(true)))
      expect(file.getAttribute("data-view")).toBe("source")
    })

    it("names the file, and what it shows now, to assistive technology", async () => {
      const { container, switcher } = await show("row-4", readme, { inRow: true })
      const file = () => container.querySelector(".artifact-file")!
      expect(file().getAttribute("role")).toBe("region")
      expect(file().getAttribute("aria-label")).toBe("docs/README.md, preview")
      act(() => switcher()!.click())
      expect(file().getAttribute("aria-label")).toBe("docs/README.md, source")
    })
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

describe("a CSV file the agent pointed into", () => {
  it("marks the row a pointed line falls in, though the row starts above it", async () => {
    const lines = ["id,text", '1,"one', "two", 'three"', "2,x", "3,y"]
    const { container } = await show("pointed-1", {
      ...fileContent("notes.csv", lines),
      from: 3,
      to: 3,
    })
    const marked = [...container.querySelectorAll("tbody tr[data-pointed]")]
    expect(marked.map((row) => row.getAttribute("data-line"))).toEqual(["2"])
  })

  it("says so when the lines pointed at are past the file's end", async () => {
    const lines = ["id,n", "1,2", "3,4"]
    const { container } = await show("pointed-2", {
      ...fileContent("short.csv", lines),
      from: 3,
      to: 3,
      clamped: true,
    })
    expect(container.querySelector(".artifact-cut")?.textContent).toBe(
      "The lines pointed at are past its end, line 3.",
    )
  })
})

describe("a CSV file with a long cell", () => {
  const notes = fileContent("data/notes.csv", ["id,note", `1,${"word ".repeat(400)}`, "2,short"])
  // A held cell runs past its first lines, as the stylesheet clamps it; the unit tests lay
  // nothing out.
  const overflowing = (): void => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function scroll(
      this: HTMLElement,
    ) {
      return this.dataset.held === undefined ? 0 : 400
    })
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(120)
  }
  const note = (container: HTMLElement) =>
    container.querySelector('tr[data-line="2"] td:nth-of-type(2) > span')!
  const more = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>(".artifact-table-more")

  it("holds it to its first lines, with a button that shows it whole and back", async () => {
    overflowing()
    const { container } = await show("notes-1", notes)
    expect(note(container).hasAttribute("data-held")).toBe(true)
    const short = container.querySelector('tr[data-line="3"] td:nth-of-type(2) > span')!
    expect(short.hasAttribute("data-held")).toBe(false)
    expect(container.querySelectorAll(".artifact-table-more")).toHaveLength(1)
    expect(more(container)?.textContent).toBe("Show all")
    expect(more(container)?.getAttribute("aria-label")).toBe("Show all of note, line 2")
    expect(more(container)?.getAttribute("aria-expanded")).toBe("false")
    act(() => more(container)!.click())
    expect(note(container).hasAttribute("data-held")).toBe(false)
    expect(more(container)?.textContent).toBe("Show less")
    expect(more(container)?.getAttribute("aria-expanded")).toBe("true")
    act(() => more(container)!.click())
    expect(note(container).hasAttribute("data-held")).toBe(true)
  })

  it("offers no button where a long cell fits its lines", async () => {
    const { container } = await show("notes-2", notes)
    expect(note(container).hasAttribute("data-held")).toBe(true)
    expect(more(container)).toBeNull()
  })

  it("keeps a cell shown whole when its pane is built again", async () => {
    overflowing()
    const first = await show("notes-3", notes)
    act(() => more(first.container)!.click())
    act(() => first.unmount())
    const { container } = await show("notes-3", notes)
    expect(note(container).hasAttribute("data-held")).toBe(false)
    expect(more(container)?.textContent).toBe("Show less")
  })
})

describe("a long CSV file", () => {
  const long = fileContent("data/long.csv", [
    "id,score",
    ...Array.from({ length: 5000 }, (_, at) => `${at + 1},${(at * 7919) % 10007}`),
  ])

  it("draws only the rows in view, and says how many it has", async () => {
    const { container } = await show("long-1", long)
    const drawn = container.querySelectorAll("tbody tr[data-line]")
    expect(drawn.length).toBeGreaterThan(10)
    expect(drawn.length).toBeLessThan(200)
    expect(container.querySelector("table")?.getAttribute("aria-rowcount")).toBe("5001")
    expect(drawn[0]?.getAttribute("aria-rowindex")).toBe("2")
  })

  it("sorts all its rows, not only those drawn", async () => {
    const { container } = await show("long-2", long)
    act(() => container.querySelector<HTMLButtonElement>("thead th:nth-child(3) button")!.click())
    act(() => container.querySelector<HTMLButtonElement>("thead th:nth-child(3) button")!.click())
    const scores = long.lines.slice(1).map((line) => Number(line.split(",")[1]))
    expect(container.querySelector("tbody tr[data-line] td:nth-of-type(2)")?.textContent).toBe(
      String(Math.max(...scores)),
    )
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

describe("a data file", () => {
  const compose = fileContent("compose.yaml", ["services:", "  web:", "    image: node"])
  // A new load each time: one already sent to its source isn't sent again.
  const broken = (): FileContent =>
    fileContent("ci.yml", ["jobs:", "  build:", "    - a", "   b: 1"])

  it("shows a tree first, with the switch to its source", async () => {
    const { container, switcher } = await show("compose-1", compose)
    expect(container.querySelector(".artifact-file")?.getAttribute("data-file-preview")).toBe(
      "data",
    )
    expect(container.querySelector(".tree-viewer")).not.toBeNull()
    expect(switcher()?.getAttribute("aria-pressed")).toBe("false")
  })

  it("goes to its source when it doesn't read, saying where, with that line pointed at", async () => {
    const { container, switcher } = await show("broken-1", broken())
    expect(container.querySelector(".artifact-file")?.getAttribute("data-view")).toBe("source")
    const note = container.querySelector(".artifact-source-note")?.textContent ?? ""
    expect(note).toMatch(/^YAML doesn't read at line (\d+)/)
    const line = Number(/line (\d+)/.exec(note)![1])
    const pointed = [...container.querySelectorAll(".code-viewer > [data-emphasized]")]
    expect(pointed.map((row) => row.firstElementChild?.textContent)).toEqual([String(line)])
    expect(switcher()?.getAttribute("aria-pressed")).toBe("true")
  })

  it("previews again once the file reads, its source not kept as the person's choice", async () => {
    const { container, load } = await show("broken-3", broken())
    expect(container.querySelector(".artifact-file")?.getAttribute("data-view")).toBe("source")
    load(fileContent("ci.yml", ["jobs:", "  build:", "    runs-on: ubuntu-latest"]))
    expect(container.querySelector(".artifact-file")?.getAttribute("data-view")).toBe("preview")
    expect(container.querySelector(".artifact-source-note")).toBeNull()
    expect(container.querySelector(".tree-viewer")).not.toBeNull()
  })

  it("stays on its source when its pane is built again, as across views", async () => {
    const content = broken()
    const first = await show("broken-4", content)
    expect(first.container.querySelector(".artifact-file")?.getAttribute("data-view")).toBe(
      "source",
    )
    first.unmount()
    const { container } = await show("broken-4", content)
    expect(container.querySelector(".artifact-file")?.getAttribute("data-view")).toBe("source")
    expect(container.querySelector(".artifact-source-note")).not.toBeNull()
  })

  it("opens a JSONL file at the record its agent pointed at", async () => {
    const lines = Array.from({ length: 300 }, (_, at) => JSON.stringify({ at }))
    const { container } = await show("records-1", {
      ...fileContent("events.jsonl", lines),
      from: 250,
      to: 250,
    })
    await expect
      .poll(
        () => container.querySelector('.tree-row[aria-selected="true"] .tree-label')?.textContent,
      )
      .toBe("Line 250")
  })

  it("switched back to the preview, says where it stops instead of going again", async () => {
    const { container, switcher } = await show("broken-2", broken())
    act(() => switcher()!.click())
    expect(container.querySelector(".artifact-file")?.getAttribute("data-view")).toBe("preview")
    expect(container.querySelector(".artifact-source-note")).toBeNull()
    expect(container.querySelector(".artifact-unavailable")?.textContent).toMatch(
      /^YAML doesn't read at line \d+/,
    )
  })
})

describe("a long file's source", () => {
  it("draws the lines around the one pointed at, and says which", async () => {
    const lines = Array.from({ length: 5000 }, (_, at) => `k${at + 1}: ${at + 1}`)
    // A key with no value's indent past it: YAML stops reading there.
    lines[2999] = "   bad: [1"
    const { container } = await show("long-yaml", fileContent("long.yaml", lines))
    expect(container.querySelector(".artifact-file")?.getAttribute("data-view")).toBe("source")
    const rows = [...container.querySelectorAll(".code-viewer > div")]
    expect(rows).toHaveLength(2000)
    const first = Number(rows[0]!.firstElementChild?.textContent)
    const pointed = container.querySelector(".code-viewer > [data-emphasized]")
    const line = Number(pointed?.firstElementChild?.textContent)
    expect(line - first).toBe(40)
    expect(container.querySelector(".artifact-cut:not(.artifact-source-note)")?.textContent).toBe(
      `Lines ${first}–${first + 1999} of the 5000 read are shown here.`,
    )
  })
})

describe("a long file's miniature", () => {
  it("shows no more than its first pointed lines, each cut short", () => {
    const lines = Array.from({ length: 5000 }, () => "x".repeat(10_000))
    const content = fileContent("big.jsonl", lines)
    const { container, unmount } = render(createElement(FileThumb, { content }))
    unmounts.push(unmount)
    const shown = container.querySelector(".peek-code")?.textContent ?? ""
    expect(shown.split("\n")).toHaveLength(40)
    expect(shown.length).toBeLessThan(40 * 201)
  })
})
