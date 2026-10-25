import { useState } from "react"

// The dot over the Inbox's bell, drawn while something waits (`shown`). The bell holds
// `data-project-status`, whose tone the dot takes (see project-status.css). Its ring rings out
// each time `rings`, the bell's count of new items (the UI's `bellRings`), rises after the dot
// mounted, so it rings with the toast and the OS ping, and never for what it found on mounting.
export const BellDot = ({
  shown,
  rings,
}: {
  shown: boolean
  rings: number
}): React.JSX.Element | null => {
  const [mounted] = useState(rings)
  if (!shown) return null
  return (
    <span aria-hidden="true" className="project-status-dot bell-dot">
      {rings > mounted && <span key={rings} className="bell-dot-ring" />}
    </span>
  )
}
