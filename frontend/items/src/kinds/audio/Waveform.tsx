import { memo, useLayoutEffect, useMemo, useRef, useState } from "react"

import { jump, within } from "../video/controls"
import { clock } from "../video/format"
import { reduce } from "./peaks"

// A bar and its gap, in pixels: how many bars fit is the width over this.
const pitch = 5
// What a flat track's bars stand at, as a share of the height, and the least any bar does.
const flat = 0.22
const least = 0.06

// The bars alone, drawn twice (as they are, and in the colour of what has played, clipped to
// it), so they are made once for the peaks and the count and a time that moves restyles none.
const Bars = memo(({ heights }: { heights: readonly number[] }): React.JSX.Element => (
  <span className="wave-bars" aria-hidden>
    {heights.map((height, bar) => (
      <span
        // A bar is its place in the row: nothing else tells one from another.
        // oxlint-disable-next-line react/no-array-index-key
        key={bar}
        className="wave-bar"
        style={{ height: `${Math.max(least, height) * 100}%` }}
      />
    ))}
  </span>
))
Bars.displayName = "Bars"

// A recording's waveform, which is its scrubber: a click or a drag seeks, hovering shows the
// time under the pointer, and the keys of a slider work too (the arrows jump, Home and End go
// to the ends). `peaks` are the fine ones (undefined while they are worked out, null where
// there are none): the bars are as many as fit and the track is flat without them.
export const Waveform = ({
  peaks,
  time,
  duration,
  onSeek,
}: {
  peaks: ArrayLike<number> | null | undefined
  time: number
  duration: number
  onSeek: (to: number) => void
}): React.JSX.Element => {
  const track = useRef<HTMLDivElement>(null)
  const [count, setCount] = useState(96)
  // Where the pointer is over it, as a share of its width, while it is.
  const [hover, setHover] = useState<number>()
  const dragging = useRef(false)

  useLayoutEffect(() => {
    const element = track.current!
    const measure = (): void => {
      const width = element.getBoundingClientRect().width
      if (width > 0) setCount(Math.max(8, Math.floor(width / pitch)))
    }
    measure()
    if (typeof ResizeObserver !== "function") return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const heights = useMemo(
    () => (peaks ? reduce(peaks, count) : Array.from({ length: count }, () => flat)),
    [peaks, count],
  )

  const known = duration > 0
  const shareAt = (clientX: number): number => {
    const rect = track.current!.getBoundingClientRect()
    return rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0
  }
  const played = known ? Math.min(1, time / duration) : 0

  return (
    <div
      ref={track}
      className="wave"
      role="slider"
      tabIndex={known ? 0 : -1}
      aria-label="Seek"
      aria-orientation="horizontal"
      aria-disabled={!known}
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={Math.min(time, duration)}
      aria-valuetext={`${clock(time)} of ${clock(duration)}`}
      data-peaks={peaks === undefined ? "pending" : peaks === null ? "none" : "ready"}
      style={{ "--_played": `${played * 100}%` } as React.CSSProperties}
      onPointerDown={(event) => {
        if (!known || event.button !== 0) return
        dragging.current = true
        event.currentTarget.setPointerCapture?.(event.pointerId)
        onSeek(shareAt(event.clientX) * duration)
      }}
      onPointerMove={(event) => {
        setHover(shareAt(event.clientX))
        if (dragging.current) onSeek(shareAt(event.clientX) * duration)
      }}
      onPointerUp={() => {
        dragging.current = false
      }}
      onPointerCancel={() => {
        dragging.current = false
      }}
      onPointerLeave={() => setHover(undefined)}
      onKeyDown={(event) => {
        if (!known || event.ctrlKey || event.metaKey || event.altKey) return
        const to =
          event.key === "ArrowLeft"
            ? time - jump
            : event.key === "ArrowRight"
              ? time + jump
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? duration
                  : undefined
        if (to === undefined) return
        // The slider's keys are its own: the player's, which would jump again, don't see them.
        event.preventDefault()
        event.stopPropagation()
        onSeek(within(to, duration))
      }}
    >
      <Bars heights={heights} />
      <span className="wave-played" aria-hidden>
        <Bars heights={heights} />
      </span>
      {known && hover !== undefined && (
        <>
          <span className="wave-line" style={{ left: `${hover * 100}%` }} aria-hidden />
          <span
            className="wave-tip"
            style={{ left: `${hover * 100}%` }}
            data-edge={hover < 0.12 ? "start" : hover > 0.88 ? "end" : undefined}
            aria-hidden
          >
            {clock(hover * duration)}
          </span>
        </>
      )}
    </div>
  )
}
