import { useEffect, useLayoutEffect, useRef, useState } from "react"

import { anchorElement } from "./anchors"
import type { Coach, TourAnchor } from "./steps"

// How far the coach stands from its anchor, and from the window's edges.
const gap = 12
const margin = 16
// How often the spotlight looks where its anchor is now: views move and resize what it marks,
// and Canvas's camera moves it without a resize to hear.
const lookMs = 120

// A rect as the page shows it now, by value, so an unchanged one renders nothing anew.
export type Box = {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

const sameBox = (a: Box | null, b: Box | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height)

const boxOf = (element: HTMLElement | null): Box | null => {
  if (!element) return null
  const { left, top, width, height } = element.getBoundingClientRect()
  return { left, top, width, height }
}

/** Where an anchor is drawn now, looked at every so often while the tour points at it. */
const useAnchorBox = (anchor: TourAnchor | null, terminalId: string): Box | null => {
  const [box, setBox] = useState<Box | null>(null)
  useEffect(() => {
    if (anchor === null) return
    const look = (): void => {
      const next = boxOf(anchorElement(anchor, terminalId))
      setBox((current) => (sameBox(current, next) ? current : next))
    }
    const first = requestAnimationFrame(look)
    const timer = setInterval(look, lookMs)
    return () => {
      cancelAnimationFrame(first)
      clearInterval(timer)
    }
  }, [anchor, terminalId])
  // Pointing at nothing, it has no box, whatever it followed last.
  return anchor === null ? null : box
}

// Keeps a value within a range, the range's start where it's too small to hold it.
const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(value, high))

/**
 * Where the coach card stands, by its own size, in the window's coordinates:
 * - beside a small anchor, below it and else above, aligned to its start;
 * - inside the bottom right of a large one, as a terminal in Focus: a fresh terminal draws from
 *   its top, where the agent's own screens and its box are while the tour runs;
 * - in the window's bottom right where it points at nothing drawn.
 * Always within the window.
 */
export const coachPlace = (
  box: Box | null,
  card: { readonly width: number; readonly height: number },
  view: { readonly width: number; readonly height: number },
): { readonly left: number; readonly top: number } => {
  const fit = (left: number, top: number) => ({
    left: clamp(left, margin, view.width - card.width - margin),
    top: clamp(top, margin, view.height - card.height - margin),
  })
  if (!box) return fit(view.width - card.width - margin, view.height - card.height - margin)
  const large = box.width > view.width / 2 || box.height > view.height / 2
  if (large)
    return fit(
      box.left + box.width - card.width - gap * 2,
      box.top + box.height - card.height - gap * 2,
    )
  const below = box.top + box.height + gap
  const top = below + card.height + margin <= view.height ? below : box.top - card.height - gap
  return fit(box.left, top)
}

type Controls = {
  readonly onNext: () => void
  readonly onPause: () => void
  readonly onResume: () => void
  readonly onSkip: () => void
  readonly onEnd: () => void
  readonly onBack: () => void
}

/**
 * The tour as it shows over the workspace: a ring around what its step points at and a coach
 * card beside it. It is no dialog or popover: it takes no focus, covers nothing but its card,
 * and neither Escape nor a click elsewhere goes to it, so the person's keys and shortcuts work
 * on as without it. Paused, or while the person is in another project, a small bar takes its
 * place, to resume or go back to it.
 */
