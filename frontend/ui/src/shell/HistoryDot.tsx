import { useEffect, useState } from "react"

// How long a landing shows on the History toggle: the bell's ring, played once, over which
// the dot fades (attention-dot.css).
export const flareDotMs = 1_600
// How long after a landing the History toggle's tooltip names what landed.
export const recentDropMs = 10_000

// Whether `drops`, the count of terminals that landed in History (the UI's `historyDrops`),
// rose past the last one seen less than `forMs` ago: each rise starts the wait afresh. A count
// already there when the caller mounts is old news.
export const useRecentDrop = (drops: number, forMs: number): boolean => {
  const [seen, setSeen] = useState(drops)
  useEffect(() => {
    if (drops <= seen) return undefined
    const timer = setTimeout(() => setSeen(drops), forMs)
    return () => clearTimeout(timer)
  }, [drops, seen, forMs])
  return drops > seen
}

// The dot on a rail toggle that says something just arrived in its panel: a closed terminal in
// History, a new worktree in Changes. The Inbox bell's dot and ring (attention-dot.css), but
// only for a moment, as nothing there waits on the person. `drops` counts the arrivals, and
// each mounts a fresh dot, so one that arrives while another plays flares again; with reduced
// motion the dot shows still for as long, without its ring.
export const FlareDot = ({ drops }: { drops: number }): React.JSX.Element | null =>
  useRecentDrop(drops, flareDotMs) ? (
    <span key={drops} aria-hidden="true" className="attention-dot bell-dot flare-dot">
      <span className="bell-dot-ring" />
    </span>
  ) : null

// Says to a screen reader, politely, where a closed terminal went, as the dot can't: `last`
// is the one that landed last, said once for each landing in `drops`.
export const HistoryDropNotice = ({
  drops,
  last,
}: {
  drops: number
  last: string | undefined
}): React.JSX.Element => (
  <span role="status" aria-live="polite" className="sr-only">
    {useRecentDrop(drops, recentDropMs) && last ? `${last} closed. It’s in History.` : ""}
  </span>
)
