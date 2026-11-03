import { harnesses } from "@novadeck/core/harnesses"
import type { Approval, ApprovalAction } from "@novadeck/core/port"
import { handleText } from "@novadeck/core/terminals/handle"
import { isAgentProgram } from "@novadeck/core/terminals/process"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"
import { ConfirmDialog } from "@novadeck/toolkit/ConfirmDialog"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

import { clipped, visibleText } from "./visible-text"

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

// A terminal's name is its own text: shown whole in one clipped line, with nothing invisible,
// so it can't pose as Novadeck's.
const named = (terminal: Party): string =>
  `${terminal.handle ? `${handleText(terminal.handle)} · ` : ""}“${clipped(terminal.name, 40)}”`

// A terminal by its handle where it has one, as the title of a short question reads.
const short = (terminal: Party): string =>
  terminal.handle ? handleText(terminal.handle) : `“${clipped(terminal.name, 40)}”`

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

// The command exactly as the shell would be given it, with what draws as nothing written out,
// its size, and a note until the person has scrolled to its end: the answer waits for that.
const CommandView = ({
  command,
  cwd,
  seen,
  onSeen,
}: {
  readonly command: string
  readonly cwd: string
  readonly seen: boolean
  readonly onSeen: () => void
}): React.JSX.Element => {
  const pre = useRef<HTMLPreElement>(null)
  const check = useCallback((): void => {
    const el = pre.current
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 2) onSeen()
  }, [onSeen])
  // A command that fits needs no scrolling, as when the window grows until it does.
  useLayoutEffect(check, [check])
  useEffect(() => {
    const el = pre.current
    if (!el || typeof ResizeObserver === "undefined") return undefined
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [check])
  const lines = command.split("\n").length
  return (
    <>
      {"This is a request to open a terminal in "}
      <code className="mt-1 block max-h-16 overflow-auto break-all">{visibleText(cwd)}</code>
      {" that runs, exactly as written:"}
      <pre
        ref={pre}
        tabIndex={0}
        aria-label="The command"
        onScroll={check}
        className="approval-brief mt-2 mb-0 max-h-[min(240px,40vh)] overflow-auto whitespace-pre-wrap break-all text-caption"
      >
        {visibleText(command)}
      </pre>
      <div className="mt-1 text-caption">
        {`${command.length} characters, ${lines} line${lines === 1 ? "" : "s"}.`}
        {seen ? "" : " Scroll to the end of it to be able to run it."}
      </div>
    </>
  )
}

const descriptionOf = (
  { action, asker, target, requestId }: ApprovalView,
  seen: { readonly id: string; readonly mark: (id: string) => void } = {
    id: "",
    mark: () => {},
  },
): React.ReactNode => {
  if (action.type === "run")
    return (
      <>
        {`${askerOf(asker)} asks to run a command. `}
        <CommandView
          command={action.command}
          cwd={action.cwd}
          seen={seen.id === requestId}
          onSeen={() => seen.mark(requestId)}
        />
      </>
    )
  const agent = target && agentOf(target)
  const running = agent ?? (target?.process ? clipped(target.process, 40) : undefined)
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

// How long after a request shows that answering yes is held back, so keys typed ahead can't take it.
const armMs = 1000

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
  // The request whose command has been seen to its end.
  const [seen, setSeen] = useState("")
  return (
    <ConfirmDialog
      key={generation.count}
      subject={approval}
      title={titleOf}
      description={(view) => descriptionOf(view, { id: seen, mark: setSeen })}
      confirmDisabled={
        (lead && !(approval?.asker && approval.target)) || (run && approval?.requestId !== seen)
      }
      armMs={armMs}
      armKey={approval?.requestId ?? ""}
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
