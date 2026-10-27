import { handleText } from "@novadeck/core/handle"
import { harnesses } from "@novadeck/core/harnesses"
import type { Approval, ApprovalAction } from "@novadeck/core/port"
import { isAgentProgram } from "@novadeck/core/process"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"
import { ConfirmDialog } from "@novadeck/toolkit/ConfirmDialog"
import { useState } from "react"

type Party = Pick<TerminalMetadata, "name" | "process" | "handle">

// What the person is asked: what an agent wants done, to which terminal, and who asks.
// Either terminal is missing while the app doesn't know it yet.
export type ApprovalView = {
  readonly requestId: string
  readonly action: ApprovalAction
  readonly asker: Party | undefined
  readonly target: Party | undefined
}

// The approval with the terminals it names, found in any session of any project.
export const approvalView = (ask: Approval, workspace: Workspace): ApprovalView => {
  const terminals = workspace.projects.flatMap((project) =>
    project.history.flatMap((session) => session.state.roster.terminals),
  )
  const find = (id: string) => terminals.find((terminal) => terminal.id === id)
  return {
    requestId: ask.requestId,
    action: ask.action,
    asker: find(ask.from),
    target: find(ask.terminalId),
  }
}

// Whether two views name the same terminals as they are now, so a rerender keeps the dialog.
export const sameApprovalView = (a: ApprovalView | null, b: ApprovalView | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.requestId === b.requestId &&
    a.action === b.action &&
    a.asker === b.asker &&
    a.target === b.target)

// The agent a terminal runs, as people call it: the harness's name; none for a plain program.
const agentOf = (terminal: Party): string | undefined =>
  isAgentProgram(terminal.process)
    ? harnesses.find(({ id }) => id === terminal.process)?.name
    : undefined

const named = (terminal: Party): string =>
  `${terminal.handle ? `${handleText(terminal.handle)} · ` : ""}“${terminal.name}”`

// A terminal by its handle where it has one, as the title of a short question reads.
const short = (terminal: Party): string =>
  terminal.handle ? handleText(terminal.handle) : `“${terminal.name}”`

const askerOf = (asker: Party | undefined): string => {
  const agent = asker && agentOf(asker)
  return asker ? `${named(asker)}${agent ? ` (${agent})` : ""}` : "An agent"
}

const titleOf = ({ action, asker, target }: ApprovalView): string =>
  action.type === "lead"
    ? asker && target
      ? `Let ${short(asker)} lead ${short(target)}?`
      : "Let an agent lead a terminal?"
    : target
      ? `Close ${named(target)}?`
      : "Close a terminal?"

const descriptionOf = ({ action, asker, target }: ApprovalView): React.ReactNode => {
  const running = target && agentOf(target)
  if (action.type === "close")
    return `${askerOf(asker)} asks to close ${target ? "it" : "a terminal"}.${running ? ` ${running} is running there.` : ""}`
  return (
    <>
      {`${askerOf(asker)} asks to direct ${target ? `${named(target)}${running ? ` (${running})` : ""}` : "a terminal"} from now on, and could then close it too. This is the brief it would send:`}
      <pre
        tabIndex={0}
        aria-label="The brief"
        className="approval-brief mt-2 mb-0 max-h-[min(240px,40vh)] overflow-auto whitespace-pre-wrap break-words text-caption"
      >
        {action.brief}
      </pre>
    </>
  )
}

export type ApprovalDialogProps = {
  // The approval waiting on the person, or null when none does.
  readonly ask: ApprovalView | null
  // `approved` when the person agreed; false when they declined.
  readonly onAnswer: (requestId: string, approved: boolean) => void
}

// Asks before an agent does something the person should allow: closing a terminal that runs
// an agent it doesn't lead, since closing ends that agent, or leading one with a brief.
// Declining is focused first; Escape and a click outside decline too.
export const ApprovalDialog = ({ ask, onAnswer }: ApprovalDialogProps): React.JSX.Element => {
  // Each approval gets its own dialog: one answered while the next waits would otherwise
  // count the next one's Escape as a confirmation.
  const [generation, setGeneration] = useState({ id: "", count: 0 })
  if (ask && ask.requestId !== generation.id)
    setGeneration({ id: ask.requestId, count: generation.count + 1 })
  const lead = ask?.action.type === "lead"
  return (
    <ConfirmDialog
      key={generation.count}
      subject={ask}
      title={titleOf}
      description={descriptionOf}
      confirmDisabled={lead && !(ask?.asker && ask.target)}
      confirmLabel={lead ? "Let it lead" : "Close terminal"}
      cancelLabel={lead ? "Decline" : "Keep open"}
      onConfirm={() => ask && onAnswer(ask.requestId, true)}
      onCancel={() => ask && onAnswer(ask.requestId, false)}
      widthClassName={lead ? "w-[min(480px,calc(100vw-32px))]" : "w-[min(360px,calc(100vw-32px))]"}
    />
  )
}
