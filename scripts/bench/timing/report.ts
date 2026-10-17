// The timing run's report: what it measured, summed up as the numbers kept as a trend (switch
// p90, steady main-thread share, frames over 33 ms), with the samples behind them. A run that
// failed part way still writes one, with what it got and why it stopped.

/** One steady window: a layout with every agent busy, measured over `seconds`. */
export type Steady = {
  readonly layout: "Grid" | "Focus"
  readonly seconds: number
  /** The main thread's busy time over the window, from Chromium's TaskDuration. */
  readonly taskSeconds: number
  /** The gaps between animation frames, in milliseconds. */
  readonly frameGaps: readonly number[]
  /** The long tasks' durations, in milliseconds. */
  readonly longTasks: readonly number[]
}

/** One switch: from a click on a terminal's row to its screen painted. */
export type Switch = {
  readonly target: number
  /** Milliseconds from the click to the paint; undefined where it never painted. */
  readonly ms: number | undefined
}

export type Measured = {
  /**
   * The agents' terminals' phases once every agent is busy: `running` where the runner
   * hears its hooks, `unheard` where it doesn't, which would make the run measure no
   * telemetry at all.
   */
  readonly agentPhases: readonly (string | null)[]
  readonly steady: readonly Steady[]
  readonly switches: readonly Switch[]
}

export type Report = {
  readonly version: 1
  readonly startedAt: string
  readonly finishedAt: string
  readonly commit: string | undefined
  readonly environment: Readonly<Record<string, string | number>>
  readonly scenario: Readonly<Record<string, unknown>>
  readonly summary: {
    readonly switchP50Ms: number | null
    readonly switchP90Ms: number | null
    readonly switchesTimedOut: number
    /** How many of the agents the runner heard, of `scenario.agents`. */
    readonly agentsHeard: number
    readonly steady: readonly {
      readonly layout: Steady["layout"]
      readonly mainThreadShare: number
      readonly fps: number
      readonly framesOver33ms: number
      readonly longTasks: number
    }[]
  }
  readonly samples: Measured
  /**
   * What went wrong inside the sandbox: processes it had to end once the run was over, and
   * the developer's home written to from inside it. Empty on a clean run.
   */
  readonly problems: readonly string[]
  /** Why the run stopped short, when it did; the summary then covers what it got. */
  readonly error?: string
}

/** The value below which `fraction` of `values` fall (nearest rank), or null for none. */
export const percentile = (values: readonly number[], fraction: number): number | null => {
  if (values.length === 0) return null
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? null
}

const round = (value: number, places = 1) => Number(value.toFixed(places))

/** The numbers a run's samples come to. */
export const summarize = (measured: Measured): Report["summary"] => {
  const painted = measured.switches.flatMap(({ ms }) => (ms === undefined ? [] : [ms]))
  const at = (fraction: number) => {
    const value = percentile(painted, fraction)
    return value === null ? null : round(value)
  }
  return {
    switchP50Ms: at(0.5),
    switchP90Ms: at(0.9),
    switchesTimedOut: measured.switches.length - painted.length,
    agentsHeard: measured.agentPhases.filter((phase) => phase === "running").length,
    steady: measured.steady.map((window) => ({
      layout: window.layout,
      mainThreadShare: round((window.taskSeconds / window.seconds) * 100),
      // No frame at all is none a second, whatever the window.
      fps:
        window.frameGaps.length === 0 ? 0 : round((window.frameGaps.length + 1) / window.seconds),
      framesOver33ms: window.frameGaps.filter((gap) => gap > 33).length,
      longTasks: window.longTasks.length,
    })),
  }
}
