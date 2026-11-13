import { join, posix, win32 } from "node:path"

import { shortName } from "@novadeck/harness-core/decode"
import type { LimitsReading } from "@novadeck/harness-core/harness"
import { beside } from "@novadeck/harness-core/paths"
import { telemetryLimits, type AgentTelemetry } from "@novadeck/protocol"

import { claudeHome } from "./home.js"

// Whether two paths name one folder on `platform`: past a trailing separator, and in any
// case on Windows.
const samePath =
  (platform: NodeJS.Platform) =>
  (a: string, b: string): boolean => {
    const rules = platform === "win32" ? win32 : posix
    const plain = (path: string) => {
      const normal = rules.normalize(path).replace(/[\\/]+$/, "")
      return platform === "win32" ? normal.toLowerCase() : normal
    }
    return plain(a) === plain(b)
  }

type Window = AgentTelemetry["limits"][number]

// The id Novadeck's ask goes by, which its answer names.
const requestId = "novadeck-usage"

// A model's own windows are weekly, as Claude Code's `/usage` calls them ("Current week
// (Fable)"), and its schema says ("Per-model weekly windows").
const weekMinutes = 10_080

// The share used, 0–100 as Claude Code says it, as a fraction; undefined where it says none.
const share = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(1, value / 100)
    : undefined

// An ISO instant, as the usage answer gives a reset, in epoch milliseconds, or null.
const instant = (value: unknown): number | null => {
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isNaN(at) ? null : at
}

// One of the answer's windows, as `scope`'s weekly one, where it says how much is used.
const window = (scope: string | undefined, utilization: unknown, resets: unknown) => {
  const used = share(utilization)
  return scope === undefined || used === undefined
    ? []
    : [{ minutes: weekMinutes, used, resetsAt: instant(resets), scope } satisfies Window]
}

/**
 * The model windows in Claude Code's answer to a `get_usage` control request, the
 * windows its `/usage` shows beside the session's and the week's (probed 2026-11-13,
 * 2.1.323, fixtures/usage.probe.json): its `rate_limits.model_scoped`, each a model's
 * weekly window, as "Current week (Fable)", by its `display_name`, with `utilization`
 * (0–100) and an ISO `resets_at`; and `seven_day_sonnet`, which `/usage` shows as "Current
 * week (Sonnet only)" for a Max or Team plan. Its five-hour and weekly windows are the
 * status line's to tell. Undefined for a line that isn't the answer; null for one that
 * tells nothing of them: an error, an account without plan limits, or an answer from
 * Claude Code's cache, which leaves `model_scoped` out. An empty list is an account with no
 * model windows.
 */
export const usageWindows = (line: string): AgentTelemetry["limits"] | null | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  const { type, response } = (parsed ?? {}) as { type?: unknown; response?: unknown }
  const { subtype, request_id: id, response: answer } = (response ?? {}) as Record<string, unknown>
  if (type !== "control_response" || id !== requestId) return undefined
  if (subtype !== "success") return null
  const { rate_limits: limits, subscription_type: plan } = (answer ?? {}) as Record<string, unknown>
  if (typeof limits !== "object" || limits === null) return null
  const { model_scoped: scoped, seven_day_sonnet: sonnet } = limits as Record<string, unknown>
  if (!Array.isArray(scoped)) return null
  const models = scoped.flatMap((each: unknown) => {
    const {
      display_name: name,
      utilization,
      resets_at: resets,
    } = (each ?? {}) as Record<string, unknown>
    return window(shortName(name, telemetryLimits.scope), utilization, resets)
  })
  // As `/usage` shows it: on a Max or Team plan, or one it can't name.
  const sonnetShown = plan === "max" || plan === "team" || plan === null
  const { utilization, resets_at: resets } = (sonnet ?? {}) as Record<string, unknown>
  const named = new Set(models.map(({ scope }) => scope))
  return [
    ...models,
    ...(sonnetShown && !named.has("Sonnet") ? window("Sonnet", utilization, resets) : []),
  ].slice(0, telemetryLimits.windows)
}

/**
 * Asking Claude Code for its model windows, which its status line leaves out: a
 * `get_usage` control request (`skip_behaviors`, as only the plan's limits are wanted)
 * written to a print-mode session that takes stream-json, sent no prompt, so no model is
 * asked and nothing is spent. Its settings, and so its hooks and plugins, aren't read, nor
 * any MCP server's, and the session isn't kept, so it runs nothing of the person's and
 * leaves no conversation (probed 2026-11-13, 2.1.323: the answer came in under half a
 * second, with no hook started). It signs in as the person's sessions do, Claude Code's
 * own login and keychain, which Novadeck never reads. `--bare` would skip the same, but
 * skips the login too. One account is one Claude Code home: the folder a session's
 * transcript is in (`<home>/projects/<project>/<session>.jsonl`), else the person's; a home
 * other than theirs is named in `CLAUDE_CONFIG_DIR`, as the session's own was, and the
 * default one by none.
 */
export const limitsReading: LimitsReading = {
  args: [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "",
    "--no-session-persistence",
    "--strict-mcp-config",
  ],
  input: `${JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "get_usage", skip_behaviors: true },
  })}\n`,
  read: usageWindows,
  cover: "scoped",
  account: (install, transcript) => {
    const same = samePath(install.platform)
    const own = claudeHome(install)
    const [plans] = transcript ? beside(transcript, "projects", "plans") : []
    const home = plans ? plans.slice(0, -"plans".length - 1) : own
    const folder = same(home, own)
      ? install.env.CLAUDE_CONFIG_DIR
      : // The default home is named by no variable, as `CLAUDE_CONFIG_DIR` set to it would
        // move Claude Code's own settings file into it.
        same(home, join(install.home, ".claude"))
        ? undefined
        : home
    return {
      key: same(home, own) ? own : home,
      // Its sessions' status lines told a subscription's limits; a key in the person's
      // environment, which a session can decline but print mode always takes, would answer
      // for another account.
      env: {
        CLAUDE_CONFIG_DIR: folder,
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
      },
    }
  },
}
