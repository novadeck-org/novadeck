import { describe, expect, it } from "../test.js"
import type { Message } from "./messages.js"
import { RingNotes } from "./ring-notes.js"

const message = (id: string, text: string): Message =>
  ({
    id,
    from: { kind: "agent", terminalId: "A", handle: "moth", agent: "claude", sessionId: null },
    text,
  }) as Message

describe("a terminal's ring notes", () => {
  const many = Array.from({ length: 11 }, (_, at) => message(`m-${at}`, `message ${at}`))

  it("keeps a ring's first eight parts and says how many more it had", () => {
    const notes = new RingNotes(
      () => {},
      () => 1,
    )
    notes.ring("B", "n1", many)
    const [ring] = notes.since("B", 0).rings
    expect(ring!.parts).toHaveLength(8)
    expect(ring!.more).toBe(3)
  })

  it("keeps a delivery's every id, up to the most, with the parts it shows", () => {
    const notes = new RingNotes(
      () => {},
      () => 1,
    )
    notes.delivery("B", many)
    const [delivery] = notes.since("B", 0).deliveries
    expect(delivery!.ids).toHaveLength(11)
    expect(delivery!.parts).toHaveLength(8)
    expect(delivery!.more).toBe(3)
  })

  it("counts rings and deliveries in one sequence a reader follows", () => {
    const notes = new RingNotes(
      () => {},
      () => 1,
    )
    notes.ring("B", "n1", many.slice(0, 1))
    notes.delivery("B", many.slice(0, 1))
    notes.ring("B", "n2", many.slice(0, 1))
    expect(notes.listed("B")).toEqual({ ringSeq: 3 })
    const later = notes.since("B", 1)
    expect(later.deliveries.map((each) => each.seq)).toEqual([2])
    expect(later.rings.map((each) => each.nonce)).toEqual(["n2"])
  })
})
