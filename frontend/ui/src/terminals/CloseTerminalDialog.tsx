import { closeReasons, type CloseReason } from "@novadeck/core/terminals/closing"
import { shellCommandLine } from "@novadeck/core/terminals/ending"
import { handleText } from "@novadeck/core/terminals/handle"
import type { TerminalMetadata } from "@novadeck/core/types"
import { ConfirmDialog } from "@novadeck/toolkit/ConfirmDialog"
import { SubjectBar } from "@novadeck/toolkit/SubjectBar"
import { useState } from "react"

import { type CloseTeamRow, type CloseTeamTree } from "./close-team"
import { TerminalSubject } from "./TerminalSubject"

type CloseTerminalDialogProps = {
  // The terminal waiting to close, or null when nothing asks.
  readonly terminal: TerminalMetadata | null
  // Whether closing can be undone from History, which changes what is worth asking about.
  readonly keepsHistory: boolean
  // Whom the terminal leads, at any depth; none for a terminal that leads no one.
  readonly team: CloseTeamTree | null
  // Draws the team's rows, which read each teammate as its tab does (the app's to give).
  readonly teamRows: (rows: readonly CloseTeamRow[]) => React.ReactNode
  // Closes the terminal alone, or with its team.
  readonly onConfirm: (scope: "terminal" | "team") => void
  readonly onCancel: () => void
  // Where focus goes back when the person keeps the terminal.
  readonly returnFocus: (terminalId: string) => HTMLElement | null
}

// What a sleeping or waking agent's terminal says: where the agent is, with its session saved.
const restingWords = (terminal: TerminalMetadata, then: string): string | undefined =>
  terminal.state === "sleeping"
    ? `${terminal.agent} is asleep in it, with its session saved, but ${then}`
    : terminal.state === "starting" && terminal.restoredProcess
      ? `${terminal.restoredProcess} is waking in it, with its session saved, but ${then}`
      : undefined

// What closing it loses of its own; that it leads a team is the dialog's tree to say.
const sentences = (terminal: TerminalMetadata): Readonly<Record<CloseReason, string>> => ({
  program: `${terminal.process || "A program"} is still running in it.`,
  working: "Its agent is working on a turn, and closing it stops the turn.",
  command: shellCommandLine(terminal)
    ? `It runs \`${shellCommandLine(terminal)}\` in its agent's shell mode, and closing it stops the command.`
    : "It runs a command in its agent's shell mode, and closing it stops the command.",
  background:
    "Its agent is waiting on a job or a wake-up it set, or has tasks running in the background. Closing it ends them, and restoring it doesn't start them again.",
  leads: "",
  unrestorable:
    restingWords(terminal, "its session can't be restored from History once it is closed.") ??
    "It can't be restored from History once it is closed.",
  asleep: restingWords(terminal, "closing it ends that session.") ?? "",
})

// What the dialog says, from the terminal as it is now: an agent's turn may end, or a program
// exit, while the question is up, and then nothing is left to lose. A lead's own reasons only,
// or nothing when it has none, since its team is listed under the title.
export const closeDescription = (
  terminal: TerminalMetadata,
  keepsHistory: boolean,
  leads = false,
): string | null => {
  const own = closeReasons(terminal, keepsHistory, leads).filter((reason) => reason !== "leads")
  if (own.length > 0) return own.map((reason) => sentences(terminal)[reason]).join(" ")
  if (leads) return null
  return keepsHistory
    ? "Nothing in it is running now. It stays in History, so it can be restored."
    : sentences(terminal).program
}

const closeBar = (terminal: TerminalMetadata): React.JSX.Element => (
  <SubjectBar terminal>
    <TerminalSubject terminal={terminal} />
  </SubjectBar>
)

// Asks before closing a terminal that would lose something: a program still running in it,
// or, where History keeps closed terminals, an agent mid-turn, one waiting on background
// jobs, or one that can't be restored. A lead always asks, with its team listed, and
// closes with all of it or alone.
// Cancel is focused first, as the safe choice; Escape and a click outside cancel too.
export const CloseTerminalDialog = ({
  terminal,
  keepsHistory,
  team,
  teamRows,
  onConfirm,
  onCancel,
  returnFocus,
}: CloseTerminalDialogProps): React.JSX.Element => {
  // The question up, kept while the dialog animates out.
  const [kept, setKept] = useState({ terminal, team })
  if (terminal !== null && (terminal !== kept.terminal || team !== kept.team))
    setKept({ terminal, team })
  const led = kept.team !== null && kept.team.rows.length > 0 ? kept.team : null
  const leads = led !== null
  // What the lead's close takes, under the words.
  const listing = led && (
    <>
      {teamRows(led.rows)}
      {keepsHistory && <p className="close-team-note">Closed terminals stay in History.</p>}
    </>
  )
  return (
    <ConfirmDialog
      subject={terminal}
      bar={closeBar}
      title={() => (leads ? "Close this lead?" : "Close this terminal?")}
      description={(shown) => closeDescription(shown, keepsHistory, leads)}
      {...(led
        ? {
            body: () => listing,
            alternative: {
              label: kept.terminal?.handle
                ? `Close ${handleText(kept.terminal.handle)} only`
                : "Close it only",
              onSelect: () => onConfirm("terminal"),
            },
          }
        : {})}
      confirmLabel={led ? `Close all ${led.total}` : "Close terminal"}
      cancelLabel="Cancel"
      onConfirm={() => onConfirm(leads ? "team" : "terminal")}
      onCancel={onCancel}
      returnFocus={(shown) => returnFocus(shown.id)}
      widthClassName="w-[min(420px,calc(100vw-32px))]"
    />
  )
}
