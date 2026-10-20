import { redacted } from "@novadeck/secrets"
import { describe, expect, it } from "vitest"

import type { AgentDigest, ShellDigest } from "./describer.js"
import { redactDigest } from "./redact.js"

describe("redacting a digest", () => {
  const previous = { title: "Deploying app" }

  it("cleans every string of an agent digest", () => {
    const digest: AgentDigest = {
      kind: "agent",
      harness: "Claude Code",
      project: "app",
      folder: "api",
      branch: "task/API_KEY=abc",
      plan: "Rotate sk-abcdefghijklmnopqrstuvwxyz",
      folders: ["src"],
      prompts: ["use DB_PASSWORD=pw please", "now deploy"],
      reply: "done with https://u:p@host/",
      summary: "rotated sk-abcdefghijklmnopqrstuvwxyz",
      previous,
      stage: "settled",
    }
    const clean = redactDigest(digest) as AgentDigest
    expect(JSON.stringify(clean)).not.toMatch(/ghp_|sk-abc|=pw|=abc|u:p@/)
    expect(clean.prompts[1]).toBe("now deploy")
    expect(clean.previous?.title).toBe("Deploying app")
  })

  it("cleans every string of a reply", () => {
    const reply = redactDigest({
      kind: "reply",
      reply: "Done with https://u:p@host/",
      failed: true,
    })

    expect(JSON.stringify(reply)).not.toContain("u:p@")
    expect(reply).toMatchObject({ kind: "reply", failed: true })
  })

  it("sees a key block that spans the rows of a screen", () => {
    const digest: ShellDigest = {
      kind: "shell",
      project: null,
      folder: null,
      command: "cat id_rsa",
      screen: [
        "-----BEGIN PRIVATE KEY-----",
        "MIIEvQIBADANBgkqhkiG9w0B",
        "-----END PRIVATE KEY-----",
        "$",
      ],
      previous: null,
    }
    const clean = redactDigest(digest) as ShellDigest
    // Every row of the block is masked, and the rows stay where they are.
    expect(clean.screen).toEqual([redacted, redacted, redacted, "$"])
  })

  it("keeps the row of the last command, as no row is dropped or merged", () => {
    const digest: ShellDigest = {
      kind: "shell",
      project: null,
      folder: null,
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
      previous: null,
    }
    const clean = redactDigest(digest) as ShellDigest
    expect(clean.screen).toHaveLength(digest.screen.length)
    expect(clean.commandAt).toBe(0)
  })
})
