import { describe, expect, it } from "vitest"

import { createAdmission, perFrame, type Frames } from "./admission"

const setup = () => {
  const pending = new Map<number, () => void>()
  let next = 1
  const frames: Frames = {
    request: (callback) => {
      pending.set(next, callback)
      return next++
    },
    cancel: (handle) => void pending.delete(handle),
  }
  const turns: string[][] = []
  const admission = createAdmission((ids) => turns.push([...ids]), frames)
  const frame = (): void => {
    const [handle, callback] = [...pending][0] ?? []
    if (handle === undefined) return
    pending.delete(handle)
    callback?.()
  }
  return { admission, turns, pending, frame }
}

describe("admitting nodes to their screens", () => {
  it("admits the selected node at once and the rest nearest first, a few per frame", () => {
    const { admission, turns, frame } = setup()
    admission.select("c")
    for (const [id, distance] of [
      ["a", 50],
      ["b", 10],
      ["c", 900],
      ["d", 30],
      ["e", 70],
    ] as const)
      admission.want(id, distance)
    expect(turns).toEqual([["c"]])
    expect(admission.admitted("b")).toBe(false)
    frame()
    expect(turns.slice(1)).toEqual([["b", "d"].slice(0, perFrame)])
    frame()
    frame()
    expect(turns.flat()).toEqual(["c", "b", "d", "a", "e"])
    expect(admission.admitted("e")).toBe(true)
  })

  it("admits a waiting node the moment it is selected", () => {
    const { admission, turns } = setup()
    admission.want("a", 5)
    admission.select("a")
    expect(turns).toEqual([["a"]])
  })

  it("drops a node that leaves before its turn, and stops asking for frames", () => {
    const { admission, turns, pending, frame } = setup()
    admission.want("a", 1)
    admission.drop("a")
    expect(pending.size).toBe(0)
    frame()
    expect(turns).toEqual([])
    expect(admission.admitted("a")).toBe(false)
  })

  it("takes an admitted node back when it leaves, and queues it again on return", () => {
    const { admission, turns, frame } = setup()
    admission.want("a", 1)
    frame()
    admission.drop("a")
    expect(admission.admitted("a")).toBe(false)
    admission.want("a", 1)
    frame()
    expect(turns).toEqual([["a"], ["a"]])
  })
})
