import { Tooltip } from "@novadeck/toolkit/Tooltip"
/* oxlint-disable react/no-array-index-key -- Parts are read from text that has no ids; they never reorder. */
import { Check, ChevronDown, Copy } from "lucide-react"
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react"

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

// A question or a statement, set in the sheet's sans, with its glyph in the gutter.
export const Heading = ({
  glyph = "?",
  children,
}: {
  readonly glyph?: string
  readonly children: ReactNode
}): React.JSX.Element => (
  <h3 className="console-ask">
    <span className="console-q" aria-hidden="true">
      {glyph}
    </span>
    <span>{children}</span>
  </h3>
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
      {open && (
        <div id={id} style={{ alignSelf: "stretch" }}>
          {children}
        </div>
      )}
    </div>
  )
}

// A command, word for word, in the sheet's mono box, with the folder it runs in where the
// sheet says so and a Copy for what the person runs themselves. Whatever in it draws as
// nothing shows as a mark (`command-view.ts`), and a command of more than one line says how
// many and scrolls in its box, so nothing Copy copies or Allow runs is out of reach.
export const CommandBox = ({
  command,
  folder = null,
  copy,
}: {
  readonly command: string
  readonly folder?: string | null
  readonly copy?: boolean
}): React.JSX.Element => {
  const view = commandView(command)
  const long = view.lines > 8
  return (
    <div className="console-box console-command" data-long={long || undefined}>
      {(folder || view.lines > 1 || copy) && (
        <span className="console-path">
          <span>
            {folder}
            {folder && view.lines > 1 && " · "}
            {view.lines > 1 && `${view.lines} lines`}
          </span>
          {copy && <CopyButton text={command} label="Copy command" />}
        </span>
      )}
      <div
        className="console-code"
        tabIndex={long ? 0 : undefined}
        aria-label={long ? "The command" : undefined}
      >
        {view.lines === 1 && (
          <span className="console-dollar" aria-hidden="true">
            ${" "}
          </span>
        )}
        {view.parts.map((part, index) =>
          part.type === "text" ? (
            <Fragment key={index}>{part.text}</Fragment>
          ) : (
            <span key={index} className="console-mark" data-mark={part.type}>
              {markText(part)}
            </span>
          ),
        )}
      </div>
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
