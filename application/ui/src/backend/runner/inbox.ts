import type { AgentDetail } from "@novadeck/protocol"

import { agentWorking } from "../../model/agent-finish"
import type { ChatAnswer, ChatRequest, ConversationKey } from "../../model/conversation"
import type { AgentName } from "../../model/harnesses"
import {
  emptyInbox,
  ordered,
  urgency,
  type Inbox,
  type InboxAnswer,
  type InboxBinding,
  type InboxContent,
  type InboxItem,
  type InboxSource,
  type InboxState,
  type InboxUnread,
} from "../../model/inbox"
import type { AgentMessage, MailState, MessageThread } from "../../model/messages"
import { isAgentProgram } from "../../model/process"
import { createStore, type Store } from "../../model/store"
import type {
  TerminalMetadata,
  Workspace,
  WorkspaceProject,
  WorkspaceSession,
} from "../../model/types"
import { requestOf } from "./conversations"
import { currentPlatform } from "./platform"

// The runner's Inbox: what every agent terminal waits on the person for, one item per
// terminal, built from what the UI already has: the terminals' statuses (a finished turn,
// its error, a usage limit), the messages held for release, and the requests of the agents
// that ask (read from `agents.detail`, opened only while one waits). `inboxItems` is the
// pure derivation; `createRunnerInbox` keeps it current and answers through the runner.

// How long a request's dialog may stay unread before its item shows anyway, to be answered
// in the terminal.
export const dialogMs = 3000
// How long a terminal's detail stays open once nothing waits on it, so a request that
// comes straight after is not missed, and how soon a lost one is opened again.
export const detailGraceMs = 5000
export const retryMs = 1000
const retryCapMs = 10_000
// How long an answer to trouble may leave its item standing before it can be answered again.
// Antigravity marks a turn's start at its first model call, which can take a while.
export const settleMs = 15_000

// A request, with when its hook started on the runner's clock.
export type Asked = { readonly request: ChatRequest; readonly askedAt: number }

export type InboxInputs = {
  readonly workspace: Workspace
  readonly unread: InboxUnread
  readonly mail: MailState
  // The requests of each terminal whose detail is open, by terminal id, oldest first.
  readonly requests: Readonly<Record<string, readonly Asked[]>>
  readonly now: number
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
// match either way, and case does on Windows paths and on macOS.
const relative = (directory: string, file: string): string => {
  const base = slashed(directory).replace(/\/+$/, "")
  if (base === "") return file
  const folded = currentPlatform() === "mac" || /^[A-Za-z]:/.test(base)
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
      allowed: thread.allowed,
    },
  }
}

