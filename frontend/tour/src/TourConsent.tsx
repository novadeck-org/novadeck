import { Dialog, DialogDescription, DialogTitle } from "@novadeck/toolkit/Dialog"
import { OpencodeIcon } from "@novadeck/toolkit/icons/OpencodeIcon"
import { brandName, NovaMark } from "@novadeck/toolkit/NovaLogo"
import { SubjectBar, SubjectName, SubjectSide } from "@novadeck/toolkit/SubjectBar"
import { CircleStop, Clock, FolderLock, Globe } from "lucide-react"
import { useState } from "react"

import type { TourAgentState, TourConsent } from "./consent"

export const tourHeading = "Take the tour"

// What the person agrees to: opencode's agents run, on a model Novadeck pays for, which is
// where what they read and write goes.
const facts = [
  {
    icon: Clock,
    text: "Runs three opencode agents on GPT-6 Luna, free and paid by Novadeck, for about 5 minutes.",
  },
  {
    icon: Globe,
    text: "What the agents read and write goes through novadeck.dev to OpenRouter and Microsoft Azure, which runs OpenAI's model.",
  },
  {
    icon: FolderLock,
    text: "Works in a sandbox repo under ~/.novadeck, made fresh each time. A game you finish is yours to keep.",
  },
  { icon: CircleStop, text: "Close the tour's terminal to stop it at any time." },
] as const

/**
 * Asks the person before the tour runs: opencode's agents on Novadeck's model, and where their
 * words go. There is no agent to pick. Where opencode isn't installed, or Novadeck isn't connected
 * to it, the consent offers to do that right here. Starting waits for the backend to ready the
 * run; one it refuses (its service has no free run to give) shows why and stays open.
 */
export const TourConsentDialog = ({
  consent,
  agent,
  installing,
  installError,
  onInstall,
  onConnect,
  onStart,
  onClose,
}: {
  // Absent while it is closed.
  readonly consent: TourConsent | null
  readonly agent: TourAgentState
  // opencode's installer is running (in a terminal behind the dialog), or it is being connected after.
  readonly installing: boolean
  // Why the last install didn't end with opencode installed and connected, where it didn't.
  readonly installError?: string | undefined
  readonly onInstall: (command: string) => void
  readonly onConnect: () => void
  readonly onStart: () => void
  readonly onClose: () => void
}): React.JSX.Element => {
  // The dialog keeps its last content while it animates out.
  const [last, setLast] = useState(consent)
  if (consent !== null && consent !== last) setLast(consent)
  const shown = consent ?? last
  return (
    <Dialog
      open={consent !== null}
      onOpenChange={(open) => {
        if (!open && !consent?.starting) onClose()
      }}
      label={tourHeading}
      initialFocusEl={() => document.querySelector<HTMLElement>("[data-tour-start]")}
      backdropClassName="overlay fixed inset-0 z-50"
      positionerClassName="fixed inset-0 z-50 flex items-center justify-center px-5"
      className="modal tour-consent flex w-[min(460px,calc(100vw-32px))] flex-col gap-3 p-5"
    >
      {shown && (
        <TourConsentBody
          consent={shown}
          agent={agent}
          installing={installing}
          installError={installError}
          onInstall={onInstall}
          onConnect={onConnect}
          onStart={onStart}
          onClose={onClose}
        />
      )}
    </Dialog>
  )
}

// What the person gets by pressing the step's button, and what it costs them: when to pick it.
const steps = {
  install: {
    note: "Install adds opencode to this computer with its own installer, then connects it to Novadeck. Pick it if you don't have opencode; the tour is the only reason to, and it stays installed after.",
    action: "Install opencode",
  },
  update: {
    note: "This opencode is older than Novadeck works with (1.18 or later), so it can't follow the tour's agents. Update it with `opencode upgrade`, then take the tour.",
  },
  unsupported: {
    note: "Novadeck works with opencode 1 so far, so it can't follow this opencode 2. Install opencode 1 (1.18 or later) to take the tour.",
  },
  connect: {
    note: "Connect adds Novadeck's small plugin to opencode, so the tour's agents can use Novadeck's tools. Pick it to take the tour; Preferences disconnects it again.",
    action: "Connect opencode",
  },
} as const

const TourConsentBody = ({
  consent,
  agent,
  installing,
  installError,
  onInstall,
  onConnect,
  onStart,
  onClose,
}: {
  readonly consent: TourConsent
  readonly agent: TourAgentState
  readonly installing: boolean
  readonly installError?: string | undefined
  readonly onInstall: (command: string) => void
  readonly onConnect: () => void
  readonly onStart: () => void
  readonly onClose: () => void
}): React.JSX.Element => {
  const { starting } = consent
  // Why the tour can't start now, in words: its start's refusal, or why opencode isn't ready.
  const error =
    consent.error ?? agent.error ?? (agent.step === "install" ? installError : undefined)
  const { step, installer } = agent
  const waiting = starting || step === "connecting" || installing
  const needed = step === "ready" || step === "connecting" ? undefined : steps[step]
  return (
    <>
      <SubjectBar>
        <SubjectSide>
          <NovaMark size={14} />
          <SubjectName>{brandName}</SubjectName>
        </SubjectSide>
      </SubjectBar>
      <DialogTitle className="modal-title m-0 text-heading font-medium">{tourHeading}</DialogTitle>
      <DialogDescription className="modal-description m-0 text-body leading-[1.6]">
        opencode agents lead a small team that builds a little browser game you choose. You answer a
        question or two, approve one command, and play the game at the end.
      </DialogDescription>
      <ul className="tour-facts m-0 flex flex-col gap-2 p-0">
        {facts.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-start gap-2.5 text-body leading-[1.5]">
            <Icon size={15} className="tour-fact-icon mt-0.5 shrink-0" aria-hidden="true" />
            <span>{text}</span>
          </li>
        ))}
      </ul>
      {needed && (
        <div
          className="tour-agent flex items-start justify-between gap-3"
          role="group"
          aria-label="opencode"
        >
          <span className="flex min-w-0 items-start gap-2.5 text-body leading-[1.5]">
            <OpencodeIcon size={15} className="tour-fact-icon mt-0.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">
              {needed.note}
              {step === "install" && installer !== undefined && (
                <>
                  {" "}
                  It runs <code className="[overflow-wrap:anywhere]">{installer}</code>.
                </>
              )}
              {step === "install" && installer === undefined && " Install it from opencode.ai."}
            </span>
          </span>
          {(step === "connect" || (step === "install" && installer !== undefined)) && (
            <button
              type="button"
              className="button min-h-8 shrink-0 px-3 text-control"
              aria-disabled={installing || starting || undefined}
              onClick={() => {
                if (installing || starting) return
                if (step === "connect") onConnect()
                else if (installer !== undefined) onInstall(installer)
              }}
            >
              {installing ? "Installing…" : "action" in needed ? needed.action : null}
            </button>
          )}
        </div>
      )}
      {error && (
        <div role="alert">
          <p className="tour-error m-0 text-body">{error}</p>
        </div>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" className="button" disabled={starting} onClick={onClose}>
          Not now
        </button>
        <button
          type="button"
          className="button primary"
          data-tour-start=""
          aria-disabled={waiting || step !== "ready" || undefined}
          onClick={() => {
            if (!waiting && step === "ready") onStart()
          }}
        >
          {starting ? "Starting…" : step === "connecting" ? "Connecting…" : "Start the tour"}
        </button>
      </div>
    </>
  )
}
