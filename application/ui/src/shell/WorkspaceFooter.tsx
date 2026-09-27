import { useEffect, useState } from "react"

// How the backend link is doing, most severe first: "ok" shows nothing.
export type FooterStatus = "restarting" | "unavailable" | "reconnecting" | "ok"

// Recovery is announced this long, then the footer returns to its normal colours.
export const recoveredForMs = 3_000

type Tone = "danger" | "warning" | "success"
const shown: Record<Exclude<FooterStatus, "ok">, { readonly tone: Tone; readonly text: string }> = {
  restarting: { tone: "danger", text: "Crash loop" },
  unavailable: { tone: "danger", text: "Offline" },
  reconnecting: { tone: "warning", text: "Reconnecting" },
}
// Whole class strings, so Tailwind finds them: a soft tint, text of the same hue, and
// borders that stay subtle in it.
const tones: Record<Tone, { readonly bar: string; readonly separator: string }> = {
  danger: { bar: "border-danger-fg/20 bg-danger text-danger-fg", separator: "border-danger-fg/25" },
  warning: {
    bar: "border-warning-fg/20 bg-warning text-warning-fg",
    separator: "border-warning-fg/25",
  },
  success: {
    bar: "border-success-fg/20 bg-success text-success-fg",
    separator: "border-success-fg/25",
  },
}

// The terminal counts under the workspace. While the backend link is in trouble the
// whole bar takes the status colour, and says so on the right; after it recovers it
// turns green with "Reconnected" for a moment. The status is short, bold and set in
// capitals by CSS, so assistive technology still reads ordinary words.
export const WorkspaceFooter = ({
  hidden,
  count,
  running,
  status,
  onRetry,
}: {
  readonly hidden: boolean
  readonly count: number
  readonly running: number
  readonly status: FooterStatus
  // Offered while the runner keeps crashing: starts the terminals over.
  readonly onRetry?: (() => void) | undefined
}): React.JSX.Element => {
  const [previous, setPrevious] = useState(status)
  const [recovered, setRecovered] = useState(false)
  if (status !== previous) {
    setPrevious(status)
    setRecovered(status === "ok")
  }
  useEffect(() => {
    if (!recovered) return
    const timer = setTimeout(() => setRecovered(false), recoveredForMs)
    return () => clearTimeout(timer)
  }, [recovered])
  const current =
    status !== "ok"
      ? shown[status]
      : recovered
        ? { tone: "success" as const, text: "Reconnected" }
        : undefined
  return (
    <footer
      hidden={hidden}
      data-status={current?.tone}
      className={`app-footer max-[701px]:px-3 max-[701px]:text-[8px] flex h-7 shrink-0 items-center justify-between border-t px-4 text-[10px] transition-[background-color,border-color,color] duration-(--motion-state) ease-interface motion-reduce:transition-none ${current ? tones[current.tone].bar : "border-line bg-paper text-muted"}`}
    >
      <span className="flex items-center gap-2">
        <span>
          {count} {count === 1 ? "terminal" : "terminals"}
        </span>
        <span
          className={`footer-running max-[701px]:hidden ml-2 border-l pl-3 ${current ? tones[current.tone].separator : "border-line"}`}
        >
          {running} running
        </span>
      </span>
      <span className="flex items-center gap-1.5 font-bold uppercase tracking-wider">
        <span role="status" aria-live={current?.tone === "danger" ? "assertive" : "polite"}>
          {current?.text}
        </span>
        {status === "restarting" && onRetry && (
          <>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              className="cursor-pointer font-bold tracking-wider uppercase underline-offset-2 hover:underline focus-visible:underline"
              onClick={onRetry}
            >
              Try again
            </button>
          </>
        )}
      </span>
    </footer>
  )
}
