import { handleText } from "@novadeck/core/terminals/handle"
import type { TerminalMetadata } from "@novadeck/core/types"
import { ConfirmDialog } from "@novadeck/toolkit/ConfirmDialog"
import { SubjectBar } from "@novadeck/toolkit/SubjectBar"
import { useState } from "react"

import { TerminalSubject } from "./TerminalSubject"

// A teammate's move the person is asked about: the terminal, the lead it would leave, where
// it goes, and how many terminals its whole team is, the lead at its top included.
export type MoveQuestion = {
  readonly terminal: TerminalMetadata
  readonly lead: string
  readonly session: string
  readonly team: number
}

const moveBar = (question: MoveQuestion): React.JSX.Element => (
  <SubjectBar terminal>
    <TerminalSubject terminal={question.terminal} />
  </SubjectBar>
)

// The handle the dialog names the terminal by, or its name where it has none.
const named = (terminal: TerminalMetadata): string =>
  terminal.handle ? handleText(terminal.handle) : terminal.name

// Asks before moving a terminal an agent leads on its own: it would leave that lead's team,
// whose lead can't reach it in another session. Moving it alone is the main answer, the whole
// team the other way out; Cancel keeps it where it is, and is focused first.
export const MoveTeammateDialog = ({
  question,
  onConfirm,
  onCancel,
  returnFocus,
}: {
  // The move waiting for an answer, or null when nothing asks.
  readonly question: MoveQuestion | null
  readonly onConfirm: (scope: "alone" | "team") => void
  readonly onCancel: () => void
  readonly returnFocus: (terminalId: string) => HTMLElement | null
}): React.JSX.Element => {
  // The question up, kept while the dialog animates out.
  const [kept, setKept] = useState(question)
  if (question !== null && question !== kept) setKept(question)
  return (
    <ConfirmDialog
      subject={question}
      bar={moveBar}
      title={(shown) => `Move ${named(shown.terminal)} out of ${handleText(shown.lead)}'s team?`}
      description={(shown) =>
        `${shown.terminal.name} goes to ${shown.session} on its own, and ${handleText(shown.lead)} can't send to it there.`
      }
      alternative={{
        label: kept ? `Move all ${kept.team}` : "Move the whole team",
        onSelect: () => onConfirm("team"),
      }}
      confirmLabel={kept ? `Move ${named(kept.terminal)} alone` : "Move alone"}
      cancelLabel="Cancel"
      focus="cancel"
      onConfirm={() => onConfirm("alone")}
      onCancel={onCancel}
      returnFocus={(shown) => returnFocus(shown.terminal.id)}
      widthClassName="w-[min(440px,calc(100vw-32px))]"
    />
  )
}
