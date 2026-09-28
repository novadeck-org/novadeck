import { useRef } from "react"

import { Dialog, DialogDescription, DialogTitle } from "../ui-toolkit/Dialog"
import { AgentSwitches, agentsExplanation, type AgentSwitch } from "./AgentSwitches"

import motion from "../ui-toolkit/ModalMotion.module.css"

// Shown when the app first opens: which agents to connect, all off until switched on.
// Continue, Escape or a click outside ends it; Preferences offers the same switches.
export const OnboardingDialog = ({
  open,
  agents,
  onChange,
  onDone,
}: {
  readonly open: boolean
  readonly agents: readonly AgentSwitch[]
  readonly onChange: (agent: AgentSwitch["agent"], connected: boolean) => void
  readonly onDone: () => void
}): React.JSX.Element => {
  const done = useRef<HTMLButtonElement>(null)
  return (
    <Dialog
      open={open}
      closeOnInteractOutside
      onOpenChange={(expanded) => {
        if (!expanded) onDone()
      }}
      label="Welcome to NovaDeck"
      initialFocusEl={() => done.current}
      backdropClassName={`${motion.backdrop} fixed inset-0 z-50 bg-scrim backdrop-blur-[3px]`}
      positionerClassName="fixed inset-0 z-50 flex items-center justify-center px-5"
      className={`${motion.dialog} flex w-[min(440px,calc(100vw-32px))] flex-col gap-2 rounded-popover border border-line-strong bg-paper p-5 text-ink shadow-modal`}
    >
      <DialogTitle className="m-0 text-[14px] font-medium tracking-[-0.2px]">
        Welcome to NovaDeck
      </DialogTitle>
      <DialogDescription className="m-0 text-[12px] leading-[1.5] text-muted">
        {agentsExplanation} You can change this later in Preferences.
      </DialogDescription>
      <div className="mt-2">
        <AgentSwitches agents={agents} onChange={onChange} />
      </div>
      <div className="mt-3 flex justify-end">
        <button
          ref={done}
          type="button"
          className="rounded-control border border-strong bg-strong px-3 py-1.5 text-[12px] text-white shadow-control transition-[opacity] duration-(--motion-feedback) hover:opacity-90"
          onClick={onDone}
        >
          Continue
        </button>
      </div>
    </Dialog>
  )
}
