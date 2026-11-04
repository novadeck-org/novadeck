import { agentWorking } from "@novadeck/core/agents/finish"
import type { InboxRow } from "@novadeck/core/inbox"
import { inboxMarks } from "@novadeck/core/inbox/marks"
import { doneText, terminalGlance } from "@novadeck/core/terminals/ending"
import { waitingOf, wakeGraceMs } from "@novadeck/core/terminals/waiting"
import type { TerminalMetadata, WorkspaceProject } from "@novadeck/core/types"

// What a project's terminals show at a glance, the most pressing of them, as the switcher
// marks it, as their tabs do: an agent that asks the person a question (the tab's `?`, the
// Inbox's `ask`) or is blocked on them for a permission, a plan or an action (its `!`, the
// Inbox's `unblock`); one that failed while they looked elsewhere; one paused at its usage
// limit; one still working; one that ended its turn to wait on a job or a wake-up; one whose
// report of its task done still stands; or one Novadeck can't hear from. Undefined while none
// shows anything.
export type ProjectStatus =
  | "ask"
  | "unblock"
  | "failed"
  | "paused"
  | "running"
  | "waiting"
  | "done"
  | "unheard"

// Most pressing first: what blocks an agent before what it asks, then a failure, then a limit
// hit (which the person may want to know of while the rest works on), then an agent at work
// and one that waits to be woken before a done report, so a project reads done only once none
// of it works on or waits to; an agent nothing tells of comes last, as anything known outranks
// it.
const rank: readonly ProjectStatus[] = [
  "unblock",
  "ask",
  "failed",
  "paused",
  "running",
  "waiting",
  "done",
  "unheard",
]

const pressing = (a: ProjectStatus | undefined, b: ProjectStatus | undefined) =>
  a === undefined || (b !== undefined && rank.indexOf(b) < rank.indexOf(a)) ? b : a

// How a terminal's unread turn ended, by its session context (`${projectId}/${sessionId}`)
// and id, or undefined when none waits: where the app keeps the turns the person hasn't read.
export type UnreadEnds = (context: string, terminalId: string) => "unread" | "failed" | undefined

// Each status in words, for the switcher's rows and the pins bar: the terminal tabs' own for
// the states they share.
export const statusText: Record<ProjectStatus, string> = {
  ask: "Asks a question",
  unblock: "Needs you",
  failed: doneText(true),
  paused: "Paused at its usage limit",
  running: "Working",
  waiting: "Waits on a job or a wake-up",
  done: doneText(),
  unheard: "Not reporting",
}

// The status of each terminal is what its tab shows: its need (the Inbox's raw `items`, as
// the tab reads them, and the dialog its agent shows now), an unread turn that failed, a
// done report that stands, or its agent's phase: paused at its limit, at work, waiting, or
// unheard. An ended terminal shows nothing, as its tab reads ended, and only an agent at work
// counts as running, not a dev server or any other program: a shell's own program is no
// status, so a project never spins for a server left running.
const terminalStatus = (
  project: WorkspaceProject,
  sessionId: string,
  terminal: TerminalMetadata,
  unread: UnreadEnds,
  rows: readonly InboxRow[],
  now: number,
): ProjectStatus | undefined => {
  if (terminal.state === "exited" || terminal.state === "failed") return undefined
  const at = { projectId: project.id, workspaceSessionId: sessionId, terminalId: terminal.id }
  const { need, phase, failed } = terminalGlance(
    terminal,
    inboxMarks(rows, at, now),
    unread(`${project.id}/${sessionId}`, terminal.id),
    now,
  )
  return (
    need ??
    (phase === "done"
      ? failed
        ? "failed"
        : "done"
      : phase === "running"
        ? agentWorking(terminal)
          ? "running"
          : undefined
        : phase === "paused" || phase === "waiting" || phase === "unheard"
          ? phase
          : undefined)
  )
}

// The most pressing status among a project's terminals that `counts`.
const mostPressing = (
  project: WorkspaceProject,
  unread: UnreadEnds,
  rows: readonly InboxRow[],
  now: number,
  counts: (status: ProjectStatus) => boolean,
): ProjectStatus | undefined => {
  let status: ProjectStatus | undefined
  for (const session of project.history)
    for (const terminal of session.state.roster.terminals) {
      const each = terminalStatus(project, session.id, terminal, unread, rows, now)
      if (each !== undefined && counts(each)) status = pressing(status, each)
    }
  return status
}

