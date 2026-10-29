import { randomUUID } from "node:crypto"

import type { PageLookAnswer } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import { PageLooks } from "./looks.js"

const look = { itemId: randomUUID(), shown: 1, url: "http://localhost:5173/" }
const refusal = (lookId: string): PageLookAnswer => ({ lookId, reason: "No pane shows it." })

describe("agents' looks at pages", () => {
  it("go nowhere without a client following them", async () => {
    await expect(new PageLooks().ask(look, 1_000)).resolves.toEqual({ type: "nobody" })
  })

  it("go to the client that followed last, and wait for its answer", async () => {
    const looks = new PageLooks()
    const controller = new AbortController()
    const older = looks.follow("older", controller.signal)
    const newer = looks.follow("newer", controller.signal)
    // A stream follows from its first read.
    void older.next()
    const first = newer.next()
    const asked = looks.ask(look, 1_000)
    const { value } = await first
    expect(value).toEqual({ lookId: expect.any(String), ...look })
    // Not the client it went to: nothing waits for its answer there.
    expect(() => looks.answer(refusal(value!.lookId), "older")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
    looks.answer(refusal(value!.lookId), "newer")
    await expect(asked).resolves.toEqual({
      type: "answered",
      answer: refusal(value!.lookId),
    })
    // Answered once: the look is no longer waited for.
    expect(() => looks.answer(refusal(value!.lookId), "newer")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
    controller.abort()
  })

  it("end as late when the client takes too long, and the late answer is refused", async () => {
    const looks = new PageLooks()
    const controller = new AbortController()
    const stream = looks.follow("owner", controller.signal)
    const first = stream.next()
    const asked = looks.ask(look, 20)
    const { value } = await first
    await expect(asked).resolves.toEqual({ type: "late" })
    expect(() => looks.answer(refusal(value!.lookId), "owner")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
    controller.abort()
  })

  it("end as gone when their client goes away, or the runner stops", async () => {
    const looks = new PageLooks()
    const stream = looks.follow("owner")
    const first = stream.next()
    const asked = looks.ask(look, 5_000)
    await first
    looks.release("owner")
    await expect(asked).resolves.toEqual({ type: "gone" })

    const again = new PageLooks()
    const second = again.follow("owner")
    const read = second.next()
    const stopped = again.ask(look, 5_000)
    await read
    again.finish()
    await expect(stopped).resolves.toEqual({ type: "gone" })
  })
})
