/* oxlint-disable react/no-array-index-key -- Parts are read from text that has no ids; they never reorder. */
import { ChevronDown } from "lucide-react"
import { Fragment, useId, useState, type ReactNode } from "react"

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
