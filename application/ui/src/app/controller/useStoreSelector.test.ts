import { act, createElement, StrictMode } from "react"

import { createStore, type MutableStore } from "../../model/store"
import { context, describe, expect, it } from "../../test"
import { render } from "../../test/render"
import { useStoreSelector } from "./useStoreSelector"

type Counts = { readonly tabs: readonly string[]; readonly zoom: number }

const sameItems = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index])

// Renders one selection of the store and records every value it rendered with.
const watch = <T>(
  store: MutableStore<Counts>,
  select: (state: Counts) => T,
  equal?: (a: T, b: T) => boolean,
  strict = false,
) => {
  const seen: T[] = []
  const Probe = (): null => {
    seen.push(useStoreSelector(store, select, equal))
    return null
  }
  const element = createElement(Probe)
  const rendered = render(strict ? createElement(StrictMode, null, element) : element)
  return { seen, unmount: rendered.unmount }
}

const change = (store: MutableStore<Counts>, next: Partial<Counts>): void =>
  act(() => void store.update((state) => ({ ...state, ...next })))

describe("useStoreSelector", () => {
  context("when an unrelated part of the store changes", () => {
    it("does not render again", () => {
      const store = createStore<Counts>({ tabs: ["01"], zoom: 1 })
      const { seen, unmount } = watch(store, (state) => state.tabs)
      change(store, { zoom: 2 })
      expect(seen).toHaveLength(1)
      change(store, { tabs: ["01", "02"] })
      expect(seen.at(-1)).toEqual(["01", "02"])
      expect(seen).toHaveLength(2)
      unmount()
    })
  })

  context("when the selection is rebuilt with equal contents", () => {
    it("keeps the previous value for an equality that says so", () => {
      const store = createStore<Counts>({ tabs: ["01"], zoom: 1 })
      const { seen, unmount } = watch(store, (state) => [...state.tabs], sameItems)
      change(store, { tabs: ["01"] })
      change(store, { zoom: 3 })
      expect(seen).toHaveLength(1)
      change(store, { tabs: ["02"] })
      expect(seen.map((tabs) => tabs.join())).toEqual(["01", "02"])
      unmount()
    })
  })

  context("when the component renders again with a new selector function", () => {
    it("keeps the value it rendered while the new selection is equal", () => {
      const store = createStore<Counts>({ tabs: ["01"], zoom: 1 })
      const seen: (readonly string[])[] = []
      const Probe = (): null => {
        seen.push(useStoreSelector(store, (state) => [...state.tabs], sameItems))
        return null
      }
      const rendered = render(createElement(Probe))
      rendered.rerender(createElement(Probe))
      expect(seen).toHaveLength(2)
      expect(seen[1]).toBe(seen[0])
      rendered.unmount()
    })
  })

  context("when rendered in StrictMode", () => {
    it("hands every render the same value until the selection changes", () => {
      const store = createStore<Counts>({ tabs: ["01"], zoom: 1 })
      const { seen, unmount } = watch(store, (state) => [...state.tabs], sameItems, true)
      change(store, { zoom: 2 })
      change(store, { tabs: ["01"] })
      expect(new Set(seen).size).toBe(1)
      change(store, { tabs: ["02"] })
      expect(new Set(seen).size).toBe(2)
      expect(seen.at(-1)).toEqual(["02"])
      unmount()
    })
  })
})
