import { useRef, useState, type ReactNode } from "react"

import { Dialog, DialogDescription, DialogTitle } from "./Dialog"

export type ConfirmDialogProps<Subject> = {
  // What the dialog asks about; it is open while this is set, and keeps showing the
  // last one while it animates out.
  readonly subject: Subject | null
  readonly title: (subject: Subject) => string
  readonly description: (subject: Subject) => ReactNode
  readonly confirmLabel: string
  readonly cancelLabel: string
  readonly onConfirm: () => void
  // Also on Escape and a click outside.
  readonly onCancel: () => void
  // Which answer takes focus first: the safe one. Cancel unless told otherwise.
  readonly focus?: "confirm" | "cancel"
  // Where focus goes back when the person cancels; the page's choice otherwise.
  readonly returnFocus?: (subject: Subject) => HTMLElement | null
  // The dialog's width, e.g. `w-[min(360px,calc(100vw-32px))]`.
  readonly widthClassName: string
}

// A question with two answers, shown as an alert dialog above everything.
export const ConfirmDialog = <Subject,>({
  subject,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  focus = "cancel",
  returnFocus,
  widthClassName,
}: ConfirmDialogProps<Subject>): React.JSX.Element => {
  const [shown, setShown] = useState(subject)
  if (subject !== null && subject !== shown) setShown(subject)
  const confirmed = useRef(false)
  const confirm = useRef<HTMLButtonElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const heading = shown === null ? "" : title(shown)
  return (
    <Dialog
      open={subject !== null}
      role="alertdialog"
      closeOnInteractOutside
      onOpenChange={(open) => {
        if (!open && !confirmed.current) onCancel()
      }}
      onExitComplete={() => {
        confirmed.current = false
      }}
      label={heading}
      initialFocusEl={() => (focus === "confirm" ? confirm : cancel).current}
      {...(returnFocus
        ? {
            finalFocusEl: () => (confirmed.current || shown === null ? null : returnFocus(shown)),
          }
        : {})}
      backdropClassName="overlay fixed inset-0 z-50"
      positionerClassName="fixed inset-0 z-50 flex items-center justify-center px-5"
      className={`modal ${widthClassName} flex flex-col gap-2 p-5`}
    >
      <DialogTitle className="modal-title m-0 text-[14px] font-medium">{heading}</DialogTitle>
      <DialogDescription className="modal-description m-0 text-[12px] leading-[1.5]">
        {shown === null ? null : description(shown)}
      </DialogDescription>
      <div className="mt-3 flex justify-end gap-2">
        <button ref={cancel} type="button" className="button" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button
          ref={confirm}
          type="button"
          className="button primary"
          onClick={() => {
            confirmed.current = true
            onConfirm()
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  )
}
