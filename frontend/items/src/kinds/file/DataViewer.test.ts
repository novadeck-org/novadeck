import type { FileContent, ItemId } from "@novadeck/core/items"
import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../../test"
import { DataViewer, isData } from "./DataViewer"
import type { ToSource } from "./previews"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const fileOf = (
  path: string,
  lines: readonly string[],
  more: Partial<FileContent> = {},
): FileContent => ({
  kind: "file",
  path,
  firstLine: 1,
  lines,
  from: 1,
  to: lines.length,
  total: lines.length,
  clamped: false,
  truncated: false,
  ...more,
})

const shown = (content: FileContent, toSource = vi.fn<ToSource>()) => {
  const { container, unmount } = render(
    createElement(DataViewer, { id: "data" as ItemId, name: content.path, content, toSource }),
  )
  unmounts.push(unmount)
  return { container, toSource }
}

describe("a data file's tree", () => {
  it("reads JSON, JSONL, NDJSON and YAML files, nothing else", () => {
    expect(["a.json", "b.jsonl", "c.ndjson", "d.yaml", "e.yml"].every(isData)).toBe(true)
    expect(isData("notes.md")).toBe(false)
  })

  it("shows a whole file as a tree, with no note", () => {
    const { container } = shown(fileOf("package.json", ['{ "name": "studio" }']))
    expect(container.querySelector(".tree-viewer")).not.toBeNull()
    expect(container.querySelector(".artifact-cut")).toBeNull()
  })

  it("sends a whole file that doesn't read to its source, at the line it stops", () => {
    const { toSource } = shown(fileOf("ci.yml", ["jobs:", "  build:", "    - a", "   b: 1"]))
    expect(toSource).toHaveBeenCalledWith({
      note: expect.stringMatching(/^YAML doesn't read at line \d+, column \d+: .+\.$/),
      line: expect.any(Number),
    })
  })

  it("sends it once per load: shown again, it says where it stops, and offers its source there", () => {
    const content = fileOf("ci.yml", ["jobs:", "  build:", "    - a", "   b: 1"])
    shown(content)
    const { container, toSource } = shown(content)
    expect(toSource).not.toHaveBeenCalled()
    expect(container.textContent).toMatch(/^YAML doesn't read at line \d+/)
    container.querySelector<HTMLButtonElement>(".artifact-open")!.click()
    expect(toSource).toHaveBeenCalledWith({ note: expect.any(String), line: expect.any(Number) })
  })

  context("read only in part", () => {
    it("shows a JSONL file's records read, and says so", () => {
      const { container } = shown(
        fileOf("session.jsonl", ['{"a":1}', '{"b":'], { truncated: true, total: null }),
      )
      expect(container.querySelector(".artifact-cut")?.textContent).toContain(
        "Only its start came, as it's longer than Novadeck reads at once, so some records may be missing.",
      )
    })

    it("says a JSON window can't read as a whole, and offers its source", () => {
      const toSource = vi.fn<ToSource>()
      const { container } = shown(
        fileOf("lock.json", ['    "a": 1,', "  },"], { firstLine: 380, total: 9214 }),
        toSource,
      )
      expect(container.querySelector(".tree-viewer")).toBeNull()
      expect(container.textContent).toContain(
        "Only lines 380–381 of 9214 were read, so the JSON can't be read as a whole.",
      )
      expect(toSource).not.toHaveBeenCalled()
      container.querySelector<HTMLButtonElement>(".artifact-open")!.click()
      expect(toSource).toHaveBeenCalledWith()
    })

    it("reads minified JSON whole, however long its one line", () => {
      const line = `[${'"x",'.repeat(20_000)}"x"]`
      const { container } = shown(fileOf("min.json", [line]))
      expect(container.querySelector(".tree-viewer")).not.toBeNull()
      expect(container.querySelector(".artifact-cut")).toBeNull()
    })

    it("says minified JSON past the runner's budget came only in part, not that it's broken", () => {
      const toSource = vi.fn<ToSource>()
      const line = `[${'"x",'.repeat(2000)}`
      const { container } = shown(
        fileOf("min.json", [line], { truncated: true, total: null }),
        toSource,
      )
      expect(toSource).not.toHaveBeenCalled()
      expect(container.textContent).toContain(
        "Only its start came, as it's longer than Novadeck reads at once, so the JSON can't be read as a whole.",
      )
    })

    it("says how much of a long file's start came", () => {
      const lines = Array.from({ length: 400 }, (_, at) => `k${at}: ${at}`)
      const { container } = shown(fileOf("long.yaml", lines, { total: 1204 }))
      expect(container.querySelector(".artifact-cut")?.textContent).toContain(
        "Only the first 400 lines of 1204 were read, so the tree may be missing some.",
      )
    })

    it("shows a YAML file's start as a tree, saying it may be missing some", () => {
      const { container } = shown(fileOf("big.yaml", ["a: 1"], { truncated: true, total: null }))
      expect(container.querySelector(".tree-viewer")).not.toBeNull()
      expect(container.querySelector(".artifact-cut")?.textContent).toContain("may be missing some")
    })
  })
})
