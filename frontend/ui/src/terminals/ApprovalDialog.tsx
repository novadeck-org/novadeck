import { harnesses } from "@novadeck/core/harnesses"
import type { Approval, ApprovalAction } from "@novadeck/core/port"
import { handleText } from "@novadeck/core/terminals/handle"
import { isAgentProgram } from "@novadeck/core/terminals/process"
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
export const approvalView = (approval: Approval, workspace: Workspace): ApprovalView => {
  const terminals = workspace.projects.flatMap((project) =>
    project.history.flatMap((session) => session.state.roster.terminals),
  )
  const find = (id: string) => terminals.find((terminal) => terminal.id === id)
  return {
    requestId: approval.requestId,
    action: approval.action,
    asker: find(approval.from),
    target: find(approval.terminalId),
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
  action.type === "run"
    ? asker
      ? `Let ${short(asker)} run a command?`
      : "Let an agent run a command?"
    : action.type === "lead"
      ? asker && target
        ? `Let ${short(asker)} lead ${short(target)}?`
        : "Let an agent lead a terminal?"
      : target
        ? `Close ${named(target)}?`
        : "Close a terminal?"

const descriptionOf = ({ action, asker, target }: ApprovalView): React.ReactNode => {
  if (action.type === "run")
    return (
      <>
        {`${askerOf(asker)} asks to open a terminal in `}
        <code className="break-all">{action.cwd}</code>
        {" that runs this command, exactly as written:"}
        <pre
          tabIndex={0}
          aria-label="The command"
          className="approval-brief mt-2 mb-0 max-h-[min(240px,40vh)] overflow-auto whitespace-pre-wrap break-all text-caption"
        >
          {action.command}
        </pre>
      </>
    )
  const agent = target && agentOf(target)
  const running = agent ?? (target?.process ? target.process : undefined)
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

type ApprovalDialogProps = {
  // The approval waiting on the person, or null when none does.
  readonly approval: ApprovalView | null
  // `approved` when the person agreed; false when they declined.
  readonly onAnswer: (requestId: string, approved: boolean) => void
}

// Asks before an agent does something the person should allow: closing a terminal that runs
// an agent it doesn't lead or a program, since closing ends it, leading one with a brief, or
// running a command in a new terminal.
// Declining is focused first; Escape and a click outside decline too.
export const ApprovalDialog = ({ approval, onAnswer }: ApprovalDialogProps): React.JSX.Element => {
  // Each approval gets its own dialog: one answered while the next waits would otherwise
  // count the next one's Escape as a confirmation.
  const [generation, setGeneration] = useState({ id: "", count: 0 })
  if (approval && approval.requestId !== generation.id)
    setGeneration({ id: approval.requestId, count: generation.count + 1 })
  const lead = approval?.action.type === "lead"
  const run = approval?.action.type === "run"
  return (
    <ConfirmDialog
      key={generation.count}
      subject={approval}
      title={titleOf}
      description={descriptionOf}
      confirmDisabled={lead && !(approval?.asker && approval.target)}
      confirmLabel={run ? "Run command" : lead ? "Let it lead" : "Close terminal"}
      cancelLabel={run ? "Don't run" : lead ? "Decline" : "Keep open"}
      onConfirm={() => approval && onAnswer(approval.requestId, true)}
      onCancel={() => approval && onAnswer(approval.requestId, false)}
      widthClassName={
        lead || run ? "w-[min(480px,calc(100vw-32px))]" : "w-[min(360px,calc(100vw-32px))]"
      }
    />
  )
}
