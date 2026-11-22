import { oc } from "@orpc/contract"
import { createRouterClient, implement } from "@orpc/server"
import { describe as context, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { readTolerantly } from "./read.js"
import { dropUnknownKeys, type Dropped } from "./tolerant.js"

const note = z.strictObject({ text: z.string().max(8) })
const contract = {
  sessions: {
    save: oc
      .input(
        z.strictObject({
          id: z.string(),
          notes: z.array(note),
          change: z.discriminatedUnion("type", [
            z.strictObject({ type: z.literal("set"), value: z.number() }),
            z.strictObject({ type: z.literal("clear") }),
          ]),
        }),
      )
      .output(z.unknown()),
    ping: oc.output(z.string()),
    // Told apart by their keys alone, as a request answered by a terminal or by a reason.
    answer: oc
      .input(
        z.union([
          z.strictObject({ requestId: z.string(), terminalId: z.string() }),
          z.strictObject({ requestId: z.string(), reason: z.string() }),
        ]),
      )
      .output(z.unknown()),
  },
}

const serve = (dropped?: Dropped) => {
  const api = implement(dropUnknownKeys(contract, dropped))
  const router = api.router({
    sessions: {
      save: api.sessions.save.handler(({ input }) => input),
      ping: api.sessions.ping.handler(() => "pong"),
      answer: api.sessions.answer.handler(({ input }) => input),
    },
  })
  return createRouterClient(router)
}

const valid = { id: "s1", notes: [{ text: "hi" }], change: { type: "set" as const, value: 1 } }

describe("dropUnknownKeys", () => {
  context("with keys the schema doesn't name", () => {
    it("drops them at every level, passing on only what it names", async () => {
      const dropped = vi.fn<Dropped>()
      const client = serve(dropped)
      const input = {
        ...valid,
        base: 4,
        notes: [{ text: "hi", pinned: true }],
        change: { type: "set", value: 1, by: "phone" },
      }
      await expect(client.sessions.save(input as never)).resolves.toEqual(valid)
      expect(
        dropped.mock.calls.map(([path, keys]) => [path.join("."), [...keys].toSorted()]),
      ).toEqual([["sessions.save", ["base", "by", "pinned"]]])
      // What the client sent is left as it was.
      expect(input.base).toBe(4)
    })

    it("refuses an input with anything else wrong, as it did, telling of nothing", async () => {
      const dropped = vi.fn<Dropped>()
      const client = serve(dropped)
      const input = { ...valid, base: 4, notes: [{ text: "far too long" }] }
      await expect(client.sessions.save(input as never)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      })
      expect(dropped).not.toHaveBeenCalled()
    })

    it("drops a key another of a discriminated union's options names, as its tag picks one", async () => {
      const client = serve()
      const input = { ...valid, change: { type: "clear", value: 3 } }
      await expect(client.sessions.save(input as never)).resolves.toEqual({
        ...valid,
        change: { type: "clear" },
      })
    })

    it("drops a key no option of a plain union names", async () => {
      const client = serve()
      const input = { requestId: "r1", terminalId: "t1", by: "phone" }
      await expect(client.sessions.answer(input as never)).resolves.toEqual({
        requestId: "r1",
        terminalId: "t1",
      })
    })

    // Dropping it would answer as the other option, passing a field that one refuses.
    it("keeps refusing a key one of a plain union's options names", async () => {
      const client = serve()
      const input = { requestId: "r1", terminalId: "t1", reason: 5 }
      await expect(client.sessions.answer(input as never)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      })
    })
  })

  context("with an input that names nothing unknown", () => {
    it("takes it as it did, telling of nothing", async () => {
      const dropped = vi.fn<Dropped>()
      const client = serve(dropped)
      await expect(client.sessions.save(valid)).resolves.toEqual(valid)
      await expect(client.sessions.ping()).resolves.toBe("pong")
      expect(dropped).not.toHaveBeenCalled()
    })
  })

  it("leaves the contract's own schemas strict, for whoever else parses with them", () => {
    dropUnknownKeys(contract)
    const parsed = contract.sessions.save["~orpc"].inputSchema?.safeParse({ ...valid, base: 4 })
    expect(parsed?.success).toBe(false)
  })
})

describe("readTolerantly", () => {
  const reason = z.strictObject({ reason: z.enum(["pending", "draft"]) })

  it("reads a newer peer's value, dropping the keys it added", () => {
    expect(readTolerantly(reason, { reason: "draft", returned: "words" })).toEqual({
      reason: "draft",
    })
  })

  it("reads nothing from a value that doesn't fit", () => {
    expect(readTolerantly(reason, { reason: "gone" })).toBeUndefined()
    expect(readTolerantly(reason, undefined)).toBeUndefined()
  })
})
