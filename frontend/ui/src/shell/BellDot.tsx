import { useState } from "react"

// The dot over the Inbox's bell, drawn while something waits: mounted only then, so each time
// it appears it starts from the bell's count as it stands; its look is attention-dot.css's.
// Its ring rings out each time `rings`, the bell's count of new Inbox rows (the UI's
// `bellRings`), rises past the last one it rang out for, and leaves once played: the browser
// plays an animation again on an element moved in the page, as the rail's toggles are when
// the person reorders them.
export const BellDot = ({ rings }: { rings: number }): React.JSX.Element => {
  const [rung, setRung] = useState(rings)
  return (
    <span aria-hidden="true" className="attention-dot bell-dot">
      {rings > rung && (
        <span key={rings} className="bell-dot-ring" onAnimationEnd={() => setRung(rings)} />
      )}
    </span>
  )
}
