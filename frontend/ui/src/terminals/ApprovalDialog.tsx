import { harnesses } from "@novadeck/core/harnesses"
import type { Approval, ApprovalAction } from "@novadeck/core/port"
import { handleText } from "@novadeck/core/terminals/handle"
import { isAgentProgram } from "@novadeck/core/terminals/process"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"
import { ConfirmDialog } from "@novadeck/toolkit/ConfirmDialog"
import {
  SubjectArrow,
  SubjectBar,
  SubjectName,
  SubjectNew,
  SubjectSide,
} from "@novadeck/toolkit/SubjectBar"
import { Terminal } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

import { TerminalSubject } from "./TerminalSubject"
import { clipped, visibleText } from "./visible-text"

type Party = TerminalMetadata

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

// A terminal by its handle where it has one, as the title of a short question reads. A name is
// the terminal's own text: shown whole in one clipped line, with nothing invisible, so it
// can't pose as Novadeck's.
const short = (terminal: Party): string =>
  terminal.handle ? handleText(terminal.handle) : `“${clipped(terminal.name, 40)}”`

const titleOf = ({ action, asker, target }: ApprovalView): string =>
  action.type === "run"
    ? "Run this in a new terminal?"
    : asker && target
      ? `Let ${short(asker)} ${action.type === "lead" ? "lead" : "close"} ${short(target)}?`
      : action.type === "lead"
        ? "Let an agent lead a terminal?"
        : target
          ? `Close ${short(target)}?`
          : "Close a terminal?"

// A terminal in the bar, or where the app doesn't know it yet, what it would be.
const Side = ({
  terminal,
  unknown,
}: {
  readonly terminal: Party | undefined
  readonly unknown: string
}): React.JSX.Element =>
  terminal ? (
    <TerminalSubject terminal={terminal} />
  ) : (
    <SubjectSide>
      <Terminal size={14} strokeWidth={1.5} aria-hidden="true" />
      <SubjectName>{unknown}</SubjectName>
    </SubjectSide>
  )

// The asking agent, then what it acts on: a terminal, or one that doesn't exist yet.
const barOf = ({ action, asker, target }: ApprovalView): React.JSX.Element => (
  <SubjectBar terminal>
    <Side terminal={asker} unknown="An agent" />
    <SubjectArrow />
    {action.type === "run" ? (
      <SubjectSide>
        <Terminal size={14} strokeWidth={1.5} aria-hidden="true" />
        <SubjectNew>new terminal</SubjectNew>
      </SubjectSide>
    ) : (
      <Side terminal={target} unknown="A terminal" />
    )}
  </SubjectBar>
)

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
      <pre
        ref={pre}
        tabIndex={0}
        aria-label="The command"
        onScroll={check}
        className="approval-brief m-0 max-h-[min(240px,40vh)] overflow-auto whitespace-pre-wrap break-all text-caption"
      >
        {visibleText(command)}
      </pre>
      <div className="max-h-16 overflow-auto text-caption break-all">
        {"In "}
        <code>{visibleText(cwd)}</code>
      </div>
      <div className="text-caption">
        {`${command.length} characters, ${lines} line${lines === 1 ? "" : "s"}.`}
        {seen ? "" : " Scroll to the end of it to be able to run it."}
      </div>
    </>
  )
}

// The words under the title: none for a command, whose body says it.
const descriptionOf = ({ action, target }: ApprovalView): string | null => {
  if (action.type === "run") return null
  if (action.type === "lead")
    return `It would direct ${target ? short(target) : "it"} from now on, and could close it too. The brief it would send:`
  const agent = target && agentOf(target)
  const running = agent ?? (target?.process ? clipped(target.process, 40) : undefined)
  return running ? `${running} is running there.` : null
}

// What shows under the words: the command and where it runs, or the brief.
const bodyOf = (
  { action, requestId }: ApprovalView,
  seen: { readonly id: string; readonly mark: (id: string) => void },
): React.ReactNode => {
  if (action.type === "run")
    return (
      <CommandView
        command={action.command}
        cwd={action.cwd}
        seen={seen.id === requestId}
        onSeen={() => seen.mark(requestId)}
      />
    )
  if (action.type === "lead")
    return (
      <pre
        tabIndex={0}
        aria-label="The brief"
        className="approval-brief m-0 max-h-[min(240px,40vh)] overflow-auto whitespace-pre-wrap break-words text-caption"
      >
        {action.brief}
      </pre>
    )
  return null
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
      bar={barOf}
      title={titleOf}
      description={descriptionOf}
      body={(view) => bodyOf(view, { id: seen, mark: setSeen })}
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
