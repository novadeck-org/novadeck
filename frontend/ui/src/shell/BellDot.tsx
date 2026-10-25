import { useState } from "react"

// The dot over the Inbox's bell, drawn while something waits. The bell holds
// `data-project-status`, whose tone the dot takes (see project-status.css). Its ring rings out
// each time the count rises, so a new item catches the eye; a dot that mounts with items already
// waiting, as on a reload or entering Zen, stays still. Kept mounted at zero, so the first item
// rings too.
export const BellDot = ({ count }: { count: number }): React.JSX.Element | null => {
  const [seen, setSeen] = useState(count)
  const [rings, setRings] = useState(0)
  if (count !== seen) {
    setSeen(count)
    if (count > seen) setRings(rings + 1)
  }
  if (count === 0) return null
  return (
    <span aria-hidden="true" className="project-status-dot bell-dot">
      {rings > 0 && <span key={rings} className="bell-dot-ring" />}
    </span>
  )
}
