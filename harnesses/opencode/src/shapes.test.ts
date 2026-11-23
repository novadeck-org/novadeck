import { unknownShapes } from "@novadeck/harness-core/shapes"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { conversational, shapes } from "./shapes.js"

type Probe = { readonly transcript: readonly unknown[]; readonly child?: readonly unknown[] }
const lines = (name: string): string[] => {
  const probe = loadProbe(import.meta.dirname, name) as Probe
  return [...probe.transcript, ...(probe.child ?? [])].map((line) => JSON.stringify(line))
}

describe("the shapes of the transcripts Novadeck's plugin wrote (probed 2026-11-22, 1.19.6)", () => {
  it("are each read or knowingly skipped", () => {
    for (const name of ["session.probe.json", "edges.probe.json"])
      expect([...unknownShapes(shapes, lines(name)).keys()]).toEqual([])
  })

  it("tell a part opencode adds in a later release as unknown words of the conversation", () => {
    const line = JSON.stringify({
      type: "part",
      role: "assistant",
      part: { id: "p", type: "novel" },
    })
    const [, shape] = shapes(line)
    expect(shape).toEqual({ key: "part:assistant/novel", verdict: "unknown" })
    expect(conversational(shape!.key)).toBe(true)
  })
})
