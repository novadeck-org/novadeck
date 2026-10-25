import { useState } from "react"

// The dot over the Inbox's bell, drawn while something waits: mounted only then, so each time
// it appears it starts from the bell's count as it stands. The bell holds `data-project-status`,
// whose tone the dot takes (see project-status.css). Its ring rings out each time `rings`, the
// bell's count of new items (the UI's `bellRings`), rises past the one it mounted with.
export const BellDot = ({ rings }: { rings: number }): React.JSX.Element => {
  const [mounted] = useState(rings)
  return (
    <span aria-hidden="true" className="project-status-dot bell-dot">
      {rings > mounted && <span key={rings} className="bell-dot-ring" />}
    </span>
  )
}
