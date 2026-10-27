import { handleText } from "@novadeck/core/handle"
import { harnesses } from "@novadeck/core/harnesses"
import type { CloseAsk } from "@novadeck/core/port"
import { isAgentProgram } from "@novadeck/core/process"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"
import { ConfirmDialog } from "@novadeck/toolkit/ConfirmDialog"
import { useState } from "react"

type Party = Pick<TerminalMetadata, "name" | "process" | "handle">

// What the person is asked: which terminal, and who asks to close it. Either terminal is
// missing while the app doesn't know it yet.
export type CloseAskView = {
  readonly requestId: string
  readonly asker: Party | undefined
  readonly target: Party | undefined
}

// The ask with the terminals it names, found in any session of any project.
export const closeAskView = (ask: CloseAsk, workspace: Workspace): CloseAskView => {
  const terminals = workspace.projects.flatMap((project) =>
    project.history.flatMap((session) => session.state.roster.terminals),
  )
  const find = (id: string) => terminals.find((terminal) => terminal.id === id)
  return { requestId: ask.requestId, asker: find(ask.from), target: find(ask.terminalId) }
}

// Whether two views name the same terminals as they are now, so a rerender keeps the dialog.
export const sameCloseAskView = (a: CloseAskView | null, b: CloseAskView | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.requestId === b.requestId &&
    a.asker === b.asker &&
    a.target === b.target)

// The agent a terminal runs, as people call it: the harness's name; none for a plain program.
const agentOf = (terminal: Party): string | undefined =>
  isAgentProgram(terminal.process)
    ? harnesses.find(({ id }) => id === terminal.process)?.name
    : undefined

const named = (terminal: Party): string =>
  `${terminal.handle ? `${handleText(terminal.handle)} · ` : ""}“${terminal.name}”`

const titleOf = ({ target }: CloseAskView): string =>
  target ? `Close ${named(target)}?` : "Close a terminal?"

const descriptionOf = ({ asker, target }: CloseAskView): string => {
  const agent = asker && agentOf(asker)
  const who = asker ? `${named(asker)}${agent ? ` (${agent})` : ""}` : "An agent"
  const running = target && agentOf(target)
  return `${who} asks to close ${target ? "it" : "a terminal"}.${running ? ` ${running} is running there.` : ""}`
}

export type CloseAskDialogProps = {
  // The ask waiting on the person, or null when none does.
  readonly ask: CloseAskView | null
  // `close` when the person confirmed; false when they kept the terminal open.
  readonly onAnswer: (requestId: string, close: boolean) => void
}

// Asks before an agent closes a terminal that runs an agent it doesn't lead, since closing
// ends that agent. Keep open is focused first; Escape and a click outside keep it open too.
export const CloseAskDialog = ({ ask, onAnswer }: CloseAskDialogProps): React.JSX.Element => {
  // Each ask gets its own dialog: one answered while the next waits would otherwise count
  // the next one's Escape as a confirmation.
  const [generation, setGeneration] = useState({ id: "", count: 0 })
  if (ask && ask.requestId !== generation.id)
    setGeneration({ id: ask.requestId, count: generation.count + 1 })
  return (
    <ConfirmDialog
      key={generation.count}
      subject={ask}
      title={titleOf}
      description={descriptionOf}
      confirmLabel="Close terminal"
      cancelLabel="Keep open"
      onConfirm={() => ask && onAnswer(ask.requestId, true)}
      onCancel={() => ask && onAnswer(ask.requestId, false)}
      widthClassName="w-[min(360px,calc(100vw-32px))]"
    />
  )
}
