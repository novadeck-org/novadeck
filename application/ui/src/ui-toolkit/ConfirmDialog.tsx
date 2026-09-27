import { useRef, useState, type ReactNode } from "react"

import { Dialog, DialogDescription, DialogTitle } from "./Dialog"

import motion from "./ModalMotion.module.css"

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
      backdropClassName={`${motion.backdrop} fixed inset-0 z-50 bg-scrim backdrop-blur-[3px]`}
      positionerClassName="fixed inset-0 z-50 flex items-center justify-center px-5"
      className={`${motion.dialog} ${widthClassName} flex flex-col gap-2 rounded-popover border border-line-strong bg-paper p-5 text-ink shadow-modal`}
    >
      <DialogTitle className="m-0 text-[14px] font-medium tracking-[-0.2px]">{heading}</DialogTitle>
      <DialogDescription className="m-0 text-[12px] leading-[1.5] text-muted">
        {shown === null ? null : description(shown)}
      </DialogDescription>
      <div className="mt-3 flex justify-end gap-2">
        <button
          ref={cancel}
          type="button"
          className="rounded-control border border-line-strong bg-paper px-3 py-1.5 text-[12px] text-ink shadow-control transition-[background] duration-(--motion-feedback) hover:bg-soft"
          onClick={onCancel}
        >
          {cancelLabel}
        </button>
        <button
          ref={confirm}
          type="button"
          className="rounded-control border border-strong bg-strong px-3 py-1.5 text-[12px] text-white shadow-control transition-[opacity] duration-(--motion-feedback) hover:opacity-90"
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
