import { agentWorking } from "@novadeck/core/agent-finish"
import type { InboxRow } from "@novadeck/core/inbox"
import { inboxMarks } from "@novadeck/core/inbox-marks"
import { doneText, terminalGlance } from "@novadeck/core/terminal-ending"
import type { WorkspaceProject } from "@novadeck/core/types"

// What a project's terminals show at a glance, the most pressing of them, as the switcher
// marks it, as their tabs do: an agent that asks the person a question (the tab's `?`, the
// Inbox's `ask`) or is blocked on them for a permission, a plan or an action (its `!`, the
// Inbox's `unblock`); one that failed while they looked elsewhere; one that reported its task
// done, unseen; or one still working. Undefined while none shows anything.
export type ProjectStatus = "ask" | "unblock" | "failed" | "done" | "running"

// Most pressing first: what blocks an agent before what it asks.
const rank: readonly ProjectStatus[] = ["unblock", "ask", "failed", "done", "running"]

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
  done: doneText(),
  running: "Working",
}

// The status of each terminal is what its tab shows: its need (the Inbox's raw `items`, as
// the tab reads them, and the dialog its agent shows now), an unread turn that failed, an
// unseen done report, or an agent at work. An ended terminal shows nothing, as its tab reads
// ended, and only an agent at work counts as running, not a dev server or any other program.
export const projectStatus = (
  project: WorkspaceProject,
  unread: UnreadEnds,
  items: readonly InboxRow[] = [],
  now = Date.now(),
): ProjectStatus | undefined => {
  let status: ProjectStatus | undefined
  for (const session of project.history) {
    const context = `${project.id}/${session.id}`
    for (const terminal of session.state.roster.terminals) {
      if (terminal.state === "exited" || terminal.state === "failed") continue
      const at = {
        projectId: project.id,
        workspaceSessionId: session.id,
        terminalId: terminal.id,
      }
      const { need, phase, failed } = terminalGlance(
        terminal,
        inboxMarks(items, at, now),
        unread(context, terminal.id),
        now,
      )
      const each: ProjectStatus | undefined =
        need ??
        (phase === "done"
          ? failed
            ? "failed"
            : "done"
          : phase === "running" && agentWorking(terminal)
            ? "running"
            : undefined)
      status = pressing(status, each)
    }
  }
  return status
}

// Whether an agent is at work in any of the projects, in any of their sessions.
export const anyAgentWorking = (projects: readonly WorkspaceProject[]): boolean =>
  projects.some(({ history }) =>
    history.some(({ state }) => state.roster.terminals.some(agentWorking)),
  )

// Whether a status asks for the person, as working on does not.
export const needsPerson = (status: ProjectStatus | undefined): boolean =>
  status !== undefined && status !== "running"

// The status of every project, by its id, that shows one.
export const projectStatuses = (
  projects: readonly WorkspaceProject[],
  unread: UnreadEnds,
  items: readonly InboxRow[] = [],
  now = Date.now(),
): Readonly<Record<string, ProjectStatus>> => {
  const statuses: Record<string, ProjectStatus> = {}
  for (const project of projects) {
    const status = projectStatus(project, unread, items, now)
    if (status) statuses[project.id] = status
  }
  return statuses
}

// The most pressing status among the projects other than `current` and the `ignore`d ones
// that ask for the person: what the switcher's button marks.
export const elsewhereStatus = (
  statuses: Readonly<Record<string, ProjectStatus>>,
  current: string,
  ignore: readonly string[],
): ProjectStatus | undefined => {
  let status: ProjectStatus | undefined
  for (const [id, each] of Object.entries(statuses))
    if (id !== current && !ignore.includes(id) && needsPerson(each)) status = pressing(status, each)
  return status
}
