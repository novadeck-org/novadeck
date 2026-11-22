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
