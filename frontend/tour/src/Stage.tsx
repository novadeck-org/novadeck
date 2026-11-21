import { harnesses, type AgentName } from "@novadeck/core/harnesses"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

import { anchorElement } from "./anchors"
import { placeBox, sameBox, type Box } from "./place"
import { tourActs, type Coach, type TourAct } from "./steps"

import "./print.css"

// How often the stage looks where its subject, the workspace and its windows are now: views move
// and resize them, and Canvas's camera moves them without a resize to hear.
const lookMs = 120
// How long an act's wipe stays: it slides in, stamps its plate and name, and slides off while
// the act's first moves already play under it.
const wipeMs = 1_300

const boxOf = (element: Element | null): Box | null => {
  if (!element) return null
  const { left, top, width, height } = element.getBoundingClientRect()
  return { left, top, width, height }
}

const sameBoxes = (a: readonly Box[], b: readonly Box[]): boolean =>
  a.length === b.length && a.every((box, index) => sameBox(box, b[index] ?? null))

// What the stage reads off the page: what its step points at (and the window holding it, which
// the caption box stands beside), the workspace, and every window drawn in it.
type Scene = {
  readonly anchor: Box | null
  readonly subject: Box | null
  readonly area: Box | null
  readonly windows: readonly Box[]
}

const noScene: Scene = { anchor: null, subject: null, area: null, windows: [] }

const sameScene = (a: Scene, b: Scene): boolean =>
  sameBox(a.anchor, b.anchor) &&
  sameBox(a.subject, b.subject) &&
  sameBox(a.area, b.area) &&
  sameBoxes(a.windows, b.windows)

const drawn = (box: Box | null): box is Box => box !== null && box.width > 0 && box.height > 0

const lookAt = (coach: Coach | null, terminalId: string): Scene => {
  const area = document.querySelector("[data-workspace-area]")
  const element = coach?.anchor ? anchorElement(coach.anchor, coach.terminalId ?? terminalId) : null
  // A part of a window (its Messages, its side pane) is named beside the window itself.
  const holder = element?.closest("[data-terminal]") ?? element
  return {
    anchor: boxOf(element),
    subject: boxOf(holder),
    area: boxOf(area),
    windows: [...(area?.querySelectorAll("[data-terminal]") ?? [])].map(boxOf).filter(drawn),
  }
}

// The footer's middle, where the stage's controls go beside whatever else stands there (as the
// No sandbox chip), so they cover none of it.
const footerSlot = (): HTMLElement | null =>
  document.querySelector<HTMLElement>("footer.app-footer:not([hidden]) .footer-middle")

/** The footer's middle while it's drawn, looked at as the scene is. */
const useFooterSlot = (looking: boolean): HTMLElement | null => {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!looking) return
    const look = (): void => setSlot(footerSlot())
    look()
    const timer = setInterval(look, lookMs)
    return () => clearInterval(timer)
  }, [looking])
  return looking ? slot : null
}

/** The scene as the page draws it now, looked at every so often while the tour shows. */
const useScene = (coach: Coach | null, terminalId: string, looking: boolean): Scene => {
  const [scene, setScene] = useState<Scene>(noScene)
  useEffect(() => {
    if (!looking) return
    const look = (): void => {
      const next = lookAt(coach, terminalId)
      setScene((current) => (sameScene(current, next) ? current : next))
    }
    const first = requestAnimationFrame(look)
    const timer = setInterval(look, lookMs)
    return () => {
      cancelAnimationFrame(first)
      clearInterval(timer)
    }
  }, [coach, terminalId, looking])
  return looking ? scene : noScene
}

const nameOf = (agent: AgentName): string => harnesses.find(({ id }) => id === agent)?.name ?? agent

// The small line under an act's name on its wipe.
const actLabel = (act: TourAct, agent: AgentName): string =>
  act === 1
    ? `${nameOf(agent)} · your account · a sandbox folder`
    : act === 2
      ? "Teammates your agent opens"
      : act === 3
        ? "A question for you"
        : "What they made"

/** An act's wipe, while it is new: shown once per act, over the page but taking no pointer. */
const useWipe = (act: TourAct): TourAct | null => {
  const [wiping, setWiping] = useState<TourAct | null>(act)
  // A new act wipes in as it comes, set while rendering rather than a frame later.
  const [seen, setSeen] = useState(act)
  if (seen !== act) {
    setSeen(act)
    setWiping(act)
  }
  useEffect(() => {
    if (wiping === null) return
    const timer = setTimeout(() => setWiping(null), wipeMs)
    return () => clearTimeout(timer)
  }, [wiping])
  return wiping
}

/**
 * The tour as it shows over the workspace, in a print look of its own: each act opened by a
 * wipe, a ring around what its step points at, and one lettered caption box beside it in space
 * no window takes, with the act plates and End tour in the middle of the app's footer, which no
 * window takes either (or, with the footer hidden, at the workspace's foot). It is no dialog:
 * it takes no focus and covers nothing but its box, plates and button, so the person's keys and
 * shortcuts work on as without it. While the person is in another project, a small bar takes
 * its place, to go back to it.
 */
