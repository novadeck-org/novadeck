import { oc, type } from "@orpc/contract"
import { describe, expect, it } from "vitest"

import { gated, serves } from "./since.js"

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
