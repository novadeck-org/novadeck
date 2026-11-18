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
