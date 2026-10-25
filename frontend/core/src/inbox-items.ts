import { agentWorking } from "./agent-finish"
import type { ChatRequest } from "./conversation"
import type { AgentName } from "./harnesses"
import {
  ordered,
  type AgentAsk,
  type InboxContent,
  type InboxItem,
  type InboxSource,
  type InboxTurn,
} from "./inbox"
import { companionKeyId } from "./items"
import {
  waitingFor,
  type AgentMessage,
  type MailState,
  type MailWaits,
  type MessageThread,
  type TerminalMail,
} from "./messages"
import { isAgentProgram } from "./process"
import type { TerminalMetadata, Workspace, WorkspaceProject, WorkspaceSession } from "./types"

// The Inbox's items, as a backend that builds them from the app's own state derives them:
// what every agent terminal waits on the person for, every item its own row, from the
// terminals' statuses (a usage limit), the stored failed turns (their error), the messages
// held for release, the requests of the agents that ask, and what agents wrote through
// Novadeck's MCP `ask`, `tell` and `done`. A completed turn makes no item. The runner's Inbox and the demo's keep it current.

// How long a request's dialog may stay unread before its item shows anyway, to be answered
// in the terminal.
export const dialogMs = 3000

// A request, with when its hook started on the backend's clock.
export type Asked = { readonly request: ChatRequest; readonly askedAt: number }

// What an agent wrote through Novadeck's MCP `ask`, `tell` or `done`, from its terminal: an
// ask, something it told the person, or its report that its task is done.
export type InboxLetter = {
  readonly id: string
  readonly terminalId: string
  readonly projectId: string
  readonly workspaceSessionId: string
  readonly agent: AgentName
  readonly handle: string
  readonly at: number
  readonly content:
    | { readonly kind: "ask"; readonly ask: AgentAsk }
    | { readonly kind: "tell"; readonly subject: string; readonly body: string }
    | { readonly kind: "done"; readonly subject: string; readonly body: string }
}

export type InboxInputs = {
  readonly workspace: Workspace
  // The backend's stored finished turns, read ones gone.
  readonly turns: readonly InboxTurn[]
  readonly mail: MailState
  readonly letters: readonly InboxLetter[]
  // The requests of each terminal whose detail is open, by terminal id, oldest first.
  readonly requests: Readonly<Record<string, readonly Asked[]>>
  readonly now: number
  // How long a message may wait for an idle agent before its hold is raised (the protocol's
  // `longHoldMs`); null where the backend raises none, as the demo's.
  readonly longHoldMs: number | null
}

type Where = {
  readonly project: WorkspaceProject
  readonly session: WorkspaceSession
  readonly terminal: TerminalMetadata
}

const whereOf = (workspace: Workspace): Where[] =>
  workspace.projects.flatMap((project) =>
    project.history.flatMap((session) =>
      session.state.roster.terminals.map((terminal) => ({ project, session, terminal })),
    ),
  )

const agentOf = (terminal: TerminalMetadata): AgentName | null =>
  terminal.state === "running" && isAgentProgram(terminal.process)
    ? (terminal.process as AgentName)
    : null

const sourceOf = ({ project, session, terminal }: Where, agent: AgentName): InboxSource => ({
  projectId: project.id,
  workspaceSessionId: session.id,
  terminalId: terminal.id,
  handle: terminal.handle ?? "",
  agent,
  title: terminal.name,
  projectName: project.name,
})

const heldOf = (
  thread: MessageThread,
  message: AgentMessage,
  where: Where[],
): InboxItem | undefined => {
  const named = (handle: string) => where.find(({ terminal }) => terminal.handle === handle)
  const sender = named(message.from)
  const recipient = named(message.to)
  const source = [sender, recipient].find((each) => each && agentOf(each.terminal))
  const agent = source && agentOf(source.terminal)
  if (!source || !agent) return undefined
  const person = (handle: string, found: Where | undefined) => ({
    handle,
    title: found?.terminal.name ?? handle,
  })
  return {
    id: `held:${thread.id}`,
    source: sourceOf(source, agent),
    at: message.sentAt,
    stopped: !sender || !agentWorking(sender.terminal),
    seen: false,
    kind: "held",
    held: {
      threadId: thread.id,
      from: person(message.from, sender),
      to: person(message.to, recipient),
      text: message.text,
      hop: message.hop,
      heldFor: thread.heldFor,
    },
  }
}

