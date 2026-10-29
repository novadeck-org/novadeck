import { createPageSights, type PageSight } from "./page-sights"
import { describe, expect, it } from "./test"

const sight: PageSight = async () => undefined

describe("the sights of the pages in the panes", () => {
  it("lists an item's live viewers, the latest first, until each is gone", () => {
    const sights = createPageSights()
    const older = sight
    const newer: PageSight = async () => undefined
    const stopOlder = sights.register("item", older)
    const stopNewer = sights.register("item", newer)
    expect(sights.of("item")).toEqual([newer, older])
    expect(sights.of("other")).toEqual([])
    stopNewer()
    expect(sights.of("item")).toEqual([older])
    stopOlder()
    expect(sights.of("item")).toEqual([])
  })

  it("keeps what each page lays out as, a desktop's unless the person switched it", () => {
    const sights = createPageSights()
    expect(sights.layout("item")).toBe("desktop")
    sights.setLayout("item", "phone")
    expect(sights.layout("item")).toBe("phone")
    expect(sights.layout("other")).toBe("desktop")
  })
})
