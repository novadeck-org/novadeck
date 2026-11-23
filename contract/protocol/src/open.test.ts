import { getEventIteratorSchemaDetails, oc } from "@orpc/contract"
import { describe as context, describe, expect, it } from "vitest"
import { z } from "zod"

import { compatibility } from "./compatibility.js"
import { contract } from "./contract.js"
import { inputEnum, inputUnion, isDropped, newer, openEnum, openUnion, readerOf } from "./open.js"
import { snapshotContract } from "./snapshot.js"

const since = 3

describe("readerOf", () => {
  context("with a schema that has no open part", () => {
    it("is undefined, so values are read as they are, at no cost", () => {
      const plain = z.strictObject({ kind: z.enum(["a", "b"]), items: z.array(z.string()) })
      expect(readerOf(plain)).toBeUndefined()
    })
  })

  context("with an open enum", () => {
    it("reads a value it doesn't know as `newer` where it keeps the element", () => {
      const read = readerOf(
        z.strictObject({
          id: z.string(),
          kind: openEnum(["image", "file"], { since, unknown: "placeholder" }),
        }),
      )!
      expect(read({ id: "i1", kind: "hologram" })).toEqual({ id: "i1", kind: newer })
      const known = { id: "i2", kind: "file" }
      expect(read(known)).toBe(known)
    })

    it("reads it as the catch-all the enum has", () => {
      const read = readerOf(
        z.strictObject({
          state: openEnum(["working", "idle", "unknown"], {
            since,
            unknown: { fallback: "unknown" },
          }),
        }),
      )!
      expect(read({ state: "dreaming" })).toEqual({ state: "unknown" })
    })

    it("leaves out the list element that holds one it drops", () => {
      const part = z.strictObject({
        kind: openEnum(["agent", "person"], { since, unknown: "drop" }),
        text: z.string(),
      })
      const read = readerOf(z.strictObject({ parts: z.array(part) }))!
      expect(
        read({
          parts: [
            { kind: "agent", text: "a" },
            { kind: "robot", text: "b" },
          ],
        }),
      ).toEqual({
        parts: [{ kind: "agent", text: "a" }],
      })
    })

    it("leaves a list and its items as they are where nothing is unknown", () => {
      const part = z.strictObject({
        kind: openEnum(["agent", "person"], { since, unknown: "drop" }),
      })
      const read = readerOf(
        z.strictObject({ parts: z.array(part), byId: z.record(z.string(), part) }),
      )!
      const value = {
        parts: [{ kind: "agent" }, { kind: "person" }],
        byId: { a: { kind: "agent" } },
      }
      const same = read(value) as typeof value
      expect(same).toBe(value)
      expect(same.parts).toBe(value.parts)
    })

    it("drops a stream item that holds one, with no list to leave it out of", () => {
      const read = readerOf(z.strictObject({ kind: openEnum(["a"], { since, unknown: "drop" }) }))!
      expect(isDropped(read({ kind: "z" }))).toBe(true)
      expect(isDropped(read({ kind: "a" }))).toBe(false)
    })
  })

  context("with an open discriminated union", () => {
    const action = openUnion(
      "type",
      [
        z.strictObject({ type: z.literal("close") }),
        z.strictObject({ type: z.literal("run"), command: z.string() }),
      ],
      { since, unknown: "placeholder" },
    )
    const read = readerOf(z.strictObject({ requestId: z.string(), action }))!

    it("keeps the element, its variant read as the placeholder", () => {
      expect(read({ requestId: "r1", action: { type: "hand", to: "t2" } })).toEqual({
        requestId: "r1",
        action: { type: newer },
      })
    })

    it("reads a known variant through its own open parts", () => {
      const inner = openUnion(
        "kind",
        [
          z.strictObject({
            kind: z.literal("file"),
            lang: openEnum(["ts"], { since, unknown: { fallback: "ts" } }),
          }),
        ],
        { since, unknown: "drop" },
      )
      const reading = readerOf(z.array(inner))!
      expect(reading([{ kind: "file", lang: "rust" }, { kind: "hologram" }])).toEqual([
        { kind: "file", lang: "ts" },
      ])
    })
  })

  context("with open parts in a closed discriminated union", () => {
    it("reads each variant by its tag", () => {
      const change = z.discriminatedUnion("type", [
        z.strictObject({
          type: z.literal("item"),
          kind: openEnum(["a"], { since, unknown: "placeholder" }),
        }),
        z.strictObject({ type: z.literal("synced") }),
      ])
      const read = readerOf(change)!
      expect(read({ type: "item", kind: "b" })).toEqual({ type: "item", kind: newer })
      expect(read({ type: "synced" })).toEqual({ type: "synced" })
    })
  })

  context("with a nullable or optional open part", () => {
    it("reads null and undefined as they are", () => {
      const read = readerOf(
        z.strictObject({
          agent: openEnum(["claude"], { since, unknown: "placeholder" }).nullable(),
        }),
      )!
      expect(read({ agent: null })).toEqual({ agent: null })
      expect(read({ agent: "grok" })).toEqual({ agent: newer })
    })
  })

  context("with a recursive schema", () => {
    it("reads every level, and ends", () => {
      type Node = { kind: string; children: Node[] }
      const node: z.ZodType<Node> = z.lazy(() =>
        z.strictObject({
          kind: openEnum(["dir"], { since, unknown: { fallback: "dir" } }),
          children: z.array(node),
        }),
      )
      const read = readerOf(node)!
      expect(read({ kind: "x", children: [{ kind: "y", children: [] }] })).toEqual({
        kind: "dir",
        children: [{ kind: "dir", children: [] }],
      })
    })
  })

  it("refuses an open part inside a plain union, which it can't tell apart", () => {
    const ambiguous = z.union([
      z.strictObject({ a: openEnum(["x"], { since, unknown: "drop" }) }),
      z.strictObject({ b: z.string() }),
    ])
    expect(() => readerOf(ambiguous)).toThrow("plain union")
  })
})

