import { useEffect, useRef } from "react"

// How long a finished piece of work says so before it fades, and how long the fade takes.
// Both are spent in view: they wait while the surface is hidden, as in Zen mode.
export const finishedForMs = 4_000
export const fadeMs = 200

// Walks a finished surface through its farewell: from `finished` it moves to `fading` after
// `finishedForMs`, and from `fading` to `gone` after `fadeMs`, by calling `advance` with
// where it goes next. Any other `moment` is at rest. The clock runs only while `shown`.
export const useLinger = (
  moment: string | null,
  shown: boolean,
  advance: (next: "fading" | "gone") => void,
): void => {
  const latest = useRef(advance)
  useEffect(() => {
    latest.current = advance
  })
  useEffect(() => {
    if (!shown || (moment !== "finished" && moment !== "fading")) return undefined
    const timer = setTimeout(
      () => latest.current(moment === "finished" ? "fading" : "gone"),
      moment === "finished" ? finishedForMs : fadeMs,
    )
    return () => clearTimeout(timer)
  }, [moment, shown])
}
