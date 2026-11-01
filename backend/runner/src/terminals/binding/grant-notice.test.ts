import { maxGrantCommands, maxGrantRepos, type Grant } from "@novadeck/protocol"

import { harnesses } from "../../harnesses/registry.js"
import {
  grantCommandBytes,
  grantCommandsRefusal,
  maxGrantCommandBytes,
} from "../../messaging/grant-text.js"
import { byteLength, maxDeliveryBytes, wrapGrants } from "../../messaging/messages.js"
import { describe, expect, it } from "../../test.js"
import { noticesAt } from "../nudges.js"
import { fitGrants } from "./grant-notice.js"

// The most one grant can say: commands up to the cap, the most repos, each as long as allowed.
const largest = (id: string): Grant => {
  const commands: Grant["commands"][number][] = []
  const accepts = (more: Grant["commands"][number]) =>
    commands.length < maxGrantCommands && grantCommandsRefusal([...commands, more]) === undefined
  for (let length = 256; length > 0; length -= 1) {
    const more = { argv: ["echo", "<".repeat(length)], rest: false }
    while (accepts(more)) commands.push(more)
  }
  expect(grantCommandBytes(commands)).toBeGreaterThan(maxGrantCommandBytes - 8)
  return {
    id,
    projectId: "00000000-0000-4000-8000-000000000001",
    workspaceSessionId: "00000000-0000-4000-8000-000000000002",
    holder: { kind: "team", lead: "sable", withLead: true },
    presets: ["push", "pr"],
    commands,
    repos: Array.from({ length: maxGrantRepos }, (_, n) => ({
      url: `github.com/${"o".repeat(39)}/${String(n).padEnd(109, "r")}`,
      defaultBranch: "b".repeat(100),
      defaultFrom: "github" as const,
    })),
    entryId: "00000000-0000-4000-8000-000000000003",
    proposedBy: "sable",
    madeAt: 0,
    lifetime: "hour",
    endsAt: 3_600_000,
    lastActivityAt: 0,
    covering: [],
    ended: [],
    revokedAt: null,
    lastUse: null,
  }
}

describe("the grants beside the bar's notice", () => {
  const took = { companion: true, summarize: true, pages: [] }
  const ids = Array.from({ length: 6 }, (_, n) => `8c0e3d5a-45c1-4e0e-9d52-1f3f0f2f6a1${n}`)

  it("always leave room for the notice itself, on every harness and OS, however many are held", () => {
    for (const agent of ["claude", "codex", "agy"] as const)
      for (const platform of ["linux", "darwin", "win32"] as const)
        for (const cmdPrints of [false, true, "held", "unreadable"] as const)
          for (const held of [1, 2, 6]) {
            const covering = ids.slice(0, held).map(largest)
            const { prompt } = harnesses[agent].messaging
            const printed = (grants: string) =>
              byteLength(prompt(noticesAt(took, { summary: null }, grants)))
            const { wrapped, left } = fitGrants(
              covering,
              (list) => wrapGrants(list, agent, platform, undefined, cmdPrints),
              (text) => printed(text) <= maxDeliveryBytes,
            )
            // Repeated whole, a maximal grant overflows alone: the cap is what keeps it in.
            expect(
              printed(wrapGrants(covering, agent, platform, undefined, cmdPrints)),
            ).toBeGreaterThan(maxDeliveryBytes)
            const where = `${held} on ${agent}, ${platform}, cmdPrints ${String(cmdPrints)}`
            expect(printed(wrapped), where).toBeLessThanOrEqual(maxDeliveryBytes)
            // What isn't in the notice is left to be delivered, in order, and nothing is lost.
            const shown = covering.filter((each) => wrapped.includes(`<grant id="${each.id}"`))
            expect(
              [...shown, ...left].map((each) => each.id),
              where,
            ).toEqual(covering.map((each) => each.id))
          }
  })

  it("take as many as fit, oldest first, and all of them where there is room", () => {
    const small = ids.slice(0, 3).map((id) => ({ ...largest(id), commands: [], repos: [] }))
    const all = fitGrants(
      small,
      (list) => list.map((each) => each.id).join(" "),
      () => true,
    )
    expect(all.left).toEqual([])
    const two = fitGrants(
      small,
      (list) => list.map((each) => each.id).join(" "),
      (text) => text.split(" ").length <= 2,
    )
    expect(two.wrapped).toBe(`${ids[0]} ${ids[1]}`)
    expect(two.left.map((each) => each.id)).toEqual([ids[2]])
    expect(
      fitGrants(
        small,
        () => "x",
        () => false,
      ),
    ).toEqual({ wrapped: "", left: small })
    expect(
      fitGrants(
        [],
        () => "x",
        () => true,
      ),
    ).toEqual({ wrapped: "", left: [] })
  })
})