// The messages for a terminal's idle agent, the longest of which has waited at least
// `longHoldMs`: why the doorbell can't wake it (null where it hasn't said), since when, and
// how many (none held for the person's release or a pause, which have items and switches of
// their own).
const heldLong = (
  mail: TerminalMail | undefined,
  now: number,
  longHoldMs: number,
):
  | { readonly waits: MailWaits | null; readonly since: number; readonly count: number }
  | undefined => {
  const { waits = null, waitsSince } = mail ?? {}
  if (!mail || waitsSince == null || now - waitsSince < longHoldMs) return undefined
  const count = waitingFor(mail).filter((message) => message.state === "queued").length
  return count > 0 ? { waits, since: waitsSince, count } : undefined
}

// Whether a terminal's agent reports to a lead whose agent still runs in its project and
// session: that lead hears of its dones, so they are the lead's, not the person's. Stricter
// than messaging's running lead, a live terminal whatever runs in it, on purpose: a lead whose
// agent stopped hears nothing, so its workers' dones come to the person, once each.
const reportsToLead = ({ project, session, terminal }: Where, where: readonly Where[]): boolean =>
  !!terminal.ledBy &&
  where.some(
    (each) =>
      each.project.id === project.id &&
      each.session.id === session.id &&
      each.terminal.handle === terminal.ledBy &&
      agentOf(each.terminal) !== null,
  )

// Whether the terminal `terminalId` of the session `context` (`${projectId}/${sessionId}`)
// reports to a lead whose agent runs, as the Inbox counts: for what else tells the person of
// that terminal's finish, so it should not.
export const leadHearsOf = (workspace: Workspace, context: string, terminalId: string): boolean => {
  const where = whereOf(workspace)
  const here = where.find(
    (each) =>
      `${each.project.id}/${each.session.id}` === context && each.terminal.id === terminalId,
  )
  return !!here && reportsToLead(here, where)
}

// Each terminal's items, each its own row.
const candidates = (
  { mail, requests, now, longHoldMs }: InboxInputs,
  here: Where,
): readonly InboxItem[] => {
  const { project, session, terminal } = here
  const agent = agentOf(terminal)
  if (!agent || terminal.state !== "running" || !terminal.agent) return []
  const status = terminal.agent
  const source = sourceOf(here, agent)
  const found: InboxItem[] = []
  const add = (id: string, at: number, stopped: boolean, content: InboxContent): void => {
    found.push({ id, source, at, stopped, seen: false, ...content })
  }

  // A request waiting on the person: the oldest, as the harness asks one at a time, once its
  // dialog reads or it has waited long enough to be answered in the terminal. It hides
  // nothing else of the terminal's: one a screen or a subagent raised can stand after the
  // turn ended, beside how it ended.
  if (status.attention) {
    const [oldest] = requests[terminal.id] ?? []
    if (oldest && (oldest.request.dialog !== null || now - oldest.askedAt >= dialogMs))
      add(`request:${oldest.request.id}`, oldest.askedAt, true, {
        kind: "request",
        request: oldest.request,
      })
  }

  // Its messages held long, as only the person can clear what holds them: in the terminal.
  // Not while it works, as its status says, whatever the listing last said.
  const held =
    !status.working &&
    longHoldMs !== null &&
    heldLong(
      mail.terminals[
        companionKeyId({
          projectId: project.id,
          workspaceSessionId: session.id,
          terminalId: terminal.id,
        })
      ],
      now,
      longHoldMs,
    )
  if (held)
    add(`waits:${terminal.id}:${held.since}`, held.since, true, {
      kind: "trouble",
      trouble: { type: "waits", waits: held.waits, count: held.count },
    })

  // A usage limit is a state of the current end, not a stored row: with its window known, limit
  // trouble; limited with none found, failed trouble. It leaves when the agent works again.
  const turn = status.lastTurn
  if (turn && !status.working) {
    if (turn.limit) {
      add(`limit:${terminal.id}:${turn.at}`, turn.at, true, {
        kind: "trouble",
        trouble: {
          type: "limit",
          minutes: turn.limit.minutes ?? 0,
          resetsAt: turn.limit.resetsAt,
          autoResume: null,
          evidence: [{ text: turn.error ?? "Usage limit reached", result: null, times: 1 }],
        },
      })
    } else if (turn.limited) {
      add(`limit:${terminal.id}:${turn.at}`, turn.at, true, {
        kind: "trouble",
        trouble: { type: "failed", error: turn.error ?? null },
      })
    }
  }
  return found
}

