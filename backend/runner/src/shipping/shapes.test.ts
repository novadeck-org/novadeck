import { readFileSync } from "node:fs"

import { shippingRules } from "@novadeck/harness-agy/shim"
import { describe, expect, it } from "vitest"

import { hookGated } from "../harnesses/registry.js"
import { shipsByRule, shipsCoarsely } from "./shapes.js"

const relay = new URL("../../../relay/src/", import.meta.url)

describe("the commands the shim's rules cover, read coarsely", () => {
  it("are read as the relay reads them, from one list of cases", () => {
    const { cases } = JSON.parse(readFileSync(new URL("rule-cases.json", relay), "utf8")) as {
      cases: { command: string; ships: boolean; coarse: boolean }[]
    }
    for (const { command, ships } of cases) expect(shipsByRule(command), command).toBe(ships)
  })

  it("are never more than what opencode's coarse reading refuses, read as the relay reads it", () => {
    const { cases } = JSON.parse(readFileSync(new URL("rule-cases.json", relay), "utf8")) as {
      cases: { command: string; ships: boolean; coarse: boolean }[]
    }
    for (const { command, coarse } of cases) expect(shipsCoarsely(command), command).toBe(coarse)
    // The shim's shapes are among what it refuses.
    expect(cases.filter(({ ships, coarse }) => ships && !coarse)).toEqual([])
  })

  it("name the hook-gated harnesses the relay holds too", () => {
    const { hookGated: held } = JSON.parse(
      readFileSync(new URL("rule-cases.json", relay), "utf8"),
    ) as { hookGated: string[] }
    expect(held.toSorted()).toEqual(
      (["claude", "codex", "agy", "opencode", "pi"] as const).filter(hookGated).toSorted(),
    )
  })

  it("are the rules the relay holds too", () => {
    const source = readFileSync(new URL("hook.rs", relay), "utf8")
    const held = /pub const SHIPPING_RULES: \[&str; \d+\] = \[([^\]]*)\]/.exec(source)?.[1]
    expect(held?.match(/"[^"]*"/g)?.map((each) => each.slice(1, -1))).toEqual([...shippingRules])
  })
})
