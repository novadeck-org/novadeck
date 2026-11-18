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
