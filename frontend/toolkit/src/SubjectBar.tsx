import { ArrowRight } from "lucide-react"
import type { ReactNode } from "react"

// The strip a confirmation opens on: what it is about, drawn as that thing's window header
// draws it (surface.css, `.modal-subject`), so the title under it can be a plain question.
// `terminal` marks a terminal's, which carries the focused window's indicator.
export const SubjectBar = ({
  terminal = false,
  children,
}: {
  readonly terminal?: boolean
  readonly children?: ReactNode
}): React.JSX.Element => (
  <div className="modal-subject" {...(terminal ? { "data-terminal": true } : {})}>
    {children}
  </div>
)

// One thing in the strip: its icon, then whatever names it (a handle, a name, a path).
export const SubjectSide = ({ children }: { readonly children: ReactNode }): React.JSX.Element => (
  <span className="modal-subject-side">{children}</span>
)

export const SubjectName = ({ children }: { readonly children: ReactNode }): React.JSX.Element => (
  <span className="modal-subject-name">{children}</span>
)

// A path or a count in the metadata voice; `end` sets it at the strip's far end.
export const SubjectDetail = ({
  end = false,
  children,
}: {
  readonly end?: boolean
  readonly children: ReactNode
}): React.JSX.Element => (
  <span className="modal-subject-detail" {...(end ? { "data-end": true } : {})}>
    {children}
  </span>
)

// From an asking agent to what it acts on.
export const SubjectArrow = (): React.JSX.Element => (
  <span className="modal-subject-arrow">
    <ArrowRight size={14} strokeWidth={1.5} aria-hidden="true" />
    <span className="sr-only"> to </span>
  </span>
)

// A terminal an agent asks to open: it doesn't exist yet.
export const SubjectNew = ({ children }: { readonly children: ReactNode }): React.JSX.Element => (
  <span className="modal-subject-new">{children}</span>
)
