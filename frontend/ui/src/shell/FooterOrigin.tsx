import { failingFor } from "@novadeck/core/fetch-age"
import type { OriginFailing } from "@novadeck/core/works"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { CloudOff } from "lucide-react"
import { useState } from "react"

export type FooterOriginProps = {
  // The open project's repositories whose origin has failed to fetch for a while, oldest first.
  readonly failing: readonly OriginFailing[]
  // Fetches the project's origins now; resolves once each fetch has ended, failed or not.
  readonly onRetry: () => Promise<void>
  readonly now: number
}

// What the tooltip says: how long each repository has failed to fetch and git's reason, then
// what a click does.
export const originText = (failing: readonly OriginFailing[], now: number): string =>
  [
    ...failing.map(
      (each) =>
        `${each.repository}: fetching origin has failed for ${failingFor(each.since, now)}. ${each.said}`,
    ),
    "Worktrees can't tell what has landed since. Click to try again.",
  ].join("\n")

// The open project's origin failing to fetch, in the footer's middle: a chip, "Can't fetch",
// whose tooltip says which repository, since when and git's reason, and whose click fetches
// again. The runner fetches every few minutes by itself, so the chip shows only once fetches
// have kept failing (`useFailingOrigins`), and goes with the first one that succeeds. It is the
// one place the app says so: the Worktrees panel, the Files panel and a change's diff say nothing
// of how old origin is.
export const FooterOrigin = ({
  origin,
}: {
  readonly origin: FooterOriginProps | undefined
}): React.JSX.Element | null => {
  const [fetching, setFetching] = useState(false)
  if (!origin || origin.failing.length === 0) return null
  return (
    <Tooltip
      content={
        <span className="whitespace-pre-line">{originText(origin.failing, origin.now)}</span>
      }
    >
      <button
        type="button"
        className="footer-action footer-update cursor-pointer gap-1.5 font-bold"
        disabled={fetching}
        onClick={() => {
          setFetching(true)
          void origin.onRetry().finally(() => setFetching(false))
        }}
      >
        <CloudOff size={12} strokeWidth={1.75} aria-hidden="true" />
        {fetching ? "Fetching…" : "Can't fetch"}
      </button>
    </Tooltip>
  )
}