const any = (): boolean => true

// What a project's terminals show: the most pressing status among them, which the
// switcher's rows and the pins bar mark.
export const projectStatus = (
  project: WorkspaceProject,
  unread: UnreadEnds,
  rows: readonly InboxRow[] = [],
  now = Date.now(),
): ProjectStatus | undefined => mostPressing(project, unread, rows, now, any)

// What a project's terminals ask of the person: the most pressing status among them that
// does, which the switcher's dot reads, so a done report under an agent paused at its limit
// or waiting to be woken still lights it, as its mark shows the quieter state.
export const projectAsk = (
  project: WorkspaceProject,
  unread: UnreadEnds,
  rows: readonly InboxRow[] = [],
  now = Date.now(),
): ProjectStatus | undefined => mostPressing(project, unread, rows, now, needsPerson)

// Whether an agent is at work in any of the projects, in any of their sessions.
export const anyAgentWorking = (projects: readonly WorkspaceProject[]): boolean =>
  projects.some(({ history }) =>
    history.some(({ state }) => state.roster.terminals.some(agentWorking)),
  )

// Whether a status asks for the person: what an agent needs, a failure or a done report, as
// one at work, paused, waiting or unheard does not.
const asksForPerson: ReadonlySet<ProjectStatus> = new Set(["unblock", "ask", "failed", "done"])
export const needsPerson = (status: ProjectStatus | undefined): boolean =>
  status !== undefined && asksForPerson.has(status)

const byProject = (
  projects: readonly WorkspaceProject[],
  each: (project: WorkspaceProject) => ProjectStatus | undefined,
): Readonly<Record<string, ProjectStatus>> => {
  const statuses: Record<string, ProjectStatus> = {}
  for (const project of projects) {
    const status = each(project)
    if (status) statuses[project.id] = status
  }
  return statuses
}

// The status of every project, by its id, that shows one.
export const projectStatuses = (
  projects: readonly WorkspaceProject[],
  unread: UnreadEnds,
  rows: readonly InboxRow[] = [],
  now = Date.now(),
): Readonly<Record<string, ProjectStatus>> =>
  byProject(projects, (project) => projectStatus(project, unread, rows, now))

// What every project asks of the person, by its id, where one asks anything.
export const projectAsks = (
  projects: readonly WorkspaceProject[],
  unread: UnreadEnds,
  rows: readonly InboxRow[] = [],
  now = Date.now(),
): Readonly<Record<string, ProjectStatus>> =>
  byProject(projects, (project) => projectAsk(project, unread, rows, now))

// When a project's status next changes by time alone, so a view can read them again then:
// the grace after a job an agent's harness gives up on, or after its wake-up, passing,
// which ends its wait. Undefined while nothing waits that way; a limit resetting is the
// Inbox's (`nextLimitReset`), and the needs it makes are read from its rows.
export const nextStatusChange = (
  projects: readonly WorkspaceProject[],
  now = Date.now(),
): number | undefined => {
  let soonest: number | undefined
  for (const { history } of projects)
    for (const { state } of history)
      for (const terminal of state.roster.terminals) {
        const waiting = waitingOf(terminal, now)
        if (!waiting) continue
        const ends = waiting.jobs
          .filter((job) => job.until !== null)
          .map((job) => job.until! + wakeGraceMs)
        if (waiting.wake) ends.push(waiting.wake.at + wakeGraceMs)
        for (const at of ends) if (soonest === undefined || at < soonest) soonest = at
      }
  return soonest
}

// The most pressing among what the projects other than `current` and the `ignore`d ones
// ask of the person (`projectAsks`): what the switcher's button marks.
export const elsewhereStatus = (
  asks: Readonly<Record<string, ProjectStatus>>,
  current: string,
  ignore: readonly string[],
): ProjectStatus | undefined => {
  let status: ProjectStatus | undefined
  for (const [id, each] of Object.entries(asks))
    if (id !== current && !ignore.includes(id) && needsPerson(each)) status = pressing(status, each)
  return status
}
