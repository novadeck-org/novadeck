/* oxlint-disable react/no-array-index-key -- Parts are read from text that has no ids; they never reorder. */
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { Check, Copy } from "lucide-react"
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react"

import { commandView, markText } from "./command-view"

// What a request asks in full, word for word: a command, a file's change, a dialog's own text.
// Whatever in it draws as nothing shows as a mark (`command-view.ts`), so what the person reads
// is all that runs, or all that Copy copies; more than one line says how many, with the folder
// it runs in where the host has one, and a long one scrolls in its box. A one-line command (the
// host says it is one) reads as a shell's, after `$`. It takes focus to scroll only where it
// scrolls.
export const Detail = ({
  text,
  label,
  folder = null,
  command = false,
  copy = false,
}: {
  readonly text: string
  // Its name, for a screen reader.
  readonly label: string
  readonly folder?: string | null
  readonly command?: boolean
  // A Copy, for what the person runs themselves.
  readonly copy?: boolean
}): React.JSX.Element => {
  const view = commandView(text)
  const bar = folder !== null || view.lines > 1 || copy
  // Only a detail that scrolls in its box is a stop for Tab, to scroll it by keys: one that
  // shows whole would only stand between the person and the answers.
  const box = useRef<HTMLPreElement>(null)
  const [scrolls, setScrolls] = useState(false)
  const measure = useRef(() => {
    const element = box.current
    if (element) setScrolls(element.scrollHeight > element.clientHeight + 1)
  })
  // As it draws (its text may have changed), and as its box changes size.
  useLayoutEffect(() => measure.current())
  useEffect(() => {
    const element = box.current
    if (!element || typeof ResizeObserver === "undefined") return
    const watch = new ResizeObserver(() => measure.current())
    watch.observe(element)
    return () => watch.disconnect()
  }, [])
  return (
    <div className="request-detail nodrag nopan">
      {bar && (
        <span className="request-detail-bar">
          <span>
            {folder}
            {folder !== null && view.lines > 1 && " · "}
            {view.lines > 1 && `${view.lines} lines`}
          </span>
          {copy && <CopyButton text={text} label={`Copy ${command ? "command" : "text"}`} />}
        </span>
      )}
      <pre
        ref={box}
        className="request-detail-text nowheel"
        tabIndex={scrolls ? 0 : undefined}
        aria-label={label}
      >
        {command && view.lines === 1 && (
          <span className="request-detail-dollar" aria-hidden>
            ${" "}
          </span>
        )}
        {view.parts.map((part, index) =>
          part.type === "text" ? (
            <Fragment key={index}>{part.text}</Fragment>
          ) : (
            <span key={index} className="request-mark" data-mark={part.type}>
              {markText(part)}
            </span>
          ),
        )}
      </pre>
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
        className="icon-button small dim request-copy"
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
