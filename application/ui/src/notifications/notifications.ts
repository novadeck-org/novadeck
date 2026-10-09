import {
  attentionText,
  doneText,
  terminalAsk,
  terminalAsks,
  type TerminalAsk,
} from "../model/terminal-ending"
import type { TerminalMetadata, WorkspaceProject } from "../model/types"
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
  // What it asks, in the terminal tab's words, e.g. "Asks a question".
  readonly status: string
  // The start of the agent's last reply, for a finish whose harness tells it.
  readonly reply?: string
}

// A finish's turn end, by its `at`, newer first; one without comes last.
const endAt = (terminal: TerminalMetadata): number =>
  terminal.state === "running" ? (terminal.agent?.lastTurn?.at ?? 0) : 0

const rank = (kind: NotificationKind): number => terminalAsks.indexOf(kind)

// Every terminal in the workspace that asks for the person, the most pressing kind first:
// requests in workspace order, as none tells when it was asked, then finishes, the latest
// first. A terminal shows as its tab does (see `terminalPhase`): a request it waits on
// over a reply unread, and nothing once it ended, as the switcher's status counts them.
export const notifications = (
  projects: readonly WorkspaceProject[],
  unread: Unread,
): readonly Notification[] => {
  const found: { readonly notification: Notification; readonly at: number }[] = []
  for (const project of projects)
    for (const session of project.history) {
      const context = `${project.id}/${session.id}`
      for (const terminal of session.state.roster.terminals) {
        const kind = terminalAsk(terminal, unreadEnd(unread, context, terminal.id))
        if (!kind) continue
        const finished = dismissable(kind)
        const reply =
          finished && terminal.state === "running" ? terminal.agent?.lastTurn?.reply : undefined
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
            status: attentionText(terminal) ?? doneText(kind === "failed"),
            ...(reply ? { reply } : {}),
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

// Whether the person can clear it: a finish is read once dismissed, while a request waits
// until the agent is answered.
export const dismissable = (kind: NotificationKind): boolean => kind === "failed" || kind === "done"
