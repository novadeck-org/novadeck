import { gated, servesValue } from "@novadeck/wire/client"
import { oc } from "@orpc/contract"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { judgeContract } from "./compare.js"
import { inputEnum, inputUnion } from "./open.js"
import { snapshotContract } from "./snapshot.js"

// Every place an input can hold a value marked since a revision, from both sides: the check
// gates it, and a client refuses it to a server older than the mark. Add a new shape here.
// `build(false)` is the release's schema, `build(true)` the new one; `at` is what the check
// prints and a UI passes to `supports`.
type Shape = {
  readonly name: string
  readonly build: (marked: boolean) => z.ZodType
  readonly input: unknown
  readonly at: string
  readonly value?: string
}

// "opencode" as the release lacked it, or as the new schema marks it since 7.
const harness = (marked: boolean) =>
  marked ? inputEnum(["claude", "opencode"], { since: { opencode: 7 } }) : z.enum(["claude"])

const tagged = (marked: boolean, tag: string) => {
  const variants = (...kinds: string[]) =>
    kinds.map((kind) => z.strictObject({ [tag]: z.literal(kind) }))
  return marked
    ? inputUnion(tag, variants("a", "b", "c") as never, { since: { c: 7 } })
    : z.discriminatedUnion(tag, variants("a", "b") as never)
}

type Recursive = z.ZodObject<z.ZodRawShape>
const recursive = (marked: boolean): z.ZodType => {
  const node: Recursive = z.object({
    h: harness(marked).optional(),
    get kids() {
      return z.array(node).optional()
    },
  })
  return node
}

const shapes: readonly Shape[] = [
  {
    name: "an object key",
    build: (marked) => z.strictObject({ harness: harness(marked) }),
    input: { harness: "opencode" },
    at: "harness",
  },
  {
    name: "an optional, nullable key",
    build: (marked) => z.strictObject({ harness: harness(marked).nullable().optional() }),
    input: { harness: "opencode" },
    at: "harness",
  },
  {
    name: "list items",
    build: (marked) =>
      z.strictObject({ list: z.array(z.strictObject({ harness: harness(marked) })) }),
    input: { list: [{ harness: "opencode" }] },
    at: "list.*.harness",
  },
  {
    name: "a record's values",
    build: (marked) => z.strictObject({ r: z.record(z.string(), harness(marked)) }),
    input: { r: { any: "opencode" } },
    at: "r.*",
  },
  {
    name: "a record's keys",
    build: (marked) => z.strictObject({ r: z.partialRecord(harness(marked) as never, z.number()) }),
    input: { r: { opencode: 1 } },
    at: "r.*",
  },
  {
    name: "a tuple's items",
    build: (marked) => z.strictObject({ t: z.tuple([harness(marked)]) }),
    input: { t: ["opencode"] },
    at: "t.*",
  },
  {
    name: "an intersection's part",
    build: (marked) =>
      z.intersection(
        z.strictObject({ harness: harness(marked) }),
        z.strictObject({ x: z.string() }),
      ),
    input: { harness: "opencode", x: "" },
    at: "harness",
  },
  {
    name: "an object's catchall",
    build: (marked) => z.object({}).catchall(harness(marked)),
    input: { any: "opencode" },
    at: "*",
  },
  {
    name: "a variant of a union, as the root",
    build: (marked) => tagged(marked, "kind"),
    input: { kind: "c" },
    at: "",
    value: "c",
  },
  {
    name: "a variant of a union under a key",
    build: (marked) => z.strictObject({ u: tagged(marked, "kind") }),
    input: { u: { kind: "c" } },
    at: "u",
    value: "c",
  },
  {
    name: "a value inside a union whose tag is an enum",
    build: (marked) =>
      z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.enum(["a", "b"]), harness: harness(marked) }),
        z.strictObject({ kind: z.literal("c") }),
      ]),
    input: { kind: "a", harness: "opencode" },
    at: "harness",
  },
  {
    name: "a value inside a union nested in a union",
    build: (marked) =>
      z.discriminatedUnion("kind", [
        z.discriminatedUnion("sub", [
          z.strictObject({ kind: z.literal("a"), sub: z.literal("x"), harness: harness(marked) }),
          z.strictObject({ kind: z.literal("a"), sub: z.literal("y") }),
        ]),
        z.strictObject({ kind: z.literal("b") }),
      ]),
    input: { kind: "a", sub: "x", harness: "opencode" },
    at: "harness",
  },
  {
    name: "a self-recursive schema (getter)",
    build: recursive,
    // The check names the first place it meets the value; a deeper one is guarded all the same.
    input: { kids: [{ kids: [{ h: "opencode" }] }] },
    at: "h",
  },
  {
    name: "a value inside a union's option that other options share the key with",
    build: (marked) =>
      z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("a"), model: z.enum(["x"]) }),
        z.strictObject({ kind: z.literal("b"), model: harness(marked) }),
      ]),
    input: { kind: "b", model: "opencode" },
    at: "model",
  },
]

const contractOf = (schema: z.ZodType) => ({ a: { b: oc.input(schema).output(z.void()) } })
const window = (revision: number) => ({ revision, oldestClient: 3, oldestRunner: 2 })

describe.each(shapes)("an input value marked since, in $name", (shape) => {
  const value = shape.value ?? "opencode"
  const before = snapshotContract(contractOf(shape.build(false)) as never, window(6))
  const after = snapshotContract(contractOf(shape.build(true)) as never, window(7))

  it("is taken by the check as additive, and gated under the place a UI asks with", () => {
    const verdict = judgeContract(before, after)
    expect(verdict.findings.filter(({ behind }) => behind === "runner")).toEqual([])
    expect(verdict.problems).toEqual([])
    const place = shape.at === "" ? "" : `${shape.at} `
    expect(verdict.gated).toEqual([`a.b ${place}${JSON.stringify(value)} since 7`])
  })

  it("is refused by a client to a server older than the mark, and sent to a newer one", async () => {
    const contract = contractOf(shape.build(true))
    const client = { a: { b: (input: unknown) => Promise.resolve(input) } }
    await expect(gated(client, contract, 6).a.b(shape.input)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    })
    await expect(gated(client, contract, 7).a.b(shape.input)).resolves.toBe(shape.input)
    expect(servesValue(contract, ["a", "b"], shape.at, value, 6)).toBe(false)
    expect(servesValue(contract, ["a", "b"], shape.at, value, 7)).toBe(true)
  })
})
