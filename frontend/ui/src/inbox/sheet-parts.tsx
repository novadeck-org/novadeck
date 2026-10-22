import { HandleChip } from "@novadeck/toolkit/HandleChip"
import { NovaMark } from "@novadeck/toolkit/NovaLogo"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
/* oxlint-disable react/no-array-index-key -- Parts are read from text that has no ids; they never reorder. */
import { Check, ChevronDown, Copy, Send } from "lucide-react"
import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"

import { commandView, markText } from "./command-view"
import { codeParts } from "./inbox-text"

// The small parts the sheets are made of.

// Text with its `code` set as code.
export const Text = ({ text }: { readonly text: string }): React.JSX.Element => (
  <>
    {codeParts(text).map((part, index) =>
      part.code ? (
        <code key={index}>{part.text}</code>
      ) : (
        <Fragment key={index}>{part.text}</Fragment>
      ),
    )}
  </>
)

// The line over a sheet's title: who wants what, and how it stands. Novadeck's own
// items carry its mark.
export const Byline = ({
  label,
  novadeck,
  status,
  statusTone,
}: {
  readonly label: string
  readonly novadeck: boolean
  readonly status: string
  readonly statusTone: "urgent" | "waiting" | "calm" | "done"
}): React.JSX.Element => (
  <div className="inbox-byline">
    {novadeck && <NovaMark size={14} className="inbox-byline-mark" />}
    <span>{label}</span>
    <span aria-hidden="true" className="inbox-byline-sep">
      ·
    </span>
    <span className="inbox-status" data-urgency={statusTone}>
      {status}
    </span>
  </div>
)

// A quiet button that reads as a link.
export const QuietLink = ({
  children,
  onClick,
  disabled,
}: {
  readonly children: ReactNode
  readonly onClick: () => void
  readonly disabled?: boolean
}): React.JSX.Element => (
  <button
    type="button"
    className="button link inbox-link text-control"
    disabled={disabled}
    onClick={onClick}
  >
    {children}
  </button>
)

// More under a line of text, behind a toggle.
export const Disclosure = ({
  label,
  openLabel = label,
  children,
}: {
  readonly label: string
  readonly openLabel?: string
  readonly children: ReactNode
}): React.JSX.Element => {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className="inbox-disclosure">
      <button
        type="button"
        className="inbox-disclose text-caption"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {open ? openLabel : label}
        <ChevronDown size={12} aria-hidden />
      </button>
      {open && <div id={id}>{children}</div>}
    </div>
  )
}

// A command or other text a person would copy, set large in a mono card with the folder
// it runs in; `small` for one that is only to be read or copied. Whatever in it draws as
// nothing shows as a mark (`command-view.ts`), and a command of more than one line says how
// many, so nothing Copy copies or Allow runs is out of sight.
export const CommandCard = ({
  folder,
  command,
  copy,
  small,
  tone = "waiting",
}: {
  readonly folder: string | null
  readonly command: string
  readonly copy?: boolean
  readonly small?: boolean
  readonly tone?: "waiting" | "urgent" | "calm"
}): React.JSX.Element => {
  const view = commandView(command)
  return (
    <div className="inbox-command" data-small={small || undefined} data-urgency={tone}>
      {(folder || view.lines > 1) && (
        <span className="inbox-command-folder">
          {folder}
          {folder && view.lines > 1 && " · "}
          {view.lines > 1 && `${view.lines} lines`}
        </span>
      )}
      <span className="inbox-command-line">
        {view.lines === 1 && (
          <span className="inbox-command-dollar" aria-hidden="true">
            $
          </span>
        )}
        <span className="inbox-command-text">
          {view.parts.map((part, index) =>
            part.type === "text" ? (
              <Fragment key={index}>{part.text}</Fragment>
            ) : (
              <span key={index} className="inbox-command-mark" data-mark={part.type}>
                {markText(part)}
              </span>
            ),
          )}
        </span>
        {copy && <CopyButton text={command} label="Copy command" />}
      </span>
    </div>
  )
}

export const CopyButton = ({
  text,
  label,
}: {
  readonly text: string
  readonly label: string
}): React.JSX.Element => {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <Tooltip content={copied ? "Copied" : "Copy"}>
      <button
        type="button"
        className="icon-button small dim inbox-copy"
        aria-label={label}
        onClick={() => {
          navigator.clipboard
            ?.writeText(text)
            .then(() => {
              setCopied(true)
              window.clearTimeout(timer.current)
              timer.current = window.setTimeout(() => setCopied(false), 1500)
            })
            // A page that may not write the clipboard simply doesn't copy.
            .catch(() => {})
        }}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </Tooltip>
  )
}

