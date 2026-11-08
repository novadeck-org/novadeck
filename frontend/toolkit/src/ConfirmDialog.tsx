import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"

import { Dialog, DialogDescription, DialogTitle } from "./Dialog"

export type ConfirmDialogProps<Subject> = {
  // What the dialog asks about; it is open while this is set, and keeps showing the
  // last one while it animates out. Another subject, or one set again after it was null,
  // is another question: an answer to the last one doesn't count for it. Keep its identity
  // while it asks the same thing.
  readonly subject: Subject | null
  // The strip the dialog opens on, naming what it is about as its window header does
  // (a SubjectBar), so the title can be a plain question.
  readonly bar: (subject: Subject) => ReactNode
  readonly title: (subject: Subject) => string
  // The words under the title; null for none, when the bar and the body say it all.
  readonly description: (subject: Subject) => ReactNode
  // What shows under the words and over the answers, such as a list of what the answer
  // touches.
  readonly body?: (subject: Subject) => ReactNode
  readonly confirmLabel: string
  // A third answer, between cancelling and confirming: a narrower way to go ahead. With
  // it, cancelling moves to the start of the row.
  readonly alternative?: { readonly label: string; readonly onSelect: () => void }
  // Whether confirming is not yet possible; the button is disabled, cancelling stays.
  readonly confirmDisabled?: boolean
  readonly cancelLabel: string
  readonly onConfirm: () => void
  // Also on Escape and a click outside.
  readonly onCancel: () => void
  // Which answer takes focus first: the safe one. Cancel unless told otherwise.
  readonly focus?: "confirm" | "cancel"
  // Where focus goes back when the person cancels; the page's choice otherwise.
  readonly returnFocus?: (subject: Subject) => HTMLElement | null
  // A delay in milliseconds before confirming works, started when the dialog shows and again
  // whenever `armKey` changes, so keys typed ahead as it opens, or meant for a dialog it just
  // replaced, can't answer it. Confirming is available at once when left out.
  readonly armMs?: number
  readonly armKey?: string
  // The dialog's width, e.g. `w-[min(360px,calc(100vw-32px))]`.
  readonly widthClassName: string
}

// A question with two answers (or three, with `alternative`), shown as an alert dialog
// above everything.
export const ConfirmDialog = <Subject,>({
  subject,
  bar,
  title,
  description,
  body,
  confirmLabel,
  alternative,
  confirmDisabled = false,
  cancelLabel,
  onConfirm,
  onCancel,
  focus = "cancel",
  returnFocus,
  armMs = 0,
  armKey = "",
  widthClassName,
}: ConfirmDialogProps<Subject>): React.JSX.Element => {
  const [shown, setShown] = useState(subject)
  if (subject !== null && subject !== shown) setShown(subject)
  // Whether the question up now was confirmed, so closing it neither cancels nor gives
  // focus back. It may be asked again before the last one has animated out.
  const confirmed = useRef(false)
  useLayoutEffect(() => {
    if (subject !== null) confirmed.current = false
  }, [subject])
  const confirm = useRef<HTMLButtonElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  // The key whose delay has passed; confirming works only for the key now shown. Each
  // time the dialog shows, it waits again.
  const [armedKey, setArmedKey] = useState<string | null>(null)
  const shownNow = subject !== null
  const [wasShown, setWasShown] = useState(false)
  if (shownNow !== wasShown) {
    setWasShown(shownNow)
    if (shownNow) setArmedKey(null)
  }
  useEffect(() => {
    if (armMs === 0 || !shownNow) return undefined
    const timer = setTimeout(() => setArmedKey(armKey), armMs)
    return () => clearTimeout(timer)
  }, [armMs, armKey, shownNow])
  const armed = armMs === 0 || armedKey === armKey
  const heading = shown === null ? "" : title(shown)
  const words = shown === null ? null : description(shown)
  return (
    <Dialog
      open={subject !== null}
      role="alertdialog"
      closeOnInteractOutside
      onOpenChange={(open) => {
        if (!open && !confirmed.current) onCancel()
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
      {shown !== null && bar(shown)}
      <DialogTitle className="modal-title m-0 text-heading font-medium">{heading}</DialogTitle>
      {words !== null && words !== undefined && (
        <DialogDescription className="modal-description m-0 text-body">{words}</DialogDescription>
      )}
      {shown !== null && body?.(shown)}
      <div className="mt-3 flex justify-end gap-2">
        <button
          ref={cancel}
          type="button"
          className={`button${alternative ? " mr-auto" : ""}`}
          onClick={onCancel}
        >
          {cancelLabel}
        </button>
        {alternative && (
          <button
            type="button"
            className="button"
            disabled={!armed}
            onClick={() => {
              confirmed.current = true
              alternative.onSelect()
            }}
          >
            {alternative.label}
          </button>
        )}
        <button
          ref={confirm}
          type="button"
          className="button primary"
          disabled={confirmDisabled || !armed}
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
