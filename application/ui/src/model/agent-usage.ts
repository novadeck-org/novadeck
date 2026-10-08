import type { AgentUsage, TerminalMetadata } from "./types"

// A window's length as people say it: "5h", "7d", or minutes when neither fits.
export const windowName = (minutes: number | null): string => {
  if (minutes === null) return "limit"
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`

// Thousands of tokens, the way agents themselves show them: 30k, 1.2M.
const tokens = (count: number): string =>
  count >= 1_000_000
    ? `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
    : count >= 1000
      ? `${Math.round(count / 1000)}k`
      : String(count)

const usageOf = (terminal: TerminalMetadata): AgentUsage | undefined =>
  terminal.state === "running" ? terminal.agent?.usage : undefined

// What its window says of the agent by its buttons: the model it runs and its effort,
// where its harness says, and how full its context is, as a share where its capacity is
// known, with the tokens it holds of how many, and all of it in words. Undefined without
// any.
export type AgentStats = {
  readonly model: string | null
  readonly effort: string | null
  readonly context: {
    readonly share: number | null
    readonly label: string
    readonly tokens: string
    readonly detail: string
  } | null
}

export const agentStats = (terminal: TerminalMetadata): AgentStats | undefined => {
  const usage = usageOf(terminal)
  if (!usage) return undefined
  const { model, effort, context } = usage
  if (!model && !effort && !context) return undefined
  return {
    model,
    effort,
    context: context && {
      share: context.capacity ? Math.min(1, context.occupied / context.capacity) : null,
      label: context.capacity
        ? percent(context.occupied / context.capacity)
        : tokens(context.occupied),
      tokens: context.capacity
        ? `${tokens(context.occupied)}/${tokens(context.capacity)}`
        : tokens(context.occupied),
      detail: context.capacity
        ? `Context ${percent(context.occupied / context.capacity)} full · ${tokens(context.occupied)} of ${tokens(context.capacity)} tokens`
        : `Context: ${tokens(context.occupied)} tokens`,
    },
  }
}
