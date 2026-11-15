import { render } from "@novadeck/test-kit/render"
import { act, createElement, useState } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import {
  createPanePictures,
  firstMs,
  freshenMs,
  keptMost,
  leftMs,
  pageLook,
  PanePicturesContext,
  sketchedAttribute,
  usePanePicture,
  type PanePicture,
  type PanePictures,
  type Shoot,
} from "./pane-pictures"
import { context, describe, expect, it } from "./test"

afterEach(() => document.documentElement.removeAttribute(sketchedAttribute))

// An element drawn at `rect`, on top wherever it is unless `covered`.
const drawn = (
  rect = { left: 10, top: 20, width: 300, height: 200 },
  { covered = false, size = { width: 300, height: 200 } } = {},
) => {
  const element = document.createElement("div")
  document.body.append(element)
  const box = {
    ...rect,
    x: rect.left,
    y: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
  }
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ ...box, toJSON: () => box })
  Object.defineProperty(element, "offsetWidth", { value: size.width })
  Object.defineProperty(element, "offsetHeight", { value: size.height })
  const other = document.createElement("div")
  Object.assign(document, {
    elementFromPoint: () => (covered ? other : element),
  })
  return element
}

describe("a picture of a pane", () => {
  afterEach(() => {
    document.body.replaceChildren()
    Reflect.deleteProperty(document, "elementFromPoint")
  })

  it("is of where it's drawn, at the size it's laid out at", async () => {
    const asked: unknown[] = []
    const pictures = createPanePictures(async (rect) => {
      asked.push(rect)
      return "data:image/jpeg;base64,AAAA"
    })
    // As a Canvas zoomed out draws it at half its size.
    const element = drawn(
      { left: 10, top: 20, width: 150, height: 100 },
      { size: { width: 300, height: 200 } },
    )
    const picture = await pictures.take(element)
    expect(asked).toEqual([{ x: 10, y: 20, width: 150, height: 100 }])
    expect(picture?.image.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA")
    expect([picture?.width, picture?.height]).toEqual([300, 200])
    expect(picture?.look).toBe(pageLook())
  })

  it("is none where it isn't wholly in the window", async () => {
    const shoot = vi.fn<Shoot>(async () => "data:image/jpeg;base64,AAAA")
    const pictures = createPanePictures(shoot)
    const rects = [
      { left: -5, top: 20, width: 300, height: 200 },
      { left: 10, top: 20, width: window.innerWidth, height: 200 },
      { left: 10, top: 20, width: 0, height: 200 },
    ]
    const taken = await Promise.all(rects.map((rect) => pictures.take(drawn(rect))))
    expect(taken).toEqual(rects.map(() => undefined))
    expect(shoot).not.toHaveBeenCalled()
  })

  it("is none where something covers it, as a dialog or another tile", async () => {
    const shoot = vi.fn<Shoot>(async () => "data:image/jpeg;base64,AAAA")
    expect(
      await createPanePictures(shoot).take(drawn(undefined, { covered: true })),
    ).toBeUndefined()
    expect(shoot).not.toHaveBeenCalled()
  })

  it("is none where a menu or tooltip floats over it from outside", async () => {
    const shoot = vi.fn<Shoot>(async () => "data:image/jpeg;base64,AAAA")
    const element = drawn()
    const menu = document.createElement("div")
    menu.setAttribute("role", "menu")
    document.body.append(menu)
    const box = { left: 250, top: 150, width: 120, height: 90, right: 370, bottom: 240 }
    vi.spyOn(menu, "getBoundingClientRect").mockReturnValue({
      ...box,
      x: box.left,
      y: box.top,
      toJSON: () => box,
    })
    expect(await createPanePictures(shoot).take(element)).toBeUndefined()
    expect(shoot).not.toHaveBeenCalled()
  })

  it("is none where it moved while it was taken, as a pan moves it", async () => {
    const element = drawn()
    const pictures = createPanePictures(async () => {
      vi.mocked(element.getBoundingClientRect).mockReturnValue({
        ...element.getBoundingClientRect(),
        left: 60,
        x: 60,
      })
      return "data:image/jpeg;base64,AAAA"
    })
    expect(await pictures.take(element)).toBeUndefined()
  })

  it("is taken one at a time", async () => {
    const shots: ((src: string) => void)[] = []
    const pictures = createPanePictures(
      () => new Promise<string | undefined>((resolve) => shots.push(resolve)),
    )
    const element = drawn()
    const first = pictures.take(element)
    const second = pictures.take(element)
    await Promise.resolve()
    expect(shots).toHaveLength(1)
    shots[0]!("data:image/jpeg;base64,AAAA")
    await first
    await vi.waitFor(() => expect(shots).toHaveLength(2))
    shots[1]!("data:image/jpeg;base64,BBBB")
    expect((await second)?.image.getAttribute("src")).toBe("data:image/jpeg;base64,BBBB")
  })

  it("is none where the app gives none", async () => {
    expect(await createPanePictures(async () => undefined).take(drawn())).toBeUndefined()
  })

  it("can't be taken where the page can't picture itself", () => {
    expect(createPanePictures(undefined).can()).toBe(false)
  })

  it("is a sketch of its layout while the demo's debug panel asks", async () => {
    document.documentElement.setAttribute(sketchedAttribute, "")
    const pictures = createPanePictures(undefined)
    expect(pictures.can()).toBe(true)
    const element = drawn()
    element.append(document.createElement("p"))
    const src = (await pictures.take(element))?.image.getAttribute("src") ?? ""
    expect(src.startsWith("data:image/svg+xml,")).toBe(true)
    expect(decodeURIComponent(src)).toContain('width="300" height="200"')
  })
})

describe("keeping a pane's picture", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  // Pictures that note each take, the next one numbered.
  const noting = () => {
    const taken: HTMLElement[] = []
    const pictures: PanePictures = {
      // Kept as the app keeps them; taken as the test says.
      ...createPanePictures(undefined),
      can: () => true,
      take: async (element) => {
        taken.push(element)
        const image = document.createElement("img")
        image.alt = String(taken.length)
        return { image, width: 1, height: 1, look: "" }
      },
    }
    return { pictures, taken }
  }

  // A pane, live or not, showing `key`; `latest` is its picture now.
  const pane = (
    pictures: PanePictures | undefined,
    live = true,
    key = "a",
    mark?: () => string,
  ) => {
    let latest: () => PanePicture | undefined = () => undefined
    let set: (next: { live: boolean; key: string }) => void = () => {}
    const Pane = (): React.JSX.Element => {
      const [state, setState] = useState({ live, key })
      set = setState
      const [element, setElement] = useState<HTMLElement | null>(null)
      latest = usePanePicture(element, state.live, state.key, mark)
      return createElement("div", { ref: setElement }, createElement("p", null, "text"))
    }
    const { container, unmount } = render(
      createElement(PanePicturesContext, { value: pictures }, createElement(Pane)),
    )
    const element = container.firstElementChild as HTMLElement
    return {
      element,
      latest: () => latest()?.image.alt,
      set: (next: { live: boolean; key: string }) => act(() => set(next)),
      unmount,
    }
  }
  const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

  it("finds its picture again as it mounts again with the same key", async () => {
    const { pictures } = noting()
    const before = pane(pictures)
    await pass(firstMs)
    before.unmount()
    expect(pane(pictures, false).latest()).toBe("1")
    expect(pane(pictures, false, "b").latest()).toBeUndefined()
  })

  it("lets its own picture go as what it shows changes or it unmounts", async () => {
    const { pictures } = noting()
    const Own = ({ keyed }: { readonly keyed: string }): React.JSX.Element => {
      const [element, setElement] = useState<HTMLElement | null>(null)
      usePanePicture(element, true, keyed, undefined, true)
      return createElement("div", { ref: setElement })
    }
    const page = render(
      createElement(PanePicturesContext, { value: pictures }, createElement(Own, { keyed: "a" })),
    )
    await pass(firstMs)
    expect(pictures.kept("a")).toBeDefined()
    page.rerender(
      createElement(PanePicturesContext, { value: pictures }, createElement(Own, { keyed: "b" })),
    )
    expect(pictures.kept("a")).toBeUndefined()
    await pass(firstMs)
    page.unmount()
    expect(pictures.kept("b")).toBeUndefined()
  })

  context("where what it shows is named", () => {
    it("takes it only once that holds still from one freshen to the next", async () => {
      const { pictures, taken } = noting()
      let named = "one"
      pane(pictures, true, "a", () => named)
      named = "two"
      await pass(firstMs)
      expect(taken).toEqual([])
      await pass(freshenMs)
      expect(taken).toHaveLength(1)
    })

    it("counts it only while that's still what it shows", async () => {
      const { pictures } = noting()
      let named = "one"
      const { latest } = pane(pictures, true, "a", () => named)
      await pass(firstMs)
      expect(latest()).toBe("1")
      named = "two"
      expect(latest()).toBeUndefined()
    })
  })

  it("keeps a few dozen, the one kept or shown longest ago going first", () => {
    const pictures = createPanePictures(undefined)
    const picture = (alt: string): PanePicture => {
      const image = document.createElement("img")
      image.alt = alt
      return { image, width: 1, height: 1, look: "" }
    }
    for (let at = 0; at <= keptMost; at++) {
      pictures.keep(String(at), picture(String(at)))
      // The first is shown as the others come, so it stays.
      if (at === 1) pictures.kept("0")
    }
    expect(pictures.kept("0")?.image.alt).toBe("0")
    expect(pictures.kept("1")).toBeUndefined()
    expect(pictures.kept(String(keptMost))?.image.alt).toBe(String(keptMost))
  })

  it("takes one a moment after the pane is laid out", async () => {
    const { pictures, taken } = noting()
    const { element, latest } = pane(pictures)
    await pass(firstMs - 1)
    expect(taken).toEqual([])
    await pass(1)
    expect(taken).toEqual([element])
    expect(latest()).toBe("1")
  })

  it("takes it again only once what it shows has changed", async () => {
    const { pictures, taken } = noting()
    const { element, latest } = pane(pictures)
    await pass(firstMs)
    await pass(freshenMs * 3)
    expect(taken).toHaveLength(1)
    element.querySelector("p")!.textContent = "more"
    await pass(freshenMs)
    expect(taken).toHaveLength(2)
    expect(latest()).toBe("2")
  })

  it("takes it again a moment after the pointer leaves, which a hover showed", async () => {
    const { pictures, taken } = noting()
    const { element } = pane(pictures)
    await pass(firstMs)
    element.dispatchEvent(new Event("pointerleave"))
    await pass(leftMs - 1)
    expect(taken).toHaveLength(1)
    await pass(1)
    expect(taken).toHaveLength(2)
  })

  it("takes it again a moment after focus leaves it, but not as focus moves inside it", async () => {
    const { pictures, taken } = noting()
    const { element } = pane(pictures)
    await pass(firstMs)
    const inside = element.querySelector("p")!
    element.dispatchEvent(new FocusEvent("focusout", { relatedTarget: inside }))
    await pass(leftMs)
    expect(taken).toHaveLength(1)
    element.dispatchEvent(new FocusEvent("focusout", { relatedTarget: null }))
    await pass(leftMs)
    expect(taken).toHaveLength(2)
  })

  it("takes it again in the page's new look", async () => {
    const { pictures, taken } = noting()
    pane(pictures)
    await pass(firstMs)
    document.documentElement.dataset.scheme = "dark"
    await pass(freshenMs)
    delete document.documentElement.dataset.scheme
    expect(taken).toHaveLength(2)
  })

  it("takes it again where it scrolled", async () => {
    const { pictures, taken } = noting()
    const { element } = pane(pictures)
    await pass(firstMs)
    element.querySelector("p")!.dispatchEvent(new Event("scroll"))
    await pass(freshenMs)
    expect(taken).toHaveLength(2)
  })

  it("tries again on the next freshen where none came", async () => {
    let tries = 0
    const pictures: PanePictures = {
      // Kept as the app keeps them; taken as the test says.
      ...createPanePictures(undefined),
      can: () => true,
      take: async () => {
        tries += 1
        return undefined
      },
    }
    pane(pictures)
    await pass(firstMs + freshenMs)
    expect(tries).toBe(2)
  })

  it("takes none while the pane isn't live", async () => {
    const { pictures, taken } = noting()
    pane(pictures, false)
    await pass(firstMs + freshenMs)
    expect(taken).toEqual([])
  })

  it("takes none where pictures can't be taken", async () => {
    const { pictures, taken } = noting()
    pane({ ...pictures, can: () => false })
    await pass(firstMs + freshenMs)
    expect(taken).toEqual([])
  })

  context("as it stops being live", () => {
    it("keeps its picture, and takes no more", async () => {
      const { pictures, taken } = noting()
      const { element, latest, set } = pane(pictures)
      await pass(firstMs)
      set({ live: false, key: "a" })
      element.querySelector("p")!.textContent = "more"
      await pass(freshenMs * 2)
      expect(taken).toHaveLength(1)
      expect(latest()).toBe("1")
    })
  })

  it("gives no picture of what it showed before", async () => {
    const { pictures } = noting()
    const { latest, set } = pane(pictures)
    await pass(firstMs)
    set({ live: false, key: "b" })
    expect(latest()).toBeUndefined()
  })
})
