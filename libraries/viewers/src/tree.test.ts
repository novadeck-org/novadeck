import "./tree.css"
import { afterEach, describe as context, describe, expect, it } from "vitest"

import type { Viewer } from "./index.js"
import { mountTree, parseData, type DataRoot, type TreeContent } from "./tree.js"

const panes: HTMLElement[] = []
afterEach(() => {
  for (const pane of panes.splice(0)) pane.remove()
})

const paneIn = (): HTMLElement => {
  const pane = document.createElement("div")
  pane.style.cssText = "display: flex; flex-direction: column; height: 220px; width: 480px"
  document.body.append(pane)
  panes.push(pane)
  return pane
}

const rootsOf = (text: string, format: "json" | "jsonl" | "yaml"): readonly DataRoot[] => {
  const parsed = parseData(text, format)
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.roots
}

const treeOf = (pane: HTMLElement): HTMLElement => pane.querySelector(".tree-viewer")!
const rowsOf = (pane: HTMLElement): HTMLElement[] => [
  ...pane.querySelectorAll<HTMLElement>(".tree-row"),
]
// Each drawn row's text, without its copy buttons.
const textsOf = (pane: HTMLElement): string[] =>
  rowsOf(pane).map((row) =>
    [...row.children]
      .filter((child) => !child.classList.contains("tree-actions"))
      .map((child) => child.textContent)
      .join(""),
  )
const rowNamed = (pane: HTMLElement, name: string): HTMLElement =>
  rowsOf(pane).find(
    (row) => row.querySelector(".tree-key, .tree-label, .tree-index")?.textContent === name,
  )!

const mount = (
  content: TreeContent,
  pane = paneIn(),
  copied: string[] = [],
  saved?: ReturnType<Viewer<TreeContent>["state"]>,
): Viewer<TreeContent> =>
  mountTree(pane, {
    content,
    label: "data.json",
    copy: (text) => void copied.push(text),
    ...(saved ? { saved } : {}),
  })

const key = (pane: HTMLElement, name: string, init: KeyboardEventInit = {}): void => {
  treeOf(pane).dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, ...init }))
}

