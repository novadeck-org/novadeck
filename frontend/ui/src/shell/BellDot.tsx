import { useState } from "react"

// The dot over the Inbox's bell. The bell holds `data-project-status`, whose tone the dot takes
// (see project-status.css). Its ring rings out as it appears and again each time the count rises,
// so a new item catches the eye and the dot then sits still.
export const BellDot = ({ count }: { count: number }): React.JSX.Element => {
  const [seen, setSeen] = useState(count)
  const [rings, setRings] = useState(0)
  if (count !== seen) {
    setSeen(count)
    if (count > seen) setRings(rings + 1)
  }
  return (
    <span aria-hidden="true" className="project-status-dot bell-dot">
      <span key={rings} className="bell-dot-ring" />
    </span>
  )
}
