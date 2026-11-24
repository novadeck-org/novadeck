import type { DragDropManager } from "@dnd-kit/abstract"
import { signal } from "@dnd-kit/state"

import { afterDrop } from "./drag-settled"
import { context, describe, expect, it } from "./test"

// A manager whose drag operation is idle while `idle` says so, as dnd-kit's turns idle once
// its drop animation has played out.
const managerOf = (idle: { value: boolean }) =>
  ({
    dragOperation: {
      status: {
        get idle() {
          return idle.value
        },
      },
    },
  }) as unknown as DragDropManager<any, any>

describe("after a drop", () => {
  context("while the dropped row is still sliding into its place", () => {
    it("waits, then runs once the drag has settled, and only once", async () => {
      const idle = signal(false)
      const runs: string[] = []
      afterDrop(managerOf(idle), () => runs.push("settled"))
      expect(runs).toEqual([])
      idle.value = true
      await Promise.resolve()
      expect(runs).toEqual(["settled"])
      idle.value = false
      idle.value = true
      await Promise.resolve()
      expect(runs).toEqual(["settled"])
    })
  })

  context("when the drag has already settled", () => {
    it("runs in the next microtask", async () => {
      const runs: string[] = []
      afterDrop(managerOf(signal(true)), () => runs.push("settled"))
      await Promise.resolve()
      expect(runs).toEqual(["settled"])
    })
  })

  context("when the wait is stopped first", () => {
    it("never runs", async () => {
      const idle = signal(false)
      const runs: string[] = []
      const stop = afterDrop(managerOf(idle), () => runs.push("settled"))
      stop()
      idle.value = true
      await Promise.resolve()
      expect(runs).toEqual([])
    })
  })
})