describe("the tree viewer", () => {
  it("shows an object's keys, the first level open, values coloured by type", () => {
    const pane = paneIn()
    mount(
      { roots: rootsOf('{"name":"app","tags":["a"],"n":2,"ok":true,"none":null}', "json") },
      pane,
    )
    expect(treeOf(pane).getAttribute("role")).toBe("tree")
    expect(textsOf(pane)).toEqual([
      'name: "app"',
      "tags: 1 item",
      '0: "a"',
      "n: 2",
      "ok: true",
      "none: null",
    ])
    const types = [...pane.querySelectorAll<HTMLElement>(".tree-value")].map(
      (value) => value.dataset["type"],
    )
    expect(types).toEqual(["string", "string", "number", "boolean", "null"])
  })

  it("shows a closed node's first entries and how many it holds", () => {
    const pane = paneIn()
    mount({ roots: rootsOf('{"a":{"b":{"c":1,"d":[1,2]}}}', "json") }, pane)
    expect(textsOf(pane)).toEqual(["a: 1 key", "b: {c: 1, d: […]}2 keys"])
    expect(rowNamed(pane, "b").getAttribute("aria-expanded")).toBe("false")
  })

  it("opens and closes a node on a click", () => {
    const pane = paneIn()
    mount({ roots: rootsOf('{"a":{"b":{"c":1}}}', "json") }, pane)
    rowNamed(pane, "b").click()
    expect(textsOf(pane)).toEqual(["a: 1 key", "b: 1 key", "c: 1"])
    rowNamed(pane, "a").click()
    expect(textsOf(pane)).toEqual(["a: {b: {…}}1 key"])
  })

  context("JSONL", () => {
    const records = '{"type":"user","text":"hi"}\n{"type":\n{"type":"assistant"}\n'

    it("shows one closed row per record, a broken one with why", () => {
      const pane = paneIn()
      mount({ roots: rootsOf(records, "jsonl"), opening: { roots: false } }, pane)
      expect(textsOf(pane)).toEqual([
        'Line 1 {type: "user", text: "hi"}2 keys',
        'Line 2 Expected a value, found the end, at column 9"{\\"type\\":"',
        'Line 3 {type: "assistant"}1 key',
      ])
      expect(rowsOf(pane)[1]!.hasAttribute("data-broken")).toBe(true)
    })
  })

  context("YAML", () => {
    it("shows each document as a row of its own, open", () => {
      const pane = paneIn()
      mount({ roots: rootsOf("a: 1\n---\nb: 2\n", "yaml") }, pane)
      expect(textsOf(pane)).toEqual(["Document 1 1 key", "a: 1", "Document 2 1 key", "b: 2"])
    })
  })

  context("with thousands of nodes", () => {
    const many = JSON.stringify(Array.from({ length: 3000 }, (_, at) => ({ id: at })))

    it("draws only the rows in sight, and others as it scrolls", async () => {
      const pane = paneIn()
      const viewer = mount({ roots: rootsOf(many, "json") }, pane)
      expect(rowsOf(pane).length).toBeLessThan(60)
      const tree = treeOf(pane)
      tree.scrollTop = tree.scrollHeight / 2
      tree.dispatchEvent(new Event("scroll"))
      await expect.poll(() => textsOf(pane).some((text) => text.startsWith("1500:"))).toBe(true)
      viewer.destroy()
    })
  })

  context("by keyboard", () => {
    it("moves down and up, opens with right, closes and climbs with left", () => {
      const pane = paneIn()
      mount({ roots: rootsOf('{"a":{"b":{"c":1}},"d":1}', "json") }, pane)
      const active = () => pane.querySelector('[aria-selected="true"] .tree-key')?.textContent
      key(pane, "ArrowDown")
      expect(active()).toBe("a")
      key(pane, "ArrowDown")
      expect(active()).toBe("b")
      key(pane, "ArrowRight")
      expect(textsOf(pane)).toContain("c: 1")
      key(pane, "ArrowRight")
      expect(active()).toBe("c")
      key(pane, "ArrowLeft")
      expect(active()).toBe("b")
      key(pane, "ArrowLeft")
      expect(textsOf(pane)).not.toContain("c: 1")
      key(pane, "End")
      expect(active()).toBe("d")
      expect(treeOf(pane).getAttribute("aria-activedescendant")).toBe(
        pane.querySelector('[aria-selected="true"]')!.id,
      )
    })

    it("copies the active row's value, or with Shift its path", () => {
      const pane = paneIn()
      const copied: string[] = []
      mount({ roots: rootsOf('{"items":[{"name":"x"}]}', "json") }, pane, copied)
      key(pane, "End")
      key(pane, "ArrowRight")
      key(pane, "End")
      key(pane, "c", { ctrlKey: true })
      key(pane, "c", { ctrlKey: true, shiftKey: true })
      expect(copied).toEqual(["x", ".items[0].name"])
    })
  })

  it("copies a value or its path from the row's buttons, and says so", async () => {
    const pane = paneIn()
    const copied: string[] = []
    mount({ roots: rootsOf('{"a":{"b":[1]}}', "json") }, pane, copied)
    const row = rowNamed(pane, "b")
    row.querySelector<HTMLElement>('[data-action="value"]')!.click()
    row.querySelector<HTMLElement>('[data-action="path"]')!.click()
    expect(copied).toEqual(["[\n  1\n]", ".a.b"])
    await expect
      .poll(() => rowNamed(pane, "b").querySelector("[data-copied]")?.textContent)
      .toBe("Copied")
  })

  context("shown again", () => {
    it("opens as it was left: what's open, the active row and the scroll", async () => {
      const content = {
        roots: rootsOf(
          JSON.stringify({ list: Array.from({ length: 80 }, (_, at) => ({ at })) }),
          "json",
        ),
        path: "a.json",
      }
      const pane = paneIn()
      const viewer = mount(content, pane)
      rowNamed(pane, "list").click()
      rowNamed(pane, "list").click()
      key(pane, "ArrowDown")
      treeOf(pane).scrollTop = 300
      const state = viewer.state()
      viewer.destroy()
      const again = paneIn()
      mount(content, again, [], state)
      await expect.poll(() => treeOf(again).scrollTop).toBe(300)
      expect(again.querySelector('[aria-selected="true"]')).not.toBeNull()
    })

    it("opens another file as its own defaults say", () => {
      const pane = paneIn()
      const viewer = mount({ roots: rootsOf('{"a":{"b":1}}', "json"), path: "a.json" }, pane)
      rowNamed(pane, "a").click()
      const state = viewer.state()
      viewer.destroy()
      const again = paneIn()
      mount({ roots: rootsOf('{"a":{"b":1}}', "json"), path: "b.json" }, again, [], state)
      expect(textsOf(again)).toEqual(["a: 1 key", "b: 1"])
    })

    it("keeps what's open as the file changes", () => {
      const pane = paneIn()
      const viewer = mount({ roots: rootsOf('{"a":{"b":{"c":1}}}', "json"), path: "a.json" }, pane)
      rowNamed(pane, "b").click()
      viewer.update({ roots: rootsOf('{"a":{"b":{"c":2}}}', "json"), path: "a.json" })
      expect(textsOf(pane)).toEqual(["a: 1 key", "b: 1 key", "c: 2"])
    })
  })
})
