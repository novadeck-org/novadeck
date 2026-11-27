import { Dialog, DialogDescription, DialogTitle } from "@novadeck/toolkit/Dialog"
import { brandName, NovaMark } from "@novadeck/toolkit/NovaLogo"
import { SubjectBar, SubjectName, SubjectSide } from "@novadeck/toolkit/SubjectBar"
import { CircleStop, Clock, Download, FolderLock, Globe } from "lucide-react"
import { useState } from "react"

import type { TourAgentNote, TourConsent } from "./consent"

export const tourHeading = "Take the tour"

// What the person agrees to: Nova agents run, on a model Novadeck pays for, which is
// where what they read and write goes, and Pi is downloaded once.
const facts = [
  {
    icon: Clock,
    text: "Runs three Nova agents on GPT-6 Luna, free and paid by Novadeck, for about 5 minutes.",
  },
  {
    icon: Globe,
    text: "What the agents read and write goes through novadeck.dev to OpenRouter and Microsoft Azure, which runs OpenAI's model.",
  },
  {
    icon: FolderLock,
    text: "Works in a sandbox repo under ~/.novadeck, made fresh each time. A game you finish is yours to keep.",
  },
  {
    icon: Download,
    text: "Downloads Pi, Novadeck's own agent, once: about 50–60 MB.",
  },
  { icon: CircleStop, text: "Close the tour's terminal to stop it at any time." },
] as const

/**
 * Asks the person before the tour runs: Nova agents on Novadeck's model, and where
 * their words go. There is no agent to pick. Pi downloads in the background from the moment the
 * consent opens; Start waits for it, and a download that failed shows why, with a button to try
 * again. Starting waits for the backend to ready the run; one it refuses (its service has no free
 * run to give) shows why and stays open.
 */
export const TourConsentDialog = ({
  consent,
  agent,
  onRetry,
  onStart,
  onClose,
}: {
  // Absent while it is closed.
  readonly consent: TourConsent | null
  readonly agent: TourAgentNote
  readonly onRetry: () => void
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
          onRetry={onRetry}
          onStart={onStart}
          onClose={onClose}
        />
      )}
    </Dialog>
  )
}

const TourConsentBody = ({
  consent,
  agent,
  onRetry,
  onStart,
  onClose,
}: {
  readonly consent: TourConsent
  readonly agent: TourAgentNote
  readonly onRetry: () => void
  readonly onStart: () => void
  readonly onClose: () => void
}): React.JSX.Element => {
  const { starting } = consent
  const ready = agent.step === "ready"
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
        Pi agents lead a small team that builds a little browser game you choose. You answer a
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
      {agent.step === "waiting" && (
        <p className="tour-agent m-0 text-body leading-[1.5]" role="status">
          {agent.text}
        </p>
      )}
      {agent.step === "failed" && (
        <div className="tour-agent flex items-start justify-between gap-3" role="alert">
          <p className="tour-error m-0 min-w-0 text-body">{agent.text}</p>
          <button
            type="button"
            className="button min-h-8 shrink-0 px-3 text-control"
            aria-disabled={starting || undefined}
            onClick={() => {
              if (!starting) onRetry()
            }}
          >
            Try again
          </button>
        </div>
      )}
      {consent.error && (
        <div role="alert">
          <p className="tour-error m-0 text-body">{consent.error}</p>
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
          aria-disabled={starting || !ready || undefined}
          onClick={() => {
            if (!starting && ready) onStart()
          }}
        >
          {starting ? "Starting…" : agent.step === "waiting" ? "Waiting for Pi…" : "Start the tour"}
        </button>
      </div>
    </>
  )
}
