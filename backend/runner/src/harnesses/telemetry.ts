import type { LimitsCover, TelemetryObserved } from "@novadeck/harness-core/events"
import { telemetryLimits, type AgentTelemetry } from "@novadeck/protocol"

import { bound, type LastTurn } from "./activity.js"
import type { Binding } from "./bindings.js"

/**
 * The bound session's tokens and quotas, as of the latest record that named them (`at`),
 * the model and effort, as of the latest that named those (`modelAt`), and its scoped
 * windows, as of the latest reading of those alone (`scopedAt`).
 */
export type Telemetry = AgentTelemetry & {
  readonly at: number
  readonly modelAt: number
  readonly scopedAt?: number
}

type Window = AgentTelemetry["limits"][number]

// Whether a record that covers `cover` speaks for `window`, so its own replace it.
const covers = (cover: LimitsCover, { scope }: Window): boolean =>
  cover === "all" ||
  (cover === "account"
    ? scope === undefined
    : cover === "scoped"
      ? scope !== undefined
      : scope === cover.scope)

/**
 * The windows after a record's: those it doesn't speak for (see `limitsCover`) and its own,
 * the account's before the models', as many as the telemetry carries.
 */
const merged = (held: readonly Window[], limits: readonly Window[], cover: LimitsCover): Window[] =>
  cover === "all"
    ? [...limits]
    : [...held.filter((window) => !covers(cover, window)), ...limits]
        // The account's own first, so models' windows never crowd them out of the cap.
        .toSorted((a, b) => Number(a.scope !== undefined) - Number(b.scope !== undefined))
        .slice(0, telemetryLimits.windows)

/**
 * A reading of some scoped windows alone, as Claude Code's usage answer is, read apart from
 * the session's records: its own clock, so it never turns away a status line made while it
 * was asked, nor they it. Undefined when it is older than the scoped windows shown.
 */
const scopedReading = (
  telemetry: Telemetry | null,
  limits: readonly Window[],
  cover: LimitsCover,
  at: number,
): Telemetry | undefined => {
  const scopedAt = telemetry?.scopedAt ?? Number.NEGATIVE_INFINITY
  if (at < scopedAt) return undefined
  return {
    context: telemetry?.context ?? null,
    limits: merged(telemetry?.limits ?? [], limits, cover),
    model: telemetry?.model ?? null,
    effort: telemetry?.effort ?? null,
    at: telemetry?.at ?? Number.NEGATIVE_INFINITY,
    modelAt: telemetry?.modelAt ?? Number.NEGATIVE_INFINITY,
    scopedAt: at,
  }
}

/**
 * The telemetry after a record, or undefined when it changes nothing: another session's,
 * or older than what is shown. A record names only what it knows; the rest stays, the
 * context's capacity too when a source that does not know it reports what it holds. A
 * record of the model alone, as Antigravity's hooks give, keeps a clock of its own, so it
 * never turns away an older snapshot of the tokens and quotas that arrives after it.
 */
