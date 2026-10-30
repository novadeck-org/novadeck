import { X } from "lucide-react"
import type { ReactNode } from "react"

// What a mark says, as an OS taskbar's does: new since the person last looked, showing in
// the pane now, open in it behind what it shows, or seen.
export type Indicator = "new" | "open" | "behind" | "seen"

export type PeekEntry = {
  readonly id: string
  readonly name: string
  readonly icon: ReactNode
  readonly preview: ReactNode
  readonly state: Indicator
  readonly onOpen: () => void
  readonly onClose: () => void
  // Pressing on the card may start pulling it out, as an icon of its own.
  readonly onGrab?: (event: React.PointerEvent<HTMLElement>) => void
}

// A peek above a taskbar icon: a card for each thing behind it, one or many. The card
// says it all without words: its preview, its name, the same mark as the taskbar, and a
// close button that shows on hover.
export const Peek = ({ entries }: { entries: readonly PeekEntry[] }): React.JSX.Element => (
  <div
    className="peek-cards"
    // Escape here closes the peek, not whatever the workspace would do with it.
    data-workspace-companion
    style={{ "--_peek-columns": Math.min(entries.length, 3) } as React.CSSProperties}
  >
    {entries.map((entry) => (
      <div key={entry.id} className="peek-card">
        <button
          className="peek-open"
          data-state={entry.state}
          aria-label={`${entry.name}${entry.state === "new" ? ", new" : entry.state === "behind" ? ", in the pane" : ""}`}
          aria-pressed={entry.state === "open"}
          onClick={entry.onOpen}
          onPointerDown={entry.onGrab}
          // An image in it would start the browser's own drag instead.
          onDragStart={entry.onGrab && ((event) => event.preventDefault())}
        >
          <span className="peek-thumb" aria-hidden="true">
            {entry.preview}
          </span>
          <span className="peek-name">
            {entry.icon}
            <span>{entry.name}</span>
          </span>
        </button>
        <button
          className="peek-close icon-button raised"
          aria-label={`Close ${entry.name}`}
          onClick={entry.onClose}
        >
          <X size={12} />
        </button>
      </div>
    ))}
  </div>
)
