import { agentWorking } from "../model/agent-finish"
import {
  doneText,
  terminalAsk,
  terminalAsks,
  terminalPhase,
  type TerminalAsk,
} from "../model/terminal-ending"
import type { WorkspaceProject } from "../model/types"

// What a project's terminals show at a glance, the most pressing of them, as the switcher
// marks it: an agent asking the person a question, or waiting on them for a permission or
// a plan; one that finished while they looked elsewhere, its reply unread, on an error or
// on its own; or one still working. Undefined while none shows anything.
export type ProjectStatus = "question" | "attention" | "failed" | "done" | "running"

// The status of each thing a terminal asks: a permission and a plan both read as needing
// the person.
export const askStatus: Readonly<Record<TerminalAsk, ProjectStatus>> = {
  question: "question",
  permission: "attention",
  plan: "attention",
  failed: "failed",
  done: "done",
}

// Most pressing first: what terminals ask in their order, then working.
const rank: readonly ProjectStatus[] = [
  ...new Set([...terminalAsks.map((ask) => askStatus[ask]), "running" as const]),
]

const pressing = (a: ProjectStatus | undefined, b: ProjectStatus | undefined) =>
  a === undefined || (b !== undefined && rank.indexOf(b) < rank.indexOf(a)) ? b : a

// How a terminal's unread turn ended, by its session context (`${projectId}/${sessionId}`)
// and id, or undefined when none waits: where the app keeps the agents that finished
// while the person looked elsewhere.
export type UnreadEnds = (context: string, terminalId: string) => "done" | "failed" | undefined

// Each status in words, for the switcher's rows and the pins bar: the terminal tabs' own for
// the states they share.
export const statusText: Record<ProjectStatus, string> = {
  question: "Asks a question",
  attention: "Needs you",
  failed: doneText(true),
  done: doneText(),
  running: "Working",
}

// The status of each terminal is its tab's phase: an ended terminal shows nothing, as its
// tab reads ended whatever its reply was, and only an agent at work counts as running, not
// a dev server or any other program.
export const projectStatus = (
  project: WorkspaceProject,
  unread: UnreadEnds,
): ProjectStatus | undefined => {
  let status: ProjectStatus | undefined
  for (const session of project.history) {
    const context = `${project.id}/${session.id}`
    for (const terminal of session.state.roster.terminals) {
      const ask = terminalAsk(terminal, unread(context, terminal.id))
      const each: ProjectStatus | undefined = ask
        ? askStatus[ask]
        : terminalPhase(terminal) === "running" && agentWorking(terminal)
          ? "running"
          : undefined
      status = pressing(status, each)
    }
  }
  return status
}

// Whether a status asks for the person, as working on does not.
export const needsPerson = (status: ProjectStatus | undefined): boolean =>
  status !== undefined && status !== "running"

// The status of every project, by its id, that shows one.
export const projectStatuses = (
  projects: readonly WorkspaceProject[],
  unread: UnreadEnds,
): Readonly<Record<string, ProjectStatus>> => {
  const statuses: Record<string, ProjectStatus> = {}
  for (const project of projects) {
    const status = projectStatus(project, unread)
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
