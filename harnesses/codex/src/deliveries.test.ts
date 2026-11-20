import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { decode } from "./decode.js"

const { prompts, deliveries } = loadProbe<{ prompts: string[]; deliveries: string[] }>(
  import.meta.dirname,
  "delivery-prompts.probe.json",
)

const submitted = (prompt: string) =>
  decode({
    terminalId: "t",
    token: "x",
    agent: "codex",
    event: "UserPromptSubmit",
    seq: 1,
    instance: null,
    env: { cursor: false },
    payload: { session_id: "00000000-0000-4000-8000-000000000001", prompt },
  }).find((event) => event.type === "turn-started")

describe("the prompts it submits while Novadeck delivers messages", () => {
  it("hold no delivery: it lands in the hooks' context, never in a prompt", () => {
    expect(deliveries.length).toBeGreaterThan(0)
    for (const prompt of prompts) expect(prompt).not.toContain("novadeck-messages")
  })

  it("read as the person's, or as the doorbell's ring", () => {
    expect(prompts.map((prompt) => submitted(prompt))).toEqual(
      prompts.map((prompt) =>
        expect.objectContaining({ cause: prompt.startsWith("[Novadeck:") ? "doorbell" : "prompt" }),
      ),
    )
  })
})