export const TourStage = ({
  coach,
  terminalId,
  agent,
  act,
  away,
  onEnd,
  onBack,
}: {
  readonly coach: Coach | null
  readonly terminalId: string
  readonly agent: AgentName
  readonly act: TourAct
  // The tour's project isn't the one on screen.
  readonly away: boolean
  readonly onEnd: () => void
  readonly onBack: () => void
}): React.JSX.Element => {
  const scene = useScene(coach, terminalId, !away)
  const slot = useFooterSlot(!away)
  const wiping = useWipe(act)
  if (away)
    return (
      <section aria-label="Tour" className="tour-print tour-away">
        <span role="status">The tour goes on in its project.</span>
        <button type="button" className="tour-button tour-button-go" onClick={onBack}>
          Back to the tour
        </button>
        <button type="button" className="tour-button" onClick={onEnd}>
          End tour
        </button>
      </section>
    )
  const { area } = scene
  return (
    <div className="tour-print">
      {scene.anchor && (
        <div
          aria-hidden="true"
          className="tour-ring"
          style={{
            left: scene.anchor.left,
            top: scene.anchor.top,
            width: scene.anchor.width,
            height: scene.anchor.height,
          }}
        />
      )}
      {coach && area && (
        <CaptionBox
          key={coach.line}
          coach={coach}
          scene={scene}
          area={area}
          tilt={act % 2 === 0 ? "right" : "left"}
          clear={slot ? [] : footlessControls(area)}
        />
      )}
      {/* What the person hears: one region for the whole run, its act and words. */}
      <p aria-live="polite" className="sr-only">
        {`Act ${act}, ${tourActs[act - 1]}.${coach ? ` ${coach.line}` : ""}${coach?.note ? ` ${coach.note}` : ""}`}
      </p>
      {area &&
        (slot ? (
          createPortal(<Controls act={act} onEnd={onEnd} />, slot)
        ) : (
          <div
            className="tour-controls tour-controls-free"
            style={{ left: area.left + area.width / 2, top: area.top + area.height - 24 }}
          >
            <Controls act={act} onEnd={onEnd} />
          </div>
        ))}
      {wiping !== null && (
        <div aria-hidden="true" className="tour-wipe">
          <b className="tour-wipe-plate">{wiping}</b>
          <span className="tour-wipe-name">
            <span className="tour-wipe-say">{tourActs[wiping - 1]}</span>
            <span className="tour-wipe-label">{actLabel(wiping, agent)}</span>
          </span>
        </div>
      )}
    </div>
  )
}

// The stage's controls: the four act plates, the one on now inked in, and End tour. They go in
// the footer's middle, or, with the footer hidden (as in Zen), at the workspace's foot.
const Controls = ({
  act,
  onEnd,
}: {
  readonly act: TourAct
  readonly onEnd: () => void
}): React.JSX.Element => (
  <span className="tour-print tour-controls">
    <ol aria-label={`Act ${act} of ${tourActs.length}: ${tourActs[act - 1]}`} className="tour-acts">
      {tourActs.map((name, index) => (
        <li key={name} aria-current={index + 1 === act ? "step" : undefined}>
          {index + 1}
        </li>
      ))}
    </ol>
    <button type="button" className="tour-button" onClick={onEnd}>
      End tour
    </button>
  </span>
)

// Where the controls stand at the workspace's foot, which the caption box keeps clear of.
const controlsWidth = 260
const footlessControls = (area: Box): readonly Box[] => [
  {
    left: area.left + (area.width - controlsWidth) / 2,
    top: area.top + area.height - 48,
    width: controlsWidth,
    height: 48,
  },
]

// The step's caption box: its line lettered in Nyx's box from the skits, and a note under it for
// a moment the person has to act on; placed by its own size beside what it names.
const CaptionBox = ({
  coach,
  scene,
  area,
  tilt,
  clear,
}: {
  readonly coach: Coach
  readonly scene: Scene
  readonly area: Box
  // Which way it leans, alternating act by act, as the skits' boxes do.
  readonly tilt: "left" | "right"
  // What else it keeps clear of beside the windows.
  readonly clear: readonly Box[]
}): React.JSX.Element => {
  const box = useRef<HTMLElement>(null)
  const [place, setPlace] = useState<{ readonly left: number; readonly top: number } | null>(null)
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const placeNow = (): void => {
      const { width, height } = element.getBoundingClientRect()
      const placed = placeBox(scene.subject, { width, height }, area, [...scene.windows, ...clear])
      setPlace((current) =>
        current && current.left === placed.left && current.top === placed.top ? current : placed,
      )
    }
    placeNow()
    const sized = new ResizeObserver(placeNow)
    sized.observe(element)
    return () => sized.disconnect()
  }, [scene, area, clear])
  return (
    <section
      ref={box}
      aria-label="Tour step"
      className="tour-caption"
      style={place ? { left: place.left, top: place.top } : { visibility: "hidden" }}
    >
      <p className="tour-caption-line" data-tilt={tilt}>
        {coach.line}
      </p>
      {coach.note && <p className="tour-caption-note">{coach.note}</p>}
    </section>
  )
}