// Every item the Inbox now holds, the longest waiting among the most urgent first: each of a
// terminal's items, and each thread held for release.
export const inboxItems = (inputs: InboxInputs): InboxItem[] => {
  const where = whereOf(inputs.workspace)
  const all = where.flatMap((here) => candidates(inputs, here))
  for (const letter of inputs.letters) {
    const here = where.find(
      ({ project, session, terminal }) =>
        project.id === letter.projectId &&
        session.id === letter.workspaceSessionId &&
        terminal.id === letter.terminalId &&
        terminal.handle === letter.handle &&
        (letter.content.kind !== "ask" || agentOf(terminal) === letter.agent),
    )
    if (!here) continue
    // A worker's done is its lead's to hear while the lead's agent runs: a team reports
    // one finish.
    if (letter.content.kind === "done" && reportsToLead(here, where)) continue
    const { content: letterContent } = letter
    const content: InboxContent =
      letterContent.kind === "ask"
        ? { kind: "ask", ask: letterContent.ask }
        : {
            kind: "update",
            update: {
              type: letterContent.kind === "done" ? "done" : "told",
              subject: letterContent.subject,
              body: letterContent.body,
            },
          }
    all.push({
      id: letter.id,
      source: sourceOf(here, letter.agent),
      at: letter.at,
      stopped: letter.content.kind === "ask" && !agentWorking(here.terminal),
      seen: false,
      ...content,
    })
  }

  // A stored failed turn shows while its terminal exists with the same handle, whatever runs
  // in it: trouble that stops the agent only while it is the terminal's current end and the
  // agent rests, and informs otherwise. A completed one makes no item: it marks its tab unread.
  for (const row of inputs.turns) {
    if (row.outcome !== "failed") continue
    const here = where.find(
      ({ project, session, terminal }) =>
        project.id === row.projectId &&
        session.id === row.workspaceSessionId &&
        terminal.id === row.terminalId &&
        (terminal.handle ?? "") === row.handle,
    )
    if (!here) continue
    const source = sourceOf(here, row.agent)
    const { terminal } = here
    const current =
      terminal.state === "running" &&
      terminal.agent?.lastTurn?.at === row.at &&
      !agentWorking(terminal)
    all.push({
      id: row.id,
      source,
      at: row.at,
      stopped: current,
      seen: false,
      kind: "trouble",
      trouble: { type: "failed", error: row.error, stored: true },
    })
  }

  // A thread held for release is listed by both its terminals: once, from its oldest
  // held message.
  const threads = new Map<string, InboxItem>()
  for (const mail of Object.values(inputs.mail.terminals))
    for (const thread of mail.threads) {
      if (!thread.held || threads.has(thread.id)) continue
      const message = thread.messages.find((each) => each.held === "release")
      const item = message && heldOf(thread, message, where)
      if (item) threads.set(thread.id, item)
    }

  // A terminal's items all show: nothing replaces or hides another.
  return ordered([...all, ...threads.values()])
}

// Items that read the same keep their old objects, so what shows them stays as it is.
export const reuse = (
  before: readonly InboxItem[],
  next: readonly InboxItem[],
): readonly InboxItem[] => {
  const old = new Map(before.map((item) => [item.id, item]))
  const items = next.map((item) => {
    const known = old.get(item.id)
    return known && JSON.stringify(known) === JSON.stringify(item) ? known : item
  })
  return items.length === before.length && items.every((item, index) => item === before[index])
    ? before
    : items
}
