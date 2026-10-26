import { redacted } from "@novadeck/secrets"
import { describe, expect, it } from "vitest"

import type { AgentDigest, ShellDigest } from "./describer.js"
import { redactDigest } from "./redact.js"

describe("redacting a digest", () => {
  it("cleans every string of an agent digest", () => {
    const digest: AgentDigest = {
      kind: "agent",
      project: "DB_PASSWORD=pw",
      summary: "Rotated sk-abcdefghijklmnopqrstuvwxyz for billing",
    }
    const clean = redactDigest(digest) as AgentDigest
    expect(JSON.stringify(clean)).not.toMatch(/sk-abc|=pw/)
    expect(clean.summary).toMatch(/^Rotated .* for billing$/)
  })

  it("sees a key block that spans the rows of a screen", () => {
    const digest: ShellDigest = {
      kind: "shell",
      project: null,
      command: "cat id_rsa",
      screen: [
        "-----BEGIN PRIVATE KEY-----",
        "MIIEvQIBADANBgkqhkiG9w0B",
        "-----END PRIVATE KEY-----",
        "$",
      ],
    }
    const clean = redactDigest(digest) as ShellDigest
    // Every row of the block is masked, and the rows stay where they are.
    expect(clean.screen).toEqual([redacted, redacted, redacted, "$"])
  })

  it("keeps the row of the last command, as no row is dropped or merged", () => {
    const digest: ShellDigest = {
      kind: "shell",
      project: null,
      command: null,
      screen: [
        "$ cat id_rsa",
        "-----BEGIN PRIVATE KEY-----",
        "MIIEvQIBADANBgkqhkiG9w0B",
        "-----END PRIVATE KEY-----",
        "$",
      ],
      continues: [false, false, true, false, false],
      commandAt: 0,
    }
    const clean = redactDigest(digest) as ShellDigest
    expect(clean.screen).toHaveLength(digest.screen.length)
    expect(clean.commandAt).toBe(0)
  })
})
