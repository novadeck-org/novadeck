import { promptStart } from "@novadeck/harness-core/prompts"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { agy } from "./index.js"

const { prompts, deliveries } = loadProbe<{ prompts: string[]; deliveries: string[] }>(
  import.meta.dirname,
  "delivery-prompts.probe.json",
)

const base = {
  agent: "agy",
  sessionId: "00000000-0000-4000-8000-000000000001",
  instance: null,
  startedAt: 1,
} as const

describe("what its transcript records as typed while Novadeck delivers messages", () => {
  it("holds no delivery: deliveries are system steps, never typed input", () => {
    expect(deliveries.length).toBeGreaterThan(0)
    for (const prompt of prompts) expect(prompt).not.toContain("novadeck-messages")
  })

  it("reads as the person's, or as the doorbell's ring, as the runner classes a typed entry", () => {
    expect(prompts.map((prompt) => promptStart(base, prompt))).toEqual(
      prompts.map((prompt) =>
        expect.objectContaining({ cause: prompt.startsWith("[Novadeck:") ? "doorbell" : "prompt" }),
      ),
    )
  })
})

describe("how long what its prompt hook injects lasts, by release", () => {
  it("lasts one model call before 1.5.18, so each later call gets it again", () => {
    for (const version of ["1.5.16", "1.5.17", "1.4.12"])
      expect(agy.messagingAt!(version)).toMatchObject({ reinjectPerCall: true })
    expect(agy.messaging.reinjectPerCall).toBe(true)
  })

  it("stays in the conversation from 1.5.18, its hook still asking before every call", () => {
    for (const version of ["1.5.18", "1.5.20", "1.6.0", "2.0.0"])
      expect(agy.messagingAt!(version)).toMatchObject({
        reinjectPerCall: false,
        asksEveryCall: true,
        lasting: [],
      })
  })
})
