import { clockTime, wakeFill, type Waiting } from "@novadeck/core/agent-waiting"
import { minutesWaited, wakeIn } from "@novadeck/core/agent-waiting-clock"
import type { TerminalMetadata } from "@novadeck/core/types"

import { useSecond } from "./use-second"

// How many rows a tab's waiting lists before it counts the rest on the last.
const waitRows = 3

// What an agent's tab shows of a job it waits on, beside it in a row (tabs.css): a dripping
// column for a job, a glyph that fills as the time nears for a wake-up.
type Row = {
  readonly key: string
  readonly kind: "job" | "wake"
  readonly label: string
  // How long the job has run, or when the wake-up is.
  readonly trail: string
  readonly fill?: number
}

const rowsOf = (waiting: Waiting, fill: number): Row[] => {
  const rows: Row[] = waiting.jobs.map((job) => ({
    key: job.id,
    kind: "job",
    label: job.label,
    trail: minutesWaited(job.since),
  }))
  if (waiting.wake)
    rows.push({
      key: "wake",
      kind: "wake",
      label: waiting.wake.reason ?? "Wake-up",
      trail: clockTime(waiting.wake.at),
      fill,
    })
  return rows.length > waitRows
    ? [
        ...rows.slice(0, waitRows - 1),
        {
          key: "more",
          kind: "job",
          label: `+${rows.length - waitRows + 1} more`,
          trail: "",
        },
      ]
    : rows
}

// The jobs a waiting agent's tab lists under its line, as a tree from the agent like its
// subagents: each one's glyph, its description cut to fit and how long it has run; a
// wake-up's reason and time. The tab's description says them in words.
export const WaitingBranches = ({
  terminal,
  waiting,
}: {
  terminal: TerminalMetadata
  waiting: Waiting
}): React.JSX.Element => {
  const rows = rowsOf(waiting, wakeFill(terminal))
  return (
    <span aria-hidden className="terminal-tab-branches terminal-tab-waits -mt-1 grid min-w-0">
      <span className="terminal-tab-branches-fold min-h-0 overflow-hidden">
        <span className="flex min-w-0 flex-col pt-1 text-caption leading-[18px]">
          {rows.map((row, place) => (
            <span key={row.key} className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
              <span className="terminal-tab-branch shrink-0">
                {place === rows.length - 1 ? "└" : "├"}
              </span>
              {row.key === "more" ? (
                <span className="inline-block w-[1ch] shrink-0" />
              ) : (
                <span
                  className="terminal-tab-wait inline-block w-[1ch] shrink-0 text-center"
                  data-wait={row.kind}
                  {...(row.fill === undefined ? {} : { "data-wake-fill": row.fill })}
                />
              )}
              <span className="truncate">{row.label}</span>
              {row.trail && <span className="terminal-tab-wait-trail shrink-0">{row.trail}</span>}
            </span>
          ))}
        </span>
      </span>
    </span>
  )
}

// A faint trace under an idle agent's tab of the wake-up that passed with no new turn,
// "wake passed 14:32", in the place its waiting was.
export const WakePassed = ({ time }: { time: string }): React.JSX.Element => (
  <span aria-hidden className="terminal-tab-branches terminal-tab-passed -mt-1 grid min-w-0">
    <span className="terminal-tab-branches-fold min-h-0 overflow-hidden">
      <span className="flex min-w-0 pt-1 text-caption leading-[18px]">
        <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          <span className="terminal-tab-branch shrink-0">└</span>
          <span className="truncate">wake passed {time}</span>
        </span>
      </span>
    </span>
  </span>
)

// What the hover card over a waiting tab says: how long it has waited, in the agent's own
// words what on, the command in mono, when it wakes, and that a message still reaches it.
export const WaitingPeek = ({ waiting }: { waiting: Waiting }): React.JSX.Element => {
  // Open, it keeps the wake-up's countdown and the minutes current.
  useSecond(true)
  return (
    <div className="terminal-tab-peek flex flex-col gap-2">
      {waiting.jobs.map((job) => (
        <div key={job.id} className="flex flex-col gap-0.5">
          <strong>Waiting · {minutesWaited(job.since)}</strong>
          <span>{job.label}</span>
          {job.command && job.label !== job.command && (
            <code className="terminal-tab-peek-command">{job.command}</code>
          )}
          <span className="terminal-tab-peek-note">
            {job.until === null
              ? "Wakes when it finishes."
              : `Wakes when it finishes, or gives up at ${clockTime(job.until)}.`}
          </span>
        </div>
      ))}
      {waiting.wake && (
        <div className="flex flex-col gap-0.5">
          <strong>
            Wakes at {clockTime(waiting.wake.at)} · {wakeIn(waiting.wake.at)}
          </strong>
          {waiting.wake.reason && <span>{waiting.wake.reason}</span>}
          <span className="terminal-tab-peek-note">A wake-up it set.</span>
        </div>
      )}
      <span className="terminal-tab-peek-note">A message still reaches it.</span>
    </div>
  )
}