// Each terminal's candidate items, before only the most urgent is kept.
const candidates = ({ unread, requests, now }: InboxInputs, here: Where): readonly InboxItem[] => {
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
    } else if (mark === "done") {
      add(`update:${terminal.id}:${turn.at}`, turn.at, false, {
        kind: "update",
        update: {
          type: "finished",
          subject: turn.gist ?? turn.reply ?? "Finished its turn",
          reply: turn.reply ?? "",
          files: (turn.files ?? []).map((file) => relative(project.directory, file)),
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
  const all = where.flatMap((here) => candidates(inputs, here))

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

// The streams and calls the Inbox needs of the runner.
export type InboxStreams = {
  readonly detail: (terminalId: string) => AsyncIterableIterator<AgentDetail, undefined>
  readonly answer: (key: ConversationKey, request: string, answer: ChatAnswer) => Promise<void>
  readonly send: (key: ConversationKey, text: string) => Promise<void>
  readonly interrupt: (key: ConversationKey) => Promise<string | null>
  // The messages' own, which track their progress in the mail state.
  readonly release: (thread: string) => void
  readonly stop: (thread: string) => void
}

export type RunnerInbox = Inbox & {
  readonly bind: NonNullable<Inbox["bind"]>
  // Ends every stream it opened; the backend is stopping.
  readonly end: () => void
}

type Reading = {
  alive: boolean
  requests: readonly Asked[]
  stream: AsyncIterableIterator<AgentDetail, undefined> | undefined
  closing: ReturnType<typeof setTimeout> | undefined
  retrying: ReturnType<typeof setTimeout> | undefined
  backoff: number
}

const askedOf = (detail: AgentDetail): readonly Asked[] => {
  const root = detail.actors.find((actor) => actor.role === "root")?.ref ?? null
  return detail.requests.map((request) => ({
    request: requestOf(request, root),
    askedAt: request.askedAt,
  }))
}

const reason = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : "That didn't take. Try again."

// Items that read the same keep their old objects, so what shows them stays as it is.
const reuse = (before: readonly InboxItem[], next: readonly InboxItem[]): readonly InboxItem[] => {
  const old = new Map(before.map((item) => [item.id, item]))
  const items = next.map((item) => {
    const known = old.get(item.id)
    return known && JSON.stringify(known) === JSON.stringify(item) ? known : item
  })
  return items.length === before.length && items.every((item, index) => item === before[index])
    ? before
    : items
}

export const createRunnerInbox = (
  streams: InboxStreams,
  mail: Store<MailState>,
  {
    now = Date.now,
    // Keeps a call the backend waits for before it stops, as its other calls are.
    track = (work) => work,
  }: {
    now?: () => number
    track?: <T>(work: Promise<T>) => Promise<T>
  } = {},
): RunnerInbox => {
  const state = createStore<InboxState>(emptyInbox)
  let binding: InboxBinding | null = null
  let unsubscribe: (() => void)[] = []
  const readings = new Map<string, Reading>()
  const seen = new Set<string>()
  // What the person answered, until the item goes; and why an answer didn't take.
  const submitted = new Set<string>()
  const failed = new Map<string, string>()
  let due: ReturnType<typeof setTimeout> | undefined
  // Per item, when its answer is given up on if the item still stands.
  const settling = new Map<string, ReturnType<typeof setTimeout>>()
  const clearSettling = (): void => {
    for (const timer of settling.values()) clearTimeout(timer)
    settling.clear()
  }
  // Set once the backend stops: nothing opens or recomputes after it.
  let ended = false

  const close = (id: string): void => {
    const reading = readings.get(id)
    if (!reading) return
    readings.delete(id)
    reading.alive = false
    clearTimeout(reading.closing)
    clearTimeout(reading.retrying)
    const { stream } = reading
    reading.stream = undefined
    void stream?.return?.()?.catch?.(() => {})
  }

  const connect = (id: string, reading: Reading): void => {
    if (ended) return
    let stream: AsyncIterableIterator<AgentDetail, undefined>
    try {
      stream = streams.detail(id)
    } catch {
      return retry(id, reading)
    }
    reading.stream = stream
    void (async () => {
      try {
        for await (const snapshot of stream) {
          if (!reading.alive || reading.stream !== stream) return
          reading.requests = askedOf(snapshot)
          reading.backoff = retryMs
          recompute()
        }
      } catch {
        // The terminal is gone, or the runner is: opened again while something waits on it.
      }
      if (!reading.alive || reading.stream !== stream) return
      reading.stream = undefined
      retry(id, reading)
    })()
  }

  const retry = (id: string, reading: Reading): void => {
    reading.retrying = setTimeout(() => {
      reading.retrying = undefined
      if (reading.alive) connect(id, reading)
    }, reading.backoff)
    reading.backoff = Math.min(reading.backoff * 2, retryCapMs)
  }

  // Details stay open for the terminals whose agent has a request waiting, and a while
  // after.
  const follow = (workspace: Workspace): void => {
    const waiting = new Set<string>()
    for (const project of workspace.projects)
      for (const session of project.history)
        for (const terminal of session.state.roster.terminals)
          if (terminal.state === "running" && terminal.agent?.attention) waiting.add(terminal.id)
    for (const id of waiting) {
      const known = readings.get(id)
      if (known) {
        clearTimeout(known.closing)
        known.closing = undefined
        continue
      }
      const reading: Reading = {
        alive: true,
        requests: [],
        stream: undefined,
        closing: undefined,
        retrying: undefined,
        backoff: retryMs,
      }
      readings.set(id, reading)
      connect(id, reading)
    }
    for (const [id, reading] of readings)
      if (!waiting.has(id) && reading.closing === undefined)
        reading.closing = setTimeout(() => {
          close(id)
          recompute()
        }, detailGraceMs)
  }

  const recompute = (): void => {
    if (!binding || ended) return
    const workspace = binding.workspace.getSnapshot()
    follow(workspace)
    const requests = Object.fromEntries(
      [...readings].map(([id, reading]) => [id, reading.requests] as const),
    )
    const at = now()
    const found = inboxItems({
      workspace,
      unread: binding.unread.getSnapshot(),
      mail: mail.getSnapshot(),
      requests,
      now: at,
    })
    const ids = new Set(found.map((item) => item.id))
    for (const set of [seen, submitted]) for (const id of set) if (!ids.has(id)) set.delete(id)
    for (const id of failed.keys()) if (!ids.has(id)) failed.delete(id)
    const items = found.map((item) => (seen.has(item.id) ? { ...item, seen: true } : item))
    const answering: Record<string, true> = {}
    for (const item of items)
      if (submitted.has(item.id) || (item.kind === "request" && item.request.answered))
        answering[item.id] = true

    // A held thread's release or stop is tracked with the messages, so a pane's counts too.
    const { releasing, failed: refused } = mail.getSnapshot()
    const rest: Record<string, string> = Object.fromEntries(failed)
    for (const item of items)
      if (item.kind === "held") {
        const thread = item.held.threadId
        if (releasing[thread]) answering[item.id] = true
        if (refused[thread]) rest[item.id] = refused[thread]
      }
    state.update((current) => {
      const kept = reuse(current.items, items)
      return kept === current.items &&
        JSON.stringify(answering) === JSON.stringify(current.answering) &&
        JSON.stringify(rest) === JSON.stringify(current.failed)
        ? current
        : { items: kept, answering, failed: rest }
    })

    // A request whose dialog is unread shows anyway once it has waited long enough.
    clearTimeout(due)
    due = undefined
    const waits = Object.values(requests)
      .flat()
      .filter(({ request }) => request.dialog === null)
      .map(({ askedAt }) => askedAt + dialogMs - at)
      .filter((wait) => wait > 0)
    if (waits.length > 0) due = setTimeout(recompute, Math.min(...waits))
  }

  const find = (id: string): InboxItem | undefined =>
    state.getSnapshot().items.find((item) => item.id === id)

  const fail = (id: string, message: string): void => {
    submitted.delete(id)
    failed.set(id, message)
    recompute()
  }

  const terminalOf = (source: InboxSource): TerminalMetadata | undefined =>
    binding?.workspace
      .getSnapshot()
      .projects.find((project) => project.id === source.projectId)
      ?.history.find((session) => session.id === source.workspaceSessionId)
      ?.state.roster.terminals.find((terminal) => terminal.id === source.terminalId)

  // Runs an answer. With `settles`, an answer that took but left its item standing (a
  // prompt that started no turn) gives the buttons back after a few seconds.
  const call = (id: string, work: () => Promise<unknown>, settles = false): void => {
    clearTimeout(settling.get(id))
    settling.delete(id)
    failed.delete(id)
    submitted.add(id)
    recompute()
    track(work()).then(
      () => {
        if (!settles) return
        settling.set(
          id,
          setTimeout(() => {
            settling.delete(id)
            if (!submitted.delete(id)) return
            recompute()
          }, settleMs),
        )
      },
      (error: unknown) => fail(id, reason(error)),
    )
  }

  const answer = (id: string, given: InboxAnswer): void => {
    const item = find(id)
    if (!item || !binding || state.getSnapshot().answering[id]) return
    if (item.kind !== given.kind) return fail(id, "That answer isn't for this item.")
    const key: ConversationKey = {
      projectId: item.source.projectId,
      workspaceSessionId: item.source.workspaceSessionId,
      terminalId: item.source.terminalId,
    }
    if (item.kind === "request" && given.kind === "request")
      return call(id, () => streams.answer(key, item.request.id, given.answer))
    if (item.kind === "held" && given.kind === "held") {
      failed.delete(id)
      const { threadId } = item.held
      if (given.action === "release") streams.release(threadId)
      else streams.stop(threadId)
      return
    }
    if (item.kind === "update" && given.kind === "update") {
      failed.delete(id)
      return binding.read([
        {
          context: `${item.source.projectId}/${item.source.workspaceSessionId}`,
          terminalId: key.terminalId,
        },
      ])
    }
    if (item.kind === "trouble" && given.kind === "trouble") {
      const { action } = given
      if (action.type === "continue") return call(id, () => streams.send(key, "continue"), true)
      if (action.type === "stop") return call(id, () => streams.interrupt(key), true)
      if (action.type === "nudge") {
        const terminal = terminalOf(item.source)
        return call(
          id,
          async () => {
            if (terminal && agentWorking(terminal)) await streams.interrupt(key)
            await streams.send(key, action.text)
          },
          true,
        )
      }
      // Novadeck resumes no agent in this backend: nothing to turn on or off.
    }
  }

  return {
    state,
    answer,
    see: (id) => {
      if (seen.has(id) || !find(id)) return
      seen.add(id)
      recompute()
    },
    readAll: () => {
      const updates = state.getSnapshot().items.filter((item) => item.kind === "update")
      if (updates.length > 0 && binding)
        binding.read(
          updates.map((item) => ({
            context: `${item.source.projectId}/${item.source.workspaceSessionId}`,
            terminalId: item.source.terminalId,
          })),
        )
    },
    bind: (next) => {
      binding = next
      unsubscribe = [
        next.workspace.subscribe(recompute),
        next.unread.subscribe(recompute),
        mail.subscribe(recompute),
      ]
      recompute()
      return () => {
        if (binding !== next) return
        binding = null
        for (const stop of unsubscribe) stop()
        unsubscribe = []
        clearTimeout(due)
        clearSettling()
        for (const id of readings.keys()) close(id)
        seen.clear()
        submitted.clear()
        failed.clear()
        state.update(() => emptyInbox)
      }
    },
    end: () => {
      ended = true
      clearTimeout(due)
      clearSettling()
      for (const id of readings.keys()) close(id)
    },
  }
}
