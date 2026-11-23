import { afterEach, vi } from "vitest"

import { fileDropZone, guardFileDrops, type FileDropZone } from "./file-drops"
import { context, describe, expect, it } from "./test"

// What a drag hands the page: its types, the files it carries, and the drop effect the page
// sets, which a real drag keeps.
const carrying = (files: number, types = ["Files"]) => ({
  types,
  items: Array.from({ length: files }, () => ({ kind: "file", type: "text/plain" })),
  files: [],
  dropEffect: "none",
})

const drag = (
  type: string,
  target: EventTarget,
  data: ReturnType<typeof carrying>,
  relatedTarget: EventTarget | null = null,
) => {
  const event = new Event(type, { bubbles: true, cancelable: true, composed: true })
  Object.defineProperty(event, "dataTransfer", { value: data })
  Object.defineProperty(event, "relatedTarget", { value: relatedTarget })
  target.dispatchEvent(event)
  return event
}

// A zone on a new element in the page, recording what it is told.
const zoneOn = (parent: Element = document.body, takes = () => true) => {
  const element = document.createElement("div")
  parent.append(element)
  const told: (number | null)[] = []
  const dropped: unknown[] = []
  const zone: FileDropZone = {
    accepts: takes,
    over: (count) => void told.push(count),
    drop: (data) => void dropped.push(data),
  }
  const undo = fileDropZone(element, zone)
  undos.push(undo)
  return { element, told, dropped, undo }
}

const undos: (() => void)[] = []
afterEach(() => {
  for (const undo of undos.splice(0)) undo()
  document.body.replaceChildren()
})

describe("files dragged onto the page", () => {
  context("over a zone that takes them", () => {
    it("lets them be dropped as a copy, and tells the zone how many, once", () => {
      const { element, told } = zoneOn()
      const data = carrying(2)

      const over = drag("dragover", element, data)
      drag("dragover", element, data)

      expect(over.defaultPrevented).toBe(true)
      expect(data.dropEffect).toBe("copy")
      expect(told).toEqual([2])
    })

    it("hands the zone the drop, and tells it they're no longer over it", () => {
      const { element, told, dropped } = zoneOn()
      const data = carrying(1)

      drag("dragover", element, data)
      const drop = drag("drop", element, data)

      expect(drop.defaultPrevented).toBe(true)
      expect(dropped).toEqual([data])
      expect(told).toEqual([1, null])
    })

    it("tells it they left once the pointer leaves the page", () => {
      const { element, told } = zoneOn()
      const data = carrying(1)

      drag("dragover", element, data)
      drag("dragleave", element, data)

      expect(told).toEqual([1, null])
    })

    it("keeps them over it while the pointer moves between its parts", () => {
      vi.useFakeTimers()
      try {
        const { element, told } = zoneOn()
        const part = document.createElement("span")
        element.append(part)
        const data = carrying(1)

        drag("dragover", element, data)
        // The browser enters where the pointer went before it leaves where it was.
        drag("dragenter", part, data)
        drag("dragleave", element, data)

        expect(told).toEqual([1])
      } finally {
        vi.runOnlyPendingTimers()
        vi.useRealTimers()
      }
    })
    it("keeps them over it while the browser names where in it the pointer went", () => {
      const { element, told } = zoneOn()
      const part = document.createElement("span")
      element.append(part)
      const data = carrying(1)

      drag("dragover", element, data)
      drag("dragleave", element, data, part)

      expect(told).toEqual([1])
    })

    it("tells it they left once the pointer goes into a frame, which the page hears no more of", () => {
      for (const kind of ["iframe", "webview"]) {
        const { element, told } = zoneOn()
        const frame = document.createElement(kind)
        element.append(frame)
        const data = carrying(1)

        drag("dragover", element, data)
        drag("dragleave", element, data, frame)

        expect(told).toEqual([1, null])
      }
    })

    it("tells it they left as it is undone while they are over it", () => {
      const { element, told, undo } = zoneOn()

      drag("dragover", element, carrying(1))
      undo()

      expect(told).toEqual([1, null])
    })
  })

  context("over a zone inside another", () => {
    it("tells the inner zone alone, and the outer once the pointer is back over it", () => {
      const outer = zoneOn()
      const inner = zoneOn(outer.element)
      const data = carrying(1)

      drag("dragover", outer.element, data)
      drag("dragover", inner.element, data)
      drag("dragover", outer.element, data)
      drag("drop", outer.element, data)

      expect(outer.told).toEqual([1, null, 1, null])
      expect(inner.told).toEqual([1, null])
      expect(outer.dropped).toEqual([data])
      expect(inner.dropped).toEqual([])
    })
  })

  context("over a zone that doesn't take them now", () => {
    it("shows they can't be dropped there, and a drop does nothing", () => {
      const { element, told, dropped } = zoneOn(document.body, () => false)
      const data = carrying(1)

      const over = drag("dragover", element, data)
      const drop = drag("drop", element, data)

      expect(over.defaultPrevented).toBe(true)
      expect(data.dropEffect).toBe("none")
      expect(drop.defaultPrevented).toBe(true)
      expect(told).toEqual([])
      expect(dropped).toEqual([])
    })
  })

  context("off every zone", () => {
    it("never lets the browser open the file in place of the page", () => {
      guardFileDrops()
      const zone = zoneOn()
      const data = carrying(1)

      drag("dragover", zone.element, data)
      const over = drag("dragover", document.body, data)
      const drop = drag("drop", document.body, data)

      expect(over.defaultPrevented).toBe(true)
      expect(data.dropEffect).toBe("none")
      expect(drop.defaultPrevented).toBe(true)
      expect(zone.told).toEqual([1, null])
      expect(zone.dropped).toEqual([])
    })
  })

  context("carrying no files", () => {
    it("leaves the drag to the page, zone or not", () => {
      const { element, told } = zoneOn()
      const data = carrying(0, ["text/plain"])

      const over = drag("dragover", element, data)
      const drop = drag("drop", element, data)

      expect(over.defaultPrevented).toBe(false)
      expect(drop.defaultPrevented).toBe(false)
      expect(told).toEqual([])
    })
  })

  context("once a zone is undone", () => {
    it("takes nothing more there", () => {
      const { element, told, undo } = zoneOn()
      undo()

      drag("dragover", element, carrying(1))

      expect(told).toEqual([])
    })
  })
})
