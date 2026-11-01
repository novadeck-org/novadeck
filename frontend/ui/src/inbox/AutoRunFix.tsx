import type { AutoRunState } from "@novadeck/core/autorun"
import {
  autoRunBody,
  autoRunEverywhere,
  autoRunTitle,
  manualWhy,
  outcomeText,
} from "@novadeck/core/autorun-text"
import { Dialog, DialogDescription, DialogTitle } from "@novadeck/toolkit/Dialog"
import { useState } from "react"

import { AutoRunValue, RegeditStep } from "./AutoRunValue"
import { useInboxContext } from "./InboxProvider"
import { Disclosure } from "./sheet-parts"

// Command Prompt's startup script (cmd's AutoRun, Windows) in the plain style of the Grant card:
// one line that says Antigravity needs a fix and a link to it, and a small confirm behind the
// link. The words are Novadeck's own (`autorun-text.ts`); the registry values are the runner's,
// shown verbatim; only a click changes anything.

// Whether there is something to fix, and what its link says.
const fixOf = (autorun: AutoRunState): "fix" | "see" | null =>
  autorun.state === "offer" || autorun.state === "manual"
    ? "fix"
    : autorun.state === "silenced" && autorun.machine !== null
      ? "see"
      : null

const key = (machine: boolean): React.JSX.Element => (
  <code>
    HKEY_{machine ? "LOCAL_MACHINE" : "CURRENT_USER"}\Software\Microsoft\Command Processor
  </code>
)

const Line = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => (
  <p className="modal-description m-0 text-control">{children}</p>
)

// What the confirm shows behind "details": the key, the values as the runner read them, and for
// the machine's key the step in words, never a command line.
const Details = ({ autorun }: { readonly autorun: AutoRunState }): React.JSX.Element | null => {
  if (autorun.state === "offer")
    return (
      <>
        <Line>
          Registry key: {key(false)}, value <code>AutoRun</code>
        </Line>
        <Line>
          Now: <AutoRunValue value={autorun.current} kind="current" />
        </Line>
        <Line>
          Novadeck would change it to: <AutoRunValue value={autorun.next} kind="next" />
        </Line>
        <Line>{autoRunEverywhere}</Line>
        {autorun.machine !== null && (
          <Line>
            The machine&apos;s startup script (HKLM) holds a value too, which Novadeck doesn&apos;t
            change: <AutoRunValue value={autorun.machine} kind="machine" />
          </Line>
        )}
      </>
    )
  if (autorun.state === "manual")
    return (
      <>
        {autorun.current !== null && (
          <Line>
            Your value: <AutoRunValue value={autorun.current} kind="current" />
          </Line>
        )}
        {autorun.machine !== null && (
          <Line>
            The machine&apos;s value (HKLM): <AutoRunValue value={autorun.machine} kind="machine" />
          </Line>
        )}
        <RegeditStep
          machine={autorun.reason === "machine"}
          from={autorun.reason === "machine" ? autorun.machine : autorun.current}
          to={autorun.suggested}
        />
      </>
    )
  if (autorun.state === "silenced" && autorun.machine !== null)
    return (
      <>
        <Line>
          The machine&apos;s value (HKLM): <AutoRunValue value={autorun.machine} kind="machine" />
        </Line>
        <RegeditStep machine from={autorun.machine} to={autorun.suggested} />
      </>
    )
  return null
}