// A mini terminal: what Novadeck read of the agent's tool calls, with the times a line
// came again in a badge.
export const Evidence = ({
  handle,
  lines,
}: {
  readonly handle: string
  readonly lines: readonly {
    readonly text: string
    readonly result: string | null
    readonly times: number
  }[]
}): React.JSX.Element => (
  <div className="inbox-evidence">
    <span className="inbox-evidence-label">
      In <HandleChip handle={handle} />
    </span>
    {lines.map((line, index) => (
      <div className="inbox-evidence-line" key={index}>
        <span className="min-w-0">
          {line.text}
          {line.result && <span className="inbox-evidence-result"> └ {line.result}</span>}
        </span>
        {line.times > 1 && (
          <span className="badge inbox-times" data-tone="danger">
            ×{line.times}
          </span>
        )}
      </div>
    ))}
  </div>
)

// What the person's answer did, and the way on to what asks next.
export const Sent = ({
  note,
  onNext,
}: {
  readonly note: string
  readonly onNext: (() => void) | undefined
}): React.JSX.Element => (
  <div className="inbox-sent" role="status" data-tone="success">
    <span className="inbox-sent-note">
      <Check size={12} aria-hidden />
      {note}
    </span>
    {onNext && (
      <button type="button" className="button ghost inbox-next text-control" onClick={onNext}>
        Next
        <span aria-hidden="true">→</span>
      </button>
    )}
  </div>
)

// Why an answer didn't take.
export const Failure = ({
  message,
}: {
  readonly message: string | undefined
}): React.JSX.Element | null =>
  message ? (
    <p className="inbox-failure" role="alert">
      {message}
    </p>
  ) : null

// The box grows with its words, up to a few lines.
const fit = (element: HTMLTextAreaElement): void => {
  element.style.height = "auto"
  element.style.height = `${Math.min(element.scrollHeight, 140)}px`
}

// A box for the person's words: Enter sends, Shift+Enter starts a line. `required` says
// whether there must be words to send; a pick may stand in for them.
export const ReplyBox = ({
  value,
  onChange,
  onSend,
  placeholder,
  label,
  canSend,
  sendLabel = "Send",
  autoFocus,
  minRows = 1,
  onCancel,
  required,
}: {
  readonly value: string
  readonly onChange: (text: string) => void
  readonly onSend: () => void
  readonly placeholder: string
  readonly label: string
  readonly canSend: boolean
  readonly sendLabel?: string
  readonly autoFocus?: boolean
  readonly minRows?: number
  // What Esc does in the box, where it can be given up on; else Esc leaves the box.
  readonly onCancel?: () => void
  readonly required?: boolean
}): React.JSX.Element => {
  const field = useRef<HTMLTextAreaElement>(null)
  const limit = useId()
  const maximum = 4096
  const allowed = canSend && value.length <= maximum
  // Opens as tall as the words it starts with.
  useLayoutEffect(() => {
    if (field.current) fit(field.current)
  }, [])
  useEffect(() => {
    if (autoFocus) field.current?.focus()
  }, [autoFocus])
  return (
    <form
      className="inbox-reply"
      onSubmit={(event) => {
        event.preventDefault()
        if (allowed) onSend()
      }}
    >
      <div className="field inbox-reply-field">
        <textarea
          ref={field}
          className="field-input inbox-reply-input text-body"
          rows={minRows}
          maxLength={maximum}
          aria-describedby={limit}
          aria-invalid={value.length > maximum || undefined}
          value={value}
          placeholder={placeholder}
          aria-label={label}
          aria-required={required || undefined}
          onChange={(event) => {
            fit(event.target)
            onChange(event.target.value)
          }}
          data-cancels={onCancel ? "" : undefined}
          onKeyDown={(event) => {
            if (event.key === "Escape" && onCancel) {
              event.preventDefault()
              event.stopPropagation()
              onCancel()
              return
            }
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
            if (event.ctrlKey || event.metaKey || event.altKey) return
            event.preventDefault()
            if (allowed) onSend()
          }}
        />
        <button
          type="submit"
          className="button primary inbox-send text-control"
          disabled={!allowed}
        >
          <Send size={12} aria-hidden />
          {sendLabel}
        </button>
      </div>
      <p
        id={limit}
        className="inbox-reply-limit"
        role={value.length >= maximum ? "status" : undefined}
      >
        {value.length > maximum
          ? `Reply exceeds the 4,096 character limit by ${value.length - maximum}. Shorten it to send.`
          : value.length === maximum
            ? "4,096 character limit reached."
            : "Up to about 4,000 characters, fewer with emoji or some languages."}
      </p>
    </form>
  )
}
