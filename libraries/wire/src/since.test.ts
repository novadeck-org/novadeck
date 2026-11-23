import { oc, type } from "@orpc/contract"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { gated, serves, servesValue } from "./since.js"

const contract = {
  sessions: {
    save: oc.input(type<string>()).output(type<string>()),
    watch: oc.meta({ since: 4 }).input(type<void>()).output(type<string>()),
  },
}

describe("serves", () => {
  it("says a server has a procedure from before its revision, and one marked since it", () => {
    expect(serves(contract, ["sessions", "save"], 1)).toBe(true)
    expect(serves(contract, ["sessions", "watch"], 4)).toBe(true)
  })

  it("says a server older than a procedure's `since` doesn't have it", () => {
    expect(serves(contract, ["sessions", "watch"], 3)).toBe(false)
  })

  it("says no for a path that names no procedure", () => {
    expect(serves(contract, ["sessions"], 9)).toBe(false)
    expect(serves(contract, ["sessions", "drop"], 9)).toBe(false)
  })
})

describe("gated", () => {
  const client = { sessions: { save: () => "saved", watch: () => "watching" } }

  it("returns the client as it is for a server that has every procedure", () => {
    expect(gated(client, contract, 4)).toBe(client)
  })

  it("refuses a newer procedure without calling it, and passes the rest through", async () => {
    const old = gated(client, contract, 3)
    await expect(old.sessions.watch()).rejects.toMatchObject({ code: "UNSUPPORTED" })
    expect(old.sessions.save()).toBe("saved")
  })
})

describe("gated, reading answers", () => {
  const skipped = Symbol("skipped")
  const items = async function* () {
    yield "a"
    yield "skip"
    yield "b"
  }
  const client = {
    sessions: {
      save: () => Promise.resolve("saved"),
      watch: () => Promise.resolve(items()),
    },
  }
  const outputs = {
    reader: (path: readonly string[]) =>
      path.join(".") === "sessions.watch"
        ? (value: unknown) => (value === "skip" ? skipped : `read ${String(value)}`)
        : path.join(".") === "sessions.save"
          ? (value: unknown) => `read ${String(value)}`
          : undefined,
    skips: (value: unknown) => value === skipped,
  }

  it("reads a call's answer", async () => {
    expect(await gated(client, contract, 4, outputs).sessions.save()).toBe("read saved")
  })

  it("reads each of a stream's items, leaving out those read as skipped", async () => {
    const read: unknown[] = []
    for await (const item of await gated(client, contract, 4, outputs).sessions.watch())
      read.push(item)
    expect(read).toEqual(["read a", "read b"])
  })

  it("returns the client as it is when it reads nothing", () => {
    expect(gated(client, contract, 4, { reader: () => undefined, skips: () => false })).toBe(client)
  })
})

// What `inputEnum` and `inputUnion` write, without the protocol package.
const marked = <T extends z.ZodType>(schema: T, since: Record<string, number>): T =>
  schema.meta({ "x-since": since }) as T

const harness = marked(z.enum(["claude", "opencode"]), { opencode: 7 })
const choice = marked(
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("a") }),
    z.strictObject({ kind: z.literal("b"), harness }),
    z.strictObject({ kind: z.literal("c") }),
  ]),
  { c: 8 },
)
const inputs = {
  agents: {
    open: oc
      .input(
        z.strictObject({
          harness,
          later: harness.optional(),
          maybe: harness.nullable().optional(),
          list: z.array(z.strictObject({ harness })),
          nested: z.strictObject({ choice }).optional(),
          plain: z.enum(["x", "y"]),
        }),
      )
      .output(type<string>()),
    list: oc.input(z.strictObject({ plain: z.enum(["x"]) })).output(type<string>()),
  },
}

describe("servesValue", () => {
  const asks = (at: string, value: string, revision: number) =>
    servesValue(inputs, ["agents", "open"], at, value, revision)

  it("says a server older than a value's revision doesn't take it", () => {
    expect(asks("harness", "opencode", 6)).toBe(false)
    expect(asks("harness", "opencode", 7)).toBe(true)
  })

  it("takes a value with no mark, and one of an unmarked place", () => {
    expect(asks("harness", "claude", 1)).toBe(true)
    expect(asks("plain", "x", 1)).toBe(true)
    expect(asks("missing", "x", 1)).toBe(true)
  })

  it("reads through optional and nullable wrappers", () => {
    expect(asks("later", "opencode", 6)).toBe(false)
    expect(asks("maybe", "opencode", 6)).toBe(false)
  })

  it("reads nested keys, list items and a union's variants", () => {
    expect(asks("list.*.harness", "opencode", 6)).toBe(false)
    expect(asks("list.*.harness", "opencode", 7)).toBe(true)
    expect(asks("nested.choice", "c", 7)).toBe(false)
    expect(asks("nested.choice", "c", 8)).toBe(true)
    expect(asks("nested.choice", "a", 1)).toBe(true)
  })

  it("says no for a procedure the contract lacks", () => {
    expect(servesValue(inputs, ["agents", "gone"], "harness", "opencode", 9)).toBe(false)
  })
})

describe("gated, reading inputs", () => {
  const client = {
    agents: { open: (input: unknown) => Promise.resolve(input), list: () => Promise.resolve("ok") },
  }
  const input = (changes: Record<string, unknown>) => ({
    harness: "claude",
    list: [],
    plain: "x",
    ...changes,
  })

  it("refuses a marked value an older server predates, naming where and which", async () => {
    const old = gated(client, inputs, 6)
    const error: unknown = await old.agents.open(input({ harness: "opencode" })).catch((e) => e)
    expect(error).toMatchObject({ code: "UNSUPPORTED" })
    expect((error as Error).message).toBe(
      'The server, at revision 6, doesn\'t take "opencode" at input harness of agents.open, which came in revision 7.',
    )
    await expect(
      old.agents.open(input({ list: [{ harness: "claude" }, { harness: "opencode" }] })),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" })
    await expect(
      old.agents.open(input({ nested: { choice: { kind: "b", harness: "opencode" } } })),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" })
    await expect(
      gated(client, inputs, 7).agents.open(input({ nested: { choice: { kind: "c" } } })),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" })
  })

  it("lets a marked value through to a newer server, and unmarked values to any", async () => {
    const given = input({ harness: "opencode", maybe: null })
    await expect(gated(client, inputs, 7).agents.open(given)).resolves.toBe(given)
    const plain = input({ later: undefined, nested: { choice: { kind: "a" } } })
    await expect(gated(client, inputs, 1).agents.open(plain)).resolves.toBe(plain)
    expect(await gated(client, inputs, 1).agents.list()).toBe("ok")
  })

  it("returns the client as it is once the server takes every marked value", () => {
    expect(gated(client, inputs, 8)).toBe(client)
  })
})