describe("the contract's open schemas", () => {
  const procedures = (node: unknown, path: string[] = []): [string, Record<string, unknown>][] => {
    if (typeof node !== "object" || node === null) return []
    if ("~orpc" in node)
      return [[path.join("."), (node as { "~orpc": Record<string, unknown> })["~orpc"]]]
    return Object.entries(node).flatMap(([key, inner]) => procedures(inner, [...path, key]))
  }

  it("reads every procedure's answer, open parts and all", () => {
    for (const [, def] of procedures(contract)) {
      const stream = getEventIteratorSchemaDetails(def.outputSchema as never)
      expect(() => readerOf(stream ? stream.yields : def.outputSchema)).not.toThrow()
    }
  })

  // A UI never sends what only its reader writes: inputs take the closed schemas.
  it("has no placeholder in any input", () => {
    const written = snapshotContract(contract, compatibility)
    const inputs = Object.entries(written.procedures).filter(([, { input }]) =>
      JSON.stringify(input).includes(`"${newer}"`),
    )
    expect(inputs.map(([path]) => path)).toEqual([])
  })
})

describe("inputEnum and inputUnion", () => {
  it("parse as the plain enum and union", () => {
    const harness = inputEnum(["claude", "opencode"], { since: { opencode: 7 } })
    expect(harness.parse("opencode")).toBe("opencode")
    expect(harness.safeParse("codex").success).toBe(false)
    const union = inputUnion(
      "kind",
      [z.strictObject({ kind: z.literal("a") }), z.strictObject({ kind: z.literal("b") })],
      { since: { b: 7 } },
    )
    expect(union.parse({ kind: "b" })).toEqual({ kind: "b" })
    expect(union.safeParse({ kind: "c" }).success).toBe(false)
    const typed: z.infer<typeof harness> = "claude"
    expect(typed).toBe("claude")
  })

  it("carry the mark into the JSON Schema", () => {
    const schema = z.strictObject({
      harness: inputEnum(["claude", "opencode"], { since: { opencode: 7 } }),
      choice: inputUnion(
        "kind",
        [z.strictObject({ kind: z.literal("a") }), z.strictObject({ kind: z.literal("b") })],
        { since: { b: 7 } },
      ),
    })
    const written = z.toJSONSchema(schema, { io: "input" }) as {
      properties: Record<string, Record<string, unknown>>
    }
    expect(written.properties.harness?.["x-since"]).toEqual({ opencode: 7 })
    expect(written.properties.choice?.["x-since"]).toEqual({ b: 7 })
  })

  it("land in contract.json through the snapshot", () => {
    const snapshot = snapshotContract(
      {
        agents: {
          open: oc
            .input(
              z.strictObject({
                harness: inputEnum(["claude", "opencode"], { since: { opencode: 7 } }),
              }),
            )
            .output(z.void()),
        },
      } as never,
      compatibility,
    )
    expect(JSON.stringify(snapshot.procedures["agents.open"]?.input)).toContain(
      '"x-since":{"opencode":7}',
    )
  })
})
