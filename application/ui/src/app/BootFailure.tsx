import { useEffect, useState } from "react"

import type { ConnectFailure } from "../backend/port"
import { failureAction, failureDetails, failureTitle, retryCountdown } from "./boot"

// Puts text on the clipboard, falling back to a hidden field where the clipboard API
// is unavailable, as on a page served from the file system.
const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const field = document.createElement("textarea")
    field.value = text
    field.setAttribute("readonly", "")
    field.style.position = "fixed"
    field.style.opacity = "0"
    document.body.append(field)
    field.select()
    const copied = document.execCommand("copy")
    field.remove()
    return copied
  }
}

const primary =
  "rounded-control border border-strong bg-strong px-3 py-1.5 text-[12px] text-white shadow-control transition-[opacity] duration-(--motion-feedback) hover:opacity-90"
const quiet =
  "rounded-control px-1.5 py-0.5 text-[11px] text-muted underline-offset-2 hover:text-ink hover:underline"

// What failed on the way in, in place of the phase line: why, what happens next, and
// the details for a bug report.
export const BootFailure = ({
  failure,
  attempts,
  retryIn,
  onRetry,
  onQuit,
}: {
  readonly failure: ConnectFailure
  // Connection attempts made so far, for the details.
  readonly attempts: number
  // Milliseconds until the next automatic retry, or undefined when none is due.
  readonly retryIn: number | undefined
  readonly onRetry: () => void
  readonly onQuit: () => void
}): React.JSX.Element => {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2_000)
    return () => clearTimeout(timer)
  }, [copied])
  const action = failureAction(failure)
  return (
    <div role="alert" className="flex max-w-90 flex-col items-center gap-2 text-center">
      <p className="m-0 text-[13px] font-medium text-ink">{failureTitle}</p>
      <p className="m-0 text-[12px] leading-[1.5] text-muted">{failure.message}</p>
      {retryIn !== undefined && (
        <p className="m-0 text-[12px] text-muted tabular-nums">{retryCountdown(retryIn)}</p>
      )}
      <div className="mt-2 flex items-center gap-3">
        {action === "quit" ? (
          <button type="button" className={primary} onClick={onQuit}>
            Quit
          </button>
        ) : (
          <button type="button" className={primary} onClick={onRetry}>
            {retryIn === undefined && failure.kind !== "transient" ? "Retry" : "Retry now"}
          </button>
        )}
        <button
          type="button"
          className={quiet}
          aria-expanded={open}
          aria-controls="boot-failure-details"
          onClick={() => setOpen((value) => !value)}
        >
          Details
        </button>
      </div>
      {open && (
        <div
          id="boot-failure-details"
          className="mt-1 flex w-full flex-col items-center gap-2 rounded-control border border-line bg-shell px-3 py-2"
        >
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-left font-mono text-[11px] text-muted">
            <dt>Code</dt>
            <dd className="m-0 break-all text-ink">{failure.code}</dd>
            <dt>Message</dt>
            <dd className="m-0 break-all text-ink">{failure.detail}</dd>
            <dt>Attempts</dt>
            <dd className="m-0 text-ink">{attempts}</dd>
          </dl>
          <button
            type="button"
            className={quiet}
            onClick={() => {
              void copyText(failureDetails(failure, attempts)).then(setCopied)
            }}
          >
            {copied ? "Copied" : "Copy details"}
          </button>
        </div>
      )}
    </div>
  )
}
