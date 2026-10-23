import { agentWorking } from "./agent-finish"
import type { ChatRequest } from "./conversation"
import type { AgentName } from "./harnesses"
import {
  ordered,
  urgency,
  type AgentAsk,
  type InboxContent,
  type InboxItem,
  type InboxSource,
  type InboxUnread,
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
// what every agent terminal waits on the person for, one item per terminal, from the
// terminals' statuses (a finished turn, unless the agent reports to a lead, its error, a
// usage limit), the messages held for
// release, the requests of the agents that ask, and what agents wrote through Novadeck's MCP
// `ask` and `tell`. The runner's Inbox and the demo's keep it current.

// How long a request's dialog may stay unread before its item shows anyway, to be answered
// in the terminal.
export const dialogMs = 3000

// A request, with when its hook started on the backend's clock.
export type Asked = { readonly request: ChatRequest; readonly askedAt: number }

// What an agent wrote through Novadeck's MCP `ask` or `tell`, from its terminal: an ask, or
// something it told the person.
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
}

export type InboxInputs = {
  readonly workspace: Workspace
  readonly unread: InboxUnread
  readonly mail: MailState
  readonly letters: readonly InboxLetter[]
  // The requests of each terminal whose detail is open, by terminal id, oldest first.
  readonly requests: Readonly<Record<string, readonly Asked[]>>
  readonly now: number
  // Whether paths on the backend's machine match whatever their case, as on macOS; a
  // Windows path always does.
  readonly caseless: boolean
  // How long a message may wait for an idle agent before its hold is raised (the protocol's
  // `longHoldMs`); null where the backend raises none, as the demo's.
  readonly longHoldMs: number | null
}

type Where = {
  readonly project: WorkspaceProject
  readonly session: WorkspaceSession
  readonly terminal: TerminalMetadata
}

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

const slashed = (path: string): string => path.replaceAll("\\", "/")

// A path inside the project's directory, relative to it; any other as it is. Separators
// match either way, and case does on Windows paths and where the machine's paths are
// `caseless`.
const relative = (directory: string, file: string, caseless: boolean): string => {
  const base = slashed(directory).replace(/\/+$/, "")
  if (base === "") return file
  const folded = caseless || /^[A-Za-z]:/.test(base)
  const same = (path: string): string => (folded ? path.toLowerCase() : path)
  const path = slashed(file)
  return same(path).startsWith(`${same(base)}/`) ? file.slice(base.length + 1) : file
}

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
// session, as messaging names a running lead: the lead hears of its finishes, so they are
// the lead's, not the person's.
const reportsToLead = ({ project, session, terminal }: Where, where: readonly Where[]): boolean =>
  !!terminal.ledBy &&
  where.some(
    (each) =>
      each.project.id === project.id &&
      each.session.id === session.id &&
      each.terminal.handle === terminal.ledBy &&
      agentOf(each.terminal) !== null,
  )

// Each terminal's candidate items, before only the most urgent is kept.
const candidates = (
  { unread, mail, requests, now, caseless, longHoldMs }: InboxInputs,
  here: Where,
  where: readonly Where[],
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

  // A request waiting on the person is the terminal's item, whatever it ended on before.
  // The oldest is the one to answer: until its dialog reads, or it has waited long enough
  // to be answered in the terminal, the terminal shows nothing.
  if (status.attention) {
    const [oldest] = requests[terminal.id] ?? []
    if (oldest && (oldest.request.dialog !== null || now - oldest.askedAt >= dialogMs))
      add(`request:${oldest.request.id}`, oldest.askedAt, true, {
        kind: "request",
        request: oldest.request,
      })
    return found
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

  const turn = status.lastTurn
  if (turn && !status.working) {
    const mark = unread[`${project.id}/${session.id}`]?.[terminal.id]
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
    } else if (turn.outcome === "failed" && mark === "failed") {
      add(`trouble:${terminal.id}:${turn.at}`, turn.at, true, {
        kind: "trouble",
        trouble: { type: "failed", error: turn.error ?? null },
      })
    } else if (mark === "done" && !reportsToLead(here, where)) {
      add(`update:${terminal.id}:${turn.at}`, turn.at, false, {
        kind: "update",
        update: {
          type: "finished",
          subject: turn.gist ?? turn.reply ?? "Finished its turn",
          reply: turn.reply ?? "",
          files: (turn.files ?? []).map((file) => relative(project.directory, file, caseless)),
        },
      })
    }
  }
  return found
}

// Every item the Inbox now holds, the longest waiting among the most urgent first: one per
// terminal, the most urgent of what it has, then the oldest; and each thread held for release.
export const inboxItems = (inputs: InboxInputs): InboxItem[] => {
  const where: Where[] = inputs.workspace.projects.flatMap((project) =>
    project.history.flatMap((session) =>
      session.state.roster.terminals.map((terminal) => ({ project, session, terminal })),
    ),
  )
  const all = where.flatMap((here) => candidates(inputs, here, where))
  for (const letter of inputs.letters) {
    const here = where.find(
      ({ project, session, terminal }) =>
        project.id === letter.projectId &&
        session.id === letter.workspaceSessionId &&
        terminal.id === letter.terminalId &&
        terminal.handle === letter.handle &&
        (letter.content.kind === "tell" || agentOf(terminal) === letter.agent),
    )
    if (!here) continue
    // A permission or plan needs the person first. While its dialog is still reading,
    // retain the request's grace period rather than showing a different question.
    if (here.terminal.state === "running" && here.terminal.agent?.attention) {
      const gate = all.find(
        (item) => item.source.terminalId === letter.terminalId && item.kind === "request",
      )
      if (!gate || gate.kind !== "request" || gate.request.kind !== "question") continue
    }
    const content: InboxContent =
      letter.content.kind === "ask"
        ? { kind: "ask", ask: letter.content.ask }
        : {
            kind: "update",
            update: { type: "told", subject: letter.content.subject, body: letter.content.body },
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

  const best = new Map<string, InboxItem>()
  for (const item of all) {
    const kept = best.get(item.source.terminalId)
    if (
      !kept ||
      urgency(item) < urgency(kept) ||
      (urgency(item) === urgency(kept) && item.at < kept.at)
    )
      best.set(item.source.terminalId, item)
  }
  // A held thread is its own item, whatever else its terminal has to show.
  return ordered([...best.values(), ...threads.values()])
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
