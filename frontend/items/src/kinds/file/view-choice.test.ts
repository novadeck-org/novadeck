import type { ItemId } from "@novadeck/core/items"
import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../../test"
import { openOnSource, useFileView, type FileView } from "./view-choice"

afterEach(() => vi.useRealTimers())

const id = (name: string) => name as unknown as ItemId

// What a file viewer of item `item` showing `path` reads, once it mounts.
const showing = (item: ItemId, path: string): FileView => {
  let view: FileView = "preview"
  const Probe = () => {
    view = useFileView(item, path)[0]
    return null
  }
  render(createElement(Probe)).unmount()
  return view
}

describe("opening an item on its source", () => {
  it("takes effect for the viewer that shows the item next, and stays the choice", () => {
    openOnSource(id("fresh"))
    expect(showing(id("fresh"), "/a.md")).toBe("source")
    expect(showing(id("fresh"), "/a.md")).toBe("source")
  })

  it("lapses, so an item that never took it up isn't switched unasked later", () => {
    vi.useFakeTimers()
    openOnSource(id("slow"))
    vi.advanceTimersByTime(60_000)
    vi.useRealTimers()
    expect(showing(id("slow"), "/b.md")).toBe("preview")
    // And once seen, it is gone: another file of the item opens on its preview.
    expect(showing(id("slow"), "/c.md")).toBe("preview")
  })

  it("is used once: the item's next file opens on its preview", () => {
    openOnSource(id("once"))
    expect(showing(id("once"), "/d.md")).toBe("source")
    expect(showing(id("once"), "/e.md")).toBe("preview")
  })
})
