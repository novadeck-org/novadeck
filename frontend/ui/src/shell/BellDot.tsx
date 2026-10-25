import { useState } from "react"

import { launchSlackMs } from "../inbox/inbox-state"

// The dot over the Inbox's bell, drawn while something waits; `latest` is when the newest of it
// began (the badge's), undefined while nothing does. The bell holds `data-project-status`, whose
// tone the dot takes (see project-status.css). Its ring rings out each time a newer item arrives,
// so it catches the eye, even when another left at once and the count held. Items that began
// before the dot mounted, as the Inbox fills in on a reload or the dot mounts on entering Zen,
// ring nothing. Kept mounted while nothing waits, so the first item rings too.
export const BellDot = ({ latest }: { latest: number | undefined }): React.JSX.Element | null => {
  const [startedAt] = useState(Date.now)
  const [seen, setSeen] = useState(latest)
  const [rings, setRings] = useState(0)
  if (latest !== seen) {
    setSeen(latest)
    const newer = latest !== undefined && (seen === undefined || latest > seen)
    if (newer && latest >= startedAt - launchSlackMs) setRings(rings + 1)
  }
  if (latest === undefined) return null
  return (
    <span aria-hidden="true" className="project-status-dot bell-dot">
      {rings > 0 && <span key={rings} className="bell-dot-ring" />}
    </span>
  )
}
