import {
  attentionText,
  doneText,
  terminalAsk,
  terminalAsks,
  waitingText,
  type TerminalAsk,
} from "#core/terminal-ending"
import type { TerminalMetadata, WorkspaceProject } from "#core/types"

import { unreadEnd, type Unread } from "../terminals/unread-state"

// What a terminal asks of the person, as the notification center lists it.
export type NotificationKind = TerminalAsk

// One terminal that asks for the person, wherever it is in the workspace. Nothing here
// is kept: each comes from what the terminal shows now, so it goes once its agent is
// answered, the person looks at it, or its agent works again.
export type Notification = {
  readonly kind: NotificationKind
  // The session context, `${projectId}/${sessionId}`, as unread ends are kept by.
  readonly context: string
  readonly projectId: string
  readonly projectName: string
  readonly sessionId: string
  readonly sessionName: string
  readonly terminalId: string
  readonly terminalName: string
  readonly handle?: string
  // What it asks, in the terminal tab's words, e.g. "Asks a question"; where murmur wrote a
  // headline for a question or a plan, in its words, e.g. "Asks which database to use".
  readonly status: string
  // Whether `status` is murmur's headline.
  readonly headline?: true
  // The start of the agent's last reply, for a finish whose harness tells it.
  readonly reply?: string
  // Murmur's words for that reply, and that the reply asks the person something.
  readonly gist?: string
  readonly asks?: true
}

// A finish's turn end, by its `at`, newer first; one without comes last.
const endAt = (terminal: TerminalMetadata): number =>
  terminal.state === "running" ? (terminal.agent?.lastTurn?.at ?? 0) : 0

const rank = (kind: NotificationKind): number => terminalAsks.indexOf(kind)

// Every terminal in the workspace that asks for the person, the most pressing kind first:
// requests in workspace order, as none tells when it was asked, then finishes, the latest
// first. A terminal shows as its tab does (see `terminalPhase`): a request it waits on
// over a reply unread, and nothing once it ended, as the switcher's status counts them.
const scan = (projects: readonly WorkspaceProject[], unread: Unread): readonly Notification[] => {
  const found: { readonly notification: Notification; readonly at: number }[] = []
  for (const project of projects)
    for (const session of project.history) {
      const context = `${project.id}/${session.id}`
      for (const terminal of session.state.roster.terminals) {
        const kind = terminalAsk(terminal, unreadEnd(unread, context, terminal.id))
        if (!kind) continue
        const finished = dismissable(kind)
        const lastTurn =
          finished && terminal.state === "running" ? terminal.agent?.lastTurn : undefined
        const attention = terminal.state === "running" ? terminal.agent?.attention : undefined
        const headline =
          (kind === "question" || kind === "plan") && attention?.kind === kind
            ? attention.headline
            : undefined
        found.push({
          at: finished ? endAt(terminal) : 0,
          notification: {
            kind,
            context,
            projectId: project.id,
            projectName: project.name,
            sessionId: session.id,
            sessionName: session.name,
            terminalId: terminal.id,
            terminalName: terminal.name,
            ...(terminal.handle ? { handle: terminal.handle } : {}),
            status: headline
              ? waitingText(headline, attention?.count ?? 1)
              : (attentionText(terminal) ?? doneText(kind === "failed")),
            ...(headline ? { headline: true as const } : {}),
            ...(lastTurn?.reply ? { reply: lastTurn.reply } : {}),
            ...(lastTurn?.gist ? { gist: lastTurn.gist } : {}),
            ...(lastTurn?.gist && lastTurn.asks ? { asks: true as const } : {}),
          },
        })
      }
    }
  // A stable sort keeps workspace order within a kind and between ends told at once.
  return found
    .toSorted(
      (a, b) =>
        rank(a.notification.kind) - rank(b.notification.kind) ||
        (dismissable(a.notification.kind) ? b.at - a.at : 0),
    )
    .map(({ notification }) => notification)
}

const lists = new WeakMap<readonly WorkspaceProject[], WeakMap<Unread, readonly Notification[]>>()

// The notifications, scanned once per workspace and unread marks however many readers
// ask: the notification center and each bell read the same list. Neither is changed in
// place, so a list stays right for as long as both are the ones it was scanned from.
export const notifications = (
  projects: readonly WorkspaceProject[],
  unread: Unread,
): readonly Notification[] => {
  const known = lists.get(projects)?.get(unread)
  if (known) return known
  const list = scan(projects, unread)
  lists.set(projects, (lists.get(projects) ?? new WeakMap()).set(unread, list))
  return list
}

// Whether the person can clear it: a finish is read once dismissed, while a request waits
// until the agent is answered.
export const dismissable = (kind: NotificationKind): boolean => kind === "failed" || kind === "done"

const asksYou = "Asks you something"

// What a row says: its status and where it is, that it asks the person something, and the
// agent's reply, as sentences for assistive technology; one that already ends in a mark gets no
// full stop after it.
export const notificationDescription = (item: Notification): string =>
  [item.status, `${item.projectName} · ${item.sessionName}`, item.asks && asksYou, item.reply]
    .filter((part): part is string => Boolean(part))
    .reduce(
      (text, part, index) =>
        index === 0 ? part : `${text}${/[.!?]$/.test(text) ? " " : ". "}${part}`,
      "",
    )

// What a row's tooltip says, a line each: the terminal, its status, where it is, that it asks
// and the agent's own reply, which the row may show only as murmur's gist.
export const notificationTooltip = (item: Notification): string =>
  [
    item.terminalName,
    item.status,
    `${item.projectName} · ${item.sessionName}`,
    item.asks && asksYou,
    item.reply,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