// The small confirm: the title and body, the details collapsed, and the clicks. It closes where
// there is nothing left to fix.
const AutoRunDialog = ({
  open,
  onClose,
}: {
  readonly open: boolean
  readonly onClose: () => void
}): React.JSX.Element => {
  const { autorun, silenceAutoRun, dismissAutoRun, autorunBusy } = useInboxContext()
  const fix = fixOf(autorun)
  const body =
    autorun.state === "manual"
      ? `${autoRunBody} ${manualWhy(autorun.reason, autorun.rule)}`
      : autorun.state === "silenced"
        ? "Novadeck hid your startup script's output, but the machine's startup script (HKLM) still prints, and only an administrator can change it."
        : autoRunBody
  return (
    <Dialog
      open={open && fix !== null}
      role="alertdialog"
      closeOnInteractOutside
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      label={autoRunTitle}
      backdropClassName="overlay fixed inset-0 z-50"
      positionerClassName="fixed inset-0 z-50 flex items-center justify-center px-5"
      className="modal w-[min(420px,calc(100vw-32px))] flex flex-col gap-2 p-5"
    >
      <DialogTitle className="modal-title m-0 text-heading font-medium">{autoRunTitle}</DialogTitle>
      <DialogDescription className="modal-description m-0 text-body">{body}</DialogDescription>
      <Disclosure label="details">
        <div className="flex flex-col gap-1.5 pt-1">
          <Details autorun={autorun} />
        </div>
      </Disclosure>
      <div className="mt-3 flex justify-end gap-2">
        {autorun.state === "offer" ? (
          <>
            {dismissAutoRun && (
              <button
                type="button"
                className="button"
                disabled={autorunBusy}
                onClick={() => {
                  dismissAutoRun()
                  onClose()
                }}
              >
                Not now
              </button>
            )}
            {silenceAutoRun && (
              <button
                type="button"
                className="button primary"
                disabled={autorunBusy}
                onClick={() => {
                  silenceAutoRun(autorun.next)
                  onClose()
                }}
              >
                Hide it
              </button>
            )}
          </>
        ) : autorun.state === "manual" && dismissAutoRun ? (
          <button
            type="button"
            className="button"
            disabled={autorunBusy}
            onClick={() => {
              dismissAutoRun()
              onClose()
            }}
          >
            Not now
          </button>
        ) : (
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
        )}
      </div>
    </Dialog>
  )
}

const classes = {
  // In the Grant card's Details.
  card: { line: "grant-warn", good: "grant-who", bad: "grant-warn" },
  // In the Inbox panel's compact line.
  panel: {
    line: "grant-row-what text-caption",
    good: "grant-row-last text-caption",
    bad: "grant-row-error text-caption",
  },
} as const

// The line that says what needs fixing with its link, what the last click came to, and the
// confirm the link opens. `line` is the sentence before "Fix" where Hide it is on offer.
export const AutoRunNote = ({
  line,
  where,
}: {
  readonly line: string
  readonly where: keyof typeof classes
}): React.JSX.Element | null => {
  const { autorun, autorunFailure, undoAutoRun, autorunBusy } = useInboxContext()
  const [open, setOpen] = useState(false)
  const fix = fixOf(autorun)
  const { outcome } = autorun
  const as = classes[where]
  if (fix === null && outcome === null && autorunFailure === null) return null
  const link = "button link inbox-link text-control"
  return (
    <>
      {fix !== null && (
        <p
          className={as.line}
          data-autorun={autorun.state}
          // Beside its sentence, as the Grant card's Review link sits.
          style={where === "card" ? { display: "flex", alignItems: "baseline", gap: 6 } : undefined}
        >
          {fix === "fix"
            ? line
            : "Command Prompt still prints at startup: the machine's script does"}
          {" · "}
          <button type="button" className={link} onClick={() => setOpen(true)}>
            {fix === "fix" ? "Fix" : "See how"}
          </button>
        </p>
      )}
      {where === "panel" && autorun.state === "silenced" && undoAutoRun && (
        <p className={as.line} data-autorun="silenced">
          Command Prompt startup output hidden for Antigravity{" · "}
          <button type="button" className={link} disabled={autorunBusy} onClick={undoAutoRun}>
            Undo
          </button>
        </p>
      )}
      {outcome !== null && (
        <p
          className={
            outcome.kind === "failed" || outcome.kind === "undo-refused" ? as.bad : as.good
          }
          role="status"
          data-autorun-outcome={outcome.kind}
        >
          {outcomeText(outcome)}
        </p>
      )}
      {autorunFailure !== null && (
        <p className={as.bad} role="alert">
          Could not reach Novadeck&apos;s runner: {autorunFailure}
        </p>
      )}
      <AutoRunDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}