export const observeTelemetry = (
  telemetry: Telemetry | null,
  binding: Binding,
  event: TelemetryObserved,
): Telemetry | undefined => {
  if (!bound(binding, event)) return undefined
  const naming = event.model !== undefined || event.effort !== undefined
  // A record of the harness's version alone says nothing of tokens, quotas or model.
  if (
    event.version !== undefined &&
    !naming &&
    event.context === undefined &&
    event.limits === undefined
  )
    return undefined
  const cover = event.limitsCover ?? "all"
  if (
    event.limits !== undefined &&
    event.context === undefined &&
    !naming &&
    (cover === "scoped" || typeof cover === "object")
  )
    return scopedReading(telemetry, event.limits, cover, event.startedAt)
  const modelOnly = naming && event.context === undefined && event.limits === undefined
  const usageAt = telemetry?.at ?? Number.NEGATIVE_INFINITY
  const modelAt = telemetry?.modelAt ?? Number.NEGATIVE_INFINITY
  const freshUsage = !modelOnly && event.startedAt >= usageAt
  const freshModel = naming && event.startedAt >= modelAt
  // A record older than the tokens and quotas shown may still name a newer model.
  if (!freshUsage && !freshModel) return undefined
  return {
    context: !freshUsage
      ? (telemetry?.context ?? null)
      : event.context === undefined
        ? (telemetry?.context ?? null)
        : event.context && event.context.capacity === null && telemetry?.context?.capacity
          ? { ...event.context, capacity: telemetry.context.capacity }
          : event.context,
    limits:
      freshUsage && event.limits
        ? merged(telemetry?.limits ?? [], event.limits, cover)
        : (telemetry?.limits ?? []),
    model: freshModel && event.model !== undefined ? event.model : (telemetry?.model ?? null),
    effort: freshModel && event.effort !== undefined ? event.effort : (telemetry?.effort ?? null),
    at: freshUsage ? event.startedAt : usageAt,
    modelAt: freshModel ? event.startedAt : modelAt,
    ...(telemetry?.scopedAt !== undefined && { scopedAt: telemetry.scopedAt }),
  }
}

/** The telemetry as clients see it. */
export const telemetrySummary = ({
  context,
  limits,
  model,
  effort,
}: Telemetry): AgentTelemetry => ({
  context,
  limits,
  model,
  effort,
})

/**
 * How long after a turn ended a record showing a window used up still counts as the turn
 * running into it. A window that fills later is the person's, not the turn's: it latches
 * nothing on a terminal idle since.
 */
export const limitGraceMs = 60_000

/**
 * The usage-limit window the last turn ran into, or null. Only a turn whose harness said it
 * failed on a limit (`limited`) has one: a window used up alone proves nothing, as
 * Antigravity's status line lists every model's buckets. The windows only tell when it
 * resets: of those with a reset to come after the turn ended, in a record made (`seenAt`)
 * by the turn's end or within `limitGraceMs` after it, the used-up one that resets last, as
 * nothing runs before it does, else the most-used one (`spent` false), which a used-up
 * window seen within the grace replaces. A model's own window, as Claude Code's weekly Fable
 * one, counts only where the session runs that model (`model`) or the turn's error names
 * it, as one used up a while ago stops no turn on another model; where none of the windows
 * counts so, as Antigravity's quotas each cover some models only, they all do. Latch it on
 * the turn (`withLimit`): it stays after the window's records move on.
 */
export const limitOf = (
  lastTurn: LastTurn | null,
  limits: readonly Window[],
  seenAt: number,
  model: string | null = null,
): { minutes: number | null; resetsAt: number; scope?: string; spent: boolean } | null => {
  if (!lastTurn?.limited || lastTurn.outcome === "interrupted") return null
  // A window used up fixes the latch; one picked as the most used gives way to it.
  if (lastTurn.limit && !lastTurn.guessed) return null
  if (seenAt > lastTurn.at + limitGraceMs) return null
  const named = (scope: string) =>
    [model, lastTurn.error].some((text) => text?.toLowerCase().includes(scope.toLowerCase()))
  const turns = limits.filter(({ scope }) => scope === undefined || named(scope))
  const ahead = (turns.length > 0 ? turns : limits).filter(
    (window): window is Window & { resetsAt: number } =>
      window.resetsAt !== null && window.resetsAt > lastTurn.at,
  )
  const spent = ahead.filter(({ used }) => used >= 1)
  if (lastTurn.limit && spent.length === 0) return null
  const pick =
    spent.length > 0
      ? spent.reduce((a, b) => (b.resetsAt > a.resetsAt ? b : a))
      : ahead.reduce<(Window & { resetsAt: number }) | null>(
          (a, b) => (!a || b.used > a.used ? b : a),
          null,
        )
  return (
    pick && {
      minutes: pick.minutes,
      resetsAt: pick.resetsAt,
      ...(pick.scope !== undefined && { scope: pick.scope }),
      spent: spent.length > 0,
    }
  )
}
