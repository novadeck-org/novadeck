import { harnesses, type AgentName } from "@novadeck/core/harnesses"
import { Dialog, DialogDescription, DialogTitle } from "@novadeck/toolkit/Dialog"
import { AntigravityIcon } from "@novadeck/toolkit/icons/AntigravityIcon"
import { ClaudeIcon } from "@novadeck/toolkit/icons/ClaudeIcon"
import { CodexIcon } from "@novadeck/toolkit/icons/CodexIcon"
import { brandName, NovaMark } from "@novadeck/toolkit/NovaLogo"
import { SegmentGroup } from "@novadeck/toolkit/SegmentGroup"
import { SubjectBar, SubjectName, SubjectSide } from "@novadeck/toolkit/SubjectBar"
import { CircleStop, Clock, FolderLock } from "lucide-react"
import { useState } from "react"

import type { TourConsent } from "./consent"

const icons = { claude: ClaudeIcon, codex: CodexIcon, agy: AntigravityIcon }
const nameOf = (agent: AgentName): string => harnesses.find(({ id }) => id === agent)?.name ?? agent

export const tourHeading = "Take the tour"

// What the person agrees to: their own agent runs, and what that costs them.
const facts = (agent: AgentName) =>
  [
    {
      icon: Clock,
      text: `Runs three ${nameOf(agent)} agents on its cheapest model, on your own account, for about 5 minutes.`,
    },
    {
      icon: FolderLock,
      text: "Works in a sandbox repo under ~/.novadeck, made fresh each time. A game you finish is yours to keep.",
    },
    { icon: CircleStop, text: "Close the tour's terminal to stop it at any time." },
  ] as const

/**
 * Asks the person before the tour runs their agent: which one, where several are connected,
 * and what it will spend. Starting waits for the backend to ready the run; one it refuses
 * shows why and stays open. With no agent connected, it says to connect one first.
 */
export const TourConsentDialog = ({
  consent,
  agents,
  connecting,
  onAgent,
  onStart,
  onStartAgent,
  onClose,
}: {
  // Absent while it is closed.
  readonly consent: TourConsent | null
  readonly agents: readonly AgentName[]
  // The consent's agent is still being connected: it can't start yet.
  readonly connecting: boolean
  readonly onAgent: (agent: AgentName) => void
  readonly onStart: () => void
  // Starts the agent the tour needs started first, in a terminal of its own.
  readonly onStartAgent: (agent: AgentName) => void
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
          agents={agents}
          connecting={connecting}
          onAgent={onAgent}
          onStart={onStart}
          onStartAgent={onStartAgent}
          onClose={onClose}
        />
      )}
    </Dialog>
  )
}

const TourConsentBody = ({
  consent,
  agents,
  connecting,
  onAgent,
  onStart,
  onStartAgent,
  onClose,
}: {
  readonly consent: TourConsent
  readonly agents: readonly AgentName[]
  readonly connecting: boolean
  readonly onAgent: (agent: AgentName) => void
  readonly onStart: () => void
  readonly onStartAgent: (agent: AgentName) => void
  readonly onClose: () => void
}): React.JSX.Element => {
  const { agent, starting, error, needs } = consent
  const waiting = starting || connecting
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
        {agent === null
          ? "The tour runs one of your agents. Install and connect Claude Code, Codex or Antigravity in Preferences first."
          : "Your own agent leads a small team that builds a little browser game you choose. You answer a question or two, approve one command, and play the game at the end."}
      </DialogDescription>
      {agent !== null && agents.length > 1 && (
        <SegmentGroup
          label="Agent for the tour"
          items={agents.map((each) => {
            const Icon = icons[each]
            return { value: each, label: nameOf(each), icon: <Icon size={14} /> }
          })}
          value={agent}
          onValueChange={(next) => {
            const picked = agents.find((each) => each === next)
            if (picked) onAgent(picked)
          }}
          disabled={starting}
          className="tour-agents flex gap-1 self-start"
          itemClassName="flex h-8 items-center gap-1.5 px-2.5 text-control"
          indicatorClassName="absolute"
        />
      )}
      {agent !== null && (
        <ul className="tour-facts m-0 flex flex-col gap-2 p-0">
          {facts(agent).map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-start gap-2.5 text-body leading-[1.5]">
              <Icon size={15} className="tour-fact-icon mt-0.5 shrink-0" aria-hidden="true" />
              <span>{text}</span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <div role="alert" className="flex items-start justify-between gap-3">
          <p className="tour-error m-0 text-body">{error}</p>
          {needs && (
            <button
              type="button"
              className="button min-h-8 shrink-0 px-3 text-control"
              onClick={() => onStartAgent(needs)}
            >
              Start {nameOf(needs)}
            </button>
          )}
        </div>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" className="button" disabled={starting} onClick={onClose}>
          {agent === null ? "Close" : "Not now"}
        </button>
        {agent !== null && (
          <button
            type="button"
            className="button primary"
            data-tour-start=""
            aria-disabled={waiting || undefined}
            onClick={() => {
              if (!waiting) onStart()
            }}
          >
            {starting ? "Starting…" : connecting ? "Connecting…" : "Start the tour"}
          </button>
        )}
      </div>
    </>
  )
}
