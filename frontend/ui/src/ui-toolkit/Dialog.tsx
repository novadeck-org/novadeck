import { Dialog as ArkDialog } from "@ark-ui/react/dialog"
import { Portal } from "@ark-ui/react/portal"
import type { ReactNode, RefObject } from "react"

export type DialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onExitComplete?: (() => void) | undefined
  label: string
  children: ReactNode
  className?: string
  backdropClassName?: string
  positionerClassName?: string
  initialFocusEl?: () => HTMLElement | null
  finalFocusEl?: () => HTMLElement | null
  contentRef?: RefObject<HTMLDivElement | null>
  modal?: boolean
  // "alertdialog" for a confirmation: outside clicks do not dismiss it unless
  // allowed here. Set the first focus with initialFocusEl.
  role?: "dialog" | "alertdialog"
  closeOnInteractOutside?: boolean
}

// Parts that name and describe a dialog; Ark wires their ids.
export const DialogTitle = ArkDialog.Title
export const DialogDescription = ArkDialog.Description

export const Dialog = ({
  open,
  onOpenChange,
  onExitComplete,
  label,
  children,
  className,
  backdropClassName,
  positionerClassName,
  initialFocusEl,
  finalFocusEl,
  contentRef,
  modal = true,
  role = "dialog",
  closeOnInteractOutside,
}: DialogProps): React.JSX.Element => (
  <ArkDialog.Root
    open={open}
    role={role}
    {...(closeOnInteractOutside === undefined ? {} : { closeOnInteractOutside })}
    onOpenChange={(details) => onOpenChange(details.open)}
    aria-label={label}
    onExitComplete={onExitComplete}
    initialFocusEl={initialFocusEl}
    finalFocusEl={finalFocusEl}
    modal={modal}
    onFocusOutside={(event) => {
      // A modal keeps focus inside, including while another dialog restores its opener.
      if (modal) event.preventDefault()
    }}
    restoreFocus
    lazyMount
    unmountOnExit
  >
    <Portal>
      <ArkDialog.Backdrop className={backdropClassName} />
      <ArkDialog.Positioner className={positionerClassName}>
        <ArkDialog.Content ref={contentRef} className={className} inert={!open} aria-hidden={!open}>
          {children}
        </ArkDialog.Content>
      </ArkDialog.Positioner>
    </Portal>
  </ArkDialog.Root>
)
