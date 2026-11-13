import { join } from "node:path"

import type { Install } from "@novadeck/harness-core/harness"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe as context, describe, expect, it } from "vitest"

import { limitsReading, usageWindows } from "./usage.js"

const { line } = loadProbe(import.meta.dirname, "usage.probe.json") as { line: string }
type Answer = { response: { response: { rate_limits: Record<string, unknown> } & object } }
// The probe's answer with its rate limits changed by `change`.
const answer = (change: (limits: Record<string, unknown>) => Record<string, unknown>): string => {
  const parsed = JSON.parse(line) as Answer
  const { rate_limits: limits, ...rest } = parsed.response.response
  return JSON.stringify({
    ...parsed,
    response: { ...parsed.response, response: { ...rest, rate_limits: change(limits) } },
  })
}

describe("Claude Code's model windows", () => {
  it("reads each model's weekly window from its answer to get_usage", () => {
    expect(usageWindows(line)).toEqual([
      {
        minutes: 10_080,
        used: 0.07,
        resetsAt: Date.parse("2026-11-16T14:00:00.166468+00:00"),
        scope: "Fable",
      },
    ])
  })

  it("reads the Sonnet window /usage shows on a Max plan beside them", () => {
    const sonnet = { utilization: 50, resets_at: "2026-11-16T14:00:00Z" }
    expect(usageWindows(answer((limits) => ({ ...limits, seven_day_sonnet: sonnet })))).toEqual([
      expect.objectContaining({ scope: "Fable" }),
      { minutes: 10_080, used: 0.5, resetsAt: Date.parse(sonnet.resets_at), scope: "Sonnet" },
    ])
  })

  it("gives none for an account that has no model window", () => {
    expect(usageWindows(answer((limits) => ({ ...limits, model_scoped: [] })))).toEqual([])
  })

  context("when the answer says nothing of them", () => {
    it("gives null for an answer from Claude Code's cache, an error, or no plan limits", () => {
      expect(
        usageWindows(
          answer((limits) =>
            Object.fromEntries(Object.entries(limits).filter(([key]) => key !== "model_scoped")),
          ),
        ),
      ).toBeNull()
      const error = {
        type: "control_response",
        response: { subtype: "error", request_id: "novadeck-usage" },
      }
      expect(usageWindows(JSON.stringify(error))).toBeNull()
      const parsed = JSON.parse(line) as Answer
      const none = { ...parsed.response.response, rate_limits: null }
      expect(
        usageWindows(
          JSON.stringify({ ...parsed, response: { ...parsed.response, response: none } }),
        ),
      ).toBeNull()
    })

    it("keeps reading past a line that isn't its answer", () => {
      expect(usageWindows('{"type":"system","subtype":"init"}')).toBeUndefined()
      expect(usageWindows("not json")).toBeUndefined()
      expect(usageWindows(line.replace('"novadeck-usage"', '"other"'))).toBeUndefined()
    })

    it("drops a window with no share used or a name no protocol takes", () => {
      const scoped = [
        { display_name: "Fable", utilization: null, resets_at: null },
        { display_name: "‮Fable", utilization: 10, resets_at: null },
        { display_name: "Opus", utilization: 10, resets_at: "soon" },
      ]
      expect(usageWindows(answer((limits) => ({ ...limits, model_scoped: scoped })))).toEqual([
        { minutes: 10_080, used: 0.1, resetsAt: null, scope: "Opus" },
      ])
    })
  })
})

describe("Claude Code's account", () => {
  const home = join("/", "home", "person")
  const install: Install = { env: {}, home, platform: "linux", plugin: "" }
  const transcript = (claudeHome: string) =>
    join(claudeHome, "projects", "-home-person-app", "s.jsonl")
  const keys = { ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined }

  it("is the person's home for a session there, or one without a transcript", () => {
    const own = join(home, ".claude")
    const theirs = { key: own, env: { CLAUDE_CONFIG_DIR: undefined, ...keys } }
    expect(limitsReading.account(install, transcript(own))).toEqual(theirs)
    expect(limitsReading.account(install, undefined)).toEqual(theirs)
  })

  it("is the home a session's transcript is in, which the program is pointed at", () => {
    const work = join(home, "claude-work")
    expect(limitsReading.account(install, transcript(work))).toEqual({
      key: work,
      env: { CLAUDE_CONFIG_DIR: work, ...keys },
    })
    // The person's own moved home, however its path is written, stays as they set it.
    const moved = { ...install, env: { CLAUDE_CONFIG_DIR: `${work}/` } }
    expect(limitsReading.account(moved, transcript(work))).toEqual({
      key: `${work}/`,
      env: { CLAUDE_CONFIG_DIR: `${work}/`, ...keys },
    })
  })

  it("names the default home by no variable, though the person's points elsewhere", () => {
    const moved = { ...install, env: { CLAUDE_CONFIG_DIR: join(home, "claude-work") } }
    expect(limitsReading.account(moved, transcript(join(home, ".claude")))).toEqual({
      key: join(home, ".claude"),
      env: { CLAUDE_CONFIG_DIR: undefined, ...keys },
    })
  })

  it("is one home on Windows whatever the case of its letters", () => {
    const windows: Install = { env: {}, home: "C:\\Users\\p", platform: "win32", plugin: "" }
    const seen = "c:\\users\\p\\.claude\\projects\\app\\s.jsonl"
    expect(limitsReading.account(windows, seen).env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })
})
