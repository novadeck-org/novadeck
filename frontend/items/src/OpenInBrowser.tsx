import { ExternalLink } from "lucide-react"
import type { ReactNode } from "react"

// A link in an item's header that opens `url` in the person's browser, never in the pane: the
// desktop app opens a new window's http(s) address there. It reads "Open in browser" unless it
// is given its own words, and `label` names it to a screen reader where they need more.
export const OpenInBrowser = ({
  url,
  label,
  className,
  children = "Open in browser",
}: {
  readonly url: string
  readonly label?: string
  readonly className?: string
  readonly children?: ReactNode
}): React.JSX.Element => (
  <a
    className={className ? `artifact-open ${className}` : "artifact-open"}
    href={url}
    target="_blank"
    rel="noreferrer"
    aria-label={label}
  >
    <ExternalLink size={14} aria-hidden="true" />
    {children}
  </a>
)
