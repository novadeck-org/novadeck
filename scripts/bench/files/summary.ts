import type { Config } from "./scenario.ts"

// The Files bench's numbers: what the page measures for each poll, and the figures kept per run.

/** What the page and Chromium measured for one poll (or one turn end). */
export type Sample = {
  /** The first event (or the turn) to the frame painted once nothing was left to do, in ms. */
  readonly wallMs: number
  /** The main thread's busy time over it, Chromium's TaskDuration, in ms. */
  readonly busyMs: number
  /** The part of it spent running script, and in style and layout. */
  readonly scriptMs: number
  readonly layoutMs: number
  readonly styleMs: number
  /** The long tasks (50 ms and over) of the page over it, durations in ms. */
  readonly longTasks: readonly number[]
  /** React commits, and the time React says they took to render. */
  readonly commits: number
  readonly reactMs: number
  /** Folder reads the panel asked its reader for. */
  readonly reads: number
  /** The tree's rows in the document once settled: a fact, not the work done. */
  readonly rows: number
}

/** What the page itself measures of a poll; the bench adds Chromium's main-thread time. */
export type Timed = Omit<Sample, "busyMs" | "scriptMs" | "layoutMs" | "styleMs">

/** The page's handle, as `window.bench`. */
export type Bench = {
  readonly ready: Promise<void>
  /** Feeds poll `poll`'s events and resolves once the panel has settled. */
  readonly poll: (poll: number) => Promise<Timed>
  /** Ends an agent turn, so the open folders are read again; resolves once settled. */
  readonly turn: () => Promise<Timed>
}

/** The nearest-rank percentile of `values` (`fraction` 0 to 1), null with none. */
export const percentile = (values: readonly number[], fraction: number): number | null => {
  if (values.length === 0) return null
  const sorted = values.toSorted((a, b) => a - b)
  const rank = Math.max(1, Math.ceil(fraction * sorted.length))
  return sorted[Math.min(rank, sorted.length) - 1]!
}

export type Spread = { readonly median: number | null; readonly p95: number | null }

const spread = (values: readonly number[]): Spread => ({
  median: percentile(values, 0.5),
  p95: percentile(values, 0.95),
})

export type Summary = {
  readonly count: number
  readonly wallMs: Spread
  readonly busyMs: Spread
  readonly scriptMs: Spread
  readonly layoutMs: Spread
  readonly styleMs: Spread
  readonly commits: Spread
  readonly reactMs: Spread
  readonly reads: Spread
  /** Long tasks over all the samples, and the longest. */
  readonly longTasks: { readonly count: number; readonly totalMs: number; readonly maxMs: number }
  readonly rows: number | null
}

export const summarize = (samples: readonly Sample[]): Summary => {
  const each = (pick: (sample: Sample) => number) => spread(samples.map(pick))
  const tasks = samples.flatMap((sample) => sample.longTasks)
  return {
    count: samples.length,
    wallMs: each((sample) => sample.wallMs),
    busyMs: each((sample) => sample.busyMs),
    scriptMs: each((sample) => sample.scriptMs),
    layoutMs: each((sample) => sample.layoutMs),
    styleMs: each((sample) => sample.styleMs),
    commits: each((sample) => sample.commits),
    reactMs: each((sample) => sample.reactMs),
    reads: each((sample) => sample.reads),
    longTasks: {
      count: tasks.length,
      totalMs: tasks.reduce((sum, task) => sum + task, 0),
      maxMs: tasks.reduce((most, task) => Math.max(most, task), 0),
    },
    rows: samples.at(-1)?.rows ?? null,
  }
}

export type Report = {
  readonly version: 1
  readonly label: string
  readonly startedAt: string
  readonly commit: string | undefined
  readonly environment: Readonly<Record<string, string | number>>
  readonly config: Config
  readonly polls: readonly Sample[]
  readonly turns: readonly Sample[]
  readonly summary: { readonly polls: Summary; readonly turns: Summary | null }
}

const number = (value: number | null, digits = 1): string =>
  value === null ? "-" : value.toFixed(digits)

const row = (name: string, summary: Summary): string => {
  const cells = [
    summary.wallMs,
    summary.busyMs,
    summary.scriptMs,
    summary.layoutMs,
    summary.commits,
    summary.reactMs,
  ].map(
    (each, place) =>
      `${number(each.median, place === 4 ? 0 : 1)} / ${number(each.p95, place === 4 ? 0 : 1)}`,
  )
  const { longTasks } = summary
  return `| ${name} | ${cells.join(" | ")} | ${longTasks.count} (${number(longTasks.totalMs, 0)} ms) | ${number(summary.reads.median, 0)} | ${summary.rows ?? "-"} |`
}

/** A short markdown summary of a run: median / p95 per poll, as a table. */
export const markdown = (report: Report): string => {
  const { config } = report
  const lines = [
    `# Files panel bench: ${report.label}`,
    "",
    `Commit ${report.commit?.slice(0, 9) ?? "unknown"}, ${report.environment["cpu"] ?? "?"} (${report.environment["cpus"] ?? "?"} cpus), Chromium ${report.environment["chromium"] ?? "?"}, headless. Load average ${report.environment["loadBefore"] ?? "?"} before, ${report.environment["loadAfter"] ?? "?"} after; the idle page is busy ${report.environment["idleBusyMs"] ?? "?"} ms a second.`,
    `${config.folders} folders, ${config.files} files, ${config.worktrees} worktrees, ${config.changed} changed per poll x ${config.filesPerWorktree} files, ${report.polls.length} polls (${config.warmup} warm-up not counted).`,
    "",
    "Each cell is median / p95 per poll. Wall is the first event to the settled frame; busy, script and layout are Chromium's main-thread time over it.",
    "",
    "| | wall ms | busy ms | script ms | layout ms | commits | react ms | long tasks | reads | rows |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    row("poll", report.summary.polls),
  ]
  if (report.summary.turns) lines.push(row("turn end", report.summary.turns))
  lines.push("")
  return lines.join("\n")
}