export const TourSpotlight = ({
  coach,
  terminalId,
  step,
  steps,
  paused,
  away,
  next,
  onPause,
  onResume,
  onSkip,
  onNext,
  onEnd,
  onBack,
}: {
  readonly coach: Coach | null
  readonly terminalId: string
  readonly step: number
  readonly steps: number
  readonly paused: boolean
  // The tour's project isn't the one on screen.
  readonly away: boolean
  // The step waits on the person's Next.
  readonly next: boolean
} & Controls): React.JSX.Element | null => {
  const anchor = paused || away ? null : (coach?.anchor ?? null)
  const box = useAnchorBox(anchor, coach?.terminalId ?? terminalId)
  if (away)
    return (
      <TourBar text="The tour goes on in its project.">
        <button type="button" className="button min-h-8 px-3 text-control" onClick={onBack}>
          Back to the tour
        </button>
        <button type="button" className="button ghost min-h-8 px-2.5 text-control" onClick={onEnd}>
          End tour
        </button>
      </TourBar>
    )
  if (paused)
    return (
      <TourBar text="Tour paused.">
        <button type="button" className="button min-h-8 px-3 text-control" onClick={onResume}>
          Resume
        </button>
        <button type="button" className="button ghost min-h-8 px-2.5 text-control" onClick={onEnd}>
          End tour
        </button>
      </TourBar>
    )
  if (!coach) return null
  return (
    <>
      {box && (
        <div
          aria-hidden="true"
          className="tour-ring"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        />
      )}
      <CoachCard
        coach={coach}
        box={box}
        step={step}
        steps={steps}
        next={next}
        onNext={onNext}
        onPause={onPause}
        onSkip={onSkip}
        onEnd={onEnd}
      />
    </>
  )
}

const CoachCard = ({
  coach,
  box,
  step,
  steps,
  next,
  onNext,
  onPause,
  onSkip,
  onEnd,
}: {
  readonly coach: Coach
  readonly box: Box | null
  readonly step: number
  readonly steps: number
  readonly next: boolean
} & Pick<Controls, "onNext" | "onPause" | "onSkip" | "onEnd">): React.JSX.Element => {
  const card = useRef<HTMLElement>(null)
  const [place, setPlace] = useState<{ readonly left: number; readonly top: number } | null>(null)
  // Placed by its own size once drawn, and again as its anchor moves or its size changes, as
  // with a step's words.
  useLayoutEffect(() => {
    const element = card.current
    if (!element) return
    const placeNow = (): void => {
      const { width, height } = element.getBoundingClientRect()
      const placed = coachPlace(
        box,
        { width, height },
        { width: window.innerWidth, height: window.innerHeight },
      )
      setPlace((current) =>
        current && current.left === placed.left && current.top === placed.top ? current : placed,
      )
    }
    placeNow()
    const sized = new ResizeObserver(placeNow)
    sized.observe(element)
    return () => sized.disconnect()
  }, [box])
  return (
    <section
      ref={card}
      aria-label="Tour step"
      className="floating tour-coach flex w-[min(340px,calc(100vw-32px))] flex-col gap-2 p-4"
      style={place ? { left: place.left, top: place.top } : { visibility: "hidden" }}
    >
      <p className="section-label tour-step m-0 text-label font-medium">
        Tour · {Math.min(step + 1, steps)} of {steps}
      </p>
      <div aria-live="polite" className="flex flex-col gap-2">
        <h3 className="m-0 text-heading font-medium">{coach.title}</h3>
        <p className="modal-description m-0 text-body leading-[1.55]">{coach.body}</p>
      </div>
      <div className="mt-1 flex justify-end gap-1.5">
        <button type="button" className="button ghost min-h-8 px-2.5 text-control" onClick={onEnd}>
          End tour
        </button>
        {!next && (
          <button
            type="button"
            className="button ghost min-h-8 px-2.5 text-control"
            onClick={onSkip}
          >
            Skip step
          </button>
        )}
        <button
          type="button"
          className={`button ${next ? "ghost px-2.5" : "px-3"} min-h-8 text-control`}
          onClick={onPause}
        >
          Pause
        </button>
        {next && (
          <button
            type="button"
            className="button primary min-h-8 px-3 text-control"
            onClick={onNext}
          >
            Next
          </button>
        )}
      </div>
    </section>
  )
}

// The small bar that stands in for the tour while it's paused or elsewhere.
const TourBar = ({
  text,
  children,
}: {
  readonly text: string
  readonly children: React.ReactNode
}): React.JSX.Element => (
  <section
    aria-label="Tour"
    className="floating tour-bar flex items-center gap-2 py-1.5 pr-1.5 pl-3"
  >
    <span role="status" className="text-body">
      {text}
    </span>
    {children}
  </section>
)
