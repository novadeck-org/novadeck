// The timing run's report: what it measured, summed up as the numbers kept as a trend (switch
// p90, steady main-thread share, frames over 33 ms), with the samples behind them. A run that
// failed part way still writes one, with what it got and why it stopped.

/** One steady window: a layout with every agent busy, measured over `seconds`. */
export type Steady = {
  readonly layout: "Grid" | "Focus"
  readonly seconds: number
  /** The main thread's busy time over the window, from Chromium's TaskDuration. */
  readonly taskSeconds: number
  /** The page's frames over the window, from a trace of it (see `windowFrames`). */
  readonly frames: number
  /** The frames the main thread took over 33 ms to answer once asked for them. */
  readonly slowFrames: number
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
    /**
     * Where the steady windows' frames come from. A report without this field is from before
     * the timing run read them from a trace: its frames came from an animation frame requested
     * all the time, which loaded the main thread it measured, so its `mainThreadShare`,
     * `fps`, `framesOver33ms` and `longTasks` don't compare with a report that has it.
     */
    readonly framesFrom: "trace"
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

/**
 * Why a run's scenario didn't hold, so that its numbers measure something other than the
 * scenario: agents the runner never heard running (their windows are as quiet as an idle
 * app's) or most of the switches never painting (their times are the wait's). Empty when it
 * held. A run that fails on these can't pass for a trend with a scenario that has quietly
 * stopped working.
 */
export const scenarioFailures = (
  measured: Pick<Measured, "agentPhases" | "switches">,
  agents: number,
): string[] => {
  const heard = measured.agentPhases.filter((phase) => phase === "running").length
  const timedOut = measured.switches.filter(({ ms }) => ms === undefined).length
  return [
    ...(heard < agents
      ? [
          `the scenario didn't hold: ${heard} of ${agents} agents were running (phases: ${measured.agentPhases.map(String).join(", ") || "none"})`,
        ]
      : []),
    ...(measured.switches.length > 0 && timedOut * 2 > measured.switches.length
      ? [
          `the scenario didn't hold: ${timedOut} of ${measured.switches.length} switches never painted`,
        ]
      : []),
  ]
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
    framesFrom: "trace",
    switchP50Ms: at(0.5),
    switchP90Ms: at(0.9),
    switchesTimedOut: measured.switches.length - painted.length,
    agentsHeard: measured.agentPhases.filter((phase) => phase === "running").length,
    steady: measured.steady.map((window) => ({
      layout: window.layout,
      mainThreadShare: round((window.taskSeconds / window.seconds) * 100),
      fps: window.seconds > 0 ? round(window.frames / window.seconds) : 0,
      framesOver33ms: window.slowFrames,
      longTasks: window.longTasks.length,
    })),
  }
}
